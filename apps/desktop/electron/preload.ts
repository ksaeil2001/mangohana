import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ElectronProjectApi } from "../src/renderer/electronApi.js";
import type { BatchProgressEvent } from "../src/shared/processingQueue.js";

const projectApi: ElectronProjectApi = {
  createProjectSession: (args) => ipcRenderer.invoke("project:createSession", args),
  openProjectFromDialog: () => ipcRenderer.invoke("project:openFromDialog"),
  openExampleProject: () => ipcRenderer.invoke("project:openExample"),
  openRecentProject: (args) => ipcRenderer.invoke("project:openRecent", args),
  unlockProject: (args) => ipcRenderer.invoke("project:unlock", args),
  applyProjectMutation: (args) => ipcRenderer.invoke("project:applyMutation", args),
  reviewCleanedAsset: (args) => ipcRenderer.invoke("project:reviewCleanedAsset", {
    projectSessionId: args.projectSessionId,
    pageImageId: args.pageImageId,
    cleanedAssetId: args.cleanedAssetId,
    expectedRevision: args.expectedRevision
  }),
  hydratePage: (args) => ipcRenderer.invoke("project:hydratePage", args),
  prefetchPages: (args) => ipcRenderer.invoke("project:prefetchPages", args),
  saveProject: (args) =>

    ipcRenderer.invoke("project:save", {
      projectSessionId: "projectSessionId" in args ? args.projectSessionId : undefined
    }),
  saveProjectAs: (args) => ipcRenderer.invoke("project:saveAs", args),
  chooseSaveFile: (args) => ipcRenderer.invoke("project:chooseSaveFile", args),
  rekeyProject: (args) => ipcRenderer.invoke("project:rekey", args),
  closeProject: (args) => ipcRenderer.invoke("project:close", args),
  listRecentProjects: () => ipcRenderer.invoke("project:listRecent"),
  removeRecentProject: (args) => ipcRenderer.invoke("project:removeRecent", args),
  importTxtFile: () => ipcRenderer.invoke("project:importTxtFile"),
  exportTranslations: (args) => {
    if (!args.projectSessionId) {
      return Promise.reject(new Error("A project session is required to export translations"));
    }
    return ipcRenderer.invoke("project:exportTranslations", {
      defaultPath: args.defaultPath,
      projectSessionId: args.projectSessionId
    });
  },
  exportProjectImages: (args) => {
    return ipcRenderer.invoke("project:exportImages", {
      projectSessionId: args.projectSessionId,
      defaultPath: args.defaultPath,
      includeZip: args.includeZip,
      typesetPages: args.typesetPages?.map((page) => ({
        pageImageId: page.pageImageId,
        pngBase64: page.pngBase64,
        readiness: page.readiness
      }))
    });
  },
  updateProcessingQueue: (args) => ipcRenderer.invoke("project:updateProcessingQueue", {
    projectSessionId: args.projectSessionId,
    queueId: args.queueId,
    action: args.action,
    pageImageIds: args.pageImageIds,
    pageImageId: args.pageImageId,
    stage: args.stage,
    revision: args.revision,
    runId: args.runId,
    reason: args.reason,
    error: args.error
  }),
  choosePageImageFiles: () => ipcRenderer.invoke("project:choosePageImageFiles"),
  choosePreparedPageImageFiles: () => ipcRenderer.invoke("project:choosePreparedPageImageFiles"),
  preparePageImageFiles: (sourcePaths) => ipcRenderer.invoke("project:preparePageImageFiles", sourcePaths),
  releasePreparedPageImages: (ids) => ipcRenderer.invoke("project:releasePreparedPageImages", ids),
  choosePageImages: (args) => ipcRenderer.invoke("project:choosePageImages", args),
  preparePageImages: (args) =>
    ipcRenderer.invoke("project:preparePageImages", {
      projectSessionId: args.projectSessionId,
      sourcePaths: args.files.map((file) => webUtils.getPathForFile(file))
    }),
  releasePageImageImportBatch: (args) =>
    ipcRenderer.invoke("project:releasePageImageImportBatch", args),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  importPageImages: (args) =>
    ipcRenderer.invoke("project:importPageImages", sanitizePageImageImport(args)),
  resolvePageImageSrc: (args) =>
    ipcRenderer.invoke("project:resolvePageImageSrc", withoutRendererProjectPath(args)),
  inpaintPageImage: (args) =>
    ipcRenderer.invoke("project:inpaintPageImage", sanitizeInpaintPageImage(args)),
  cancelInpainting: (args) => ipcRenderer.invoke("project:cancelInpainting", args),
  getProviderSettings: () => ipcRenderer.invoke("settings:getProviderSettings"),
  updateProviderSettings: (patch) => ipcRenderer.invoke("settings:updateProviderSettings", patch),
  getGeminiApiKeyStatus: () => ipcRenderer.invoke("project:getGeminiApiKeyStatus"),
  setGeminiApiKey: (args) => ipcRenderer.invoke("project:setGeminiApiKey", args),
  clearGeminiApiKey: () => ipcRenderer.invoke("project:clearGeminiApiKey"),
  extractSpeechBubbles: (args) => ipcRenderer.invoke("project:extractSpeechBubbles", args),
  applyProductionOcrReview: (args) => ipcRenderer.invoke("project:applyProductionOcrReview", args),
  cancelSpeechBubbleOcr: (args) => ipcRenderer.invoke("project:cancelSpeechBubbleOcr", args),
  testLocalAiConnection: (args) => ipcRenderer.invoke("localAi:testConnection", args),
  listLocalAiModels: (args) => ipcRenderer.invoke("localAi:listModels", args),
  translateWithLocalAi: (args) => ipcRenderer.invoke("localAi:translate", args),
  executeTranslation: (args) => ipcRenderer.invoke("translation:execute", args),
  commitTranslationProposal: (args) => ipcRenderer.invoke("translation:commitProposal", args),
  cancelTranslation: (args) => ipcRenderer.invoke("translation:cancel", args),
  inspectTranslationQa: (args) => ipcRenderer.invoke("translation:inspectQa", args),
  queryTranslationMemory: (args) => ipcRenderer.invoke("translation:queryTm", args),
  buildTranslationPayload: (args) => ipcRenderer.invoke("translation:buildPayload", args),
  getEnvironmentSnapshot: () => ipcRenderer.invoke("environment:getSnapshot"),
  chooseEnvironmentResourceRoot: () => ipcRenderer.invoke("environment:chooseResourceRoot"),
  installProductionOcr: () => ipcRenderer.invoke("environment:installProductionOcr"),
  getAutoUpdateState: () => ipcRenderer.invoke("app-update:getState"),
  checkForAutoUpdate: () => ipcRenderer.invoke("app-update:check"),
  downloadAutoUpdate: () => ipcRenderer.invoke("app-update:download"),
  installAutoUpdate: () => ipcRenderer.invoke("app-update:install"),
  openAutoUpdateRelease: () => ipcRenderer.invoke("app-update:openRelease"),
  onAutoUpdateState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on("app-update:state", wrapped);
    return () => ipcRenderer.removeListener("app-update:state", wrapped);
  },
  extractGlossaryProposals: (args) => ipcRenderer.invoke("project:extractGlossaryProposals", args),
  inspectInpaintingQa: (args) => ipcRenderer.invoke("project:inspectInpaintingQa", args),
  runBatchJob: (args) => ipcRenderer.invoke("batch:run", args),
  cancelBatchJob: (args) => ipcRenderer.invoke("batch:cancel", args),
  onBatchProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, data: BatchProgressEvent) => listener(data);
    ipcRenderer.on("batch:progress", wrapped);
    return () => ipcRenderer.removeListener("batch:progress", wrapped);
  }
};

function withoutRendererProjectPath<T extends object>(args: T): Omit<T, "projectFilePath"> {
  const { projectFilePath: _projectFilePath, ...sessionRequest } = args as T & {
    projectFilePath?: unknown;
  };
  return sessionRequest;
}

function sanitizePageImageImport(
  args: Parameters<NonNullable<ElectronProjectApi["importPageImages"]>>[0]
) {
  if ("importBatchId" in args) {
    return {
      projectSessionId: args.projectSessionId,
      importBatchId: args.importBatchId,
      pages: args.pages
    };
  }
  return withoutRendererProjectPath(args);
}

function sanitizeInpaintPageImage(
  args: Parameters<NonNullable<ElectronProjectApi["inpaintPageImage"]>>[0]
) {
  if ("projectSessionId" in args) {
    return {
      requestId: args.requestId,
      projectSessionId: args.projectSessionId,
      pageImageId: args.pageImageId,
      maskPngBase64: args.maskPngBase64,
      mode: args.mode,
      provider: args.provider,
      promptOverride: args.promptOverride,
      ...(args.options !== undefined ? { options: args.options } : {})
    };
  }
  return withoutRendererProjectPath(args);
}

contextBridge.exposeInMainWorld("projectApi", projectApi);
