import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPendingPageImageImportManager,
  importJournalPath,
  saveTransactionJournalPath
} from "../../src/main/pendingPageImageImports";
import { recoverProjectFile } from "../../src/main/projectRecovery";
import { replaceProjectFileAtomically } from "../../src/main/projectSaveTransaction";
import { createEmptyProject } from "../../src/shared/projectValidation";

describe("pendingPageImageImports", () => {
  let tempDir: string;
  let sourcePath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `pending-page-imports-${randomUUID()}`);
    sourcePath = join(tempDir, "user-owned", "scan-001.png");
    await mkdir(join(tempDir, "user-owned"), { recursive: true });
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prepares a private temporary copy and returns an opaque renderer DTO", async () => {
    const manager = createPendingPageImageImportManager({
      temporaryRoot: join(tempDir, "pending"),
      createId: sequenceIds("batch-1", "prepared-1", "preview-1")
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false)
    });

    const batch = await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath]
    });

    expect(batch).toEqual({
      importBatchId: "batch-1",
      images: [{
        preparedImageId: "prepared-1",
        importBatchId: "batch-1",
        originalFileName: "scan-001.png",
        byteSize: 4,
        mimeType: "image/png",
        previewToken: "preview-1"
      }]
    });
    expect(JSON.stringify(batch)).not.toContain(sourcePath);
    const temporaryPath = manager.getPreparedPageImagePath("session-1", "prepared-1");
    await expect(readFile(temporaryPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));

    await writeFile(sourcePath, Buffer.from([9, 9, 9, 9]));
    await expect(readFile(temporaryPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rolls back a partially prepared batch when one selected file is invalid", async () => {
    const invalidPath = join(tempDir, "user-owned", "notes.txt");
    await writeFile(invalidPath, "not an image", "utf8");
    const temporaryRoot = join(tempDir, "pending");
    const manager = createPendingPageImageImportManager({
      temporaryRoot,
      createId: sequenceIds("batch-1", "prepared-1", "preview-1")
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false)
    });

    await expect(manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath, invalidPath]
    })).rejects.toThrow(/unsupported image/i);

    expect(() =>
      manager.getPreparedPageImagePath("session-1", "prepared-1")
    ).toThrow(/not available/i);
    await expect(
      stat(join(temporaryRoot, "session-1", "batch-1"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records successful links independently and treats duplicate links as idempotent", async () => {
    const manager = createPendingPageImageImportManager({
      temporaryRoot: join(tempDir, "pending"),
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "page-image-1"
      )
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false)
    });
    await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath]
    });

    const first = await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [
        { preparedImageId: "prepared-1", pageNumber: 1 },
        { preparedImageId: "missing", pageNumber: 2 }
      ]
    });
    const duplicate = await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });

    expect(first).toEqual([
      {
        ok: true,
        pendingPageImage: expect.objectContaining({
          pageImageId: "page-image-1",
          preparedImageId: "prepared-1",
          pageNumber: 1
        })
      },
      {
        ok: false,
        preparedImageId: "missing",
        message: "Prepared page image is not available"
      }
    ]);
    expect(duplicate).toEqual([first[0]]);
    expect(manager.getPendingPageImages("session-1")).toHaveLength(1);
    expect(manager.getProject("session-1").pageImages).toEqual([]);
  });

  it("keeps only the latest pending replacement for the same page number", async () => {
    const replacementPath = join(tempDir, "user-owned", "scan-002.png");
    await writeFile(replacementPath, Buffer.from([5, 6, 7, 8]));
    const projectFilePath = join(tempDir, "Book.ctp");
    const manager = createPendingPageImageImportManager({
      temporaryRoot: join(tempDir, "pending"),
      createId: sequenceIds(
        "batch-1", "prepared-1", "preview-1",
        "batch-2", "prepared-2", "preview-2",
        "page-image-1", "page-image-2", "transaction-1"
      )
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    });
    await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath]
    });
    await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [replacementPath]
    });
    await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-2",
      pages: [{ preparedImageId: "prepared-2", pageNumber: 1 }]
    });

    expect(manager.getPendingPageImages("session-1")).toEqual([
      expect.objectContaining({
        importBatchId: "batch-2",
        preparedImageId: "prepared-2",
        pageImageId: "page-image-2",
        pageNumber: 1
      })
    ]);
    expect(() => manager.getPreparedPageImagePath("session-1", "prepared-1"))
      .toThrow(/not available/i);

    const saved = await manager.savePendingPageImages({
      projectSessionId: "session-1",
      persistProject: async (_candidate, hooks) => {
        await hooks.afterCandidateValidated();
        await hooks.afterProjectReplaced();
      }
    });
    expect(saved.pageImages).toEqual([
      expect.objectContaining({ id: "page-image-2", pageNumber: 1 })
    ]);
  });

  it("atomically journals prepared entries and partial link results without user source paths", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const manager = createPendingPageImageImportManager({
      temporaryRoot: join(tempDir, "pending"),
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "page-image-1"
      ),
      now: () => "2026-07-28T00:00:00.000Z"
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    });

    await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath]
    });
    await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [
        { preparedImageId: "prepared-1", pageNumber: 1 },
        { preparedImageId: "missing", pageNumber: 2 }
      ]
    });

    const journalRaw = await readFile(importJournalPath(projectFilePath), "utf8");
    const journal = JSON.parse(journalRaw) as {
      schemaVersion: number;
      projectSessionId: string;
      preparedPageImages: Array<{ temporaryFilePath: string }>;
      pendingPageImageLinks: Array<{ pageImageId: string }>;
    };
    expect(journal).toMatchObject({
      schemaVersion: 1,
      projectSessionId: "session-1",
      pendingPageImageLinks: [{ pageImageId: "page-image-1" }]
    });
    expect(journal.preparedPageImages).toHaveLength(1);
    expect(journalRaw).not.toContain(sourcePath);
    await expect(stat(`${importJournalPath(projectFilePath)}.tmp`)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("promotes pending pages with a staged save journal and cleans them only after project replacement", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const manager = createPendingPageImageImportManager({
      temporaryRoot: join(tempDir, "pending"),
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "page-image-1",
        "transaction-1"
      ),
      now: () => "2026-07-28T00:00:00.000Z"
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    });
    await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath]
    });
    await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    const pendingOriginal = manager.getPreparedPageImagePath("session-1", "prepared-1");
    const observedStages: string[] = [];

    const saved = await manager.savePendingPageImages({
      projectSessionId: "session-1",
      persistProject: async (candidate, hooks) => {
        await expect(readFile(pendingOriginal)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
        observedStages.push(
          JSON.parse(await readFile(saveTransactionJournalPath(projectFilePath), "utf8")).stage
        );
        await hooks.afterCandidateValidated();
        observedStages.push(
          JSON.parse(await readFile(saveTransactionJournalPath(projectFilePath), "utf8")).stage
        );
        expect(candidate.pageImages).toEqual([
          expect.objectContaining({
            id: "page-image-1",
            storedRelativePath:
              "Book-assets/images/9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png"
          })
        ]);
        await hooks.afterProjectReplaced();
        observedStages.push(
          JSON.parse(await readFile(saveTransactionJournalPath(projectFilePath), "utf8")).stage
        );
      }
    });

    expect(observedStages).toEqual([
      "assets_staged",
      "candidate_validated",
      "project_replaced"
    ]);
    expect(saved.pageImages).toEqual([
      expect.objectContaining({ id: "page-image-1", pageNumber: 1 })
    ]);
    await expect(
      readFile(
        join(
          tempDir,
          "Book-assets",
          "images",
          "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png"
        )
      )
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    await expect(stat(pendingOriginal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(importJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(stat(saveTransactionJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("preserves pending originals after failure and retries without duplicating assets", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const manager = createPendingPageImageImportManager({
      temporaryRoot: join(tempDir, "pending"),
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "page-image-1",
        "transaction-1",
        "transaction-2"
      )
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    });
    await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath]
    });
    await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    const pendingOriginal = manager.getPreparedPageImagePath("session-1", "prepared-1");

    await expect(
      manager.savePendingPageImages({
        projectSessionId: "session-1",
        persistProject: async (_candidate, hooks) => {
          await hooks.afterCandidateValidated();
          throw new Error("candidate rename interrupted");
        }
      })
    ).rejects.toThrow(/interrupted/i);

    await expect(readFile(pendingOriginal)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    expect(manager.getProject("session-1").pageImages).toEqual([]);
    expect(
      JSON.parse(await readFile(saveTransactionJournalPath(projectFilePath), "utf8")).stage
    ).toBe("candidate_validated");

    const saved = await manager.savePendingPageImages({
      projectSessionId: "session-1",
      persistProject: async (_candidate, hooks) => {
        await hooks.afterCandidateValidated();
        await hooks.afterProjectReplaced();
      }
    });

    expect(saved.pageImages).toHaveLength(1);
    expect(saved.pageImages[0]?.storedRelativePath).toBe(
      "Book-assets/images/9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png"
    );
    await expect(
      stat(join(tempDir, "Book-assets", ".save-staging", "transaction-1"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("journals each promoted asset before the next asset can fail", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const secondSourcePath = join(tempDir, "user-owned", "scan-002.png");
    await writeFile(secondSourcePath, Buffer.from([5, 6, 7, 8]));
    const manager = createPendingPageImageImportManager({
      temporaryRoot: join(tempDir, "pending"),
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "prepared-2",
        "preview-2",
        "page-image-1",
        "page-image-2",
        "transaction-1"
      )
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    });
    const batch = await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath, secondSourcePath]
    });
    await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: batch.importBatchId,
      pages: [
        { preparedImageId: "prepared-1", pageNumber: 1 },
        { preparedImageId: "prepared-2", pageNumber: 2 }
      ]
    });
    await rm(
      manager.getPreparedPageImagePath("session-1", "prepared-2"),
      { force: true }
    );

    await expect(manager.savePendingPageImages({
      projectSessionId: "session-1",
      persistProject: async () => undefined
    })).rejects.toMatchObject({ code: "ENOENT" });

    const journal = JSON.parse(
      await readFile(saveTransactionJournalPath(projectFilePath), "utf8")
    ) as { stage: string; promotedAssets: unknown[] };
    expect(journal.stage).toBe("preparing");
    expect(journal.promotedAssets).toEqual([
      expect.objectContaining({
        finalRelativePath:
          "Book-assets/images/9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png"
      })
    ]);
  });

  it("restores pending links from the import journal after the project is reopened", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const temporaryRoot = join(tempDir, "pending");
    const originalProject = createEmptyProject("Book", false);
    const firstManager = createPendingPageImageImportManager({
      temporaryRoot,
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "page-image-1",
        "transaction-1"
      )
    });
    firstManager.startSession({
      projectSessionId: "session-before-crash",
      project: originalProject,
      filePath: projectFilePath
    });
    await firstManager.preparePageImages({
      projectSessionId: "session-before-crash",
      sourcePaths: [sourcePath]
    });
    await firstManager.linkPageImages({
      projectSessionId: "session-before-crash",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    await expect(
      firstManager.savePendingPageImages({
        projectSessionId: "session-before-crash",
        persistProject: async (_candidate, hooks) => {
          await hooks.afterCandidateValidated();
          throw new Error("process stopped");
        }
      })
    ).rejects.toThrow(/stopped/i);

    const resumedManager = createPendingPageImageImportManager({
      temporaryRoot,
      createId: sequenceIds("transaction-2")
    });
    await resumedManager.resumeSession({
      projectSessionId: "session-after-reopen",
      project: originalProject,
      filePath: projectFilePath
    });

    expect(resumedManager.getPendingPageImages("session-after-reopen")).toEqual([
      expect.objectContaining({
        importBatchId: "batch-1",
        preparedImageId: "prepared-1",
        pageImageId: "page-image-1",
        pageNumber: 1
      })
    ]);
    const saved = await resumedManager.savePendingPageImages({
      projectSessionId: "session-after-reopen",
      persistProject: async (_candidate, hooks) => {
        await hooks.afterCandidateValidated();
        await hooks.afterProjectReplaced();
      }
    });
    expect(saved.pageImages).toEqual([
      expect.objectContaining({ id: "page-image-1", pageNumber: 1 })
    ]);
  });

  it("rejects a recovery journal that points outside the managed temporary root", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const temporaryRoot = join(tempDir, "pending");
    await writeFile(importJournalPath(projectFilePath), JSON.stringify({
      schemaVersion: 1,
      projectSessionId: "session-before-crash",
      targetProjectPath: projectFilePath,
      preparedPageImages: [{
        preparedImageId: "prepared-1",
        importBatchId: "batch-1",
        originalFileName: "scan-001.png",
        byteSize: 4,
        mimeType: "image/png",
        previewToken: "preview-1",
        temporaryFilePath: sourcePath
      }],
      pendingPageImageLinks: [],
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z"
    }), "utf8");
    const manager = createPendingPageImageImportManager({ temporaryRoot });

    await expect(manager.resumeSession({
      projectSessionId: "session-after-reopen",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    })).rejects.toThrow(/temporary|journal/i);

    await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects an unsafe save transaction id before removing any staging directory", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const temporaryRoot = join(tempDir, "pending");
    const sentinelDir = join(tempDir, "sentinel");
    const sentinelPath = join(sentinelDir, "keep.txt");
    await mkdir(sentinelDir);
    await writeFile(sentinelPath, "keep", "utf8");
    await writeFile(importJournalPath(projectFilePath), JSON.stringify({
      schemaVersion: 1,
      projectSessionId: "session-before-crash",
      targetProjectPath: projectFilePath,
      preparedPageImages: [],
      pendingPageImageLinks: [],
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z"
    }), "utf8");
    await writeFile(saveTransactionJournalPath(projectFilePath), JSON.stringify({
      schemaVersion: 1,
      transactionId: "..\\..\\sentinel",
      projectSessionId: "session-before-crash",
      targetProjectPath: projectFilePath,
      candidateProjectPath: `${projectFilePath}.candidate`,
      stage: "preparing",
      promotedAssets: [],
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z"
    }), "utf8");
    const manager = createPendingPageImageImportManager({ temporaryRoot });

    await expect(manager.resumeSession({
      projectSessionId: "session-after-reopen",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    })).rejects.toThrow(/transaction|journal/i);

    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep");
  });

  it("finishes cleanup when the reopened project already contains every promoted asset", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const temporaryRoot = join(tempDir, "pending");
    const originalProject = createEmptyProject("Book", false);
    const firstManager = createPendingPageImageImportManager({
      temporaryRoot,
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "page-image-1",
        "transaction-1"
      )
    });
    firstManager.startSession({
      projectSessionId: "session-before-crash",
      project: originalProject,
      filePath: projectFilePath
    });
    await firstManager.preparePageImages({
      projectSessionId: "session-before-crash",
      sourcePaths: [sourcePath]
    });
    await firstManager.linkPageImages({
      projectSessionId: "session-before-crash",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    const pendingOriginal = firstManager.getPreparedPageImagePath(
      "session-before-crash",
      "prepared-1"
    );
    let committedProject = originalProject;
    await expect(
      firstManager.savePendingPageImages({
        projectSessionId: "session-before-crash",
        persistProject: async (candidate, hooks) => {
          committedProject = structuredClone(candidate);
          await hooks.afterCandidateValidated();
          await hooks.afterProjectReplaced();
          throw new Error("process stopped after replace");
        }
      })
    ).rejects.toThrow(/after replace/i);

    expect(
      JSON.parse(await readFile(saveTransactionJournalPath(projectFilePath), "utf8")).stage
    ).toBe("project_replaced");
    const resumedManager = createPendingPageImageImportManager({
      temporaryRoot
    });
    await resumedManager.resumeSession({
      projectSessionId: "session-after-reopen",
      project: committedProject,
      filePath: projectFilePath
    });

    expect(resumedManager.getPendingPageImages("session-after-reopen")).toEqual([]);
    await expect(stat(pendingOriginal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(importJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(stat(saveTransactionJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("keeps unrelated prepared bytes when restart finishes a replaced save transaction", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const secondSourcePath = join(tempDir, "user-owned", "scan-002.png");
    const temporaryRoot = join(tempDir, "pending");
    await writeFile(secondSourcePath, Buffer.from([5, 6, 7, 8]));
    const firstManager = createPendingPageImageImportManager({
      temporaryRoot,
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "prepared-2",
        "preview-2",
        "page-image-1",
        "transaction-1"
      )
    });
    const originalProject = createEmptyProject("Book", false);
    firstManager.startSession({
      projectSessionId: "session-before-crash",
      project: originalProject,
      filePath: projectFilePath
    });
    await firstManager.preparePageImages({
      projectSessionId: "session-before-crash",
      sourcePaths: [sourcePath, secondSourcePath]
    });
    await firstManager.linkPageImages({
      projectSessionId: "session-before-crash",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    const savedTemporaryPath = firstManager.getPreparedPageImagePath(
      "session-before-crash",
      "prepared-1"
    );
    const unrelatedTemporaryPath = firstManager.getPreparedPageImagePath(
      "session-before-crash",
      "prepared-2"
    );
    let committedProject = originalProject;
    await expect(firstManager.savePendingPageImages({
      projectSessionId: "session-before-crash",
      persistProject: async (candidate, hooks) => {
        committedProject = structuredClone(candidate);
        await hooks.afterCandidateValidated();
        await hooks.afterProjectReplaced();
        throw new Error("process stopped after replace");
      }
    })).rejects.toThrow(/after replace/i);

    const resumedManager = createPendingPageImageImportManager({ temporaryRoot });
    await resumedManager.resumeSession({
      projectSessionId: "session-after-reopen",
      project: committedProject,
      filePath: projectFilePath
    });

    await expect(stat(savedTemporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelatedTemporaryPath)).resolves.toEqual(Buffer.from([5, 6, 7, 8]));
    expect(
      resumedManager.getPreparedPageImagePath("session-after-reopen", "prepared-2")
    ).toBe(unrelatedTemporaryPath);
    const journal = JSON.parse(
      await readFile(importJournalPath(projectFilePath), "utf8")
    ) as { preparedPageImages: Array<{ preparedImageId: string }> };
    expect(journal.preparedPageImages.map((entry) => entry.preparedImageId)).toEqual([
      "prepared-2"
    ]);
    await expect(stat(saveTransactionJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("removes only hash-verified unreferenced assets when a failed batch is released", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const manager = createPendingPageImageImportManager({
      temporaryRoot: join(tempDir, "pending"),
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "page-image-1",
        "transaction-1"
      )
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    });
    await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath]
    });
    await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    await expect(
      manager.savePendingPageImages({
        projectSessionId: "session-1",
        persistProject: async () => {
          throw new Error("project save failed");
        }
      })
    ).rejects.toThrow(/save failed/i);
    const promotedPath = join(
      tempDir,
      "Book-assets",
      "images",
      "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png"
    );
    await expect(readFile(promotedPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));

    await manager.releasePageImageImportBatch({
      projectSessionId: "session-1",
      importBatchId: "batch-1"
    });

    expect(manager.getPendingPageImages("session-1")).toEqual([]);
    await expect(stat(promotedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(tempDir, "pending", "session-1"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(importJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("keeps an unlinked prepared image from the same batch recoverable after saving linked pages", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const secondSourcePath = join(tempDir, "user-owned", "scan-002.png");
    const temporaryRoot = join(tempDir, "pending");
    await writeFile(secondSourcePath, Buffer.from([5, 6, 7, 8]));
    const manager = createPendingPageImageImportManager({
      temporaryRoot,
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "prepared-2",
        "preview-2",
        "page-image-1",
        "transaction-1"
      )
    });
    manager.startSession({
      projectSessionId: "session-1",
      project: createEmptyProject("Book", false),
      filePath: projectFilePath
    });
    await manager.preparePageImages({
      projectSessionId: "session-1",
      sourcePaths: [sourcePath, secondSourcePath]
    });
    await manager.linkPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });

    await manager.savePendingPageImages({
      projectSessionId: "session-1",
      persistProject: async (_candidate, hooks) => {
        await hooks.afterCandidateValidated();
        await hooks.afterProjectReplaced();
      }
    });

    const remainingPath = join(
      temporaryRoot,
      "session-1",
      "batch-1",
      "prepared-2.png"
    );
    await expect(readFile(remainingPath)).resolves.toEqual(Buffer.from([5, 6, 7, 8]));
    const journal = JSON.parse(
      await readFile(importJournalPath(projectFilePath), "utf8")
    ) as { preparedPageImages: Array<{ preparedImageId: string }> };
    expect(journal.preparedPageImages).toEqual([
      expect.objectContaining({ preparedImageId: "prepared-2" })
    ]);

    await manager.releasePageImageImportBatch({
      projectSessionId: "session-1",
      importBatchId: "batch-1"
    });
    await expect(stat(remainingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(importJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("reconciles a candidate_validated journal when recovery keeps the promoted project", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const temporaryRoot = join(tempDir, "pending");
    const originalProject = createEmptyProject("Book", false);
    await writeFile(projectFilePath, JSON.stringify(originalProject), "utf8");
    const firstManager = createPendingPageImageImportManager({
      temporaryRoot,
      createId: sequenceIds(
        "batch-1",
        "prepared-1",
        "preview-1",
        "page-image-1",
        "transaction-1"
      )
    });
    firstManager.startSession({
      projectSessionId: "session-before-crash",
      project: originalProject,
      filePath: projectFilePath
    });
    await firstManager.preparePageImages({
      projectSessionId: "session-before-crash",
      sourcePaths: [sourcePath]
    });
    await firstManager.linkPageImages({
      projectSessionId: "session-before-crash",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
    });
    const pendingOriginal = firstManager.getPreparedPageImagePath(
      "session-before-crash",
      "prepared-1"
    );
    let promotedProject = originalProject;
    const candidatePath = `${projectFilePath}.candidate`;
    let candidatePromoted = false;

    await expect(
      firstManager.savePendingPageImages({
        projectSessionId: "session-before-crash",
        persistProject: async (candidate, hooks) => {
          promotedProject = structuredClone(candidate);
          await replaceProjectFileAtomically({
            filePath: projectFilePath,
            writeCandidate: (nextCandidatePath) =>
              writeFile(nextCandidatePath, JSON.stringify(candidate), "utf8"),
            validateFile: async () => undefined,
            afterCandidateValidated: hooks.afterCandidateValidated,
            afterProjectReplaced: async () => {
              throw new Error("afterProjectReplaced failed");
            },
            renameFile: async (from, to) => {
              if (from === candidatePath && to === projectFilePath) {
                await rename(from, to);
                candidatePromoted = true;
                return;
              }
              if (
                candidatePromoted &&
                from === projectFilePath &&
                to === candidatePath
              ) {
                const error = new Error("Access denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
              }
              await rename(from, to);
            },
            retryOptions: { maxRetries: 1, initialDelayMs: 1, backoffFactor: 1 }
          });
        }
      })
    ).rejects.toBeInstanceOf(AggregateError);

    expect(
      JSON.parse(await readFile(saveTransactionJournalPath(projectFilePath), "utf8")).stage
    ).toBe("candidate_validated");
    await expect(readFile(projectFilePath, "utf8")).resolves.toBe(
      JSON.stringify(promotedProject)
    );
    await expect(readFile(`${projectFilePath}.bak`, "utf8")).resolves.toBe(
      JSON.stringify(originalProject)
    );

    await expect(recoverProjectFile({
      filePath: projectFilePath,
      validateFile: async (recoveredPath) => {
        JSON.parse(await readFile(recoveredPath, "utf8"));
      }
    })).resolves.toBe("current");

    const resumedManager = createPendingPageImageImportManager({ temporaryRoot });
    await resumedManager.resumeSession({
      projectSessionId: "session-after-reopen",
      project: promotedProject,
      filePath: projectFilePath
    });

    expect(resumedManager.getPendingPageImages("session-after-reopen")).toEqual([]);
    expect(resumedManager.getProject("session-after-reopen").pageImages).toEqual([
      expect.objectContaining({ id: "page-image-1", pageNumber: 1 })
    ]);
    await expect(stat(pendingOriginal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(importJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(stat(saveTransactionJournalPath(projectFilePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      readFile(
        join(
          tempDir,
          "Book-assets",
          "images",
          "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.png"
        )
      )
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });
});

function sequenceIds(...values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error(`Missing test id at index ${index}`);
    index += 1;
    return value;
  };
}
