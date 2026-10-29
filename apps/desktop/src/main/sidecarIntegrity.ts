import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  readdir
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  parseSidecarIntegrityManifestV1,
  type ManifestFileEntryV1
} from "../shared/pipelineResources.js";
import type {
  CmsPublisherAllowlist,
  CmsSignatureVerification
} from "./cmsSignatureVerifier.js";
import { verifyDetachedCmsSignature } from "./cmsSignatureVerifier.js";
import { validatePipelineRelativePathList } from "./pipelinePathSecurity.js";

export type SidecarIntegrityValidationCode =
  | "SIDECAR_ROOT_INVALID"
  | "SIDECAR_MANIFEST_READ_FAILED"
  | "SIDECAR_SIGNATURE_READ_FAILED"
  | "SIDECAR_FILE_MISSING"
  | "SIDECAR_FILE_UNREGISTERED"
  | "SIDECAR_FILE_COUNT_MISMATCH"
  | "SIDECAR_FILE_TYPE_UNSUPPORTED"
  | "SIDECAR_FILE_SIZE_MISMATCH"
  | "SIDECAR_FILE_HASH_MISMATCH"
  | "SIDECAR_FILE_CHANGED"
  | "SIDECAR_FILESYSTEM_INVALID";

export class SidecarIntegrityValidationError extends Error {
  readonly code: SidecarIntegrityValidationCode;

  constructor(code: SidecarIntegrityValidationCode) {
    super("Invalid sidecar integrity");
    this.name = "SidecarIntegrityValidationError";
    this.code = code;
  }
}

type SidecarTreeFile = {
  relativePath: string;
};

export type SidecarIntegrityVerification = {
  pipelineVersion: string;
  fileCount: number;
  signer: CmsSignatureVerification;
};

/**
 * Verifies a sidecar using the real detached-CMS verifier and Node filesystem.
 *
 * INCOMPLETE GATE (Node 24/win32): arbitrary non-symlink reparse tags and fully
 * hostile concurrent path replacement are not completely detectable because
 * Node exposes neither generic reparse-tag inspection nor
 * O_NOFOLLOW/O_DIRECTORY/O_PATH. This verifier rejects symbolic
 * links/junctions and realpath aliases and performs handle/path identity
 * checks, but native-helper-complete protection is deferred by user approval.
 */
export async function verifySidecarIntegrity(
  sidecarRoot: string,
  allowlist: CmsPublisherAllowlist
): Promise<SidecarIntegrityVerification> {
  const verifiedRoot = await resolveVerifiedRoot(sidecarRoot);
  const manifestBytes = await readMetadataFile(
    verifiedRoot,
    join(verifiedRoot, manifestName),
    "SIDECAR_MANIFEST_READ_FAILED"
  );
  const signatureBytes = await readMetadataFile(
    verifiedRoot,
    join(verifiedRoot, signatureName),
    "SIDECAR_SIGNATURE_READ_FAILED"
  );

  const signer = await verifyDetachedCmsSignature(
    manifestBytes,
    signatureBytes,
    allowlist
  );
  const manifest = parseManifestBytes(manifestBytes);
  validatePipelineRelativePathList(manifest.files.map((file) => file.relativePath));

  const treeFiles = await enumerateSidecarTree(verifiedRoot);
  validatePipelineRelativePathList(treeFiles.map((file) => file.relativePath));

  const manifestByPath = new Map(
    manifest.files.map((file) => [file.relativePath, file])
  );
  const treePaths = new Set(treeFiles.map((file) => file.relativePath));

  if (manifest.files.some((file) => !treePaths.has(file.relativePath))) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_MISSING");
  }
  if (treeFiles.some((file) => !manifestByPath.has(file.relativePath))) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_UNREGISTERED");
  }
  if (treeFiles.length !== manifest.files.length) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_COUNT_MISMATCH");
  }

  for (const treeFile of treeFiles) {
    const manifestFile = manifestByPath.get(treeFile.relativePath)!;
    const absolutePath = resolveContainedFile(verifiedRoot, treeFile.relativePath);
    await verifyRegularFile(verifiedRoot, absolutePath, manifestFile);
  }

  return {
    pipelineVersion: manifest.pipelineVersion,
    fileCount: treeFiles.length,
    signer
  };
}

const manifestName = "sidecar-integrity-manifest.json";
const signatureName = "sidecar-integrity-manifest.p7s";
const excludedTreePaths = new Set([manifestName, signatureName]);

async function resolveVerifiedRoot(sidecarRoot: string): Promise<string> {
  if (typeof sidecarRoot !== "string" || sidecarRoot.length === 0) {
    throw new SidecarIntegrityValidationError("SIDECAR_ROOT_INVALID");
  }

  const absoluteRoot = resolve(sidecarRoot);
  try {
    const metadata = await lstat(absoluteRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new SidecarIntegrityValidationError("SIDECAR_ROOT_INVALID");
    }
    const resolvedRoot = await realpath(absoluteRoot);
    if (!pathsAreEqual(absoluteRoot, resolvedRoot)) {
      throw new SidecarIntegrityValidationError("SIDECAR_ROOT_INVALID");
    }
    return resolvedRoot;
  } catch (error) {
    if (error instanceof SidecarIntegrityValidationError) throw error;
    throw new SidecarIntegrityValidationError("SIDECAR_ROOT_INVALID");
  }
}

async function readMetadataFile(
  sidecarRoot: string,
  absolutePath: string,
  readFailureCode: "SIDECAR_MANIFEST_READ_FAILED" | "SIDECAR_SIGNATURE_READ_FAILED"
): Promise<Uint8Array> {
  let expectedRealPath: string;
  try {
    expectedRealPath = (await inspectRegularPath(sidecarRoot, absolutePath)).realPath;
  } catch (error) {
    if (error instanceof SidecarIntegrityValidationError) throw error;
    throw new SidecarIntegrityValidationError(readFailureCode);
  }

  return useOpenFile(absolutePath, readFailureCode, async (handle) => {
    const before = await statOpenRegularFile(
      sidecarRoot,
      absolutePath,
      expectedRealPath,
      handle
    );
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await handle.readFile());
    } catch {
      throw new SidecarIntegrityValidationError(readFailureCode);
    }
    const after = await statOpenRegularFile(
      sidecarRoot,
      absolutePath,
      expectedRealPath,
      handle
    );
    assertFileUnchanged(before, after, bytes.byteLength);
    return bytes;
  });
}

function parseManifestBytes(manifestBytes: Uint8Array) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    decoded = undefined;
  }
  return parseSidecarIntegrityManifestV1(decoded);
}

async function enumerateSidecarTree(sidecarRoot: string): Promise<SidecarTreeFile[]> {
  const files: SidecarTreeFile[] = [];
  await enumerateDirectory(sidecarRoot, sidecarRoot, "", files);
  return files;
}

async function enumerateDirectory(
  sidecarRoot: string,
  absoluteDirectory: string,
  relativeDirectory: string,
  files: SidecarTreeFile[]
): Promise<void> {
  const before = await inspectDirectoryPath(
    absoluteDirectory,
    relativeDirectory === ""
  );
  let names: string[];
  try {
    names = await readdir(absoluteDirectory);
  } catch {
    throw new SidecarIntegrityValidationError("SIDECAR_FILESYSTEM_INVALID");
  }
  const afterRead = await inspectDirectoryPath(
    absoluteDirectory,
    relativeDirectory === ""
  );
  assertSameIdentity(before.metadata, afterRead.metadata);

  for (const name of names) {
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (relativeDirectory === "" && excludedTreePaths.has(relativePath)) continue;

    const absolutePath = join(absoluteDirectory, name);
    let inspected;
    try {
      inspected = await inspectTreePath(sidecarRoot, absolutePath);
    } catch {
      throw new SidecarIntegrityValidationError("SIDECAR_FILE_TYPE_UNSUPPORTED");
    }

    if (inspected.metadata.isDirectory()) {
      await enumerateDirectory(sidecarRoot, absolutePath, relativePath, files);
      continue;
    }
    if (inspected.metadata.isFile()) {
      files.push({ relativePath });
      continue;
    }
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_TYPE_UNSUPPORTED");
  }

  const afterTraversal = await inspectDirectoryPath(
    absoluteDirectory,
    relativeDirectory === ""
  );
  assertSameIdentity(before.metadata, afterTraversal.metadata);
}

function resolveContainedFile(sidecarRoot: string, relativePath: string): string {
  const absolutePath = resolve(sidecarRoot, ...relativePath.split("/"));
  const pathFromRoot = relative(sidecarRoot, absolutePath);
  if (
    pathFromRoot.length === 0
    || isAbsolute(pathFromRoot)
    || pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILESYSTEM_INVALID");
  }
  return absolutePath;
}

async function verifyRegularFile(
  sidecarRoot: string,
  absolutePath: string,
  manifestFile: ManifestFileEntryV1
): Promise<void> {
  let expectedRealPath: string;
  try {
    expectedRealPath = (await inspectRegularPath(sidecarRoot, absolutePath)).realPath;
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new SidecarIntegrityValidationError("SIDECAR_FILE_MISSING");
    }
    if (error instanceof SidecarIntegrityValidationError) throw error;
    throw new SidecarIntegrityValidationError("SIDECAR_FILESYSTEM_INVALID");
  }

  await useOpenFile(absolutePath, "SIDECAR_FILESYSTEM_INVALID", async (handle) => {
    const before = await statOpenRegularFile(
      sidecarRoot,
      absolutePath,
      expectedRealPath,
      handle
    );
    const hash = createHash("sha256");
    let byteSize = 0;
    const stream = handle.createReadStream({ autoClose: false });

    try {
      for await (const chunk of stream) {
        byteSize += chunk.byteLength;
        hash.update(chunk);
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new SidecarIntegrityValidationError("SIDECAR_FILE_MISSING");
      }
      throw new SidecarIntegrityValidationError("SIDECAR_FILESYSTEM_INVALID");
    }

    const after = await statOpenRegularFile(
      sidecarRoot,
      absolutePath,
      expectedRealPath,
      handle
    );
    assertFileUnchanged(before, after, byteSize);

    if (byteSize !== manifestFile.byteSize) {
      throw new SidecarIntegrityValidationError("SIDECAR_FILE_SIZE_MISMATCH");
    }
    if (hash.digest("hex") !== manifestFile.sha256.toLowerCase()) {
      throw new SidecarIntegrityValidationError("SIDECAR_FILE_HASH_MISMATCH");
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

async function inspectDirectoryPath(
  absolutePath: string,
  isRoot: boolean
): Promise<{ metadata: Stats; realPath: string }> {
  try {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new SidecarIntegrityValidationError(
        isRoot ? "SIDECAR_ROOT_INVALID" : "SIDECAR_FILE_TYPE_UNSUPPORTED"
      );
    }
    const resolvedPath = await realpath(absolutePath);
    if (!pathsAreEqual(absolutePath, resolvedPath)) {
      throw new SidecarIntegrityValidationError(
        isRoot ? "SIDECAR_ROOT_INVALID" : "SIDECAR_FILE_TYPE_UNSUPPORTED"
      );
    }
    return { metadata, realPath: resolvedPath };
  } catch (error) {
    if (error instanceof SidecarIntegrityValidationError) throw error;
    throw new SidecarIntegrityValidationError("SIDECAR_FILESYSTEM_INVALID");
  }
}

async function inspectTreePath(
  sidecarRoot: string,
  absolutePath: string
): Promise<{ metadata: Stats; realPath: string }> {
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_TYPE_UNSUPPORTED");
  }
  const resolvedPath = await realpath(absolutePath);
  assertCanonicalContainedPath(sidecarRoot, absolutePath, resolvedPath);
  return { metadata, realPath: resolvedPath };
}

async function inspectRegularPath(
  sidecarRoot: string,
  absolutePath: string
): Promise<{ metadata: Stats; realPath: string }> {
  const inspected = await inspectTreePath(sidecarRoot, absolutePath);
  if (!inspected.metadata.isFile()) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_TYPE_UNSUPPORTED");
  }
  return inspected;
}

async function statOpenRegularFile(
  sidecarRoot: string,
  absolutePath: string,
  expectedRealPath: string,
  handle: FileHandle
): Promise<Stats> {
  let handleMetadata: Stats;
  try {
    handleMetadata = await handle.stat();
  } catch {
    throw new SidecarIntegrityValidationError("SIDECAR_FILESYSTEM_INVALID");
  }
  if (!handleMetadata.isFile()) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_TYPE_UNSUPPORTED");
  }

  let inspected;
  try {
    inspected = await inspectRegularPath(sidecarRoot, absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new SidecarIntegrityValidationError("SIDECAR_FILE_CHANGED");
    }
    if (error instanceof SidecarIntegrityValidationError) {
      throw new SidecarIntegrityValidationError("SIDECAR_FILE_CHANGED");
    }
    throw new SidecarIntegrityValidationError("SIDECAR_FILESYSTEM_INVALID");
  }

  if (!pathsAreEqual(inspected.realPath, expectedRealPath)) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_CHANGED");
  }
  assertSameIdentity(handleMetadata, inspected.metadata);
  if (handleMetadata.size !== inspected.metadata.size) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_CHANGED");
  }
  return handleMetadata;
}

function assertFileUnchanged(
  before: Stats,
  after: Stats,
  streamedByteSize: number
): void {
  assertSameIdentity(before, after);
  if (
    before.size !== after.size
    || after.size !== streamedByteSize
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_CHANGED");
  }
}

function assertSameIdentity(before: Stats, after: Stats): void {
  const stableIdentityAvailable =
    identityIsAvailable(before) && identityIsAvailable(after);
  if (stableIdentityAvailable && (
    before.dev !== after.dev || before.ino !== after.ino
  )) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_CHANGED");
  }
  if (
    !stableIdentityAvailable
    && before.birthtimeMs > 0
    && after.birthtimeMs > 0
    && before.birthtimeMs !== after.birthtimeMs
  ) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_CHANGED");
  }
}

function identityIsAvailable(metadata: Stats): boolean {
  return Number.isSafeInteger(metadata.dev)
    && Number.isSafeInteger(metadata.ino)
    && (metadata.dev !== 0 || metadata.ino !== 0);
}

function assertCanonicalContainedPath(
  sidecarRoot: string,
  absolutePath: string,
  resolvedPath: string
): void {
  if (!pathsAreEqual(absolutePath, resolvedPath)) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_TYPE_UNSUPPORTED");
  }
  const pathFromRoot = relative(sidecarRoot, resolvedPath);
  if (
    pathFromRoot.length === 0
    || isAbsolute(pathFromRoot)
    || pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new SidecarIntegrityValidationError("SIDECAR_FILE_TYPE_UNSUPPORTED");
  }
}

function pathsAreEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function useOpenFile<T>(
  absolutePath: string,
  openFailureCode:
    | "SIDECAR_MANIFEST_READ_FAILED"
    | "SIDECAR_SIGNATURE_READ_FAILED"
    | "SIDECAR_FILESYSTEM_INVALID",
  action: (handle: FileHandle) => Promise<T>
): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, "r");
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new SidecarIntegrityValidationError(
        openFailureCode === "SIDECAR_FILESYSTEM_INVALID"
          ? "SIDECAR_FILE_MISSING"
          : openFailureCode
      );
    }
    throw new SidecarIntegrityValidationError(openFailureCode);
  }

  let actionFailed = false;
  try {
    return await action(handle);
  } catch (error) {
    actionFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch {
      if (!actionFailed) {
        throw new SidecarIntegrityValidationError("SIDECAR_FILESYSTEM_INVALID");
      }
    }
  }
}
