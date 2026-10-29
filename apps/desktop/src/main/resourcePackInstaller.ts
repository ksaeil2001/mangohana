import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import type { CmsPublisherAllowlist } from "./cmsSignatureVerifier.js";
import {
  normalizeCmsPublisherAllowlist,
  verifyDetachedCmsSignature
} from "./cmsSignatureVerifier.js";
import {
  validatePipelineRelativePath,
  validatePipelineRelativePathList
} from "./pipelinePathSecurity.js";
import {
  extractResourcePackArchive,
  RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
} from "./resourcePackArchive.js";
import { downloadResourcePack } from "./resourcePackDownloader.js";
import type {
  ManifestFileEntryV1,
  PipelineResourceErrorCode,
  PipelineResourceLockEntryV1,
  PipelineResourceLockV1,
  ResourcePackManifestV1
} from "../shared/pipelineResources.js";
import {
  parsePipelineResourceLockV1,
  parseResourcePackManifestV1
} from "../shared/pipelineResources.js";

export type ResourcePackInstallOptions = Readonly<{
  resourceStoreRoot: string;
  lock: Readonly<PipelineResourceLockV1>;
  resourceId: string;
  transactionId: string;
  publisherAllowlist: CmsPublisherAllowlist;
  signal?: AbortSignal;
}>;

export type ResourcePackInstallResult = Readonly<{
  resourceId: string;
  version: string;
  absolutePath: string;
  installed: boolean;
}>;

export type ResourcePackVerificationOptions = Readonly<{
  packRoot: string;
  entry: Readonly<PipelineResourceLockEntryV1>;
  pipelineVersion: string;
  publisherAllowlist: CmsPublisherAllowlist;
}>;

export type ResourcePackVerification = Readonly<{
  absolutePath: string;
}>;

export class ResourcePackInstallError extends Error {
  readonly code: PipelineResourceErrorCode;

  constructor(code: PipelineResourceErrorCode) {
    super("Resource pack installation failed");
    this.name = "ResourcePackInstallError";
    this.code = code;
  }
}

export class ResourcePackVerificationError extends Error {
  readonly code:
    | "RESOURCE_MISSING"
    | "RESOURCE_CORRUPT"
    | "RESOURCE_INCOMPATIBLE";

  constructor(code: ResourcePackVerificationError["code"]) {
    super("Resource pack verification failed");
    this.name = "ResourcePackVerificationError";
    this.code = code;
  }
}

export async function verifyInstalledResourcePack(
  options: ResourcePackVerificationOptions
): Promise<ResourcePackVerification> {
  try {
    const snapshot = snapshotResourcePackVerification(options);
    await verifyPack(
      snapshot.packRoot,
      snapshot.entry,
      snapshot.pipelineVersion,
      snapshot.publisherAllowlist
    );
    return Object.freeze({
      absolutePath: snapshot.packRoot
    });
  } catch (error) {
    if (error instanceof PackVerificationError) {
      const code = error.code === "RESOURCE_MISSING"
        ? "RESOURCE_MISSING"
        : error.code === "RESOURCE_INCOMPATIBLE"
          || error.code === "RESOURCE_COORDINATE_MISMATCH"
          ? "RESOURCE_INCOMPATIBLE"
          : "RESOURCE_CORRUPT";
      throw new ResourcePackVerificationError(code);
    }
    throw new ResourcePackVerificationError("RESOURCE_CORRUPT");
  }
}

function snapshotResourcePackVerification(
  options: ResourcePackVerificationOptions
): Readonly<{
  packRoot: string;
  entry: Readonly<PipelineResourceLockEntryV1>;
  pipelineVersion: string;
  publisherAllowlist: Readonly<CmsPublisherAllowlist>;
}> {
  const lock = parsePipelineResourceLockV1({
    schemaVersion: 1,
    appVersion: "resource-pack-verification",
    pipelineVersion: options.pipelineVersion,
    resources: [options.entry]
  });
  const entry = lock.resources[0]!;
  if (entry.download !== undefined) Object.freeze(entry.download);
  Object.freeze(entry.requiredFor);
  Object.freeze(entry);
  return Object.freeze({
    packRoot: options.packRoot,
    entry,
    pipelineVersion: lock.pipelineVersion,
    publisherAllowlist: normalizeCmsPublisherAllowlist(
      options.publisherAllowlist
    )
  });
}

export async function installResourcePack(
  options: ResourcePackInstallOptions
): Promise<ResourcePackInstallResult> {
  let transactionRoot: string | undefined;
  let partialRoot: string | undefined;
  let transactionCreated = false;
  let result: ResourcePackInstallResult | undefined;
  let failure: unknown;

  try {
    const storeRoot = validateAbsoluteRoot(options.resourceStoreRoot);
    const requestedResourceId = validatePathSegment(options.resourceId);
    const lock = parsePipelineResourceLockV1(options.lock);
    const entries = lock.resources.filter(
      (entry) => entry.resourceId === requestedResourceId
    );
    if (entries.length === 0) {
      throw new ResourcePackInstallError("RESOURCE_MISSING");
    }
    if (entries.length !== 1) {
      throw new ResourcePackInstallError("RESOURCE_CORRUPT");
    }
    const entry = entries[0]!;
    validatePathSegment(entry.resourceId);
    validatePathSegment(entry.version);
    validateTransactionId(options.transactionId);
    if (entry.distribution !== "download" || entry.download === undefined) {
      throw new ResourcePackInstallError("RESOURCE_INCOMPATIBLE");
    }

    await mkdir(storeRoot, { recursive: true });
    await ensureCanonicalDirectory(storeRoot);
    partialRoot = resolveDirectChild(storeRoot, ".partial");
    const resourceRoot = resolveDirectChild(storeRoot, entry.resourceId);
    const finalRoot = resolveDirectChild(resourceRoot, entry.version);

    const existing = await inspectExistingFinal(
      finalRoot,
      entry,
      lock.pipelineVersion,
      options.publisherAllowlist
    );
    if (existing) {
      return installResult(entry, finalRoot, false);
    }

    await mkdir(partialRoot, { recursive: true });
    await ensureCanonicalDirectory(partialRoot);
    await mkdir(resourceRoot, { recursive: true });
    await ensureCanonicalDirectory(resourceRoot);

    const transactionId = options.transactionId;
    transactionRoot = resolveDirectChild(partialRoot, transactionId);
    assertOwnedTransaction(partialRoot, transactionRoot, transactionId);
    await mkdir(transactionRoot);
    transactionCreated = true;
    await ensureCanonicalDirectory(transactionRoot);

    const archivePath = resolveDirectChild(transactionRoot, "resource-pack.zip");
    const manifestPath = resolveDirectChild(
      transactionRoot,
      "resource-manifest.json"
    );
    const signaturePath = resolveDirectChild(
      transactionRoot,
      "resource-manifest.p7s"
    );

    await downloadToOwnedFile(
      entry.download.archiveUrl,
      archivePath,
      options.signal
    );
    await downloadToOwnedFile(
      entry.download.manifestUrl,
      manifestPath,
      options.signal,
      RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
    );
    await downloadToOwnedFile(
      entry.download.signatureUrl,
      signaturePath,
      options.signal,
      RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
    );

    const manifestBytes = await readBoundedRegularFile(
      manifestPath,
      transactionRoot,
      RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
    );
    const signatureBytes = await readBoundedRegularFile(
      signaturePath,
      transactionRoot,
      RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
    );
    if (sha256(manifestBytes) !== entry.manifestSha256.toLowerCase()) {
      throw new ResourcePackInstallError("RESOURCE_CORRUPT");
    }
    await verifyDetachedCmsSignature(
      manifestBytes,
      signatureBytes,
      options.publisherAllowlist
    );
    const manifest = parseManifestBytes(manifestBytes);
    validateManifestAgainstLock(manifest, entry, lock.pipelineVersion);

    const packStagingRoot = resolveDirectChild(transactionRoot, "pack");
    await mkdir(packStagingRoot);
    await ensureCanonicalDirectory(packStagingRoot);
    const extraction = await extractResourcePackArchive(
      archivePath,
      packStagingRoot,
      options.publisherAllowlist
    );
    if (!manifestsAreEqual(extraction.manifest, manifest)) {
      throw new ResourcePackInstallError("RESOURCE_CORRUPT");
    }

    const extractedManifest = await readBoundedRegularFile(
      resolveDirectChild(packStagingRoot, "resource-manifest.json"),
      packStagingRoot,
      RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
    );
    const extractedSignature = await readBoundedRegularFile(
      resolveDirectChild(packStagingRoot, "resource-manifest.p7s"),
      packStagingRoot,
      RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
    );
    if (
      !extractedManifest.equals(manifestBytes)
      || !extractedSignature.equals(signatureBytes)
    ) {
      throw new ResourcePackInstallError("RESOURCE_CORRUPT");
    }

    await verifyPack(
      packStagingRoot,
      entry,
      lock.pipelineVersion,
      options.publisherAllowlist
    );

    const concurrentBeforeRename = await inspectExistingFinal(
      finalRoot,
      entry,
      lock.pipelineVersion,
      options.publisherAllowlist
    );
    if (concurrentBeforeRename) {
      result = installResult(entry, finalRoot, false);
    } else {
      publishPromotionPhase("before-rename", transactionId);
      try {
        await rename(packStagingRoot, finalRoot);
      } catch {
        publishPromotionPhase("rename-failed", transactionId);
        const concurrentAfterRenameFailure = await inspectExistingFinal(
          finalRoot,
          entry,
          lock.pipelineVersion,
          options.publisherAllowlist
        );
        if (!concurrentAfterRenameFailure) {
          throw new ResourcePackInstallError("RESOURCE_CORRUPT");
        }
        result = installResult(entry, finalRoot, false);
      }

      if (result === undefined) {
        await verifyPack(
          finalRoot,
          entry,
          lock.pipelineVersion,
          options.publisherAllowlist
        );
        result = installResult(entry, finalRoot, true);
      }
    }
  } catch (error) {
    failure = classifyInstallFailure(error);
  }

  if (
    transactionRoot !== undefined
    && partialRoot !== undefined
    && transactionCreated
  ) {
    try {
      await cleanupOwnedTransaction(partialRoot, transactionRoot);
    } catch {
      failure ??= new ResourcePackInstallError("RESOURCE_CORRUPT");
    }
  }

  if (failure !== undefined) throw failure;
  if (result === undefined) {
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
  return result;
}

const manifestName = "resource-manifest.json";
const signatureName = "resource-manifest.p7s";
const metadataNames = new Set([manifestName, signatureName]);
const promotionEventName = "resource-pack-installer:promotion-phase";
const canonicalUuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class PackVerificationError extends Error {
  readonly code:
    | "RESOURCE_MISSING"
    | "RESOURCE_CORRUPT"
    | "RESOURCE_INCOMPATIBLE"
    | "RESOURCE_COORDINATE_MISMATCH";

  constructor(code: PackVerificationError["code"]) {
    super("Resource pack verification failed");
    this.code = code;
  }
}

function validateAbsoluteRoot(root: string): string {
  if (
    typeof root !== "string"
    || root.length === 0
    || !isAbsolute(root)
    || !pathsAreEqual(root, resolve(root))
  ) {
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
  return resolve(root);
}

function validatePathSegment(value: string): string {
  if (
    typeof value !== "string"
    || value.includes("/")
    || value.includes("\\")
  ) {
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
  try {
    validatePipelineRelativePath(value);
  } catch {
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
  return value;
}

function validateTransactionId(value: string): void {
  if (typeof value !== "string" || !canonicalUuidV4.test(value)) {
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
}

function resolveDirectChild(parent: string, segment: string): string {
  const candidate = resolve(parent, segment);
  const pathFromParent = relative(parent, candidate);
  if (
    pathFromParent !== segment
    || isAbsolute(pathFromParent)
    || pathFromParent.startsWith(`..${sep}`)
  ) {
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
  return candidate;
}

async function ensureCanonicalDirectory(root: string): Promise<void> {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ResourcePackInstallError("RESOURCE_CORRUPT");
    }
    const canonical = await realpath(root);
    if (!pathsAreEqual(root, canonical)) {
      throw new ResourcePackInstallError("RESOURCE_CORRUPT");
    }
  } catch (error) {
    if (error instanceof ResourcePackInstallError) throw error;
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
}

async function downloadToOwnedFile(
  source: string,
  destination: string,
  signal: AbortSignal | undefined,
  maxDownloadBytes?: number
): Promise<void> {
  let handle;
  try {
    handle = await open(destination, "wx+");
    await downloadResourcePack(source, handle, {
      signal,
      ...(maxDownloadBytes === undefined
        ? {}
        : { policy: { maxDownloadBytes } })
    });
  } finally {
    await handle?.close();
  }
}

function publishPromotionPhase(
  phase: "before-rename" | "rename-failed",
  transactionId: string
): void {
  const message = Object.freeze({ phase, transactionId });
  for (const observer of process.rawListeners(promotionEventName)) {
    try {
      const result = Reflect.apply(observer, process, [message]);
      void Promise.resolve(result).catch(() => {
        // Asynchronous observers are also observation-only.
      });
    } catch {
      // Synchronous observer failures cannot alter installation decisions.
    }
  }
}

function parseManifestBytes(bytes: Uint8Array): ResourcePackManifestV1 {
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
  return parseResourcePackManifestV1(input);
}

function validateManifestAgainstLock(
  manifest: ResourcePackManifestV1,
  entry: PipelineResourceLockEntryV1,
  pipelineVersion: string
): void {
  if (
    manifest.resourceId !== entry.resourceId
    || manifest.version !== entry.version
    || manifest.role !== entry.role
  ) {
    throw new PackVerificationError("RESOURCE_COORDINATE_MISMATCH");
  }

  try {
    validatePipelineRelativePathList(
      manifest.files.map((file) => file.relativePath)
    );
    validatePipelineRelativePathList(manifest.licenseFiles);
  } catch {
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }

  const declaredPaths = new Set(
    manifest.files.map((file) => file.relativePath)
  );
  if (
    manifest.licenseFiles.length === 0
    || manifest.licenseFiles.some((path) => !declaredPaths.has(path))
  ) {
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }
  if (!manifest.compatiblePipelineVersions.includes(pipelineVersion)) {
    throw new PackVerificationError("RESOURCE_INCOMPATIBLE");
  }
}

async function inspectExistingFinal(
  finalRoot: string,
  entry: PipelineResourceLockEntryV1,
  pipelineVersion: string,
  publisherAllowlist: CmsPublisherAllowlist
): Promise<boolean> {
  try {
    await lstat(finalRoot);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }

  await verifyPack(finalRoot, entry, pipelineVersion, publisherAllowlist);
  return true;
}

async function verifyPack(
  packRoot: string,
  entry: Readonly<PipelineResourceLockEntryV1>,
  pipelineVersion: string,
  publisherAllowlist: CmsPublisherAllowlist
): Promise<void> {
  await ensureCanonicalPackRoot(packRoot);
  const manifestPath = resolveDirectPackFile(packRoot, manifestName);
  const signaturePath = resolveDirectPackFile(packRoot, signatureName);
  const manifestBytes = await readBoundedRegularFile(
    manifestPath,
    packRoot,
    RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
  );
  const signatureBytes = await readBoundedRegularFile(
    signaturePath,
    packRoot,
    RESOURCE_ARCHIVE_METADATA_MEMORY_LIMIT_BYTES
  );
  if (sha256(manifestBytes) !== entry.manifestSha256.toLowerCase()) {
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }
  await verifyDetachedCmsSignature(
    manifestBytes,
    signatureBytes,
    publisherAllowlist
  );
  const manifest = parseManifestBytes(manifestBytes);
  validateManifestAgainstLock(manifest, entry, pipelineVersion);

  const treePaths = await enumeratePayloadFiles(packRoot);
  const declaredPaths = validatePipelineRelativePathList(
    manifest.files.map((file) => file.relativePath)
  );
  const declaredSet = new Set(declaredPaths);
  const treeSet = new Set(treePaths);
  if (declaredPaths.some((path) => !treeSet.has(path))) {
    throw new PackVerificationError("RESOURCE_MISSING");
  }
  if (
    treePaths.length !== declaredPaths.length
    || treePaths.some((path) => !declaredSet.has(path))
  ) {
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }

  const filesByPath = new Map(
    manifest.files.map((file) => [file.relativePath, file])
  );
  for (const relativePath of treePaths) {
    await verifyDeclaredFile(
      packRoot,
      relativePath,
      filesByPath.get(relativePath)!
    );
  }

  for (const licensePath of manifest.licenseFiles) {
    if (!filesByPath.has(licensePath)) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
  }
}

async function ensureCanonicalPackRoot(root: string): Promise<void> {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
    const canonical = await realpath(root);
    if (!pathsAreEqual(root, canonical)) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
  } catch (error) {
    if (error instanceof PackVerificationError) throw error;
    if (isMissingPathError(error)) {
      throw new PackVerificationError("RESOURCE_MISSING");
    }
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }
}

async function enumeratePayloadFiles(packRoot: string): Promise<string[]> {
  const files: string[] = [];
  await visit(packRoot, "");
  validatePipelineRelativePathList(files);
  return files;

  async function visit(
    absoluteDirectory: string,
    relativeDirectory: string
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(absoluteDirectory);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new PackVerificationError("RESOURCE_MISSING");
      }
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
    names.sort();

    for (const name of names) {
      const relativePath = relativeDirectory === ""
        ? name
        : `${relativeDirectory}/${name}`;
      validatePipelineRelativePath(relativePath);
      const absolutePath = resolveDirectPackFile(packRoot, relativePath);
      let metadata;
      try {
        metadata = await lstat(absolutePath);
      } catch (error) {
        if (isMissingPathError(error)) {
          throw new PackVerificationError("RESOURCE_MISSING");
        }
        throw new PackVerificationError("RESOURCE_CORRUPT");
      }
      if (metadata.isSymbolicLink()) {
        throw new PackVerificationError("RESOURCE_CORRUPT");
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        if (!metadataNames.has(relativePath)) files.push(relativePath);
      } else {
        throw new PackVerificationError("RESOURCE_CORRUPT");
      }
    }
  }
}

async function verifyDeclaredFile(
  packRoot: string,
  relativePath: string,
  declaration: ManifestFileEntryV1
): Promise<void> {
  const absolutePath = resolveDirectPackFile(packRoot, relativePath);
  const { handle, before } = await openVerifiedRegularFile(
    absolutePath,
    packRoot
  );
  try {
    if (before.size !== declaration.byteSize) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(chunk.length, before.size - position);
      const { bytesRead } = await handle.read(
        chunk,
        0,
        length,
        position
      );
      if (bytesRead <= 0 || bytesRead > length) {
        throw new PackVerificationError("RESOURCE_CORRUPT");
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    await assertEndOfFile(handle, position);
    const after = await handle.stat();
    assertFileStable(before, after, position);
    if (hash.digest("hex") !== declaration.sha256.toLowerCase()) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
  } catch (error) {
    if (error instanceof PackVerificationError) throw error;
    throw new PackVerificationError("RESOURCE_CORRUPT");
  } finally {
    await handle.close();
  }
}

function resolveDirectPackFile(packRoot: string, relativePath: string): string {
  try {
    validatePipelineRelativePath(relativePath);
  } catch {
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }
  const candidate = resolve(packRoot, ...relativePath.split("/"));
  const pathFromRoot = relative(packRoot, candidate);
  if (
    pathFromRoot.length === 0
    || isAbsolute(pathFromRoot)
    || pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }
  return candidate;
}

async function readBoundedRegularFile(
  absolutePath: string,
  containingRoot: string,
  maxBytes: number
): Promise<Buffer> {
  const { handle, before } = await openVerifiedRegularFile(
    absolutePath,
    containingRoot
  );
  try {
    if (
      !Number.isSafeInteger(before.size)
      || before.size < 0
      || before.size > maxBytes
    ) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        before.size - position,
        position
      );
      if (bytesRead <= 0 || bytesRead > before.size - position) {
        throw new PackVerificationError("RESOURCE_CORRUPT");
      }
      position += bytesRead;
    }
    await assertEndOfFile(handle, position);
    const after = await handle.stat();
    assertFileStable(before, after, position);
    return bytes;
  } catch (error) {
    if (error instanceof PackVerificationError) throw error;
    throw new PackVerificationError("RESOURCE_CORRUPT");
  } finally {
    await handle.close();
  }
}

async function openVerifiedRegularFile(
  absolutePath: string,
  containingRoot: string
) {
  let handle;
  try {
    const pathMetadata = await lstat(absolutePath);
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
    const canonicalPath = await realpath(absolutePath);
    const pathFromRoot = relative(containingRoot, canonicalPath);
    if (
      pathFromRoot.length === 0
      || isAbsolute(pathFromRoot)
      || pathFromRoot === ".."
      || pathFromRoot.startsWith(`..${sep}`)
    ) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }

    handle = await open(absolutePath, "r");
    const before = await handle.stat();
    if (
      !before.isFile()
      || pathMetadata.dev !== before.dev
      || pathMetadata.ino !== before.ino
      || pathMetadata.size !== before.size
    ) {
      throw new PackVerificationError("RESOURCE_CORRUPT");
    }
    return { handle, before };
  } catch (error) {
    await handle?.close();
    if (error instanceof PackVerificationError) throw error;
    if (isMissingPathError(error)) {
      throw new PackVerificationError("RESOURCE_MISSING");
    }
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }
}

async function assertEndOfFile(
  handle: Awaited<ReturnType<typeof open>>,
  position: number
): Promise<void> {
  const extraByte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(extraByte, 0, 1, position);
  if (bytesRead !== 0) {
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }
}

function assertFileStable(
  before: Stats,
  after: Stats,
  bytesRead: number
): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || bytesRead !== after.size
  ) {
    throw new PackVerificationError("RESOURCE_CORRUPT");
  }
}

function manifestsAreEqual(
  left: ResourcePackManifestV1,
  right: ResourcePackManifestV1
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function installResult(
  entry: PipelineResourceLockEntryV1,
  absolutePath: string,
  installed: boolean
): ResourcePackInstallResult {
  return {
    resourceId: entry.resourceId,
    version: entry.version,
    absolutePath,
    installed
  };
}

function assertOwnedTransaction(
  partialRoot: string,
  transactionRoot: string,
  transactionId: string
): void {
  validateTransactionId(transactionId);
  if (
    !pathsAreEqual(
      transactionRoot,
      resolveDirectChild(partialRoot, transactionId)
    )
    || relative(partialRoot, transactionRoot) !== transactionId
  ) {
    throw new ResourcePackInstallError("RESOURCE_CORRUPT");
  }
}

async function cleanupOwnedTransaction(
  partialRoot: string,
  transactionRoot: string
): Promise<void> {
  const transactionId = relative(partialRoot, transactionRoot);
  assertOwnedTransaction(partialRoot, transactionRoot, transactionId);
  try {
    const metadata = await lstat(transactionRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ResourcePackInstallError("RESOURCE_CORRUPT");
    }
    const canonical = await realpath(transactionRoot);
    if (!pathsAreEqual(canonical, transactionRoot)) {
      throw new ResourcePackInstallError("RESOURCE_CORRUPT");
    }
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  await rm(transactionRoot, {
    recursive: true,
    force: false,
    maxRetries: 2,
    retryDelay: 50
  });
}

function classifyInstallFailure(error: unknown): ResourcePackInstallError {
  if (error instanceof ResourcePackInstallError) return error;
  if (error instanceof PackVerificationError) {
    return new ResourcePackInstallError(
      error.code === "RESOURCE_INCOMPATIBLE"
        ? "RESOURCE_INCOMPATIBLE"
        : "RESOURCE_CORRUPT"
    );
  }
  return new ResourcePackInstallError("RESOURCE_CORRUPT");
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function pathsAreEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}
