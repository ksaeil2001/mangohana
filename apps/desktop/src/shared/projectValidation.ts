import type {
  CharacterProfile,
  DialogueLine,
  DialogueLineV2,
  DialogueType,
  DialogueTypesetting,
  DictionaryTerm,
  DictionaryTermCategory,
  TermCondition,
  EditableTranslationProject,
  LineStatus,
  PageImage,
  ProcessingQueueState,
  ProcessingState,
  SourceLanguage,
  TranslationMode,
  TranslationProject,
  TranslationProjectV2
} from "./projectTypes.js";
import { PRODUCTION_OCR_CONTRACT, normalizeProductionOcrText } from "./productionOcr.js";

const dialogueTypes: DialogueType[] = ["speech", "thought", "narration", "unknown"];
const lineStatuses: LineStatus[] = ["untranslated", "draft", "complete", "review"];
const sourceLanguages: SourceLanguage[] = ["ja", "en", "mixed", "unknown"];
const ocrEditStatuses = new Set(["ai_proposed", "user_modified", "user_confirmed"]);
const ocrUserOwnedFields = new Set(["source_text", "reading_order", "geometry", "group_assignment"]);
const translationModes: TranslationMode[] = ["fast", "precise"];
const dictionaryTermCategories: DictionaryTermCategory[] = [
  "character",
  "skill",
  "location",
  "tone",
  "general"
];
const processingRunStatuses = new Set([
  "queued", "running", "committing", "cancelling", "completed", "cancelled", "failed", "orphaned"
]);
const processingRunSources = new Set([
  "automatic_pipeline", "manual_openai", "manual_gemini", "manual_local_edit"
]);
const processingAssetRoles = new Set([
  "cleaned", "translated", "debug", "manual_preview", "mask"
]);
const pageFinalStatuses = new Set([
  "pending", "auto_approved", "needs_review", "rolled_back", "skipped", "failed"
]);
const processingQueueStatuses = new Set([
  "idle", "running", "paused", "completed", "failed", "cancelled"
]);
const processingQueueStages = new Set([
  "ocr", "speaker_review", "translation", "inpainting", "typesetting", "completed"
]);
const processingQueuePageStatuses = new Set([
  "pending", "running", "paused", "awaiting_approval", "completed", "failed", "cancelled"
]);

export function createEmptyProject(title: string, secret: boolean): EditableTranslationProject {
  const now = new Date().toISOString();

  return {
    schemaVersion: 2,
    metadata: {
      id: createProjectId(),
      title,
      createdAt: now,
      updatedAt: now,
      secret
    },
    characters: [],
    dictionaryTerms: [],
    dialogueLines: [],
    pageImages: [],
    settings: {
      defaultSourceLanguage: "unknown"
    },
    processing: {
      pages: [],
      runs: [],
      assets: []
    }
  };
}

export function normalizeProject(input: unknown): TranslationProjectV2 {
  if (!isRecord(input)) throw new Error("Invalid project: expected object");
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) {
    throw new Error("Invalid project: unsupported schema version");
  }
  if (!isProjectMetadata(input.metadata)) throw new Error("Invalid project: missing metadata");
  if (!Array.isArray(input.characters)) throw new Error("Invalid project: missing characters");
  if (!Array.isArray(input.dictionaryTerms)) throw new Error("Invalid project: missing dictionaryTerms");
  if (!Array.isArray(input.dialogueLines)) throw new Error("Invalid project: missing dialogueLines");
  const pageImages = input.schemaVersion === 1 && input.pageImages === undefined
    ? []
    : input.pageImages;
  if (!Array.isArray(pageImages)) throw new Error("Invalid project: missing pageImages");
  if (!isProjectSettings(input.settings)) throw new Error("Invalid project: missing settings");
  if (!input.characters.every(isCharacterProfile)) {
    throw new Error("Invalid project: malformed character");
  }
  if (!input.dictionaryTerms.every(isDictionaryTerm)) {
    throw new Error("Invalid project: malformed dictionary term");
  }
  if (!pageImages.every(isPageImage)) {
    throw new Error("Invalid project: malformed page image");
  }
  if (new Set(pageImages.map((pageImage) => pageImage.id)).size !== pageImages.length) {
    throw new Error("Invalid project: duplicate page image id");
  }
  if (new Set(pageImages.map((pageImage) => pageImage.pageNumber)).size !== pageImages.length) {
    throw new Error("Invalid project: duplicate page image page number");
  }

  if (input.schemaVersion === 1) {
    if (!input.dialogueLines.every(isDialogueLine)) {
      throw new Error("Invalid project: malformed dialogue line");
    }
    return {
      ...structuredClone(input as TranslationProject),
      schemaVersion: 2,
      pageImages: structuredClone(pageImages),
      dialogueLines: (input.dialogueLines as DialogueLine[]).map((line) => ({
        ...line,
        pageNumber: line.pageNumber ?? 1,
        origin: { kind: "manual" as const }
      })),
      processing: { pages: [], runs: [], assets: [] }
    };
  }

  if (!input.dialogueLines.every(isDialogueLineV2)) {
    throw new Error("Invalid project: malformed dialogue line");
  }
  if (!isProcessingState(input.processing)) {
    throw new Error("Invalid project: malformed processing state");
  }
  return structuredClone(input) as TranslationProjectV2;
}

export function normalizeEditableProject(input: unknown): TranslationProjectV2 {
  if (!isRecord(input) || input.schemaVersion !== 2 || !Array.isArray(input.dialogueLines)) {
    return normalizeProject(input);
  }
  const dialogueLines: unknown[] = structuredClone(input.dialogueLines);
  const editable = structuredClone(input);
  editable.dialogueLines = dialogueLines.map((line) =>
    isRecord(line) && line.origin === undefined
      ? { ...line, origin: { kind: "manual" as const } }
      : line
  );
  return normalizeProject(editable);
}

function isDialogueLineV2(value: unknown): value is DialogueLineV2 {
  if (!isDialogueLine(value) || !isRecord(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isRecord(candidate.origin)) return false;
  if (candidate.orphanedFromPipeline !== undefined && typeof candidate.orphanedFromPipeline !== "boolean") return false;
  if (candidate.origin.kind === "manual") return Object.keys(candidate.origin).length === 1;
  return (
    candidate.origin.kind === "pipeline" &&
    typeof candidate.origin.persistentRegionId === "string" &&
    typeof candidate.origin.latestRunId === "string" &&
    typeof candidate.origin.latestRegionId === "string" &&
    typeof candidate.origin.pageImageId === "string" &&
    isStringArray(candidate.origin.candidateIds) &&
    typeof candidate.origin.readingIndex === "number" &&
    Number.isInteger(candidate.origin.readingIndex) &&
    typeof candidate.origin.sourceFingerprint === "string"
  );
}

function isProcessingState(value: unknown): value is ProcessingState {
  if (
    !isRecord(value) ||
    !Array.isArray(value.pages) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.assets) ||
    !value.pages.every(isPageProcessingRecord) ||
    !value.runs.every(isProcessingRunRecord) ||
    !value.assets.every(isDerivedImageAsset)
  ) return false;
  return (
    hasUniqueStrings(value.pages, "pageImageId") &&
    hasUniqueStrings(value.runs, "runId") &&
    hasUniqueStrings(value.assets, "assetId") &&
    (value.queue === undefined || isProcessingQueueState(value.queue))
  );
}

function isProcessingQueueState(value: unknown): value is ProcessingQueueState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.queueId) ||
    !isNonEmptyString(value.projectSessionId) ||
    !processingQueueStatuses.has(value.status as string) ||
    !isStringArray(value.pageImageIds) ||
    !Array.isArray(value.pages) ||
    !value.pages.every(isProcessingQueuePageRecord) ||
    !isNonNegativeInteger(value.currentPageIndex) ||
    value.currentPageIndex > value.pages.length ||
    !isOptionalNonEmptyString(value.currentRunId) ||
    !isOptionalString(value.pauseReason) ||
    !isOptionalString(value.failureReason) ||
    typeof value.lastUpdatedAt !== "string"
  ) return false;

  const pageImageIds = value.pageImageIds as string[];
  if (
    pageImageIds.length !== value.pages.length ||
    !hasUniqueStrings(value.pages, "pageImageId")
  ) return false;
  return value.pages.every(
    (page, index) => page.pageImageId === pageImageIds[index]
  );
}

function isProcessingQueuePageRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.pageImageId) &&
    processingQueuePageStatuses.has(value.status as string) &&
    processingQueueStages.has(value.stage as string) &&
    isNonNegativeInteger(value.revision) &&
    isOptionalNonEmptyString(value.runId) &&
    (value.requiresExternalResume === undefined || typeof value.requiresExternalResume === "boolean") &&
    (value.error === undefined || isPipelineError(value.error)) &&
    typeof value.updatedAt === "string"
  );
}

function isPageProcessingRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.pageImageId) &&
    isOptionalNonEmptyString(value.activeRunId) &&
    isOptionalNonEmptyString(value.latestCompletedRunId) &&
    isOptionalNonEmptyString(value.approvedCleanedAssetId) &&
    isOptionalNonEmptyString(value.userReviewedCleanedAssetId) &&
    isOptionalNonEmptyString(value.approvedTranslatedAssetId) &&
    isOptionalNonEmptyString(value.approvedMaskAssetId) &&
    pageFinalStatuses.has(value.finalStatus as string) &&
    typeof value.updatedAt === "string"
  );
}

function isProcessingRunRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.pageImageId) &&
    processingRunSources.has(value.source as string) &&
    processingRunStatuses.has(value.status as string) &&
    isSha256(value.sourceSha256) &&
    typeof value.appVersion === "string" &&
    isOptionalString(value.pipelineVersion) &&
    (value.protocolVersion === undefined || value.protocolVersion === "1.0") &&
    (value.profile === undefined || value.profile === "fast" || value.profile === "precise") &&
    typeof value.queuedAt === "string" &&
    isOptionalString(value.startedAt) &&
    isOptionalString(value.committingAt) &&
    isOptionalString(value.completedAt) &&
    isOptionalRelativePath(value.commitMarkerRelativePath) &&
    isOptionalRelativePath(value.canonicalManifestRelativePath) &&
    (value.error === undefined || isPipelineError(value.error))
  );
}

function isPipelineError(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    isOptionalString(value.stage) &&
    (
      value.details === undefined ||
      (
        isRecord(value.details) &&
        Object.values(value.details).every(
          (detail) =>
            typeof detail === "string" ||
            typeof detail === "number" ||
            typeof detail === "boolean"
        )
      )
    )
  );
}

function isDerivedImageAsset(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.assetId) &&
    processingRunSources.has(value.source as string) &&
    isNonEmptyString(value.sourcePageImageId) &&
    isNonEmptyString(value.runId) &&
    processingAssetRoles.has(value.role as string) &&
    isRelativeStoredPath(value.storedRelativePath) &&
    isSha256(value.sha256) &&
    typeof value.byteSize === "number" &&
    Number.isInteger(value.byteSize) &&
    value.byteSize >= 0 &&
    value.mimeType === "image/png" &&
    typeof value.createdAt === "string" &&
    isOptionalNonEmptyString(value.maskAssetId)
  );
}

function createProjectId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProjectMetadata(value: unknown): value is TranslationProject["metadata"] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.secret === "boolean"
  );
}

function isProjectSettings(value: unknown): value is TranslationProject["settings"] {
  return (
    isRecord(value) &&
    isSourceLanguage(value.defaultSourceLanguage) &&
    (value.translationMode === undefined || isTranslationMode(value.translationMode)) &&
    (value.allowExternalAi === undefined || typeof value.allowExternalAi === "boolean") &&
    (value.debugArtifactsEnabled === undefined || typeof value.debugArtifactsEnabled === "boolean")
  );
}

function isCharacterProfile(value: unknown): value is CharacterProfile {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isStringArray(value.aliases) &&
    isOptionalString(value.description) &&
    isOptionalString(value.speechStyle) &&
    isOptionalString(value.relationshipNotes)
  );
}

function isTermCondition(value: unknown): value is TermCondition {
  return (
    isRecord(value) &&
    isOptionalString(value.speaker) &&
    (value.dialogueType === undefined || isDialogueType(value.dialogueType)) &&
    isOptionalString(value.targetContext)
  );
}

function isDictionaryTerm(value: unknown): value is DictionaryTerm {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.target === "string" &&
    isOptionalString(value.note) &&
    (value.category === undefined || isDictionaryTermCategory(value.category)) &&
    (value.condition === undefined || isTermCondition(value.condition)) &&
    (value.priority === undefined || (typeof value.priority === "number" && Number.isFinite(value.priority)))
  );
}

function isDialogueLine(value: unknown): value is DialogueLine {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonNegativeInteger(value.order) &&
    (value.pageNumber === undefined || isPositiveInteger(value.pageNumber)) &&
    isOptionalString(value.speaker) &&
    isOptionalString(value.position) &&
    isDialogueType(value.dialogueType) &&
    isOptionalLineStatus(value.lineStatus) &&
    isSourceLanguage(value.sourceLanguage) &&
    typeof value.sourceText === "string" &&
    isOptionalString(value.referenceTranslation) &&
    isOptionalString(value.aiTranslation) &&
    isOptionalString(value.userTranslation) &&
    isOptionalString(value.notes) &&
    typeof value.parseConfidence === "number" &&
    Number.isFinite(value.parseConfidence) &&
    isStringArray(value.parseWarnings) &&
    isOptionalDialogueTypesetting(value.typesetting) &&
    (value.ocrEditStatus === undefined || ocrEditStatuses.has(value.ocrEditStatus as string)) &&
    isOptionalString(value.userOverrideSourceText) &&
    isOptionalString(value.ocrGroupId) &&
    isOptionalOcrUserOwnedFields(value.ocrUserOwnedFields) &&
    isOptionalPolygon(value.polygon) &&
    isOptionalTextRegionSourceInfo(value.ocrSourceInfo)
  );
}

function isOptionalOcrUserOwnedFields(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) &&
    value.every((field) => typeof field === "string" && ocrUserOwnedFields.has(field)) &&
    new Set(value).size === value.length
  );
}

function isOptionalPolygon(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.every((point) =>
      isRecord(point) &&
      typeof point.x === "number" && Number.isFinite(point.x) &&
      typeof point.y === "number" && Number.isFinite(point.y))
  );
}

function isOptionalTextRegionSourceInfo(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.detectorName) &&
    isOptionalString(value.ocrEngine) &&
    isOptionalString(value.rawMangaOcrText) &&
    isOptionalString(value.rawPaddleOcrText) &&
    (value.confidence === undefined || (typeof value.confidence === "number" && Number.isFinite(value.confidence))) &&
    (value.isCrossValidated === undefined || typeof value.isCrossValidated === "boolean") &&
    (value.orientation === undefined || ["horizontal", "vertical", "unknown"].includes(value.orientation as string)) &&
    (value.productionOcrProvenance === undefined || isProductionOcrProvenance(value.productionOcrProvenance))
  );
}

function isProductionOcrProvenance(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.cropTransform)) return false;
  const transform = value.cropTransform;
  return (
    value.contractVersion === 1 &&
    value.detectorModelId === PRODUCTION_OCR_CONTRACT.detector.modelId &&
    value.detectorRevision === PRODUCTION_OCR_CONTRACT.detector.revision &&
    value.recognizerModelId === PRODUCTION_OCR_CONTRACT.recognizer.modelId &&
    value.recognizerRevision === PRODUCTION_OCR_CONTRACT.recognizer.revision &&
    isNonEmptyString(value.groupId) &&
    isStringArray(value.sourceDetectionIds) && value.sourceDetectionIds.length > 0 &&
    new Set(value.sourceDetectionIds).size === value.sourceDetectionIds.length &&
    Array.isArray(value.sourceQuadsPx) &&
    value.sourceQuadsPx.length === value.sourceDetectionIds.length &&
    Array.isArray(value.sourceDetectionScores) &&
    value.sourceDetectionScores.length === value.sourceDetectionIds.length &&
    value.sourceDetectionScores.every((score) =>
      typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1) &&
    value.sourceQuadsPx.every((quad) => Array.isArray(quad) && quad.length === 4 && quad.every(isFinitePoint)) &&
    ["horizontal", "vertical", "unknown"].includes(value.orientation as string) &&
    value.confidenceSource === "detector_min" &&
    (value.recognition === undefined || (
      isRecord(value.recognition) &&
      typeof value.recognition.rawOcrText === "string" &&
      typeof value.recognition.normalizedOcrText === "string" &&
      value.recognition.normalization === PRODUCTION_OCR_CONTRACT.normalization &&
      value.recognition.normalizedOcrText === normalizeProductionOcrText(value.recognition.rawOcrText)
    )) &&
    isPixelBbox(transform.sourceBboxPx) &&
    isPixelBbox(transform.cropBboxPx) &&
    transform.paddingRatio === 0.08 &&
    transform.rotationDegrees === 0 &&
    isPositiveInteger(transform.imageWidth) &&
    isPositiveInteger(transform.imageHeight)
  );
}

function isFinitePoint(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y);
}

function isPixelBbox(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [value.x, value.y, value.width, value.height].every((coordinate) =>
    typeof coordinate === "number" && Number.isFinite(coordinate)) &&
    typeof value.width === "number" && value.width > 0 &&
    typeof value.height === "number" && value.height > 0;
}

function isDialogueTypesetting(value: unknown): value is DialogueTypesetting {
  if (!isRecord(value)) return false;
  if (!isRecord(value.bbox)) return false;
  const { x, y, width, height } = value.bbox;
  if (
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y) ||
    typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
    typeof height !== "number" || !Number.isFinite(height) || height <= 0
  ) {
    return false;
  }
  if (value.writingMode !== "horizontal-tb" && value.writingMode !== "vertical-rl") return false;
  if (value.rotationDegrees !== undefined && (typeof value.rotationDegrees !== "number" || !Number.isFinite(value.rotationDegrees))) return false;
  if (value.shape !== undefined && !["rectangle", "ellipse", "rounded_rectangle", "cloud", "spiky"].includes(value.shape as string)) return false;
  if (value.fontFamily !== undefined && typeof value.fontFamily !== "string") return false;
  if (value.fontSizeRatio !== undefined && (typeof value.fontSizeRatio !== "number" || !Number.isFinite(value.fontSizeRatio))) return false;
  if (value.color !== undefined && typeof value.color !== "string") return false;
  if (value.strokeColor !== undefined && typeof value.strokeColor !== "string") return false;
  if (value.strokeWidth !== undefined && (typeof value.strokeWidth !== "number" || !Number.isFinite(value.strokeWidth))) return false;
  if (value.align !== undefined && !["center", "left", "right"].includes(value.align as string)) return false;
  if (value.lineHeight !== undefined && (typeof value.lineHeight !== "number" || !Number.isFinite(value.lineHeight))) return false;
  return true;
}

function isOptionalDialogueTypesetting(value: unknown): boolean {
  return value === undefined || isDialogueTypesetting(value);
}

function isPageImage(value: unknown): value is PageImage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isPositiveInteger(value.pageNumber) &&
    typeof value.storedRelativePath === "string" &&
    isRelativeStoredPath(value.storedRelativePath) &&
    typeof value.originalFileName === "string" &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(value.sha256) &&
    typeof value.byteSize === "number" &&
    Number.isInteger(value.byteSize) &&
    value.byteSize >= 0 &&
    typeof value.mimeType === "string" &&
    typeof value.copiedAt === "string"
  );
}

function hasUniqueStrings(values: unknown[], field: string): boolean {
  const strings = values.map((value) => (value as Record<string, unknown>)[field]);
  return strings.every((value) => typeof value === "string") &&
    new Set(strings).size === strings.length;
}

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalRelativePath(value: unknown): boolean {
  return value === undefined || isRelativeStoredPath(value);
}

function isRelativeStoredPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/.test(value) &&
    !value.split(/[\\/]+/).includes("..")
  );
}

function isDialogueType(value: unknown): value is DialogueType {
  return typeof value === "string" && dialogueTypes.includes(value as DialogueType);
}

function isOptionalLineStatus(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && lineStatuses.includes(value as LineStatus));
}

function isSourceLanguage(value: unknown): value is SourceLanguage {
  return typeof value === "string" && sourceLanguages.includes(value as SourceLanguage);
}

function isTranslationMode(value: unknown): value is TranslationMode {
  return typeof value === "string" && translationModes.includes(value as TranslationMode);
}

function isDictionaryTermCategory(value: unknown): value is DictionaryTermCategory {
  return typeof value === "string" && dictionaryTermCategories.includes(value as DictionaryTermCategory);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
