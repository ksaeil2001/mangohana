import {
  MANGA_OCR_MODELS,
  PRODUCTION_OCR_CONTRACT,
  normalizeProductionOcrText,
  type ProductionOcrDetectionModelIdentity,
  type ProductionOcrDetectorIdentity,
  type ProductionOcrModelIdentity,
  type ProductionOcrPixelBbox,
  type ProductionOcrProvenance,
  type ProductionOcrRecognizerIdentity
} from "./productionOcr.js";
import { baseProductionOcrCrop } from "./imageCropGeometry.js";

const requiredProvenanceKeys = [
  "contractVersion", "detectorModelId", "detectorRevision", "recognizerModelId", "recognizerRevision",
  "groupId", "sourceDetectionIds", "sourceQuadsPx", "sourceDetectionScores", "orientation", "cropTransform", "confidenceSource"
];
const allowedProvenanceKeys = new Set([
  ...requiredProvenanceKeys, "recognition", "sourceDetectionModels", "sourceDetectionSupportModels"
]);

function matchesIdentity(value: unknown, identity: ProductionOcrModelIdentity): boolean {
  return isRecord(value) && value.modelId === identity.modelId && value.revision === identity.revision;
}

export function isProductionOcrDetectionModelIdentity(value: unknown): value is ProductionOcrDetectionModelIdentity {
  return matchesIdentity(value, PRODUCTION_OCR_CONTRACT.detector) || matchesIdentity(value, MANGA_OCR_MODELS.detector);
}

export function isProductionOcrRecognizerIdentity(value: unknown): value is ProductionOcrRecognizerIdentity {
  return matchesIdentity(value, PRODUCTION_OCR_CONTRACT.recognizer) || matchesIdentity(value, MANGA_OCR_MODELS.recognizer);
}

function isDetectionSupportModels(
  models: readonly ProductionOcrDetectionModelIdentity[],
  value: unknown
): value is readonly (ProductionOcrDetectionModelIdentity | null)[] {
  return Array.isArray(value) && value.length === models.length && Array.from(value).every((support, index) =>
    support === null || (
      isRecord(support) && Object.keys(support).length === 2 &&
      Object.hasOwn(support, "modelId") && Object.hasOwn(support, "revision") &&
      matchesIdentity(models[index], PRODUCTION_OCR_CONTRACT.detector) &&
      matchesIdentity(support, MANGA_OCR_MODELS.detector)
    ));
}

export function deriveProductionOcrDetectorIdentity(
  models: readonly ProductionOcrDetectionModelIdentity[],
  supportModels?: readonly (ProductionOcrDetectionModelIdentity | null)[]
): ProductionOcrDetectorIdentity {
  if (!Array.isArray(models) || models.length === 0 || !Array.from(models).every(isProductionOcrDetectionModelIdentity)) {
    throw new Error("Invalid Production OCR detector identity");
  }
  if (supportModels !== undefined) {
    if (!isDetectionSupportModels(models, supportModels)) throw new Error("Invalid Production OCR detection support identity");
    if (supportModels.some((support) => support !== null)) return MANGA_OCR_MODELS.compositeDetector;
  }
  if (models.every((model) => matchesIdentity(model, PRODUCTION_OCR_CONTRACT.detector))) {
    return { modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: PRODUCTION_OCR_CONTRACT.detector.revision };
  }
  if (models.every((model) => matchesIdentity(model, MANGA_OCR_MODELS.detector))) return MANGA_OCR_MODELS.detector;
  return MANGA_OCR_MODELS.compositeDetector;
}

export function isProductionOcrProvenance(value: unknown): value is ProductionOcrProvenance {
  if (!isRecord(value) || !isRecord(value.cropTransform)) return false;
  if (requiredProvenanceKeys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowedProvenanceKeys.has(key))) return false;

  const detectorIdentity = { modelId: value.detectorModelId, revision: value.detectorRevision };
  const recognizerIdentity = { modelId: value.recognizerModelId, revision: value.recognizerRevision };
  if (!isProductionOcrRecognizerIdentity(recognizerIdentity)) return false;
  if (!Array.isArray(value.sourceDetectionIds) || value.sourceDetectionIds.length === 0 ||
    !value.sourceDetectionIds.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(value.sourceDetectionIds).size !== value.sourceDetectionIds.length) return false;

  if (value.sourceDetectionModels === undefined) {
    // Only legacy PP/Baberu records may omit per-detection identity.
    if (value.sourceDetectionSupportModels !== undefined ||
      !matchesIdentity(detectorIdentity, PRODUCTION_OCR_CONTRACT.detector) ||
      !matchesIdentity(recognizerIdentity, PRODUCTION_OCR_CONTRACT.recognizer)) return false;
  } else {
    const models = value.sourceDetectionModels;
    if (!Array.isArray(models) || models.length !== value.sourceDetectionIds.length ||
      !Array.from(models).every(isProductionOcrDetectionModelIdentity)) return false;
    const supportModels = value.sourceDetectionSupportModels;
    if (supportModels !== undefined && !isDetectionSupportModels(models, supportModels)) return false;
    if (!matchesIdentity(detectorIdentity, deriveProductionOcrDetectorIdentity(models, supportModels))) return false;
  }

  const transform = value.cropTransform;
  return value.contractVersion === 1 &&
    typeof value.groupId === "string" && value.groupId.length > 0 &&
    Array.isArray(value.sourceQuadsPx) && value.sourceQuadsPx.length === value.sourceDetectionIds.length &&
    value.sourceQuadsPx.every((quad) => Array.isArray(quad) && quad.length === 4 && quad.every(isFinitePoint)) &&
    Array.isArray(value.sourceDetectionScores) && value.sourceDetectionScores.length === value.sourceDetectionIds.length &&
    value.sourceDetectionScores.every((score) => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1) &&
    ["horizontal", "vertical", "unknown"].includes(value.orientation as string) &&
    value.confidenceSource === "detector_min" &&
    (value.recognition === undefined || (
      isRecord(value.recognition) &&
      Object.keys(value.recognition).length === 3 &&
      typeof value.recognition.rawOcrText === "string" &&
      typeof value.recognition.normalizedOcrText === "string" &&
      value.recognition.normalization === PRODUCTION_OCR_CONTRACT.normalization &&
      value.recognition.normalizedOcrText === normalizeProductionOcrText(value.recognition.rawOcrText)
    )) &&
    isPixelBbox(transform.sourceBboxPx) && isPixelBbox(transform.cropBboxPx) &&
    transform.paddingRatio === 0.08 && transform.rotationDegrees === 0 &&
    typeof transform.imageWidth === "number" && Number.isInteger(transform.imageWidth) && transform.imageWidth > 0 &&
    typeof transform.imageHeight === "number" && Number.isInteger(transform.imageHeight) && transform.imageHeight > 0 &&
    isAdditionalCropPadding(value);
}

function isAdditionalCropPadding(value: Record<string, unknown>): boolean {
  const transform = value.cropTransform;
  if (!isRecord(transform)) return false;
  // Saved records without this optional field retain their original crop validation.
  if (!Object.hasOwn(transform, "additionalPaddingPx")) return true;
  if (!matchesIdentity({ modelId: value.recognizerModelId, revision: value.recognizerRevision }, MANGA_OCR_MODELS.recognizer) ||
    !Array.isArray(value.sourceDetectionIds) || value.sourceDetectionIds.length !== 1 ||
    !Array.isArray(value.sourceDetectionModels) || value.sourceDetectionModels.length !== 1 ||
    !matchesIdentity(value.sourceDetectionModels[0], PRODUCTION_OCR_CONTRACT.detector) ||
    !Array.isArray(value.sourceDetectionSupportModels) || value.sourceDetectionSupportModels.length !== 1 ||
    !matchesIdentity(value.sourceDetectionSupportModels[0], MANGA_OCR_MODELS.detector)) return false;

  const padding = transform.additionalPaddingPx;
  const source = transform.sourceBboxPx;
  const crop = transform.cropBboxPx;
  if (!isRecord(padding) || !isPixelBbox(source) || !isPixelBbox(crop) ||
    typeof transform.imageWidth !== "number" || typeof transform.imageHeight !== "number") return false;
  const edges = ["left", "top", "right", "bottom"] as const;
  const maximum = Math.ceil(Math.min(source.width, source.height));
  if (Object.keys(padding).length !== edges.length || edges.some((edge) =>
    !Object.hasOwn(padding, edge) || typeof padding[edge] !== "number" ||
    !Number.isInteger(padding[edge]) || padding[edge] < 0 || padding[edge] > maximum)) return false;
  const { left, top, right, bottom } = padding as Record<typeof edges[number], number>;
  if (left + top + right + bottom === 0) return false;

  const base = baseProductionOcrCrop(source, transform.imageWidth, transform.imageHeight);
  return crop.x >= 0 && crop.y >= 0 &&
    crop.x + crop.width <= transform.imageWidth && crop.y + crop.height <= transform.imageHeight &&
    crop.x === base.x - left && crop.y === base.y - top &&
    crop.width === base.width + left + right && crop.height === base.height + top + bottom;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinitePoint(value: unknown): boolean {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y);
}

function isPixelBbox(value: unknown): value is ProductionOcrPixelBbox {
  return isRecord(value) && [value.x, value.y, value.width, value.height].every((coordinate) =>
    typeof coordinate === "number" && Number.isFinite(coordinate)) &&
    typeof value.width === "number" && value.width > 0 && typeof value.height === "number" && value.height > 0;
}
