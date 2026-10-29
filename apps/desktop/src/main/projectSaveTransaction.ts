import { rm, rename as defaultRename, stat } from "node:fs/promises";

export type ProjectFileTransactionArgs = {
  filePath: string;
  writeCandidate: (candidatePath: string) => Promise<void>;
  validateFile: (filePath: string) => Promise<void>;
  afterCandidateValidated?: () => void | Promise<void>;
  beforeFinalRename?: () => void | Promise<void>;
  afterProjectReplaced?: () => void | Promise<void>;
  renameFile?: (from: string, to: string) => Promise<void>;
  retryOptions?: RenameRetryOptions;
};

export type RenameRetryOptions = {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
};

const DEFAULT_RENAME_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 50;
const DEFAULT_BACKOFF_FACTOR = 2;

export async function renameWithRetry(
  fromPath: string,
  toPath: string,
  options?: RenameRetryOptions,
  customRename?: (from: string, to: string) => Promise<void>
): Promise<void> {
  const renameFn = customRename ?? defaultRename;
  const maxRetries = options?.maxRetries ?? DEFAULT_RENAME_RETRIES;
  const initialDelay = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const factor = options?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;

  let currentDelay = initialDelay;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await renameFn(fromPath, toPath);
      return;
    } catch (error) {
      if (attempt === maxRetries || !isRetryableRenameError(error)) {
        throw error;
      }
      await delay(currentDelay);
      currentDelay *= factor;
    }
  }
}

export async function replaceProjectFileAtomically(args: ProjectFileTransactionArgs): Promise<void> {
  const candidatePath = `${args.filePath}.candidate`;
  const backupPath = `${args.filePath}.bak`;
  const renameFn = (from: string, to: string) =>
    renameWithRetry(from, to, args.retryOptions, args.renameFile);

  if ((await pathExists(candidatePath)) || (await pathExists(backupPath))) {
    throw new Error("Project save transaction blocked: recovery files already exist");
  }
  try {
    await args.writeCandidate(candidatePath);
    await args.validateFile(candidatePath);
    await args.afterCandidateValidated?.();
  } catch (error) {
    if (await pathExists(candidatePath)) await rm(candidatePath);
    throw error;
  }

  const hadExistingProject = await pathExists(args.filePath);
  let backupCreated = false;
  let candidatePromoted = false;
  try {
    if (hadExistingProject) {
      await renameFn(args.filePath, backupPath);
      backupCreated = true;
    }

    await args.beforeFinalRename?.();
    await renameFn(candidatePath, args.filePath);
    candidatePromoted = true;
    await args.validateFile(args.filePath);
    await args.afterProjectReplaced?.();

    if (backupCreated) await rm(backupPath);
  } catch (error) {
    await rollbackFailedProjectReplace({
      error,
      filePath: args.filePath,
      candidatePath,
      backupPath,
      backupCreated,
      candidatePromoted,
      renameFn
    });
  }
}

async function rollbackFailedProjectReplace(args: {
  error: unknown;
  filePath: string;
  candidatePath: string;
  backupPath: string;
  backupCreated: boolean;
  candidatePromoted: boolean;
  renameFn: (from: string, to: string) => Promise<void>;
}): Promise<never> {
  const rollbackErrors: unknown[] = [];
  let promotedFileMovedToCandidate = await pathExists(args.candidatePath);

  if (args.candidatePromoted && (await pathExists(args.filePath))) {
    try {
      await args.renameFn(args.filePath, args.candidatePath);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    promotedFileMovedToCandidate = await pathExists(args.candidatePath);
  }

  if (args.backupCreated && (await pathExists(args.backupPath))) {
    const currentExists = await pathExists(args.filePath);
    // Restore backup only when the promoted file is already preserved at
    // .candidate (or current is missing). Overwriting current would destroy
    // the only remaining copy of the new project.
    if (!currentExists || promotedFileMovedToCandidate) {
      try {
        await args.renameFn(args.backupPath, args.filePath);
      } catch (restoreError) {
        rollbackErrors.push(restoreError);
      }
    }
  }

  const currentExistsAfter = await pathExists(args.filePath);
  const backupExistsAfter = await pathExists(args.backupPath);
  const candidateExistsAfter = await pathExists(args.candidatePath);
  const previousProjectRestored = args.backupCreated
    ? currentExistsAfter && !backupExistsAfter
    : !currentExistsAfter;

  // Discard .candidate only after the previous project is current again.
  // Incomplete rollback must leave .candidate/.bak for recoverProjectFile.
  if (previousProjectRestored && candidateExistsAfter) {
    try {
      await rm(args.candidatePath);
    } catch (cleanupError) {
      rollbackErrors.push(cleanupError);
    }
  }

  throwWithRollbackErrors(args.error, rollbackErrors);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isRetryableRenameError(error: unknown): boolean {
  if (isNodeError(error)) {
    return (
      error.code === "EPERM" ||
      error.code === "EBUSY" ||
      error.code === "EACCES" ||
      error.code === "EEXIST"
    );
  }
  return false;
}


function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwWithRollbackErrors(originalError: unknown, rollbackErrors: unknown[]): never {
  if (rollbackErrors.length === 0) throw originalError;
  const errors = [originalError, ...rollbackErrors];
  const details = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join("; ");
  throw new AggregateError(errors, `Project save failed and file rollback failed: ${details}`);
}
