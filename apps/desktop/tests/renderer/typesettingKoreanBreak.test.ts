import { describe, expect, it } from "vitest";
import {
  evaluateAndBreakKoreanText,
  findBestSubwordBreak,
  tokenizeKoreanText
} from "../../src/renderer/typesettingKoreanBreak.js";

describe("typesettingKoreanBreak", () => {
  describe("tokenizeKoreanText", () => {
    it("tokenizes korean sentences preserving words, spaces, and punctuation", () => {
      const tokens = tokenizeKoreanText("안녕 루피! 정말이야?");
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.map((t) => t.text).join("")).toBe("안녕 루피! 정말이야?");
    });
  });

  describe("findBestSubwordBreak", () => {
    it("avoids breaking right before a single particle", () => {
      // "사과를" -> breaking between "사" and "과를" is better than "사과" and "를" (particle)
      const breakIdx = findBestSubwordBreak("사과를");
      // "사과를" is length 3: index 1 is "사"|"과를", index 2 is "사과"|"를"
      // Particle "를" at index 2 should have high penalty, so index 1 is preferred
      expect(breakIdx).toBe(1);
    });

    it("returns -1 for very short words", () => {
      expect(findBestSubwordBreak("나")).toBe(-1);
      expect(findBestSubwordBreak("너도")).toBe(-1);
    });
  });

  describe("evaluateAndBreakKoreanText (YSB Candidate Evaluator)", () => {
    it("evaluates candidates and splits lines smoothly without orphan words", () => {
      const text = "내가 어제 먹었던 라면은 정말로 맛있었어!";
      const lines = evaluateAndBreakKoreanText(text, {
        estimateWidth: (t) => t.length * 10,
        getAvailableWidth: () => 120 // ~12 chars per line
      });

      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0);
      }
      expect(lines.join(" ")).toBe(text);
    });

    it("handles single-word text", () => {
      const text = "안녕하세요";
      const lines = evaluateAndBreakKoreanText(text, {
        estimateWidth: (t) => t.length * 10,
        getAvailableWidth: () => 100
      });
      expect(lines).toEqual(["안녕하세요"]);
    });

    it("prevents orphan characters at the end of sentence", () => {
      const text = "이것은 긴 문장입니다 다";
      const lines = evaluateAndBreakKoreanText(text, {
        estimateWidth: (t) => t.length * 10,
        getAvailableWidth: () => 150
      });
      // Should avoid a last line with just 1 letter "다"
      const lastLine = lines[lines.length - 1]!;
      expect(lastLine.length).toBeGreaterThan(1);
    });
  });
});
