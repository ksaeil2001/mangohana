import { MANGA_OCR_MODELS, PRODUCTION_OCR_CONTRACT, type ProductionOcrProvenance } from "../../src/shared/productionOcr.js";

/** Synthetic geometry and text only; no source-page content. */
export function productionOcrProvenanceFixture(): ProductionOcrProvenance {
  return {
    contractVersion: 1,
    detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
    detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
    recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
    recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
    groupId: "synthetic-group",
    sourceDetectionIds: ["synthetic-a", "synthetic-b"],
    sourceQuadsPx: [
      [{ x: 20, y: 10 }, { x: 120, y: 10 }, { x: 120, y: 30 }, { x: 20, y: 30 }],
      [{ x: 20, y: 34 }, { x: 120, y: 34 }, { x: 120, y: 54 }, { x: 20, y: 54 }]
    ],
    sourceDetectionScores: [0.9, 0.8],
    orientation: "horizontal",
    cropTransform: {
      sourceBboxPx: { x: 20, y: 10, width: 100, height: 44 },
      cropBboxPx: { x: 12, y: 6, width: 116, height: 52 },
      paddingRatio: 0.08, rotationDegrees: 0, imageWidth: 200, imageHeight: 100
    },
    confidenceSource: "detector_min"
  };
}

/** One pinned PP quad independently supported by Manga, with actual extra crop pixels. */
export function adaptiveProductionOcrProvenanceFixture(): ProductionOcrProvenance {
  const legacy = productionOcrProvenanceFixture();
  return {
    ...legacy,
    detectorModelId: MANGA_OCR_MODELS.compositeDetector.modelId,
    detectorRevision: MANGA_OCR_MODELS.compositeDetector.revision,
    recognizerModelId: MANGA_OCR_MODELS.recognizer.modelId,
    recognizerRevision: MANGA_OCR_MODELS.recognizer.revision,
    sourceDetectionIds: ["synthetic-supported-pp"],
    sourceQuadsPx: [[{ x: 20, y: 10 }, { x: 120, y: 10 }, { x: 120, y: 54 }, { x: 20, y: 54 }]],
    sourceDetectionScores: [0.55],
    sourceDetectionModels: [{ modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: PRODUCTION_OCR_CONTRACT.detector.revision }],
    sourceDetectionSupportModels: [MANGA_OCR_MODELS.detector],
    cropTransform: {
      ...legacy.cropTransform,
      cropBboxPx: { x: 10, y: 3, width: 122, height: 60 },
      additionalPaddingPx: { left: 2, top: 3, right: 4, bottom: 5 }
    },
    recognition: { rawOcrText: "ＳＹＮＴＨＥＴＩＣ", normalizedOcrText: "SYNTHETIC", normalization: PRODUCTION_OCR_CONTRACT.normalization }
  };
}
