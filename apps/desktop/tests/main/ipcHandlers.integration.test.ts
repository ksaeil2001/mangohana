import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { registerIpcHandlers } from "../../src/main/ipcHandlers";
import {
  createPendingPageImageImportManager,
  importJournalPath
} from "../../src/main/pendingPageImageImports";
import { createProjectSessionManager } from "../../src/main/projectSessions";
import { loadProjectFile, saveProjectFile } from "../../src/main/projectStorage";
import { createRecentProjectRegistry } from "../../src/main/recentProjects";
import { createProviderSettingsStore } from "../../src/main/providerSettingsStore";
import { createBatchExecutionCoordinator } from "../../src/main/batch/batchExecutionCoordinator";
import type { TranslationEngineRegistry } from "../../src/main/translation/translationEngineRegistry";
import type { ProductionOcrService } from "../../src/main/productionOcrService.js";
import type { GeminiApiKeyStore } from "../../src/main/geminiApiKeyStore.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";
import {
  createProcessingQueue,
  failProcessingQueuePage,
  pauseProcessingQueue,
  startProcessingQueue,
  type BatchProgressEvent,
  type ProcessingQueueControlResult
} from "../../src/shared/processingQueue";
import { computeTranslationContextFingerprint } from "../../src/shared/translationContext";
import { buildRenderReadinessReport } from "../../src/shared/renderReadiness";
import type { ProjectImageExportResult } from "../../src/main/projectImageExport";

type IpcHandler = (_event: unknown, args?: unknown) => Promise<unknown>;
type ProtocolHandler = (request: { url: string }) => Promise<Response>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  protocolHandlers: new Map<string, ProtocolHandler>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  protocolHandle: vi.fn((scheme: string, handler: ProtocolHandler) => {
    electronMocks.protocolHandlers.set(scheme, handler);
  }),
  netFetch: vi.fn(),
  nativeImageToPNG: vi.fn(),
  nativeImageCrop: vi.fn(),
  nativeImageGetSize: vi.fn(),
  nativeImageCreateFromBuffer: vi.fn(),
  handle: vi.fn((channel: string, handler: IpcHandler) => {
    electronMocks.handlers.set(channel, handler);
  })
}));

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showSaveDialog: electronMocks.showSaveDialog
  },
  ipcMain: {
    handle: electronMocks.handle
  },
  protocol: {
    handle: electronMocks.protocolHandle
  },
  nativeImage: {
    createFromBuffer: electronMocks.nativeImageCreateFromBuffer
  },
  net: {
    fetch: electronMocks.netFetch
  }
}));

let tempDir: string;
let geminiApiKeyStore: {
  initialize: Mock<GeminiApiKeyStore["initialize"]>;
  getStatus: Mock<GeminiApiKeyStore["getStatus"]>;
  set: Mock<GeminiApiKeyStore["set"]>;
  clear: Mock<GeminiApiKeyStore["clear"]>;
};
let productionOcrExecute: Mock<ProductionOcrService["execute"]>;
let productionOcrService: ProductionOcrService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dialogue-editor-ipc-"));
  electronMocks.handlers.clear();
  electronMocks.showOpenDialog.mockReset();
  electronMocks.showSaveDialog.mockReset();
  electronMocks.protocolHandle.mockClear();
  electronMocks.netFetch.mockReset();
  electronMocks.nativeImageToPNG.mockReset();
  electronMocks.nativeImageCrop.mockReset();
  electronMocks.nativeImageGetSize.mockReset();
  electronMocks.nativeImageCreateFromBuffer.mockReset();
  electronMocks.nativeImageGetSize.mockReturnValue({ width: 100, height: 80 });
  electronMocks.nativeImageToPNG.mockReturnValue(Buffer.from([1, 2, 3, 4]));
  electronMocks.nativeImageCreateFromBuffer.mockImplementation(() => ({
    getSize: electronMocks.nativeImageGetSize,
    toPNG: electronMocks.nativeImageToPNG,
    resize: vi.fn(() => ({
      getSize: electronMocks.nativeImageGetSize,
      toPNG: electronMocks.nativeImageToPNG
    }))
  }));
  electronMocks.handle.mockClear();
  geminiApiKeyStore = {
    initialize: vi.fn<GeminiApiKeyStore["initialize"]>(),
    getStatus: vi.fn<GeminiApiKeyStore["getStatus"]>(() => ({
      configured: false,
      source: "none",
      persistence: "encrypted",
      requiresReentry: false
    })),
    set: vi.fn<GeminiApiKeyStore["set"]>(),
    clear: vi.fn<GeminiApiKeyStore["clear"]>()
  };
  productionOcrExecute = vi.fn<ProductionOcrService["execute"]>().mockResolvedValue(emptyExtractionFixture());
  productionOcrService = productionOcrServiceFixture(productionOcrExecute);
  registerIpcHandlers({
    geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
    productionOcrService
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ipc handler integration", () => {
  it("routes explicit cleaned review through the owner guard and rejects another renderer", async () => {
    const manager = createProjectSessionManager();
    registerIpcHandlers({ geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore, projectSessionManager: manager });
    const created = await invoke("project:createSession", { title: "review boundary", secret: false }, 41) as { projectSessionId: string };
    const review = vi.spyOn(manager, "reviewCleanedAsset").mockImplementation(async (_args, assertOwner) => {
      assertOwner!();
      return { projectSessionId: created.projectSessionId, project: manager.getProject(created.projectSessionId) };
    });
    const args = { projectSessionId: created.projectSessionId, pageImageId: "page-1", cleanedAssetId: "asset-1", expectedRevision: 7 };
    await expect(invoke("project:reviewCleanedAsset", args, 42)).rejects.toThrow(/belongs to another renderer/);
    expect(review).not.toHaveBeenCalled();
    await invoke("project:reviewCleanedAsset", args, 41);
    expect(review).toHaveBeenCalledExactlyOnceWith(args, expect.any(Function));
    await manager.disposeAll();
  });

  it("uses the current snapshot after the export folder dialog completes", async () => {
    const manager = createProjectSessionManager();
    registerIpcHandlers({ geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore, projectSessionManager: manager });
    const created = await invoke("project:createSession", { title: "export boundary", secret: false }, 41) as { projectSessionId: string };
    await manager.saveProjectAs({ projectSessionId: created.projectSessionId, filePath: join(tempDir, "export.ctp") });
    electronMocks.showSaveDialog.mockImplementationOnce(async () => {
      await manager.applyProjectMutation({ projectSessionId: created.projectSessionId, baseRevision: 0, mutation: { type: "set_project_title", title: "during dialog" } });
      return { canceled: false, filePath: join(tempDir, "output") };
    });
    const result = await invoke("project:exportImages", { projectSessionId: created.projectSessionId }, 41) as { manifest: { projectRevision: number } };
    expect(result.manifest.projectRevision).toBe(1);
    await manager.disposeAll();
  });

  it.each(["review-invalidation", "source-replacement"] as const)("keeps the current original and blocks cleaned/stale typeset after %s during the folder dialog", async (change) => {
    const manager = createProjectSessionManager();
    const font = { identity: "isolated-font", resourceAvailable: true, metricsCalculated: true, glyphCoverageVerified: true };
    const verifyFont = vi.fn(async () => true);
    registerIpcHandlers({ geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager: manager, verifyInstalledTypesetFontResource: verifyFont });
    const projectFilePath = join(tempDir, "Project.ctp");
    const project = normalizeProject(createEmptyProject("실제 페이지 출력 경계", false));
    const sourceBytes = Buffer.from([1, 2, 3, 4]);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const timestamp = "2026-10-29T00:00:00.000Z";
    const page = pageImageFixture();
    project.pageImages = [page];
    project.processing = {
      pages: [{ pageImageId: page.id, approvedCleanedAssetId: "cleaned-1", userReviewedCleanedAssetId: "cleaned-1",
        latestCompletedRunId: "run-1", finalStatus: "auto_approved", updatedAt: timestamp }],
      runs: [{ runId: "run-1", pageImageId: page.id, source: "manual_local_edit", status: "completed",
        sourceSha256: page.sha256, appVersion: "isolated", queuedAt: timestamp }],
      assets: [{ assetId: "cleaned-1", sourcePageImageId: page.id, runId: "run-1", source: "manual_local_edit", role: "cleaned",
        storedRelativePath: "Project-assets/images/cleaned.png", sha256: hash(pngBytes), byteSize: pngBytes.length,
        mimeType: "image/png", createdAt: timestamp, inpaintingQa: { qaStatus: "pass", cleanlinessScore: 1,
          residualRegions: [], attemptCount: 1, maxRetryAttempts: 2, evaluatedAt: timestamp } }]
    };
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, page.storedRelativePath), sourceBytes);
    await writeFile(join(tempDir, project.processing.assets[0]!.storedRelativePath), pngBytes);
    await saveProjectFile({ filePath: projectFilePath, project });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [projectFilePath] });
    const opened = await invoke("project:openFromDialog", undefined, 41) as { projectSessionId: string };
    const before = manager.getProject(opened.projectSessionId);
    const readiness = buildRenderReadinessReport({ pageImageId: page.id, revision: before.revision,
      resultRevision: before.revision, lines: [], font, approvedCleanedAssetId: "cleaned-1", cleanedAssetQaStatus: "pass" });
    expect(readiness.ready).toBe(true);
    let dialogOpened!: () => void;
    const waitingForDialog = new Promise<void>((resolve) => { dialogOpened = resolve; });
    let releaseDialog!: (selection: { canceled: boolean; filePath: string }) => void;
    const selection = new Promise<{ canceled: boolean; filePath: string }>((resolve) => { releaseDialog = resolve; });
    electronMocks.showSaveDialog.mockImplementationOnce(() => { dialogOpened(); return selection; });
    const exportRoot = join(tempDir, "exported");
    const pendingExport = invoke("project:exportImages", { projectSessionId: opened.projectSessionId,
      typesetPages: [{ pageImageId: page.id, pngBase64: pngBytes.toString("base64"), readiness }] }, 41);
    try {
      await waitingForDialog;
      let expectedOriginal = sourceBytes;
      if (change === "review-invalidation") {
        await manager.commitMainProjectPatch({ projectSessionId: opened.projectSessionId, patch: {
          type: "commit_processing_run", run: project.processing.runs[0]!, assets: project.processing.assets,
          pageRecord: project.processing.pages[0]!
        } });
      } else {
        expectedOriginal = Buffer.from("replacement original");
        const replacement = { ...page, storedRelativePath: "Project-assets/images/replacement.png",
          sha256: hash(expectedOriginal), byteSize: expectedOriginal.length };
        await writeFile(join(tempDir, replacement.storedRelativePath), expectedOriginal);
        await manager.registerImportedPageImages({ projectSessionId: opened.projectSessionId, pageImages: [replacement] });
      }
      const current = manager.getProject(opened.projectSessionId);
      expect(current.revision).toBeGreaterThan(before.revision);
      expect(current.project.processing.pages[0]?.userReviewedCleanedAssetId).toBeUndefined();
      releaseDialog({ canceled: false, filePath: exportRoot });
      const result = await pendingExport as ProjectImageExportResult;
      expect(verifyFont).toHaveBeenCalledWith(font.identity);
      expect(result.manifest.projectRevision).toBe(current.revision);
      expect(result.report.status).toBe("partial");
      expect(result.report.files.map((file) => file.kind)).toEqual(["original"]);
      expect(result.report.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "cleaned" }), expect.objectContaining({ kind: "typeset", code: "TYPESET_NOT_RENDER_READY" })
      ]));
      expect(await readFile(join(exportRoot, result.report.files[0]!.outputPath))).toEqual(expectedOriginal);
      expect(await readdir(join(exportRoot, "cleaned"))).toEqual([]);
      expect(await readdir(join(exportRoot, "typeset"))).toEqual([]);
      expect(await readFile(join(tempDir, page.storedRelativePath))).toEqual(sourceBytes);
    } finally {
      releaseDialog({ canceled: true, filePath: exportRoot });
      await pendingExport;
      await manager.disposeAll();
    }
  });

  it("rejects export if the owner disconnects during the folder dialog", async () => {
    const manager = createProjectSessionManager();
    const lifecycle = registerIpcHandlers({ geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore, projectSessionManager: manager });
    const created = await invoke("project:createSession", { title: "export owner", secret: false }, 41) as { projectSessionId: string };
    await manager.saveProjectAs({ projectSessionId: created.projectSessionId, filePath: join(tempDir, "owner.ctp") });
    electronMocks.showSaveDialog.mockImplementationOnce(async () => {
      await lifecycle.cleanupRenderer(41);
      return { canceled: false, filePath: join(tempDir, "output") };
    });
    await expect(invoke("project:exportImages", { projectSessionId: created.projectSessionId }, 41)).rejects.toThrow(/no longer active/);
    expect(await readdir(tempDir)).toEqual(["owner.ctp"]);
  });

  it("cancels manual OCR through the Main AbortSignal and releases the request ID", async () => {
    const projectFilePath = join(tempDir, "Project.ctp");
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));
    let providerSignal: AbortSignal | undefined;
    const projectSessionManager = createProjectSessionManager();
    const created = createSavedOcrSession(projectSessionManager, projectFilePath);
    const execute = vi.fn<ProductionOcrService["execute"]>((request) => new Promise<never>((_resolve, reject) => {
      providerSignal = request.signal;
      providerSignal?.addEventListener("abort", () => reject(providerSignal?.reason ?? new DOMException("aborted", "AbortError")), { once: true });
    }));
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager,
      productionOcrService: productionOcrServiceFixture(execute)
    });

    const pending = invoke("project:extractSpeechBubbles", {
      requestId: "manual-ocr-1",
      projectSessionId: created.projectSessionId,
      pageImageId: pageImageFixture().id,
      sourceSha256: pageImageFixture().sha256
    });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    await expect(invoke("project:extractSpeechBubbles", {
      requestId: "manual-ocr-1",
      projectSessionId: created.projectSessionId,
      pageImageId: pageImageFixture().id,
      sourceSha256: pageImageFixture().sha256
    })).rejects.toThrow(/already active/);
    await expect(invoke("project:cancelSpeechBubbleOcr", { requestId: "manual-ocr-1" })).resolves.toEqual({ canceled: true });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
    await expect(invoke("project:cancelSpeechBubbleOcr", { requestId: "manual-ocr-1" })).resolves.toEqual({ canceled: false });
  });

  it("cancels manual inpainting through the registry AbortSignal", async () => {
    const projectFilePath = join(tempDir, "Project.ctp");
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));
    let providerSignal: AbortSignal | undefined;
    const execute = vi.fn((_provider: unknown, request: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      providerSignal = request.signal;
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason ?? new DOMException("aborted", "AbortError")), { once: true });
    }));
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      inpaintingEngineRegistry: { execute } as never
    });

    const pending = invoke("project:inpaintPageImage", {
      requestId: "manual-inpaint-1",
      projectFilePath,
      pageImage: pageImageFixture(),
      maskPngBase64: Buffer.from("mask").toString("base64"),
      mode: "speech-bubble",
      provider: "local-lama"
    });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    await expect(invoke("project:cancelInpainting", { requestId: "manual-inpaint-1" })).resolves.toEqual({ canceled: true });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
  });

  it("passes a requestId AbortSignal to translation and cancels the active Provider call", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = createEmptyProject("Cancelable translation", false);
    project.dialogueLines = [{
      id: "cancel-line",
      order: 1,
      pageNumber: 1,
      sourceLanguage: "ja",
      sourceText: "原文",
      dialogueType: "speech",
      lineStatus: "untranslated",
      parseConfidence: 1,
      parseWarnings: [],
      origin: { kind: "manual" }
    }];
    const created = projectSessionManager.createProjectSession({ project });
    let providerSignal: AbortSignal | undefined;
    const executeTranslation = vi.fn((_payload: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      providerSignal = options?.signal;
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager,
      translationEngineRegistry: {
        registerAdapter: vi.fn(), getAdapter: vi.fn(), listAdapters: vi.fn(), executeTranslation
      }
    });

    const pending = invoke("translation:execute", {
      projectSessionId: created.projectSessionId,
      targetLineId: "cancel-line",
      requestId: "single-request-1"
    });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    await expect(invoke("translation:execute", {
      projectSessionId: created.projectSessionId,
      targetLineId: "cancel-line",
      requestId: "single-request-1"
    })).rejects.toThrow(/already active/);
    await expect(invoke("translation:execute", {
      projectSessionId: created.projectSessionId,
      targetLineId: "cancel-line",
      requestId: "   "
    })).rejects.toThrow(/non-empty string/);
    await expect(invoke("translation:cancel", { requestId: "single-request-1" })).resolves.toEqual({ canceled: true });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
    expect(executeTranslation).toHaveBeenCalledOnce();
  });

  it("commits a fingerprint-matched AI proposal without changing user-owned translation fields", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = createEmptyProject("Proposal commit", false);
    project.dialogueLines = [{
      id: "proposal-line",
      order: 1,
      pageNumber: 1,
      sourceLanguage: "ja",
      sourceText: "原文",
      dialogueType: "speech",
      lineStatus: "complete",
      userTranslation: "사용자 번역",
      parseConfidence: 1,
      parseWarnings: [],
      origin: { kind: "manual" }
    }];
    const created = projectSessionManager.createProjectSession({ project });
    registerIpcHandlers({ geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore, projectSessionManager });
    const fingerprint = computeTranslationContextFingerprint({
      dialogueLines: project.dialogueLines,
      targetLineId: "proposal-line",
      characters: project.characters,
      dictionaryTerms: project.dictionaryTerms,
      stylePreset: "literal"
    });

    const committed = await invoke("translation:commitProposal", {
      projectSessionId: created.projectSessionId,
      targetLineId: "proposal-line",
      proposal: "AI 제안",
      expectedTranslationFingerprint: fingerprint,
      stylePreset: "literal"
    }) as { project: { project: typeof project }; appliedDialogueUpdates: Array<{ appliedTranslation: boolean }> };

    expect(committed.appliedDialogueUpdates).toEqual([expect.objectContaining({ appliedTranslation: true })]);
    expect(committed.project.project.dialogueLines[0]).toMatchObject({
      aiTranslation: "AI 제안",
      userTranslation: "사용자 번역",
      lineStatus: "complete"
    });
  });

  it("returns the fingerprint of the exact session payload sent to the translation Provider", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = createEmptyProject("Fingerprint translation", false);
    project.dialogueLines = [{
      id: "fingerprint-line", order: 1, pageNumber: 1, sourceLanguage: "ja", sourceText: "原文",
      dialogueType: "speech", lineStatus: "untranslated", parseConfidence: 1, parseWarnings: [], origin: { kind: "manual" }
    }];
    const created = projectSessionManager.createProjectSession({ project });
    const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "번역", engine: "test" });
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager,
      translationEngineRegistry: {
        registerAdapter: vi.fn(), getAdapter: vi.fn(), listAdapters: vi.fn(), executeTranslation
      }
    });

    const result = await invoke("translation:execute", {
      projectSessionId: created.projectSessionId,
      targetLineId: "fingerprint-line",
      requestId: "fingerprint-request",
      stylePreset: "literal"
    }) as { contextFingerprint: string };

    expect(result.contextFingerprint).toBe(computeTranslationContextFingerprint({
      dialogueLines: project.dialogueLines,
      targetLineId: "fingerprint-line",
      characters: project.characters,
      dictionaryTerms: project.dictionaryTerms,
      stylePreset: "literal"
    }));
  });

  it("runs a failed translation retry through the Main Batch executor", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = createEmptyProject("IPC queue retry", false);
    project.pageImages = [{
      id: "ipc-retry-page",
      pageNumber: 1,
      storedRelativePath: "pages/retry.png",
      originalFileName: "retry.png",
      sha256: "a".repeat(64),
      byteSize: 100,
      mimeType: "image/png",
      copiedAt: "2026-08-29T00:00:00.000Z"
    }];
    project.dialogueLines = [{
      id: "ipc-retry-line",
      order: 1,
      pageNumber: 1,
      sourceLanguage: "ja",
      sourceText: "原文",
      dialogueType: "speech",
      lineStatus: "untranslated",
      parseConfidence: 1,
      parseWarnings: [],
      origin: { kind: "manual" }
    }];
    const created = projectSessionManager.createProjectSession({ project });
    let queue = createProcessingQueue({
      queueId: "ipc-retry-queue",
      projectSessionId: created.projectSessionId,
      pageImageIds: ["ipc-retry-page"],
      revision: 0,
      now: "2026-08-29T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-29T00:00:01.000Z" });
    queue.pages[0]!.stage = "translation";
    queue = failProcessingQueuePage(queue, {
      pageImageId: "ipc-retry-page",
      revision: 0,
      now: "2026-08-29T00:00:02.000Z",
      error: {
        code: "BATCH_TRANSLATION_FAILED",
        message: "provider failed",
        retryable: true,
        stage: "translation"
      }
    });
    await projectSessionManager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: { type: "update_processing_queue", queue }
    });
    const executeTranslation = vi.fn().mockResolvedValue({ translatedText: "재시도 번역", engine: "test" });
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager,
      translationEngineRegistry: {
        registerAdapter: vi.fn(),
        getAdapter: vi.fn(),
        listAdapters: vi.fn(),
        executeTranslation
      }
    });

    const result = await invoke("project:updateProcessingQueue", {
      projectSessionId: created.projectSessionId,
      action: "retry",
      queueId: queue.queueId,
      pageImageId: "ipc-retry-page",
      revision: 0
    }) as { queue?: { status: string } };

    expect(executeTranslation).toHaveBeenCalledOnce();
    expect(result.queue?.status).toBe("completed");
    expect(projectSessionManager.getProject(created.projectSessionId).project.dialogueLines[0]?.aiTranslation)
      .toBe("재시도 번역");
  });

  it("rejects start on an idle processing queue that has no batch executor", async () => {
    const projectSessionManager = createProjectSessionManager();
    const project = createEmptyProject("Idle queue", false);
    project.pageImages = [{
      id: "idle-page",
      pageNumber: 1,
      storedRelativePath: "images/idle-page.png",
      originalFileName: "idle-page.png",
      sha256: "a".repeat(64),
      byteSize: 1,
      mimeType: "image/png",
      copiedAt: "2026-08-29T00:00:00.000Z"
    }];
    const created = projectSessionManager.createProjectSession({ project });
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager
    });
    await invoke("project:updateProcessingQueue", {
      projectSessionId: created.projectSessionId,
      action: "create",
      pageImageIds: ["idle-page"]
    });
    await expect(invoke("project:updateProcessingQueue", {
      projectSessionId: created.projectSessionId,
      action: "start"
    })).rejects.toThrow(/연결된 실행 작업이 없습니다/);
  });

  it("uses the Documents fallback for project dialogs until a project is successfully saved", async () => {
    const documentsDirectory = join(tempDir, "Documents");
    const recentProjectRegistry = createRecentProjectRegistry({
      createId: () => "recent-dialog-path",
      now: () => "2026-07-27T00:00:00.000Z"
    });
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      recentProjectRegistry,
      defaultProjectDirectory: documentsDirectory
    });

    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(invoke("project:openFromDialog")).resolves.toBeNull();
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: documentsDirectory
    }));
    expect(recentProjectRegistry.getLastProjectDirectory()).toBeNull();

    electronMocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: "" });
    await expect(invoke("project:chooseSaveFile", { defaultPath: "My: Manga?.ctp" })).resolves.toBeNull();
    expect(electronMocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: join(documentsDirectory, "My_ Manga_.ctp")
    }));
    expect(recentProjectRegistry.getLastProjectDirectory()).toBeNull();
  });

  it("uses an absolute configured project storage path for save dialogs without changing open-dialog recency", async () => {
    const documentsDirectory = join(tempDir, "Documents");
    const configuredDirectory = join(tempDir, "Configured Projects");
    const recentDirectory = join(tempDir, "Recent Projects");
    const recentProjectRegistry = createRecentProjectRegistry();
    recentProjectRegistry.remember(join(recentDirectory, "Recent.ctp"), "Recent");
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      recentProjectRegistry,
      providerSettingsStore: createProviderSettingsStore({ defaultStoragePath: configuredDirectory }),
      defaultProjectDirectory: documentsDirectory
    });

    electronMocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: "" });
    await invoke("project:chooseSaveFile", { defaultPath: "Book.ctp" });
    expect(electronMocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: join(configuredDirectory, "Book.ctp")
    }));

    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await invoke("project:openFromDialog");
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: recentDirectory
    }));
  });

  it("uses the last successful CTP directory for subsequent open and Save As dialogs", async () => {
    const documentsDirectory = join(tempDir, "Documents");
    const projectDirectory = join(tempDir, "projects", "manga");
    await mkdir(projectDirectory, { recursive: true });
    const recentProjectRegistry = createRecentProjectRegistry({
      createId: () => "recent-dialog-path",
      now: () => "2026-07-27T00:00:00.000Z"
    });
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      recentProjectRegistry,
      defaultProjectDirectory: documentsDirectory
    });

    const created = await invoke("project:createSession", {
      title: "My: Manga?",
      secret: false
    }) as { projectSessionId: string };
    const savedPath = join(projectDirectory, "My-Manga.ctp");
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: savedPath });

    const saved = await invoke("project:saveAs", { projectSessionId: created.projectSessionId }) as {
      recentProject: { recentProjectId: string };
    };
    expect(saved.recentProject.recentProjectId).toBe("recent-dialog-path");
    expect(recentProjectRegistry.getLastProjectDirectory()).toBe(projectDirectory);
    expect(electronMocks.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: join(documentsDirectory, "My_ Manga_.ctp")
    }));

    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(invoke("project:openFromDialog")).resolves.toBeNull();
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: projectDirectory
    }));
    expect(recentProjectRegistry.getLastProjectDirectory()).toBe(projectDirectory);
  });

  it("updates recent directory only after direct project save and open succeed", async () => {
    const documentsDirectory = join(tempDir, "Documents");
    const projectDirectory = join(tempDir, "direct");
    await mkdir(projectDirectory, { recursive: true });
    const recentProjectRegistry = createRecentProjectRegistry({
      createId: () => "recent-direct-project",
      now: () => "2026-07-27T00:00:00.000Z"
    });
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      recentProjectRegistry,
      defaultProjectDirectory: documentsDirectory
    });

    const projectFilePath = join(projectDirectory, "Direct.ctp");
    const project = createEmptyProject("Direct", false);
    await expect(invoke("project:save", { filePath: projectFilePath, project })).resolves.toBeUndefined();
    expect(recentProjectRegistry.getLastProjectDirectory()).toBe(projectDirectory);

    await expect(invoke("project:open", { filePath: projectFilePath })).resolves.toMatchObject({
      filePath: projectFilePath,
      project: { metadata: { title: "Direct" } }
    });
    expect(recentProjectRegistry.getLastProjectDirectory()).toBe(projectDirectory);

    const failedProjectFilePath = join(tempDir, "missing", "Failed.ctp");
    await expect(invoke("project:save", {
      filePath: failedProjectFilePath,
      project: createEmptyProject("Failed", false)
    })).rejects.toThrow();
    expect(recentProjectRegistry.getLastProjectDirectory()).toBe(projectDirectory);
  });

  it("returns and updates the Main-owned environment preparation snapshot", async () => {
    const initial = (await invoke("environment:getSnapshot")) as {
      resourceRoot: string;
      canOpenWorkbench: boolean;
    };

    expect(initial.resourceRoot).toMatch(/Trio[\\/]resources$/i);
    expect(initial.canOpenWorkbench).toBe(true);

    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [join(tempDir, "resources")]
    });
    const moved = (await invoke("environment:chooseResourceRoot")) as {
      resourceRoot: string;
    };

    expect(moved.resourceRoot).toBe(join(tempDir, "resources"));
  });

  it("creates, mutates, saves, reopens, and closes a project through session-only IPC", async () => {
    const filePath = join(tempDir, "session.ctp");
    const created = (await invoke("project:createSession", {
      title: "Session IPC",
      secret: false
    })) as {
      projectSessionId: string;
      project: { revision: number; project: { metadata: { title: string } }; dirty: boolean };
    };
    expect(JSON.stringify(created)).not.toContain(filePath);

    const changed = (await invoke("project:applyMutation", {
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: { type: "set_project_title", title: "Session IPC Edited" }
    })) as { status: string; project: { dirty: boolean } };
    expect(changed).toMatchObject({ status: "applied", project: { dirty: true } });

    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath });
    const saved = await invoke("project:saveAs", { projectSessionId: created.projectSessionId });
    expect(JSON.stringify(saved)).not.toContain(filePath);

    await invoke("project:close", { projectSessionId: created.projectSessionId });
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });
    const reopened = (await invoke("project:openFromDialog")) as {
      projectSessionId: string;
      project: { project: { metadata: { title: string } } };
    };
    expect(reopened.project.project.metadata.title).toBe("Session IPC Edited");
    expect(JSON.stringify(reopened)).not.toContain(filePath);
  });

  it("creates, unlocks, saves as, rekeys, and closes a secret project without exposing secrets or paths", async () => {
    const filePath = join(tempDir, "secret-session.ctp");
    const created = (await invoke("project:createSession", {
      title: "Secret Session",
      secret: true,
      password: "initial-password"
    })) as { projectSessionId: string; project: { revision: number } };
    expect(JSON.stringify(created)).not.toMatch(/initial-password|artifactMasterKey|containerKey|filePath/i);

    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath });
    const saved = await invoke("project:saveAs", {
      projectSessionId: created.projectSessionId
    });
    expect(JSON.stringify(saved)).not.toContain(filePath);
    expect(JSON.stringify(saved)).not.toMatch(/initial-password|artifactMasterKey|containerKey/i);
    await invoke("project:close", { projectSessionId: created.projectSessionId });

    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });
    const passwordRequired = (await invoke("project:openFromDialog")) as {
      unlockToken: string;
      passwordRequired: boolean;
    };
    expect(passwordRequired).toMatchObject({
      unlockToken: expect.any(String),
      passwordRequired: true
    });
    expect(JSON.stringify(passwordRequired)).not.toContain(filePath);

    const unlocked = (await invoke("project:unlock", {
      unlockToken: passwordRequired.unlockToken,
      password: "initial-password"
    })) as { projectSessionId: string };
    expect(JSON.stringify(unlocked)).not.toMatch(/initial-password|artifactMasterKey|containerKey|filePath/i);

    await invoke("project:rekey", {
      projectSessionId: unlocked.projectSessionId,
      newPassword: "replacement-password"
    });
    await invoke("project:close", { projectSessionId: unlocked.projectSessionId });

    const retryToken = (await invoke("project:openFromDialog")) as { unlockToken: string };
    await expect(
      invoke("project:unlock", {
        unlockToken: retryToken.unlockToken,
        password: "initial-password"
      })
    ).rejects.toThrow(/password/i);
    const replacementToken = (await invoke("project:openFromDialog")) as { unlockToken: string };
    const reopened = await invoke("project:unlock", {
      unlockToken: replacementToken.unlockToken,
      password: "replacement-password"
    });
    expect(JSON.stringify(reopened)).not.toMatch(/replacement-password|artifactMasterKey|containerKey|filePath/i);
  });

  it("keeps a recent secret unlock token retryable after an invalid password", async () => {
    const filePath = join(tempDir, "retry-secret.ctp");
    const created = await invoke("project:createSession", {
      title: "Retry Secret",
      secret: true,
      password: "correct-password"
    }, 61) as { projectSessionId: string };
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath });
    const saved = await invoke("project:saveAs", {
      projectSessionId: created.projectSessionId
    }, 61) as { recentProject: { recentProjectId: string } };
    await invoke("project:close", { projectSessionId: created.projectSessionId }, 61);

    const locked = await invoke("project:openRecent", {
      recentProjectId: saved.recentProject.recentProjectId
    }, 61) as { passwordRequired: true; unlockToken: string };
    const wrong = await invoke("project:unlock", {
      unlockToken: locked.unlockToken,
      password: "wrong-password"
    }, 61);
    expect(wrong).toEqual({
      openFailed: true,
      code: "INVALID_PASSWORD",
      retryable: true,
      message: "암호가 올바르지 않습니다. 다시 입력하세요."
    });

    await expect(invoke("project:unlock", {
      unlockToken: locked.unlockToken,
      password: "correct-password"
    }, 61)).resolves.toMatchObject({
      projectSessionId: expect.any(String),
      encrypted: true
    });
  });

  it("classifies unknown and missing recent projects without exposing their paths", async () => {
    const recentProjectRegistry = createRecentProjectRegistry();
    const missingPath = join(tempDir, "missing", "Gone.ctp");
    const missing = recentProjectRegistry.remember(missingPath, "Gone");
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      recentProjectRegistry
    });

    const unknown = await invoke("project:openRecent", { recentProjectId: "unknown" });
    const missingResult = await invoke("project:openRecent", {
      recentProjectId: missing.recentProjectId
    });
    expect(unknown).toMatchObject({ openFailed: true, code: "RECENT_NOT_FOUND", retryable: false });
    expect(missingResult).toMatchObject({ openFailed: true, code: "PROJECT_FILE_NOT_FOUND", retryable: false });
    expect(JSON.stringify([unknown, missingResult])).not.toContain(missingPath);
  });

  it("returns only the Gemini key status through IPC", async () => {
    geminiApiKeyStore.getStatus.mockReturnValue({
      configured: true,
      source: "encrypted",
      persistence: "encrypted",
      requiresReentry: false
    });

    const result = await invoke("project:getGeminiApiKeyStatus");

    expect(result).toEqual(geminiApiKeyStore.getStatus());
    expect(JSON.stringify(result)).not.toContain("test-secret-key");
  });

  it("validates and delegates Gemini key storage without returning the key", async () => {
    geminiApiKeyStore.set.mockResolvedValue({
      configured: true,
      source: "encrypted",
      persistence: "encrypted",
      requiresReentry: false
    });

    const result = await invoke("project:setGeminiApiKey", { apiKey: "  test-secret-key  " });

    expect(geminiApiKeyStore.set).toHaveBeenCalledWith("test-secret-key");
    expect(JSON.stringify(result)).not.toContain("test-secret-key");
  });

  it("keeps configured status when encrypted key deletion fails", async () => {
    geminiApiKeyStore.clear.mockRejectedValue(new Error("저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요."));

    await expect(invoke("project:clearGeminiApiKey")).rejects.toThrow("저장된 키를 삭제하지 못했습니다.");
    expect(geminiApiKeyStore.clear).toHaveBeenCalledOnce();
  });

  it("imports txt through the registered import handler", async () => {
    const txtPath = join(tempDir, "dialogue.txt");
    await writeFile(txtPath, "Mika: Hello there\nREF: 안녕", "utf8");
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [txtPath] });

    const result = (await invoke("project:importTxtFile")) as {
      filePath: string;
      lines: Array<{ speaker?: string; sourceText: string; referenceTranslation?: string }>;
    };

    expect(result.filePath).toBe(txtPath);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.speaker).toBe("Mika");
    expect(result.lines[0]?.sourceText).toBe("Hello there");
    expect(result.lines[0]?.referenceTranslation).toBe("안녕");
  });

  it("chooses save paths and round-trips normal projects through save/open handlers", async () => {
    const project = createEmptyProject("IPC Normal", false);
    project.dialogueLines.push({
      id: "line-ipc",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Source",
      userTranslation: "Edited",
      parseConfidence: 1,
      parseWarnings: [],
      origin: { kind: "manual" }
    });
    const filePath = join(tempDir, "normal.ctp");
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath });

    await expect(invoke("project:chooseSaveFile", { defaultPath: filePath })).resolves.toBe(filePath);
    await expect(invoke("project:save", { filePath, project })).resolves.toBeUndefined();

    const opened = (await invoke("project:open", { filePath })) as {
      filePath: string;
      encrypted: boolean;
      project: typeof project;
    };

    expect(opened.filePath).toBe(filePath);
    expect(opened.encrypted).toBe(false);
    expect(opened.project.metadata.title).toBe("IPC Normal");
    expect(opened.project.dialogueLines[0]?.userTranslation).toBe("Edited");
  });

  it("round-trips encrypted projects through save/open handlers", async () => {
    const project = createEmptyProject("IPC Secret", true);
    project.dialogueLines.push({
      id: "line-secret-ipc",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Hidden source",
      userTranslation: "Hidden edit",
      parseConfidence: 1,
      parseWarnings: [],
      origin: { kind: "manual" }
    });
    const filePath = join(tempDir, "secret.ctp");

    await invoke("project:save", { filePath, project, password: "ipc password" });
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("IPC Secret");
    expect(raw).not.toContain("Hidden source");
    await expect(invoke("project:open", { filePath, password: "wrong" })).rejects.toThrow(/password/i);

    const opened = (await invoke("project:open", { filePath, password: "ipc password" })) as {
      encrypted: boolean;
      project: typeof project;
    };

    expect(opened.encrypted).toBe(true);
    expect(opened.project.metadata.title).toBe("IPC Secret");
    expect(opened.project.dialogueLines[0]?.sourceText).toBe("Hidden source");
  });

  it("exports translated dialogue text through the registered export handler", async () => {
    const project = createEmptyProject("IPC Export", false);
    project.dialogueLines.push({
      id: "line-export",
      order: 1,
      pageNumber: 1,
      speaker: "Mika",
      position: "Panel 1",
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Source",
      userTranslation: "Edited",
      parseConfidence: 1,
      parseWarnings: [],
      origin: { kind: "manual" }
    });
    const filePath = join(tempDir, "translations.txt");
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath });

    await expect(invoke("project:exportTranslations", { defaultPath: filePath, project })).resolves.toBe(filePath);

    await expect(readFile(filePath, "utf8")).resolves.toContain("001\tMika\tPanel 1\tEdited");
  });

  it("exports the Main session snapshot and ignores Renderer project/path fields", async () => {
    const selectedPath = join(tempDir, "session-translations.txt");
    const forgedPath = join(tempDir, "forged-overwrite.txt");
    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: selectedPath
    });
    const created = await invoke("project:createSession", {
      title: "Session export",
      secret: false
    }) as { projectSessionId: string; project: { revision: number } };
    await invoke("project:applyMutation", {
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: {
        type: "add_dialogue_line",
        input: {
          pageNumber: 1,
          sourceLanguage: "en",
          sourceText: "Main source",
          dialogueType: "speech",
          userTranslation: "Main translation"
        }
      }
    });

    await expect(invoke("project:exportTranslations", {
      projectSessionId: created.projectSessionId,
      filePath: forgedPath,
      project: createEmptyProject("Forged", false)
    })).resolves.toBe(selectedPath);

    await expect(readFile(selectedPath, "utf8")).resolves.toContain("Main translation");
    await expect(readFile(forgedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("imports page images through the registered image handler", async () => {
    const sourcePath = join(tempDir, "scan_001.png");
    const projectFilePath = join(tempDir, "Book.ctp");
    await writeFile(sourcePath, Buffer.from([9, 8, 7, 6]));

    const result = (await invoke("project:importPageImages", {
      projectFilePath,
      files: [{ sourcePath, pageNumber: 3 }]
    })) as Array<{ ok: true; pageImage: { pageNumber: number; mimeType: string; byteSize: number } }>;

    expect(result).toHaveLength(1);
    expect(result[0]?.ok).toBe(true);
    expect(result[0]?.pageImage.pageNumber).toBe(3);
    expect(result[0]?.pageImage.mimeType).toBe("image/png");
    expect(result[0]?.pageImage.byteSize).toBe(4);
  });

  it("keeps ordered page asset imports moving after one source image fails", async () => {
    const firstPath = join(tempDir, "page-001.png");
    const missingPath = join(tempDir, "missing-page-002.png");
    const thirdPath = join(tempDir, "page-003.webp");
    const projectFilePath = join(tempDir, "Batch.ctp");
    await writeFile(firstPath, Buffer.from([1, 2, 3]));
    await writeFile(thirdPath, Buffer.from([7, 8, 9, 10]));

    const result = (await invoke("project:importPageImages", {
      projectFilePath,
      files: [
        { sourcePath: firstPath, pageNumber: 1 },
        { sourcePath: missingPath, pageNumber: 2 },
        { sourcePath: thirdPath, pageNumber: 3 }
      ]
    })) as Array<
      | { ok: true; pageImage: { pageNumber: number; originalFileName: string } }
      | { ok: false; sourcePath: string; message: string }
    >;

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ ok: true, pageImage: { pageNumber: 1, originalFileName: "page-001.png" } });
    expect(result[1]).toMatchObject({ ok: false, sourcePath: missingPath });
    expect(result[2]).toMatchObject({ ok: true, pageImage: { pageNumber: 3, originalFileName: "page-003.webp" } });
  });

  it("imports an opaque batch into a session and persists only successful pending links on save", async () => {
    const projectFilePath = join(tempDir, "Opaque.ctp");
    const sourcePath = join(tempDir, "user-owned-page.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
    const created = (await invoke("project:createSession", {
      title: "Opaque",
      secret: false
    })) as { projectSessionId: string };
    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: projectFilePath
    });
    await invoke("project:saveAs", {
      projectSessionId: created.projectSessionId
    });
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [sourcePath]
    });

    const batch = (await invoke("project:choosePageImages", {
      projectSessionId: created.projectSessionId
    })) as {
      importBatchId: string;
      images: Array<{ preparedImageId: string; previewToken: string }>;
    };
    expect(batch.images).toHaveLength(1);
    expect(JSON.stringify(batch)).not.toContain(sourcePath);

    const linked = (await invoke("project:importPageImages", {
      projectSessionId: created.projectSessionId,
      importBatchId: batch.importBatchId,
      pages: [
        { preparedImageId: batch.images[0]!.preparedImageId, pageNumber: 1 },
        { preparedImageId: "missing", pageNumber: 2 }
      ]
    })) as Array<{ ok: boolean; pendingPageImage?: { pageImageId: string } }>;
    expect(linked).toEqual([
      {
        ok: true,
        pendingPageImage: expect.objectContaining({ pageNumber: 1 })
      },
      expect.objectContaining({ ok: false })
    ]);
    const protocolHandler = electronMocks.protocolHandlers.get("translation-image");
    if (!protocolHandler) throw new Error("Missing translation-image protocol handler");
    const pendingPreviewUrl = `translation-image://asset/${batch.images[0]!.previewToken}`;
    await expect(protocolHandler({ url: pendingPreviewUrl })).resolves.toBeInstanceOf(Response);

    const saved = (await invoke("project:save", {
      projectSessionId: created.projectSessionId
    })) as {
      project: {
        project: { pageImages: Array<{ storedRelativePath: string }> };
        pendingPageImages: unknown[];
      };
    };
    expect(saved.project.pendingPageImages).toEqual([]);
    expect(saved.project.project.pageImages).toEqual([
      expect.objectContaining({
        storedRelativePath: expect.stringMatching(
          /^Opaque-assets\/images\/[a-f0-9]{64}\.png$/
        )
      })
    ]);
    await expect(protocolHandler({ url: pendingPreviewUrl })).rejects.toThrow(
      /unknown page image asset/i
    );
    await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects inpainting when OPENAI_API_KEY is missing", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const projectFilePath = join(tempDir, "Project.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      await expect(
        invoke("project:inpaintPageImage", {
          projectFilePath,
          pageImage: {
            id: "page-image-1",
            pageNumber: 1,
            storedRelativePath: "Project-assets/images/page-001.png",
            originalFileName: "page-001.png",
            sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            byteSize: 4,
            mimeType: "image/png",
            copiedAt: "2026-06-30T00:00:00.000Z"
          },
          maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mode: "speech-bubble",
          provider: "openai"
        })
      ).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it("rejects malformed inpainting pageImage before calling OpenAI", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(
        invoke("project:inpaintPageImage", {
          projectFilePath: join(tempDir, "Project.ctp"),
          pageImage: {
            id: "page-image-1",
            pageNumber: 0,
            storedRelativePath: "Project-assets/images/page-001.png",
            originalFileName: "page-001.png",
            sha256: "a".repeat(64),
            byteSize: 4,
            mimeType: "image/png",
            copiedAt: "2026-06-30T00:00:00.000Z"
          },
          maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mode: "speech-bubble",
          provider: "openai"
        })
      ).rejects.toThrow(/pageImage|page number|originalFileName/i);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("returns the manual inpainting UI adapter result for a session page id", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ b64_json: Buffer.from([9, 8, 7, 6]).toString("base64") }]
      })
    }) as unknown as typeof fetch;
    try {
      const projectFilePath = join(tempDir, "Manual.ctp");
      const sourcePath = join(tempDir, "source.png");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      electronMocks.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: projectFilePath
      });
      const created = await invoke("project:createSession", {
        title: "Manual",
        secret: false
      }) as { projectSessionId: string };
      const initialSave = await invoke("project:saveAs", { projectSessionId: created.projectSessionId }) as {
        recentProject: { recentProjectId: string };
      };
      const imported = await invoke("project:importPageImages", {
        projectSessionId: created.projectSessionId,
        files: [{ sourcePath, pageNumber: 1 }]
      }) as Array<{ ok: true; pageImage: { id: string } }>;
      await invoke("project:save", { projectSessionId: created.projectSessionId });

      const result = await invoke("project:inpaintPageImage", {
        projectSessionId: created.projectSessionId,
        pageImageId: imported[0]!.pageImage.id,
        maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mode: "speech-bubble",
        provider: "openai"
      }) as {
        pageImage: { id: string; storedRelativePath: string };
        run: { runId: string; pageImageId: string; source: string; status: string };
        asset: { sourcePageImageId: string; runId: string; role: string };
        sessionResult: {
          project: {
            revision: number;
            project: {
              pageImages: Array<{ id: string; storedRelativePath: string }>;
              processing: {
                pages: Array<{ approvedCleanedAssetId?: string }>;
                runs: Array<{ runId: string }>;
                assets: Array<{ assetId: string }>;
              };
            };
          };
        };
      };

      expect(result.pageImage.id).not.toBe(imported[0]!.pageImage.id);
      expect(result.run).toEqual(expect.objectContaining({
        pageImageId: imported[0]!.pageImage.id,
        source: "manual_openai",
        status: "completed"
      }));
      expect(result.asset).toEqual(expect.objectContaining({
        sourcePageImageId: imported[0]!.pageImage.id,
        runId: result.run.runId,
        role: "cleaned"
      }));
      expect(result.sessionResult.project.project.pageImages).toEqual([
        expect.objectContaining({ id: imported[0]!.pageImage.id })
      ]);
      expect(result.sessionResult.project.project.processing).toEqual({
        pages: [expect.objectContaining({ approvedCleanedAssetId: result.pageImage.id })],
        runs: [expect.objectContaining({ runId: result.run.runId })],
        assets: [
          expect.objectContaining({ role: "mask" }),
          expect.objectContaining({ assetId: result.pageImage.id, role: "cleaned" })
        ]
      });

      const resolvedResultSrc = await invoke("project:resolvePageImageSrc", {
        projectSessionId: created.projectSessionId,
        storedRelativePath: result.pageImage.storedRelativePath
      }) as string;
      expect(resolvedResultSrc).toMatch(/^translation-image:\/\/asset\//);
      const protocolHandler = electronMocks.protocolHandlers.get("translation-image");
      if (!protocolHandler) throw new Error("Missing translation-image protocol handler");
      await expect(protocolHandler({ url: resolvedResultSrc })).resolves.toBeInstanceOf(Response);
      const originalRelativePath = result.sessionResult.project.project.pageImages[0]!.storedRelativePath;
      const resolvedOriginalSrc = await invoke("project:resolvePageImageSrc", {
        projectSessionId: created.projectSessionId,
        storedRelativePath: originalRelativePath
      }) as string;
      await expect(protocolHandler({ url: resolvedOriginalSrc })).resolves.toBeInstanceOf(Response);

      const movedDirectory = join(tempDir, "moved");
      await mkdir(movedDirectory, { recursive: true });
      const movedProjectFilePath = join(movedDirectory, "Manual-copy.ctp");
      electronMocks.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: movedProjectFilePath
      });
      const moved = await invoke("project:saveAs", {
        projectSessionId: created.projectSessionId
      }) as { recentProject: { recentProjectId: string } };
      const movedResultSrc = await invoke("project:resolvePageImageSrc", {
        projectSessionId: created.projectSessionId,
        storedRelativePath: result.pageImage.storedRelativePath
      }) as string;
      await expect(movedResultSrc).toMatch(/^translation-image:\/\/asset\//);
      await expect(protocolHandler({ url: movedResultSrc })).resolves.toBeInstanceOf(Response);
      const movedOriginalSrc = await invoke("project:resolvePageImageSrc", {
        projectSessionId: created.projectSessionId,
        storedRelativePath: originalRelativePath
      }) as string;
      await expect(protocolHandler({ url: movedOriginalSrc })).resolves.toBeInstanceOf(Response);
      const sourceResultBytes = await readFile(join(tempDir, result.pageImage.storedRelativePath));
      const movedResultBytes = await readFile(join(movedDirectory, result.pageImage.storedRelativePath));
      expect(movedResultBytes).toEqual(sourceResultBytes);
      const sourceOriginalBytes = await readFile(join(tempDir, originalRelativePath));
      const movedOriginalBytes = await readFile(join(movedDirectory, originalRelativePath));
      expect(movedOriginalBytes).toEqual(sourceOriginalBytes);

      await invoke("project:close", { projectSessionId: created.projectSessionId });
      const reopened = await invoke("project:openRecent", {
        recentProjectId: moved.recentProject.recentProjectId
      }) as {
        projectSessionId: string;
        project: {
          project: {
            pageImages: Array<{ id: string; storedRelativePath: string }>;
            processing: {
              pages: Array<{ approvedCleanedAssetId?: string }>;
              runs: Array<{ runId: string }>;
              assets: Array<{ assetId: string }>;
            };
          };
        };
      };
      expect(reopened.project.project.pageImages).toEqual([
        expect.objectContaining({ id: imported[0]!.pageImage.id })
      ]);
      expect(reopened.project.project.processing.pages[0]).toEqual(
        expect.objectContaining({ approvedCleanedAssetId: result.pageImage.id })
      );
      expect(reopened.project.project.processing.runs[0]?.runId).toBe(result.run.runId);
      expect(reopened.project.project.processing.assets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ assetId: result.pageImage.id, role: "cleaned" }),
          expect.objectContaining({ role: "mask" })
        ])
      );
      const reopenedOriginalSrc = await invoke("project:resolvePageImageSrc", {
        projectSessionId: reopened.projectSessionId,
        storedRelativePath: originalRelativePath
      }) as string;
      await expect(protocolHandler({ url: reopenedOriginalSrc })).resolves.toBeInstanceOf(Response);
      const reopenedResultSrc = await invoke("project:resolvePageImageSrc", {
        projectSessionId: reopened.projectSessionId,
        storedRelativePath: result.pageImage.storedRelativePath
      }) as string;
      await expect(protocolHandler({ url: reopenedResultSrc })).resolves.toBeInstanceOf(Response);
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("cleans a newly written session inpainting asset when processing commit fails", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ b64_json: Buffer.from([9, 8, 7, 6]).toString("base64") }]
      })
    }) as unknown as typeof fetch;
    let saveCalls = 0;
    const failingManager = createProjectSessionManager({
      saveProjectFile: async () => {
        saveCalls += 1;
        if (saveCalls >= 3) throw new Error("injected processing commit failure");
      }
    });
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager: failingManager
    });
    try {
      const projectFilePath = join(tempDir, "Cleanup.ctp");
      const sourcePath = join(tempDir, "cleanup-source.png");
      await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
      electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: projectFilePath });
      const created = await invoke("project:createSession", {
        title: "Cleanup",
        secret: false
      }) as { projectSessionId: string };
      await invoke("project:saveAs", { projectSessionId: created.projectSessionId });
      const imported = await invoke("project:importPageImages", {
        projectSessionId: created.projectSessionId,
        files: [{ sourcePath, pageNumber: 1 }]
      }) as Array<{ ok: true; pageImage: { id: string } }>;
      await invoke("project:save", { projectSessionId: created.projectSessionId });

      const assetDirectory = join(tempDir, "Cleanup-assets", "images");
      const before = await readdir(assetDirectory);
      await expect(
        invoke("project:inpaintPageImage", {
          projectSessionId: created.projectSessionId,
          pageImageId: imported[0]!.pageImage.id,
          maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mode: "speech-bubble",
          provider: "openai"
        })
      ).rejects.toThrow(/injected processing commit failure/);
      await expect(readdir(assetDirectory)).resolves.toEqual(before);
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects changed source bytes before calling the inpainting provider", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const projectFilePath = join(tempDir, "Changed-source.ctp");
      const storedRelativePath = "Changed-source-assets/images/page-001.png";
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Changed-source-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, storedRelativePath), Buffer.from([1, 2, 3, 4]));

      await expect(
        invoke("project:inpaintPageImage", {
          projectFilePath,
          pageImage: {
            id: "changed-page",
            pageNumber: 1,
            storedRelativePath,
            originalFileName: "page-001.png",
            sha256: "a".repeat(64),
            byteSize: 4,
            mimeType: "image/png",
            copiedAt: "2026-08-03T00:00:00.000Z"
          },
          maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mode: "speech-bubble",
          provider: "openai"
        })
      ).rejects.toThrow(/source bytes|SHA-256|original image/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects changed source bytes before extracting speech bubbles", async () => {
    const projectFilePath = join(tempDir, "Changed-extract.ctp");
    await writeFile(projectFilePath, "{}", "utf8");
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));
    const changedPageImage = { ...pageImageFixture(), sha256: "a".repeat(64) };
    const projectSessionManager = createProjectSessionManager();
    const project = createEmptyProject("Changed OCR source", false);
    project.pageImages = [changedPageImage];
    const created = projectSessionManager.createProjectSession({ project, filePath: projectFilePath });
    const execute = vi.fn<ProductionOcrService["execute"]>();
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager,
      productionOcrService: productionOcrServiceFixture(execute)
    });

    await expect(
      invoke("project:extractSpeechBubbles", {
        requestId: "changed-production-ocr",
        projectSessionId: created.projectSessionId,
        pageImageId: changedPageImage.id,
        sourceSha256: changedPageImage.sha256
      })
    ).rejects.toThrow(/source bytes|SHA-256|original image/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects changed source bytes before validating speech bubbles", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.GEMINI_API_KEY;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const projectFilePath = join(tempDir, "Changed-validation.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      await expect(
        invoke("project:validateSpeechBubbles", {
          projectFilePath,
          pageImage: { ...pageImageFixture(), sha256: "a".repeat(64) },
          geminiExtraction: emptyExtractionFixture()
        })
      ).rejects.toThrow(/source bytes|SHA-256|original image/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks provider calls while a session page image replacement is unsaved", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const projectFilePath = join(tempDir, "Gate.ctp");
      const directSourcePath = join(tempDir, "direct.png");
      const opaqueSourcePath = join(tempDir, "opaque.png");
      await writeFile(directSourcePath, Buffer.from([1, 2, 3, 4]));
      await writeFile(opaqueSourcePath, Buffer.from([5, 6, 7, 8]));
      electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: projectFilePath });
      const created = await invoke("project:createSession", {
        title: "Gate",
        secret: false
      }) as { projectSessionId: string };
      await invoke("project:saveAs", { projectSessionId: created.projectSessionId });

      const imported = await invoke("project:importPageImages", {
        projectSessionId: created.projectSessionId,
        files: [{ sourcePath: directSourcePath, pageNumber: 1 }]
      }) as Array<{ ok: true; pageImage: { id: string; sha256: string } }>;
      await expect(
        invoke("project:extractSpeechBubbles", {
          requestId: "dirty-page-production-ocr",
          projectSessionId: created.projectSessionId,
          pageImageId: imported[0]!.pageImage.id,
          sourceSha256: imported[0]!.pageImage.sha256
        })
      ).rejects.toThrow(/먼저 저장.*OCR.*인페인팅/);
      await expect(
        invoke("project:inpaintPageImage", {
          projectSessionId: created.projectSessionId,
          pageImageId: imported[0]!.pageImage.id,
          maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mode: "speech-bubble",
          provider: "openai"
        })
      ).rejects.toThrow(/먼저 저장.*OCR.*인페인팅/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(electronMocks.nativeImageCreateFromBuffer).not.toHaveBeenCalled();

      await invoke("project:save", { projectSessionId: created.projectSessionId });
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [opaqueSourcePath] });
      const batch = await invoke("project:choosePageImages", {
        projectSessionId: created.projectSessionId
      }) as { importBatchId: string; images: Array<{ preparedImageId: string }> };
      await invoke("project:importPageImages", {
        projectSessionId: created.projectSessionId,
        importBatchId: batch.importBatchId,
        pages: [{ preparedImageId: batch.images[0]!.preparedImageId, pageNumber: 1 }]
      });

      await expect(
        invoke("project:inpaintPageImage", {
          projectSessionId: created.projectSessionId,
          pageImageId: imported[0]!.pageImage.id,
          maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mode: "speech-bubble",
          provider: "openai"
        })
      ).rejects.toThrow(/먼저 저장.*OCR.*인페인팅/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("returns manual processing metadata for a non-session inpainting result", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: [{ b64_json: Buffer.from([9, 8, 7, 6]).toString("base64") }]
      })
    }) as unknown as typeof fetch;
    try {
      const projectFilePath = join(tempDir, "Standalone.ctp");
      const storedRelativePath = "Standalone-assets/images/page-001.png";
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Standalone-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, storedRelativePath), Buffer.from([1, 2, 3, 4]));

      const result = await invoke("project:inpaintPageImage", {
        projectFilePath,
        pageImage: {
          id: "standalone-page-1",
          pageNumber: 1,
          storedRelativePath,
          originalFileName: "page-001.png",
          sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
          byteSize: 4,
          mimeType: "image/png",
          copiedAt: "2026-08-03T00:00:00.000Z"
        },
        maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
        mode: "speech-bubble",
        provider: "openai"
      }) as {
        pageImage: { id: string };
        run: { pageImageId: string; source: string };
        asset: { sourcePageImageId: string; assetId: string };
      };

      expect(result.run).toEqual(expect.objectContaining({
        pageImageId: "standalone-page-1",
        source: "manual_openai"
      }));
      expect(result.asset).toEqual(expect.objectContaining({
        sourcePageImageId: "standalone-page-1",
        assetId: result.pageImage.id
      }));
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves stored page image paths to file URLs inside the project folder", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const sourcePath = join(tempDir, "scan_001.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

    const imported = (await invoke("project:importPageImages", {
      projectFilePath,
      files: [{ sourcePath, pageNumber: 1 }]
    })) as Array<{ ok: true; pageImage: { storedRelativePath: string } }>;

    const fileUrl = await invoke("project:resolvePageImageSrc", {
      projectFilePath,
      storedRelativePath: imported[0]?.pageImage.storedRelativePath
    });

    expect(fileUrl).toMatch(/^translation-image:\/\/asset\//);
    await expect(
      invoke("project:resolvePageImageSrc", {
        projectFilePath,
        storedRelativePath: "../outside.png"
      })
    ).rejects.toThrow(/inside the project folder/i);
  });

  it("chooses page image files through the registered picker handler", async () => {
    const firstPath = join(tempDir, "page-001.jpg");
    const secondPath = join(tempDir, "page-002.png");
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [firstPath, secondPath] });

    await expect(invoke("project:choosePageImageFiles")).resolves.toEqual([firstPath, secondPath]);
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "이미지 파일", extensions: ["jpg", "jpeg", "png", "webp"] }]
      })
    );
  });

  it("routes Gemini inpainting requests to GEMINI_API_KEY", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const projectFilePath = join(tempDir, "Project.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      await expect(
        invoke("project:inpaintPageImage", {
          projectFilePath,
          pageImage: {
            id: "page-image-1",
            pageNumber: 1,
            storedRelativePath: "Project-assets/images/page-001.png",
            originalFileName: "page-001.png",
            sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            byteSize: 4,
            mimeType: "image/png",
            copiedAt: "2026-06-30T00:00:00.000Z"
          },
          maskPngBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mode: "speech-bubble",
          provider: "gemini"
        })
      ).rejects.toThrow(/GEMINI_API_KEY/);
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
    }
  });

  it("extracts speech bubble candidates from a Main-owned page through Production OCR", async () => {
    const projectFilePath = join(tempDir, "Project.ctp");
    await writeFile(projectFilePath, "{}", "utf8");
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));
    const projectSessionManager = createProjectSessionManager();
    const created = createSavedOcrSession(projectSessionManager, projectFilePath);
    const extraction = {
      pageNumber: 1,
      speechBubbles: [
        {
          id: "bubble-001",
          type: "speech_bubble" as const,
          text: "Hello",
          language: "en" as const,
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          readingOrder: 1,
          confidence: 0.9,
          notes: "",
          speakerCandidates: []
        }
      ],
      nonSpeechText: [],
      warnings: []
    };
    const execute = vi.fn<ProductionOcrService["execute"]>().mockResolvedValue(extraction);
    registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager,
      productionOcrService: productionOcrServiceFixture(execute)
    });

    const result = (await invoke("project:extractSpeechBubbles", {
      requestId: "production-ocr-ipc",
      projectSessionId: created.projectSessionId,
      pageImageId: pageImageFixture().id,
      sourceSha256: pageImageFixture().sha256
    })) as {
      speechBubbles: Array<{ text: string }>;
      productionOcrContext: { runId: string; pageImageId: string; sourceSha256: string };
    };

    expect(result.speechBubbles[0]?.text).toBe("Hello");
    expect(result.productionOcrContext).toEqual({
      runId: "production-ocr-ipc",
      pageImageId: pageImageFixture().id,
      sourceSha256: pageImageFixture().sha256
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      imageBytes: Buffer.from([1, 2, 3, 4]),
      pageNumber: 1,
      signal: expect.any(AbortSignal)
    }));
  });

  it("validates Gemini speech bubble extraction from a stored page image through OpenAI", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.GEMINI_API_KEY;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          pageNumber: 1,
          speechBubbles: [],
          nonSpeechText: [
            {
              type: "caption",
              text: "A caption",
              bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
              confidence: 0.9
            }
          ],
          warnings: ["No speech bubbles confirmed"]
        })
      })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const projectFilePath = join(tempDir, "Project.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      const result = (await invoke("project:validateSpeechBubbles", {
        projectFilePath,
        pageImage: {
          id: "page-image-1",
          pageNumber: 1,
          storedRelativePath: "Project-assets/images/page-001.png",
          originalFileName: "page-001.png",
          sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
          byteSize: 4,
          mimeType: "image/png",
          copiedAt: "2026-06-30T00:00:00.000Z"
        },
        geminiExtraction: {
          pageNumber: 1,
          speechBubbles: [],
          nonSpeechText: [],
          warnings: []
        }
      })) as { nonSpeechText: Array<{ text: string }>; warnings: string[] };

      expect(result.nonSpeechText[0]?.text).toBe("A caption");
      expect(result.warnings).toEqual(["No speech bubbles confirmed"]);
      const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
        input: Array<{ content: Array<{ image_url?: string; text?: string }> }>;
      };
      expect(requestBody.input[0]?.content[0]?.text).toContain("Gemini JSON extraction");
      expect(requestBody.input[0]?.content[1]?.image_url).toBe(
        `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`
      );
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("validates speech bubble extraction through Gemini when only Gemini API key is configured", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          pageNumber: 1,
          speechBubbles: [
            {
              id: "bubble-001",
              type: "speech_bubble",
              text: "Gemini checked",
              language: "en",
              bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
              readingOrder: 1,
              confidence: 0.9,
              notes: ""
            }
          ],
          nonSpeechText: [],
          warnings: []
        })
      })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const projectFilePath = join(tempDir, "Project.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      const result = (await invoke("project:validateSpeechBubbles", {
        projectFilePath,
        pageImage: {
          id: "page-image-1",
          pageNumber: 1,
          storedRelativePath: "Project-assets/images/page-001.png",
          originalFileName: "page-001.png",
          sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
          byteSize: 4,
          mimeType: "image/png",
          copiedAt: "2026-06-30T00:00:00.000Z"
        },
        geminiExtraction: {
          pageNumber: 1,
          speechBubbles: [],
          nonSpeechText: [],
          warnings: []
        },
        characters: [
          {
            name: "Mika",
            aliases: ["M"],
            description: "short hair",
            speechStyle: "casual",
            relationshipNotes: "often speaks to Ren"
          }
        ]
      })) as { speechBubbles: Array<{ text: string }> };

      expect(result.speechBubbles[0]?.text).toBe("Gemini checked");
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
        "Content-Type": "application/json",
        "x-goog-api-key": "test-gemini-key"
      });
      const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
        input: Array<{ text?: string; data?: string }>;
      };
      expect(requestBody.input[0]?.text).toContain("Gemini JSON extraction");
      expect(requestBody.input[0]?.text).toContain("Project character context");
      expect(requestBody.input[0]?.text).toContain("Mika");
      expect(requestBody.input[0]?.text).toContain("short hair");
      expect(requestBody.input[0]?.text).toContain("speakerCandidates");
      expect(requestBody.input[1]?.data).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("uses Gemini validation and Gemini crop reOCR when only Gemini API key is configured", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";
    electronMocks.nativeImageToPNG.mockReturnValue(Buffer.from([7, 7, 7]));
    electronMocks.nativeImageCrop.mockReturnValue({ toPNG: electronMocks.nativeImageToPNG });
    electronMocks.nativeImageGetSize.mockReturnValue({ width: 100, height: 100 });
    electronMocks.nativeImageCreateFromBuffer.mockReturnValue({
      getSize: electronMocks.nativeImageGetSize,
      crop: electronMocks.nativeImageCrop
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            pageNumber: 1,
            speechBubbles: [
              {
                id: "bubble-001",
                type: "speech_bubble",
                text: "Hel[?]o",
                language: "en",
                bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
                readingOrder: 1,
                confidence: 0.62,
                notes: "uncertain"
              }
            ],
            nonSpeechText: [],
            warnings: []
          })
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            text: "Hello",
            confidence: 0.86,
            notes: "crop clear"
          })
        })
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const projectFilePath = join(tempDir, "Project.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      const result = (await invoke("project:validateSpeechBubbles", {
        projectFilePath,
        pageImage: {
          id: "page-image-1",
          pageNumber: 1,
          storedRelativePath: "Project-assets/images/page-001.png",
          originalFileName: "page-001.png",
          sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
          byteSize: 4,
          mimeType: "image/png",
          copiedAt: "2026-06-30T00:00:00.000Z"
        },
        geminiExtraction: {
          pageNumber: 1,
          speechBubbles: [],
          nonSpeechText: [],
          warnings: []
        }
      })) as { speechBubbles: Array<{ text: string; confidence: number; notes: string; readingOrder: number; bbox: unknown; type: string }> };

      expect(result.speechBubbles[0]).toMatchObject({
        type: "speech_bubble",
        text: "Hello",
        confidence: 0.86,
        readingOrder: 1,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }
      });
      expect(result.speechBubbles[0]?.notes).toContain("Crop ReOCR applied");
      expect(result.speechBubbles[0]?.notes).toContain("crop clear");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const validationBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
        input: Array<{ text?: string; data?: string }>;
      };
      const cropBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
        input: Array<{ text?: string; data?: string; mime_type?: string }>;
      };
      expect(validationBody.input[0]?.text).toContain("Gemini JSON extraction");
      expect(cropBody.input[0]?.text).toContain("OCR only this single crop image");
      expect(cropBody.input[1]).toMatchObject({
        mime_type: "image/png",
        data: Buffer.from([7, 7, 7]).toString("base64")
      });
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("prepares ordered opaque page image previews through the picker", async () => {
    const firstPath = join(tempDir, "page-001.jpg");
    const secondPath = join(tempDir, "page-002.png");
    await writeFile(firstPath, Buffer.from([1, 2, 3]));
    await writeFile(secondPath, Buffer.from([4, 5]));
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [firstPath, secondPath] });

    const result = await invoke("project:choosePreparedPageImageFiles");

    expect(result).toEqual([
      expect.objectContaining({
        sourcePath: firstPath,
        fileName: "page-001.jpg",
        previewSrc: expect.stringMatching(/^translation-image:\/\/asset\//),
        byteSize: 3
      }),
      expect.objectContaining({
        sourcePath: secondPath,
        fileName: "page-002.png",
        previewSrc: expect.stringMatching(/^translation-image:\/\/asset\//),
        byteSize: 2
      })
    ]);
  });

  it("returns null when the prepared page image picker is canceled", async () => {
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(invoke("project:choosePreparedPageImageFiles")).resolves.toBeNull();
  });

  it("rejects unsupported page image extensions before preparing previews", async () => {
    const unsupportedPath = join(tempDir, "page-001.gif");
    await writeFile(unsupportedPath, Buffer.from([1, 2, 3]));

    await expect(invoke("project:preparePageImageFiles", [unsupportedPath])).rejects.toThrow(
      /unsupported image file extension/i
    );
  });

  it("prepares an exact duplicate page image path only once", async () => {
    const sourcePath = join(tempDir, "page-001.webp");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

    const result = (await invoke("project:preparePageImageFiles", [sourcePath, sourcePath])) as Array<{
      sourcePath: string;
    }>;

    expect(result).toHaveLength(1);
    expect(result[0]?.sourcePath).toBe(sourcePath);
  });

  it("rejects relative page image paths before resolving or reading them", async () => {
    await expect(invoke("project:preparePageImageFiles", ["relative-page.png"])).rejects.toThrow(
      /absolute path/i
    );
  });

  it("rejects the entire preparation batch when a later file fails metadata validation", async () => {
    const validPath = join(tempDir, "page-001.png");
    const missingPath = join(tempDir, "missing-page-002.png");
    await writeFile(validPath, Buffer.from([1, 2, 3, 4]));

    await expect(invoke("project:preparePageImageFiles", [validPath, missingPath])).rejects.toThrow();
  });

  it("releases only the supplied prepared page image preview token", async () => {
    const firstPath = join(tempDir, "page-001.jpg");
    const secondPath = join(tempDir, "page-002.png");
    await writeFile(firstPath, Buffer.from([1, 2, 3]));
    await writeFile(secondPath, Buffer.from([4, 5, 6]));
    const prepared = (await invoke("project:preparePageImageFiles", [firstPath, secondPath])) as Array<{
      id: string;
      previewSrc: string;
    }>;
    const protocolHandler = electronMocks.protocolHandlers.get("translation-image");
    if (!protocolHandler) throw new Error("Missing translation-image protocol handler");

    await expect(protocolHandler({ url: prepared[0]!.previewSrc })).resolves.toBeInstanceOf(Response);
    await expect(protocolHandler({ url: prepared[1]!.previewSrc })).resolves.toBeInstanceOf(Response);

    await expect(invoke("project:releasePreparedPageImages", [prepared[0]!.id])).resolves.toBeUndefined();

    await expect(protocolHandler({ url: prepared[0]!.previewSrc })).rejects.toThrow(/unknown page image asset/i);
    await expect(protocolHandler({ url: prepared[1]!.previewSrc })).resolves.toBeInstanceOf(Response);
  });

  it("does not release a stored-project preview token supplied with a prepared token", async () => {
    const projectFilePath = join(tempDir, "Book.ctp");
    const storedPath = join(tempDir, "stored-page.png");
    const preparedPath = join(tempDir, "prepared-page.png");
    await writeFile(storedPath, Buffer.from([1, 2, 3]));
    await writeFile(preparedPath, Buffer.from([4, 5, 6]));
    const storedPreviewSrc = (await invoke("project:resolvePageImageSrc", {
      projectFilePath,
      storedRelativePath: "stored-page.png"
    })) as string;
    const [prepared] = (await invoke("project:preparePageImageFiles", [preparedPath])) as Array<{
      id: string;
      previewSrc: string;
    }>;
    const storedToken = new URL(storedPreviewSrc).pathname.slice(1);
    const protocolHandler = electronMocks.protocolHandlers.get("translation-image");
    if (!prepared || !protocolHandler) throw new Error("Missing prepared image or protocol handler");

    await invoke("project:releasePreparedPageImages", [storedToken, prepared.id]);

    await expect(protocolHandler({ url: storedPreviewSrc })).resolves.toBeInstanceOf(Response);
    await expect(protocolHandler({ url: prepared.previewSrc })).rejects.toThrow(/unknown page image asset/i);
  });

  it("revokes stored image protocol capabilities when a project session closes", async () => {
    const projectFilePath = join(tempDir, "session-images.ctp");
    const sourcePath = join(tempDir, "source-page.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: projectFilePath
    });
    const created = await invoke("project:createSession", {
      title: "Session images",
      secret: false
    }) as { projectSessionId: string };
    await invoke("project:saveAs", { projectSessionId: created.projectSessionId });
    const imported = await invoke("project:importPageImages", {
      projectSessionId: created.projectSessionId,
      files: [{ sourcePath, pageNumber: 1 }]
    }) as Array<{ ok: true; pageImage: { storedRelativePath: string } }>;
    const previewSrc = await invoke("project:resolvePageImageSrc", {
      projectSessionId: created.projectSessionId,
      storedRelativePath: imported[0]!.pageImage.storedRelativePath
    }) as string;
    const protocolHandler = electronMocks.protocolHandlers.get("translation-image");
    if (!protocolHandler) throw new Error("Missing translation-image protocol handler");

    await expect(protocolHandler({ url: previewSrc })).resolves.toBeInstanceOf(Response);
    await invoke("project:close", { projectSessionId: created.projectSessionId });
    await expect(protocolHandler({ url: previewSrc })).rejects.toThrow(/unknown page image asset/i);
  });

  it("keeps validated OCR when Gemini crop reOCR cannot process one crop", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";
    electronMocks.nativeImageToPNG.mockReturnValue(Buffer.from([7, 7, 7]));
    electronMocks.nativeImageCrop.mockReturnValue({ toPNG: electronMocks.nativeImageToPNG });
    electronMocks.nativeImageGetSize.mockReturnValue({ width: 100, height: 100 });
    electronMocks.nativeImageCreateFromBuffer.mockReturnValue({
      getSize: electronMocks.nativeImageGetSize,
      crop: electronMocks.nativeImageCrop
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            pageNumber: 1,
            speechBubbles: [{
              id: "bubble-001",
              type: "speech_bubble",
              text: "Hel[?]o",
              language: "en",
              bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
              readingOrder: 1,
              confidence: 0.62,
              notes: "uncertain",
              speakerCandidates: [{ speaker: "Mika", confidence: 0.8, reason: "tail" }]
            }],
            nonSpeechText: [],
            warnings: ["whole-image warning"]
          })
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: { message: "Unable to process input image." }
        }))
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const projectFilePath = join(tempDir, "Project.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      const result = (await invoke("project:validateSpeechBubbles", {
        projectFilePath,
        pageImage: pageImageFixture(),
        geminiExtraction: emptyExtractionFixture()
      })) as SpeechBubbleExtractionResult;

      expect(result.speechBubbles[0]).toMatchObject({
        text: "Hel[?]o",
        confidence: 0.62,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        readingOrder: 1,
        speakerCandidates: [{ speaker: "Mika", confidence: 0.8, reason: "tail" }]
      });
      expect(result.warnings).toEqual([
        "whole-image warning",
        "Crop ReOCR skipped for #1: Gemini crop reOCR request failed: Unable to process input image."
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("hides sensitive crop generation errors from Crop ReOCR warnings", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const sensitiveError = [
      "Crop failed at C:\\Users\\private-user\\secret-page.png",
      "Authorization: Bearer fake-secret-token",
      "x-api-key=fake-api-key",
      "request-image-bytes=89504e47"
    ].join("; ");
    electronMocks.nativeImageGetSize.mockReturnValue({ width: 100, height: 100 });
    electronMocks.nativeImageCrop.mockImplementation(() => {
      throw new Error(sensitiveError);
    });
    electronMocks.nativeImageCreateFromBuffer.mockReturnValue({
      getSize: electronMocks.nativeImageGetSize,
      crop: electronMocks.nativeImageCrop
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output_text: JSON.stringify({
          pageNumber: 1,
          speechBubbles: [{
            id: "bubble-001",
            type: "speech_bubble",
            text: "Hel[?]o",
            language: "en",
            bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
            readingOrder: 1,
            confidence: 0.62,
            notes: "uncertain"
          }],
          nonSpeechText: [],
          warnings: []
        })
      })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const projectFilePath = join(tempDir, "Project.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      const result = (await invoke("project:validateSpeechBubbles", {
        projectFilePath,
        pageImage: pageImageFixture(),
        geminiExtraction: emptyExtractionFixture()
      })) as SpeechBubbleExtractionResult;

      expect(result.warnings).toEqual([
        "Crop ReOCR skipped for #1: Unable to re-OCR this crop."
      ]);
      expect(result.warnings.join(" ")).not.toContain("C:\\Users\\private-user");
      expect(result.warnings.join(" ")).not.toContain("fake-secret-token");
      expect(result.warnings.join(" ")).not.toContain("fake-api-key");
      expect(result.warnings.join(" ")).not.toContain("89504e47");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("continues later crop reOCR targets after one target fails", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";
    electronMocks.nativeImageToPNG.mockReturnValue(Buffer.from([7, 7, 7]));
    electronMocks.nativeImageCrop.mockReturnValue({ toPNG: electronMocks.nativeImageToPNG });
    electronMocks.nativeImageGetSize.mockReturnValue({ width: 100, height: 100 });
    electronMocks.nativeImageCreateFromBuffer.mockReturnValue({
      getSize: electronMocks.nativeImageGetSize,
      crop: electronMocks.nativeImageCrop
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({
            pageNumber: 1,
            speechBubbles: [
              {
                id: "bubble-001",
                type: "speech_bubble",
                text: "First[?]",
                language: "en",
                bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
                readingOrder: 1,
                confidence: 0.6,
                notes: "first uncertain"
              },
              {
                id: "bubble-002",
                type: "speech_bubble",
                text: "Second[?]",
                language: "en",
                bbox: { x: 0.5, y: 0.4, width: 0.3, height: 0.1 },
                readingOrder: 2,
                confidence: 0.61,
                notes: "second uncertain"
              }
            ],
            nonSpeechText: [],
            warnings: []
          })
        })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: { message: "Unable to process input image." }
        }))
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          output_text: JSON.stringify({ text: "Second fixed", confidence: 0.91, notes: "second crop clear" })
        })
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const projectFilePath = join(tempDir, "Project.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      const result = (await invoke("project:validateSpeechBubbles", {
        projectFilePath,
        pageImage: pageImageFixture(),
        geminiExtraction: emptyExtractionFixture()
      })) as SpeechBubbleExtractionResult;

      expect(result.speechBubbles[0]?.text).toBe("First[?]");
      expect(result.speechBubbles[0]?.confidence).toBe(0.6);
      expect(result.speechBubbles[1]?.text).toBe("Second fixed");
      expect(result.speechBubbles[1]?.confidence).toBe(0.91);
      expect(result.speechBubbles[1]?.notes).toContain("Crop ReOCR applied");
      expect(result.warnings).toContain(
        "Crop ReOCR skipped for #1: Gemini crop reOCR request failed: Unable to process input image."
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      globalThis.fetch = originalFetch;
    }
  });

  it("returns unvalidated extraction with warning when no cloud API keys are present", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const projectFilePath = join(tempDir, "offline-validation.ctp");
      await writeFile(projectFilePath, "{}", "utf8");
      await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
      await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));

      const inputExtraction: SpeechBubbleExtractionResult = {
        pageNumber: 1,
        speechBubbles: [
          {
            id: "b1",
            text: "Local OCR bubble",
            bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            confidence: 0.85,
            type: "speech_bubble",
            language: "ja",
            readingOrder: 1,
            notes: "",
            speakerCandidates: []
          }
        ],
        nonSpeechText: [],
        warnings: []
      };

      const result = (await invoke("project:validateSpeechBubbles", {
        projectFilePath,
        pageImage: pageImageFixture(),
        geminiExtraction: inputExtraction
      })) as SpeechBubbleExtractionResult;

      expect(result.speechBubbles).toHaveLength(1);
      expect(result.speechBubbles[0]?.text).toBe("Local OCR bubble");
      expect(result.warnings).toContain(
        "2차 AI 검증 미완료, 원본 OCR 후보 사용 중. 클라우드 API 키가 등록되지 않았습니다."
      );
    } finally {
      if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiKey;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
    }
  });

  it("closes only the disconnected renderer's sessions and permits a new renderer to start", async () => {
    const projectSessionManager = createProjectSessionManager();
    const lifecycle = registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager
    });
    const created = await invoke("project:createSession", {
      title: "Renderer owner A",
      secret: false
    }, 41) as { projectSessionId: string };

    expect(projectSessionManager.getProject(created.projectSessionId).project.metadata.title).toBe("Renderer owner A");
    await expect(invoke("project:save", {
      projectSessionId: created.projectSessionId
    }, 42)).rejects.toThrow(/belongs to another renderer/);
    await lifecycle.cleanupRenderer(41);
    expect(() => projectSessionManager.getProject(created.projectSessionId)).toThrow(/Unknown project session/);
    await expect(lifecycle.cleanupRenderer(41)).resolves.toBeUndefined();

    const reopened = await invoke("project:createSession", {
      title: "Renderer owner B",
      secret: false
    }, 42) as { projectSessionId: string };
    expect(projectSessionManager.getProject(reopened.projectSessionId).project.metadata.title).toBe("Renderer owner B");
    projectSessionManager.disposeAll();
    projectSessionManager.disposeAll();
  });

  it("aborts translation owned by a disconnected renderer before closing its session", async () => {
    const projectSessionManager = createProjectSessionManager();
    let providerSignal: AbortSignal | undefined;
    const executeTranslation = vi.fn((_payload: unknown, options?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        providerSignal = options?.signal;
        providerSignal?.addEventListener("abort", () => reject(providerSignal?.reason), { once: true });
      })
    );
    const lifecycle = registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager,
      translationEngineRegistry: {
        registerAdapter: vi.fn(), getAdapter: vi.fn(), listAdapters: vi.fn(), executeTranslation
      }
    });
    const created = await invoke("project:createSession", {
      title: "Owned translation",
      secret: false
    }, 51) as { projectSessionId: string; project: { revision: number } };
    await projectSessionManager.applyProjectMutation({
      projectSessionId: created.projectSessionId,
      baseRevision: created.project.revision,
      mutation: {
        type: "add_dialogue_line",
        input: {
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "原文",
          dialogueType: "speech"
        }
      }
    });

    const pending = invoke("translation:execute", {
      projectSessionId: created.projectSessionId,
      targetLineId: projectSessionManager.getProject(created.projectSessionId).project.dialogueLines[0]!.id,
      requestId: "renderer-owned-translation"
    }, 51);
    const pendingOutcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    await lifecycle.cleanupRenderer(51);

    await expect(pendingOutcome).resolves.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
    expect(() => projectSessionManager.getProject(created.projectSessionId)).toThrow(/Unknown project session/);
  });

  it("aborts OCR and inpainting requests owned by a disconnected renderer", async () => {
    const projectFilePath = join(tempDir, "owned-ai.ctp");
    await writeFile(projectFilePath, "{}", "utf8");
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));
    let ocrSignal: AbortSignal | undefined;
    let inpaintingSignal: AbortSignal | undefined;
    const projectSessionManager = createProjectSessionManager();
    const created = createSavedOcrSession(projectSessionManager, projectFilePath);
    const executeOcr = vi.fn<ProductionOcrService["execute"]>((request) => new Promise<never>((_resolve, reject) => {
      ocrSignal = request.signal;
      ocrSignal?.addEventListener("abort", () => reject(ocrSignal?.reason), { once: true });
    }));
    const lifecycle = registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager,
      productionOcrService: productionOcrServiceFixture(executeOcr),
      inpaintingEngineRegistry: {
        execute: vi.fn((_provider: unknown, request: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            inpaintingSignal = request.signal;
            inpaintingSignal?.addEventListener("abort", () => reject(inpaintingSignal?.reason), { once: true });
          })
        )
      } as never
    });

    const ocrPending = invoke("project:extractSpeechBubbles", {
      requestId: "renderer-owned-ocr",
      projectSessionId: created.projectSessionId,
      pageImageId: pageImageFixture().id,
      sourceSha256: pageImageFixture().sha256
    }, 52);
    const inpaintingPending = invoke("project:inpaintPageImage", {
      requestId: "renderer-owned-inpainting",
      projectFilePath,
      pageImage: pageImageFixture(),
      maskPngBase64: Buffer.from("mask").toString("base64"),
      mode: "speech-bubble",
      provider: "local-lama"
    }, 52);
    const ocrOutcome = ocrPending.catch((error: unknown) => error);
    const inpaintingOutcome = inpaintingPending.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(ocrSignal).toBeDefined();
      expect(inpaintingSignal).toBeDefined();
    });

    await lifecycle.cleanupRenderer(52);
    await expect(ocrOutcome).resolves.toMatchObject({ name: "AbortError" });
    await expect(inpaintingOutcome).resolves.toMatchObject({ name: "AbortError" });
    expect(ocrSignal?.aborted).toBe(true);
    expect(inpaintingSignal?.aborted).toBe(true);
  });

  it("cancels and settles an image-less session batch before renderer close", async () => {
    const entered = lifecycleGate();
    const release = lifecycleGate();
    let signal: AbortSignal | undefined;
    let returned = false;
    let leaseReleased = false;
    const violations: string[] = [];
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      signal = options?.signal;
      entered.resolve();
      await release.promise;
      returned = true;
      return { translatedText: "늦은 결과", engine: "local_ai" };
    });
    const { manager, lifecycle } = registerLifecycleBatch(executeTranslation, { withImages: false });
    const created = await createLifecycleSession(manager, "run");
    const releaseLease = manager.releaseBatchProcessingLease.bind(manager);
    vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation((...args) => {
      leaseReleased = releaseLease(...args);
      return leaseReleased;
    });
    const close = manager.closeProject.bind(manager);
    vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (!returned || !leaseReleased) violations.push("image-less session closed before drain");
      return close(args);
    });
    const pending = invokeLifecycleBatch(created.projectSessionId, "run");
    const outcomes: Promise<unknown>[] = [pending];
    void pending.catch(() => undefined);
    try {
      await lifecycleDeadline(entered.promise);
      const cleanup = lifecycle.cleanupRenderer(71);
      outcomes.push(cleanup);
      void cleanup.catch(() => undefined);
      expect(signal?.aborted).toBe(true);
      release.resolve();
      await lifecycleDeadline(cleanup);
      await expect(pending).resolves.toMatchObject({ progress: { stage: "canceled" } });
      expect(violations).toEqual([]);
      expect(leaseReleased).toBe(true);
      expect(() => manager.getProject(created.projectSessionId)).toThrow(/Unknown project session/);
    } finally {
      release.resolve();
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it("does not leave a failed-open session as a renderer-unreachable orphan after close cleanup fails", async () => {
    const filePath = join(tempDir, "failed-open.ctp");
    await invoke("project:save", {
      filePath,
      project: createEmptyProject("Failed Open", false)
    });
    const inner = createProjectSessionManager();
    const openedSessionIds: string[] = [];
    let failClose = true;
    const projectSessionManager = {
      ...inner,
      createProjectSession(args: Parameters<typeof inner.createProjectSession>[0]) {
        const created = inner.createProjectSession(args);
        openedSessionIds.push(created.projectSessionId);
        return created;
      },
      resumePageImageImports: vi.fn(async () => {
        throw new Error("resume imports failed");
      }),
      closeProject: vi.fn(async (args: { projectSessionId: string }) => {
        if (failClose) throw new Error("temporary close cleanup failure");
        return inner.closeProject(args);
      })
    };
    const lifecycle = registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager
    });
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });

    await expect(invoke("project:openFromDialog", undefined, 61)).rejects.toMatchObject({
      name: "AggregateError",
      message: "Opened project session cleanup failed"
    });
    expect(openedSessionIds).toHaveLength(1);
    const orphanedSessionId = openedSessionIds[0]!;
    expect(projectSessionManager.getProject(orphanedSessionId).status).toBe("active");

    failClose = false;
    await expect(lifecycle.retryPendingSessionCleanups()).resolves.toBeUndefined();
    expect(() => projectSessionManager.getProject(orphanedSessionId)).toThrow(/Unknown project session/);
    expect(projectSessionManager.closeProject).toHaveBeenCalledTimes(2);
  });

  it("blocks a later open of the same file while Main-owned close cleanup keeps failing", async () => {
    const filePath = join(tempDir, "blocked-open.ctp");
    await invoke("project:save", {
      filePath,
      project: createEmptyProject("Blocked Open", false)
    });
    const inner = createProjectSessionManager();
    const openedSessionIds: string[] = [];
    const projectSessionManager = {
      ...inner,
      createProjectSession(args: Parameters<typeof inner.createProjectSession>[0]) {
        const created = inner.createProjectSession(args);
        openedSessionIds.push(created.projectSessionId);
        return created;
      },
      resumePageImageImports: vi.fn(async () => {
        throw new Error("resume imports failed");
      }),
      closeProject: vi.fn(async () => {
        throw new Error("persistent close cleanup failure");
      })
    };
    const lifecycle = registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager
    });
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });

    await expect(invoke("project:openFromDialog", undefined, 62)).rejects.toMatchObject({
      name: "AggregateError"
    });
    expect(projectSessionManager.getProject(openedSessionIds[0]!).status).toBe("active");
    await expect(lifecycle.retryPendingSessionCleanups()).resolves.toBeUndefined();
    expect(projectSessionManager.getProject(openedSessionIds[0]!).status).toBe("active");

    await expect(invoke("project:openFromDialog", undefined, 62)).rejects.toThrow(
      /이전 프로젝트 세션을 닫지 못해 같은 프로젝트를 열 수 없습니다: persistent close cleanup failure/
    );
    expect(openedSessionIds).toHaveLength(1);
  });

  it("retries a disconnected renderer's failed session close without dropping secret protection early", async () => {
    const inner = createProjectSessionManager();
    let protectionBuffers: Buffer[] = [];
    let failClose = true;
    const projectSessionManager = {
      ...inner,
      createSecretProjectSession(args: Parameters<typeof inner.createSecretProjectSession>[0]) {
        const created = inner.createSecretProjectSession(args);
        protectionBuffers = created.protectionBuffers;
        return created;
      },
      closeProject: vi.fn(async (args: { projectSessionId: string }) => {
        if (failClose) throw new Error("temporary renderer close cleanup failure");
        return inner.closeProject(args);
      })
    };
    const lifecycle = registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager
    });
    const created = await invoke("project:createSession", {
      title: "Disconnected secret",
      secret: true,
      password: "keep-until-retry"
    }, 63) as { projectSessionId: string };

    await expect(lifecycle.cleanupRenderer(63)).resolves.toBeUndefined();
    expect(projectSessionManager.getProject(created.projectSessionId).status).toBe("active");
    expect(protectionBuffers.some((buffer) => buffer.some((byte) => byte !== 0))).toBe(true);
    await expect(lifecycle.cleanupRenderer(63)).resolves.toBeUndefined();
    expect(projectSessionManager.getProject(created.projectSessionId).status).toBe("active");

    failClose = false;
    await expect(lifecycle.retryPendingSessionCleanups()).resolves.toBeUndefined();
    expect(() => projectSessionManager.getProject(created.projectSessionId)).toThrow(/Unknown project session/);
    for (const buffer of protectionBuffers) expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it("keeps recoverable pending import bytes after a failed renderer close until Main retries the normal close", async () => {
    const sourcePath = join(tempDir, "pending-page.png");
    const projectFilePath = join(tempDir, "PendingClose.ctp");
    const temporaryRoot = join(tempDir, "pending-imports");
    await writeFile(sourcePath, Buffer.from([9, 8, 7, 6]));
    const inner = createProjectSessionManager({
      pageImageImports: createPendingPageImageImportManager({ temporaryRoot })
    });
    let failClose = true;
    const projectSessionManager = {
      ...inner,
      closeProject: vi.fn(async (args: { projectSessionId: string }) => {
        if (failClose) throw new Error("temporary discard failure");
        return inner.closeProject(args);
      })
    };
    const lifecycle = registerIpcHandlers({
      geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
      projectSessionManager
    });
    const created = await invoke("project:createSession", {
      title: "Pending Close",
      secret: false
    }, 64) as { projectSessionId: string };
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: projectFilePath });
    await invoke("project:saveAs", { projectSessionId: created.projectSessionId }, 64);
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourcePath] });
    const batch = await invoke("project:choosePageImages", {
      projectSessionId: created.projectSessionId
    }, 64) as { importBatchId: string; images: Array<{ preparedImageId: string }> };
    await invoke("project:importPageImages", {
      projectSessionId: created.projectSessionId,
      importBatchId: batch.importBatchId,
      pages: [{ preparedImageId: batch.images[0]!.preparedImageId, pageNumber: 1 }]
    }, 64);

    await expect(lifecycle.cleanupRenderer(64)).resolves.toBeUndefined();
    expect(projectSessionManager.getProject(created.projectSessionId).status).toBe("active");
    await expect(readFile(importJournalPath(projectFilePath), "utf8")).resolves.toContain(created.projectSessionId);
    await expect(readdir(join(temporaryRoot, created.projectSessionId))).resolves.not.toEqual([]);

    failClose = false;
    await expect(lifecycle.retryPendingSessionCleanups()).resolves.toBeUndefined();
    expect(() => projectSessionManager.getProject(created.projectSessionId)).toThrow(/Unknown project session/);
    await expect(readFile(importJournalPath(projectFilePath), "utf8")).resolves.toContain(created.projectSessionId);
    await expect(readdir(join(temporaryRoot, created.projectSessionId))).resolves.not.toEqual([]);
  });
});

describe("batch lifecycle IPC", () => {
  it("waits for the running provider and cleanup before replying to pause", async () => {
    const entered = lifecycleGate();
    const release = lifecycleGate();
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async () => {
      entered.resolve();
      await release.promise;
      return { translatedText: "일시정지 전 제안", engine: "local_ai" };
    });
    const { manager } = registerLifecycleBatch(executeTranslation, { pageCount: 2 });
    const created = await createLifecycleSession(manager, "run");
    const filePath = await saveLifecycleTemporaryProject(manager, created.projectSessionId);
    const cleanup = vi.spyOn(manager, "releaseBatchProcessingLease");
    const running = invokeLifecycleBatch(created.projectSessionId, "run");
    const outcomes: Promise<unknown>[] = [running];
    void running.catch(() => undefined);
    try {
      await lifecycleDeadline(entered.promise);
      const queueId = manager.getProject(created.projectSessionId).project.processing.queue!.queueId;
      let replied = false;
      const pausing = invoke("project:updateProcessingQueue", {
        projectSessionId: created.projectSessionId, queueId, action: "pause"
      }, 71).then((result) => { replied = true; return result; });
      outcomes.push(pausing);
      void pausing.catch(() => undefined);
      // This real FIFO save finishes any IPC-owned queue write while the provider remains gated.
      await manager.saveProject({ projectSessionId: created.projectSessionId });
      expect(replied).toBe(false);
      expect(cleanup).not.toHaveBeenCalled();
      release.resolve();
      await expect(lifecycleDeadline(pausing)).resolves.toMatchObject({
        queue: { queueId, status: "paused" }, control: { status: "settled" }
      });
      await lifecycleDeadline(running);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(executeTranslation).toHaveBeenCalledOnce();
      await invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
      const persisted = await loadProjectFile({ filePath });
      expect(persisted.project.processing.queue).toMatchObject({ queueId, status: "paused" });
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });
      const reopened = await invoke("project:openFromDialog", undefined, 72) as { projectSessionId: string };
      const restored = manager.getProject(reopened.projectSessionId).project;
      expect(restored.processing.queue).toMatchObject({ queueId, projectSessionId: reopened.projectSessionId, status: "paused" });
      expect(restored.dialogueLines[0]).toMatchObject({ aiTranslation: "일시정지 전 제안", lineStatus: "untranslated" });
      expect(restored.dialogueLines[0]?.userTranslation).toBeUndefined();
      expect(restored.dialogueLines[1]?.aiTranslation).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it.each(["run", "retry", "resume"] as const)("waits for a late %s provider before project close", async (mode) => {
    const providerEntered = lifecycleGate();
    const providerRelease = lifecycleGate();
    const abortObserved = lifecycleGate();
    const closeEntered = lifecycleGate();
    let providerReturned = false;
    let signal: AbortSignal | undefined;
    const violations: string[] = [];
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      signal = options?.signal;
      signal?.addEventListener("abort", () => abortObserved.resolve(), { once: true });
      providerEntered.resolve();
      await providerRelease.promise;
      providerReturned = true;
      return { translatedText: "늦은 번역", engine: "local_ai" };
    });
    const { manager, lifecycle } = registerLifecycleBatch(executeTranslation);
    const realClose = manager.closeProject.bind(manager);
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (!providerReturned) violations.push("manager close entered before provider returned");
      closeEntered.resolve();
      return realClose(args);
    });
    const created = await createLifecycleSession(manager, mode);
    const pending = invokeLifecycleBatch(created.projectSessionId, mode);
    const outcomes: Promise<unknown>[] = [pending];
    void pending.catch(() => undefined);
    try {
      await providerEntered.promise;
      const closing = invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
      outcomes.push(closing);
      void closing.catch(() => undefined);
      await Promise.race([abortObserved.promise, closeEntered.promise]);
      expect(signal?.aborted).toBe(true);
      expect(observedClose).not.toHaveBeenCalled();
      providerRelease.resolve();
      await closing;
      await pending;
      expect(violations).toEqual([]);
      expect(observedClose).toHaveBeenCalledOnce();
      expect(executeTranslation).toHaveBeenCalledOnce();
    } finally {
      providerRelease.resolve();
      await Promise.allSettled(outcomes);
      await lifecycle.retryPendingSessionCleanups();
      await manager.disposeAll();
    }
  });

  it.each(["run", "retry", "resume"] as const)("drains %s acquisition before renderer close", async (mode) => {
    const acquired = lifecycleGate();
    const acquireRelease = lifecycleGate();
    const drainEntered = lifecycleGate();
    let acquisitionReturned = false;
    let leaseReleased = false;
    const violations: string[] = [];
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({
      translatedText: "호출되면 안 됨", engine: "local_ai"
    });
    const { manager, coordinator, lifecycle } = registerLifecycleBatch(executeTranslation);
    const created = await createLifecycleSession(manager, mode);
    if (mode === "run") {
      const acquire = manager.acquireBatchProcessingQueue.bind(manager);
      vi.spyOn(manager, "acquireBatchProcessingQueue").mockImplementation(async (args) => {
        const result = await acquire(args);
        acquired.resolve();
        await acquireRelease.promise;
        acquisitionReturned = true;
        return result;
      });
    } else {
      const acquire = manager.acquireBatchProcessingQueueResume.bind(manager);
      vi.spyOn(manager, "acquireBatchProcessingQueueResume").mockImplementation(async (args) => {
        const result = await acquire(args);
        acquired.resolve();
        await acquireRelease.promise;
        acquisitionReturned = true;
        return result;
      });
    }
    const release = manager.releaseBatchProcessingLease.bind(manager);
    vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation((...args) => {
      leaseReleased = release(...args);
      return leaseReleased;
    });
    const drain = coordinator.cancelSessionExecutions.bind(coordinator);
    vi.spyOn(coordinator, "cancelSessionExecutions").mockImplementation((id) => {
      const pending = drain(id);
      drainEntered.resolve();
      return pending;
    });
    const close = manager.closeProject.bind(manager);
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (!acquisitionReturned || !leaseReleased) violations.push("close entered before acquisition and lease cleanup");
      return close(args);
    });
    const pending = invokeLifecycleBatch(created.projectSessionId, mode);
    const outcomes: Promise<unknown>[] = [pending];
    void pending.catch(() => undefined);
    try {
      await lifecycleDeadline(acquired.promise);
      const cleanup = lifecycle.cleanupRenderer(71);
      outcomes.push(cleanup);
      void cleanup.catch(() => undefined);
      await lifecycleDeadline(drainEntered.promise);
      expect(observedClose).not.toHaveBeenCalled();
      expect(leaseReleased).toBe(false);
      acquireRelease.resolve();
      await lifecycleDeadline(cleanup);
      await pending;
      expect(violations).toEqual([]);
      expect(leaseReleased).toBe(true);
      expect(executeTranslation).not.toHaveBeenCalled();
    } finally {
      acquireRelease.resolve();
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it("aborts every owned request and session before waiting and preserves another owner", async () => {
    const entered = Array.from({ length: 4 }, lifecycleGate);
    const release = Array.from({ length: 4 }, lifecycleGate);
    const returned = [false, false, false, false];
    const signals: Array<AbortSignal | undefined> = [];
    const violations: string[] = [];
    let calls = 0;
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      const index = calls++;
      signals[index] = options?.signal;
      entered[index]!.resolve();
      await release[index]!.promise;
      returned[index] = true;
      return { translatedText: "제안 번역", engine: "local_ai" };
    });
    const { manager, lifecycle } = registerLifecycleBatch(executeTranslation);
    const retry = await createLifecycleSession(manager, "retry");
    const resume = await createLifecycleSession(manager, "resume");
    const other = await createLifecycleSession(manager, "run", 72);
    const close = manager.closeProject.bind(manager);
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (!returned.slice(0, 3).every(Boolean)) violations.push("close before all owned providers returned");
      if (args.projectSessionId === other.projectSessionId) violations.push("another owner was closed");
      return close(args);
    });
    const outcomes: Promise<unknown>[] = [];
    const watch = (promise: Promise<unknown>) => {
      outcomes.push(promise);
      void promise.catch(() => undefined);
      return promise;
    };
    try {
      watch(invoke("batch:run", {
        requestId: "standalone-owned", project: manager.getProject(retry.projectSessionId).project, config: lifecycleConfig
      }, 71));
      await lifecycleDeadline(entered[0]!.promise);
      watch(invokeLifecycleBatch(retry.projectSessionId, "retry"));
      await lifecycleDeadline(entered[1]!.promise);
      watch(invokeLifecycleBatch(resume.projectSessionId, "resume"));
      await lifecycleDeadline(entered[2]!.promise);
      const otherRun = watch(invokeLifecycleBatch(other.projectSessionId, "run", 72, "other-owner"));
      await lifecycleDeadline(entered[3]!.promise);
      const cleanup = watch(lifecycle.cleanupRenderer(71));
      expect(signals.slice(0, 3).map((signal) => signal?.aborted)).toEqual([true, true, true]);
      expect(signals[3]?.aborted).toBe(false);
      expect(observedClose).not.toHaveBeenCalled();
      release.slice(0, 3).forEach((gate) => gate.resolve());
      await lifecycleDeadline(cleanup);
      expect(violations).toEqual([]);
      expect(observedClose).toHaveBeenCalledTimes(2);
      expect(manager.getProject(other.projectSessionId).status).toBe("active");
      expect(signals[3]?.aborted).toBe(false);
      release[3]!.resolve();
      await otherRun;
      expect(executeTranslation).toHaveBeenCalledTimes(4);
    } finally {
      release.forEach((gate) => gate.resolve());
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it("preserves the original request owner after same-owner and cross-owner duplicate IDs", async () => {
    const entered = lifecycleGate();
    const release = lifecycleGate();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      if (calls++ === 0) {
        signal = options?.signal;
        entered.resolve();
        await release.promise;
      }
      return { translatedText: "제안", engine: "local_ai" };
    });
    const { manager } = registerLifecycleBatch(executeTranslation);
    const original = await createLifecycleSession(manager, "run");
    const sameOwner = await createLifecycleSession(manager, "run");
    const otherOwner = await createLifecycleSession(manager, "run", 72);
    const pending = invokeLifecycleBatch(original.projectSessionId, "run");
    const outcomes: Promise<unknown>[] = [pending];
    const duplicates: Array<Promise<unknown>> = [];
    void pending.catch(() => undefined);
    let canceled: unknown;
    try {
      await lifecycleDeadline(entered.promise);
      for (const [sessionId, owner] of [[sameOwner.projectSessionId, 71], [otherOwner.projectSessionId, 72]] as const) {
        const duplicate = invokeLifecycleBatch(sessionId, "run", owner).catch((error: unknown) => error);
        duplicates.push(duplicate);
        outcomes.push(duplicate);
      }
      expect(executeTranslation).toHaveBeenCalledOnce();
      await expect(invoke("batch:cancel", { requestId: "lifecycle-request" }, 72)).resolves.toEqual({ canceled: false });
      canceled = await invoke("batch:cancel", { requestId: "lifecycle-request" }, 71);
    } finally {
      release.resolve();
      await Promise.allSettled(outcomes);
    }
    try {
      for (const duplicate of duplicates) expect(await duplicate).toMatchObject({ message: expect.stringMatching(/이미 실행 중인 Batch requestId/) });
      expect(canceled).toEqual({ canceled: true });
      expect(signal?.aborted).toBe(true);
      await expect(invokeLifecycleBatch(sameOwner.projectSessionId, "run")).resolves.toMatchObject({ progress: { stage: "completed" } });
      expect(executeTranslation).toHaveBeenCalledTimes(2);
    } finally {
      await manager.disposeAll();
    }
  });

  it("joins explicit closes and blocks run retry resume before acquisition", async () => {
    const closeEntered = lifecycleGate();
    const closeRelease = lifecycleGate();
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "제안", engine: "local_ai" });
    const { manager } = registerLifecycleBatch(executeTranslation);
    const created = await createLifecycleSession(manager, "resume");
    const close = manager.closeProject.bind(manager);
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      closeEntered.resolve();
      await closeRelease.promise;
      return close(args);
    });
    const acquire = vi.spyOn(manager, "acquireBatchProcessingQueue");
    const acquireResume = vi.spyOn(manager, "acquireBatchProcessingQueueResume");
    const first = invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
    const second = invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
    const admissions = (["run", "retry", "resume"] as const).map((mode) =>
      invokeLifecycleBatch(created.projectSessionId, mode).catch((error: unknown) => error)
    );
    try {
      expect(acquire).not.toHaveBeenCalled();
      expect(acquireResume).not.toHaveBeenCalled();
      await lifecycleDeadline(closeEntered.promise);
      expect(observedClose).toHaveBeenCalledOnce();
    } finally {
      closeRelease.resolve();
      await Promise.allSettled([first, second, ...admissions]);
    }
    try {
      for (const admission of admissions) expect(await admission).toMatchObject({ message: expect.stringMatching(/닫는 중이거나 정리를 기다리는/) });
      expect(executeTranslation).not.toHaveBeenCalled();
      expect(observedClose).toHaveBeenCalledOnce();
    } finally {
      await manager.disposeAll();
    }
  });

  it("transfers a failed close before releasing its gate and skips its own pending retry", async () => {
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "제안", engine: "local_ai" });
    const { manager, lifecycle } = registerLifecycleBatch(executeTranslation);
    const created = await createLifecycleSession(manager, "resume");
    const close = manager.closeProject.bind(manager);
    const failure = new Error("own close failed");
    let fail = true;
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (fail) throw failure;
      return close(args);
    });
    const acquire = vi.spyOn(manager, "acquireBatchProcessingQueue");
    const acquireResume = vi.spyOn(manager, "acquireBatchProcessingQueueResume");
    const admissions: Promise<unknown>[] = [];
    try {
      await expect(invoke("project:close", { projectSessionId: created.projectSessionId }, 71)).rejects.toBe(failure);
      // A failed raw close is Main-owned, so another renderer reaches the pending gate rather than acquiring it.
      admissions.push(...(["run", "retry", "resume"] as const).map((mode) =>
        invokeLifecycleBatch(created.projectSessionId, mode, 72).catch((error: unknown) => error)
      ));
      expect(acquire).not.toHaveBeenCalled();
      expect(acquireResume).not.toHaveBeenCalled();
      for (const admission of admissions) expect(await admission).toMatchObject({ message: expect.stringMatching(/닫는 중이거나 정리를 기다리는/) });
      fail = false;
      await lifecycleDeadline(invoke("project:close", { projectSessionId: created.projectSessionId }, 72));
      expect(observedClose).toHaveBeenCalledTimes(2);
      expect(() => manager.getProject(created.projectSessionId)).toThrow(/Unknown project session/);
      await lifecycle.retryPendingSessionCleanups();
      expect(observedClose).toHaveBeenCalledTimes(2);
    } finally {
      fail = false;
      await Promise.allSettled(admissions);
      await lifecycle.retryPendingSessionCleanups();
      await manager.disposeAll();
    }
  });

  it("gates the target before older pending cleanup and preserves its owner when that retry fails", async () => {
    const retryEntered = lifecycleGate();
    const retryRelease = lifecycleGate();
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "제안", engine: "local_ai" });
    const { manager, lifecycle } = registerLifecycleBatch(executeTranslation);
    const previous = await createLifecycleSession(manager, "run");
    const target = await createLifecycleSession(manager, "resume");
    const close = manager.closeProject.bind(manager);
    const failure = new Error("older pending close failed");
    let initialFailure = true;
    let retryFailure = true;
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (args.projectSessionId === previous.projectSessionId) {
        if (initialFailure) throw failure;
        retryEntered.resolve();
        await retryRelease.promise;
        if (retryFailure) throw failure;
      }
      return close(args);
    });
    const acquire = vi.spyOn(manager, "acquireBatchProcessingQueue");
    const acquireResume = vi.spyOn(manager, "acquireBatchProcessingQueueResume");
    const outcomes: Promise<unknown>[] = [];
    const admissions: Promise<unknown>[] = [];
    try {
      await expect(invoke("project:close", { projectSessionId: previous.projectSessionId }, 71)).rejects.toBe(failure);
      initialFailure = false;
      const closing = invoke("project:close", { projectSessionId: target.projectSessionId }, 71).catch((error: unknown) => error);
      outcomes.push(closing);
      admissions.push(...(["run", "retry", "resume"] as const).map((mode) =>
        invokeLifecycleBatch(target.projectSessionId, mode).catch((error: unknown) => error)
      ));
      outcomes.push(...admissions);
      expect(acquire).not.toHaveBeenCalled();
      expect(acquireResume).not.toHaveBeenCalled();
      await lifecycleDeadline(retryEntered.promise);
      expect(observedClose.mock.calls.every(([args]) => args.projectSessionId === previous.projectSessionId)).toBe(true);
      retryRelease.resolve();
      expect(await closing).toBe(failure);
      for (const admission of admissions) expect(await admission).toMatchObject({ message: expect.stringMatching(/닫는 중이거나 정리를 기다리는/) });
      await expect(invoke("project:close", { projectSessionId: target.projectSessionId }, 72)).rejects.toThrow(/belongs to another renderer/);
      await expect(invoke("project:save", { projectSessionId: target.projectSessionId }, 72)).rejects.toThrow(/belongs to another renderer/);
      expect(manager.getProject(target.projectSessionId).status).toBe("active");
      // The unsuccessful target gate is gone; the original owner may still run this session.
      await invokeLifecycleBatch(target.projectSessionId, "resume");
      expect(acquireResume).toHaveBeenCalledOnce();
    } finally {
      initialFailure = false;
      retryFailure = false;
      retryRelease.resolve();
      await Promise.allSettled(outcomes);
      await lifecycle.retryPendingSessionCleanups();
      await manager.disposeAll();
    }
  });

  it("rechecks each pending item and skips a concurrent explicit close without joining itself", async () => {
    const firstEntered = lifecycleGate();
    const firstRelease = lifecycleGate();
    const secondEntered = lifecycleGate();
    const secondRelease = lifecycleGate();
    const { manager, lifecycle } = registerLifecycleBatch(vi.fn<TranslationEngineRegistry["executeTranslation"]>());
    const first = await createLifecycleSession(manager, "run");
    const second = await createLifecycleSession(manager, "run");
    const close = manager.closeProject.bind(manager);
    let fail = true;
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (fail) throw new Error("seed pending close");
      const isFirst = args.projectSessionId === first.projectSessionId;
      (isFirst ? firstEntered : secondEntered).resolve();
      await (isFirst ? firstRelease : secondRelease).promise;
      return close(args);
    });
    const outcomes: Promise<unknown>[] = [];
    try {
      await expect(invoke("project:close", { projectSessionId: first.projectSessionId }, 71)).rejects.toThrow(/seed pending/);
      await expect(invoke("project:close", { projectSessionId: second.projectSessionId }, 71)).rejects.toThrow(/seed pending/);
      // The second explicit close was blocked by the first pending failure, so seed it with renderer cleanup.
      await lifecycle.cleanupRenderer(71);
      fail = false;
      const retry = lifecycle.retryPendingSessionCleanups();
      outcomes.push(retry);
      void retry.catch(() => undefined);
      await lifecycleDeadline(firstEntered.promise);
      const explicit = invoke("project:close", { projectSessionId: second.projectSessionId }, 72);
      outcomes.push(explicit);
      void explicit.catch(() => undefined);
      await lifecycleDeadline(secondEntered.promise);
      firstRelease.resolve();
      await lifecycleDeadline(retry);
      expect(observedClose.mock.calls.filter(([args]) => args.projectSessionId === second.projectSessionId)).toHaveLength(2);
      secondRelease.resolve();
      await explicit;
    } finally {
      fail = false;
      firstRelease.resolve();
      secondRelease.resolve();
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it.each(["close", "cleanup"] as const)("waits for cancellation persistence before %s completes", async (mode) => {
    const providerEntered = lifecycleGate();
    const providerRelease = lifecycleGate();
    const aborted = lifecycleGate();
    const saveEntered = lifecycleGate();
    const saveRelease = lifecycleGate();
    let saved = false;
    let leaseReleased = false;
    const violations: string[] = [];
    const { manager, lifecycle } = registerLifecycleBatch(async (_payload, options) => {
      options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      providerEntered.resolve();
      await providerRelease.promise;
      return { translatedText: "버릴 결과", engine: "local_ai" };
    });
    const created = await createLifecycleSession(manager, "run");
    const commit = manager.commitMainProjectPatch.bind(manager);
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation(async (args) => {
      const cancellation = args.patch.type === "update_processing_queue" && args.patch.queue.status === "cancelled";
      if (cancellation) {
        saveEntered.resolve();
        await saveRelease.promise;
      }
      const result = await commit(args);
      if (cancellation) saved = true;
      return result;
    });
    const releaseLease = manager.releaseBatchProcessingLease.bind(manager);
    vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation((...args) => {
      if (!saved) violations.push("lease released before cancellation persistence");
      leaseReleased = releaseLease(...args);
      return leaseReleased;
    });
    const close = manager.closeProject.bind(manager);
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (!saved || !leaseReleased) violations.push("close entered before cancellation persistence and lease cleanup");
      return close(args);
    });
    const pending = invokeLifecycleBatch(created.projectSessionId, "run");
    const outcomes: Promise<unknown>[] = [pending];
    void pending.catch(() => undefined);
    try {
      await lifecycleDeadline(providerEntered.promise);
      const closing = mode === "close"
        ? invoke("project:close", { projectSessionId: created.projectSessionId }, 71)
        : lifecycle.cleanupRenderer(71);
      outcomes.push(closing);
      void closing.catch(() => undefined);
      await lifecycleDeadline(aborted.promise);
      providerRelease.resolve();
      await lifecycleDeadline(saveEntered.promise);
      expect(leaseReleased).toBe(false);
      expect(observedClose).not.toHaveBeenCalled();
      saveRelease.resolve();
      await lifecycleDeadline(closing);
      await pending;
      expect(violations).toEqual([]);
      expect(saved).toBe(true);
      expect(leaseReleased).toBe(true);
    } finally {
      providerRelease.resolve();
      saveRelease.resolve();
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it.each(["false", "throw"] as const)("retains only the failed session after a %s lease cleanup and closes healthy owned sessions", async (failureMode) => {
    const entered = Array.from({ length: 3 }, lifecycleGate);
    const release = Array.from({ length: 3 }, lifecycleGate);
    const returned = [false, false, false];
    const signals: Array<AbortSignal | undefined> = [];
    const violations: string[] = [];
    let calls = 0;
    const { manager, lifecycle } = registerLifecycleBatch(async (_payload, options) => {
      const index = calls++;
      signals[index] = options?.signal;
      entered[index]!.resolve();
      await release[index]!.promise;
      returned[index] = true;
      return { translatedText: "제안", engine: "local_ai" };
    });
    const failed = await createLifecycleSession(manager, "run");
    const healthy = await createLifecycleSession(manager, "retry");
    const foreign = await createLifecycleSession(manager, "run", 72);
    const releaseLease = manager.releaseBatchProcessingLease.bind(manager);
    vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation((id, leaseId) => {
      if (id === failed.projectSessionId) {
        if (failureMode === "throw") throw new Error("injected lease cleanup failure");
        return false;
      }
      return releaseLease(id, leaseId);
    });
    const close = manager.closeProject.bind(manager);
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      if (!returned[0] || !returned[1]) violations.push("close before every owned provider settled");
      if (args.projectSessionId === failed.projectSessionId) violations.push("failed drain was immediately retried or closed");
      if (args.projectSessionId === foreign.projectSessionId) violations.push("foreign session was closed");
      return close(args);
    });
    const outcomes: Promise<unknown>[] = [];
    const watch = (promise: Promise<unknown>) => {
      outcomes.push(promise);
      void promise.catch(() => undefined);
      return promise;
    };
    try {
      watch(invokeLifecycleBatch(failed.projectSessionId, "run"));
      await lifecycleDeadline(entered[0]!.promise);
      watch(invokeLifecycleBatch(healthy.projectSessionId, "retry"));
      await lifecycleDeadline(entered[1]!.promise);
      const foreignRun = watch(invokeLifecycleBatch(foreign.projectSessionId, "run", 72, "foreign-request"));
      await lifecycleDeadline(entered[2]!.promise);
      const cleanup = watch(lifecycle.cleanupRenderer(71));
      expect(signals.map((signal) => signal?.aborted)).toEqual([true, true, false]);
      release[0]!.resolve();
      release[1]!.resolve();
      await expect(lifecycleDeadline(cleanup)).rejects.toBeInstanceOf(Error);
      expect(violations).toEqual([]);
      expect(observedClose.mock.calls.map(([args]) => args.projectSessionId)).toEqual([healthy.projectSessionId]);
      expect(manager.getProject(failed.projectSessionId).status).toBe("active");
      expect(() => manager.getProject(healthy.projectSessionId)).toThrow(/Unknown project session/);
      expect(manager.getProject(foreign.projectSessionId).status).toBe("active");
      expect(signals[2]?.aborted).toBe(false);
      const admissions = (["run", "retry", "resume"] as const).map((mode) =>
        invokeLifecycleBatch(failed.projectSessionId, mode, 72).catch((error: unknown) => error)
      );
      outcomes.push(...admissions);
      for (const admission of admissions) expect(await admission).toMatchObject({ message: expect.stringMatching(/닫는 중이거나 정리를 기다리는/) });
      // A later Main retry must recover the failed session, while the foreign owner stays active.
      observedClose.mockRestore();
      await lifecycle.retryPendingSessionCleanups();
      expect(() => manager.getProject(failed.projectSessionId)).toThrow(/Unknown project session/);
      expect(manager.getProject(foreign.projectSessionId).status).toBe("active");
      release[2]!.resolve();
      await foreignRun;
    } finally {
      release.forEach((gate) => gate.resolve());
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it("continues healthy session close after a standalone drain error without transferring foreign ownership", async () => {
    const entered = Array.from({ length: 2 }, lifecycleGate);
    const release = Array.from({ length: 2 }, lifecycleGate);
    let calls = 0;
    const { manager, coordinator, lifecycle } = registerLifecycleBatch(async () => {
      const index = calls++;
      entered[index]!.resolve();
      await release[index]!.promise;
      return { translatedText: "제안", engine: "local_ai" };
    });
    const healthy = await createLifecycleSession(manager, "run");
    const foreign = await createLifecycleSession(manager, "run", 72);
    const failure = new Error("injected standalone drain failure");
    const drain = coordinator.cancelBatchJobAndWait.bind(coordinator);
    vi.spyOn(coordinator, "cancelBatchJobAndWait").mockImplementation(async (id) => {
      const result = await drain(id);
      if (id === "standalone-failure") throw failure;
      return result;
    });
    const close = vi.spyOn(manager, "closeProject");
    const outcomes: Promise<unknown>[] = [];
    const watch = (promise: Promise<unknown>) => {
      outcomes.push(promise);
      void promise.catch(() => undefined);
    };
    try {
      watch(invoke("batch:run", { requestId: "standalone-failure", project: manager.getProject(healthy.projectSessionId).project, config: lifecycleConfig }, 71));
      await lifecycleDeadline(entered[0]!.promise);
      watch(invokeLifecycleBatch(healthy.projectSessionId, "run"));
      await lifecycleDeadline(entered[1]!.promise);
      const cleanup = lifecycle.cleanupRenderer(71);
      watch(cleanup);
      release.forEach((gate) => gate.resolve());
      await expect(lifecycleDeadline(cleanup)).rejects.toBe(failure);
      expect(close.mock.calls.map(([args]) => args.projectSessionId)).toEqual([healthy.projectSessionId]);
      expect(() => manager.getProject(healthy.projectSessionId)).toThrow(/Unknown project session/);
      await lifecycle.retryPendingSessionCleanups();
      expect(close).toHaveBeenCalledOnce();
      await expect(invoke("project:close", { projectSessionId: foreign.projectSessionId }, 71)).rejects.toThrow(/belongs to another renderer/);
    } finally {
      release.forEach((gate) => gate.resolve());
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it("keeps an explicit drain failure pending and rejects every new batch entry before acquire", async () => {
    const entered = lifecycleGate();
    const release = lifecycleGate();
    const aborted = lifecycleGate();
    const { manager, lifecycle } = registerLifecycleBatch(async (_payload, options) => {
      options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      return { translatedText: "제안", engine: "local_ai" };
    });
    const created = await createLifecycleSession(manager, "run");
    const failure = new Error("explicit close lease cleanup failed");
    vi.spyOn(manager, "releaseBatchProcessingLease").mockImplementation(() => { throw failure; });
    const close = vi.spyOn(manager, "closeProject");
    const pending = invokeLifecycleBatch(created.projectSessionId, "run");
    const outcomes: Promise<unknown>[] = [pending];
    const admissions: Promise<unknown>[] = [];
    void pending.catch(() => undefined);
    try {
      await lifecycleDeadline(entered.promise);
      const closing = invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
      outcomes.push(closing);
      void closing.catch(() => undefined);
      await lifecycleDeadline(aborted.promise);
      release.resolve();
      await expect(lifecycleDeadline(closing)).rejects.toBe(failure);
      expect(close).not.toHaveBeenCalled();
      const acquire = vi.spyOn(manager, "acquireBatchProcessingQueue");
      const acquireResume = vi.spyOn(manager, "acquireBatchProcessingQueueResume");
      admissions.push(...(["run", "retry", "resume"] as const).map((mode) =>
        invokeLifecycleBatch(created.projectSessionId, mode, 72).catch((error: unknown) => error)
      ));
      expect(acquire).not.toHaveBeenCalled();
      expect(acquireResume).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([...outcomes, ...admissions]);
    }
    try {
      for (const admission of admissions) expect(await admission).toMatchObject({ message: expect.stringMatching(/닫는 중이거나 정리를 기다리는/) });
      await lifecycleDeadline(invoke("project:close", { projectSessionId: created.projectSessionId }, 72));
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await manager.disposeAll();
    }
  });

  it("preserves a committed checkpoint when close cancels a later provider and the temporary ctp is reopened", async () => {
    const secondEntered = lifecycleGate();
    const secondRelease = lifecycleGate();
    const secondAborted = lifecycleGate();
    let secondSignal: AbortSignal | undefined;
    let calls = 0;
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      if (++calls === 2) {
        secondSignal = options?.signal;
        secondSignal?.addEventListener("abort", () => secondAborted.resolve(), { once: true });
        secondEntered.resolve();
        await secondRelease.promise;
      }
      return { translatedText: calls === 1 ? "이미 저장한 제안" : "채택하지 않을 결과", engine: "local_ai" };
    });
    const { manager } = registerLifecycleBatch(executeTranslation, { pageCount: 2 });
    const created = await createLifecycleSession(manager, "run");
    const filePath = join(tempDir, "checkpoint.ctp");
    await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
    await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));
    await manager.saveProjectAs({ projectSessionId: created.projectSessionId, filePath });
    const pending = invokeLifecycleBatch(created.projectSessionId, "run");
    const outcomes: Promise<unknown>[] = [pending];
    void pending.catch(() => undefined);
    try {
      await lifecycleDeadline(secondEntered.promise);
      expect(manager.getProject(created.projectSessionId).project.dialogueLines[0]?.aiTranslation).toBe("이미 저장한 제안");
      const closing = invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
      outcomes.push(closing);
      void closing.catch(() => undefined);
      await lifecycleDeadline(secondAborted.promise);
      secondRelease.resolve();
      await lifecycleDeadline(closing);
      await pending;
      expect(secondSignal?.aborted).toBe(true);
      expect(await readFile(filePath, "utf8")).toContain("이미 저장한 제안");
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });
      const reopened = await invoke("project:openFromDialog", undefined, 72) as { projectSessionId: string };
      const lines = manager.getProject(reopened.projectSessionId).project.dialogueLines;
      expect(lines[0]?.aiTranslation).toBe("이미 저장한 제안");
      expect(lines[0]?.userTranslation).toBeUndefined();
      expect(lines[0]?.lineStatus).toBe("untranslated");
      expect(lines[1]?.aiTranslation).toBeUndefined();
      expect(executeTranslation).toHaveBeenCalledTimes(2);
    } finally {
      secondRelease.resolve();
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });
});

describe("batch queue control IPC", () => {
  it.each(["completed", "cancelled"] as const)("returns terminal %s without another revision or disk write", async (status) => {
    const saver = vi.fn(saveProjectFile);
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "제안", engine: "local_ai" });
    const { manager } = registerLifecycleBatch(executeTranslation, { managerDependencies: { saveProjectFile: saver } });
    const created = await createLifecycleSession(manager, status === "completed" ? "run" : "resume");
    await saveLifecycleTemporaryProject(manager, created.projectSessionId);
    try {
      if (status === "completed") await invokeLifecycleBatch(created.projectSessionId, "run");
      else await invoke("project:updateProcessingQueue", {
        projectSessionId: created.projectSessionId, queueId: manager.getProject(created.projectSessionId).project.processing.queue!.queueId, action: "cancel"
      }, 71);
      const before = manager.getProject(created.projectSessionId);
      const writes = saver.mock.calls.length;
      for (const action of ["pause", "cancel", "pause", "cancel"] as const) {
        await expect(invoke("project:updateProcessingQueue", {
          projectSessionId: created.projectSessionId, queueId: before.project.processing.queue!.queueId, action
        }, 71)).resolves.toEqual({ project: before, queue: before.project.processing.queue, control: { status: "settled" } });
      }
      expect(before.project.processing.queue?.status).toBe(status);
      expect(manager.getProject(created.projectSessionId)).toEqual(before);
      expect(saver).toHaveBeenCalledTimes(writes);
      expect(executeTranslation).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
    } finally {
      await manager.disposeAll();
    }
  });

  it.each(["resume", "retry"] as const)("allows queue cancellation while %s is waiting for a late provider", async (mode) => {
    const entered = lifecycleGate();
    const aborted = lifecycleGate();
    const release = lifecycleGate();
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      return { translatedText: "채택하지 않을 결과", engine: "local_ai" };
    });
    const { manager } = registerLifecycleBatch(executeTranslation);
    const created = await createLifecycleSession(manager, mode);
    const queueId = manager.getProject(created.projectSessionId).project.processing.queue!.queueId;
    const managerControl = vi.spyOn(manager, "controlBatchProcessingQueue");
    const running = invokeLifecycleBatch(created.projectSessionId, mode);
    const outcomes: Promise<unknown>[] = [running];
    void running.catch(() => undefined);
    try {
      await lifecycleDeadline(entered.promise);
      let replied = false;
      const canceling = invoke("project:updateProcessingQueue", { projectSessionId: created.projectSessionId, queueId, action: "cancel" }, 71)
        .then((result) => { replied = true; return result; });
      outcomes.push(canceling);
      void canceling.catch(() => undefined);
      await lifecycleDeadline(aborted.promise);
      expect(replied).toBe(false);
      release.resolve();
      await expect(lifecycleDeadline(canceling)).resolves.toMatchObject({ queue: { queueId, status: "cancelled" }, control: { status: "settled" } });
      const resumed = await lifecycleDeadline(running);
      expect(resumed).toMatchObject({ queue: { queueId, status: "cancelled" } });
      expect(resumed).not.toHaveProperty("control");
      expect(managerControl).not.toHaveBeenCalled();
      expect(executeTranslation).toHaveBeenCalledOnce();
      expect(manager.getProject(created.projectSessionId).project.dialogueLines[0]?.aiTranslation).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled(outcomes);
      await manager.disposeAll();
    }
  });

  it.each(["pause", "cancel", "resume", "retry"] as const)(
    "rejects missing, stale and foreign-owner %s identity before execution or writes", async (action) => {
      const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>();
      const { manager, coordinator } = registerLifecycleBatch(executeTranslation);
      const created = await createLifecycleSession(manager, "resume");
      const before = manager.getProject(created.projectSessionId);
      const control = vi.spyOn(coordinator, "controlProcessingQueue");
      const resume = vi.spyOn(coordinator, "resumeProcessingQueue");
      const retry = vi.spyOn(coordinator, "retryProcessingQueuePage");
      const acquire = vi.spyOn(manager, "acquireBatchProcessingQueue");
      const acquireResume = vi.spyOn(manager, "acquireBatchProcessingQueueResume");
      const commit = vi.spyOn(manager, "commitMainProjectPatch");
      const request = { projectSessionId: created.projectSessionId, action, pageImageId: "lifecycle-page-1", revision: 0 };
      try {
        await expect(invoke("project:updateProcessingQueue", request, 71)).rejects.toThrow(/queueId/);
        await expect(invoke("project:updateProcessingQueue", { ...request, queueId: "previous-queue" }, 71))
          .rejects.toThrow("BATCH_PROCESSING_QUEUE_CHANGED");
        await expect(invoke("project:updateProcessingQueue", { ...request, queueId: before.project.processing.queue!.queueId }, 72))
          .rejects.toThrow(/another renderer/);
        for (const observed of [control, resume, retry, acquire, acquireResume, commit, executeTranslation]) {
          expect(observed).not.toHaveBeenCalled();
        }
        expect(manager.getProject(created.projectSessionId)).toEqual(before);
      } finally {
        await manager.disposeAll();
      }
    }
  );

  it.each(["closing", "pending"] as const)("blocks every queue control while the session is %s", async (phase) => {
    const entered = lifecycleGate();
    const release = lifecycleGate();
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>();
    const { manager, coordinator, lifecycle } = registerLifecycleBatch(executeTranslation);
    const created = await createLifecycleSession(manager, "resume");
    const queueId = manager.getProject(created.projectSessionId).project.processing.queue!.queueId;
    const close = manager.closeProject.bind(manager);
    const failure = new Error("fake close failure");
    vi.spyOn(manager, "closeProject").mockImplementationOnce(async (args) => {
      entered.resolve();
      await release.promise;
      if (phase === "pending") throw failure;
      return close(args);
    });
    const control = vi.spyOn(coordinator, "controlProcessingQueue");
    const resume = vi.spyOn(coordinator, "resumeProcessingQueue");
    const retry = vi.spyOn(coordinator, "retryProcessingQueuePage");
    const acquire = vi.spyOn(manager, "acquireBatchProcessingQueueResume");
    const commit = vi.spyOn(manager, "commitMainProjectPatch");
    const closing = invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
    void closing.catch(() => undefined);
    try {
      await lifecycleDeadline(entered.promise);
      if (phase === "pending") {
        release.resolve();
        await expect(closing).rejects.toBe(failure);
      }
      for (const action of ["pause", "cancel", "resume", "retry"] as const) {
        await expect(invoke("project:updateProcessingQueue", {
          projectSessionId: created.projectSessionId, queueId, action, pageImageId: "lifecycle-page-1", revision: 0
        }, phase === "pending" ? 72 : 71)).rejects.toThrow(/닫는 중이거나 정리를 기다리는/);
      }
      for (const observed of [control, resume, retry, acquire, commit, executeTranslation]) {
        expect(observed).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([closing]);
      await lifecycle.retryPendingSessionCleanups();
      await manager.disposeAll();
    }
  });

  it.each([
    { first: "pause", cancelVia: "request" }, { first: "cancel", cancelVia: "request" },
    { first: "pause", cancelVia: "queue" }, { first: "cancel", cancelVia: "queue" }
  ] as const)("settles $first first with $cancelVia cancellation on the same execution", async ({ first, cancelVia }) => {
    const entered = lifecycleGate();
    const aborted = lifecycleGate();
    const release = lifecycleGate();
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      return { translatedText: "채택하지 않을 결과", engine: "local_ai" };
    });
    const { manager } = registerLifecycleBatch(executeTranslation, { pageCount: 2 });
    const created = await createLifecycleSession(manager, "run");
    const managerControl = vi.spyOn(manager, "controlBatchProcessingQueue");
    const commit = vi.spyOn(manager, "commitMainProjectPatch");
    const running = invokeLifecycleBatch(created.projectSessionId, "run");
    const outcomes: Promise<unknown>[] = [running];
    const controls: Promise<unknown>[] = [];
    let replies = 0;
    void running.catch(() => undefined);
    try {
      await lifecycleDeadline(entered.promise);
      const queueId = manager.getProject(created.projectSessionId).project.processing.queue!.queueId;
      const control = (action: "pause" | "cancel") => {
        const response = invoke("project:updateProcessingQueue", { projectSessionId: created.projectSessionId, queueId, action }, 71)
          .then((result) => { replies += 1; return result; });
        void response.catch(() => undefined);
        controls.push(response);
      };
      if (first === "pause") control("pause");
      if (cancelVia === "queue") control("cancel");
      else await expect(invoke("batch:cancel", { requestId: "lifecycle-request" }, 71)).resolves.toEqual({ canceled: true });
      control("pause");
      control("cancel");
      await lifecycleDeadline(aborted.promise);
      expect(replies).toBe(0);
      release.resolve();
      for (const response of controls) {
        await expect(lifecycleDeadline(response)).resolves.toMatchObject({ queue: { queueId, status: "cancelled" }, control: { status: "settled" } });
      }
      await expect(running).resolves.toMatchObject({ progress: { stage: "canceled" } });
      expect(executeTranslation).toHaveBeenCalledOnce();
      expect(managerControl).not.toHaveBeenCalled();
      expect(commit.mock.calls.filter(([args]) => args.patch.type === "update_processing_queue" && args.patch.queue.status === "cancelled"))
        .toHaveLength(1);
      expect(manager.getProject(created.projectSessionId).project.dialogueLines.every((line) => !line.aiTranslation)).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([...outcomes, ...controls]);
      await manager.disposeAll();
    }
  });

  it("waits for a real checkpoint write before pause and cancel return, then reopens the saved proposal", async () => {
    const checkpointEntered = lifecycleGate();
    const checkpointRelease = lifecycleGate();
    const aborted = lifecycleGate();
    let held = false;
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async (_payload, options) => {
      options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      return { translatedText: "저장 중인 제안", engine: "local_ai" };
    });
    const { manager } = registerLifecycleBatch(executeTranslation, {
      pageCount: 2,
      managerDependencies: { saveProjectFile: async (args) => {
        if (!held && args.project.dialogueLines[0]?.aiTranslation === "저장 중인 제안") {
          held = true;
          checkpointEntered.resolve();
          await checkpointRelease.promise;
        }
        await saveProjectFile(args);
      } }
    });
    const created = await createLifecycleSession(manager, "run");
    const filePath = await saveLifecycleTemporaryProject(manager, created.projectSessionId);
    const running = invokeLifecycleBatch(created.projectSessionId, "run");
    const controls: Promise<unknown>[] = [];
    let replies = 0;
    void running.catch(() => undefined);
    try {
      await lifecycleDeadline(checkpointEntered.promise);
      const queueId = manager.getProject(created.projectSessionId).project.processing.queue!.queueId;
      for (const action of ["pause", "cancel"] as const) {
        const response = invoke("project:updateProcessingQueue", { projectSessionId: created.projectSessionId, queueId, action }, 71)
          .then((result) => { replies += 1; return result; });
        void response.catch(() => undefined);
        controls.push(response);
      }
      await lifecycleDeadline(aborted.promise);
      expect(replies).toBe(0);
      checkpointRelease.resolve();
      for (const response of controls) {
        await expect(lifecycleDeadline(response)).resolves.toMatchObject({ queue: { queueId, status: "cancelled" }, control: { status: "settled" } });
      }
      await expect(running).resolves.toMatchObject({ progress: { stage: "canceled" } });
      await invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
      const persisted = await loadProjectFile({ filePath });
      expect(persisted.project.processing.queue).toMatchObject({ queueId, status: "cancelled" });
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });
      const reopened = await invoke("project:openFromDialog", undefined, 72) as { projectSessionId: string };
      const restored = manager.getProject(reopened.projectSessionId).project;
      expect(restored.processing.queue).toMatchObject({ queueId, status: "cancelled" });
      expect(restored.dialogueLines[0]).toMatchObject({ aiTranslation: "저장 중인 제안", lineStatus: "untranslated" });
      expect(restored.dialogueLines[0]?.userTranslation).toBeUndefined();
      expect(restored.dialogueLines[1]?.aiTranslation).toBeUndefined();
      expect(executeTranslation).toHaveBeenCalledOnce();
    } finally {
      checkpointRelease.resolve();
      await Promise.allSettled([running, ...controls]);
      await manager.disposeAll();
    }
  });

  it.each([
    { phase: "enqueue", fail: false }, { phase: "enqueue", fail: true },
    { phase: "disk", fail: false }, { phase: "disk", fail: true }
  ] as const)("keeps the final fence through real $phase wait (failure=$fail) and close/reopen", async ({ phase, fail }) => {
    const entered = lifecycleGate();
    const release = lifecycleGate();
    const failure = new Error("fake final disk failure");
    const violations: string[] = [];
    let holdNextSave = false;
    let closed = false;
    let finalCalls = 0;
    let blocker: Promise<unknown> | undefined;
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "보존할 제안", engine: "local_ai" });
    const { manager, coordinator } = registerLifecycleBatch(executeTranslation, {
      managerDependencies: { saveProjectFile: async (args) => {
        if (closed) violations.push("file write after close");
        const finalSave = args.project.processing.queue?.status === "completed";
        if (holdNextSave || (phase === "disk" && finalSave)) {
          holdNextSave = false;
          entered.resolve();
          await release.promise;
        }
        if (finalSave && fail) throw failure;
        await saveProjectFile(args);
      } }
    });
    const created = await createLifecycleSession(manager, "run");
    const filePath = await saveLifecycleTemporaryProject(manager, created.projectSessionId);
    const commit = manager.commitMainProjectPatch.bind(manager);
    vi.spyOn(manager, "commitMainProjectPatch").mockImplementation((args) => {
      if (closed) violations.push("project patch after close");
      if (args.patch.type === "commit_batch_result" && args.patch.queue?.status === "completed") {
        finalCalls += 1;
        if (phase === "enqueue") {
          holdNextSave = true;
          // This real save is enqueued first; the final commit below waits inside the manager.
          blocker = manager.saveProject({ projectSessionId: created.projectSessionId });
          void blocker.catch(() => undefined);
        }
      }
      return commit(args);
    });
    const managerControl = vi.spyOn(manager, "controlBatchProcessingQueue");
    const close = manager.closeProject.bind(manager);
    const observedClose = vi.spyOn(manager, "closeProject").mockImplementation(async (args) => {
      await close(args);
      closed = true;
    });
    const running = invokeLifecycleBatch(created.projectSessionId, "run");
    const outcomes: Promise<unknown>[] = [running];
    void running.catch(() => undefined);
    try {
      await lifecycleDeadline(entered.promise);
      expect(finalCalls).toBe(1);
      const queueId = manager.getProject(created.projectSessionId).project.processing.queue!.queueId;
      let controlsReplied = 0;
      const controls = (["pause", "cancel"] as const).map((action) => {
        const response = invoke("project:updateProcessingQueue", { projectSessionId: created.projectSessionId, queueId, action }, 71)
          .then((result) => { controlsReplied += 1; return result as ProcessingQueueControlResult; });
        void response.catch(() => undefined);
        return response;
      });
      let drained = false;
      const draining = coordinator.cancelSessionExecutions(created.projectSessionId).then((found) => { drained = true; return found; });
      const closing = invoke("project:close", { projectSessionId: created.projectSessionId }, 71);
      outcomes.push(...controls, draining, closing);
      void closing.catch(() => undefined);
      await expect(invoke("batch:cancel", { requestId: "lifecycle-request" }, 71)).resolves.toEqual({ canceled: false });
      expect(controlsReplied).toBe(0);
      expect(drained).toBe(false);
      expect(observedClose).not.toHaveBeenCalled();
      expect(managerControl).not.toHaveBeenCalled();
      release.resolve();
      for (const control of controls) {
        const response = await lifecycleDeadline(control);
        expect(response.queue).toMatchObject({ queueId, status: fail ? "running" : "completed" });
        expect(response.control).toEqual(fail ? { status: "failed", message: failure.message } : { status: "settled" });
        expect(response.project.project.dialogueLines[0]?.aiTranslation).toBe("보존할 제안");
      }
      if (fail) await expect(running).rejects.toBe(failure);
      else await expect(running).resolves.toMatchObject({ progress: { stage: "completed" } });
      await expect(draining).resolves.toBe(true);
      await lifecycleDeadline(closing);
      await blocker;
      const persisted = await loadProjectFile({ filePath });
      expect(persisted.project.processing.queue).toMatchObject({ queueId, status: fail ? "running" : "completed" });
      electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] });
      const reopened = await invoke("project:openFromDialog", undefined, 72) as { projectSessionId: string };
      const restored = manager.getProject(reopened.projectSessionId).project;
      expect(restored.processing.queue).toMatchObject({ queueId, status: fail ? "paused" : "completed" });
      expect(restored.dialogueLines[0]).toMatchObject({ aiTranslation: "보존할 제안", lineStatus: "untranslated" });
      expect(restored.dialogueLines[0]?.userTranslation).toBeUndefined();
      expect(executeTranslation).toHaveBeenCalledOnce();
      expect(violations).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([...outcomes, ...(blocker ? [blocker] : [])]);
      await manager.disposeAll();
    }
  });

  it.each(["resume", "retry"] as const)("rejects a different queue adopted before the %s response returns", async (mode) => {
    const entered = lifecycleGate(); const release = lifecycleGate();
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>().mockResolvedValue({ translatedText: "기존 큐 결과", engine: "local_ai" });
    const { manager, coordinator } = registerLifecycleBatch(executeTranslation);
    const created = await createLifecycleSession(manager, mode);
    const method = mode === "resume" ? "resumeProcessingQueue" : "retryProcessingQueuePage";
    if (method === "resumeProcessingQueue") {
      const resume = coordinator.resumeProcessingQueue.bind(coordinator);
      vi.spyOn(coordinator, method).mockImplementation(async (args) => {
        const result = await resume(args); entered.resolve(); await release.promise; return result;
      });
    } else {
      const retry = coordinator.retryProcessingQueuePage.bind(coordinator);
      vi.spyOn(coordinator, method).mockImplementation(async (args) => {
        const result = await retry(args); entered.resolve(); await release.promise; return result;
      });
    }
    const response = invokeLifecycleBatch(created.projectSessionId, mode);
    void response.catch(() => undefined);
    try {
      await lifecycleDeadline(entered.promise);
      const previousQueueId = manager.getProject(created.projectSessionId).project.processing.queue!.queueId;
      await invoke("project:updateProcessingQueue", { projectSessionId: created.projectSessionId, action: "create" }, 71);
      const newQueueId = manager.getProject(created.projectSessionId).project.processing.queue!.queueId;
      expect(newQueueId).not.toBe(previousQueueId);
      release.resolve();
      await expect(lifecycleDeadline(response)).rejects.toThrow("BATCH_PROCESSING_QUEUE_CHANGED");
      expect(manager.getProject(created.projectSessionId).project.processing.queue?.queueId).toBe(newQueueId);
      expect(executeTranslation).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([response]);
      await manager.disposeAll();
    }
  });

  it("sends the acquired queue identity through the existing progress envelope before the provider", async () => {
    const send = vi.fn();
    const violations: string[] = [];
    let expectedQueueId: string | undefined;
    const executeTranslation = vi.fn<TranslationEngineRegistry["executeTranslation"]>(async () => {
      const events = send.mock.calls.filter(([channel]) => channel === "batch:progress").map(([, data]) => data as BatchProgressEvent);
      if (!events.some((data) => data.queueId === expectedQueueId && data.projectSessionId === created.projectSessionId)) {
        violations.push("provider started without an acquired queue progress event");
      }
      return { translatedText: "제안", engine: "local_ai" };
    });
    const { manager } = registerLifecycleBatch(executeTranslation);
    const created = await createLifecycleSession(manager, "run");
    const acquire = manager.acquireBatchProcessingQueue.bind(manager);
    vi.spyOn(manager, "acquireBatchProcessingQueue").mockImplementation(async (args) => {
      const acquired = await acquire(args);
      if (!acquired.queue) throw new Error("Expected the acquired session queue before publishing progress");
      expectedQueueId = acquired.queue.queueId;
      return acquired;
    });
    try {
      await electronMocks.handlers.get("batch:run")!({ sender: { id: 71, isDestroyed: () => false, send } }, {
        requestId: "progress-identity", projectSessionId: created.projectSessionId, config: lifecycleConfig
      });
      expect(executeTranslation).toHaveBeenCalledOnce();
      expect(violations).toEqual([]);
      const events = send.mock.calls.filter(([channel]) => channel === "batch:progress").map(([, data]) => data as BatchProgressEvent);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event).toMatchObject({ requestId: "progress-identity", projectSessionId: created.projectSessionId, queueId: expectedQueueId, progress: expect.any(Object) });
        expect(event).not.toHaveProperty("project");
      }
    } finally {
      await manager.disposeAll();
    }
  });
});

async function saveLifecycleTemporaryProject(manager: ReturnType<typeof createProjectSessionManager>, projectSessionId: string) {
  await mkdir(join(tempDir, "Project-assets", "images"), { recursive: true });
  await writeFile(join(tempDir, "Project-assets", "images", "page-001.png"), Buffer.from([1, 2, 3, 4]));
  const filePath = join(tempDir, "temporary.ctp");
  await manager.saveProjectAs({ projectSessionId, filePath });
  return filePath;
}

function lifecycleGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function lifecycleDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Batch lifecycle gate did not settle")), 2000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const lifecycleConfig = {
  targetPages: "all" as const,
  runOcr: false,
  runGlossary: false,
  runTranslate: true,
  runInpaint: false,
  runTypeset: false,
  speechStylePreset: "informal" as const,
  overwriteExisting: false
};

function registerLifecycleBatch(
  executeTranslation: TranslationEngineRegistry["executeTranslation"],
  options: { managerDependencies?: Parameters<typeof createProjectSessionManager>[0]; withImages?: boolean; pageCount?: number } = {}
) {
  const inner = createProjectSessionManager(options.managerDependencies);
  const manager = {
    ...inner,
    createProjectSession(args: Parameters<typeof inner.createProjectSession>[0]) {
      const project = normalizeProject(args.project);
      if (!args.filePath) {
        project.pageImages = options.withImages === false ? [] : Array.from({ length: options.pageCount ?? 1 }, (_, index) => ({
          ...pageImageFixture(), id: `lifecycle-page-${index + 1}`, pageNumber: index + 1
        }));
        project.dialogueLines = Array.from({ length: options.pageCount ?? 1 }, (_, index) => ({
          id: `lifecycle-line-${index + 1}`, order: index + 1, pageNumber: index + 1, sourceLanguage: "ja" as const, sourceText: "原文",
          dialogueType: "speech" as const, lineStatus: "untranslated" as const, parseConfidence: 1, parseWarnings: [],
          origin: { kind: "manual" as const }
        }));
      }
      return inner.createProjectSession({ ...args, project });
    }
  };
  const translationEngineRegistry: TranslationEngineRegistry = {
    registerAdapter: vi.fn(), getAdapter: vi.fn(), listAdapters: vi.fn(), executeTranslation
  };
  const coordinator = createBatchExecutionCoordinator({
    projectSessionManager: manager,
    translationEngineRegistry,
    providerSettingsStore: createProviderSettingsStore()
  });
  const lifecycle = registerIpcHandlers({
    geminiApiKeyStore: geminiApiKeyStore as GeminiApiKeyStore,
    projectSessionManager: manager,
    batchExecutionCoordinator: coordinator,
    translationEngineRegistry
  });
  return { manager, coordinator, lifecycle };
}

async function createLifecycleSession(
  manager: ReturnType<typeof createProjectSessionManager>, mode: "run" | "retry" | "resume", ownerId = 71
) {
  const created = await invoke("project:createSession", { title: `Lifecycle ${mode}`, secret: false }, ownerId) as {
    projectSessionId: string;
  };
  if (mode !== "run") {
    let queue = startProcessingQueue(createProcessingQueue({
      queueId: `lifecycle-${created.projectSessionId}`, projectSessionId: created.projectSessionId,
      pageImageIds: ["lifecycle-page-1"], revision: 0, now: "2026-10-18T00:00:00.000Z"
    }), { now: "2026-10-18T00:00:01.000Z" });
    queue.pages[0]!.stage = "translation";
    queue = mode === "retry"
      ? failProcessingQueuePage(queue, {
          pageImageId: "lifecycle-page-1", revision: 0, now: "2026-10-18T00:00:02.000Z",
          error: { code: "BATCH_TRANSLATION_FAILED", message: "fake failure", retryable: true, stage: "translation" }
        })
      : pauseProcessingQueue(queue, { now: "2026-10-18T00:00:02.000Z" });
    await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId, patch: { type: "update_processing_queue", queue }
    });
  }
  return created;
}

function invokeLifecycleBatch(projectSessionId: string, mode: "run" | "retry" | "resume", ownerId = 71, requestId = "lifecycle-request") {
  return mode === "run"
    ? invoke("batch:run", { requestId, projectSessionId, config: lifecycleConfig }, ownerId)
    : invoke("project:updateProcessingQueue", {
        projectSessionId, queueId: `lifecycle-${projectSessionId}`, action: mode, pageImageId: "lifecycle-page-1", revision: 0
      }, ownerId);
}

async function invoke(channel: string, args?: unknown, ownerId = 0): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  const requestScopedChannels = new Set([
    "project:inpaintPageImage",
    "project:extractSpeechBubbles",
    "project:validateSpeechBubbles"
  ]);
  const scopedArgs = requestScopedChannels.has(channel) && args && typeof args === "object" && !("requestId" in args)
    ? { ...args, requestId: `${channel}-${Math.random()}` }
    : args;
  return handler({
    sender: {
      id: ownerId,
      isDestroyed: () => false,
      send: vi.fn()
    }
  }, scopedArgs);
}

function pageImageFixture() {
  return {
    id: "page-image-1",
    pageNumber: 1,
    storedRelativePath: "Project-assets/images/page-001.png",
    originalFileName: "page-001.png",
    sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    byteSize: 4,
    mimeType: "image/png",
    copiedAt: "2026-06-30T00:00:00.000Z"
  };
}

function emptyExtractionFixture() {
  return { pageNumber: 1, speechBubbles: [], nonSpeechText: [], warnings: [] };
}

function productionOcrServiceFixture(
  execute: ProductionOcrService["execute"]
): ProductionOcrService {
  const readyStatus = {
    state: "ready" as const,
    ready: true,
    message: "Production OCR test runtime is ready",
    resourceVersion: "1.0.0"
  };
  return {
    getStatus: vi.fn(async () => readyStatus),
    setResourceRoot: vi.fn(async () => readyStatus),
    installOrRepair: vi.fn(async () => readyStatus),
    execute,
    close: vi.fn()
  };
}

function createSavedOcrSession(
  projectSessionManager: ReturnType<typeof createProjectSessionManager>,
  projectFilePath: string
) {
  const project = createEmptyProject("Production OCR IPC", false);
  project.pageImages = [pageImageFixture()];
  return projectSessionManager.createProjectSession({ project, filePath: projectFilePath });
}
