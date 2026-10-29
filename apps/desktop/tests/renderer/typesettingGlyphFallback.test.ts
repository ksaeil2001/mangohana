import { describe, expect, it } from "vitest";
import {
  autoFitFontSizeForBubbleShape,
  calculateContrastStroke,
  estimateTextWidth,
  getRecommendedFontFallbackChain,
  layoutTextForBubbleShape
} from "../../src/renderer/typesettingGeometry.js";

describe("typesettingGlyphFallback", () => {
  describe("getRecommendedFontFallbackChain", () => {
    it("returns Korean font fallback chain by default", () => {
      const chain = getRecommendedFontFallbackChain("ko");
      expect(chain).toContain("Pretendard");
      expect(chain).toContain("NanumGothic");
      expect(chain).toContain("Apple SD Gothic Neo");
      expect(chain).toContain("Malgun Gothic");
    });

    it("prepends primary font when specified", () => {
      const chain = getRecommendedFontFallbackChain("ko", "Comic Sans MS");
      expect(chain.startsWith("'Comic Sans MS', Pretendard")).toBe(true);
    });

    it("returns Japanese font fallback chain when requested", () => {
      const chain = getRecommendedFontFallbackChain("ja");
      expect(chain).toContain("Noto Sans CJK JP");
      expect(chain).toContain("Meiryo");
    });
  });

  describe("calculateContrastStroke", () => {
    it("returns white outline for black text on normal background", () => {
      const stroke = calculateContrastStroke({ textColor: "#000000", isDarkBackground: false });
      expect(stroke.strokeColor).toBe("#ffffff");
      expect(stroke.strokeWidth).toBeGreaterThanOrEqual(1.5);
    });

    it("returns black outline for white text or dark background", () => {
      const stroke = calculateContrastStroke({ textColor: "#ffffff", isDarkBackground: false });
      expect(stroke.strokeColor).toBe("#000000");

      const darkBgStroke = calculateContrastStroke({ textColor: "#333333", isDarkBackground: true });
      expect(darkBgStroke.strokeColor).toBe("#000000");
    });
  });

  describe("layoutTextForBubbleShape with multilingual text and punctuation", () => {
    it("correctly lays out text containing Korean, English, quotes, and punctuation", () => {
      const text = "“정말이야…!? Really!?”";
      const result = layoutTextForBubbleShape(text, {
        shape: "ellipse",
        fontSizeRatio: 0.12
      });

      expect(result.lines.length).toBeGreaterThan(0);
      const combined = result.lines.map((l) => l.text).join(" ");
      expect(combined).toContain("정말이야");
      expect(combined).toContain("Really");
    });

    it("auto-fits text into bubble shape without clipping", () => {
      const text = "이것은 긴 대사입니다. 말풍선 내부에 안전하게 맞춰져야 합니다.";
      const fit = autoFitFontSizeForBubbleShape(text, { shape: "ellipse" });

      expect(fit.lines.length).toBeGreaterThan(0);
      expect(fit.fontSizeRatio).toBeGreaterThanOrEqual(0.04);
      expect(fit.totalHeightRatio).toBeLessThanOrEqual(0.95);
    });
  });
});
