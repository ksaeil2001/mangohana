import { describe, expect, it } from "vitest";
import {
  PRODUCTION_OCR_CONTRACT,
  MANGA_OCR_MODELS,
  normalizeProductionOcrText
} from "../../src/shared/productionOcr.js";
import { isProductionOcrProvenance } from "../../src/shared/productionOcrValidation.js";
import { adaptiveProductionOcrProvenanceFixture, productionOcrProvenanceFixture } from "../fixtures/productionOcrProvenance.js";

describe("Production OCR contract", () => {
  it("pins Manga/Hayai revisions and identifies the detector composition as internal", () => {
    expect(MANGA_OCR_MODELS).toEqual({
      detector: { modelId: "Kellenok/PP-OCRv6_manga", revision: "c94f4a20677f1ba0c90625bccf42ea980f24e2f4" },
      recognizer: { modelId: "JustANormalTinkerer/hayai-ocr-v2.5-nova", revision: "2803d0dc005fa4396ab1e7c5a472d2c450a247f7" },
      compositeDetector: { modelId: "trio/ppocr-manga-assisted", revision: "1" }
    });
  });

  it("pins one detector and one CPU recognizer for every language", () => {
    expect(PRODUCTION_OCR_CONTRACT).toEqual({
      contractVersion: 1,
      platform: "win32-x64",
      resourceRole: "ocr_production",
      detector: {
        modelId: "PaddlePaddle/PP-OCRv6_medium_det",
        revision: "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
        files: ["detector/inference.json", "detector/inference.pdiparams", "detector/inference.yml"],
        device: "cpu"
      },
      recognizer: {
        modelId: "genshiai-daichi/baberu-ocr",
        revision: "d9cc13153e9a1cd8fdfa3b7b1cc329da2020aeae",
        files: [
          "recognizer/onnx/vision_fp16.onnx",
          "recognizer/onnx/decoder_prefill_int8.onnx",
          "recognizer/onnx/decoder_step_int8.onnx",
          "recognizer/tokenizer/vocab.json"
        ],
        executionProvider: "CPUExecutionProvider"
      },
      normalization: "NFKC_JAPANESE_QUOTES"
    });
  });

  it("normalizes only NFKC and Japanese presentation-form quotations", () => {
    expect(normalizeProductionOcrText("ＡＢＣ﹁猫﹂\n  spacing ﹃本﹄")).toBe(
      "ABC「猫」\n  spacing 『本』"
    );
  });
});

describe("Production OCR additional crop padding contract", () => {
  const padding = { left: 2, top: 3, right: 4, bottom: 5 };
  const edges = ["left", "top", "right", "bottom"] as const;

  it("accepts the actual additional pixels for a supported PP singleton recognized by Hayai", () => {
    expect(isProductionOcrProvenance(adaptiveProductionOcrProvenanceFixture())).toBe(true);
  });

  it("preserves legacy validation without requiring exact base-crop geometry", () => {
    const legacy = productionOcrProvenanceFixture();
    expect(isProductionOcrProvenance({
      ...legacy,
      cropTransform: { ...legacy.cropTransform, cropBboxPx: legacy.cropTransform.sourceBboxPx }
    })).toBe(true);
  });

  it.each([
    ["undefined padding", undefined],
    ["null padding", null],
    ["array padding", [2, 3, 4, 5]],
    ["zero padding", { left: 0, top: 0, right: 0, bottom: 0 }],
    ["unknown edge", { ...padding, extra: 1 }],
    ...edges.flatMap((edge): [string, unknown][] => {
      const missing = { ...padding } as Partial<typeof padding>;
      delete missing[edge];
      return [
        [`missing ${edge}`, missing],
        [`undefined ${edge}`, { ...padding, [edge]: undefined }],
        [`fractional ${edge}`, { ...padding, [edge]: 0.5 }],
        [`negative ${edge}`, { ...padding, [edge]: -1 }],
        [`oversized ${edge}`, { ...padding, [edge]: 45 }],
        [`non-numeric ${edge}`, { ...padding, [edge]: "1" }],
        [`infinite ${edge}`, { ...padding, [edge]: Infinity }],
        [`NaN ${edge}`, { ...padding, [edge]: NaN }]
      ];
    })
  ])("rejects %s in shared provenance validation", (_label, additionalPaddingPx) => {
    const provenance = adaptiveProductionOcrProvenanceFixture();
    expect(isProductionOcrProvenance({
      ...provenance, cropTransform: { ...provenance.cropTransform, additionalPaddingPx }
    })).toBe(false);
  });

  it.each([
    ["left", { x: 9, y: 3, width: 122, height: 60 }],
    ["top", { x: 10, y: 2, width: 122, height: 60 }],
    ["right", { x: 10, y: 3, width: 123, height: 60 }],
    ["bottom", { x: 10, y: 3, width: 122, height: 61 }],
    ["fractional crop", { x: 10.5, y: 3, width: 122, height: 60 }],
    ["base crop without the recorded padding", { x: 12, y: 6, width: 116, height: 52 }]
  ])("rejects a crop that mismatches the recorded %s", (_label, cropBboxPx) => {
    const provenance = adaptiveProductionOcrProvenanceFixture();
    expect(isProductionOcrProvenance({
      ...provenance, cropTransform: { ...provenance.cropTransform, cropBboxPx }
    })).toBe(false);
  });

  it.each([
    ["legacy Baberu", { recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId, recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision }],
    ["unpinned Hayai", { recognizerRevision: "latest" }],
    ["missing Manga support", { sourceDetectionSupportModels: undefined, detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId, detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision }],
    ["null Manga support", { sourceDetectionSupportModels: [null], detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId, detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision }],
    ["unpinned Manga support", { sourceDetectionSupportModels: [{ ...MANGA_OCR_MODELS.detector, revision: "latest" }] }],
    ["Manga source", { sourceDetectionModels: [MANGA_OCR_MODELS.detector], sourceDetectionSupportModels: [null], detectorModelId: MANGA_OCR_MODELS.detector.modelId, detectorRevision: MANGA_OCR_MODELS.detector.revision }],
    ["missing source model", { sourceDetectionModels: undefined }],
    ["unpinned PP source", { sourceDetectionModels: [{ modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: "latest" }] }],
    ["unknown provenance key", { extra: true }],
    ["inconsistent recognition evidence", { recognition: { rawOcrText: "Ａ", normalizedOcrText: "B", normalization: PRODUCTION_OCR_CONTRACT.normalization } }]
  ])("rejects additional padding with %s", (_label, patch) => {
    expect(isProductionOcrProvenance({ ...adaptiveProductionOcrProvenanceFixture(), ...patch })).toBe(false);
  });

  it.each(["supported PP group", "mixed group"])("rejects additional padding on a multi-quad %s", (label) => {
    const provenance = adaptiveProductionOcrProvenanceFixture();
    const pp = provenance.sourceDetectionModels![0]!;
    expect(isProductionOcrProvenance({
      ...provenance,
      sourceDetectionIds: ["pp-a", "second"],
      sourceQuadsPx: [provenance.sourceQuadsPx[0], provenance.sourceQuadsPx[0]],
      sourceDetectionScores: [0.55, 0.8],
      sourceDetectionModels: [pp, label === "mixed group" ? MANGA_OCR_MODELS.detector : pp],
      sourceDetectionSupportModels: [MANGA_OCR_MODELS.detector, null]
    })).toBe(false);
  });

  it("accepts zero edges and the maximum ceil(min(source dimensions)) additional pixels", () => {
    const provenance = adaptiveProductionOcrProvenanceFixture();
    expect(isProductionOcrProvenance({
      ...provenance,
      cropTransform: { ...provenance.cropTransform,
        cropBboxPx: { x: 12, y: 6, width: 160, height: 52 },
        additionalPaddingPx: { left: 0, top: 0, right: 44, bottom: 0 } }
    })).toBe(true);
  });

  it("rejects additional pixels beyond image bounds even when the crop matches exactly", () => {
    const provenance = adaptiveProductionOcrProvenanceFixture();
    expect(isProductionOcrProvenance({
      ...provenance,
      cropTransform: { ...provenance.cropTransform,
        cropBboxPx: { x: 12, y: -1, width: 116, height: 59 },
        additionalPaddingPx: { left: 0, top: 7, right: 0, bottom: 0 } }
    })).toBe(false);
  });

  it("rejects claimed padding clamped away by the image boundary", () => {
    const provenance = adaptiveProductionOcrProvenanceFixture();
    expect(isProductionOcrProvenance({
      ...provenance,
      cropTransform: { ...provenance.cropTransform,
        cropBboxPx: { x: 0, y: 6, width: 128, height: 52 },
        additionalPaddingPx: { left: 13, top: 0, right: 0, bottom: 0 } }
    })).toBe(false);
  });

  it("uses normalized 8% geometry, including its floating-point floor boundary", () => {
    const provenance = adaptiveProductionOcrProvenanceFixture();
    // (29 / 200) * 200 is 28.999999999999996, so the base crop starts at 26, not 27.
    const sourceBboxPx = { x: 29, y: 44, width: 25, height: 44 };
    const transform = {
      ...provenance.cropTransform, sourceBboxPx, imageWidth: 200, imageHeight: 200,
      cropBboxPx: { x: 24, y: 37, width: 36, height: 60 },
      additionalPaddingPx: padding
    };
    expect(isProductionOcrProvenance({ ...provenance, cropTransform: transform })).toBe(true);
    expect(isProductionOcrProvenance({
      ...provenance, cropTransform: { ...transform, cropBboxPx: { x: 25, y: 37, width: 35, height: 60 } }
    })).toBe(false);
  });
});
