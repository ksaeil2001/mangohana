import { describe, expect, it } from "vitest";
import { calculateTextSimilarity, evaluateOcrCrossValidation } from "../../src/main/ocr/evaluator.js";

describe("ocrEvaluator (MangaOCR & PaddleOCR Cross-Validation)", () => {
  describe("calculateTextSimilarity", () => {
    it("returns 1.0 for exact match ignoring whitespaces", () => {
      expect(calculateTextSimilarity("こんにちは", "こんにちは")).toBe(1.0);
      expect(calculateTextSimilarity("こ ん に ち は", "こんにちは")).toBe(1.0);
    });

    it("returns high similarity for minor typo or 1-character difference", () => {
      const sim = calculateTextSimilarity("おはようございます", "おはようごさいまーす");
      expect(sim).toBeGreaterThan(0.65);
    });

    it("returns low similarity for completely different texts", () => {
      const sim = calculateTextSimilarity("これはペンです", "全然違う文章だよ");
      expect(sim).toBeLessThan(0.3);
    });
  });

  describe("evaluateOcrCrossValidation", () => {
    it("marks consistent and high confidence when both engines match", () => {
      const result = evaluateOcrCrossValidation({
        mangaOcrText: "お前を絶対に許さない！",
        paddleOcrText: "お前を絶対に許さない！",
        paddleConfidence: 0.95
      });

      expect(result.isConsistent).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.selectedText).toBe("お前を絶対に許さない！");
      expect(result.warnings.length).toBe(0);
    });

    it("flags warnings and moderate confidence for minor differences", () => {
      const result = evaluateOcrCrossValidation({
        mangaOcrText: "何かがおかしい…？",
        paddleOcrText: "何かがおかしい...?",
        paddleConfidence: 0.85
      });

      expect(result.selectedText).toBe("何かがおかしい…？");
      expect(result.rawMangaOcrText).toBe("何かがおかしい…？");
      expect(result.rawPaddleOcrText).toBe("何かがおかしい...?");
    });

    it("flags low confidence and critical warning when engines severely diverge", () => {
      const result = evaluateOcrCrossValidation({
        mangaOcrText: "魔王軍が攻めてきた！",
        paddleOcrText: "1234567890",
        paddleConfidence: 0.8
      });

      expect(result.isConsistent).toBe(false);
      expect(result.confidence).toBeLessThanOrEqual(0.5);
      expect(result.warnings.some((w) => w.includes("크게 다릅니다"))).toBe(true);
    });

    it("handles empty recognition safely", () => {
      const result = evaluateOcrCrossValidation({
        mangaOcrText: "",
        paddleOcrText: "",
        paddleConfidence: 0.0
      });

      expect(result.selectedText).toBe("");
      expect(result.confidence).toBe(0.0);
      expect(result.isConsistent).toBe(true);
    });
  });
});
