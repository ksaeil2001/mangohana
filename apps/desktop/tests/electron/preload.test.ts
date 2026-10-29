import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchProgressEvent } from "../../src/shared/processingQueue";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn()
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: { invoke: electronMocks.invoke, on: electronMocks.on, removeListener: electronMocks.removeListener },
  webUtils: { getPathForFile: electronMocks.getPathForFile }
}));

beforeAll(async () => {
  await import("../../electron/preload");
});

beforeEach(() => {
  electronMocks.invoke.mockClear();
  electronMocks.on.mockClear();
  electronMocks.removeListener.mockClear();
  electronMocks.getPathForFile.mockClear();
});

describe("preload project API", () => {
  it("opens the fixed bundled example without forwarding paths or caller arguments", async () => {
    const projectApi = getExposedProjectApi();
    const result = { projectSessionId: "example-session", encrypted: false };
    electronMocks.invoke.mockResolvedValueOnce(result);
    await expect(projectApi.openExampleProject({ filePath: "ignored.ctp" })).resolves.toBe(result);
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith("project:openExample");
  });

  it("forwards the clicked cleaned result identity once without paths, mutations or automatic revision retry", async () => {
    const projectApi = getExposedProjectApi();
    const args = { projectSessionId: "session-1", pageImageId: "page-1", cleanedAssetId: "cleaned-1", expectedRevision: 7 };
    expect(projectApi.reviewCleanedAsset).toBeTypeOf("function");
    electronMocks.invoke.mockRejectedValueOnce(new Error("REVISION_CONFLICT"));
    await expect(projectApi.reviewCleanedAsset({ ...args, project: { forged: true }, filePath: "C:\\private\\forged.ctp" })).rejects.toThrow("REVISION_CONFLICT");
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith("project:reviewCleanedAsset", args);
  });

  it.each(["pause", "cancel", "resume", "retry"] as const)("forwards %s queue identity and the control result", async (action) => {
    const projectApi = getExposedProjectApi();
    const response = { project: { revision: 7 }, queue: { queueId: "queue-1" }, control: { status: "failed", message: "저장 실패" } };
    electronMocks.invoke.mockResolvedValueOnce(response);
    await expect(projectApi.updateProcessingQueue({
      projectSessionId: "session-1", queueId: "queue-1", action,
      pageImageId: "page-1", revision: 2, reason: "사용자 요청",
      projectFilePath: "C:\\private\\forged.ctp", project: { forged: true }
    })).resolves.toBe(response);
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith("project:updateProcessingQueue", {
      projectSessionId: "session-1", queueId: "queue-1", action, pageImageIds: undefined,
      pageImageId: "page-1", stage: undefined, revision: 2, runId: undefined, reason: "사용자 요청", error: undefined
    });
  });

  it("passes typed Batch progress identity unchanged and removes the same listener", () => {
    const projectApi = getExposedProjectApi();
    const listener = vi.fn<(event: BatchProgressEvent) => void>();
    const unsubscribe = projectApi.onBatchProgress(listener);
    const wrapped = electronMocks.on.mock.calls[0]![1] as (_event: unknown, data: BatchProgressEvent) => void;
    const event: BatchProgressEvent = {
      requestId: "batch-1", projectSessionId: "session-1", queueId: "actual-queue-1",
      progress: { stage: "translate", currentPageIndex: 0, totalPages: 1, percent: 0, currentMessage: "번역 중",
        pageStatuses: {}, errors: [], isCanceled: false }
    };
    wrapped({}, event);
    const standalone: BatchProgressEvent = { requestId: "standalone-1", progress: event.progress };
    wrapped({}, standalone);
    expect(listener.mock.calls).toEqual([[event], [standalone]]);
    expect(listener.mock.calls[0]![0]).toBe(event);
    expect(electronMocks.on).toHaveBeenCalledWith("batch:progress", wrapped);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith("batch:progress", wrapped);
  });

  it.each([true, false])("preserves the Batch cancel acknowledgment shape (%s)", async (canceled) => {
    const projectApi = getExposedProjectApi();
    const response = { canceled };
    electronMocks.invoke.mockResolvedValueOnce(response);
    await expect(projectApi.cancelBatchJob({ requestId: "batch-1" })).resolves.toBe(response);
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith("batch:cancel", { requestId: "batch-1" });
  });

  it("exposes session persistence and native project destination selection methods", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.createProjectSession({ title: "Book", secret: false });
    await projectApi.openProjectFromDialog();
    await projectApi.openRecentProject({ recentProjectId: "recent-1" });
    await projectApi.unlockProject({ unlockToken: "unlock-1", password: "secret" });
    await projectApi.applyProjectMutation({
      projectSessionId: "session-1",
      baseRevision: 0,
      mutation: { type: "set_project_title", title: "Renamed" }
    });
    await projectApi.saveProject({
      projectSessionId: "session-1",
      filePath: "C:\\private\\forged.ctp",
      project: { forged: true },
      password: "must-not-cross"
    });
    await projectApi.chooseSaveFile({ defaultPath: "Book.ctp" });
    await projectApi.saveProjectAs({ projectSessionId: "session-1", filePath: "C:\\selected\\Book.ctp" });
    await projectApi.rekeyProject({ projectSessionId: "session-1", newPassword: "new secret" });
    await projectApi.closeProject({ projectSessionId: "session-1" });

    expect(projectApi).toHaveProperty("chooseSaveFile");
    expect(projectApi).not.toHaveProperty("openProject");
    expect(electronMocks.invoke.mock.calls.slice(0, 10)).toEqual([
      ["project:createSession", { title: "Book", secret: false }],
      ["project:openFromDialog"],
      ["project:openRecent", { recentProjectId: "recent-1" }],
      ["project:unlock", { unlockToken: "unlock-1", password: "secret" }],
      [
        "project:applyMutation",
        {
          projectSessionId: "session-1",
          baseRevision: 0,
          mutation: { type: "set_project_title", title: "Renamed" }
        }
      ],
      ["project:save", { projectSessionId: "session-1" }],
      ["project:chooseSaveFile", { defaultPath: "Book.ctp" }],
      ["project:saveAs", { projectSessionId: "session-1", filePath: "C:\\selected\\Book.ctp" }],
      ["project:rekey", { projectSessionId: "session-1", newPassword: "new secret" }],
      ["project:close", { projectSessionId: "session-1" }]
    ]);
  });

  it("exposes prepared page image IPC methods", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.choosePreparedPageImageFiles();
    await projectApi.preparePageImageFiles(["C:\\images\\page-001.png"]);
    await projectApi.releasePreparedPageImages(["preview-token"]);

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "project:choosePreparedPageImageFiles");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "project:preparePageImageFiles", [
      "C:\\images\\page-001.png"
    ]);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(3, "project:releasePreparedPageImages", ["preview-token"]);
  });

  it("exposes opaque session import batches without forwarding project paths or source files", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.choosePageImages({ projectSessionId: "session-1" });
    await projectApi.importPageImages({
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 3 }],
      projectFilePath: "C:\\private\\forged.ctp",
      files: [{ sourcePath: "C:\\private\\forged.png", pageNumber: 99 }]
    });
    await projectApi.releasePageImageImportBatch({
      projectSessionId: "session-1",
      importBatchId: "batch-1"
    });

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "project:choosePageImages", {
      projectSessionId: "session-1"
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "project:importPageImages", {
      projectSessionId: "session-1",
      importBatchId: "batch-1",
      pages: [{ preparedImageId: "prepared-1", pageNumber: 3 }]
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      3,
      "project:releasePageImageImportBatch",
      {
        projectSessionId: "session-1",
        importBatchId: "batch-1"
      }
    );
  });

  it("converts dropped Files to paths only inside the preload boundary", async () => {
    const projectApi = getExposedProjectApi();
    const file = new File(["page"], "page-001.png", { type: "image/png" });
    electronMocks.getPathForFile.mockReturnValue("C:\\actual\\page-001.png");

    await projectApi.preparePageImages({
      projectSessionId: "session-1",
      files: [file]
    });

    expect(electronMocks.getPathForFile).toHaveBeenCalledWith(file);
    expect(electronMocks.invoke).toHaveBeenCalledWith("project:preparePageImages", {
      projectSessionId: "session-1",
      sourcePaths: ["C:\\actual\\page-001.png"]
    });
  });

  it("never forwards a Renderer-supplied export path", async () => {
    const projectApi = getExposedProjectApi();
    const project = { schemaVersion: 2, metadata: { title: "Book" } };

    await projectApi.exportTranslations({
      filePath: "C:\\private\\overwrite.txt",
      defaultPath: "Book.txt",
      projectSessionId: "session-1",
      project
    });

    expect(electronMocks.invoke).toHaveBeenCalledWith("project:exportTranslations", {
      defaultPath: "Book.txt",
      projectSessionId: "session-1"
    });
    await expect(projectApi.exportTranslations({
      filePath: "C:\\private\\overwrite.txt",
      project
    })).rejects.toThrow(/project session/i);
  });

  it("forwards only the session page id across the manual inpainting adapter boundary", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.inpaintPageImage({
      projectSessionId: "session-1",
      pageImageId: "page-image-1",
      pageImage: { id: "forged", storedRelativePath: "C:\\private\\forged.png" },
      projectFilePath: "C:\\private\\forged.ctp",
      maskPngBase64: "mask",
      mode: "speech-bubble",
      provider: "openai",
      promptOverride: "keep line art"
    });

    expect(electronMocks.invoke).toHaveBeenCalledWith("project:inpaintPageImage", {
      projectSessionId: "session-1",
      pageImageId: "page-image-1",
      maskPngBase64: "mask",
      mode: "speech-bubble",
      provider: "openai",
      promptOverride: "keep line art"
    });
  });

  it("forwards inpainting options across the preload boundary when provided", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.inpaintPageImage({
      projectSessionId: "session-1",
      pageImageId: "page-image-1",
      maskPngBase64: "mask",
      mode: "speech-bubble",
      provider: "openai",
      options: {
        conservative: true,
        dilatePixels: 2
      }
    });

    expect(electronMocks.invoke).toHaveBeenCalledWith("project:inpaintPageImage", {
      projectSessionId: "session-1",
      pageImageId: "page-image-1",
      maskPngBase64: "mask",
      mode: "speech-bubble",
      provider: "openai",
      options: {
        conservative: true,
        dilatePixels: 2
      }
    });
  });

  it("exposes request-scoped manual OCR and inpainting cancellation", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.cancelSpeechBubbleOcr({ requestId: "ocr-1" });
    await projectApi.cancelInpainting({ requestId: "inpaint-1" });

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "project:cancelSpeechBubbleOcr", { requestId: "ocr-1" });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "project:cancelInpainting", { requestId: "inpaint-1" });
  });

  it("gets a dropped file path only through Electron webUtils", () => {
    const projectApi = getExposedProjectApi();
    const file = { name: "C:\\fakepath\\page-001.png", path: "C:\\browser-fake\\page-001.png" } as unknown as File;
    electronMocks.getPathForFile.mockReturnValue("C:\\actual\\page-001.png");

    expect(projectApi.getPathForFile(file)).toBe("C:\\actual\\page-001.png");
    expect(electronMocks.getPathForFile).toHaveBeenCalledWith(file);
  });

  it("exposes typed environment preparation IPC without renderer paths or commands", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.getEnvironmentSnapshot();
    await projectApi.chooseEnvironmentResourceRoot();

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "environment:getSnapshot");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "environment:chooseResourceRoot");
  });

  it("exposes typed local AI IPC methods", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.testLocalAiConnection({ runtime: "ollama", endpoint: "http://localhost:11434" });
    await projectApi.listLocalAiModels({ runtime: "ollama", endpoint: "http://localhost:11434" });
    await projectApi.translateWithLocalAi({
      endpoint: "http://localhost:11434",
      model: "sakura-13b",
      sourceText: "こんにちは"
    });

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "localAi:testConnection", {
      runtime: "ollama",
      endpoint: "http://localhost:11434"
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "localAi:listModels", {
      runtime: "ollama",
      endpoint: "http://localhost:11434"
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(3, "localAi:translate", {
      endpoint: "http://localhost:11434",
      model: "sakura-13b",
      sourceText: "こんにちは"
    });
  });

  it("exposes typed unified translation methods", async () => {
    const projectApi = getExposedProjectApi();

    await projectApi.executeTranslation({ projectSessionId: "session-1", targetLineId: "line-1" });
    await projectApi.commitTranslationProposal({
      projectSessionId: "session-1",
      targetLineId: "line-1",
      proposal: "해적왕",
      expectedTranslationFingerprint: "fingerprint-1"
    });
    await projectApi.inspectTranslationQa({ sourceText: "海賊王", translatedText: "해적왕" });
    await projectApi.queryTranslationMemory({ sourceText: "海賊王" });
    await projectApi.buildTranslationPayload({ targetLineId: "line-1" });

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "translation:execute", {
      projectSessionId: "session-1",
      targetLineId: "line-1"
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "translation:commitProposal", {
      projectSessionId: "session-1",
      targetLineId: "line-1",
      proposal: "해적왕",
      expectedTranslationFingerprint: "fingerprint-1"
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(3, "translation:inspectQa", {
      sourceText: "海賊王",
      translatedText: "해적왕"
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(4, "translation:queryTm", {
      sourceText: "海賊王"
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(5, "translation:buildPayload", {
      targetLineId: "line-1"
    });
  });

  it("exposes provider settings and translation cancellation methods", async () => {
    const projectApi = getExposedProjectApi() as typeof getExposedProjectApi extends () => infer R ? R & {
      getProviderSettings: () => Promise<unknown>;
      updateProviderSettings: (args: unknown) => Promise<unknown>;
      cancelTranslation: (args: unknown) => Promise<unknown>;
    } : never;

    await projectApi.getProviderSettings();
    await projectApi.updateProviderSettings({ ocrEngine: "paddle-ocr" });
    await projectApi.cancelTranslation({ requestId: "req-123" });

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "settings:getProviderSettings");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "settings:updateProviderSettings", {
      ocrEngine: "paddle-ocr"
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(3, "translation:cancel", {
      requestId: "req-123"
    });
  });
});

function getExposedProjectApi(): {
  createProjectSession: (args: unknown) => Promise<unknown>;
  openProjectFromDialog: () => Promise<unknown>;
  openExampleProject: (...args: unknown[]) => Promise<unknown>;
  openRecentProject: (args: unknown) => Promise<unknown>;
  unlockProject: (args: unknown) => Promise<unknown>;
  applyProjectMutation: (args: unknown) => Promise<unknown>;
  reviewCleanedAsset: (args: unknown) => Promise<unknown>;
  saveProject: (args: unknown) => Promise<unknown>;
  saveProjectAs: (args: unknown) => Promise<unknown>;
  chooseSaveFile: (args: unknown) => Promise<unknown>;
  rekeyProject: (args: unknown) => Promise<unknown>;
  closeProject: (args: unknown) => Promise<unknown>;
  exportTranslations: (args: unknown) => Promise<unknown>;
  choosePreparedPageImageFiles: () => Promise<unknown>;
  preparePageImageFiles: (paths: string[]) => Promise<unknown>;
  releasePreparedPageImages: (ids: string[]) => Promise<unknown>;
  choosePageImages: (args: unknown) => Promise<unknown>;
  preparePageImages: (args: unknown) => Promise<unknown>;
  importPageImages: (args: unknown) => Promise<unknown>;
  releasePageImageImportBatch: (args: unknown) => Promise<unknown>;
  inpaintPageImage: (args: unknown) => Promise<unknown>;
  cancelInpainting: (args: unknown) => Promise<unknown>;
  cancelSpeechBubbleOcr: (args: unknown) => Promise<unknown>;
  getPathForFile: (file: File) => string;
  getEnvironmentSnapshot: () => Promise<unknown>;
  chooseEnvironmentResourceRoot: () => Promise<unknown>;
  testLocalAiConnection: (args: unknown) => Promise<unknown>;
  listLocalAiModels: (args: unknown) => Promise<unknown>;
  translateWithLocalAi: (args: unknown) => Promise<unknown>;
  executeTranslation: (args: unknown) => Promise<unknown>;
  commitTranslationProposal: (args: unknown) => Promise<unknown>;
  inspectTranslationQa: (args: unknown) => Promise<unknown>;
  queryTranslationMemory: (args: unknown) => Promise<unknown>;
  buildTranslationPayload: (args: unknown) => Promise<unknown>;
  updateProcessingQueue: (args: unknown) => Promise<unknown>;
  cancelBatchJob: (args: unknown) => Promise<{ canceled: boolean }>;
  onBatchProgress: (listener: (event: BatchProgressEvent) => void) => () => void;
} {
  const call = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "projectApi");
  if (!call) throw new Error("projectApi was not exposed");
  return call[1];
}
