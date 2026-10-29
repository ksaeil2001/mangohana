import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPendingPageImageImportManager,
  importJournalPath
} from "../../src/main/pendingPageImageImports";
import { createProjectSessionManager } from "../../src/main/projectSessions";
import { loadProjectFile } from "../../src/main/projectStorage";
import {
  createProcessingQueue,
  processingQueueConcurrencyToken,
  startProcessingQueue
} from "../../src/shared/processingQueue";
import {
  computeTranslationContextFingerprint,
  computeTypesettingContextFingerprint
} from "../../src/shared/translationContext";
import { createEmptyProject } from "../../src/shared/projectValidation";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes";

describe("project sessions", () => {
  it("persists a pipeline-owned translation proposal and restores it without promoting user ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trio-single-proposal-"));
    try {
      const filePath = join(directory, "proposal.ctp");
      const project = createEmptyProject("Single proposal", false);
      project.dialogueLines = [{
        ...manualLine("single-proposal-line", 1, "原文"),
        userTranslation: "사용자 번역",
        lineStatus: "complete"
      }];
      const manager = createProjectSessionManager();
      const created = manager.createProjectSession({ project, filePath });
      const fingerprint = computeTranslationContextFingerprint({
        dialogueLines: project.dialogueLines,
        targetLineId: "single-proposal-line",
        characters: project.characters,
        dictionaryTerms: project.dictionaryTerms
      });

      await manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          type: "commit_batch_result",
          dialogueUpdates: [{
            id: "single-proposal-line",
            aiTranslation: "AI 제안",
            expectedTranslationFingerprint: fingerprint
          }]
        }
      });

      const reopened = await loadProjectFile({ filePath });
      expect(reopened.project.dialogueLines[0]).toMatchObject({
        aiTranslation: "AI 제안",
        userTranslation: "사용자 번역",
        lineStatus: "complete"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps persisted and live snapshots separate across Main patch and user save", async () => {
    const writes: TranslationProjectV2[] = [];
    const manager = createProjectSessionManager({
      saveProjectFile: async ({ project }) => {
        writes.push(structuredClone(project));
      }
    });
    const project = createEmptyProject("Session", false);
    project.pageImages = [pageImage("page-1", 1)];
    const created = manager.createProjectSession({
      project,
      filePath: "C:\\projects\\session.ctp"
    });

    const changed = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: {
        type: "add_dialogue_line",
        input: {
          pageNumber: 1,
          sourceLanguage: "en",
          sourceText: "unsaved",
          dialogueType: "speech"
        }
      }
    });
    expect(changed.status).toBe("applied");

    const committed = await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: {
        type: "commit_processing_run",
        run: {
          runId: "run-1",
          pageImageId: "page-1",
          source: "automatic_pipeline",
          status: "completed",
          sourceSha256: "a".repeat(64),
          appVersion: "0.1.0",
          queuedAt: "2026-07-27T00:00:00.000Z"
        },
        pageRecord: {
          pageImageId: "page-1",
          latestCompletedRunId: "run-1",
          finalStatus: "needs_review",
          updatedAt: "2026-07-27T00:00:00.000Z"
        },
        assets: []
      }
    });

    expect(committed.project.project.dialogueLines.map((line) => line.sourceText)).toEqual(["unsaved"]);
    expect(committed.project.dirty).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.dialogueLines).toEqual([]);
    expect(writes[0]?.processing.runs.map((run) => run.runId)).toEqual(["run-1"]);

    const saved = await manager.saveProject({ projectSessionId: created.projectSessionId });
    expect(saved.project.dirty).toBe(false);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.dialogueLines.map((line) => line.sourceText)).toEqual(["unsaved"]);
  });

  it("persists OCR typesetting geometry through save and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trio-typeset-save-"));
    try {
      const filePath = join(directory, "typeset.ctp");
      const project = createEmptyProject("Typeset persist", false);
      project.pageImages = [pageImage("page-1", 1)];
      const manager = createProjectSessionManager();
      const created = manager.createProjectSession({ project, filePath });
      const typesetting = {
        bbox: { x: 0.21, y: 0.33, width: 0.17, height: 0.08 },
        writingMode: "vertical-rl" as const,
        rotationDegrees: 11,
        shape: "cloud" as const
      };

      const added = await manager.applyProjectMutation({
        projectSessionId: created.projectSessionId,
        baseRevision: created.project.revision,
        mutation: {
          type: "add_dialogue_line",
          input: {
            pageNumber: 1,
            sourceLanguage: "ja",
            sourceText: "こんにちは",
            dialogueType: "speech",
            typesetting
          }
        }
      });
      expect(added.status).toBe("applied");
      expect(added.project.project.dialogueLines[0]?.typesetting).toEqual(typesetting);

      await manager.saveProject({ projectSessionId: created.projectSessionId });
      const reopened = await loadProjectFile({ filePath });
      expect(reopened.project.dialogueLines[0]?.typesetting).toEqual(typesetting);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns the latest DTO on stale path conflicts and serializes session mutations", async () => {
    const manager = createProjectSessionManager();
    const created = manager.createProjectSession({ project: createEmptyProject("Revision", false) });

    const first = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: 0,
      mutation: { type: "set_project_title", title: "First" }
    });
    const conflict = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: 0,
      mutation: { type: "set_project_title", title: "Stale" }
    });

    expect(first.status).toBe("applied");
    expect(conflict).toMatchObject({
      status: "revision_conflict",
      code: "REVISION_CONFLICT",
      revision: 1,
      conflictingPaths: ["metadata/title"],
      project: { project: { metadata: { title: "First" } } }
    });
  });

  it("persists a user pageNumber change and restores it after save and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trio-page-move-"));
    try {
      const filePath = join(directory, "page-move.ctp");
      const project = createEmptyProject("Page move", false);
      project.pageImages = [pageImage("page-1", 1), pageImage("page-2", 2)];
      project.dialogueLines = [manualLine("moved-line", 1, "move me")];
      const manager = createProjectSessionManager();
      const created = manager.createProjectSession({ project, filePath });

      const mutated = await manager.applyProjectMutation({
        projectSessionId: created.projectSessionId,
        baseRevision: created.project.revision,
        mutation: {
          type: "update_dialogue_line",
          lineId: "moved-line",
          patch: { pageNumber: 2 }
        }
      });

      expect(mutated.status).toBe("applied");
      expect(mutated.project.project.dialogueLines[0]?.pageNumber).toBe(2);

      const saved = await manager.saveProject({ projectSessionId: created.projectSessionId });
      expect(saved.project.project.dialogueLines[0]?.pageNumber).toBe(2);
      expect(saved.project.dirty).toBe(false);

      const reopened = await loadProjectFile({ filePath });
      expect(reopened.project.dialogueLines[0]).toMatchObject({
        id: "moved-line",
        pageNumber: 2,
        sourceText: "move me"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("conflicts a stale pageNumber mutation on the same path and rebases a non-overlapping line edit", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Page revision", false);
    project.dialogueLines = [manualLine("moved-line", 1, "original")];
    const created = manager.createProjectSession({ project });

    const first = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: {
        type: "update_dialogue_line",
        lineId: "moved-line",
        patch: { pageNumber: 2 }
      }
    });
    expect(first.status).toBe("applied");

    const conflict = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: 0,
      mutation: {
        type: "update_dialogue_line",
        lineId: "moved-line",
        patch: { pageNumber: 3 }
      }
    });
    expect(conflict).toMatchObject({
      status: "revision_conflict",
      code: "REVISION_CONFLICT",
      revision: 1,
      conflictingPaths: ["dialogueLines/moved-line/pageNumber"],
      project: { project: { dialogueLines: [{ id: "moved-line", pageNumber: 2 }] } }
    });

    const rebased = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: 0,
      mutation: {
        type: "update_dialogue_line",
        lineId: "moved-line",
        patch: { sourceText: "still original page move" }
      }
    });
    expect(rebased.status).toBe("applied");
    expect(rebased.project.project.dialogueLines[0]).toMatchObject({
      id: "moved-line",
      pageNumber: 2,
      sourceText: "still original page move"
    });
  });

  it("rejects an invalid pageNumber mutation before changing the live session", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Invalid page", false);
    project.dialogueLines = [manualLine("moved-line", 1, "keep me")];
    const created = manager.createProjectSession({ project });

    await expect(manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: {
        type: "update_dialogue_line",
        lineId: "moved-line",
        patch: { pageNumber: 0 }
      }
    })).rejects.toThrow(/pageNumber must be a positive integer/i);

    expect(manager.getProject(created.projectSessionId).project.dialogueLines[0]?.pageNumber).toBe(1);
  });

  it("zeroizes protection buffers and invalidates the session when closed", async () => {
    const manager = createProjectSessionManager();
    const created = manager.createSecretProjectSession({
      project: createEmptyProject("Secret", true),
      password: "close me"
    });
    const buffers = created.protectionBuffers;

    await manager.closeProject({ projectSessionId: created.projectSessionId });

    for (const buffer of buffers) expect(buffer.every((byte) => byte === 0)).toBe(true);
    expect(() => manager.getProject(created.projectSessionId)).toThrow(/unknown project session/i);
  });

  it("keeps a session active and protected when fallible close cleanup fails, then retries safely", async () => {
    const realImports = createPendingPageImageImportManager();
    let failDiscard = true;
    const pageImageImports = {
      ...realImports,
      discardSession: async (projectSessionId: string) => {
        if (failDiscard) throw new Error("temporary discard failure");
        return realImports.discardSession(projectSessionId);
      }
    };
    const manager = createProjectSessionManager({ pageImageImports });
    const created = manager.createSecretProjectSession({
      project: createEmptyProject("Close retry", true),
      password: "keep until close succeeds"
    });

    await expect(manager.closeProject({ projectSessionId: created.projectSessionId }))
      .rejects.toThrow(/temporary discard failure/);
    expect(manager.getProject(created.projectSessionId).status).toBe("active");
    expect(created.protectionBuffers.some((buffer) => buffer.some((byte) => byte !== 0))).toBe(true);

    failDiscard = false;
    await expect(manager.closeProject({ projectSessionId: created.projectSessionId })).resolves.toBeUndefined();
    expect(() => manager.getProject(created.projectSessionId)).toThrow(/unknown project session/i);
    for (const buffer of created.protectionBuffers) expect(buffer.every((byte) => byte === 0)).toBe(true);
    await expect(manager.closeProject({ projectSessionId: created.projectSessionId })).resolves.toBeUndefined();
  });

  it("zeroizes every secret session during app shutdown disposal", async () => {
    const manager = createProjectSessionManager();
    const first = manager.createSecretProjectSession({
      project: createEmptyProject("Secret A", true),
      password: "close a"
    });
    const second = manager.createSecretProjectSession({
      project: createEmptyProject("Secret B", true),
      password: "close b"
    });

    await manager.disposeAll();

    for (const buffer of [...first.protectionBuffers, ...second.protectionBuffers]) {
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    }
    expect(() => manager.getProject(first.projectSessionId)).toThrow(/unknown project session/i);
    expect(() => manager.getProject(second.projectSessionId)).toThrow(/unknown project session/i);
  });

  it("does not finish shutdown disposal until disposable import cleanup settles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-dispose-wait-"));
    try {
      let releaseDiscard: () => void = () => undefined;
      const discardGate = new Promise<void>((resolve) => {
        releaseDiscard = resolve;
      });
      let discarded = false;
      const realImports = createPendingPageImageImportManager({
        temporaryRoot: join(tempDir, "pending")
      });
      const pageImageImports = {
        ...realImports,
        discardSession: async (projectSessionId: string) => {
          await discardGate;
          discarded = true;
          return realImports.discardSession(projectSessionId);
        }
      };
      const manager = createProjectSessionManager({ pageImageImports });
      const created = manager.createProjectSession({
        project: createEmptyProject("Disposable", false)
      });

      let disposeSettled = false;
      const disposePromise = Promise.resolve(manager.disposeAll()).then(() => {
        disposeSettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(disposeSettled).toBe(false);
      expect(discarded).toBe(false);
      expect(manager.getProject(created.projectSessionId).status).toBe("closing");

      releaseDiscard();
      await disposePromise;
      expect(discarded).toBe(true);
      expect(() => manager.getProject(created.projectSessionId)).toThrow(/unknown project session/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves resumable pending page imports across shutdown disposal", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-dispose-resume-"));
    try {
      const sourcePath = join(tempDir, "Page.png");
      const projectFilePath = join(tempDir, "Book.ctp");
      const temporaryRoot = join(tempDir, "pending");
      const stagedPath = join(temporaryRoot, "session-before-quit", "batch-1", "prepared-1.png");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      const firstManager = createProjectSessionManager({
        createId: sequenceIds("session-before-quit"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot,
          createId: sequenceIds("batch-1", "prepared-1", "preview-1", "page-image-1")
        })
      });
      const first = firstManager.createProjectSession({
        project: createEmptyProject("Book", false),
        filePath: projectFilePath
      });
      await firstManager.preparePageImages({
        projectSessionId: first.projectSessionId,
        sourcePaths: [sourcePath]
      });
      await firstManager.linkPageImages({
        projectSessionId: first.projectSessionId,
        importBatchId: "batch-1",
        pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
      });

      await firstManager.disposeAll();

      await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
      await expect(stat(importJournalPath(projectFilePath))).resolves.toBeDefined();

      const restartedManager = createProjectSessionManager({
        createId: sequenceIds("session-after-quit"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot,
          createId: sequenceIds("transaction-after-quit")
        })
      });
      const restarted = restartedManager.createProjectSession({
        project: createEmptyProject("Book", false),
        filePath: projectFilePath
      });
      const resumed = await restartedManager.resumePageImageImports(restarted.projectSessionId);
      expect(resumed.pendingPageImages).toEqual([
        expect.objectContaining({ pageImageId: "page-image-1", pageNumber: 1 })
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes disposable temporary imports during shutdown disposal", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-dispose-discard-"));
    try {
      const sourcePath = join(tempDir, "Page.png");
      const temporaryRoot = join(tempDir, "pending");
      const stagedPath = join(temporaryRoot, "session-unsaved", "batch-1", "prepared-1.png");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-unsaved"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot,
          createId: sequenceIds("batch-1", "prepared-1", "preview-1")
        })
      });
      const created = manager.createProjectSession({
        project: createEmptyProject("Unsaved", false)
      });
      await manager.preparePageImages({
        projectSessionId: created.projectSessionId,
        sourcePaths: [sourcePath]
      });
      await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));

      await manager.disposeAll();

      await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => manager.getProject(created.projectSessionId)).toThrow(/unknown project session/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not mutate project files or recovery artifacts when shutdown discard fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-dispose-failure-"));
    try {
      const filePath = join(tempDir, "Book.ctp");
      await writeFile(filePath, "current-project");
      await writeFile(`${filePath}.bak`, "backup-project");
      await writeFile(`${filePath}.candidate`, "candidate-project");
      await writeFile(`${filePath}.recovery-invalid`, "invalid-project");
      const realImports = createPendingPageImageImportManager({
        temporaryRoot: join(tempDir, "pending")
      });
      const pageImageImports = {
        ...realImports,
        discardSession: async () => {
          throw new Error("temporary discard failure");
        }
      };
      const manager = createProjectSessionManager({ pageImageImports });
      const created = manager.createProjectSession({
        project: createEmptyProject("Book", false),
        filePath
      });

      await expect(manager.disposeAll()).resolves.toBeUndefined();

      expect(() => manager.getProject(created.projectSessionId)).toThrow(/unknown project session/i);
      await expect(readFile(filePath, "utf8")).resolves.toBe("current-project");
      await expect(readFile(`${filePath}.bak`, "utf8")).resolves.toBe("backup-project");
      await expect(readFile(`${filePath}.candidate`, "utf8")).resolves.toBe("candidate-project");
      await expect(readFile(`${filePath}.recovery-invalid`, "utf8")).resolves.toBe("invalid-project");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent non-conflicting mutations on one session queue", async () => {
    const manager = createProjectSessionManager({
      createId: (() => {
        let value = 0;
        return () => `queue-${++value}`;
      })()
    });
    const created = manager.createProjectSession({ project: createEmptyProject("Queue", false) });

    const [title, settings] = await Promise.all([
      manager.applyProjectMutation({
        projectSessionId: created.projectSessionId,
        baseRevision: 0,
        mutation: { type: "set_project_title", title: "Queued title" }
      }),
      manager.applyProjectMutation({
        projectSessionId: created.projectSessionId,
        baseRevision: 0,
        mutation: {
          type: "update_project_settings",
          patch: { translationMode: "precise" }
        }
      })
    ]);

    expect(title.status).toBe("applied");
    expect(settings.status).toBe("applied");
    expect(settings.revision).toBe(2);
    expect(manager.getProject(created.projectSessionId).project).toMatchObject({
      metadata: { title: "Queued title" },
      settings: { translationMode: "precise" }
    });
  });

  it("persists Fast and Precise translationMode through save and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trio-mode-save-"));
    try {
      for (const translationMode of ["fast", "precise"] as const) {
        const filePath = join(directory, `${translationMode}.ctp`);
        const manager = createProjectSessionManager();
        const created = manager.createProjectSession({
          project: createEmptyProject(`Mode ${translationMode}`, false),
          filePath
        });
        const applied = await manager.applyProjectMutation({
          projectSessionId: created.projectSessionId,
          baseRevision: created.project.revision,
          mutation: {
            type: "update_project_settings",
            patch: { translationMode }
          }
        });
        expect(applied.status).toBe("applied");
        await manager.saveProject({ projectSessionId: created.projectSessionId });
        const reopened = await loadProjectFile({ filePath });
        expect(reopened.project.settings.translationMode).toBe(translationMode);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists conditional dictionary terms and character metadata through save and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trio-glossary-save-"));
    try {
      const filePath = join(directory, "glossary.ctp");
      const project = createEmptyProject("Glossary persist", false);
      const manager = createProjectSessionManager();
      const created = manager.createProjectSession({ project, filePath });

      const characterResult = await manager.applyProjectMutation({
        projectSessionId: created.projectSessionId,
        baseRevision: created.project.revision,
        mutation: {
          type: "upsert_character",
          character: {
            id: "char-a",
            name: "나미",
            aliases: ["ナミ", "고양이 도둑"],
            speechStyle: "활발한 반말",
            relationshipNotes: "루피의 항해사"
          }
        }
      });
      expect(characterResult.status).toBe("applied");

      const termResult = await manager.applyProjectMutation({
        projectSessionId: created.projectSessionId,
        baseRevision: characterResult.revision,
        mutation: {
          type: "upsert_dictionary_term",
          term: {
            id: "term-a",
            source: "先輩",
            target: "선배님",
            note: "후배 전용",
            category: "tone",
            priority: 20,
            condition: {
              speaker: "나미",
              dialogueType: "speech",
              targetContext: "존칭"
            }
          }
        }
      });
      expect(termResult.status).toBe("applied");

      await manager.saveProject({ projectSessionId: created.projectSessionId });
      const reopened = await loadProjectFile({ filePath });
      expect(reopened.project.characters[0]).toEqual({
        id: "char-a",
        name: "나미",
        aliases: ["ナミ", "고양이 도둑"],
        speechStyle: "활발한 반말",
        relationshipNotes: "루피의 항해사"
      });
      expect(reopened.project.dictionaryTerms[0]).toEqual({
        id: "term-a",
        source: "先輩",
        target: "선배님",
        note: "후배 전용",
        category: "tone",
        priority: 20,
        condition: {
          speaker: "나미",
          dialogueType: "speech",
          targetContext: "존칭"
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes writes from different sessions that target the same ctp path", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const manager = createProjectSessionManager({
      saveProjectFile: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) {
          markFirstStarted();
          await firstRelease;
        }
        active -= 1;
      }
    });
    const filePath = "C:\\projects\\shared.ctp";
    const first = manager.createProjectSession({
      project: createEmptyProject("First", false),
      filePath
    });
    const second = manager.createProjectSession({
      project: createEmptyProject("Second", false),
      filePath: "c:/projects/nested/../shared.ctp"
    });

    const saves = Promise.all([
      manager.saveProject({ projectSessionId: first.projectSessionId }),
      manager.saveProject({ projectSessionId: second.projectSessionId })
    ]);
    await firstStarted;
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await saves;

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("allows writes to different project paths to proceed independently", async () => {
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let releaseWrites!: () => void;
    const writesRelease = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const manager = createProjectSessionManager({
      saveProjectFile: async () => {
        calls += 1;
        if (calls === 2) markBothStarted();
        active += 1;
        maxActive = Math.max(maxActive, active);
        await writesRelease;
        active -= 1;
      }
    });
    const first = manager.createProjectSession({
      project: createEmptyProject("First", false),
      filePath: "C:\\projects\\first.ctp"
    });
    const second = manager.createProjectSession({
      project: createEmptyProject("Second", false),
      filePath: "C:\\projects\\second.ctp"
    });

    const saves = Promise.all([
      manager.saveProject({ projectSessionId: first.projectSessionId }),
      manager.saveProject({ projectSessionId: second.projectSessionId })
    ]);
    await Promise.race([
      bothStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 100))
    ]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(2);
    releaseWrites();
    await saves;
  });

  it("serializes cross-directory Save As promotions that share a target directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-save-as-target-lock-"));
    try {
      const sourceADir = join(tempDir, "source-a");
      const sourceBDir = join(tempDir, "source-b");
      const targetDir = join(tempDir, "target");
      const sourceARelativePath = "SourceA-assets/images/page.png";
      const sourceBRelativePath = "SourceB-assets/images/page.png";
      const sourceABytes = Buffer.from("source-a");
      const sourceBBytes = Buffer.from("source-b");
      await mkdir(join(sourceADir, "SourceA-assets", "images"), { recursive: true });
      await mkdir(join(sourceBDir, "SourceB-assets", "images"), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(sourceADir, sourceARelativePath), sourceABytes);
      await writeFile(join(sourceBDir, sourceBRelativePath), sourceBBytes);

      const projectA = createEmptyProject("Source A", false);
      projectA.pageImages = [{
        id: "source-a-page",
        pageNumber: 1,
        storedRelativePath: sourceARelativePath,
        originalFileName: "page.png",
        sha256: sha256(sourceABytes),
        byteSize: sourceABytes.length,
        mimeType: "image/png",
        copiedAt: "2026-08-04T00:00:00.000Z"
      }];
      const projectB = createEmptyProject("Source B", false);
      projectB.pageImages = [{
        id: "source-b-page",
        pageNumber: 1,
        storedRelativePath: sourceBRelativePath,
        originalFileName: "page.png",
        sha256: sha256(sourceBBytes),
        byteSize: sourceBBytes.length,
        mimeType: "image/png",
        copiedAt: "2026-08-04T00:00:00.000Z"
      }];

      let releaseFirst!: () => void;
      let markFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
      const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let calls = 0;
      let active = 0;
      let maxActive = 0;
      const manager = createProjectSessionManager({
        saveProjectFile: async ({ transactionHooks }) => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (calls === 1) markFirstStarted();
          await transactionHooks?.afterCandidateValidated?.();
          await transactionHooks?.beforeFinalRename?.();
          if (calls === 1) await firstRelease;
          await transactionHooks?.afterProjectReplaced?.();
          active -= 1;
        }
      });
      const first = manager.createProjectSession({
        project: projectA,
        filePath: join(sourceADir, "SourceA.ctp")
      });
      const second = manager.createProjectSession({
        project: projectB,
        filePath: join(sourceBDir, "SourceB.ctp")
      });
      const saves = Promise.all([
        manager.saveProjectAs({
          projectSessionId: first.projectSessionId,
          filePath: join(targetDir, "First.ctp")
        }),
        manager.saveProjectAs({
          projectSessionId: second.projectSessionId,
          filePath: join(targetDir, "Second.ctp")
        })
      ]);

      await firstStarted;
      await Promise.resolve();
      expect(calls).toBe(1);
      releaseFirst();
      await saves;
      expect(maxActive).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("serializes the entire pending image transaction against same-path saves", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-file-transaction-"));
    try {
      const sourcePath = join(tempDir, "page.png");
      const projectFilePath = join(tempDir, "Book.ctp");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      const realPageImageImports = createPendingPageImageImportManager({
        temporaryRoot: join(tempDir, "pending"),
        createId: sequenceIds(
          "batch-1",
          "prepared-1",
          "preview-1",
          "page-image-1",
          "transaction-1"
        )
      });
      let markTransactionStarted!: () => void;
      let releaseTransaction!: () => void;
      const transactionStarted = new Promise<void>((resolve) => {
        markTransactionStarted = resolve;
      });
      const transactionRelease = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      const pageImageImports = {
        ...realPageImageImports,
        savePendingPageImages: async (
          args: Parameters<typeof realPageImageImports.savePendingPageImages>[0]
        ) => {
          markTransactionStarted();
          await transactionRelease;
          return realPageImageImports.savePendingPageImages(args);
        }
      };
      const savedTitles: string[] = [];
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-1", "session-2"),
        pageImageImports,
        saveProjectFile: async ({ project, transactionHooks }) => {
          savedTitles.push(project.metadata.title);
          await transactionHooks?.afterCandidateValidated?.();
          await transactionHooks?.beforeFinalRename?.();
          await transactionHooks?.afterProjectReplaced?.();
        }
      });
      const first = manager.createProjectSession({
        project: createEmptyProject("First", false),
        filePath: projectFilePath
      });
      const second = manager.createProjectSession({
        project: createEmptyProject("Second", false),
        filePath: projectFilePath
      });
      const batch = await manager.preparePageImages({
        projectSessionId: first.projectSessionId,
        sourcePaths: [sourcePath]
      });
      await manager.linkPageImages({
        projectSessionId: first.projectSessionId,
        importBatchId: batch.importBatchId,
        pages: [{
          preparedImageId: batch.images[0]!.preparedImageId,
          pageNumber: 1
        }]
      });

      const firstSave = manager.saveProject({
        projectSessionId: first.projectSessionId
      });
      await transactionStarted;
      const secondSave = manager.saveProject({
        projectSessionId: second.projectSessionId
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(savedTitles).toEqual([]);
      releaseTransaction();
      await Promise.all([firstSave, secondSave]);
      expect(savedTitles).toEqual(["First", "Second"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("serializes prepared image release behind an in-flight session import", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-import-release-"));
    try {
      const sourcePath = join(tempDir, "page.png");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      const realImports = createPendingPageImageImportManager({
        temporaryRoot: join(tempDir, "pending"),
        createId: sequenceIds("batch-1", "prepared-1", "preview-1", "page-image-1")
      });
      let markLinkStarted!: () => void;
      let continueLink!: () => void;
      const linkStarted = new Promise<void>((resolve) => {
        markLinkStarted = resolve;
      });
      const linkGate = new Promise<void>((resolve) => {
        continueLink = resolve;
      });
      const order: string[] = [];
      const pageImageImports = {
        ...realImports,
        linkPageImages: async (args: Parameters<typeof realImports.linkPageImages>[0]) => {
          order.push("import-started");
          markLinkStarted();
          await linkGate;
          const result = await realImports.linkPageImages(args);
          order.push("import-finished");
          return result;
        },
        releasePageImageImportBatch: async (
          args: Parameters<typeof realImports.releasePageImageImportBatch>[0]
        ) => {
          order.push("release");
          return realImports.releasePageImageImportBatch(args);
        }
      };
      const manager = createProjectSessionManager({ pageImageImports });
      const created = manager.createProjectSession({
        project: createEmptyProject("Import release", false)
      });
      const batch = await manager.preparePageImages({
        projectSessionId: created.projectSessionId,
        sourcePaths: [sourcePath]
      });
      const linking = manager.linkPageImages({
        projectSessionId: created.projectSessionId,
        importBatchId: batch.importBatchId,
        pages: [{ preparedImageId: batch.images[0]!.preparedImageId, pageNumber: 1 }]
      });
      await linkStarted;
      const releasing = manager.releasePageImageImportBatch({
        projectSessionId: created.projectSessionId,
        importBatchId: batch.importBatchId
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).toEqual(["import-started"]);

      continueLink();
      await Promise.all([linking, releasing]);
      expect(order).toEqual(["import-started", "import-finished", "release"]);
      expect(manager.getProject(created.projectSessionId).pendingPageImages).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks another same-path save when a pending image transaction fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-failed-transaction-"));
    try {
      const sourcePath = join(tempDir, "page.png");
      const projectFilePath = join(tempDir, "Book.ctp");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      let saveCalls = 0;
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-1", "session-2"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending"),
          createId: sequenceIds(
            "batch-1",
            "prepared-1",
            "preview-1",
            "page-image-1",
            "transaction-1"
          )
        }),
        saveProjectFile: async () => {
          saveCalls += 1;
          if (saveCalls === 1) throw new Error("injected save failure");
        }
      });
      const first = manager.createProjectSession({
        project: createEmptyProject("First", false),
        filePath: projectFilePath
      });
      const second = manager.createProjectSession({
        project: createEmptyProject("Second", false),
        filePath: projectFilePath
      });
      const batch = await manager.preparePageImages({
        projectSessionId: first.projectSessionId,
        sourcePaths: [sourcePath]
      });
      await manager.linkPageImages({
        projectSessionId: first.projectSessionId,
        importBatchId: batch.importBatchId,
        pages: [{
          preparedImageId: batch.images[0]!.preparedImageId,
          pageNumber: 1
        }]
      });

      await expect(
        manager.saveProject({ projectSessionId: first.projectSessionId })
      ).rejects.toThrow(/injected save failure/);
      await expect(
        manager.saveProject({ projectSessionId: second.projectSessionId })
      ).rejects.toThrow(/PROJECT_IMPORT_BUSY/);
      expect(saveCalls).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prevents sessions from overwriting another session's import journal", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-import-owner-"));
    try {
      const firstSourcePath = join(tempDir, "first.png");
      const secondSourcePath = join(tempDir, "second.png");
      const projectFilePath = join(tempDir, "Book.ctp");
      await writeFile(firstSourcePath, Buffer.from([1, 2, 3, 4]));
      await writeFile(secondSourcePath, Buffer.from([5, 6, 7, 8]));
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-1", "session-2"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending"),
          createId: sequenceIds(
            "batch-1",
            "prepared-1",
            "preview-1",
            "batch-2",
            "prepared-2",
            "preview-2"
          )
        })
      });
      const first = manager.createProjectSession({
        project: createEmptyProject("First", false),
        filePath: projectFilePath
      });
      const second = manager.createProjectSession({
        project: createEmptyProject("Second", false),
        filePath: projectFilePath
      });

      const firstBatch = await manager.preparePageImages({
        projectSessionId: first.projectSessionId,
        sourcePaths: [firstSourcePath]
      });
      await expect(
        manager.preparePageImages({
          projectSessionId: second.projectSessionId,
          sourcePaths: [secondSourcePath]
        })
      ).rejects.toThrow(/PROJECT_IMPORT_BUSY/);

      await manager.releasePageImageImportBatch({
        projectSessionId: first.projectSessionId,
        importBatchId: firstBatch.importBatchId
      });
      await expect(
        manager.preparePageImages({
          projectSessionId: second.projectSessionId,
          sourcePaths: [secondSourcePath]
        })
      ).resolves.toMatchObject({ importBatchId: "batch-2" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not remove another session's import journal during Save As", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-save-as-owner-"));
    try {
      const sourcePath = join(tempDir, "page.png");
      const originalPath = join(tempDir, "Book.ctp");
      const newPath = join(tempDir, "Other.ctp");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-1", "session-2"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending"),
          createId: sequenceIds("batch-1", "prepared-1", "preview-1")
        }),
        saveProjectFile: async () => undefined
      });
      const owner = manager.createProjectSession({
        project: createEmptyProject("Owner", false),
        filePath: originalPath
      });
      const other = manager.createProjectSession({
        project: createEmptyProject("Other", false),
        filePath: originalPath
      });
      await manager.preparePageImages({
        projectSessionId: owner.projectSessionId,
        sourcePaths: [sourcePath]
      });

      await manager.saveProjectAs({
        projectSessionId: other.projectSessionId,
        filePath: newPath
      });

      const journal = JSON.parse(
        await readFile(`${originalPath}.import-journal.json`, "utf8")
      ) as { projectSessionId: string };
      expect(journal.projectSessionId).toBe(owner.projectSessionId);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an orphaned import journal at a Save As target", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-orphan-target-"));
    try {
      const sourcePath = join(tempDir, "page.png");
      const targetPath = join(tempDir, "Recovered.ctp");
      const journalPath = `${targetPath}.import-journal.json`;
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      await writeFile(journalPath, JSON.stringify({
        schemaVersion: 1,
        projectSessionId: "session-before-crash",
        targetProjectPath: targetPath,
        preparedPageImages: [],
        pendingPageImageLinks: [],
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z"
      }));
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-new"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending"),
          createId: sequenceIds(
            "batch-1",
            "prepared-1",
            "preview-1"
          )
        }),
        saveProjectFile: async () => undefined
      });
      const created = manager.createProjectSession({
        project: createEmptyProject("New", false)
      });
      await manager.preparePageImages({
        projectSessionId: created.projectSessionId,
        sourcePaths: [sourcePath]
      });

      await expect(
        manager.saveProjectAs({
          projectSessionId: created.projectSessionId,
          filePath: targetPath
        })
      ).rejects.toThrow(/PROJECT_IMPORT_BUSY/);
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        projectSessionId: string;
      };
      expect(journal.projectSessionId).toBe("session-before-crash");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks a plain Save As from invalidating an orphaned import journal", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-plain-orphan-target-"));
    try {
      const targetPath = join(tempDir, "Recovered.ctp");
      const journalPath = `${targetPath}.import-journal.json`;
      await writeFile(journalPath, JSON.stringify({
        schemaVersion: 1,
        projectSessionId: "session-before-crash",
        targetProjectPath: targetPath,
        preparedPageImages: [],
        pendingPageImageLinks: [],
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z"
      }));
      let saveCalls = 0;
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-new"),
        saveProjectFile: async () => {
          saveCalls += 1;
        }
      });
      const created = manager.createProjectSession({
        project: createEmptyProject("New", false)
      });

      await expect(
        manager.saveProjectAs({
          projectSessionId: created.projectSessionId,
          filePath: targetPath
        })
      ).rejects.toThrow(/PROJECT_IMPORT_BUSY/);
      expect(saveCalls).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a closed session's import journal reserved until it is resumed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-resume-owner-"));
    try {
      const firstSourcePath = join(tempDir, "first.png");
      const secondSourcePath = join(tempDir, "second.png");
      const projectFilePath = join(tempDir, "Book.ctp");
      await writeFile(firstSourcePath, Buffer.from([1, 2, 3, 4]));
      await writeFile(secondSourcePath, Buffer.from([5, 6, 7, 8]));
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-1", "session-2"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending"),
          createId: sequenceIds(
            "batch-1",
            "prepared-1",
            "preview-1",
            "batch-2",
            "prepared-2",
            "preview-2"
          )
        })
      });
      const first = manager.createProjectSession({
        project: createEmptyProject("First", false),
        filePath: projectFilePath
      });
      const second = manager.createProjectSession({
        project: createEmptyProject("Second", false),
        filePath: projectFilePath
      });
      await manager.preparePageImages({
        projectSessionId: first.projectSessionId,
        sourcePaths: [firstSourcePath]
      });
      await manager.closeProject({ projectSessionId: first.projectSessionId });

      await expect(
        manager.preparePageImages({
          projectSessionId: second.projectSessionId,
          sourcePaths: [secondSourcePath]
        })
      ).rejects.toThrow(/PROJECT_IMPORT_BUSY/);

      await manager.resumePageImageImports(second.projectSessionId);
      await expect(
        manager.preparePageImages({
          projectSessionId: second.projectSessionId,
          sourcePaths: [secondSourcePath]
        })
      ).resolves.toMatchObject({ importBatchId: "batch-2" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves staged page bytes across normal close and process restart until the resumed save commits", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-close-resume-"));
    try {
      const sourcePath = join(tempDir, "Page.png");
      const projectFilePath = join(tempDir, "Book.ctp");
      const temporaryRoot = join(tempDir, "pending");
      const stagedPath = join(
        temporaryRoot,
        "session-before-close",
        "batch-1",
        "prepared-1.png"
      );
      const project = createEmptyProject("Book", false);
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

      const firstManager = createProjectSessionManager({
        createId: sequenceIds("session-before-close"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot,
          createId: sequenceIds(
            "batch-1",
            "prepared-1",
            "preview-1",
            "page-image-1"
          )
        })
      });
      const first = firstManager.createProjectSession({
        project,
        filePath: projectFilePath
      });
      await firstManager.preparePageImages({
        projectSessionId: first.projectSessionId,
        sourcePaths: [sourcePath]
      });
      await firstManager.linkPageImages({
        projectSessionId: first.projectSessionId,
        importBatchId: "batch-1",
        pages: [{ preparedImageId: "prepared-1", pageNumber: 1 }]
      });

      await firstManager.closeProject({ projectSessionId: first.projectSessionId });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));

      await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
      await expect(stat(importJournalPath(projectFilePath))).resolves.toBeDefined();

      const restartedManager = createProjectSessionManager({
        createId: sequenceIds("session-after-restart"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot,
          createId: sequenceIds("transaction-after-restart")
        })
      });
      const restarted = restartedManager.createProjectSession({
        project,
        filePath: projectFilePath
      });
      const resumed = await restartedManager.resumePageImageImports(
        restarted.projectSessionId
      );

      expect(resumed.pendingPageImages).toEqual([
        expect.objectContaining({
          pageImageId: "page-image-1",
          pageNumber: 1
        })
      ]);

      const saved = await restartedManager.saveProject({
        projectSessionId: restarted.projectSessionId
      });
      expect(saved.project.project.pageImages).toEqual([
        expect.objectContaining({
          id: "page-image-1",
          pageNumber: 1
        })
      ]);
      await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(importJournalPath(projectFilePath))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(
        stat(join(temporaryRoot, "session-before-close"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("releases import ownership when linking leaves no pending work", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-empty-link-owner-"));
    try {
      const sourcePath = join(tempDir, "page.png");
      const projectFilePath = join(tempDir, "Book.ctp");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      const manager = createProjectSessionManager({
        createId: sequenceIds("session-1", "session-2"),
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending"),
          createId: sequenceIds("batch-1", "prepared-1", "preview-1")
        })
      });
      const first = manager.createProjectSession({
        project: createEmptyProject("First", false),
        filePath: projectFilePath
      });
      const second = manager.createProjectSession({
        project: createEmptyProject("Second", false),
        filePath: projectFilePath
      });

      await manager.linkPageImages({
        projectSessionId: first.projectSessionId,
        importBatchId: "missing-batch",
        pages: [{ preparedImageId: "missing-image", pageNumber: 1 }]
      });

      await expect(
        manager.preparePageImages({
          projectSessionId: second.projectSessionId,
          sourcePaths: [sourcePath]
        })
      ).resolves.toMatchObject({ importBatchId: "batch-1" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not change revision or dirty state for an empty image import result", async () => {
    const manager = createProjectSessionManager();
    const created = manager.createProjectSession({
      project: createEmptyProject("No images", false)
    });

    const result = await manager.registerImportedPageImages({
      projectSessionId: created.projectSessionId,
      pageImages: []
    });

    expect(result.project).toMatchObject({
      revision: 0,
      dirty: false,
      project: { pageImages: [] }
    });
  });

  it("retains pending edits and the original path after Save As fails", async () => {
    const savePaths: string[] = [];
    let failNextSave = true;
    const manager = createProjectSessionManager({
      saveProjectFile: async ({ filePath }) => {
        savePaths.push(filePath);
        if (failNextSave) {
          failNextSave = false;
          throw new Error("injected save failure");
        }
      }
    });
    const created = manager.createProjectSession({
      project: createEmptyProject("Failure", false),
      filePath: "C:\\projects\\original.ctp"
    });
    await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: 0,
      mutation: { type: "set_project_title", title: "Pending title" }
    });

    await expect(manager.saveProjectAs({
      projectSessionId: created.projectSessionId,
      filePath: "C:\\projects\\new.ctp"
    })).rejects.toThrow(/injected save failure/);
    expect(manager.getProject(created.projectSessionId)).toMatchObject({
      dirty: true,
      project: { metadata: { title: "Pending title" } }
    });

    await expect(manager.saveProject({
      projectSessionId: created.projectSessionId
    })).resolves.toMatchObject({ project: { dirty: false } });
    expect(savePaths).toEqual(["C:\\projects\\new.ctp", "C:\\projects\\original.ctp"]);
  });

  it("relocates persisted assets before a cross-directory Save As is committed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-asset-relocation-"));
    try {
      const sourceDir = join(tempDir, "source");
      const targetDir = join(tempDir, "target");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      const sourcePath = join(sourceDir, "Book.ctp");
      const targetPath = join(targetDir, "Book-copy.ctp");
      const pageBytes = Buffer.from("source-page");
      const resultBytes = Buffer.from("source-result");
      const pageRelativePath = "Book-assets/images/page.png";
      const resultRelativePath = "Book-assets/results/cleaned.png";
      await mkdir(join(sourceDir, "Book-assets", "images"), { recursive: true });
      await mkdir(join(sourceDir, "Book-assets", "results"), { recursive: true });
      await writeFile(join(sourceDir, pageRelativePath), pageBytes);
      await writeFile(join(sourceDir, resultRelativePath), resultBytes);

      const project = createEmptyProject("Relocation", false);
      project.pageImages = [{
        id: "page-1",
        pageNumber: 1,
        storedRelativePath: pageRelativePath,
        originalFileName: "page.png",
        sha256: sha256(pageBytes),
        byteSize: pageBytes.length,
        mimeType: "image/png",
        copiedAt: "2026-08-04T00:00:00.000Z"
      }];
      project.processing.assets = [{
        assetId: "asset-1",
        source: "manual_openai",
        sourcePageImageId: "page-1",
        runId: "run-1",
        role: "cleaned",
        storedRelativePath: resultRelativePath,
        sha256: sha256(resultBytes),
        byteSize: resultBytes.length,
        mimeType: "image/png",
        createdAt: "2026-08-04T00:00:00.000Z"
      }];
      const order: string[] = [];
      const manager = createProjectSessionManager({
        saveProjectFile: async ({ filePath, transactionHooks }) => {
          order.push("save-start");
          await transactionHooks?.afterCandidateValidated?.();
          order.push("candidate-validated");
          await transactionHooks?.beforeFinalRename?.();
          order.push("before-final-rename");
          await writeFile(filePath, "project");
          await transactionHooks?.afterProjectReplaced?.();
          order.push("project-replaced");
        }
      });
      const created = manager.createProjectSession({ project, filePath: sourcePath });

      await manager.saveProjectAs({ projectSessionId: created.projectSessionId, filePath: targetPath });

      expect(order).toEqual([
        "save-start",
        "candidate-validated",
        "before-final-rename",
        "project-replaced"
      ]);
      expect(await readFile(join(targetDir, pageRelativePath))).toEqual(pageBytes);
      expect(await readFile(join(targetDir, resultRelativePath))).toEqual(resultBytes);
      expect(await readFile(join(sourceDir, pageRelativePath))).toEqual(pageBytes);
      expect(await readFile(join(sourceDir, resultRelativePath))).toEqual(resultBytes);
      expect(manager.getFilePath(created.projectSessionId)).toBe(targetPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("relocates source-backed assets while keeping a new pending page local to the target", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-pending-relocation-"));
    try {
      const sourceDir = join(tempDir, "source");
      const targetDir = join(tempDir, "target");
      await mkdir(join(sourceDir, "Book-assets", "images"), { recursive: true });
      await mkdir(join(sourceDir, "Book-assets", "results"), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      const sourceProjectPath = join(sourceDir, "Book.ctp");
      const targetProjectPath = join(targetDir, "Book-copy.ctp");
      const sourcePageBytes = Buffer.from("source-page");
      const sourceResultBytes = Buffer.from("source-result");
      const pendingPageBytes = Buffer.from([8, 7, 6, 5]);
      const sourcePageRelativePath = "Book-assets/images/source.png";
      const sourceResultRelativePath = "Book-assets/results/cleaned.png";
      await writeFile(join(sourceDir, sourcePageRelativePath), sourcePageBytes);
      await writeFile(join(sourceDir, sourceResultRelativePath), sourceResultBytes);
      const pendingSourcePath = join(tempDir, "pending.png");
      await writeFile(pendingSourcePath, pendingPageBytes);

      const project = createEmptyProject("Pending relocation", false);
      project.pageImages = [{
        id: "source-page",
        pageNumber: 1,
        storedRelativePath: sourcePageRelativePath,
        originalFileName: "source.png",
        sha256: sha256(sourcePageBytes),
        byteSize: sourcePageBytes.length,
        mimeType: "image/png",
        copiedAt: "2026-08-04T00:00:00.000Z"
      }];
      project.processing.assets = [{
        assetId: "source-result",
        source: "manual_openai",
        sourcePageImageId: "source-page",
        runId: "run-1",
        role: "cleaned",
        storedRelativePath: sourceResultRelativePath,
        sha256: sha256(sourceResultBytes),
        byteSize: sourceResultBytes.length,
        mimeType: "image/png",
        createdAt: "2026-08-04T00:00:00.000Z"
      }];
      const manager = createProjectSessionManager({
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending-work"),
          createId: sequenceIds(
            "batch-pending-relocation",
            "prepared-pending-relocation",
            "preview-pending-relocation",
            "pending-page-relocation",
            "transaction-pending-relocation"
          )
        })
      });
      const created = manager.createProjectSession({ project, filePath: sourceProjectPath });
      const batch = await manager.preparePageImages({
        projectSessionId: created.projectSessionId,
        sourcePaths: [pendingSourcePath]
      });
      await manager.linkPageImages({
        projectSessionId: created.projectSessionId,
        importBatchId: batch.importBatchId,
        pages: [{ preparedImageId: batch.images[0]!.preparedImageId, pageNumber: 2 }]
      });

      const saved = await manager.saveProjectAs({
        projectSessionId: created.projectSessionId,
        filePath: targetProjectPath
      });

      expect(saved.project.project.pageImages).toHaveLength(2);
      expect(saved.project.project.pageImages.map((image) => image.pageNumber)).toEqual([1, 2]);
      expect(await readFile(join(targetDir, sourcePageRelativePath))).toEqual(sourcePageBytes);
      expect(await readFile(join(targetDir, sourceResultRelativePath))).toEqual(sourceResultBytes);
      const pendingTargetPath = saved.project.project.pageImages.find((image) => image.pageNumber === 2)?.storedRelativePath;
      expect(pendingTargetPath).toMatch(/^Book-copy-assets\/images\/[a-f0-9]{64}\.png$/);
      await expect(readFile(join(targetDir, pendingTargetPath!))).resolves.toEqual(pendingPageBytes);
      expect(await readFile(join(sourceDir, sourcePageRelativePath))).toEqual(sourcePageBytes);
      expect(await readFile(join(sourceDir, sourceResultRelativePath))).toEqual(sourceResultBytes);
      expect(manager.getFilePath(created.projectSessionId)).toBe(targetProjectPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restores the source session and pending edits when Save As fails after promotion", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-relocation-rollback-"));
    try {
      const sourceDir = join(tempDir, "source");
      const targetDir = join(tempDir, "target");
      await mkdir(join(sourceDir, "Book-assets", "images"), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      const sourceProjectPath = join(sourceDir, "Book.ctp");
      const targetProjectPath = join(targetDir, "Book-copy.ctp");
      const bytes = Buffer.from("source-asset");
      const relativePath = "Book-assets/images/page.png";
      await writeFile(join(sourceDir, relativePath), bytes);
      const project = createEmptyProject("Rollback", false);
      project.pageImages = [{
        id: "page-1",
        pageNumber: 1,
        storedRelativePath: relativePath,
        originalFileName: "page.png",
        sha256: sha256(bytes),
        byteSize: bytes.length,
        mimeType: "image/png",
        copiedAt: "2026-08-04T00:00:00.000Z"
      }];
      const manager = createProjectSessionManager({
        saveProjectFile: async ({ transactionHooks }) => {
          await transactionHooks?.afterCandidateValidated?.();
          await transactionHooks?.beforeFinalRename?.();
          throw new Error("injected final project save failure");
        }
      });
      const created = manager.createProjectSession({ project, filePath: sourceProjectPath });
      await manager.applyProjectMutation({
        projectSessionId: created.projectSessionId,
        baseRevision: 0,
        mutation: { type: "set_project_title", title: "Unsaved title" }
      });

      await expect(manager.saveProjectAs({
        projectSessionId: created.projectSessionId,
        filePath: targetProjectPath
      })).rejects.toThrow(/final project save failure/);

      expect(manager.getFilePath(created.projectSessionId)).toBe(sourceProjectPath);
      expect(manager.getProject(created.projectSessionId)).toMatchObject({
        dirty: true,
        project: { metadata: { title: "Unsaved title" } }
      });
      expect(await readFile(join(sourceDir, relativePath))).toEqual(bytes);
      await expect(readFile(join(targetDir, relativePath))).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restores the pending import target after Save As fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-save-as-import-"));
    try {
      const originalPath = join(tempDir, "Original.ctp");
      const newPath = join(tempDir, "nested", "New.ctp");
      await mkdir(join(tempDir, "nested"), { recursive: true });
      const sourcePath = join(tempDir, "page.png");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      const savePaths: string[] = [];
      const hookOrder: string[] = [];
      let failNextSave = true;
      const manager = createProjectSessionManager({
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending"),
          createId: sequenceIds(
            "batch-1",
            "prepared-1",
            "preview-1",
            "page-image-1",
            "transaction-1",
            "transaction-2"
          )
        }),
        saveProjectFile: async ({ filePath, transactionHooks }) => {
          savePaths.push(filePath);
          if (failNextSave) {
            failNextSave = false;
            throw new Error("injected pending save failure");
          }
          await transactionHooks?.afterCandidateValidated?.();
          hookOrder.push("candidate-validated");
          await transactionHooks?.beforeFinalRename?.();
          hookOrder.push("before-final-rename");
          await transactionHooks?.afterProjectReplaced?.();
          hookOrder.push("project-replaced");
        }
      });
      const created = manager.createProjectSession({
        project: createEmptyProject("Original", false),
        filePath: originalPath
      });
      const batch = await manager.preparePageImages({
        projectSessionId: created.projectSessionId,
        sourcePaths: [sourcePath]
      });
      await manager.linkPageImages({
        projectSessionId: created.projectSessionId,
        importBatchId: batch.importBatchId,
        pages: [{ preparedImageId: batch.images[0]!.preparedImageId, pageNumber: 1 }]
      });

      await expect(manager.saveProjectAs({
        projectSessionId: created.projectSessionId,
        filePath: newPath
      })).rejects.toThrow(/pending save failure/);
      const saved = await manager.saveProject({
        projectSessionId: created.projectSessionId
      });

      expect(savePaths).toEqual([newPath, originalPath]);
      expect(hookOrder).toEqual(["candidate-validated", "before-final-rename", "project-replaced"]);
      expect(saved.project.project.pageImages[0]?.storedRelativePath).toMatch(
        /^Original-assets\/images\/[a-f0-9]{64}\.png$/
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the active secret protection intact when rekey persistence fails", async () => {
    const manager = createProjectSessionManager({
      saveProjectFile: async () => {
        throw new Error("injected rekey failure");
      }
    });
    const created = manager.createSecretProjectSession({
      project: createEmptyProject("Secret failure", true),
      password: "old password",
      filePath: "C:\\projects\\secret.ctp"
    });

    await expect(manager.rekeyProject({
      projectSessionId: created.projectSessionId,
      newPassword: "new password"
    })).rejects.toThrow(/injected rekey failure/);
    for (const buffer of created.protectionBuffers) {
      expect(buffer.some((byte) => byte !== 0)).toBe(true);
    }

    await manager.closeProject({ projectSessionId: created.projectSessionId });
    for (const buffer of created.protectionBuffers) {
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("replays pending add, update, delete, and reorder after a Main patch without persisting them early", async () => {
    const writes: TranslationProjectV2[] = [];
    const manager = createProjectSessionManager({
      createId: (() => {
        let id = 0;
        return () => `generated-${++id}`;
      })(),
      saveProjectFile: async ({ project }) => {
        writes.push(structuredClone(project));
      }
    });
    const project = createEmptyProject("Gate A", false);
    project.pageImages = [pageImage("page-1", 1)];
    project.dialogueLines = [
      manualLine("update-line", 1, "original"),
      manualLine("delete-line", 2, "delete me"),
      manualLine("reorder-a", 3, "A"),
      manualLine("reorder-b", 4, "B")
    ];
    const created = manager.createProjectSession({
      project,
      filePath: "C:\\projects\\gate-a.ctp"
    });
    let revision = created.project.revision;
    for (const mutation of [
      {
        type: "update_dialogue_line" as const,
        lineId: "update-line",
        patch: { sourceText: "user edit" }
      },
      { type: "remove_dialogue_line" as const, lineId: "delete-line" },
      {
        type: "reorder_dialogue_lines" as const,
        orderedLineIds: ["reorder-b", "reorder-a", "update-line"]
      },
      {
        type: "add_dialogue_line" as const,
        input: {
          pageNumber: 1,
          sourceLanguage: "ja" as const,
          sourceText: "added",
          dialogueType: "speech" as const
        }
      }
    ]) {
      const result = await manager.applyProjectMutation({
        projectSessionId: created.projectSessionId,
        baseRevision: revision,
        mutation
      });
      expect(result.status).toBe("applied");
      revision = result.revision;
    }

    const committed = await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: processingPatch()
    });

    expect(committed.project.project.dialogueLines.map((line) => line.sourceText)).toEqual([
      "B",
      "A",
      "user edit",
      "added"
    ]);
    expect(committed.project.dirty).toBe(true);
    expect(writes[0]?.dialogueLines.map((line) => line.sourceText)).toEqual([
      "original",
      "delete me",
      "A",
      "B"
    ]);

    await manager.saveProject({ projectSessionId: created.projectSessionId });
    expect(writes[1]?.dialogueLines.map((line) => line.sourceText)).toEqual([
      "B",
      "A",
      "user edit",
      "added"
    ]);
  });

  it("keeps a pending user source edit ahead of OCR and never deletes manual lines", async () => {
    const writes: TranslationProjectV2[] = [];
    const project = createEmptyProject("OCR merge", false);
    project.pageImages = [pageImage("page-1", 1)];
    project.dialogueLines = [
      manualLine("manual-line", 1, "manual"),
      pipelineLine("pipeline-line", 2, "old OCR", "region-1", 1)
    ];
    const manager = createProjectSessionManager({
      saveProjectFile: async ({ project: written }) => {
        writes.push(structuredClone(written));
      }
    });
    const created = manager.createProjectSession({
      project,
      filePath: "C:\\projects\\ocr-merge.ctp"
    });
    await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: 0,
      mutation: {
        type: "update_dialogue_line",
        lineId: "pipeline-line",
        patch: { sourceText: "user corrected" }
      }
    });

    const committed = await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: {
        type: "merge_pipeline_dialogues",
        pageImageId: "page-1",
        lines: [pipelineLine("pipeline-line", 2, "new OCR", "region-1", 1)],
        orphanedPersistentRegionIds: []
      }
    });

    expect(writes[0]?.dialogueLines.map((line) => line.sourceText)).toEqual(["manual", "new OCR"]);
    expect(committed.project.project.dialogueLines.map((line) => line.sourceText)).toEqual([
      "manual",
      "user corrected"
    ]);
    expect(committed.project.project.dialogueLines[0]?.origin).toEqual({ kind: "manual" });
  });

  it("keeps the saved Main patch and pending journal when replay needs recovery", async () => {
    const writes: TranslationProjectV2[] = [];
    const project = createEmptyProject("Recovery", false);
    project.pageImages = [pageImage("page-1", 1)];
    project.dialogueLines = [
      pipelineLine("old-pipeline-id", 1, "old OCR", "region-1", 1)
    ];
    const manager = createProjectSessionManager({
      saveProjectFile: async ({ project: written }) => {
        writes.push(structuredClone(written));
      }
    });
    const created = manager.createProjectSession({
      project,
      filePath: "C:\\projects\\recovery.ctp"
    });
    await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: 0,
      mutation: {
        type: "update_dialogue_line",
        lineId: "old-pipeline-id",
        patch: { sourceText: "pending correction" }
      }
    });

    const committed = await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: {
        type: "merge_pipeline_dialogues",
        pageImageId: "page-1",
        lines: [pipelineLine("new-pipeline-id", 1, "new OCR", "region-1", 1)],
        orphanedPersistentRegionIds: []
      }
    });

    expect(writes[0]?.dialogueLines[0]?.id).toBe("new-pipeline-id");
    expect(committed.project).toMatchObject({
      status: "needs_recovery",
      dirty: true,
      project: { dialogueLines: [{ id: "new-pipeline-id", sourceText: "new OCR" }] }
    });
    await expect(
      manager.saveProject({ projectSessionId: created.projectSessionId })
    ).rejects.toThrow(/needs_recovery/);
  });

  it("keeps pending page imports outside the live project until user save commits them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-imports-"));
    try {
      const sourcePath = join(tempDir, "user-owned", "page.png");
      const projectFilePath = join(tempDir, "Book.ctp");
      await mkdir(join(tempDir, "user-owned"), { recursive: true });
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      const pageImageImports = createPendingPageImageImportManager({
        temporaryRoot: join(tempDir, "pending"),
        createId: sequenceIds(
          "batch-1",
          "prepared-1",
          "preview-1",
          "page-image-1",
          "transaction-1"
        )
      });
      const writes: TranslationProjectV2[] = [];
      const manager = createProjectSessionManager({
        pageImageImports,
        saveProjectFile: async ({ project, transactionHooks }) => {
          writes.push(structuredClone(project));
          await transactionHooks?.afterCandidateValidated?.();
          await transactionHooks?.beforeFinalRename?.();
          await transactionHooks?.afterProjectReplaced?.();
        }
      });
      const created = manager.createProjectSession({
        project: createEmptyProject("Book", false),
        filePath: projectFilePath
      });

      const batch = await manager.preparePageImages({
        projectSessionId: created.projectSessionId,
        sourcePaths: [sourcePath]
      });
      const linkArgs = {
        projectSessionId: created.projectSessionId,
        importBatchId: batch.importBatchId,
        pages: [{
          preparedImageId: batch.images[0]!.preparedImageId,
          pageNumber: 1
        }]
      };
      await manager.linkPageImages(linkArgs);
      await manager.linkPageImages(linkArgs);

      expect(manager.getProject(created.projectSessionId)).toMatchObject({
        revision: 1,
        project: { pageImages: [] },
        pendingPageImages: [{
          pageImageId: "page-image-1",
          pageNumber: 1,
          preparedImageId: "prepared-1"
        }],
        dirty: true
      });
      expect(writes).toEqual([]);

      const saved = await manager.saveProject({
        projectSessionId: created.projectSessionId
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.pageImages).toEqual([
        expect.objectContaining({ id: "page-image-1", pageNumber: 1 })
      ]);
      expect(saved.project).toMatchObject({
        project: {
          pageImages: [expect.objectContaining({ id: "page-image-1" })]
        },
        pendingPageImages: [],
        dirty: false
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reopens a replaced page with its old processing graph invalidated and user dialogue orphaned", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "project-session-replacement-reopen-"));
    try {
      const projectFilePath = join(tempDir, "Book.ctp");
      const replacementSourcePath = join(tempDir, "replacement.png");
      await writeFile(replacementSourcePath, Buffer.from([5, 6, 7, 8]));
      const project = createEmptyProject("Replacement reopen", false);
      project.pageImages = [pageImage("page-1", 1)];
      project.dialogueLines = [{
        ...pipelineLine("pipeline-line", 1, "사용자 수정 원문", "region-1", 1),
        userTranslation: "사용자 번역"
      }];
      const manager = createProjectSessionManager({
        pageImageImports: createPendingPageImageImportManager({
          temporaryRoot: join(tempDir, "pending"),
          createId: sequenceIds(
            "batch-1", "prepared-1", "preview-1", "replacement-page", "transaction-1"
          )
        })
      });
      const created = manager.createProjectSession({ project, filePath: projectFilePath });
      await manager.saveProject({ projectSessionId: created.projectSessionId });
      const basePatch = processingPatch();
      await manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...basePatch,
          pageRecord: {
            ...basePatch.pageRecord,
            approvedCleanedAssetId: "asset-1"
          },
          assets: [processingAsset()]
        }
      });
      const batch = await manager.preparePageImages({
        projectSessionId: created.projectSessionId,
        sourcePaths: [replacementSourcePath]
      });
      await manager.linkPageImages({
        projectSessionId: created.projectSessionId,
        importBatchId: batch.importBatchId,
        pages: [{ preparedImageId: batch.images[0]!.preparedImageId, pageNumber: 1 }]
      });
      await manager.saveProject({ projectSessionId: created.projectSessionId });
      await expect(manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...processingPatch(),
          run: { ...processingPatch().run, runId: "stale-run" },
          pageRecord: { ...processingPatch().pageRecord, latestCompletedRunId: "stale-run" }
        }
      })).rejects.toThrow(/Unknown page image|missing from the persisted project/);
      await manager.closeProject({ projectSessionId: created.projectSessionId });

      const reopened = await loadProjectFile({ filePath: projectFilePath });
      expect(reopened.project.pageImages).toEqual([
        expect.objectContaining({ id: "replacement-page", pageNumber: 1 })
      ]);
      expect(reopened.project.processing).toEqual({ pages: [], runs: [], assets: [] });
      expect(reopened.project.dialogueLines[0]).toMatchObject({
        sourceText: "사용자 수정 원문",
        userTranslation: "사용자 번역",
        orphanedFromPipeline: true,
        origin: { pageImageId: "page-1" }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows processing only for a persisted page image and blocks unsaved replacements", async () => {
    const project = createEmptyProject("Processing gate", false);
    project.pageImages = [pageImage("persisted-page", 1)];
    const manager = createProjectSessionManager();
    const created = manager.createProjectSession({ project });

    expect(() =>
      manager.assertPageImageReadyForProcessing({
        projectSessionId: created.projectSessionId,
        pageImageId: "persisted-page"
      })
    ).not.toThrow();

    await manager.registerImportedPageImages({
      projectSessionId: created.projectSessionId,
      pageImages: [pageImage("direct-import-page", 1)]
    });

    expect(() =>
      manager.assertPageImageReadyForProcessing({
        projectSessionId: created.projectSessionId,
        pageImageId: "direct-import-page"
      })
    ).toThrow(/먼저 저장.*OCR.*인페인팅/);
  });

  it("rejects an old processing commit after the live page is replaced while the provider is running", async () => {
    const writes: TranslationProjectV2[] = [];
    const project = createEmptyProject("Processing race", false);
    project.pageImages = [pageImage("page-1", 1)];
    const manager = createProjectSessionManager({
      saveProjectFile: async ({ project: written }) => {
        writes.push(structuredClone(written));
      }
    });
    const created = manager.createProjectSession({
      project,
      filePath: "C:\\projects\\processing-race.ctp"
    });

    await manager.registerImportedPageImages({
      projectSessionId: created.projectSessionId,
      pageImages: [pageImage("page-2", 1)]
    });

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: processingPatch()
      })
    ).rejects.toThrow(/page image|processing|save/i);
    expect(writes).toEqual([]);
  });

  it("rejects processing and approval patches with inconsistent page/run/asset graphs", async () => {
    const project = createEmptyProject("Processing graph", false);
    project.pageImages = [pageImage("page-1", 1)];
    const manager = createProjectSessionManager({ saveProjectFile: async () => undefined });
    const created = manager.createProjectSession({
      project,
      filePath: "C:\\projects\\processing-graph.ctp"
    });
    const base = processingPatch();

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...base,
          run: { ...base.run, pageImageId: "other-page" }
        }
      })
    ).rejects.toThrow(/page|run|processing/i);

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...base,
          pageRecord: { ...base.pageRecord, pageImageId: "other-page" }
        }
      })
    ).rejects.toThrow(/page|run|processing/i);

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...base,
          run: { ...base.run, sourceSha256: "b".repeat(64) }
        }
      })
    ).rejects.toThrow(/SHA|source|page image/i);

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...base,
          assets: [processingAsset({ sourcePageImageId: "other-page" })]
        }
      })
    ).rejects.toThrow(/asset|source|run|processing/i);

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...base,
          assets: [processingAsset({ runId: "other-run" })]
        }
      })
    ).rejects.toThrow(/asset|source|run|processing/i);

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...base,
          assets: [processingAsset({ source: "manual_openai" })]
        }
      })
    ).rejects.toThrow(/asset|source|run|processing/i);

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...base,
          pageRecord: { ...base.pageRecord, activeRunId: "missing-run" }
        }
      })
    ).rejects.toThrow(/page|run|processing/i);

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          ...base,
          pageRecord: { ...base.pageRecord, latestCompletedRunId: "missing-run" }
        }
      })
    ).rejects.toThrow(/page|run|processing/i);

    const seeded = structuredClone(project);
    seeded.processing = {
      pages: [base.pageRecord],
      runs: [base.run],
      assets: [processingAsset()]
    };
    const approvalManager = createProjectSessionManager({ saveProjectFile: async () => undefined });
    const approvalSession = approvalManager.createProjectSession({
      project: seeded,
      filePath: "C:\\projects\\processing-approval.ctp"
    });
    await expect(
      approvalManager.commitMainProjectPatch({
        projectSessionId: approvalSession.projectSessionId,
        patch: {
          type: "approve_asset",
          pageImageId: "page-1",
          assetId: "missing-asset",
          kind: "cleaned"
        }
      })
    ).rejects.toThrow(/asset|approval|processing/i);

    await expect(
      approvalManager.commitMainProjectPatch({
        projectSessionId: approvalSession.projectSessionId,
        patch: {
          type: "approve_asset",
          pageImageId: "page-1",
          assetId: "asset-1",
          kind: "translated"
        }
      })
    ).rejects.toThrow(/role|asset|approval/i);

    const mismatchedSource = structuredClone(seeded);
    mismatchedSource.processing.assets[0]!.sourcePageImageId = "other-page";
    const mismatchedSourceManager = createProjectSessionManager({ saveProjectFile: async () => undefined });
    const mismatchedSourceSession = mismatchedSourceManager.createProjectSession({
      project: mismatchedSource,
      filePath: "C:\\projects\\processing-approval-source.ctp"
    });
    await expect(
      mismatchedSourceManager.commitMainProjectPatch({
        projectSessionId: mismatchedSourceSession.projectSessionId,
        patch: {
          type: "approve_asset",
          pageImageId: "page-1",
          assetId: "asset-1",
          kind: "cleaned"
        }
      })
    ).rejects.toThrow(/source page|asset|approval/i);

    const mismatchedSourceKind = structuredClone(seeded);
    mismatchedSourceKind.processing.assets[0]!.source = "manual_openai";
    const mismatchedSourceKindManager = createProjectSessionManager({ saveProjectFile: async () => undefined });
    const mismatchedSourceKindSession = mismatchedSourceKindManager.createProjectSession({
      project: mismatchedSourceKind,
      filePath: "C:\\projects\\processing-approval-source-kind.ctp"
    });
    await expect(
      mismatchedSourceKindManager.commitMainProjectPatch({
        projectSessionId: mismatchedSourceKindSession.projectSessionId,
        patch: {
          type: "approve_asset",
          pageImageId: "page-1",
          assetId: "asset-1",
          kind: "cleaned"
        }
      })
    ).rejects.toThrow(/source|run|asset|approval/i);

    const mismatchedRun = structuredClone(seeded);
    mismatchedRun.processing.runs[0]!.pageImageId = "other-page";
    const mismatchedRunManager = createProjectSessionManager({ saveProjectFile: async () => undefined });
    const mismatchedRunSession = mismatchedRunManager.createProjectSession({
      project: mismatchedRun,
      filePath: "C:\\projects\\processing-approval-run.ctp"
    });
    await expect(
      mismatchedRunManager.commitMainProjectPatch({
        projectSessionId: mismatchedRunSession.projectSessionId,
        patch: {
          type: "approve_asset",
          pageImageId: "page-1",
          assetId: "asset-1",
          kind: "cleaned"
        }
      })
    ).rejects.toThrow(/run|page|asset|approval/i);
  });

  it("rejects pipeline dialogue merges for a page that is no longer persisted", async () => {
    const project = createEmptyProject("Pipeline page", false);
    project.pageImages = [pageImage("page-1", 1)];
    const manager = createProjectSessionManager({ saveProjectFile: async () => undefined });
    const created = manager.createProjectSession({
      project,
      filePath: "C:\\projects\\pipeline-page.ctp"
    });

    await expect(
      manager.commitMainProjectPatch({
        projectSessionId: created.projectSessionId,
        patch: {
          type: "merge_pipeline_dialogues",
          pageImageId: "missing-page",
          lines: [],
          orphanedPersistentRegionIds: []
        }
      })
    ).rejects.toThrow(/page|processing|pipeline/i);
  });

  it("resolves registered processing asset paths but rejects unknown session image paths", () => {
    const project = createEmptyProject("Processing asset path", false);
    project.pageImages = [pageImage("page-1", 1)];
    project.processing.runs = [{
      runId: "run-1",
      pageImageId: "page-1",
      source: "automatic_pipeline",
      status: "completed",
      sourceSha256: "a".repeat(64),
      appVersion: "0.1.0",
      queuedAt: "2026-07-27T00:00:00.000Z"
    }];
    project.processing.assets = [processingAsset()];
    const manager = createProjectSessionManager();
    const created = manager.createProjectSession({
      project,
      filePath: "C:\\projects\\processing-assets.ctp"
    });

    expect(manager.getPageImageByStoredPath(
      created.projectSessionId,
      "Book-assets/results/asset-1.png"
    )).toEqual(expect.objectContaining({
      storedRelativePath: "Book-assets/results/asset-1.png"
    }));
    expect(() => manager.getPageImageByStoredPath(
      created.projectSessionId,
      "Book-assets/results/not-registered.png"
    )).toThrow(/unknown page image/i);
  });

  it("merges commit_batch_result into pending add_dialogue_line mutations for unsaved new lines", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Batch Pending", false);
    const created = manager.createProjectSession({ project });

    // Add a dialogue line via user mutation (not saved, stays in pendingUserMutations)
    const addResult = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: {
        type: "add_dialogue_line",
        input: {
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "新しい行",
          dialogueType: "speech"
        }
      }
    });
    expect(addResult.status).toBe("applied");
    const newLineId = addResult.project.project.dialogueLines[0]?.id;
    expect(newLineId).toBeDefined();

    // Commit batch result targeting the new (unpersisted) line
    const saveResult = await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: {
        type: "commit_batch_result",
        dialogueUpdates: [{
          id: newLineId!,
          aiTranslation: "새 행",
          lineStatus: "draft"
        }]
      }
    });

    // The new line should have the batch result in liveProject
    const live = saveResult.project.project;
    const updatedLine = live.dialogueLines.find((l) => l.id === newLineId);
    expect(updatedLine).toBeDefined();
    expect(updatedLine!.aiTranslation).toBe("새 행");
    expect(updatedLine!.lineStatus).toBe("draft");
    expect(updatedLine!.sourceText).toBe("新しい行");
  });

  it("records field-level changedPaths in revision journal for commit_batch_result", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Field Paths", false);
    project.dialogueLines = [
      manualLine("line-a", 1, "行A"),
      manualLine("line-b", 2, "行B")
    ];
    const created = manager.createProjectSession({ project });

    await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: {
        type: "commit_batch_result",
        dialogueUpdates: [
          { id: "line-a", aiTranslation: "번역A" },
          { id: "line-b", aiTranslation: "번역B", typesetting: { bbox: { x: 0, y: 0, width: 0.5, height: 0.2 }, writingMode: "horizontal-tb" } }
        ]
      }
    });

    // Now add a user mutation to line-a's sourceText (different field)
    const mutResult = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision + 1,
      mutation: {
        type: "update_dialogue_line",
        lineId: "line-a",
        patch: { sourceText: "新しいA" }
      }
    });

    // Should NOT conflict because batch changed aiTranslation, user changed sourceText
    expect(mutResult.status).toBe("applied");
  });

  it("returns explicit false field results when every requested batch field is stale", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Batch stale result", false);
    project.dialogueLines = [manualLine("line-stale", 1, "元の原文")];
    const created = manager.createProjectSession({ project });
    const initialProject = created.project.project;
    const expectedTranslationFingerprint = computeTranslationContextFingerprint({
      dialogueLines: initialProject.dialogueLines,
      targetLineId: "line-stale",
      characters: initialProject.characters,
      dictionaryTerms: initialProject.dictionaryTerms,
      stylePreset: "informal"
    });

    const mutation = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: {
        type: "update_dialogue_line",
        lineId: "line-stale",
        patch: { sourceText: "사용자가 바꾼 원문" }
      }
    });
    expect(mutation.status).toBe("applied");

    const result = await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: {
        type: "commit_batch_result",
        speechStylePreset: "informal",
        dialogueUpdates: [{
          id: "line-stale",
          aiTranslation: "stale proposal",
          expectedTranslationFingerprint,
          stylePreset: "informal"
        }]
      }
    });

    expect(result.appliedDialogueUpdates).toEqual([{
      id: "line-stale",
      appliedTranslation: false,
      appliedTypesetting: false
    }]);
    expect(result.staleLineIds).toEqual(["line-stale"]);
    expect(result.project.project.dialogueLines[0]?.aiTranslation).toBeUndefined();
  });

  it("applies a valid translation while rejecting stale typesetting at field level", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Batch partial field result", false);
    project.pageImages = [pageImage("page-1", 1)];
    project.dialogueLines = [{
      ...manualLine("line-partial", 1, "対象の原文"),
      userTranslation: "사용자 확정 번역",
      typesetting: {
        bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
        writingMode: "horizontal-tb"
      }
    }];
    const created = manager.createProjectSession({ project });
    const initialProject = created.project.project;
    const initialLine = initialProject.dialogueLines[0]!;
    const expectedTranslationFingerprint = computeTranslationContextFingerprint({
      dialogueLines: initialProject.dialogueLines,
      targetLineId: initialLine.id,
      characters: initialProject.characters,
      dictionaryTerms: initialProject.dictionaryTerms,
      stylePreset: "informal"
    });
    const expectedTypesettingFingerprint = computeTypesettingContextFingerprint(initialLine);

    const mutation = await manager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: {
        type: "update_dialogue_typesetting",
        lineId: initialLine.id,
        typesetting: {
          bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.15 },
          writingMode: "horizontal-tb"
        }
      }
    });
    expect(mutation.status).toBe("applied");

    const now = "2026-08-28T09:00:00.000Z";
    let queue = createProcessingQueue({
      queueId: "queue-partial",
      projectSessionId: created.projectSessionId,
      pageImageIds: ["page-1"],
      revision: created.project.revision,
      now
    });
    queue = startProcessingQueue(queue, { now });

    const result = await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: {
        type: "commit_batch_result",
        speechStylePreset: "informal",
        dialogueUpdates: [{
          id: initialLine.id,
          aiTranslation: "AI 번역 제안",
          typesetting: {
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
            writingMode: "horizontal-tb",
            fontSizeRatio: 0.08
          },
          expectedTranslationFingerprint,
          expectedTypesettingFingerprint,
          stylePreset: "informal"
        }],
        queue
      }
    });

    expect(result.appliedDialogueUpdates).toEqual([{
      id: initialLine.id,
      appliedTranslation: true,
      appliedTypesetting: false
    }]);
    expect(result.staleLineIds).toEqual([initialLine.id]);
    expect(result.project.project.dialogueLines[0]?.aiTranslation).toBe("AI 번역 제안");
    expect(result.project.project.dialogueLines[0]?.typesetting?.bbox).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.3,
      height: 0.15
    });
    expect(result.project.project.processing.queue?.pages[0]).toMatchObject({
      status: "failed",
      stage: "typesetting",
      error: {
        code: "BATCH_STALE_CONTEXT_DISCARDED",
        stage: "typesetting"
      }
    });
  });

  it("atomically grants only one concurrent Batch queue acquisition", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Concurrent Batch acquisition", false);
    project.pageImages = [pageImage("page-1", 1)];
    const created = manager.createProjectSession({ project });

    const results = await Promise.allSettled([
      manager.acquireBatchProcessingQueue({
        projectSessionId: created.projectSessionId,
        queueId: "queue-concurrent-a",
        targetPages: "all",
        initialStage: "translation",
        now: "2026-08-28T10:00:00.000Z"
      }),
      manager.acquireBatchProcessingQueue({
        projectSessionId: created.projectSessionId,
        queueId: "queue-concurrent-b",
        targetPages: "all",
        initialStage: "translation",
        now: "2026-08-28T10:00:00.001Z"
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(manager.getProject(created.projectSessionId).project.processing.queue?.queueId)
      .toBe("queue-concurrent-a");
  });

  it.each(["running", "paused"] as const)(
    "does not overwrite an existing %s queue when a Batch tries to acquire the session",
    async (status) => {
      const manager = createProjectSessionManager();
      const project = createEmptyProject(`Existing ${status} queue`, false);
      project.pageImages = [pageImage("page-1", 1)];
      const created = manager.createProjectSession({ project });
      const acquired = await manager.acquireBatchProcessingQueue({
        projectSessionId: created.projectSessionId,
        queueId: `queue-existing-${status}`,
        targetPages: "all",
        initialStage: "translation",
        now: "2026-08-28T10:01:00.000Z"
      });
      if (status === "paused" && acquired.queue) {
        await manager.commitMainProjectPatch({
          projectSessionId: created.projectSessionId,
          patch: {
            type: "update_processing_queue",
            queue: {
              ...acquired.queue,
              status: "paused",
              pages: acquired.queue.pages.map((page, index) =>
                index === 0 ? { ...page, status: "paused" as const } : page
              )
            }
          }
        });
      }

      await expect(manager.acquireBatchProcessingQueue({
        projectSessionId: created.projectSessionId,
        queueId: "queue-must-not-replace",
        targetPages: "all",
        initialStage: "typesetting",
        now: "2026-08-28T10:01:01.000Z"
      })).rejects.toThrow(/실행 중이거나 일시정지된 처리 큐/);
      expect(manager.getProject(created.projectSessionId).project.processing.queue?.queueId)
        .toBe(`queue-existing-${status}`);
    }
  );

  it("holds a session Batch lease even when the project has no page images", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Dialogue-only Batch lease", false);
    project.dialogueLines = [manualLine("line-only", 1, "こんにちは")];
    const created = manager.createProjectSession({ project });

    const first = await manager.acquireBatchProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: "lease-dialogue-a",
      targetPages: "all",
      initialStage: "translation",
      now: "2026-08-29T00:00:00.000Z"
    });

    expect(first.queue).toBeUndefined();
    await expect(manager.acquireBatchProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: "lease-dialogue-b",
      targetPages: "all",
      initialStage: "translation",
      now: "2026-08-29T00:00:00.001Z"
    })).rejects.toThrow(/Batch/);
    expect(manager.releaseBatchProcessingLease(created.projectSessionId, first.leaseId)).toBe(true);
    const third = await manager.acquireBatchProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: "lease-dialogue-c",
      targetPages: "all",
      initialStage: "translation",
      now: "2026-08-29T00:00:00.002Z"
    });
    expect(third.leaseId).toBe("lease-dialogue-c");
    expect(third.queue).toBeUndefined();
  });

  it("checks no-op controls inside the existing queue and preserves terminal revisions", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("serialized controls", false);
    project.pageImages = [pageImage("page-1", 1)];
    const created = manager.createProjectSession({ project });
    await manager.acquireBatchProcessingQueue({ projectSessionId: created.projectSessionId,
      queueId: "serialized-controls", targetPages: "all", initialStage: "translation", now: "2026-10-18T00:00:00.000Z" });
    await manager.controlBatchProcessingQueue({ projectSessionId: created.projectSessionId,
      queueId: "serialized-controls", action: "pause", now: "2026-10-18T00:00:01.000Z" });
    const cancel = manager.controlBatchProcessingQueue({ projectSessionId: created.projectSessionId,
      queueId: "serialized-controls", action: "cancel", now: "2026-10-18T00:00:02.000Z" });
    // This pause is enqueued while the currently visible snapshot is still paused.
    const latePause = manager.controlBatchProcessingQueue({ projectSessionId: created.projectSessionId,
      queueId: "serialized-controls", action: "pause", now: "2026-10-18T00:00:03.000Z" });
    const [canceled, paused] = await Promise.all([cancel, latePause]);
    expect(paused.project).toEqual(canceled.project);
    expect(paused.project.project.processing.queue?.status).toBe("cancelled");
    const again = await manager.controlBatchProcessingQueue({ projectSessionId: created.projectSessionId,
      queueId: "serialized-controls", action: "cancel", now: "2026-10-18T00:00:04.000Z" });
    expect(again.project).toEqual(canceled.project);
  });

  it("does not save or revise a completed queue for pause/cancel", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("completed no-op", false);
    project.pageImages = [pageImage("page-1", 1)];
    const created = manager.createProjectSession({ project });
    const acquired = await manager.acquireBatchProcessingQueue({ projectSessionId: created.projectSessionId,
      queueId: "completed-controls", targetPages: "all", initialStage: "translation", now: "2026-10-18T00:00:00.000Z" });
    const queue = structuredClone(acquired.queue!);
    queue.status = "completed"; queue.pages[0]!.status = "completed"; queue.pages[0]!.stage = "completed";
    const completed = await manager.commitMainProjectPatch({ projectSessionId: created.projectSessionId,
      patch: { type: "update_processing_queue", queue } });
    for (const action of ["pause", "cancel"] as const) {
      const controlled = await manager.controlBatchProcessingQueue({ projectSessionId: created.projectSessionId,
        queueId: queue.queueId, action, now: "2026-10-18T01:00:00.000Z" });
      expect(controlled.project).toEqual(completed.project);
    }
  });

  it("rejects an older progress write after the same queue was paused", async () => {
    const manager = createProjectSessionManager();
    const project = createEmptyProject("Queue generation guard", false);
    project.pageImages = [pageImage("page-1", 1)];
    const created = manager.createProjectSession({ project });
    const acquired = await manager.acquireBatchProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: "queue-generation",
      targetPages: "all",
      initialStage: "translation",
      now: "2026-08-29T00:01:00.000Z"
    });
    const staleQueue = structuredClone(acquired.queue!);
    const staleToken = processingQueueConcurrencyToken(staleQueue);

    await manager.controlBatchProcessingQueue({
      projectSessionId: created.projectSessionId,
      queueId: staleQueue.queueId,
      action: "pause",
      reason: "pause wins",
      now: "2026-08-29T00:01:01.000Z"
    });

    staleQueue.lastUpdatedAt = "2026-08-29T00:01:02.000Z";
    await expect(manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: {
        type: "update_processing_queue",
        queue: staleQueue,
        expectedQueueId: staleQueue.queueId,
        expectedQueueToken: staleToken
      }
    })).rejects.toThrow("BATCH_PROCESSING_QUEUE_CHANGED");
    expect(manager.getProject(created.projectSessionId).project.processing.queue?.status).toBe("paused");
  });
});

function manualLine(id: string, order: number, sourceText: string) {
  return {
    id,
    order,
    pageNumber: 1,
    dialogueType: "speech" as const,
    lineStatus: "untranslated" as const,
    sourceLanguage: "ja" as const,
    sourceText,
    parseConfidence: 1,
    parseWarnings: [],
    origin: { kind: "manual" as const }
  };
}

function pageImage(id: string, pageNumber: number) {
  return {
    id,
    pageNumber,
    storedRelativePath: `Book-assets/images/page-${String(pageNumber).padStart(3, "0")}.png`,
    originalFileName: `page-${pageNumber}.png`,
    sha256: id === "persisted-page" || id === "page-1" ? "a".repeat(64) : "b".repeat(64),
    byteSize: 4,
    mimeType: "image/png",
    copiedAt: "2026-08-03T00:00:00.000Z"
  };
}

function pipelineLine(
  id: string,
  order: number,
  sourceText: string,
  persistentRegionId: string,
  readingIndex: number
) {
  return {
    ...manualLine(id, order, sourceText),
    origin: {
      kind: "pipeline" as const,
      persistentRegionId,
      latestRunId: "run-1",
      latestRegionId: persistentRegionId,
      pageImageId: "page-1",
      candidateIds: [],
      readingIndex,
      sourceFingerprint: `fingerprint-${persistentRegionId}`
    }
  };
}

function processingPatch() {
  return {
    type: "commit_processing_run" as const,
    run: {
      runId: "run-1",
      pageImageId: "page-1",
      source: "automatic_pipeline" as const,
      status: "completed" as const,
      sourceSha256: "a".repeat(64),
      appVersion: "0.1.0",
      queuedAt: "2026-07-27T00:00:00.000Z"
    },
    pageRecord: {
      pageImageId: "page-1",
      latestCompletedRunId: "run-1",
      finalStatus: "needs_review" as const,
      updatedAt: "2026-07-27T00:00:00.000Z"
    },
    assets: []
  };
}

function processingAsset(overrides: Partial<{
  assetId: string;
  source: "automatic_pipeline" | "manual_openai";
  sourcePageImageId: string;
  runId: string;
  role: "cleaned";
}> = {}) {
  return {
    assetId: "asset-1",
    source: "automatic_pipeline" as const,
    sourcePageImageId: "page-1",
    runId: "run-1",
    role: "cleaned" as const,
    storedRelativePath: "Book-assets/results/asset-1.png",
    sha256: "c".repeat(64),
    byteSize: 4,
    mimeType: "image/png" as const,
    createdAt: "2026-07-27T00:00:00.000Z",
    ...overrides
  };
}

function sequenceIds(...values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error(`Missing test id at index ${index}`);
    index += 1;
    return value;
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
