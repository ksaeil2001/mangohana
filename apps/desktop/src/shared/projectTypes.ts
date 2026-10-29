export type DialogueType = "speech" | "thought" | "narration" | "unknown";
export type SourceLanguage = "ja" | "en" | "mixed" | "unknown";
export type LineStatus = "untranslated" | "draft" | "complete" | "review";
export type TranslationMode = "fast" | "precise";

import type {
  OcrUserOwnedField,
  ProductionOcrOrientation,
  ProductionOcrProvenance
} from "./productionOcr.js";

export type DialogueTypesetting = {
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  writingMode: "horizontal-tb" | "vertical-rl";
  rotationDegrees?: number;
  shape?: "rectangle" | "ellipse" | "rounded_rectangle" | "cloud" | "spiky";
  fontFamily?: string;
  fontSizeRatio?: number;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  align?: "center" | "left" | "right";
  lineHeight?: number;
};

export type OcrEditStatus = "ai_proposed" | "user_modified" | "user_confirmed";

export type TextRegionSourceInfo = {
  detectorName?: string;
  ocrEngine?: string;
  rawMangaOcrText?: string;
  rawPaddleOcrText?: string;
  confidence?: number;
  isCrossValidated?: boolean;
  orientation?: ProductionOcrOrientation;
  productionOcrProvenance?: ProductionOcrProvenance;
};

export type DialogueLine = {
  id: string;
  order: number;
  pageNumber: number;
  speaker?: string;
  position?: string;
  dialogueType: DialogueType;
  lineStatus?: LineStatus;
  sourceLanguage: SourceLanguage;
  sourceText: string;
  referenceTranslation?: string;
  aiTranslation?: string;
  userTranslation?: string;
  notes?: string;
  parseConfidence: number;
  parseWarnings: string[];
  typesetting?: DialogueTypesetting;
  ocrEditStatus?: OcrEditStatus;
  ocrUserOwnedFields?: OcrUserOwnedField[];
  ocrGroupId?: string;
  userOverrideSourceText?: string;
  polygon?: Array<{ x: number; y: number }>;
  ocrSourceInfo?: TextRegionSourceInfo;
};

export type PageImage = {
  id: string;
  pageNumber: number;
  storedRelativePath: string;
  originalFileName: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  copiedAt: string;
};

export type PreparedPageImage = {
  id: string;
  sourcePath?: string;
  importBatchId?: string;
  preparedImageId?: string;
  fileName: string;
  previewSrc: string;
  byteSize: number;
  mimeType?: string;
};

export type CharacterProfile = {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  speechStyle?: string;
  relationshipNotes?: string;
};

export type TermCondition = {
  speaker?: string;
  dialogueType?: DialogueType;
  targetContext?: string;
};

export type DictionaryTermCategory = "character" | "skill" | "location" | "tone" | "general";

export type DictionaryTerm = {
  id: string;
  source: string;
  target: string;
  note?: string;
  category?: DictionaryTermCategory;
  condition?: TermCondition;
  priority?: number;
};

export type TranslationProject = {
  schemaVersion: number;
  metadata: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    secret: boolean;
  };
  characters: CharacterProfile[];
  dictionaryTerms: DictionaryTerm[];
  dialogueLines: DialogueLine[];
  pageImages: PageImage[];
  settings: {
    defaultSourceLanguage: SourceLanguage;
    translationMode?: TranslationMode;
  };
};

export type DialogueOrigin =
  | { kind: "manual" }
  | {
      kind: "pipeline";
      persistentRegionId: string;
      latestRunId: string;
      latestRegionId: string;
      pageImageId: string;
      candidateIds: string[];
      readingIndex: number;
      sourceFingerprint: string;
    };

export type DialogueLineV2 = DialogueLine & {
  origin: DialogueOrigin;
  orphanedFromPipeline?: boolean;
};

export type ProcessingRunStatus =
  | "queued"
  | "running"
  | "committing"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "orphaned";

export type ProcessingRunSource =
  | "automatic_pipeline"
  | "manual_openai"
  | "manual_gemini"
  | "manual_local_edit";

export type PipelineError = {
  code: string;
  message: string;
  retryable: boolean;
  stage?: string;
  details?: Record<string, string | number | boolean>;
};

import type { InpaintingQaResult } from "./inpaintingQa.js";

export type DerivedImageAsset = {
  assetId: string;
  source: ProcessingRunSource;
  sourcePageImageId: string;
  runId: string;
  role: "cleaned" | "translated" | "debug" | "manual_preview" | "mask";
  storedRelativePath: string;
  sha256: string;
  byteSize: number;
  mimeType: "image/png";
  createdAt: string;
  inpaintingQa?: InpaintingQaResult;
  maskAssetId?: string;
};

export type ProcessingRunRecord = {
  runId: string;
  pageImageId: string;
  source: ProcessingRunSource;
  status: ProcessingRunStatus;
  sourceSha256: string;
  appVersion: string;
  pipelineVersion?: string;
  protocolVersion?: "1.0";
  profile?: "fast" | "precise";
  queuedAt: string;
  startedAt?: string;
  committingAt?: string;
  completedAt?: string;
  commitMarkerRelativePath?: string;
  canonicalManifestRelativePath?: string;
  error?: PipelineError;
};

export type PageProcessingRecord = {
  pageImageId: string;
  activeRunId?: string;
  latestCompletedRunId?: string;
  approvedCleanedAssetId?: string;
  /** Explicit user review of the current cleaned result, independent of technical approval/QA. */
  userReviewedCleanedAssetId?: string;
  approvedTranslatedAssetId?: string;
  approvedMaskAssetId?: string;
  finalStatus: "pending" | "auto_approved" | "needs_review" | "rolled_back" | "skipped" | "failed";
  updatedAt: string;
  inpaintingQa?: InpaintingQaResult;
};

export type ProcessingQueueStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type ProcessingQueueStage =
  | "ocr"
  | "speaker_review"
  | "translation"
  | "inpainting"
  | "typesetting"
  | "completed";

export type ProcessingQueuePageStatus =
  | "pending"
  | "running"
  | "paused"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type ProcessingQueuePageRecord = {
  pageImageId: string;
  status: ProcessingQueuePageStatus;
  stage: ProcessingQueueStage;
  revision: number;
  runId?: string;
  requiresExternalResume?: boolean;
  error?: PipelineError;
  updatedAt: string;
};

export type ProcessingQueueState = {
  schemaVersion: 1;
  queueId: string;
  projectSessionId: string;
  status: ProcessingQueueStatus;
  pageImageIds: string[];
  pages: ProcessingQueuePageRecord[];
  currentPageIndex: number;
  currentRunId?: string;
  pauseReason?: string;
  failureReason?: string;
  lastUpdatedAt: string;
};

export type ProcessingState = {
  pages: PageProcessingRecord[];
  runs: ProcessingRunRecord[];
  assets: DerivedImageAsset[];
  queue?: ProcessingQueueState;
};

export type TranslationProjectV2 = {
  schemaVersion: 2;
  metadata: TranslationProject["metadata"];
  characters: CharacterProfile[];
  dictionaryTerms: DictionaryTerm[];
  dialogueLines: DialogueLineV2[];
  pageImages: PageImage[];
  settings: TranslationProject["settings"] & {
    allowExternalAi?: boolean;
    debugArtifactsEnabled?: boolean;
  };
  processing: ProcessingState;
};

export type SecretProjectSecurityV1 = {
  artifactKeyVersion: 1;
  artifactMasterKeyB64: string;
};

export type TranslationProjectPersistedV2 =
  | (TranslationProjectV2 & {
      metadata: TranslationProjectV2["metadata"] & { secret: false };
      security?: never;
    })
  | (TranslationProjectV2 & {
      metadata: TranslationProjectV2["metadata"] & { secret: true };
      security: SecretProjectSecurityV1;
    });

export type AnyTranslationProject = TranslationProject | TranslationProjectV2;

export type EditableTranslationProject = Omit<TranslationProjectV2, "dialogueLines"> & {
  dialogueLines: Array<
    DialogueLine & {
      origin?: DialogueOrigin;
      orphanedFromPipeline?: boolean;
    }
  >;
};

export type {
  ChunkedProjectSnapshot,
  HydratedPageChunkDto,
  PageChunk,
  PageHydrationRequest,
  PageHydrationResult,
  PageSummaryIndex,
  PageSummaryStatus,
  ProjectManifest,
  ViewportCacheConfig,
  ViewportHydrationPlan
} from "./projectChunkTypes.js";
