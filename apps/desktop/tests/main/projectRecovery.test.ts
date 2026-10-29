import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverProjectFile } from "../../src/main/projectRecovery";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "project-recovery-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("project-only recovery", () => {
  it("restores a valid backup on Windows without deleting the invalid current file", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "invalid-current", "utf8");
    await writeFile(`${filePath}.bak`, "valid-backup", "utf8");

    const result = await recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        if ((await readFile(candidatePath, "utf8")) !== "valid-backup") {
          throw new Error("invalid project");
        }
      }
    });

    expect(result).toBe("backup_restored");
    await expect(readFile(filePath, "utf8")).resolves.toBe("valid-backup");
    await expect(readFile(`${filePath}.recovery-invalid`, "utf8")).resolves.toBe("invalid-current");
  });

  it("promotes a valid candidate when no current or backup file exists", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(`${filePath}.candidate`, "valid-candidate", "utf8");

    const result = await recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        if ((await readFile(candidatePath, "utf8")) !== "valid-candidate") {
          throw new Error("invalid project");
        }
      }
    });

    expect(result).toBe("candidate_restored");
    await expect(readFile(filePath, "utf8")).resolves.toBe("valid-candidate");
  });

  it("cleans a stale backup after validating a promoted current file", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "new-valid", "utf8");
    await writeFile(`${filePath}.bak`, "old-valid", "utf8");

    await expect(recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        if (!((await readFile(candidatePath, "utf8")).endsWith("valid"))) {
          throw new Error("invalid project");
        }
      }
    })).resolves.toBe("current");

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes a validated candidate promotion when the old current file is still present", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "old-valid", "utf8");
    await writeFile(`${filePath}.candidate`, "new-valid", "utf8");

    await expect(recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        if (!((await readFile(candidatePath, "utf8")).endsWith("valid"))) {
          throw new Error("invalid project");
        }
      }
    })).resolves.toBe("candidate_restored");

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
    await expect(readFile(`${filePath}.candidate`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines an invalid candidate without blocking the next save", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "current-valid", "utf8");
    await writeFile(`${filePath}.candidate`, "invalid-candidate", "utf8");

    await expect(recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        if ((await readFile(candidatePath, "utf8")) !== "current-valid") {
          throw new Error("invalid project");
        }
      }
    })).resolves.toBe("current");

    await expect(readFile(filePath, "utf8")).resolves.toBe("current-valid");
    await expect(readFile(`${filePath}.recovery-invalid-candidate`, "utf8"))
      .resolves.toBe("invalid-candidate");
    await expect(readFile(`${filePath}.candidate`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes a valid candidate after a crash moved the old current to backup", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(`${filePath}.bak`, "old-valid", "utf8");
    await writeFile(`${filePath}.candidate`, "new-valid", "utf8");

    await expect(recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        if (!((await readFile(candidatePath, "utf8")).endsWith("valid"))) {
          throw new Error("invalid project");
        }
      }
    })).resolves.toBe("candidate_restored");

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
    await expect(readFile(`${filePath}.candidate`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers gracefully when current, candidate, and backup files all coexist", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "valid-current", "utf8");
    await writeFile(`${filePath}.bak`, "old-backup", "utf8");
    await writeFile(`${filePath}.candidate`, "invalid-candidate", "utf8");

    const result = await recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        const content = await readFile(candidatePath, "utf8");
        if (content === "invalid-candidate") throw new Error("invalid candidate");
      }
    });

    expect(result).toBe("current");
    await expect(readFile(filePath, "utf8")).resolves.toBe("valid-current");
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.recovery-invalid-candidate`, "utf8")).resolves.toBe("invalid-candidate");
  });

  it("keeps a promoted current file after a failed rollback left a leftover backup", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(filePath, "new-valid", "utf8");
    await writeFile(`${filePath}.bak`, "old-valid", "utf8");

    await expect(recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        if (!(await readFile(candidatePath, "utf8")).endsWith("valid")) {
          throw new Error("invalid project");
        }
      }
    })).resolves.toBe("current");

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.candidate`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not discard a valid candidate left behind by a failed backup restore", async () => {
    const filePath = join(tempDir, "project.ctp");
    await writeFile(`${filePath}.bak`, "old-valid", "utf8");
    await writeFile(`${filePath}.candidate`, "new-valid", "utf8");

    await expect(recoverProjectFile({
      filePath,
      validateFile: async (candidatePath) => {
        if (!(await readFile(candidatePath, "utf8")).endsWith("valid")) {
          throw new Error("invalid project");
        }
      }
    })).resolves.toBe("candidate_restored");

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-valid");
    await expect(readFile(`${filePath}.candidate`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.bak`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
