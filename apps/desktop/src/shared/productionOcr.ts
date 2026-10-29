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
  groupBboxPx: ProductionOcrPixelBbox;
  bbox: NormalizedBbox;
  polygon: readonly [PolygonPoint, PolygonPoint, PolygonPoint, PolygonPoint];
  orientation: ProductionOcrOrientation;
  readingOrder: number;
  confidence: number;
  imageWidth: number;
  imageHeight: number;
}>;

export type ProductionOcrCropTransform = Readonly<{
  sourceBboxPx: ProductionOcrPixelBbox;
  cropBboxPx: ProductionOcrPixelBbox;
  paddingRatio: 0.08;
  rotationDegrees: 0;
  imageWidth: number;
  imageHeight: number;
}>;

export type ProductionOcrProvenance = Readonly<{
  contractVersion: 1;
  detectorModelId: typeof PRODUCTION_OCR_CONTRACT.detector.modelId;
  detectorRevision: typeof PRODUCTION_OCR_CONTRACT.detector.revision;
  recognizerModelId: typeof PRODUCTION_OCR_CONTRACT.recognizer.modelId;
  recognizerRevision: typeof PRODUCTION_OCR_CONTRACT.recognizer.revision;
  groupId: string;
  sourceDetectionIds: readonly string[];
  sourceQuadsPx: readonly ProductionOcrDetection["sourceQuadPx"][];
  sourceDetectionScores: readonly number[];
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
