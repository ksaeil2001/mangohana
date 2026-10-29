import { dialog, ipcMain, protocol } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { parseDialogueText } from "./dialogueParser.js";
import {
  reocrSpeechBubbleCropWithGemini,
  validateSpeechBubblesWithGemini
} from "./geminiSpeechBubbleExtraction.js";
import { cropImageToPng } from "./imageCrop.js";
import {
  createManualInpaintingAdapterResult,
  resolveStoredPageImagePath,
  writeInpaintedPageImageAsset,
  writeInpaintingMaskAsset
} from "./inpaintingAssets.js";
import { normalizeInpaintingImageBytes } from "./inpaintingImageGeometry.js";
import { filesystemPathIdentity, sameFilesystemPath } from "./pathIdentity.js";
import {
  createDefaultInpaintingRegistry,
  type InpaintingEngineRegistry
} from "./inpainting/inpaintingRegistry.js";
import type { GeminiApiKeyStore } from "./geminiApiKeyStore.js";
import {
  generateLocalAiTranslation,
  listLocalAiModels,
  testLocalAiConnection,
  type GenerateLocalAiTranslationArgs,
  type ListLocalAiModelsArgs,
  type LocalAiRuntime,
  type TestLocalAiConnectionArgs
} from "./localAiClient.js";
import { validateSpeechBubblesWithOpenAI } from "./openAiSpeechBubbleValidation.js";
import { extractGlossaryFromCorpus } from "./glossaryExtraction.js";
import { inspectInpaintingQa } from "./inpaintingQaInspector.js";
import { copyPageImageAsset } from "./pageImageAssets.js";
import {
  loadProjectFile,
  loadProjectFileWithRecovery,
  projectFileRequiresPassword,
  saveProjectFile
} from "./projectStorage.js";
import { createProjectSessionManager, type ProjectSessionManager } from "./projectSessions.js";
import { copyBundledExampleProject } from "./exampleProject.js";
import { createRecentProjectRegistry, type RecentProjectRegistry } from "./recentProjects.js";
import {
  exportProjectImages,
  resolveTrustedTypesetFontEvidence,
  type InstalledTypesetFontResourceVerifier,
  type TypesetExportPage
} from "./projectImageExport.js";
import { createTranslationEngineRegistry, type TranslationEngineRegistry, type TranslateExecutionOptions } from "./translation/translationEngineRegistry.js";
import { createLocalAiTranslationAdapter } from "./translation/adapters/localAiAdapter.js";
import { createGeminiTranslationAdapter } from "./translation/adapters/geminiAdapter.js";
import { createProviderSettingsStore, type ProviderSettingsStore } from "./providerSettingsStore.js";
import { createBatchExecutionCoordinator, type BatchExecutionCoordinator } from "./batch/batchExecutionCoordinator.js";
import { type BatchPipelineConfig, validateBatchPipelineConfig } from "../shared/batchAutomation.js";
import { validateProviderSettingsPatch } from "../shared/providerSettings.js";
import { evaluateProviderReadiness } from "./providerHealthCheck.js";
import {
  buildTranslationContextPayload,
  computeTranslationPayloadFingerprint,
  inspectTranslationQuality,
  createTranslationMemory,
  type InspectTranslationQaArgs,
  type TranslationContextPayload,
  type TranslationQaReport,
  type FuzzyTmCandidate
} from "../shared/translationContext.js";
import { formatTranslationTxt } from "../shared/exportTranslations.js";
import {
  buildInpaintingPrompt,
  createApprovedInpaintingPageRecord,
  isInpaintingMode,
  isInpaintingProvider
} from "../shared/inpainting.js";
import type { InpaintPageImageRequest } from "../shared/inpainting.js";
import type {
  PageImage,
  PreparedPageImage,
  ProcessingQueueStage,
  ProcessingQueueState,
  TranslationProject
} from "../shared/projectTypes.js";
import { renderReadinessBlockerCodes, type RenderReadinessReport } from "../shared/renderReadiness.js";
import type { ProjectMutation } from "../shared/projectChanges.js";
import type { ApplyProjectMutationArgs, ReviewCleanedAssetArgs } from "../shared/projectSessionTypes.js";
import { createEmptyProject, normalizeProject } from "../shared/projectValidation.js";
import type {
  ApplyProductionOcrReviewRequest,
  ExtractSpeechBubblesRequest,
  OcrCharacterContext,
  SpeechBubbleExtractionResult,
  ValidateSpeechBubbleExtractionRequest
} from "../shared/speechBubbleExtraction.js";
import {
  createOcrValidationDegradedWarning,
  extractionLanguages,
  ocrTextTypes
} from "../shared/speechBubbleExtraction.js";
import { normalizeSpeechBubbleExtractionResult } from "../shared/speechBubbleExtraction.js";
import { mergeCropReocrResults, selectCropReocrTargets } from "../shared/speechBubbleReocr.js";
import {
  approveProcessingQueueStage,
  completeProcessingQueueStage,
  createProcessingQueue,
  failProcessingQueuePage,
  processingQueueConcurrencyToken,
  type BatchProgressEvent,
  type ProcessingQueueActionArgs
} from "../shared/processingQueue.js";
import {
  createEnvironmentPreparationService,
  resolveDefaultEnvironmentResourceRoot,
  type EnvironmentPreparationService
} from "./environmentPreparation.js";
import {
  createAutoUpdateState
} from "../shared/autoUpdateStatus.js";
import type { AutoUpdateController } from "./autoUpdater.js";
import { isAbortError, throwIfAborted } from "./abortSignals.js";
import {
  createProductionOcrService,
  type ProductionOcrService
} from "./productionOcrService.js";
import {
  buildProductionOcrReviewMergePatch,
  type ProductionOcrReviewedCandidate
} from "./ocr/pipeline/productionOcrReviewMerge.js";
import { PRODUCTION_OCR_CONTRACT } from "../shared/productionOcr.js";

const pageImageProtocol = "translation-image";
const pageImageProtocolHost = "asset";
const pageImageProtocolPaths = new Map<string, string>();
const preparedPageImageProtocolIds = new Set<string>();
const projectSessionProtocolIds = new Map<string, Set<string>>();
const importBatchPreviewTokens = new Map<string, Set<string>>();
const pageImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const UNLOCK_TOKEN_TTL_MS = 5 * 60 * 1000;
let pageImageProtocolRegistered = false;

function assertPageImageSourceBytesMatch(pageImage: PageImage, imageBytes: Buffer): void {
  const actualSha256 = createHash("sha256").update(imageBytes).digest("hex");
  if (actualSha256 !== pageImage.sha256) {
    throw new Error("Page image source bytes do not match the saved SHA-256");
  }
}

export type IpcRendererLifecycleController = {
  cleanupRenderer: (ownerId: number) => Promise<void>;
  retryPendingSessionCleanups: () => Promise<void>;
};

type OwnedAbortController = {
  ownerId: number;
  controller: AbortController;
};

type OwnedBatchRequest = {
  ownerId: number;
  projectSessionId?: string;
};

export function registerIpcHandlers({
  geminiApiKeyStore,
  projectSessionManager = createProjectSessionManager(),
  recentProjectRegistry = createRecentProjectRegistry(),
  inpaintingEngineRegistry = createDefaultInpaintingRegistry(),
  translationEngineRegistry = createTranslationEngineRegistry([
    createLocalAiTranslationAdapter(),
    createGeminiTranslationAdapter(geminiApiKeyStore)
  ]),
  providerSettingsStore = createProviderSettingsStore(),
  appVersion = "0.1.0",
  defaultProjectDirectory = process.cwd(),
  exampleProjectDirectory,
  exampleTemporaryDirectory,
  environmentPreparationService,
  productionOcrService,
  autoUpdateController,
  verifyInstalledTypesetFontResource,
  batchExecutionCoordinator
}: {
  geminiApiKeyStore: GeminiApiKeyStore;
  projectSessionManager?: ProjectSessionManager;
  recentProjectRegistry?: RecentProjectRegistry;
  inpaintingEngineRegistry?: InpaintingEngineRegistry;
  translationEngineRegistry?: TranslationEngineRegistry;
  providerSettingsStore?: ProviderSettingsStore;
  appVersion?: string;
  defaultProjectDirectory?: string;
  exampleProjectDirectory?: string;
  exampleTemporaryDirectory?: string;
  environmentPreparationService?: EnvironmentPreparationService;
  productionOcrService?: ProductionOcrService;
  autoUpdateController?: AutoUpdateController;
  verifyInstalledTypesetFontResource?: InstalledTypesetFontResourceVerifier;
  batchExecutionCoordinator?: BatchExecutionCoordinator;
}): IpcRendererLifecycleController {
  registerPageImageProtocol();
  const pendingUnlocks = new Map<string, {
    filePath: string;
    expiresAt: number;
    ownerId: number;
    recent: boolean;
  }>();
  const activeTranslationControllers = new Map<string, OwnedAbortController>();
  const activeOcrControllers = new Map<string, OwnedAbortController>();
  const activeInpaintingControllers = new Map<string, OwnedAbortController>();
  const rendererSessions = new Map<number, Set<string>>();
  const sessionOwners = new Map<string, number>();
  const inactiveRendererOwners = new Set<number>();
  const rendererCleanupPromises = new Map<number, Promise<void>>();
  const pendingSessionCleanups = new Map<string, { lastError: unknown }>();
  const closingSessionPromises = new Map<string, Promise<void>>();
  const activeBatchRequests = new Map<string, OwnedBatchRequest>();

  function rendererOwnerId(event: unknown): number {
    return isRecord(event) && isRecord(event.sender) && typeof event.sender.id === "number"
      ? event.sender.id
      : 0;
  }

  function trackSession(ownerId: number, projectSessionId: string): void {
    const sessions = rendererSessions.get(ownerId) ?? new Set<string>();
    sessions.add(projectSessionId);
    rendererSessions.set(ownerId, sessions);
    sessionOwners.set(projectSessionId, ownerId);
  }

  function untrackSession(projectSessionId: string): void {
    const ownerId = sessionOwners.get(projectSessionId);
    if (ownerId === undefined) return;
    sessionOwners.delete(projectSessionId);
    const sessions = rendererSessions.get(ownerId);
    sessions?.delete(projectSessionId);
    if (sessions?.size === 0) rendererSessions.delete(ownerId);
  }

  async function closeAndReleaseSession(projectSessionId: string): Promise<void> {
    try {
      await batchCoordinator.cancelSessionExecutions(projectSessionId);
      await projectSessionManager.closeProject({ projectSessionId });
      releaseProjectSessionPageImages(projectSessionId);
      untrackSession(projectSessionId);
      pendingSessionCleanups.delete(projectSessionId);
    } catch (error) {
      rememberMainOwnedSessionCleanup(projectSessionId, error);
      throw error;
    }
  }

  function closeSession(projectSessionId: string, retryPendingFirst = false): Promise<void> {
    const existing = closingSessionPromises.get(projectSessionId);
    if (existing) return existing;
    const closing = Promise.resolve().then(async () => {
      if (retryPendingFirst) await retryPendingSessionCleanups(true);
      await closeAndReleaseSession(projectSessionId);
    }).finally(() => {
      if (closingSessionPromises.get(projectSessionId) === closing) {
        closingSessionPromises.delete(projectSessionId);
      }
    });
    closingSessionPromises.set(projectSessionId, closing);
    return closing;
  }

  function rememberMainOwnedSessionCleanup(projectSessionId: string, error: unknown): void {
    untrackSession(projectSessionId);
    pendingSessionCleanups.set(projectSessionId, { lastError: error });
  }

  async function retryPendingSessionCleanups(
    propagateFailure = false,
    excludedSessionIds?: ReadonlySet<string>
  ): Promise<void> {
    for (const projectSessionId of [...pendingSessionCleanups.keys()]) {
      if (excludedSessionIds?.has(projectSessionId) || closingSessionPromises.has(projectSessionId)) continue;
      try {
        await closeSession(projectSessionId);
      } catch (error) {
        if (propagateFailure) throw error;
      }
    }
  }

  function pendingCleanupErrorForFile(filePath: string): Error | undefined {
    for (const [projectSessionId, pending] of pendingSessionCleanups) {
      let sessionPath: string | undefined;
      try {
        sessionPath = projectSessionManager.getFilePath(projectSessionId);
      } catch {
        pendingSessionCleanups.delete(projectSessionId);
        continue;
      }
      if (!sessionPath || !sameFilesystemPath(sessionPath, filePath)) continue;
      const reason = pending.lastError instanceof Error ? pending.lastError.message : String(pending.lastError);
      return new Error(`이전 프로젝트 세션을 닫지 못해 같은 프로젝트를 열 수 없습니다: ${reason}`);
    }
    return undefined;
  }

  function assertRendererOwnerActive(ownerId: number): void {
    if (inactiveRendererOwners.has(ownerId)) {
      throw new DOMException("Renderer owner is no longer active.", "AbortError");
    }
  }

  function assertSessionOwner(ownerId: number, projectSessionId: string): void {
    const sessionOwner = sessionOwners.get(projectSessionId);
    if (sessionOwner !== undefined && sessionOwner !== ownerId) {
      throw new Error("Project session belongs to another renderer");
    }
  }

  function assertOwnedSession(event: unknown, projectSessionId: string): number {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    assertSessionOwner(ownerId, projectSessionId);
    return ownerId;
  }

  function assertOwnedResultSession(event: unknown, projectSessionId: string): void {
    const ownerId = assertOwnedSession(event, projectSessionId);
    if (sessionOwners.get(projectSessionId) !== ownerId) {
      throw new Error("Project session is not owned by this renderer");
    }
    if (closingSessionPromises.has(projectSessionId) || pendingSessionCleanups.has(projectSessionId)) {
      throw new Error("PROJECT_SESSION_CLOSING");
    }
  }

  function assertBatchSessionOpen(projectSessionId: string): void {
    if (closingSessionPromises.has(projectSessionId) || pendingSessionCleanups.has(projectSessionId)) {
      throw new Error("닫는 중이거나 정리를 기다리는 프로젝트에서는 Batch를 시작할 수 없습니다.");
    }
  }
  function getProjectSaveDirectory(): string {
    const configured = providerSettingsStore.getSettings().defaultStoragePath.trim();
    if (configured && isAbsolute(configured)) return configured;
    return recentProjectRegistry.getLastProjectDirectory() ?? defaultProjectDirectory;
  }
  const batchCoordinator =
    batchExecutionCoordinator ??
    createBatchExecutionCoordinator({
      translationEngineRegistry,
      providerSettingsStore,
      projectSessionManager
    });
  const productionOcr = productionOcrService ?? createProductionOcrService({
    resourcesPath: process.cwd(),
    initialResourceRoot: resolveDefaultEnvironmentResourceRoot({
      localAppData: process.env.LOCALAPPDATA,
      fallbackRoot: process.env.APPDATA ?? process.cwd()
    })
  });
  const environmentService =
    environmentPreparationService ??
    createEnvironmentPreparationService({
      resourceRoot: resolveDefaultEnvironmentResourceRoot({
        localAppData: process.env.LOCALAPPDATA,
        fallbackRoot: process.env.APPDATA ?? process.cwd()
      }),
      appVersion,
      getProviderStatus: async () => {
        const geminiConfigured = geminiApiKeyStore.getStatus().configured;
        const openAiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
        const settings = providerSettingsStore.getSettings();
        const productionOcrStatus = await productionOcr.getStatus();
        return evaluateProviderReadiness({
          geminiConfigured,
          openAiConfigured,
          productionOcrStatus,
          translationEngine: settings.translationEngine,
          localAiRuntime: settings.localAiRuntime,
          localAiEndpoint: settings.localAiEndpoint,
          selectedModel: settings.translationEngine === "local_ai" ? settings.localAiModel : undefined,
          localOcrEndpoint: settings.ocrEndpoint,
          mangaOcrEndpoint: settings.mangaOcrEndpoint ?? settings.ocrEndpoint,
          paddleOcrEndpoint: settings.paddleOcrEndpoint,
          localInpaintingProvider: settings.localInpaintingProvider,
          localInpaintingEndpoint: settings.localInpaintingEndpoint
        });
      }
    });

  function registerImportBatchPreviews(
    projectSessionId: string,
    batch: {
      importBatchId: string;
      images: Array<{ preparedImageId: string; previewToken: string }>;
    }
  ): void {
    const tokens = new Set<string>();
    const sessionTokens =
      projectSessionProtocolIds.get(projectSessionId) ?? new Set<string>();
    for (const image of batch.images) {
      pageImageProtocolPaths.set(
        image.previewToken,
        projectSessionManager.getPreparedPageImagePath(
          projectSessionId,
          image.preparedImageId
        )
      );
      preparedPageImageProtocolIds.add(image.previewToken);
      sessionTokens.add(image.previewToken);
      tokens.add(image.previewToken);
    }
    projectSessionProtocolIds.set(projectSessionId, sessionTokens);
    importBatchPreviewTokens.set(
      importBatchPreviewKey(projectSessionId, batch.importBatchId),
      tokens
    );
  }

  function releaseImportBatchPreviews(
    projectSessionId: string,
    importBatchId: string
  ): void {
    const key = importBatchPreviewKey(projectSessionId, importBatchId);
    const tokens = importBatchPreviewTokens.get(key);
    if (!tokens) return;
    const sessionTokens = projectSessionProtocolIds.get(projectSessionId);
    for (const token of tokens) {
      pageImageProtocolPaths.delete(token);
      preparedPageImageProtocolIds.delete(token);
      sessionTokens?.delete(token);
    }
    importBatchPreviewTokens.delete(key);
  }

  async function releaseUnavailableImportBatchPreviews(
    projectSessionId: string
  ): Promise<void> {
    const prefix = `${projectSessionId}\0`;
    const sessionTokens = projectSessionProtocolIds.get(projectSessionId);
    for (const [key, tokens] of importBatchPreviewTokens) {
      if (!key.startsWith(prefix)) continue;
      for (const token of [...tokens]) {
        const previewPath = pageImageProtocolPaths.get(token);
        try {
          if (previewPath && (await pathExists(previewPath))) continue;
        } catch {
          continue;
        }
        tokens.delete(token);
        sessionTokens?.delete(token);
        pageImageProtocolPaths.delete(token);
        preparedPageImageProtocolIds.delete(token);
      }
      if (tokens.size === 0) importBatchPreviewTokens.delete(key);
    }
  }

  ipcMain.handle("environment:getSnapshot", async () => await environmentService.getSnapshot());

  ipcMain.handle("environment:chooseResourceRoot", async () => {
    const selection = await dialog.showOpenDialog({
      title: "TRIO 리소스 저장 위치",
      properties: ["openDirectory", "createDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    await productionOcr.setResourceRoot(selection.filePaths[0]);
    return await environmentService.setResourceRoot(selection.filePaths[0]);
  });

  ipcMain.handle("environment:installProductionOcr", async () => {
    await productionOcr.installOrRepair();
    return await environmentService.getSnapshot();
  });

  const unavailableAutoUpdateState = () =>
    createAutoUpdateState("unavailable", {
      message: "업데이트 확인은 설치된 망고하나 앱에서 사용할 수 있습니다."
    });
  ipcMain.handle("app-update:getState", () => autoUpdateController?.getState() ?? unavailableAutoUpdateState());
  ipcMain.handle("app-update:check", async () => autoUpdateController?.checkForUpdates() ?? unavailableAutoUpdateState());
  ipcMain.handle("app-update:download", async () => autoUpdateController?.downloadUpdate() ?? unavailableAutoUpdateState());
  ipcMain.handle("app-update:install", () => autoUpdateController?.installUpdate() ?? unavailableAutoUpdateState());
  ipcMain.handle("app-update:openRelease", async () => {
    await autoUpdateController?.openRelease();
  });

  ipcMain.handle("settings:getProviderSettings", () => providerSettingsStore.getSettings());
  ipcMain.handle("settings:updateProviderSettings", (_event, args) => {
    const validatedPatch = validateProviderSettingsPatch(args);
    return providerSettingsStore.updateSettings(validatedPatch);
  });

  ipcMain.handle("project:getGeminiApiKeyStatus", () => geminiApiKeyStore.getStatus());

  ipcMain.handle("project:setGeminiApiKey", async (_event, args) => {
    const apiKey = validateGeminiApiKeyArgs(args).apiKey;
    return geminiApiKeyStore.set(apiKey);
  });

  ipcMain.handle("project:clearGeminiApiKey", () => geminiApiKeyStore.clear());

  ipcMain.handle("project:importTxtFile", async () => {
    const selection = await dialog.showOpenDialog({
      title: "대사 TXT 불러오기",
      properties: ["openFile"],
      filters: [{ name: "TXT 파일", extensions: ["txt"] }]
    });

    if (selection.canceled || !selection.filePaths[0]) return null;
    const filePath = selection.filePaths[0];
    assertFileExtension(filePath, ".txt", "Imported dialogue file must be a .txt file");
    const content = await readFile(filePath, "utf8");
    return { filePath, lines: parseDialogueText(content) };
  });

  ipcMain.handle("project:createSession", async (event, args) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    await retryPendingSessionCleanups();
    const createArgs = validateCreateSessionArgs(args);
    const project = createEmptyProject(createArgs.title, createArgs.secret);
    if (createArgs.secret) {
      const { protectionBuffers: _protectionBuffers, ...result } =
        projectSessionManager.createSecretProjectSession({
          project,
          password: requireNonEmptyString(createArgs.password, "password")
        });
      trackSession(ownerId, result.projectSessionId);
      return result;
    }
    const result = projectSessionManager.createProjectSession({ project });
    trackSession(ownerId, result.projectSessionId);
    return result;
  });

  ipcMain.handle("project:openFromDialog", async (event) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    const filePath = await chooseProjectFile(
      recentProjectRegistry.getLastProjectDirectory() ?? defaultProjectDirectory
    );
    return filePath ? openProjectSession(filePath, ownerId, false) : null;
  });

  ipcMain.handle("project:openRecent", async (event, args) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    const recentProjectId = validateIdRequest(args, "recentProjectId");
    try {
      return await openProjectSession(
        recentProjectRegistry.resolve(recentProjectId),
        ownerId,
        true
      );
    } catch (error) {
      return classifyProjectOpenFailure(error);
    }
  });

  ipcMain.handle("project:openExample", async (event, ...args) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    if (args.length) throw new Error("예시 프로젝트 열기는 인수를 받지 않습니다.");
    if (!exampleProjectDirectory) throw new Error("배포된 예시 프로젝트 경로가 준비되지 않았습니다.");
    const copy = await copyBundledExampleProject({
      resourceDirectory: exampleProjectDirectory,
      temporaryDirectory: exampleTemporaryDirectory
    });
    let openedSessionId: string | undefined;
    try {
      assertRendererOwnerActive(ownerId);
      const result = await openProjectSession(copy.filePath, ownerId, false);
      if (!("projectSessionId" in result)) {
        pendingUnlocks.delete(result.unlockToken);
        throw new Error("배포된 예시 프로젝트에 암호를 요청할 수 없습니다.");
      }
      openedSessionId = result.projectSessionId;
      assertRendererOwnerActive(ownerId);
      return result;
    } catch (error) {
      if (openedSessionId && sessionOwners.has(openedSessionId)) {
        try {
          await closeSession(openedSessionId);
        } catch (closeError) {
          throw new AggregateError([error, closeError], "예시 프로젝트 세션 정리에 실패해 임시 복사본을 보존했습니다.");
        }
      }
      // A failed regular close remains Main-owned for retry. Keep its files intact.
      if (pendingCleanupErrorForFile(copy.filePath)) throw error;
      try {
        await copy.removeFailedCopy();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "예시 프로젝트 열기 실패 후 임시 폴더 정리도 실패했습니다.");
      }
      throw error;
    }
  });

  ipcMain.handle("project:unlock", async (event, args) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    if (!isRecord(args)) throw new Error("Invalid unlock request: expected object");
    const unlockToken = requireNonEmptyString(args.unlockToken, "unlockToken");
    const password = requireNonEmptyString(args.password, "password");
    const pendingUnlock = pendingUnlocks.get(unlockToken);
    if (!pendingUnlock || pendingUnlock.expiresAt <= Date.now() || pendingUnlock.ownerId !== ownerId) {
      pendingUnlocks.delete(unlockToken);
      throw new Error("Invalid or expired unlock token");
    }
    let loaded: Awaited<ReturnType<typeof loadProjectFileWithRecovery>>;
    try {
      loaded = await loadProjectFileWithRecovery({
        filePath: pendingUnlock.filePath,
        password
      });
    } catch (error) {
      if (pendingUnlock.recent) return classifyProjectOpenFailure(error);
      throw error;
    }
    pendingUnlocks.delete(unlockToken);
    return createOpenedProjectSession({
      ownerId,
      filePath: pendingUnlock.filePath,
      loaded
    });
  });

  ipcMain.handle("project:applyMutation", (event, args) => {
    const mutationArgs = validateApplyMutationArgs(args);
    assertOwnedSession(event, mutationArgs.projectSessionId);
    return projectSessionManager.applyProjectMutation(mutationArgs);
  });

  ipcMain.handle("project:reviewCleanedAsset", (event, args) => {
    const reviewArgs = validateReviewCleanedAssetArgs(args);
    const assertOwner = () => assertOwnedResultSession(event, reviewArgs.projectSessionId);
    assertOwner();
    return projectSessionManager.reviewCleanedAsset(reviewArgs, assertOwner);
  });

  ipcMain.handle("project:hydratePage", (event, args) => {
    if (!isRecord(args)) throw new Error("Invalid page hydration request");
    const projectSessionId = requireNonEmptyString(args.projectSessionId, "projectSessionId");
    assertOwnedSession(event, projectSessionId);
    const pageNumber = requirePositiveInteger(args.pageNumber, "pageNumber");
    const prefetchRadius =
      typeof args.prefetchRadius === "number" && args.prefetchRadius >= 0
        ? Math.floor(args.prefetchRadius)
        : undefined;
    return projectSessionManager.hydratePage({
      projectSessionId,
      pageNumber,
      prefetchRadius
    });
  });

  ipcMain.handle("project:prefetchPages", (event, args) => {
    if (!isRecord(args)) throw new Error("Invalid page prefetch request");
    const projectSessionId = requireNonEmptyString(args.projectSessionId, "projectSessionId");
    assertOwnedSession(event, projectSessionId);
    const pageNumber = requirePositiveInteger(args.pageNumber, "pageNumber");
    const radius =
      typeof args.radius === "number" && args.radius >= 0
        ? Math.floor(args.radius)
        : undefined;
    return projectSessionManager.prefetchPages({
      projectSessionId,
      pageNumber,
      radius
    });
  });


  ipcMain.handle("project:save", async (event, args) => {
    if (isRecord(args) && typeof args.projectSessionId === "string" && !("project" in args)) {
      const projectSessionId = requireNonEmptyString(
        args.projectSessionId,
        "projectSessionId"
      );
      assertOwnedSession(event, projectSessionId);
      const result = await projectSessionManager.saveProject({
        projectSessionId
      });
      await releaseUnavailableImportBatchPreviews(projectSessionId);
      const filePath = projectSessionManager.getFilePath(projectSessionId);
      const recentProject = filePath
        ? recentProjectRegistry.remember(filePath, result.project.project.metadata.title)
        : undefined;
      return recentProject ? { ...result, recentProject } : result;
    }
    const saveArgs = validateSaveProjectArgs(args);
    await saveProjectFile(saveArgs);
    recentProjectRegistry.remember(saveArgs.filePath, saveArgs.project.metadata.title);
  });

  ipcMain.handle("project:saveAs", async (event, args) => {
    const projectSessionId = validateIdRequest(args, "projectSessionId");
    assertOwnedSession(event, projectSessionId);
    const project = projectSessionManager.getProject(projectSessionId);
    const requestedFilePath = isRecord(args) && typeof args.filePath === "string" && args.filePath.trim()
      ? args.filePath
      : null;
    const filePath = requestedFilePath ?? await chooseSaveProjectFile(
      resolveProjectSaveDefaultPath(
        `${project.project.metadata.title || "새 프로젝트"}.ctp`,
        getProjectSaveDirectory()
      )
    );
    if (!filePath) return null;
    assertProjectFilePath(filePath);
    const result = await projectSessionManager.saveProjectAs({ projectSessionId, filePath });
    await releaseUnavailableImportBatchPreviews(projectSessionId);
    const recentProject = recentProjectRegistry.remember(
      filePath,
      result.project.project.metadata.title
    );
    return { ...result, recentProject };
  });

  ipcMain.handle("project:rekey", (event, args) => {
    if (!isRecord(args)) throw new Error("Invalid rekey request: expected object");
    const projectSessionId = requireNonEmptyString(args.projectSessionId, "projectSessionId");
    assertOwnedSession(event, projectSessionId);
    return projectSessionManager.rekeyProject({
      projectSessionId,
      newPassword: requireNonEmptyString(args.newPassword, "newPassword")
    });
  });

  ipcMain.handle("project:close", async (event, args) => {
    const projectSessionId = validateIdRequest(args, "projectSessionId");
    const ownerId = rendererOwnerId(event);
    const sessionOwner = sessionOwners.get(projectSessionId);
    if (sessionOwner !== undefined && sessionOwner !== ownerId) {
      throw new Error("Project session belongs to another renderer");
    }
    await closeSession(projectSessionId, true);
  });
  ipcMain.handle("project:listRecent", () => recentProjectRegistry.list());
  ipcMain.handle("project:removeRecent", (_event, args) =>
    recentProjectRegistry.remove(validateIdRequest(args, "recentProjectId"))
  );

  ipcMain.handle("project:chooseSaveFile", async (_event, args) => {
    const saveArgs = validateChooseSaveFileArgs(args);
    return chooseSaveProjectFile(
      resolveProjectSaveDefaultPath(
        saveArgs.defaultPath,
        getProjectSaveDirectory()
      )
    );
  });

  ipcMain.handle("project:choosePageImageFiles", async () => {
    return choosePageImageFiles();
  });

  ipcMain.handle("project:choosePageImages", async (event, args) => {
    const projectSessionId = validateIdRequest(args, "projectSessionId");
    assertOwnedSession(event, projectSessionId);
    const sourcePaths = await choosePageImageFiles();
    if (!sourcePaths) return null;
    const batch = await projectSessionManager.preparePageImages({
      projectSessionId,
      sourcePaths
    });
    registerImportBatchPreviews(projectSessionId, batch);
    return batch;
  });

  ipcMain.handle("project:preparePageImages", async (event, args) => {
    if (!isRecord(args)) {
      throw new Error("Invalid page image preparation request");
    }
    const projectSessionId = requireNonEmptyString(
      args.projectSessionId,
      "projectSessionId"
    );
    assertOwnedSession(event, projectSessionId);
    const sourcePaths = validateStringArray(
      args.sourcePaths,
      "page image preparation"
    );
    const batch = await projectSessionManager.preparePageImages({
      projectSessionId,
      sourcePaths
    });
    registerImportBatchPreviews(projectSessionId, batch);
    return batch;
  });

  ipcMain.handle("project:releasePageImageImportBatch", async (event, args) => {
    if (!isRecord(args)) {
      throw new Error("Invalid page image import release request");
    }
    const projectSessionId = requireNonEmptyString(
      args.projectSessionId,
      "projectSessionId"
    );
    assertOwnedSession(event, projectSessionId);
    const importBatchId = requireNonEmptyString(
      args.importBatchId,
      "importBatchId"
    );
    await projectSessionManager.releasePageImageImportBatch({
      projectSessionId,
      importBatchId
    });
    releaseImportBatchPreviews(projectSessionId, importBatchId);
  });

  ipcMain.handle("project:choosePreparedPageImageFiles", async () => {
    const sourcePaths = await choosePageImageFiles();
    return sourcePaths ? preparePageImageFiles(sourcePaths) : null;
  });

  ipcMain.handle("project:preparePageImageFiles", async (_event, args) => {
    return preparePageImageFiles(validateStringArray(args, "page image preparation"));
  });

  ipcMain.handle("project:releasePreparedPageImages", (_event, args) => {
    releasePreparedPageImages(validateStringArray(args, "page image release"));
  });

  ipcMain.handle("project:open", async (_event, args) => {
    const openArgs = validateOpenProjectArgs(args);
    const filePath = openArgs.filePath ?? (await chooseProjectFile(
      recentProjectRegistry.getLastProjectDirectory() ?? defaultProjectDirectory
    ));
    if (!filePath) return null;
    assertProjectFilePath(filePath);
    let loaded;
    try {
      loaded = await loadProjectFile({ filePath, password: openArgs.password });
    } catch (error) {
      if (!openArgs.password && error instanceof Error && /password is required/i.test(error.message)) {
        return { filePath, encrypted: true, passwordRequired: true };
      }
      throw error;
    }
    recentProjectRegistry.remember(filePath, loaded.project.metadata.title);
    return { filePath, project: loaded.project, encrypted: loaded.encrypted };
  });

  async function openProjectSession(filePath: string, ownerId: number, recent: boolean) {
    assertProjectFilePath(filePath);
    if (await projectFileRequiresPassword(filePath)) {
      return createPendingUnlock(filePath, ownerId, recent);
    }
    try {
      const loaded = await loadProjectFileWithRecovery({ filePath });
      return createOpenedProjectSession({ ownerId, filePath, loaded });
    } catch (error) {
      if (error instanceof Error && /password is required/i.test(error.message)) {
        return createPendingUnlock(filePath, ownerId, recent);
      }
      throw error;
    }
  }

  async function createOpenedProjectSession(args: {
    ownerId: number;
    filePath: string;
    loaded: Awaited<ReturnType<typeof loadProjectFileWithRecovery>>;
  }) {
    await retryPendingSessionCleanups();
    const blocked = pendingCleanupErrorForFile(args.filePath);
    if (blocked) throw blocked;
    const result = projectSessionManager.createProjectSession({
      project: args.loaded.project,
      filePath: args.filePath,
      protection: args.loaded.protection,
      security: args.loaded.security,
      artifactKeyPersisted: args.loaded.artifactKeyPersisted
    });
    trackSession(args.ownerId, result.projectSessionId);
    try {
      const resumedProject = await projectSessionManager.resumePageImageImports(
        result.projectSessionId
      );
      const recentProject = recentProjectRegistry.remember(
        args.filePath,
        args.loaded.project.metadata.title
      );
      return { ...result, project: resumedProject, recentProject };
    } catch (error) {
      try {
        await closeSession(result.projectSessionId);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Opened project session cleanup failed"
        );
      }
      throw error;
    }
  }

  function createPendingUnlock(filePath: string, ownerId: number, recent: boolean) {
    const unlockToken = randomUUID();
    const expiresAt = Date.now() + UNLOCK_TOKEN_TTL_MS;
    pendingUnlocks.set(unlockToken, { filePath, expiresAt, ownerId, recent });
    const expiryTimer = setTimeout(() => {
      const pending = pendingUnlocks.get(unlockToken);
      if (pending?.expiresAt === expiresAt) pendingUnlocks.delete(unlockToken);
    }, UNLOCK_TOKEN_TTL_MS);
    expiryTimer.unref();
    return { unlockToken, encrypted: true as const, passwordRequired: true as const };
  }

  ipcMain.handle("project:exportTranslations", async (event, args) => {
    const projectSessionId =
      isRecord(args) && typeof args.projectSessionId === "string"
        ? args.projectSessionId
        : undefined;
    if (projectSessionId) assertOwnedSession(event, projectSessionId);
    const exportArgs = validateExportTranslationsArgs(
      projectSessionId
        ? {
            ...args,
            filePath: undefined,
            project: projectSessionManager.getProject(projectSessionId).project
          }
        : args
    );
    const filePath = exportArgs.filePath ?? (await chooseTranslationExportFile(exportArgs.defaultPath));
    if (!filePath) return null;
    assertTextFilePath(filePath);
    await writeFile(filePath, formatTranslationTxt(exportArgs.project), "utf8");
    return filePath;
  });

  ipcMain.handle("project:exportImages", async (event, args) => {
    const exportArgs = validateExportProjectImagesArgs(args);
    const assertOwner = () => assertOwnedResultSession(event, exportArgs.projectSessionId);
    assertOwner();
    const exportRoot = await chooseProjectImageExportDirectory(exportArgs.defaultPath);
    if (!exportRoot) return null;
    const typesetPages: TypesetExportPage[] = exportArgs.typesetPages.map((page) => ({
      pageImageId: page.pageImageId,
      pngBytes: Buffer.from(page.pngBase64, "base64"),
      readiness: page.readiness
    }));
    const trustedTypesetFontEvidence = await resolveExportTypesetFontEvidence(
      typesetPages,
      verifyInstalledTypesetFontResource
    );
    // Dialog/font verification can outlive a page change, save-as, review or session close.
    assertOwner();
    const snapshot = await projectSessionManager.captureImageExportSnapshot({ projectSessionId: exportArgs.projectSessionId }, assertOwner);
    return exportProjectImages({
      ...snapshot,
      exportRoot,
      typesetPages,
      trustedTypesetFontEvidence,
      includeZip: exportArgs.includeZip
    });
  });

  ipcMain.handle("project:updateProcessingQueue", async (event, args) => {
    const queueArgs = validateProcessingQueueActionArgs(args);
    assertOwnedSession(event, queueArgs.projectSessionId);
    const targetsQueue = queueArgs.action === "pause" || queueArgs.action === "cancel" ||
      queueArgs.action === "resume" || queueArgs.action === "retry";
    if (targetsQueue) {
      assertBatchSessionOpen(queueArgs.projectSessionId);
    }
    const current = projectSessionManager.getProject(queueArgs.projectSessionId);
    if (targetsQueue) {
      const existing = current.project.processing.queue;
      if (!existing) throw new Error("먼저 processing queue를 만들어야 합니다.");
      if (existing.queueId !== queueArgs.queueId) throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
    }
    const now = new Date().toISOString();
    let queue: ProcessingQueueState;

    if (queueArgs.action === "resume") {
      await batchCoordinator.resumeProcessingQueue({
        projectSessionId: queueArgs.projectSessionId,
        queueId: queueArgs.queueId
      });
      const result = projectSessionManager.getProject(queueArgs.projectSessionId);
      if (result.project.processing.queue?.queueId !== queueArgs.queueId) throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
      return { project: result, queue: result.project.processing.queue };
    }
    if (queueArgs.action === "retry") {
      await batchCoordinator.retryProcessingQueuePage({
        projectSessionId: queueArgs.projectSessionId,
        queueId: queueArgs.queueId,
        pageImageId: requireNonEmptyString(queueArgs.pageImageId, "pageImageId"),
        revision: requireNonNegativeInteger(queueArgs.revision, "revision")
      });
      const result = projectSessionManager.getProject(queueArgs.projectSessionId);
      if (result.project.processing.queue?.queueId !== queueArgs.queueId) throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
      return { project: result, queue: result.project.processing.queue };
    }
    if (queueArgs.action === "start") {
      throw new Error("현재 queue 단계에 연결된 실행 작업이 없습니다.");
    }
    if (queueArgs.action === "pause" || queueArgs.action === "cancel") {
      return await batchCoordinator.controlProcessingQueue({
        projectSessionId: queueArgs.projectSessionId,
        queueId: queueArgs.queueId,
        action: queueArgs.action,
        reason: queueArgs.reason
      });
    }

    if (queueArgs.action === "create") {
      const existing = current.project.processing.queue;
      if (existing && (existing.status === "running" || existing.status === "paused")) {
        throw new Error("프로젝트에는 활성 queue를 하나만 만들 수 있습니다.");
      }
      const pageImageIds = queueArgs.pageImageIds?.length
        ? queueArgs.pageImageIds
        : current.project.pageImages
          .slice()
          .sort((left, right) => left.pageNumber - right.pageNumber)
          .map((page) => page.id);
      queue = createProcessingQueue({
        queueId: randomUUID(),
        projectSessionId: queueArgs.projectSessionId,
        pageImageIds,
        revision: current.revision + 1,
        now
      });
    } else {
      if (!current.project.processing.queue) throw new Error("먼저 processing queue를 만들어야 합니다.");
      const existing = current.project.processing.queue;
      switch (queueArgs.action) {
        case "complete_stage":
          queue = completeProcessingQueueStage(existing, {
            pageImageId: requireNonEmptyString(queueArgs.pageImageId, "pageImageId"),
            stage: requireProcessingQueueStage(queueArgs.stage),
            revision: requireNonNegativeInteger(queueArgs.revision, "revision"),
            runId: queueArgs.runId,
            now
          });
          break;
        case "approve_stage":
          queue = approveProcessingQueueStage(existing, {
            pageImageId: requireNonEmptyString(queueArgs.pageImageId, "pageImageId"),
            stage: requireProcessingQueueStage(queueArgs.stage),
            now
          });
          break;
        case "fail":
          if (!queueArgs.error) throw new Error("queue failure requires an error");
          queue = failProcessingQueuePage(existing, {
            pageImageId: requireNonEmptyString(queueArgs.pageImageId, "pageImageId"),
            revision: requireNonNegativeInteger(queueArgs.revision, "revision"),
            now,
            error: queueArgs.error
          });
          break;
      }
    }

    const sessionResult = await projectSessionManager.commitMainProjectPatch({
      projectSessionId: queueArgs.projectSessionId,
      patch: {
        type: "update_processing_queue",
        queue,
        ...(current.project.processing.queue
          ? {
              expectedQueueId: current.project.processing.queue.queueId,
              expectedQueueToken: processingQueueConcurrencyToken(current.project.processing.queue)
            }
          : {})
      }
    });
    return {
      project: sessionResult.project,
      queue: sessionResult.project.project.processing.queue
    };
  });

  ipcMain.handle("project:importPageImages", async (event, args) => {
    if (isOpaquePageImageImportArgs(args)) {
      assertOwnedSession(event, args.projectSessionId);
      return projectSessionManager.linkPageImages(args);
    }
    const projectSessionId =
      isRecord(args) && typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    const imageArgs = validateImportPageImagesArgs(
      projectSessionId
        ? { ...args, projectFilePath: projectSessionManager.getFilePath(projectSessionId) }
        : args
    );
    const results = [];

    for (const file of imageArgs.files) {
      try {
        const result = await copyPageImageAsset({
          sourcePath: file.sourcePath,
          projectFilePath: imageArgs.projectFilePath,
          pageNumber: file.pageNumber
        });
        results.push({ ok: true as const, pageImage: result.pageImage });
      } catch (error) {
        results.push({
          ok: false as const,
          sourcePath: file.sourcePath,
          message: error instanceof Error ? error.message : "Failed to import image"
        });
      }
    }

    if (projectSessionId) {
      await projectSessionManager.registerImportedPageImages({
        projectSessionId,
        pageImages: results.flatMap((result) => (result.ok ? [result.pageImage] : []))
      });
    }
    return results;
  });

  ipcMain.handle("project:inpaintPageImage", async (event, args) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    const requestId = isRecord(args) ? requireNonEmptyString(args.requestId, "requestId") : "";
    if (activeInpaintingControllers.has(requestId)) throw new Error("An inpainting request with this ID is already active");
    const controller = new AbortController();
    activeInpaintingControllers.set(requestId, { ownerId, controller });
    try {
    const projectSessionId =
      isRecord(args) && typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    if (projectSessionId) assertOwnedSession(event, projectSessionId);
    if (projectSessionId) {
      assertSessionOwner(ownerId, projectSessionId);
      projectSessionManager.assertPageImageReadyForProcessing({
        projectSessionId,
        pageImageId: requirePageImageId(args)
      });
    }
    const inpaintArgs = validateInpaintPageImageArgs(
      projectSessionId
        ? {
            ...args,
            projectFilePath: projectSessionManager.getFilePath(projectSessionId),
            pageImage: projectSessionManager.getPageImage(
              projectSessionId,
              requirePageImageId(args)
            )
          }
        : args
    );
    const imagePath = resolveStoredPageImagePath({
      projectFilePath: inpaintArgs.projectFilePath,
      storedRelativePath: inpaintArgs.pageImage.storedRelativePath
    });
    const [imageBytes, maskBytes] = await Promise.all([
      readFile(imagePath),
      Promise.resolve(Buffer.from(inpaintArgs.maskPngBase64, "base64"))
    ]);
    assertPageImageSourceBytesMatch(inpaintArgs.pageImage, imageBytes);
    const provider = inpaintArgs.provider ?? "openai";
    const executionResult = await inpaintingEngineRegistry.execute(provider, {
      imageBytes,
      maskBytes,
      mode: inpaintArgs.mode,
      sourceMimeType: inpaintArgs.pageImage.mimeType,
      promptOverride: inpaintArgs.promptOverride,
      options: inpaintArgs.options,
      signal: controller.signal
    });
    throwIfAborted(controller.signal);
    assertRendererOwnerActive(ownerId);
    const normalizedImageBytes = normalizeInpaintingImageBytes({
      sourceImageBytes: imageBytes,
      editedImageBytes: executionResult.editedImageBytes
    });
    const inpaintingQa = await inspectInpaintingQa({
      inpaintedImageBytes: normalizedImageBytes,
      maskBytes,
      sourceMimeType: inpaintArgs.pageImage.mimeType
    });
    throwIfAborted(controller.signal);
    let writtenResult: Awaited<ReturnType<typeof writeInpaintedPageImageAsset>> | undefined;
    let writtenMaskResult: Awaited<ReturnType<typeof writeInpaintingMaskAsset>> | undefined;
    const runId = randomUUID();
    const source =
      provider === "gemini"
        ? "manual_gemini"
        : provider === "openai"
          ? "manual_openai"
          : "manual_local_edit";
    let committed = false;
    try {
      throwIfAborted(controller.signal);
      assertRendererOwnerActive(ownerId);
      writtenMaskResult = await writeInpaintingMaskAsset({
        projectFilePath: inpaintArgs.projectFilePath,
        sourcePageImage: inpaintArgs.pageImage,
        maskBytes,
        runId,
        source
      });
      throwIfAborted(controller.signal);
      writtenResult = await writeInpaintedPageImageAsset({
        projectFilePath: inpaintArgs.projectFilePath,
        sourcePageImage: inpaintArgs.pageImage,
        imageBytes: normalizedImageBytes
      });
      throwIfAborted(controller.signal);
      assertRendererOwnerActive(ownerId);
      const adapterResult = createManualInpaintingAdapterResult({
        sourcePageImage: inpaintArgs.pageImage,
        pageImage: writtenResult.pageImage,
        provider: inpaintArgs.provider ?? "openai",
        runId,
        appVersion,
        inpaintingQa,
        maskAsset: writtenMaskResult.maskAsset
      });
      if (!projectSessionId) {
        committed = true;
        return adapterResult;
      }

      const existingPageRecord = projectSessionManager
        .getProject(projectSessionId)
        .project.processing.pages.find(
          (page) => page.pageImageId === adapterResult.run.pageImageId
        );
      const sessionResult = await projectSessionManager.commitMainProjectPatch({
        projectSessionId,
        patch: {
          type: "commit_processing_run",
          run: adapterResult.run,
          pageRecord: createApprovedInpaintingPageRecord(adapterResult, existingPageRecord),
          assets: [writtenMaskResult.maskAsset, adapterResult.asset]
        }
      });
      committed = true;
      return { ...adapterResult, sessionResult };
    } catch (error) {
      if (!committed && writtenResult) {
        await rm(writtenResult.absoluteStoredPath, { force: true }).catch(() => undefined);
      }
      if (!committed && writtenMaskResult) {
        await rm(writtenMaskResult.absoluteStoredPath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
    } finally {
      if (activeInpaintingControllers.get(requestId)?.controller === controller) activeInpaintingControllers.delete(requestId);
    }
  });

  ipcMain.handle("project:cancelInpainting", (event, args) => {
    const requestId = validateIdRequest(args, "requestId");
    const active = activeInpaintingControllers.get(requestId);
    if (!active || active.ownerId !== rendererOwnerId(event)) return { canceled: false };
    active.controller.abort();
    return { canceled: true };
  });

  ipcMain.handle("project:extractSpeechBubbles", async (event, args) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    const request = validateProductionOcrRequestArgs(args);
    const requestId = request.requestId;
    if (activeOcrControllers.has(requestId)) throw new Error("An OCR request with this ID is already active");
    const controller = new AbortController();
    activeOcrControllers.set(requestId, { ownerId, controller });
    try {
    assertSessionOwner(ownerId, request.projectSessionId);
    projectSessionManager.assertPageImageReadyForProcessing({
      projectSessionId: request.projectSessionId,
      pageImageId: request.pageImageId
    });
    const pageImage = projectSessionManager.getPageImage(
      request.projectSessionId,
      request.pageImageId
    );
    if (pageImage.sha256 !== request.sourceSha256) {
      throw new Error("Production OCR source revision does not match the Main-owned page image");
    }
    const projectFilePath = projectSessionManager.getFilePath(request.projectSessionId);
    if (!projectFilePath) throw new Error("Production OCR requires a saved project");
    const imagePath = resolveStoredPageImagePath({
      projectFilePath,
      storedRelativePath: pageImage.storedRelativePath
    });
    const imageBytes = await readFile(imagePath);
    assertPageImageSourceBytesMatch(pageImage, imageBytes);

    const result = await productionOcr.execute({
      imageBytes,
      pageNumber: pageImage.pageNumber,
      signal: controller.signal
    });
    return {
      ...result,
      productionOcrContext: {
        runId: request.requestId,
        pageImageId: pageImage.id,
        sourceSha256: pageImage.sha256
      }
    };
    } finally {
      if (activeOcrControllers.get(requestId)?.controller === controller) activeOcrControllers.delete(requestId);
    }
  });

  ipcMain.handle("project:applyProductionOcrReview", async (event, args) => {
    const request = validateApplyProductionOcrReviewArgs(args);
    assertOwnedSession(event, request.projectSessionId);
    projectSessionManager.assertPageImageReadyForProcessing({
      projectSessionId: request.projectSessionId,
      pageImageId: request.pageImageId
    });
    const pageImage = projectSessionManager.getPageImage(
      request.projectSessionId,
      request.pageImageId
    );
    if (pageImage.sha256 !== request.sourceSha256) {
      throw new Error("Production OCR review source revision is stale");
    }
    const project = projectSessionManager.getProject(request.projectSessionId).project;
    const candidates: ProductionOcrReviewedCandidate[] = request.candidates.map((candidate) => ({
      id: candidate.id,
      text: candidate.text,
      sourceLanguage: candidate.language === "ja" || candidate.language === "en"
        ? candidate.language
        : "unknown",
      dialogueType: candidate.textType === "thought_bubble"
        ? "thought"
        : candidate.textType === "narration_box" || candidate.textType === "caption_time_place"
          ? "narration"
          : candidate.textType === "speech_bubble" || candidate.textType === "filtered_speech"
            ? "speech"
            : "unknown",
      bbox: candidate.bbox,
      polygon: candidate.polygon,
      readingOrder: candidate.readingOrder,
      confidence: candidate.confidence,
      orientation: candidate.orientation,
      selectedSpeaker: candidate.selectedSpeaker,
      notes: candidate.notes,
      provenance: candidate.productionOcrProvenance,
      typesetting: candidate.typesetting
    }));
    return projectSessionManager.commitMainProjectPatch({
      projectSessionId: request.projectSessionId,
      patch: buildProductionOcrReviewMergePatch({
        existingLines: project.dialogueLines,
        candidates,
        pageNumber: pageImage.pageNumber,
        pageImageId: pageImage.id,
        runId: request.runId
      })
    });
  });

  ipcMain.handle("project:validateSpeechBubbles", async (event, args) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    const requestId = isRecord(args) ? requireNonEmptyString(args.requestId, "requestId") : "";
    if (activeOcrControllers.has(requestId)) throw new Error("An OCR request with this ID is already active");
    const controller = new AbortController();
    activeOcrControllers.set(requestId, { ownerId, controller });
    try {
    const sessionId = isRecord(args) && typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    if (sessionId) {
      assertSessionOwner(ownerId, sessionId);
      projectSessionManager.assertPageImageReadyForProcessing({
        projectSessionId: sessionId,
        pageImageId: requirePageImageId(args)
      });
    }
    const validationArgs = validateSpeechBubbleValidationArgs(
      sessionId
        ? {
            ...args,
            projectFilePath: projectSessionManager.getFilePath(sessionId),
            pageImage: projectSessionManager.getPageImage(sessionId, requirePageImageId(args))
          }
        : args
    );
    const imagePath = resolveStoredPageImagePath({
      projectFilePath: validationArgs.projectFilePath,
      storedRelativePath: validationArgs.pageImage.storedRelativePath
    });
    const imageBytes = await readFile(imagePath);
    assertPageImageSourceBytesMatch(validationArgs.pageImage, imageBytes);

    const validationArgsForProvider = {
      imageBytes,
      sourceMimeType: validationArgs.pageImage.mimeType,
      geminiExtraction: validationArgs.geminiExtraction,
      characters: validationArgs.characters,
      signal: controller.signal
    };

    const hasGemini = hasGeminiApiKey();
    const hasOpenAi = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());

    if (!hasGemini && !hasOpenAi) {
      return normalizeSpeechBubbleExtractionResult(
        {
          ...validationArgs.geminiExtraction,
          pageNumber: validationArgs.geminiExtraction.pageNumber ?? validationArgs.pageImage.pageNumber,
          warnings: [
            ...(validationArgs.geminiExtraction.warnings ?? []),
            createOcrValidationDegradedWarning("클라우드 API 키가 등록되지 않았습니다.")
          ]
        },
        validationArgs.pageImage.pageNumber
      );
    }

    let validatedExtraction: SpeechBubbleExtractionResult;
    try {
      validatedExtraction = hasGemini
        ? await validateSpeechBubblesWithGemini(validationArgsForProvider)
        : await validateSpeechBubblesWithOpenAI(validationArgsForProvider);
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) throw err;
      return normalizeSpeechBubbleExtractionResult(
        {
          ...validationArgs.geminiExtraction,
          pageNumber: validationArgs.geminiExtraction.pageNumber ?? validationArgs.pageImage.pageNumber,
          warnings: [
            ...(validationArgs.geminiExtraction.warnings ?? []),
            createOcrValidationDegradedWarning(safeOcrValidationFailureReason(err))
          ]
        },
        validationArgs.pageImage.pageNumber
      );
    }

    if (!hasGemini) return validatedExtraction;

    const reocrTargets = selectCropReocrTargets(validatedExtraction);
    if (reocrTargets.length === 0) return validatedExtraction;

    const cropResults = [];
    const cropWarnings: string[] = [];
    for (const target of reocrTargets) {
      try {
        throwIfAborted(controller.signal);
        const cropImageBytes = cropImageToPng({
          imageBytes,
          bbox: target.bbox,
          paddingRatio: 0.08
        });
        const result = await reocrSpeechBubbleCropWithGemini({
          cropImageBytes,
          sourceMimeType: "image/png",
          target,
          signal: controller.signal
        });
        cropResults.push({ target, result });
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) throw error;
        const message = error instanceof Error
          && error.message === "Gemini crop reOCR request failed: Unable to process input image."
          ? error.message
          : "Unable to re-OCR this crop.";
        cropWarnings.push(`Crop ReOCR skipped for #${target.readingOrder}: ${message}`);
      }
    }

    const mergedExtraction = mergeCropReocrResults(validatedExtraction, cropResults);
    return cropWarnings.length === 0
      ? mergedExtraction
      : { ...mergedExtraction, warnings: [...mergedExtraction.warnings, ...cropWarnings] };
    } finally {
      if (activeOcrControllers.get(requestId)?.controller === controller) activeOcrControllers.delete(requestId);
    }
  });

  ipcMain.handle("project:cancelSpeechBubbleOcr", (event, args) => {
    const requestId = validateIdRequest(args, "requestId");
    const active = activeOcrControllers.get(requestId);
    if (!active || active.ownerId !== rendererOwnerId(event)) return { canceled: false };
    active.controller.abort();
    return { canceled: true };
  });

  ipcMain.handle("project:resolvePageImageSrc", async (event, args) => {
    const projectSessionId =
      isRecord(args) && typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    if (projectSessionId) assertOwnedSession(event, projectSessionId);
    const imageSrcArgs = validateResolvePageImageSrcArgs(
      projectSessionId
        ? {
            ...args,
            projectFilePath: projectSessionManager.getFilePath(projectSessionId),
            storedRelativePath: projectSessionManager.getPageImageByStoredPath(
              projectSessionId,
              requireStoredRelativePath(args)
            ).storedRelativePath
          }
        : args
    );
    return resolvePageImageFileUrl(imageSrcArgs, projectSessionId);
  });

  ipcMain.handle("localAi:testConnection", async (_event, args: unknown) => {
    const validated = validateTestLocalAiConnectionArgs(args);
    return testLocalAiConnection(validated);
  });

  ipcMain.handle("localAi:listModels", async (_event, args: unknown) => {
    const validated = validateListLocalAiModelsArgs(args);
    return listLocalAiModels(validated);
  });

  ipcMain.handle("localAi:translate", async (_event, args: unknown) => {
    const validated = validateGenerateLocalAiTranslationArgs(args);
    return generateLocalAiTranslation(validated);
  });

  ipcMain.handle("translation:execute", async (event, args: unknown) => {
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    if (!isRecord(args)) {
      throw new Error("Invalid translation execution request");
    }

    let payload = args.payload as TranslationContextPayload | undefined;
    const projectSessionId = typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    const targetLineId = typeof args.targetLineId === "string" ? args.targetLineId : undefined;
    const requestId = args.requestId === undefined
      ? undefined
      : requireTranslationRequestId(args.requestId);
    if (projectSessionId) assertSessionOwner(ownerId, projectSessionId);

    if (!payload && projectSessionId && targetLineId) {
      const projectWrapper = projectSessionManager.getProject(projectSessionId);
      if (!projectWrapper?.project) {
        throw new Error(`Project session "${projectSessionId}" not found`);
      }
      payload = buildTranslationContextPayload({
        dialogueLines: projectWrapper.project.dialogueLines,
        targetLineId,
        characters: projectWrapper.project.characters,
        dictionaryTerms: projectWrapper.project.dictionaryTerms,
        stylePreset: typeof args.stylePreset === "string" ? args.stylePreset : undefined
      });
    }

    if (!payload) {
      throw new Error("Missing translation payload or projectSessionId/targetLineId");
    }
    const contextFingerprint = computeTranslationPayloadFingerprint(payload);

    const options = (isRecord(args.options) ? args.options : {}) as TranslateExecutionOptions;

    let controller: AbortController | undefined;
    if (requestId) {
      if (activeTranslationControllers.has(requestId)) {
        throw new Error(`Translation request "${requestId}" is already active`);
      }
      controller = new AbortController();
      activeTranslationControllers.set(requestId, { ownerId, controller });
    }
    const currentSettings = providerSettingsStore.getSettings();

    try {
      const result = await translationEngineRegistry.executeTranslation(payload, {
        geminiModel: options.geminiModel ?? currentSettings.geminiModel,
        ...options,
        signal: controller?.signal ?? options.signal
      });
      assertRendererOwnerActive(ownerId);
      return { ...result, contextFingerprint };
    } finally {
      if (requestId && activeTranslationControllers.get(requestId)?.controller === controller) {
        activeTranslationControllers.delete(requestId);
      }
    }
  });

  ipcMain.handle("translation:cancel", async (event, args: unknown) => {
    if (isRecord(args)) {
      const requestId = requireTranslationRequestId(args.requestId);
      const active = activeTranslationControllers.get(requestId);
      if (active && active.ownerId === rendererOwnerId(event)) {
        active.controller.abort(new DOMException("Translation request was canceled.", "AbortError"));
        activeTranslationControllers.delete(requestId);
        return { canceled: true };
      }
    }
    return { canceled: false };
  });

  ipcMain.handle("translation:commitProposal", async (event, args: unknown) => {
    if (!isRecord(args)) {
      throw new Error("Invalid translation proposal commit request");
    }
    const projectSessionId = requireNonEmptyTrimmedString(args.projectSessionId, "projectSessionId");
    assertOwnedSession(event, projectSessionId);
    const targetLineId = requireNonEmptyTrimmedString(args.targetLineId, "targetLineId");
    const proposal = requireNonEmptyTrimmedString(args.proposal, "proposal");
    const expectedTranslationFingerprint = requireNonEmptyString(
      args.expectedTranslationFingerprint,
      "expectedTranslationFingerprint"
    );

    return projectSessionManager.commitMainProjectPatch({
      projectSessionId,
      patch: {
        type: "commit_batch_result",
        ...(typeof args.stylePreset === "string" && args.stylePreset.trim()
          ? { speechStylePreset: args.stylePreset.trim() }
          : {}),
        dialogueUpdates: [{
          id: targetLineId,
          aiTranslation: proposal,
          expectedTranslationFingerprint,
          ...(typeof args.stylePreset === "string" && args.stylePreset.trim()
            ? { stylePreset: args.stylePreset.trim() }
            : {})
        }]
      }
    });
  });

  ipcMain.handle("batch:run", async (event, args: unknown) => {
    const validated = validateBatchRunArgs(args);
    const ownerId = rendererOwnerId(event);
    assertRendererOwnerActive(ownerId);
    if (validated.projectSessionId) {
      assertSessionOwner(ownerId, validated.projectSessionId);
      assertBatchSessionOpen(validated.projectSessionId);
    }
    if (activeBatchRequests.has(validated.requestId)) {
      throw new Error("이미 실행 중인 Batch requestId입니다.");
    }
    const active: OwnedBatchRequest = { ownerId, projectSessionId: validated.projectSessionId };
    activeBatchRequests.set(validated.requestId, active);

    try {
      return await batchCoordinator.runBatchJob({
        project: validated.project,
        projectSessionId: validated.projectSessionId,
        config: validated.config,
        pageCount: validated.pageCount,
        requestId: validated.requestId,
        onProgress: (progress, metadata) => {
          try {
            if (!event.sender.isDestroyed() && !inactiveRendererOwners.has(ownerId)) {
              const progressEvent: BatchProgressEvent = { requestId: validated.requestId, progress, ...metadata };
              event.sender.send("batch:progress", progressEvent);
            }
          } catch {
            // ignore
          }
        }
      });
    } finally {
      if (activeBatchRequests.get(validated.requestId) === active) {
        activeBatchRequests.delete(validated.requestId);
      }
    }
  });

  ipcMain.handle("batch:cancel", async (event, args: unknown) => {
    if (isRecord(args) && typeof args.requestId === "string" && args.requestId.trim()) {
      if (activeBatchRequests.get(args.requestId.trim())?.ownerId !== rendererOwnerId(event)) {
        return { canceled: false };
      }
      const canceled = batchCoordinator.cancelBatchJob(args.requestId.trim());
      return { canceled };
    }
    return { canceled: false };
  });

  ipcMain.handle("translation:inspectQa", async (_event, args: unknown) => {
    if (!isRecord(args) || typeof args.sourceText !== "string" || typeof args.translatedText !== "string") {
      throw new Error("Invalid translation QA inspection request");
    }
    return inspectTranslationQuality(args as unknown as InspectTranslationQaArgs);
  });

  ipcMain.handle("translation:queryTm", async (event, args: unknown) => {
    if (!isRecord(args) || typeof args.sourceText !== "string") {
      throw new Error("Invalid TM query request");
    }

    const projectSessionId = typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    let dialogueLines = Array.isArray(args.dialogueLines) ? args.dialogueLines : [];

    if (projectSessionId) {
      assertOwnedSession(event, projectSessionId);
      const projectWrapper = projectSessionManager.getProject(projectSessionId);
      if (projectWrapper?.project) {
        dialogueLines = projectWrapper.project.dialogueLines;
      }
    }

    const tm = createTranslationMemory(dialogueLines);
    const minSim = typeof args.minSimilarity === "number" ? args.minSimilarity : 0.7;
    const maxCand = typeof args.maxCandidates === "number" ? args.maxCandidates : 3;
    const excludeLineId = typeof args.excludeLineId === "string" ? args.excludeLineId : undefined;
    const filterSpeaker = typeof args.filterSpeaker === "string" ? args.filterSpeaker : undefined;

    const exact = tm.findExact(args.sourceText);
    const fuzzy = tm.findFuzzy(args.sourceText, {
      minSimilarity: minSim,
      maxCandidates: maxCand,
      excludeLineId,
      filterSpeaker
    });

    return {
      exact: exact ?? null,
      fuzzy
    };
  });

  ipcMain.handle("translation:buildPayload", async (event, args: unknown) => {
    if (!isRecord(args) || typeof args.targetLineId !== "string") {
      throw new Error("Invalid build payload request");
    }

    const projectSessionId = typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    let dialogueLines = Array.isArray(args.dialogueLines) ? args.dialogueLines : [];
    let characters = Array.isArray(args.characters) ? args.characters : [];
    let dictionaryTerms = Array.isArray(args.dictionaryTerms) ? args.dictionaryTerms : [];

    if (projectSessionId) {
      assertOwnedSession(event, projectSessionId);
      const projectWrapper = projectSessionManager.getProject(projectSessionId);
      if (projectWrapper?.project) {
        dialogueLines = projectWrapper.project.dialogueLines;
        characters = projectWrapper.project.characters;
        dictionaryTerms = projectWrapper.project.dictionaryTerms;
      }
    }

    return buildTranslationContextPayload({
      dialogueLines,
      targetLineId: args.targetLineId,
      characters,
      dictionaryTerms,
      stylePreset: typeof args.stylePreset === "string" ? args.stylePreset : undefined
    });
  });

  ipcMain.handle("project:extractGlossaryProposals", async (event, args: unknown) => {
    if (!isRecord(args)) {
      throw new Error("Invalid glossary extraction request");
    }
    const sessionId = typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    let dialogueLines = Array.isArray(args.dialogueLines) ? args.dialogueLines : [];
    let existingCharacters = Array.isArray(args.existingCharacters) ? args.existingCharacters : [];
    let existingTerms = Array.isArray(args.existingTerms) ? args.existingTerms : [];

    if (sessionId) {
      assertOwnedSession(event, sessionId);
      const projectWrapper = projectSessionManager.getProject(sessionId);
      if (projectWrapper?.project) {
        dialogueLines = projectWrapper.project.dialogueLines;
        existingCharacters = projectWrapper.project.characters;
        existingTerms = projectWrapper.project.dictionaryTerms;
      }
    }

    return extractGlossaryFromCorpus({
      dialogueLines,
      existingCharacters,
      existingTerms
    });
  });

  ipcMain.handle("project:inspectInpaintingQa", async (event, args: unknown) => {
    if (!isRecord(args)) {
      throw new Error("Invalid inpainting QA inspection request");
    }
    const sessionId = typeof args.projectSessionId === "string" ? args.projectSessionId : undefined;
    const pageImageId = typeof args.pageImageId === "string" ? args.pageImageId : undefined;
    const attemptCount = typeof args.attemptCount === "number" ? args.attemptCount : 1;
    const maskBytes = typeof args.maskPngBase64 === "string" ? Buffer.from(args.maskPngBase64, "base64") : undefined;

    if (sessionId && pageImageId) {
      assertOwnedSession(event, sessionId);
      const filePath = projectSessionManager.getFilePath(sessionId);
      if (!filePath) {
        throw new Error("Project session file path is not available for inpainting QA inspection");
      }
      const pageImage = projectSessionManager.getPageImage(sessionId, pageImageId);
      const imagePath = resolveStoredPageImagePath({
        projectFilePath: filePath,
        storedRelativePath: pageImage.storedRelativePath
      });
      const inpaintedImageBytes = await readFile(imagePath);
      return inspectInpaintingQa({
        inpaintedImageBytes,
        maskBytes,
        sourceMimeType: pageImage.mimeType,
        attemptCount
      });
    }

    if (typeof args.inpaintedImagePngBase64 === "string") {
      const inpaintedImageBytes = Buffer.from(args.inpaintedImagePngBase64, "base64");
      return inspectInpaintingQa({
        inpaintedImageBytes,
        maskBytes,
        attemptCount
      });
    }

    throw new Error("Inpainting QA request requires projectSessionId/pageImageId or inpaintedImagePngBase64");
  });

  async function cleanupRenderer(ownerId: number): Promise<void> {
    const existingCleanup = rendererCleanupPromises.get(ownerId);
    if (existingCleanup) return existingCleanup;
    inactiveRendererOwners.add(ownerId);
    const cleanupPromise = (async () => {
      for (const [unlockToken, pending] of pendingUnlocks) {
        if (pending.ownerId === ownerId) pendingUnlocks.delete(unlockToken);
      }
      for (const [requestId, active] of activeTranslationControllers) {
        if (active.ownerId !== ownerId) continue;
        active.controller.abort(new DOMException("Renderer disconnected.", "AbortError"));
        activeTranslationControllers.delete(requestId);
      }
      for (const [requestId, active] of activeOcrControllers) {
        if (active.ownerId !== ownerId) continue;
        active.controller.abort(new DOMException("Renderer disconnected.", "AbortError"));
        activeOcrControllers.delete(requestId);
      }
      for (const [requestId, active] of activeInpaintingControllers) {
        if (active.ownerId !== ownerId) continue;
        active.controller.abort(new DOMException("Renderer disconnected.", "AbortError"));
        activeInpaintingControllers.delete(requestId);
      }
      const batchTargets: Array<{ projectSessionId?: string; settled: Promise<boolean> }> = [];
      for (const [requestId, active] of activeBatchRequests) {
        if (active.ownerId !== ownerId) continue;
        batchTargets.push({
          projectSessionId: active.projectSessionId,
          settled: batchCoordinator.cancelBatchJobAndWait(requestId)
        });
      }
      const sessions = [...(rendererSessions.get(ownerId) ?? [])];
      for (const projectSessionId of sessions) {
        batchTargets.push({ projectSessionId, settled: batchCoordinator.cancelSessionExecutions(projectSessionId) });
      }
      const settlements = await Promise.allSettled(batchTargets.map((target) => target.settled));
      const errors: unknown[] = [];
      const failedSessionIds = new Set<string>();
      for (const [index, result] of settlements.entries()) {
        if (result.status !== "rejected") continue;
        errors.push(result.reason);
        const projectSessionId = batchTargets[index]!.projectSessionId;
        if (projectSessionId) {
          failedSessionIds.add(projectSessionId);
          rememberMainOwnedSessionCleanup(projectSessionId, result.reason);
        }
      }

      await retryPendingSessionCleanups(false, failedSessionIds);
      for (const projectSessionId of sessions) {
        if (failedSessionIds.has(projectSessionId)) continue;
        try {
          await closeSession(projectSessionId);
        } catch {
          // Failed raw closes remain Main-owned until the next cleanup retry.
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Renderer Batch 실행 정리에 실패했습니다.");
    })();
    rendererCleanupPromises.set(ownerId, cleanupPromise);
    try {
      await cleanupPromise;
    } finally {
      rendererCleanupPromises.delete(ownerId);
    }
  }

  return { cleanupRenderer, retryPendingSessionCleanups };
}

export async function resolveExportTypesetFontEvidence(
  pages: readonly Pick<TypesetExportPage, "readiness">[],
  verifyInstalledTypesetFontResource?: InstalledTypesetFontResourceVerifier
): Promise<RenderReadinessReport["evidence"]["font"] | undefined> {
  if (!verifyInstalledTypesetFontResource) return undefined;
  return resolveTrustedTypesetFontEvidence(
    pages.map((page) => page.readiness.evidence.font),
    verifyInstalledTypesetFontResource
  );
}

async function chooseProjectFile(defaultPath?: string): Promise<string | null> {
  const selection = await dialog.showOpenDialog({
    title: "번역 프로젝트 열기",
    defaultPath,
    properties: ["openFile"],
    filters: [{ name: "캐릭터 번역 프로젝트", extensions: ["ctp"] }]
  });

  if (selection.canceled || !selection.filePaths[0]) return null;
  return selection.filePaths[0];
}

async function chooseSaveProjectFile(defaultPath?: string): Promise<string | null> {
  const selection = await dialog.showSaveDialog({
    title: "번역 프로젝트 저장",
    defaultPath,
    filters: [{ name: "캐릭터 번역 프로젝트", extensions: ["ctp"] }]
  });

  if (selection.canceled || !selection.filePath) return null;
  assertProjectFilePath(selection.filePath);
  return selection.filePath;
}

function resolveProjectSaveDefaultPath(defaultPath: string | undefined, directory: string): string {
  const requestedFileName = defaultPath ? win32.basename(defaultPath) : "새 프로젝트.ctp";
  const safeFileName = sanitizeProjectFileName(requestedFileName);
  return resolve(directory, safeFileName);
}

function sanitizeProjectFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.ctp$/i, "");
  const sanitized = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 160);
  const baseName = sanitized || "새 프로젝트";
  const safeBaseName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|com[¹²³]|lpt[¹²³])$/i.test(baseName)
    ? `_${baseName}`
    : baseName;
  return `${safeBaseName}.ctp`;
}

async function chooseTranslationExportFile(defaultPath?: string): Promise<string | null> {
  const selection = await dialog.showSaveDialog({
    title: "번역문 TXT 내보내기",
    defaultPath,
    filters: [{ name: "TXT 파일", extensions: ["txt"] }]
  });

  if (selection.canceled || !selection.filePath) return null;
  assertTextFilePath(selection.filePath);
  return selection.filePath;
}

async function chooseProjectImageExportDirectory(defaultPath?: string): Promise<string | null> {
  const selection = await dialog.showSaveDialog({
    title: "프로젝트 이미지 내보내기 폴더 선택",
    defaultPath,
    buttonLabel: "내보내기"
  });
  if (selection.canceled || !selection.filePath) return null;
  return selection.filePath;
}

async function choosePageImageFiles(): Promise<string[] | null> {
  const selection = await dialog.showOpenDialog({
    title: "페이지 이미지 가져오기",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "이미지 파일", extensions: ["jpg", "jpeg", "png", "webp"] }]
  });

  if (selection.canceled || selection.filePaths.length === 0) return null;
  return selection.filePaths;
}

async function preparePageImageFiles(sourcePaths: string[]): Promise<PreparedPageImage[]> {
  const validatedFiles: Array<{ sourcePath: string; fileName: string; byteSize: number }> = [];
  const seenPaths = new Set<string>();

  for (const sourcePath of sourcePaths) {
    if (!isAbsolute(sourcePath)) throw new Error("Page image source must be an absolute path");
    const absoluteSourcePath = resolve(sourcePath);
    const normalizedSourcePath = filesystemPathIdentity(absoluteSourcePath);
    if (seenPaths.has(normalizedSourcePath)) continue;
    seenPaths.add(normalizedSourcePath);

    if (!pageImageExtensions.has(extname(absoluteSourcePath).toLowerCase())) {
      throw new Error("Unsupported image file extension");
    }

    const metadata = await stat(absoluteSourcePath);
    if (!metadata.isFile()) throw new Error("Page image path must reference a file");

    validatedFiles.push({
      sourcePath: absoluteSourcePath,
      fileName: basename(absoluteSourcePath),
      byteSize: metadata.size
    });
  }

  const preparedFiles = validatedFiles.map<PreparedPageImage>((file) => {
    const id = randomUUID();
    return {
      id,
      sourcePath: file.sourcePath,
      fileName: file.fileName,
      previewSrc: `${pageImageProtocol}://${pageImageProtocolHost}/${id}`,
      byteSize: file.byteSize
    };
  });

  for (const file of preparedFiles) {
    if (!file.sourcePath) throw new Error("Prepared page image path is unavailable");
    pageImageProtocolPaths.set(file.id, file.sourcePath);
    preparedPageImageProtocolIds.add(file.id);
  }

  return preparedFiles;
}

function releasePreparedPageImages(ids: string[]): void {
  for (const id of ids) {
    if (!preparedPageImageProtocolIds.delete(id)) continue;
    pageImageProtocolPaths.delete(id);
  }
}

export type SaveProjectArgs = {
  filePath: string;
  project: TranslationProject;
  password?: string;
};

export type CreateSessionArgs = {
  title: string;
  secret: boolean;
  password?: string;
};

export function validateCreateSessionArgs(args: unknown): CreateSessionArgs {
  if (!isRecord(args)) throw new Error("Invalid create session request: expected object");
  if (typeof args.title !== "string") throw new Error("Invalid create session request: title must be a string");
  if (typeof args.secret !== "boolean") throw new Error("Invalid create session request: secret must be a boolean");
  if (args.password !== undefined && typeof args.password !== "string") {
    throw new Error("Invalid create session request: password must be a string");
  }
  return { title: args.title, secret: args.secret, password: args.password };
}

function requirePageImageId(args: unknown): string {
  if (!isRecord(args)) {
    throw new Error("Invalid page image request");
  }
  if (typeof args.pageImageId === "string") {
    return requireNonEmptyString(args.pageImageId, "pageImageId");
  }
  if (!isRecord(args.pageImage)) throw new Error("Invalid page image request");
  return requireNonEmptyString(args.pageImage.id, "pageImage.id");
}

function requireStoredRelativePath(args: unknown): string {
  if (!isRecord(args)) throw new Error("Invalid page image request");
  return requireNonEmptyString(args.storedRelativePath, "storedRelativePath");
}

export function validateReviewCleanedAssetArgs(args: unknown): ReviewCleanedAssetArgs {
  if (!isRecord(args)) throw new Error("Invalid cleaned review request: expected object");
  const allowedKeys = new Set(["projectSessionId", "pageImageId", "cleanedAssetId", "expectedRevision"]);
  if (Object.keys(args).some((key) => !allowedKeys.has(key))) throw new Error("Invalid cleaned review request: unexpected field");
  for (const key of ["projectSessionId", "pageImageId", "cleanedAssetId"]) {
    if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(`Invalid cleaned review request: ${key} must be a non-empty string`);
  }
  if (typeof args.expectedRevision !== "number" || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) {
    throw new Error("Invalid cleaned review request: expectedRevision must be a non-negative safe integer");
  }
  return {
    projectSessionId: requireNonEmptyString(args.projectSessionId, "projectSessionId"),
    pageImageId: requireNonEmptyString(args.pageImageId, "pageImageId"),
    cleanedAssetId: requireNonEmptyString(args.cleanedAssetId, "cleanedAssetId"),
    expectedRevision: args.expectedRevision
  };
}

export function validateApplyMutationArgs(args: unknown): ApplyProjectMutationArgs {
  if (!isRecord(args)) throw new Error("Invalid mutation request: expected object");
  const projectSessionId = requireNonEmptyString(args.projectSessionId, "projectSessionId");
  if (typeof args.baseRevision !== "number" || !Number.isInteger(args.baseRevision) || args.baseRevision < 0) {
    throw new Error("Invalid mutation request: baseRevision must be a non-negative integer");
  }
  if (!isRecord(args.mutation) || typeof args.mutation.type !== "string") {
    throw new Error("Invalid mutation request: mutation must be a typed object");
  }
  return {
    projectSessionId,
    baseRevision: args.baseRevision,
    mutation: args.mutation as ProjectMutation
  };
}

export type OpenProjectArgs = {
  filePath?: string;
  password?: string;
};

export type ChooseSaveFileArgs = {
  defaultPath?: string;
};

export type ExportTranslationsArgs = {
  filePath?: string;
  defaultPath?: string;
  project: TranslationProject;
};

export type ExportProjectImagesArgs = {
  projectSessionId: string;
  defaultPath?: string;
  includeZip: boolean;
  typesetPages: Array<{
    pageImageId: string;
    pngBase64: string;
    readiness: RenderReadinessReport;
  }>;
};

export function validateExportProjectImagesArgs(args: unknown): ExportProjectImagesArgs {
  if (!isRecord(args)) throw new Error("Invalid image export request: expected object");
  const projectSessionId = requireNonEmptyString(args.projectSessionId, "projectSessionId");
  if (args.defaultPath !== undefined && (typeof args.defaultPath !== "string" || !isAbsolute(args.defaultPath))) {
    throw new Error("Invalid image export request: defaultPath must be an absolute path");
  }
  if (args.includeZip !== undefined && typeof args.includeZip !== "boolean") {
    throw new Error("Invalid image export request: includeZip must be a boolean");
  }
  if (args.typesetPages !== undefined && !Array.isArray(args.typesetPages)) {
    throw new Error("Invalid image export request: typesetPages must be an array");
  }
  const typesetPages = Array.isArray(args.typesetPages) ? args.typesetPages.map((page, index) => {
    if (!isRecord(page)) throw new Error(`Invalid image export request: typesetPages[${index}] must be an object`);
    const pageImageId = requireNonEmptyString(page.pageImageId, `typesetPages[${index}].pageImageId`);
    const pngBase64 = requireNonEmptyString(page.pngBase64, `typesetPages[${index}].pngBase64`);
    const readiness = validateRenderReadinessReport(page.readiness, index);
    return { pageImageId, pngBase64, readiness };
  }) : [];
  return {
    projectSessionId,
    defaultPath: args.defaultPath as string | undefined,
    includeZip: args.includeZip === true,
    typesetPages
  };
}

function validateRenderReadinessReport(value: unknown, index: number): RenderReadinessReport {
  const field = `typesetPages[${index}].readiness`;
  if (!isRecord(value)) throw new Error(`Invalid image export request: ${field} must be an object`);
  if (typeof value.ready !== "boolean" || typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new Error(`Invalid image export request: typesetPages[${index}].readiness identity is invalid`);
  }
  if (!isNonEmptyString(value.pageImageId) || !isReadinessStringArray(value.lineIds)) {
    throw new Error(`Invalid image export request: ${field} line identity is invalid`);
  }
  if (!isNonEmptyString(value.sourceFingerprint) ||
      !isNonEmptyString(value.userTranslationFingerprint) ||
      !isNonEmptyString(value.typesettingGeometryFingerprint) ||
      !isNonEmptyString(value.fontIdentity)) {
    throw new Error(`Invalid image export request: ${field} fingerprints are invalid`);
  }
  if (!Array.isArray(value.blockers) || !value.blockers.every(isReadinessBlocker)) {
    throw new Error(`Invalid image export request: ${field}.blockers are invalid`);
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error(`Invalid image export request: ${field}.warnings are invalid`);
  }
  if (!isReadinessEvidence(value.evidence)) {
    throw new Error(`Invalid image export request: ${field}.evidence is invalid`);
  }
  if (value.fontIdentity !== value.evidence.font.identity) {
    throw new Error(`Invalid image export request: ${field}.fontIdentity does not match evidence.font.identity`);
  }
  if (value.approvedCleanedAssetId !== undefined && !isNonEmptyString(value.approvedCleanedAssetId)) {
    throw new Error(`Invalid image export request: ${field}.approvedCleanedAssetId is invalid`);
  }
  if (value.ready !== true || value.blockers.length > 0) {
    throw new Error(`Invalid image export request: ${field} must be render-ready`);
  }
  return value as unknown as RenderReadinessReport;
}

function isReadinessEvidence(value: unknown): value is RenderReadinessReport["evidence"] {
  if (!isRecord(value) || !isRecord(value.font)) return false;
  return isNonEmptyString(value.font.identity) &&
    typeof value.font.resourceAvailable === "boolean" &&
    typeof value.font.metricsCalculated === "boolean" &&
    typeof value.font.glyphCoverageVerified === "boolean" &&
    isReadinessStringArray(value.safeAreaProvisionalLineIds) &&
    isReadinessStringArray(value.missingGlyphLineIds) &&
    isReadinessStringArray(value.overflowLineIds);
}

function isReadinessStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => isNonEmptyString(item)) &&
    new Set(value).size === value.length;
}

function isReadinessBlocker(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.code) || !isNonEmptyString(value.message)) return false;
  if (!renderReadinessBlockerCodes.includes(value.code as (typeof renderReadinessBlockerCodes)[number])) return false;
  return value.lineId === undefined || isNonEmptyString(value.lineId);
}

export function validateProcessingQueueActionArgs(args: unknown): ProcessingQueueActionArgs {
  if (!isRecord(args)) throw new Error("Invalid processing queue request: expected object");
  const projectSessionId = requireNonEmptyString(args.projectSessionId, "projectSessionId");
  const actions = ["create", "start", "resume", "pause", "cancel", "complete_stage", "approve_stage", "fail", "retry"] as const;
  if (!actions.includes(args.action as typeof actions[number])) throw new Error("Invalid processing queue request: action is not supported");
  const action = args.action as ProcessingQueueActionArgs["action"];
  if (args.pageImageIds !== undefined) {
    if (!Array.isArray(args.pageImageIds) || args.pageImageIds.some((pageImageId) => typeof pageImageId !== "string" || pageImageId.length === 0)) {
      throw new Error("Invalid processing queue request: pageImageIds must be non-empty strings");
    }
  }
  if (args.stage !== undefined && typeof args.stage !== "string") throw new Error("Invalid processing queue request: stage must be a string");
  if (args.revision !== undefined) {
    if (typeof args.revision !== "number") throw new Error("Invalid processing queue request: revision must be a number");
    requireNonNegativeInteger(args.revision, "revision");
  }
  if (args.runId !== undefined && typeof args.runId !== "string") throw new Error("Invalid processing queue request: runId must be a string");
  if (args.reason !== undefined && typeof args.reason !== "string") throw new Error("Invalid processing queue request: reason must be a string");
  let error: ProcessingQueueActionArgs["error"];
  if (args.error !== undefined) {
    if (!isRecord(args.error) || typeof args.error.code !== "string" || typeof args.error.message !== "string" || typeof args.error.retryable !== "boolean") {
      throw new Error("Invalid processing queue request: error is malformed");
    }
    error = {
      code: args.error.code,
      message: args.error.message,
      retryable: args.error.retryable,
      ...(typeof args.error.stage === "string" ? { stage: args.error.stage } : {})
    };
  }
  const common = {
    projectSessionId,
    pageImageIds: args.pageImageIds as string[] | undefined,
    pageImageId: args.pageImageId as string | undefined,
    stage: args.stage as string | undefined,
    revision: args.revision as number | undefined,
    runId: args.runId as string | undefined,
    reason: args.reason as string | undefined,
    error
  };
  if (action === "pause" || action === "cancel" || action === "resume" || action === "retry") {
    const queueId = requireNonEmptyString(args.queueId, "queueId");
    if (!queueId.trim()) throw new Error("Invalid request: queueId must be a non-empty string");
    return { ...common, action, queueId };
  }
  if (args.queueId !== undefined) throw new Error("Invalid processing queue request: queueId is not allowed for this action");
  return { ...common, action };
}

function requireProcessingQueueStage(value: string | undefined): ProcessingQueueStage {
  if (value === "ocr" || value === "speaker_review" || value === "translation" || value === "inpainting" || value === "typesetting" || value === "completed") return value;
  throw new Error("Invalid processing queue request: stage is not supported");
}

function requireNonNegativeInteger(value: number | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`Invalid processing queue request: ${field} must be a non-negative integer`);
  return value;
}

export type ImportPageImagesArgs = {
  projectFilePath: string;
  files: Array<{
    sourcePath: string;
    pageNumber: number;
  }>;
};

function isOpaquePageImageImportArgs(args: unknown): args is {
  projectSessionId: string;
  importBatchId: string;
  pages: Array<{ preparedImageId: string; pageNumber: number }>;
} {
  if (
    !isRecord(args) ||
    (!("importBatchId" in args) && !("pages" in args))
  ) {
    return false;
  }
  requireNonEmptyString(args.projectSessionId, "projectSessionId");
  requireNonEmptyString(args.importBatchId, "importBatchId");
  if (!Array.isArray(args.pages)) {
    throw new Error("Invalid page image import request: pages must be an array");
  }
  for (const page of args.pages) {
    if (!isRecord(page)) {
      throw new Error("Invalid page image import request: page must be an object");
    }
    requireNonEmptyString(page.preparedImageId, "preparedImageId");
    if (
      typeof page.pageNumber !== "number" ||
      !Number.isInteger(page.pageNumber) ||
      page.pageNumber < 1
    ) {
      throw new Error(
        "Invalid page image import request: pageNumber must be a positive integer"
      );
    }
  }
  return true;
}

export type ResolvePageImageSrcArgs = {
  projectFilePath: string;
  storedRelativePath: string;
};

export function validateChooseSaveFileArgs(args?: unknown): ChooseSaveFileArgs {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw new Error("Invalid save file request: expected object");
  if (args.defaultPath !== undefined && typeof args.defaultPath !== "string") {
    throw new Error("Invalid save file request: defaultPath must be a string");
  }
  if (args.defaultPath !== undefined) assertProjectFilePath(args.defaultPath);

  return {
    defaultPath: args.defaultPath
  };
}

export function validateExportTranslationsArgs(args: unknown): ExportTranslationsArgs {
  if (!isRecord(args)) throw new Error("Invalid export request: expected object");
  if (args.filePath !== undefined && typeof args.filePath !== "string") {
    throw new Error("Invalid export request: filePath must be a string");
  }
  if (args.defaultPath !== undefined && typeof args.defaultPath !== "string") {
    throw new Error("Invalid export request: defaultPath must be a string");
  }
  if (args.filePath !== undefined) assertTextFilePath(args.filePath);
  if (args.defaultPath !== undefined) assertTextFilePath(args.defaultPath);
  if (!isRecord(args.project)) throw new Error("Invalid export request: project must be an object");

  return {
    filePath: args.filePath,
    defaultPath: args.defaultPath,
    project: args.project as TranslationProject
  };
}

export function validateSaveProjectArgs(args: unknown): SaveProjectArgs {
  if (!isRecord(args)) throw new Error("Invalid save request: expected object");
  if (typeof args.filePath !== "string") throw new Error("Invalid save request: filePath must be a string");
  assertProjectFilePath(args.filePath);
  if (!isRecord(args.project)) throw new Error("Invalid save request: project must be an object");
  if (args.password !== undefined && typeof args.password !== "string") {
    throw new Error("Invalid save request: password must be a string");
  }

  return {
    filePath: args.filePath,
    project: args.project as TranslationProject,
    password: args.password
  };
}

export function validateImportPageImagesArgs(args: unknown): ImportPageImagesArgs {
  if (!isRecord(args)) throw new Error("Invalid image import request: expected object");
  if (typeof args.projectFilePath !== "string") {
    throw new Error("Invalid image import request: projectFilePath must be a string");
  }
  assertProjectFilePath(args.projectFilePath);
  if (!Array.isArray(args.files)) throw new Error("Invalid image import request: files must be an array");

  return {
    projectFilePath: args.projectFilePath,
    files: args.files.map((file) => {
      if (!isRecord(file)) throw new Error("Invalid image import request: file must be an object");
      if (typeof file.sourcePath !== "string") {
        throw new Error("Invalid image import request: sourcePath must be a string");
      }
      const pageNumber = file.pageNumber;
      if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error("Invalid image import request: pageNumber must be a positive integer");
      }

      return { sourcePath: file.sourcePath, pageNumber };
    })
  };
}

export function validateInpaintPageImageArgs(args: unknown): InpaintPageImageRequest {
  if (!isRecord(args)) throw new Error("Invalid inpaint request: expected object");
  const requestId = requireNonEmptyString(args.requestId, "requestId");
  if (typeof args.projectFilePath !== "string") {
    throw new Error("Invalid inpaint request: projectFilePath must be a string");
  }
  assertProjectFilePath(args.projectFilePath);
  const pageImage = validatePageImageAsset(args.pageImage, "inpaint");
  if (typeof args.maskPngBase64 !== "string" || args.maskPngBase64.length === 0) {
    throw new Error("Invalid inpaint request: maskPngBase64 must be a non-empty string");
  }
  if (!isInpaintingMode(args.mode)) {
    throw new Error("Invalid inpaint request: mode is not supported");
  }
  if (args.provider !== undefined && !isInpaintingProvider(args.provider)) {
    throw new Error("Invalid inpaint request: provider is not supported");
  }
  if (args.promptOverride !== undefined && typeof args.promptOverride !== "string") {
    throw new Error("Invalid inpaint request: promptOverride must be a string");
  }
  let options: InpaintPageImageRequest["options"];
  if (args.options !== undefined) {
    if (!isRecord(args.options)) {
      throw new Error("Invalid inpaint request: options must be an object");
    }
    options = {
      conservative: typeof args.options.conservative === "boolean" ? args.options.conservative : undefined,
      skipOnLowConfidence: typeof args.options.skipOnLowConfidence === "boolean" ? args.options.skipOnLowConfidence : undefined,
      dilatePixels: typeof args.options.dilatePixels === "number" ? args.options.dilatePixels : undefined
    };
  }

  return {
    requestId,
    projectFilePath: args.projectFilePath,
    pageImage,
    maskPngBase64: args.maskPngBase64,
    mode: args.mode,
    provider: args.provider,
    promptOverride: args.promptOverride,
    options
  };
}

export function validateProductionOcrRequestArgs(args: unknown): ExtractSpeechBubblesRequest {
  if (!isRecord(args)) throw new Error("Invalid Production OCR request: expected object");
  const expectedKeys = ["requestId", "projectSessionId", "pageImageId", "sourceSha256"];
  const keys = Object.keys(args);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    throw new Error("Invalid Production OCR request: legacy routing or unknown fields are not allowed");
  }
  const requestId = requireNonEmptyString(args.requestId, "requestId");
  const projectSessionId = requireNonEmptyString(args.projectSessionId, "projectSessionId");
  const pageImageId = requireNonEmptyString(args.pageImageId, "pageImageId");
  const sourceSha256 = requireNonEmptyString(args.sourceSha256, "sourceSha256").toLocaleLowerCase("en-US");
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) {
    throw new Error("Invalid Production OCR request: sourceSha256 must be a SHA-256 digest");
  }
  return { requestId, projectSessionId, pageImageId, sourceSha256 };
}

export function validateApplyProductionOcrReviewArgs(args: unknown): ApplyProductionOcrReviewRequest {
  if (!isRecord(args)) throw new Error("Invalid Production OCR review request: expected object");
  const expectedKeys = ["projectSessionId", "pageImageId", "sourceSha256", "runId", "candidates"];
  const keys = Object.keys(args);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    throw new Error("Invalid Production OCR review request: unknown fields are not allowed");
  }
  const projectSessionId = requireNonEmptyString(args.projectSessionId, "projectSessionId");
  const pageImageId = requireNonEmptyString(args.pageImageId, "pageImageId");
  const sourceSha256 = requireNonEmptyString(args.sourceSha256, "sourceSha256").toLocaleLowerCase("en-US");
  const runId = requireNonEmptyString(args.runId, "runId");
  if (!/^[0-9a-f]{64}$/.test(sourceSha256) || !Array.isArray(args.candidates)) {
    throw new Error("Invalid Production OCR review request: source or candidates are malformed");
  }
  const candidates = args.candidates.map(validateProductionOcrReviewCandidate);
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error("Invalid Production OCR review request: duplicate candidate IDs");
  }
  return { projectSessionId, pageImageId, sourceSha256, runId, candidates };
}

function validateProductionOcrReviewCandidate(value: unknown): ApplyProductionOcrReviewRequest["candidates"][number] {
  if (!isRecord(value)) throw new Error("Invalid Production OCR review request: candidate must be an object");
  const requiredKeys = [
    "id", "textType", "text", "language", "bbox", "polygon", "readingOrder", "confidence",
    "notes", "selectedSpeaker", "orientation", "productionOcrProvenance"
  ];
  const allowedKeys = new Set([...requiredKeys, "typesetting"]);
  const keys = Object.keys(value);
  const provenance = value.productionOcrProvenance;
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowedKeys.has(key)) ||
    typeof value.id !== "string" || !value.id ||
    typeof value.text !== "string" ||
    typeof value.textType !== "string" || !(ocrTextTypes as readonly string[]).includes(value.textType) ||
    typeof value.language !== "string" || !(extractionLanguages as readonly string[]).includes(value.language) ||
    !isProductionNormalizedBbox(value.bbox) ||
    !Array.isArray(value.polygon) || value.polygon.length !== 4 || !value.polygon.every(isProductionNormalizedPoint) ||
    typeof value.readingOrder !== "number" || !Number.isInteger(value.readingOrder) || value.readingOrder < 1 ||
    typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
    typeof value.notes !== "string" ||
    typeof value.selectedSpeaker !== "string" ||
    (value.orientation !== "horizontal" && value.orientation !== "vertical" && value.orientation !== "unknown") ||
    !isRecord(provenance) ||
    provenance.contractVersion !== 1 ||
    provenance.detectorModelId !== PRODUCTION_OCR_CONTRACT.detector.modelId ||
    provenance.detectorRevision !== PRODUCTION_OCR_CONTRACT.detector.revision ||
    provenance.recognizerModelId !== PRODUCTION_OCR_CONTRACT.recognizer.modelId ||
    provenance.recognizerRevision !== PRODUCTION_OCR_CONTRACT.recognizer.revision ||
    provenance.groupId !== value.id ||
    provenance.orientation !== value.orientation ||
    provenance.confidenceSource !== "detector_min" ||
    !isProductionOcrProvenance(provenance) ||
    (value.typesetting !== undefined && !isProductionReviewTypesetting(value.typesetting))
  ) {
    throw new Error("Invalid Production OCR review request: candidate contract mismatch");
  }
  return structuredClone(value) as ApplyProductionOcrReviewRequest["candidates"][number];
}

function isProductionOcrProvenance(value: Record<string, unknown>): boolean {
  const expectedKeys = [
    "contractVersion", "detectorModelId", "detectorRevision", "recognizerModelId", "recognizerRevision",
    "groupId", "sourceDetectionIds", "sourceQuadsPx", "sourceDetectionScores", "orientation", "cropTransform", "confidenceSource"
  ];
  if (Object.keys(value).length !== expectedKeys.length || Object.keys(value).some((key) => !expectedKeys.includes(key))) {
    return false;
  }
  if (
    !Array.isArray(value.sourceDetectionIds) || value.sourceDetectionIds.length === 0 ||
    !value.sourceDetectionIds.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(value.sourceDetectionIds).size !== value.sourceDetectionIds.length ||
    !Array.isArray(value.sourceQuadsPx) || value.sourceQuadsPx.length !== value.sourceDetectionIds.length ||
    !Array.isArray(value.sourceDetectionScores) || value.sourceDetectionScores.length !== value.sourceDetectionIds.length ||
    !value.sourceDetectionScores.every((score) =>
      typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1) ||
    !isProductionCropTransform(value.cropTransform)
  ) return false;
  const crop = value.cropTransform;
  if (!isRecord(crop)) return false;
  return value.sourceQuadsPx.every((quad) =>
    Array.isArray(quad) && quad.length === 4 && quad.every((point) =>
      isProductionPixelPoint(point, crop.imageWidth, crop.imageHeight)));
}

function isProductionCropTransform(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    "sourceBboxPx", "cropBboxPx", "paddingRatio", "rotationDegrees", "imageWidth", "imageHeight"
  ];
  if (Object.keys(value).length !== expectedKeys.length || Object.keys(value).some((key) => !expectedKeys.includes(key))) {
    return false;
  }
  if (
    value.paddingRatio !== 0.08 || value.rotationDegrees !== 0 ||
    typeof value.imageWidth !== "number" || !Number.isInteger(value.imageWidth) || value.imageWidth < 1 ||
    typeof value.imageHeight !== "number" || !Number.isInteger(value.imageHeight) || value.imageHeight < 1
  ) return false;
  return isProductionPixelBbox(value.sourceBboxPx, value.imageWidth, value.imageHeight)
    && isProductionPixelBbox(value.cropBboxPx, value.imageWidth, value.imageHeight);
}

function isProductionPixelPoint(value: unknown, imageWidth: unknown, imageHeight: unknown): boolean {
  return isRecord(value) &&
    typeof imageWidth === "number" && typeof imageHeight === "number" &&
    typeof value.x === "number" && Number.isFinite(value.x) && value.x >= 0 && value.x <= imageWidth &&
    typeof value.y === "number" && Number.isFinite(value.y) && value.y >= 0 && value.y <= imageHeight;
}

function isProductionPixelBbox(value: unknown, imageWidth: number, imageHeight: number): boolean {
  if (!isRecord(value)) return false;
  return typeof value.x === "number" && Number.isFinite(value.x) && value.x >= 0 &&
    typeof value.y === "number" && Number.isFinite(value.y) && value.y >= 0 &&
    typeof value.width === "number" && Number.isFinite(value.width) && value.width > 0 &&
    typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0 &&
    value.x + value.width <= imageWidth && value.y + value.height <= imageHeight;
}

function isProductionReviewTypesetting(value: unknown): boolean {
  if (!isRecord(value) || !isProductionNormalizedBbox(value.bbox)) return false;
  const allowedKeys = new Set([
    "bbox", "writingMode", "rotationDegrees", "shape", "fontFamily", "fontSizeRatio", "color",
    "strokeColor", "strokeWidth", "align", "lineHeight"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (value.writingMode !== "horizontal-tb" && value.writingMode !== "vertical-rl") return false;
  if (value.rotationDegrees !== undefined && !isFiniteNumber(value.rotationDegrees)) return false;
  if (value.shape !== undefined && !["rectangle", "ellipse", "rounded_rectangle", "cloud", "spiky"].includes(String(value.shape))) return false;
  if (value.align !== undefined && !["center", "left", "right"].includes(String(value.align))) return false;
  if ([value.fontFamily, value.color, value.strokeColor].some((entry) => entry !== undefined && typeof entry !== "string")) return false;
  if (value.fontSizeRatio !== undefined && (!isFiniteNumber(value.fontSizeRatio) || value.fontSizeRatio <= 0)) return false;
  if (value.strokeWidth !== undefined && (!isFiniteNumber(value.strokeWidth) || value.strokeWidth < 0)) return false;
  if (value.lineHeight !== undefined && (!isFiniteNumber(value.lineHeight) || value.lineHeight <= 0)) return false;
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProductionNormalizedBbox(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [value.x, value.y, value.width, value.height].every((coordinate) =>
    typeof coordinate === "number" && Number.isFinite(coordinate)) &&
    typeof value.x === "number" && value.x >= 0 &&
    typeof value.y === "number" && value.y >= 0 &&
    typeof value.width === "number" && value.width > 0 &&
    typeof value.height === "number" && value.height > 0 &&
    value.x + value.width <= 1 && value.y + value.height <= 1;
}

function isProductionNormalizedPoint(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.x === "number" && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1 &&
    typeof value.y === "number" && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1;
}

export function validateSpeechBubbleValidationArgs(args: unknown): ValidateSpeechBubbleExtractionRequest {
  if (!isRecord(args)) throw new Error("Invalid speech bubble validation request: expected object");
  const requestId = requireNonEmptyString(args.requestId, "requestId");
  if (typeof args.projectFilePath !== "string") {
    throw new Error("Invalid speech bubble validation request: projectFilePath must be a string");
  }
  assertProjectFilePath(args.projectFilePath);
  const pageImage = validatePageImageAsset(args.pageImage, "speech bubble validation");
  if (!isRecord(args.geminiExtraction)) {
    throw new Error("Invalid speech bubble validation request: geminiExtraction must be an object");
  }

  return {
    requestId,
    projectFilePath: args.projectFilePath,
    pageImage,
    geminiExtraction: args.geminiExtraction as ValidateSpeechBubbleExtractionRequest["geminiExtraction"],
    characters: normalizeOcrCharacterContext(args.characters)
  };
}

function normalizeOcrCharacterContext(value: unknown): OcrCharacterContext[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(isRecord)
    .map((character) => ({
      name: typeof character.name === "string" ? character.name.trim() : "",
      aliases: Array.isArray(character.aliases)
        ? character.aliases
            .filter((alias): alias is string => typeof alias === "string")
            .map((alias) => alias.trim())
            .filter(Boolean)
            .slice(0, 5)
        : [],
      description: normalizeOptionalContextString(character.description),
      speechStyle: normalizeOptionalContextString(character.speechStyle),
      relationshipNotes: normalizeOptionalContextString(character.relationshipNotes)
    }))
    .filter((character) => character.name.length > 0)
    .slice(0, 20);
}

function normalizeOptionalContextString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function validatePageImageAsset(value: unknown, requestLabel: string): PageImage {
  if (!isRecord(value)) throw new Error(`Invalid ${requestLabel} request: pageImage must be an object`);
  if (!isNonEmptyString(value.id)) {
    throw new Error(`Invalid ${requestLabel} request: pageImage.id must be a non-empty string`);
  }
  if (typeof value.pageNumber !== "number" || !Number.isInteger(value.pageNumber) || value.pageNumber < 1) {
    throw new Error(`Invalid ${requestLabel} request: pageImage page number must be a positive integer`);
  }
  if (!isNonEmptyString(value.storedRelativePath)) {
    throw new Error(`Invalid ${requestLabel} request: pageImage.storedRelativePath must be a non-empty string`);
  }
  if (!isNonEmptyString(value.originalFileName)) {
    throw new Error(`Invalid ${requestLabel} request: pageImage.originalFileName must be a non-empty string`);
  }
  if (!isNonEmptyString(value.sha256) || !/^[a-f0-9]{64}$/i.test(value.sha256)) {
    throw new Error(`Invalid ${requestLabel} request: pageImage.sha256 must be a 64-character hex string`);
  }
  if (typeof value.byteSize !== "number" || !Number.isInteger(value.byteSize) || value.byteSize < 0) {
    throw new Error(`Invalid ${requestLabel} request: pageImage.byteSize must be a non-negative integer`);
  }
  if (!isNonEmptyString(value.mimeType)) {
    throw new Error(`Invalid ${requestLabel} request: pageImage.mimeType must be a non-empty string`);
  }
  if (!isNonEmptyString(value.copiedAt)) {
    throw new Error(`Invalid ${requestLabel} request: pageImage.copiedAt must be a non-empty string`);
  }

  return {
    id: value.id,
    pageNumber: value.pageNumber,
    storedRelativePath: value.storedRelativePath,
    originalFileName: value.originalFileName,
    sha256: value.sha256,
    byteSize: value.byteSize,
    mimeType: value.mimeType,
    copiedAt: value.copiedAt
  };
}

export function validateResolvePageImageSrcArgs(args: unknown): ResolvePageImageSrcArgs {
  if (!isRecord(args)) throw new Error("Invalid image source request: expected object");
  if (typeof args.projectFilePath !== "string") {
    throw new Error("Invalid image source request: projectFilePath must be a string");
  }
  if (typeof args.storedRelativePath !== "string") {
    throw new Error("Invalid image source request: storedRelativePath must be a string");
  }
  assertProjectFilePath(args.projectFilePath);
  if (isAbsolute(args.storedRelativePath)) {
    throw new Error("Invalid image source request: storedRelativePath must be relative");
  }

  return {
    projectFilePath: args.projectFilePath,
    storedRelativePath: args.storedRelativePath
  };
}

export function validateGeminiApiKeyArgs(args: unknown): { apiKey: string } {
  if (!isRecord(args)) throw new Error("Invalid Gemini API key request: expected object");
  if (typeof args.apiKey !== "string") {
    throw new Error("Invalid Gemini API key request: apiKey must be a string");
  }

  const apiKey = args.apiKey.trim();
  if (!apiKey) throw new Error("Invalid Gemini API key request: apiKey must be non-empty");
  return { apiKey };
}

function hasGeminiApiKey(): boolean {
  return typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.trim().length > 0;
}

function resolvePageImageFileUrl(
  args: ResolvePageImageSrcArgs,
  projectSessionId?: string
): string {
  const projectDirectory = resolve(dirname(args.projectFilePath));
  const absoluteImagePath = resolve(projectDirectory, args.storedRelativePath);
  const rel = relative(projectDirectory, absoluteImagePath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error("Invalid image source request: image must be inside the project folder");
  }

  const token = createHash("sha256")
    .update(`${projectSessionId || ""}:${absoluteImagePath}`)
    .digest("hex")
    .slice(0, 32);

  if (pageImageProtocolPaths.size > 1000) {
    const oldestKey = pageImageProtocolPaths.keys().next().value;
    if (oldestKey) pageImageProtocolPaths.delete(oldestKey);
  }

  pageImageProtocolPaths.set(token, absoluteImagePath);
  if (projectSessionId) {
    const tokens = projectSessionProtocolIds.get(projectSessionId) ?? new Set<string>();
    tokens.add(token);
    projectSessionProtocolIds.set(projectSessionId, tokens);
  }
  return `${pageImageProtocol}://${pageImageProtocolHost}/${token}`;
}

function releaseProjectSessionPageImages(projectSessionId: string): void {
  const tokens = projectSessionProtocolIds.get(projectSessionId);
  if (!tokens) return;
  for (const token of tokens) pageImageProtocolPaths.delete(token);
  projectSessionProtocolIds.delete(projectSessionId);
  const prefix = `${projectSessionId}\0`;
  for (const key of importBatchPreviewTokens.keys()) {
    if (key.startsWith(prefix)) importBatchPreviewTokens.delete(key);
  }
}

function importBatchPreviewKey(
  projectSessionId: string,
  importBatchId: string
): string {
  return `${projectSessionId}\0${importBatchId}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function registerPageImageProtocol(): void {
  if (pageImageProtocolRegistered) return;
  pageImageProtocolRegistered = true;
  protocol.handle(pageImageProtocol, async (request) => {
    const url = new URL(request.url);
    const token = url.hostname === pageImageProtocolHost ? url.pathname.slice(1) : "";
    const filePath = pageImageProtocolPaths.get(token);
    if (!filePath) throw new Error("Unknown page image asset");
    const imageBytes = await readFile(filePath);
    return new Response(new Uint8Array(imageBytes), {
      headers: {
        "cache-control": "no-store",
        "content-type": getImageMimeType(filePath)
      }
    });
  });
}

function getImageMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".png":
    default:
      return "image/png";
  }
}

export function validateOpenProjectArgs(args?: unknown): OpenProjectArgs {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw new Error("Invalid open request: expected object");
  if (args.filePath !== undefined && typeof args.filePath !== "string") {
    throw new Error("Invalid open request: filePath must be a string");
  }
  if (args.filePath !== undefined) assertProjectFilePath(args.filePath);
  if (args.password !== undefined && typeof args.password !== "string") {
    throw new Error("Invalid open request: password must be a string");
  }

  return {
    filePath: args.filePath,
    password: args.password
  };
}

function assertProjectFilePath(filePath: string): void {
  assertFileExtension(filePath, ".ctp", "Project file path must end with .ctp");
}

function assertTextFilePath(filePath: string): void {
  assertFileExtension(filePath, ".txt", "Translation export path must end with .txt");
}

function assertFileExtension(filePath: string, extension: string, message: string): void {
  if (extname(filePath).toLowerCase() !== extension) throw new Error(message);
}

function validateStringArray(value: unknown, requestLabel: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${requestLabel} request: expected string array`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) throw new Error(`Invalid request: ${field} must be a non-empty string`);
  return value;
}

function classifyProjectOpenFailure(error: unknown): import("../shared/projectSessionTypes.js").ProjectOpenFailureResult {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (/Unknown recent project/i.test(message)) {
    return {
      openFailed: true,
      code: "RECENT_NOT_FOUND",
      retryable: false,
      message: "최근 프로젝트 항목을 찾을 수 없습니다."
    };
  }
  if (code === "ENOENT") {
    return {
      openFailed: true,
      code: "PROJECT_FILE_NOT_FOUND",
      retryable: false,
      message: "최근 프로젝트 파일이 이동되었거나 삭제되었습니다."
    };
  }
  if (/Unable to decrypt project|password/i.test(message)) {
    return {
      openFailed: true,
      code: "INVALID_PASSWORD",
      retryable: true,
      message: "암호가 올바르지 않습니다. 다시 입력하세요."
    };
  }
  if (/PROJECT_IMPORT_BUSY/.test(message)) {
    return {
      openFailed: true,
      code: "PROJECT_BUSY",
      retryable: true,
      message: "프로젝트의 이미지 복구 작업이 진행 중입니다. 잠시 후 다시 시도하세요."
    };
  }
  if (code === "EACCES" || code === "EPERM" || code === "EBUSY") {
    return {
      openFailed: true,
      code: "PERMISSION_DENIED",
      retryable: true,
      message: "프로젝트 파일에 접근할 수 없습니다. 권한이나 다른 프로그램의 사용 여부를 확인하세요."
    };
  }
  if (/recover|recovery|candidate|backup/i.test(message)) {
    return {
      openFailed: true,
      code: "RECOVERY_FAILED",
      retryable: true,
      message: "프로젝트 복구를 완료하지 못했습니다. 원본과 백업을 확인한 뒤 다시 시도하세요."
    };
  }
  return {
    openFailed: true,
    code: "OPEN_FAILED",
    retryable: true,
    message: "프로젝트를 열지 못했습니다. 잠시 후 다시 시도하세요."
  };
}

function requireNonEmptyTrimmedString(value: unknown, field: string): string {
  const result = requireNonEmptyString(value, field).trim();
  if (!result) throw new Error(`Invalid request: ${field} must be a non-empty string`);
  return result;
}

function requireTranslationRequestId(value: unknown): string {
  const requestId = requireNonEmptyTrimmedString(value, "requestId");
  if (requestId.length > 200) {
    throw new Error("Invalid request: requestId must be at most 200 characters");
  }
  return requestId;
}

function safeOcrValidationFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout") || message.includes("시간") || message.includes("respond") || message.includes("응답")) {
    return "검증 요청 시간이 초과되었습니다.";
  }
  if (message.includes("429") || message.includes("quota") || message.includes("rate")) {
    return "검증 Provider의 요청 한도를 확인하세요.";
  }
  if (message.includes("network") || message.includes("fetch") || message.includes("econn")) {
    return "검증 Provider의 네트워크 응답을 받지 못했습니다.";
  }
  return "검증 Provider 요청에 실패했습니다.";
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid request: ${field} must be a positive integer`);
  }
  return value;
}


function validateIdRequest(args: unknown, field: string): string {
  if (!isRecord(args)) throw new Error(`Invalid request: expected object with ${field}`);
  return requireNonEmptyString(args[field], field);
}

export function validateTestLocalAiConnectionArgs(args: unknown): TestLocalAiConnectionArgs {
  if (!isRecord(args)) throw new Error("Invalid local AI connection request: expected object");
  const runtime = typeof args.runtime === "string" && ["ollama", "lmstudio", "vllm", "custom"].includes(args.runtime)
    ? (args.runtime as LocalAiRuntime)
    : "ollama";
  const endpoint = typeof args.endpoint === "string" && args.endpoint.trim() ? args.endpoint.trim() : "http://localhost:11434";
  return { runtime, endpoint };
}

export function validateListLocalAiModelsArgs(args: unknown): ListLocalAiModelsArgs {
  if (!isRecord(args)) throw new Error("Invalid local AI models request: expected object");
  const runtime = typeof args.runtime === "string" && ["ollama", "lmstudio", "vllm", "custom"].includes(args.runtime)
    ? (args.runtime as LocalAiRuntime)
    : "ollama";
  const endpoint = typeof args.endpoint === "string" && args.endpoint.trim() ? args.endpoint.trim() : "http://localhost:11434";
  return { runtime, endpoint };
}

export function validateGenerateLocalAiTranslationArgs(args: unknown): GenerateLocalAiTranslationArgs {
  if (!isRecord(args)) throw new Error("Invalid local AI translation request: expected object");
  if (typeof args.endpoint !== "string" || !args.endpoint.trim()) {
    throw new Error("Invalid local AI translation request: endpoint must be a non-empty string");
  }
  if (typeof args.model !== "string" || !args.model.trim()) {
    throw new Error("Invalid local AI translation request: model must be a non-empty string");
  }
  if (typeof args.sourceText !== "string" || !args.sourceText.trim()) {
    throw new Error("Invalid local AI translation request: sourceText must be a non-empty string");
  }

  const runtime = typeof args.runtime === "string" && ["ollama", "lmstudio", "vllm", "custom"].includes(args.runtime)
    ? (args.runtime as LocalAiRuntime)
    : undefined;

  return {
    runtime,
    endpoint: args.endpoint.trim(),
    model: args.model.trim(),
    sourceText: args.sourceText.trim(),
    sourceLanguage: args.sourceLanguage === "ja" || args.sourceLanguage === "en" || args.sourceLanguage === "auto" ? args.sourceLanguage : undefined,
    previousContext: Array.isArray(args.previousContext) ? args.previousContext.filter((c): c is string => typeof c === "string") : undefined,
    characterNotes: typeof args.characterNotes === "string" ? args.characterNotes.trim() : undefined,
    glossaryNotes: typeof args.glossaryNotes === "string" ? args.glossaryNotes.trim() : undefined,
    systemPrompt: typeof args.systemPrompt === "string" ? args.systemPrompt.trim() : undefined,
    temperature: typeof args.temperature === "number" && !isNaN(args.temperature) ? args.temperature : undefined
  };
}

export type ValidatedBatchRunArgs = {
  requestId: string;
  config: BatchPipelineConfig;
  project?: TranslationProject;
  projectSessionId?: string;
  pageCount?: number;
};

function ensureProjectDialogueLineOrigins(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.dialogueLines)) return raw;
  return {
    ...raw,
    dialogueLines: raw.dialogueLines.map((line) => {
      if (isRecord(line) && !line.origin) {
        return { ...line, origin: { kind: "manual" as const } };
      }
      return line;
    })
  };
}

export function validateBatchRunArgs(args: unknown): ValidatedBatchRunArgs {
  if (!isRecord(args)) {
    throw new Error("Invalid batch:run arguments: payload must be an object");
  }
  if (typeof args.requestId !== "string" || !args.requestId.trim() || args.requestId.length > 256) {
    throw new Error("Invalid batch:run arguments: requestId must be a non-empty string with length <= 256");
  }
  const validatedConfig = validateBatchPipelineConfig(args.config);

  const projectSessionId =
    typeof args.projectSessionId === "string" && args.projectSessionId.trim()
      ? args.projectSessionId.trim()
      : undefined;

  let project: TranslationProject | undefined;
  if (!projectSessionId) {
    if (!("project" in args) || !args.project) {
      throw new Error("Invalid batch:run arguments: project or projectSessionId is required");
    }
    project = normalizeProject(ensureProjectDialogueLineOrigins(args.project));
  } else if ("project" in args && args.project !== undefined && args.project !== null) {
    if (isRecord(args.project)) {
      project = normalizeProject(ensureProjectDialogueLineOrigins(args.project));
    }
  }

  let pageCount: number | undefined;
  if ("pageCount" in args && args.pageCount !== undefined && args.pageCount !== null) {
    if (typeof args.pageCount !== "number" || !Number.isInteger(args.pageCount) || args.pageCount < 1) {
      throw new Error("Invalid batch:run arguments: pageCount must be a positive integer >= 1");
    }
    pageCount = args.pageCount;
  }

  return {
    requestId: args.requestId.trim(),
    config: validatedConfig,
    project,
    projectSessionId,
    pageCount
  };
}
