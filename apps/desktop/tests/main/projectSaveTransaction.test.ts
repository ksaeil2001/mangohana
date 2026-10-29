import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverProjectFile } from "../../src/main/projectRecovery";
import { replaceProjectFileAtomically } from "../../src/main/projectSaveTransaction";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "project-transaction-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("project-only atomic replace", () => {
  it("leaves the existing project untouched when candidate validation fails", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "old-valid", "utf8");

    await expect(
      replaceProjectFileAtomically({
        filePath,
        writeCandidate: (candidatePath) => writeFile(candidatePath, "invalid-candidate", "utf8"),
        validateFile: async (candidatePath) => {
          if ((await readFile(candidatePath, "utf8")) !== "old-valid") throw new Error("candidate invalid");
        }
      })
    ).rejects.toThrow(/candidate invalid/);

    await expect(readFile(filePath, "utf8")).resolves.toBe("old-valid");
  });

  it("restores the backup when final verification fails", async () => {
    const filePath = join(tempDir, "project.ctp");
    let validations = 0;
    await writeFile(filePath, "old-valid", "utf8");

    await expect(
      replaceProjectFileAtomically({
        filePath,
        writeCandidate: (candidatePath) => writeFile(candidatePath, "new-valid", "utf8"),
        validateFile: async () => {
          validations += 1;
          if (validations === 2) throw new Error("final verification failed");
        }
      })
    ).rejects.toThrow(/final verification failed/);

    await expect(readFile(filePath, "utf8")).resolves.toBe("old-valid");

    await expect(
      replaceProjectFileAtomically({
        filePath,
        writeCandidate: (candidatePath) => writeFile(candidatePath, "retry-valid", "utf8"),
        validateFile: async () => undefined
      })
    ).resolves.toBeUndefined();
    await expect(readFile(filePath, "utf8")).resolves.toBe("retry-valid");
    await expect(readFile(`${filePath}.candidate`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the backup when the Windows candidate rename fails", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "old-valid", "utf8");

    await expect(
      replaceProjectFileAtomically({
        filePath,
        writeCandidate: (candidatePath) => writeFile(candidatePath, "new-valid", "utf8"),
        validateFile: async () => undefined,
        beforeFinalRename: () => {
          throw new Error("EPERM rename");
        }
      })
    ).rejects.toThrow(/EPERM/);

    await expect(readFile(filePath, "utf8")).resolves.toBe("old-valid");
  });

  it("reports candidate validation and verified project replacement in order", async () => {
    const filePath = join(tempDir, "project.ctp");
    const stages: string[] = [];
    await writeFile(filePath, "old-valid", "utf8");

    await replaceProjectFileAtomically({
      filePath,
      writeCandidate: (candidatePath) => writeFile(candidatePath, "new-valid", "utf8"),
      validateFile: async () => undefined,
      afterCandidateValidated: () => {
        stages.push("candidate_validated");
      },
      afterProjectReplaced: async () => {
        stages.push("project_replaced");
        await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
        await expect(readFile(`${filePath}.bak`, "utf8")).resolves.toBe("old-valid");
      }
    });

    expect(stages).toEqual(["candidate_validated", "project_replaced"]);
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("retries on transient EPERM/EBUSY and succeeds when lock is released", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "old-valid", "utf8");

    let attempts = 0;
    const transientRename = async (from: string, to: string) => {
      if (to === filePath) {
        attempts += 1;
        if (attempts <= 2) {
          const err = new Error("Resource temporarily locked") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
      }
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    };

    await replaceProjectFileAtomically({
      filePath,
      writeCandidate: (candidatePath) => writeFile(candidatePath, "new-retried", "utf8"),
      validateFile: async () => undefined,
      renameFile: transientRename,
      retryOptions: { maxRetries: 3, initialDelayMs: 5, backoffFactor: 2 }
    });

    expect(attempts).toBe(3); // 2 failures, 3rd succeeded
    await expect(readFile(filePath, "utf8")).resolves.toBe("new-retried");
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails and restores backup after exceeding max retries on persistent EBUSY", async () => {
    const filePath = join(tempDir, "project.ctp");
    const candidatePath = `${filePath}.candidate`;
    await writeFile(filePath, "old-valid", "utf8");

    let attempts = 0;
    const alwaysLockedRename = async (from: string, to: string) => {
      if (from === candidatePath && to === filePath) {
        attempts += 1;
        const err = new Error("File busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    };

    await expect(
      replaceProjectFileAtomically({
        filePath,
        writeCandidate: (candidatePath) => writeFile(candidatePath, "new-locked", "utf8"),
        validateFile: async () => undefined,
        renameFile: alwaysLockedRename,
        retryOptions: { maxRetries: 3, initialDelayMs: 5, backoffFactor: 2 }
      })
    ).rejects.toMatchObject({ code: "EBUSY" });

    expect(attempts).toBe(4); // 0, 1, 2, 3 = 4 total attempts
    await expect(readFile(filePath, "utf8")).resolves.toBe("old-valid");
    await expect(readFile(`${filePath}.candidate`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces rollback errors and keeps recovery files when current cannot be moved back", async () => {
    const filePath = join(tempDir, "project.ctp");
    const candidatePath = `${filePath}.candidate`;
    const backupPath = `${filePath}.bak`;
    await writeFile(filePath, "old-valid", "utf8");

    const lockedRename = createPhaseLockedRename({
      filePath,
      candidatePath,
      failCurrentToCandidate: lockedRenameError("EPERM", "Access denied")
    });

    const error = await replaceProjectFileAtomically({
      filePath,
      writeCandidate: (nextCandidatePath) => writeFile(nextCandidatePath, "new-valid", "utf8"),
      validateFile: async () => undefined,
      afterProjectReplaced: () => {
        throw new Error("afterProjectReplaced failed");
      },
      renameFile: lockedRename,
      retryOptions: { maxRetries: 1, initialDelayMs: 1, backoffFactor: 1 }
    }).then(
      () => {
        throw new Error("expected replaceProjectFileAtomically to reject");
      },
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/rollback failed/i);
    expect((error as AggregateError).errors[0]).toEqual(
      expect.objectContaining({ message: "afterProjectReplaced failed" })
    );
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EPERM" })])
    );

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
    await expect(readFile(backupPath, "utf8")).resolves.toBe("old-valid");
    await expect(readFile(candidatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await expect(recoverProjectFile({
      filePath,
      validateFile: async (recoveredPath) => {
        if (!(await readFile(recoveredPath, "utf8")).endsWith("valid")) {
          throw new Error("invalid project");
        }
      }
    })).resolves.toBe("current");

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(candidatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the promoted candidate when backup restore fails after rolling current back", async () => {
    const filePath = join(tempDir, "project.ctp");
    const candidatePath = `${filePath}.candidate`;
    const backupPath = `${filePath}.bak`;
    await writeFile(filePath, "old-valid", "utf8");

    const lockedRename = createPhaseLockedRename({
      filePath,
      candidatePath,
      backupPath,
      failBackupToCurrent: lockedRenameError("EBUSY", "File busy")
    });

    const error = await replaceProjectFileAtomically({
      filePath,
      writeCandidate: (nextCandidatePath) => writeFile(nextCandidatePath, "new-valid", "utf8"),
      validateFile: async (validatedPath) => {
        if (validatedPath === filePath) throw new Error("final verification failed");
      },
      renameFile: lockedRename,
      retryOptions: { maxRetries: 1, initialDelayMs: 1, backoffFactor: 1 }
    }).then(
      () => {
        throw new Error("expected replaceProjectFileAtomically to reject");
      },
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/rollback failed/i);
    expect((error as AggregateError).errors[0]).toEqual(
      expect.objectContaining({ message: "final verification failed" })
    );
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EBUSY" })])
    );

    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(backupPath, "utf8")).resolves.toBe("old-valid");
    await expect(readFile(candidatePath, "utf8")).resolves.toBe("new-valid");

    await expect(recoverProjectFile({
      filePath,
      validateFile: async (recoveredPath) => {
        if (!(await readFile(recoveredPath, "utf8")).endsWith("valid")) {
          throw new Error("invalid project");
        }
      }
    })).resolves.toBe("candidate_restored");

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
    await expect(readFile(candidatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(backupPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not wrap the original error when backup restore succeeds", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "old-valid", "utf8");

    const error = await replaceProjectFileAtomically({
      filePath,
      writeCandidate: (candidatePath) => writeFile(candidatePath, "new-valid", "utf8"),
      validateFile: async (validatedPath) => {
        if (validatedPath === filePath) throw new Error("final verification failed");
      }
    }).then(
      () => {
        throw new Error("expected replaceProjectFileAtomically to reject");
      },
      (reason: unknown) => reason
    );

    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error).toEqual(expect.objectContaining({ message: "final verification failed" }));
    await expect(readFile(filePath, "utf8")).resolves.toBe("old-valid");
    await expect(readFile(`${filePath}.candidate`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function lockedRenameError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createPhaseLockedRename(args: {
  filePath: string;
  candidatePath: string;
  backupPath?: string;
  failCurrentToCandidate?: NodeJS.ErrnoException;
  failBackupToCurrent?: NodeJS.ErrnoException;
}): (from: string, to: string) => Promise<void> {
  let candidatePromoted = false;
  return async (from, to) => {
    if (from === args.candidatePath && to === args.filePath) {
      await rename(from, to);
      candidatePromoted = true;
      return;
    }
    if (
      candidatePromoted &&
      args.failCurrentToCandidate &&
      from === args.filePath &&
      to === args.candidatePath
    ) {
      throw args.failCurrentToCandidate;
    }
    if (
      candidatePromoted &&
      args.failBackupToCurrent &&
      args.backupPath &&
      from === args.backupPath &&
      to === args.filePath
    ) {
      throw args.failBackupToCurrent;
    }
    await rename(from, to);
  };
}
