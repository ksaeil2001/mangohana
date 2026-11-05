import type {
  ExtractionLanguage,
  NormalizedBbox,
  PolygonPoint
} from "./speechBubbleExtraction.js";

export const PRODUCTION_OCR_CONTRACT = Object.freeze({
  contractVersion: 1,
  platform: "win32-x64",
  resourceRole: "ocr_production",
  detector: Object.freeze({
    modelId: "PaddlePaddle/PP-OCRv6_medium_det",
    revision: "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
    files: Object.freeze([
      "detector/inference.json",
      "detector/inference.pdiparams",
      "detector/inference.yml"
    ]),
    device: "cpu"
  }),
  recognizer: Object.freeze({
    modelId: "genshiai-daichi/baberu-ocr",
    revision: "d9cc13153e9a1cd8fdfa3b7b1cc329da2020aeae",
    files: Object.freeze([
      "recognizer/onnx/vision_fp16.onnx",
      "recognizer/onnx/decoder_prefill_int8.onnx",
      "recognizer/onnx/decoder_step_int8.onnx",
      "recognizer/tokenizer/vocab.json"
    ]),
    executionProvider: "CPUExecutionProvider"
  }),
  normalization: "NFKC_JAPANESE_QUOTES"
} as const);

export const MANGA_OCR_MODELS = Object.freeze({
  detector: Object.freeze({
    modelId: "Kellenok/PP-OCRv6_manga",
    revision: "c94f4a20677f1ba0c90625bccf42ea980f24e2f4"
  }),
  recognizer: Object.freeze({
    modelId: "JustANormalTinkerer/hayai-ocr-v2.5-nova",
    revision: "2803d0dc005fa4396ab1e7c5a472d2c450a247f7"
  }),
  // Internal composition identity, not an upstream model repository.
  compositeDetector: Object.freeze({ modelId: "trio/ppocr-manga-assisted", revision: "1" })
} as const);

export type ProductionOcrModelIdentity = Readonly<{ modelId: string; revision: string }>;
export type ProductionOcrDetectionModelIdentity =
  | Pick<typeof PRODUCTION_OCR_CONTRACT.detector, "modelId" | "revision">
  | typeof MANGA_OCR_MODELS.detector;
export type ProductionOcrDetectorIdentity =
  | ProductionOcrDetectionModelIdentity
  | typeof MANGA_OCR_MODELS.compositeDetector;
export type ProductionOcrRecognizerIdentity =
  | Pick<typeof PRODUCTION_OCR_CONTRACT.recognizer, "modelId" | "revision">
  | typeof MANGA_OCR_MODELS.recognizer;

export type ProductionOcrOrientation = "horizontal" | "vertical" | "unknown";

export type ProductionOcrPoint = Readonly<{
  x: number;
  y: number;
}>;

export type ProductionOcrPixelBbox = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ProductionOcrDetection = Readonly<{
  detectionId: string;
  /** Absent on legacy PP detections; support from Manga does not change the source. */
  sourceModel?: ProductionOcrDetectionModelIdentity;
  /** Independent model confirmation; the quad and score still belong to sourceModel. */
  supportedBy?: ProductionOcrDetectionModelIdentity;
  sourceQuadPx: readonly [
    ProductionOcrPoint,
    ProductionOcrPoint,
    ProductionOcrPoint,
    ProductionOcrPoint
  ];
  sourceBboxPx: ProductionOcrPixelBbox;
  bbox: NormalizedBbox;
  polygon: readonly [PolygonPoint, PolygonPoint, PolygonPoint, PolygonPoint];
  score: number;
  orientation: ProductionOcrOrientation;
  imageWidth: number;
  imageHeight: number;
}>;

export type ProductionOcrGroup = Readonly<{
  groupId: string;
  sourceDetectionIds: readonly string[];
  memberQuadsPx: readonly ProductionOcrDetection["sourceQuadPx"][];
  memberScores: readonly number[];
  /** Parallel to sourceDetectionIds, memberQuadsPx and memberScores. */
  memberModels?: readonly ProductionOcrDetectionModelIdentity[];
  /** Parallel support identities; null means no independent confirmation for that member. */
  memberSupportModels?: readonly (ProductionOcrDetectionModelIdentity | null)[];
  groupBboxPx: ProductionOcrPixelBbox;
  bbox: NormalizedBbox;
  polygon: readonly [PolygonPoint, PolygonPoint, PolygonPoint, PolygonPoint];
  orientation: ProductionOcrOrientation;
  readingOrder: number;
  confidence: number;
  imageWidth: number;
  imageHeight: number;
}>;

export type ProductionOcrAdditionalPaddingPx = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export type ProductionOcrCropTransform = Readonly<{
  sourceBboxPx: ProductionOcrPixelBbox;
  cropBboxPx: ProductionOcrPixelBbox;
  paddingRatio: 0.08;
  rotationDegrees: 0;
  imageWidth: number;
  imageHeight: number;
  /** Actual extra integer pixels beyond the default 8% crop, after image-bound clipping. */
  additionalPaddingPx?: ProductionOcrAdditionalPaddingPx;
}>;

export type ProductionOcrProvenance = Readonly<{
  contractVersion: 1;
  detectorModelId: ProductionOcrDetectorIdentity["modelId"];
  detectorRevision: ProductionOcrDetectorIdentity["revision"];
  recognizerModelId: ProductionOcrRecognizerIdentity["modelId"];
  recognizerRevision: ProductionOcrRecognizerIdentity["revision"];
  groupId: string;
  sourceDetectionIds: readonly string[];
  sourceQuadsPx: readonly ProductionOcrDetection["sourceQuadPx"][];
  sourceDetectionScores: readonly number[];
  /** Omission is supported only for legacy PP/Baberu provenance. */
  sourceDetectionModels?: readonly ProductionOcrDetectionModelIdentity[];
  /** Parallel to sourceDetectionModels; only a PP source supported by pinned Manga is allowed. */
  sourceDetectionSupportModels?: readonly (ProductionOcrDetectionModelIdentity | null)[];
  orientation: ProductionOcrOrientation;
  cropTransform: ProductionOcrCropTransform;
  confidenceSource: "detector_min";
  /** Absent only in projects saved before recognition evidence was recorded. */
  recognition?: Readonly<{
    rawOcrText: string;
    normalizedOcrText: string;
    normalization: typeof PRODUCTION_OCR_CONTRACT.normalization;
  }>;
}>;

export type ProductionOcrCandidate = Readonly<{
  id: string;
  text: string;
  language: ExtractionLanguage;
  bbox: NormalizedBbox;
  polygon: readonly PolygonPoint[];
  readingOrder: number;
  orientation: ProductionOcrOrientation;
  confidence: number;
  provenance: ProductionOcrProvenance;
}>;

export const OCR_USER_OWNED_FIELDS = [
  "source_text",
  "reading_order",
  "geometry",
  "group_assignment"
] as const;

export type OcrUserOwnedField = (typeof OCR_USER_OWNED_FIELDS)[number];

export function normalizeProductionOcrText(text: string): string {
  return text
    .normalize("NFKC")
    .replaceAll("﹁", "「")
    .replaceAll("﹂", "」")
    .replaceAll("﹃", "『")
    .replaceAll("﹄", "』");
}
