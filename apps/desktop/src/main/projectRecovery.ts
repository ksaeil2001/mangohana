import { rm, stat } from "node:fs/promises";
import { renameWithRetry } from "./projectSaveTransaction.js";

export async function recoverProjectFile(args: {
  filePath: string;
  validateFile: (filePath: string) => Promise<void>;
}): Promise<"current" | "backup_restored" | "candidate_restored"> {
  let currentError: unknown;
  try {
    await args.validateFile(args.filePath);
  } catch (error) {
    currentError = error;
  }

  const backupPath = `${args.filePath}.bak`;
  const candidatePath = `${args.filePath}.candidate`;
  if (currentError === undefined) {
    if (await pathExists(candidatePath)) {
      if (await pathExists(backupPath)) {
        if (!(await isValid(candidatePath, args.validateFile))) {
          const invalidCandidatePath = `${args.filePath}.recovery-invalid-candidate`;
          if (!(await pathExists(invalidCandidatePath))) {
            await renameWithRetry(candidatePath, invalidCandidatePath);
          } else {
            await rm(candidatePath, { force: true });
          }
          await rm(backupPath, { force: true });
          return "current";
        }
        await rm(backupPath, { force: true });
      }
      if (await isValid(candidatePath, args.validateFile)) {
        await renameWithRetry(args.filePath, backupPath);
        try {
          await renameWithRetry(candidatePath, args.filePath);
          await args.validateFile(args.filePath);
          await rm(backupPath);
          return "candidate_restored";
        } catch (error) {
          const rollbackErrors: unknown[] = [];
          try {
            if (await pathExists(args.filePath)) {
              await renameWithRetry(args.filePath, candidatePath);
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          const promotedPreserved = await pathExists(candidatePath);
          if (await pathExists(backupPath) && (!(await pathExists(args.filePath)) || promotedPreserved)) {
            try {
              await renameWithRetry(backupPath, args.filePath);
            } catch (restoreError) {
              rollbackErrors.push(restoreError);
            }
          }
          if (rollbackErrors.length > 0) {
            const errors = [error, ...rollbackErrors];
            const details = errors
              .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
              .join("; ");
            throw new AggregateError(
              errors,
              `Project recovery failed and file rollback failed: ${details}`
            );
          }
          throw error;
        }
      }
      const invalidCandidatePath = `${args.filePath}.recovery-invalid-candidate`;
      if (await pathExists(invalidCandidatePath)) {
        await rm(candidatePath, { force: true });
      } else {
        await renameWithRetry(candidatePath, invalidCandidatePath);
      }
    }
    if ((await pathExists(backupPath)) && !(await pathExists(candidatePath))) {
      await rm(backupPath);
    }
    return "current";
  }

  const candidateValid = await isValid(candidatePath, args.validateFile);
  if (!(await pathExists(args.filePath)) && candidateValid) {
    await renameWithRetry(candidatePath, args.filePath);
    await args.validateFile(args.filePath);
    if (await pathExists(backupPath)) await rm(backupPath);
    return "candidate_restored";
  }

  if (await isValid(backupPath, args.validateFile)) {
    if (await pathExists(args.filePath)) {
      const invalidPath = `${args.filePath}.recovery-invalid`;
      if (!(await pathExists(invalidPath))) {
        await renameWithRetry(args.filePath, invalidPath);
      } else {
        await rm(args.filePath, { force: true });
      }
    }
    if (await pathExists(candidatePath)) {
      const invalidCandidatePath = `${args.filePath}.recovery-invalid-candidate`;
      if (!(await pathExists(invalidCandidatePath))) {
        await renameWithRetry(candidatePath, invalidCandidatePath);
      } else {
        await rm(candidatePath, { force: true });
      }
    }
    await renameWithRetry(backupPath, args.filePath);
    return "backup_restored";
  }
  if (candidateValid) {
    if (await pathExists(args.filePath)) {
      if (await pathExists(backupPath)) await rm(backupPath, { force: true });
      await renameWithRetry(args.filePath, backupPath);
    }
    await renameWithRetry(candidatePath, args.filePath);
    return "candidate_restored";
  }
  throw currentError;
}

async function isValid(
  filePath: string,
  validateFile: (filePath: string) => Promise<void>
): Promise<boolean> {
  if (!(await pathExists(filePath))) return false;
  try {
    await validateFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
