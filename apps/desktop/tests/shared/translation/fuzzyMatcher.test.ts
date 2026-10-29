import { describe, expect, it } from "vitest";
import {
  calculateDiceSimilarity,
  calculateFuzzySimilarity,
  calculateLevenshteinDistance,
  calculateLevenshteinSimilarity,
  normalizeTextForMatching
} from "../../../src/shared/translation/fuzzyMatcher";

describe("fuzzyMatcher", () => {
  it("normalizes text by stripping whitespace and punctuation", () => {
    const raw = " えっ！？  嘘でしょ… ";
    expect(normalizeTextForMatching(raw)).toBe("えっ嘘でしょ");
  });

  it("calculates Levenshtein distance accurately", () => {
    expect(calculateLevenshteinDistance("こんにちは", "こんにちは")).toBe(0);
    expect(calculateLevenshteinDistance("こんにちは", "こんばんわ")).toBe(3);
    expect(calculateLevenshteinDistance("abc", "")).toBe(3);
  });

  it("returns 1.0 for identical strings", () => {
    const sim = calculateFuzzySimilarity("海賊王に俺はなる！", "海賊王に俺はなる！");
    expect(sim.score).toBe(1.0);
  });

  it("returns high similarity (> 0.75) for minor variations in manga exclamations", () => {
    const sim = calculateFuzzySimilarity("くそっ！", "くそっ…！");
    expect(sim.score).toBe(1.0); // Punctuation stripped in normalization

    const simVariation = calculateFuzzySimilarity("助けてくれ！", "助けてください！");
    expect(simVariation.score).toBeGreaterThan(0.65);
  });

  it("returns low similarity (< 0.4) for unrelated texts", () => {
    const sim = calculateFuzzySimilarity("おはようございます", "さようなら");
    expect(sim.score).toBeLessThan(0.4);
  });
});
