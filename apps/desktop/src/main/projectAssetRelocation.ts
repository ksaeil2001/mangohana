import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import type { TranslationProjectV2 } from "../shared/projectTypes.js";
import {
  parentDirectory,
  projectRelativePathIdentity,
  sameFilesystemPath,
  type PathSemantics
} from "./pathIdentity.js";
import { renameWithRetry } from "./projectSaveTransaction.js";

type RelocationAsset = {
  storedRelativePath: string;
  sha256: string;
  byteSize: number;
};

type StagedAsset = RelocationAsset & {
  sourcePath: string;
  stagingPath?: string;
  targetPath: string;
  reused: boolean;
};

export type PreparedProjectAssetRelocation = {
  beforeFinalRename(): Promise<void>;
  complete(): Promise<void>;
  rollback(): Promise<void>;
};

/**
 * Prepares the file assets referenced by a project for a cross-directory Save As.
 * The project keeps its existing relative paths; only the bytes are copied.
 */
export async function prepareProjectAssetRelocation(args: {
  sourceProjectFilePath: string;
  targetProjectFilePath: string;
  project: TranslationProjectV2;
  pathSemantics?: PathSemantics;
}): Promise<PreparedProjectAssetRelocation> {
  const sourceDirectory = dirname(args.sourceProjectFilePath);
  const targetDirectory = dirname(args.targetProjectFilePath);
  if (
    areProjectDirectoriesSame(
      args.sourceProjectFilePath,
      args.targetProjectFilePath,
      args.pathSemantics
    )
  ) {
    return noOpRelocation();
  }

  const assets = collectAssets(args.project, args.pathSemantics);
  if (assets.length === 0) return noOpRelocation();

  const stagingRoot = join(targetDirectory, ".trio-save-as-staging", randomUUID());
  const prepared: StagedAsset[] = [];
  try {
    await mkdir(stagingRoot, { recursive: true });
    for (const asset of assets) {
      const sourcePath = resolveStoredAssetPath(sourceDirectory, asset.storedRelativePath);
      await assertAssetMatches(sourcePath, asset, "source");
      const targetPath = resolveStoredAssetPath(targetDirectory, asset.storedRelativePath);
      const targetState = await inspectExistingAsset(targetPath, asset);
      if (targetState === "reused") {
        prepared.push({
          ...asset,
          sourcePath,
          targetPath,
          reused: true
        });
        continue;
      }

      const stagingPath = join(stagingRoot, String(prepared.length));
      await copyFile(sourcePath, stagingPath);
      await assertAssetMatches(stagingPath, asset, "staged");
      prepared.push({
        ...asset,
        sourcePath,
        stagingPath,
        targetPath,
        reused: false
      });
    }
  } catch (error) {
    const cleanupErrors = await collectCleanupErrors(stagingRoot, false);
    throw aggregateErrors("Asset relocation preparation failed", [error, ...cleanupErrors]);
  }

  const promoted: StagedAsset[] = [];
  let finalized = false;
  let stagingCleaned = false;
  return {
    async beforeFinalRename() {
      if (finalized) return;
      try {
        for (const asset of prepared) {
          if (asset.reused || !asset.stagingPath) continue;
          const existing = await inspectExistingAsset(asset.targetPath, asset);
          if (existing === "reused") {
            await rm(asset.stagingPath, { force: true });
            asset.reused = true;
            asset.stagingPath = undefined;
            continue;
          }
          await mkdir(dirname(asset.targetPath), { recursive: true });
          await renameWithRetry(asset.stagingPath, asset.targetPath);
          asset.stagingPath = undefined;
          promoted.push(asset);
        }
        await cleanupStagingRoot(stagingRoot);
        stagingCleaned = true;
        finalized = true;
      } catch (error) {
        const rollbackErrors = await rollbackPromotedAssets(promoted);
        const cleanupErrors = await collectCleanupErrors(stagingRoot, stagingCleaned);
        throw aggregateErrors(
          "Asset relocation failed before the project file was replaced",
          [error, ...rollbackErrors, ...cleanupErrors]
        );
      }
    },
    async complete() {
      if (stagingCleaned) return;
      await cleanupStagingRoot(stagingRoot);
      stagingCleaned = true;
    },
    async rollback() {
      const rollbackErrors = await rollbackPromotedAssets(promoted);
      const cleanupErrors = await collectCleanupErrors(stagingRoot, stagingCleaned);
      if (rollbackErrors.length > 0 || cleanupErrors.length > 0) {
        throw aggregateErrors(
          "Asset relocation rollback failed",
          [...rollbackErrors, ...cleanupErrors]
        );
      }
    }
  };
}

function collectAssets(
  project: TranslationProjectV2,
  semantics?: PathSemantics
): RelocationAsset[] {
  const byPath = new Map<string, RelocationAsset>();
  for (const asset of [...project.pageImages, ...project.processing.assets]) {
    const storedRelativePath = normalizeStoredRelativePath(asset.storedRelativePath);
    assertSafeStoredRelativePath(storedRelativePath);
    const candidate: RelocationAsset = {
      storedRelativePath,
      sha256: asset.sha256.toLowerCase(),
      byteSize: asset.byteSize
    };
    const pathKey = projectRelativePathIdentity(storedRelativePath, semantics);
    const existing = byPath.get(pathKey);
    if (existing) {
      if (existing.sha256 !== candidate.sha256 || existing.byteSize !== candidate.byteSize) {
        throw new Error(`Project asset metadata conflict for ${storedRelativePath}`);
      }
      continue;
    }
    byPath.set(pathKey, candidate);
  }
  return [...byPath.values()];
}

function resolveStoredAssetPath(projectDirectory: string, storedRelativePath: string): string {
  assertSafeStoredRelativePath(storedRelativePath);
  const absolutePath = resolve(projectDirectory, storedRelativePath.replaceAll("\\", "/"));
  const escaped = relative(resolve(projectDirectory), absolutePath);
  if (escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(escaped)) {
    throw new Error(`Project asset path escapes project root: ${storedRelativePath}`);
  }
  return absolutePath;
}

function assertSafeStoredRelativePath(storedRelativePath: string): void {
  if (
    storedRelativePath.length === 0 ||
    isAbsolute(storedRelativePath) ||
    win32.isAbsolute(storedRelativePath) ||
    /^[\\/]/.test(storedRelativePath) ||
    storedRelativePath.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`Project asset path must be relative and stay within project root: ${storedRelativePath}`);
  }
}

function normalizeStoredRelativePath(storedRelativePath: string): string {
  return storedRelativePath.replaceAll("\\", "/");
}

async function inspectExistingAsset(
  targetPath: string,
  expected: RelocationAsset
): Promise<"missing" | "reused"> {
  try {
    await assertAssetMatches(targetPath, expected, "target");
    return "reused";
  } catch (error) {
    if (error instanceof AssetMismatchError && error.missing) return "missing";
    if (isAssetMismatchError(error)) {
      throw new Error(`Project asset collision at ${expected.storedRelativePath}`);
    }
    throw error;
  }
}

async function assertAssetMatches(
  filePath: string,
  expected: RelocationAsset,
  label: string
): Promise<void> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new AssetMismatchError(`${label} asset is missing: ${expected.storedRelativePath}`, true);
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    throw new AssetMismatchError(`${label} asset is not a file: ${expected.storedRelativePath}`);
  }
  const bytes = await readFile(filePath);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (fileStat.size !== expected.byteSize || actualHash !== expected.sha256.toLowerCase()) {
    throw new AssetMismatchError(`${label} asset content does not match metadata: ${expected.storedRelativePath}`);
  }
}

async function rollbackPromotedAssets(assets: readonly StagedAsset[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const asset of [...assets].reverse()) {
    try {
      await assertAssetMatches(asset.targetPath, asset, "rollback");
      await rm(asset.targetPath, { force: true });
    } catch (error) {
      if (isMissingAssetError(error)) continue;
      errors.push(
        new Error(`Unable to remove promoted asset during rollback: ${asset.targetPath}`, {
          cause: error
        })
      );
    }
  }
  return errors;
}

function noOpRelocation(): PreparedProjectAssetRelocation {
  return {
    beforeFinalRename: async () => undefined,
    complete: async () => undefined,
    rollback: async () => undefined
  };
}

async function cleanupStagingRoot(stagingRoot: string): Promise<void> {
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    await rmdir(dirname(stagingRoot));
  } catch (error) {
    if (isExpectedStagingDirectoryCleanupError(error)) return;
    throw error;
  }
}

async function collectCleanupErrors(
  stagingRoot: string,
  alreadyCleaned: boolean
): Promise<unknown[]> {
  if (alreadyCleaned) return [];
  try {
    await cleanupStagingRoot(stagingRoot);
    return [];
  } catch (error) {
    return [new Error(`Unable to clean Save As staging: ${stagingRoot}`, { cause: error })];
  }
}

function aggregateErrors(message: string, errors: readonly unknown[]): AggregateError {
  const details = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join("; ");
  return new AggregateError(errors, details ? `${message}: ${details}` : message);
}

export function areProjectDirectoriesSame(
  leftProjectPath: string,
  rightProjectPath: string,
  semantics?: PathSemantics
): boolean {
  return sameFilesystemPath(
    parentDirectory(leftProjectPath, semantics),
    parentDirectory(rightProjectPath, semantics),
    semantics
  );
}

class AssetMismatchError extends Error {
  readonly code = "ASSET_MISMATCH";

  constructor(message: string, readonly missing = false) {
    super(message);
  }
}

function isAssetMismatchError(error: unknown): error is AssetMismatchError {
  return error instanceof AssetMismatchError;
}

function isMissingAssetError(error: unknown): boolean {
  return (
    isMissingPathError(error) ||
    (error instanceof AssetMismatchError && error.missing)
  );
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExpectedStagingDirectoryCleanupError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
      (error as NodeJS.ErrnoException).code === "EEXIST")
  );
}
