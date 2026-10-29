import type { DialogueLine, PageImage, PreparedPageImage, TranslationProject } from "../shared/projectTypes.js";
import type { ApplyProjectMutationArgs, ReviewCleanedAssetArgs, ProjectChangeResult, ProjectOpenFailureResult, ProjectPasswordRequiredResult as SessionPasswordRequiredResult, ProjectSaveResult, ProjectSessionResult } from "../shared/projectSessionTypes.js";
import type {
  PageImageImportResult,
  PreparedPageImageBatchDto
} from "../shared/projectSessionTypes.js";
import type {
  PageHydrationRequest,
  PageHydrationResult
} from "../shared/projectChunkTypes.js";

import type {
  InpaintPageImageRequest,
  InpaintPageImageResult,
  InpaintPageImageSessionRequest
} from "../shared/inpainting.js";
import type { GeminiApiKeyStatus } from "../shared/geminiApiKey.js";
import type {
  ApplyProductionOcrReviewRequest,
  ExtractSpeechBubblesRequest,
  SpeechBubbleExtractionResult,
  ValidateSpeechBubbleExtractionRequest
} from "../shared/speechBubbleExtraction.js";
import type { EnvironmentPreparationSnapshot } from "../shared/environmentPreparation.js";
import type { AutoUpdateState } from "../shared/autoUpdateStatus.js";
import type { GlossaryExtractionResult } from "../shared/glossaryPipeline.js";
import type { InpaintingQaResult } from "../shared/inpaintingQa.js";
import type {
  CharacterProfile,
  DictionaryTerm
} from "../shared/projectTypes.js";
import type { BatchProgressEvent, ProcessingQueueActionArgs, ProcessingQueueActionResult } from "../shared/processingQueue.js";
import type { RenderReadinessReport } from "../shared/renderReadiness.js";
import type { ProjectImageExportResult } from "../main/projectImageExport.js";

import type {
  DialogueTurnContext,
  FuzzyTmCandidate,
  InspectTranslationQaArgs,
  TranslationContextPayload,
  TranslationMemoryEntry,
  TranslationQaReport
} from "../shared/translationContext.js";

export type ProjectFileResult = {
  filePath: string;
  project: TranslationProject;
  encrypted: boolean;
};

export type ProjectPasswordRequiredResult = {
  filePath: string;
  encrypted: true;
  passwordRequired: true;
};

export type ElectronProjectApi = {
  createProjectSession?: (args: { title: string; secret: boolean; password?: string }) => Promise<ProjectSessionResult>;
  openProjectFromDialog?: () => Promise<ProjectSessionResult | SessionPasswordRequiredResult | null>;
  openExampleProject?: () => Promise<ProjectSessionResult>;
  openRecentProject?: (args: { recentProjectId: string }) => Promise<ProjectSessionResult | SessionPasswordRequiredResult | ProjectOpenFailureResult | null>;
  unlockProject?: (args: { unlockToken: string; password: string }) => Promise<ProjectSessionResult | ProjectOpenFailureResult>;
  applyProjectMutation?: (args: ApplyProjectMutationArgs) => Promise<ProjectChangeResult>;
  reviewCleanedAsset?: (args: ReviewCleanedAssetArgs) => Promise<ProjectSaveResult>;
  hydratePage?: (args: PageHydrationRequest) => Promise<PageHydrationResult>;
  prefetchPages?: (args: {
    projectSessionId: string;
    pageNumber: number;
    radius?: number;
  }) => Promise<number[]>;
  saveProjectAs?: (args: { projectSessionId: string; filePath?: string }) => Promise<ProjectSaveResult | null>;

  rekeyProject?: (args: { projectSessionId: string; newPassword: string }) => Promise<ProjectSaveResult>;
  closeProject?: (args: { projectSessionId: string }) => Promise<void>;
  listRecentProjects?: () => Promise<Array<{ recentProjectId: string; title: string; openedAt: string }>>;
  removeRecentProject?: (args: { recentProjectId: string }) => Promise<Array<{ recentProjectId: string; title: string; openedAt: string }>>;
  importTxtFile: () => Promise<{ filePath: string; lines: DialogueLine[] } | null>;
  chooseSaveFile?: (args?: { defaultPath?: string }) => Promise<string | null>;
  exportTranslations: (args: {
    filePath?: string;
    defaultPath?: string;
    project: TranslationProject;
    projectSessionId?: string;
  }) => Promise<string | null>;
  exportProjectImages?: (args: {
    projectSessionId: string;
    defaultPath?: string;
    includeZip?: boolean;
    typesetPages?: Array<{
      pageImageId: string;
      pngBase64: string;
      readiness: RenderReadinessReport;
    }>;
  }) => Promise<ProjectImageExportResult | null>;
  updateProcessingQueue?: (args: ProcessingQueueActionArgs) => Promise<ProcessingQueueActionResult>;
  saveProject: (args:
    | { projectSessionId: string }
    | { filePath: string; project: TranslationProject; password?: string }
  ) => Promise<ProjectSaveResult | void>;
  openProject?: (args?: {
    filePath?: string;
    password?: string;
  }) => Promise<ProjectFileResult | ProjectPasswordRequiredResult | null>;
  choosePageImageFiles?: () => Promise<string[] | null>;
  choosePreparedPageImageFiles?: () => Promise<PreparedPageImage[] | null>;
  preparePageImageFiles?: (sourcePaths: string[]) => Promise<PreparedPageImage[]>;
  releasePreparedPageImages?: (ids: string[]) => Promise<void>;
  choosePageImages?: (args: {
    projectSessionId: string;
  }) => Promise<PreparedPageImageBatchDto | null>;
  preparePageImages?: (args: {
    projectSessionId: string;
    files: File[];
  }) => Promise<PreparedPageImageBatchDto>;
  releasePageImageImportBatch?: (args: {
    projectSessionId: string;
    importBatchId: string;
  }) => Promise<void>;
  getPathForFile?: (file: File) => string;
  importPageImages?: (args:
    | {
        projectSessionId: string;
        importBatchId: string;
        pages: Array<{ preparedImageId: string; pageNumber: number }>;
      }
    | {
        projectFilePath?: string;
        projectSessionId?: string;
        files: Array<{ sourcePath: string; pageNumber: number }>;
      }
  ) => Promise<
    Array<
      | PageImageImportResult
      | { ok: true; pageImage: PageImage }
      | { ok: false; sourcePath: string; message: string }
    >
  >;
  resolvePageImageSrc?: (args: { projectFilePath?: string; projectSessionId?: string; storedRelativePath: string }) => Promise<string>;
  inpaintPageImage?: (
    args: InpaintPageImageRequest | InpaintPageImageSessionRequest
  ) => Promise<PageImage | InpaintPageImageResult>;
  cancelInpainting?: (args: { requestId: string }) => Promise<{ canceled: boolean }>;
  getGeminiApiKeyStatus?: () => Promise<GeminiApiKeyStatus>;
  getProviderSettings?: () => Promise<import("../shared/providerSettings.js").ProviderSettings>;
  updateProviderSettings?: (patch: Partial<import("../shared/providerSettings.js").ProviderSettings>) => Promise<import("../shared/providerSettings.js").ProviderSettings>;
  cancelTranslation?: (args: { requestId: string }) => Promise<{ canceled: boolean }>;
  setGeminiApiKey?: (args: { apiKey: string }) => Promise<GeminiApiKeyStatus>;
  clearGeminiApiKey?: () => Promise<GeminiApiKeyStatus>;
  extractSpeechBubbles?: (args: ExtractSpeechBubblesRequest) => Promise<SpeechBubbleExtractionResult>;
  applyProductionOcrReview?: (args: ApplyProductionOcrReviewRequest) => Promise<ProjectSaveResult>;
  validateSpeechBubbles?: (args: ValidateSpeechBubbleExtractionRequest | (Omit<ValidateSpeechBubbleExtractionRequest, "projectFilePath"> & { projectSessionId: string })) => Promise<SpeechBubbleExtractionResult>;
  cancelSpeechBubbleOcr?: (args: { requestId: string }) => Promise<{ canceled: boolean }>;
  testLocalAiConnection?: (args: { runtime: "ollama" | "lmstudio" | "vllm" | "custom"; endpoint: string }) => Promise<{ ok: boolean; message: string; latencyMs?: number; version?: string }>;
  listLocalAiModels?: (args: { runtime: "ollama" | "lmstudio" | "vllm" | "custom"; endpoint: string }) => Promise<Array<{ id: string; name: string; size?: string; modifiedAt?: string }>>;
  translateWithLocalAi?: (args: {
    runtime?: "ollama" | "lmstudio" | "vllm" | "custom";
    endpoint: string;
    model: string;
    sourceText: string;
    sourceLanguage?: "ja" | "en" | "auto";
    previousContext?: string[];
    characterNotes?: string;
    glossaryNotes?: string;
    systemPrompt?: string;
    temperature?: number;
  }) => Promise<string>;
  executeTranslation?: (args: {
    projectSessionId?: string;
    targetLineId?: string;
    payload?: TranslationContextPayload;
    stylePreset?: string;
    requestId?: string;
    options?: {
      engineType?: "local_ai" | "gemini" | "tm_direct";
      geminiModel?: string;
      localAiEndpoint?: string;
      localAiModel?: string;
      localAiRuntime?: "ollama" | "lmstudio" | "vllm" | "custom";
      temperature?: number;
      skipQaInspection?: boolean;
    };
  }) => Promise<{
    translatedText: string;
    engine: string;
    usedExactTm?: boolean;
    qaReport?: TranslationQaReport;
    contextFingerprint: string;
  }>;
  commitTranslationProposal?: (args: {
    projectSessionId: string;
    targetLineId: string;
    proposal: string;
    expectedTranslationFingerprint: string;
    stylePreset?: string;
  }) => Promise<ProjectSaveResult>;
  inspectTranslationQa?: (args: InspectTranslationQaArgs) => Promise<TranslationQaReport>;
  queryTranslationMemory?: (args: {
    projectSessionId?: string;
    dialogueLines?: DialogueLine[];
    sourceText: string;
    minSimilarity?: number;
    maxCandidates?: number;
    excludeLineId?: string;
    filterSpeaker?: string;
  }) => Promise<{
    exact: TranslationMemoryEntry | null;
    fuzzy: FuzzyTmCandidate[];
  }>;
  buildTranslationPayload?: (args: {
    projectSessionId?: string;
    dialogueLines?: DialogueLine[];
    characters?: CharacterProfile[];
    dictionaryTerms?: DictionaryTerm[];
    targetLineId: string;
    stylePreset?: string;
  }) => Promise<TranslationContextPayload>;
  getEnvironmentSnapshot?: () => Promise<EnvironmentPreparationSnapshot>;
  chooseEnvironmentResourceRoot?: () => Promise<EnvironmentPreparationSnapshot | null>;
  installProductionOcr?: () => Promise<EnvironmentPreparationSnapshot>;
  getAutoUpdateState?: () => Promise<AutoUpdateState>;
  checkForAutoUpdate?: () => Promise<AutoUpdateState>;
  downloadAutoUpdate?: () => Promise<AutoUpdateState>;
  installAutoUpdate?: () => Promise<AutoUpdateState>;
  openAutoUpdateRelease?: () => Promise<void>;
  onAutoUpdateState?: (listener: (state: AutoUpdateState) => void) => () => void;
  extractGlossaryProposals?: (args: {
    projectSessionId?: string;
    dialogueLines?: DialogueLine[];
    existingCharacters?: CharacterProfile[];
    existingTerms?: DictionaryTerm[];
  }) => Promise<GlossaryExtractionResult>;
  inspectInpaintingQa?: (args: {
    projectSessionId?: string;
    pageImageId?: string;
    maskPngBase64?: string;
    inpaintedImagePngBase64?: string;
    attemptCount?: number;
  }) => Promise<InpaintingQaResult>;
  runBatchJob?: (args: {
    project?: TranslationProject;
    projectSessionId?: string;
    config: import("../shared/batchAutomation.js").BatchPipelineConfig;
    pageCount?: number;
    requestId: string;
  }) => Promise<{
    progress: import("../shared/batchAutomation.js").BatchProgressState;
    updatedProject: TranslationProject;
    sessionChange?: import("../shared/projectSessionTypes.js").ProjectChangeResult;
  }>;
  cancelBatchJob?: (args: { requestId: string }) => Promise<{ canceled: boolean }>;
  onBatchProgress?: (listener: (data: BatchProgressEvent) => void) => () => void;
};

declare global {
  interface Window {
    projectApi: ElectronProjectApi;
  }
}
