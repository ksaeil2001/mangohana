import { describe, expect, it } from "vitest";
import {
  PRODUCTION_OCR_CONTRACT,
  normalizeProductionOcrText
} from "../../src/shared/productionOcr.js";

describe("Production OCR contract", () => {
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
