import { afterEach, describe, expect, it, vi } from "vitest";
import type { DialogueLine } from "../../src/shared/projectTypes";
import {
  PRODUCTION_TYPESET_FONT_CSS_FAMILY,
  PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY
} from "../../src/shared/productionTypesetFontResource";
import { collectRenderReadinessEvidence } from "../../src/renderer/typesettingReadiness";

function line(overrides: Partial<DialogueLine> = {}): DialogueLine {
  return {
    id: "line-1",
    order: 1,
    pageNumber: 1,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "原文",
    userTranslation: "번역",
    parseConfidence: 1,
    parseWarnings: [],
    typesetting: {
      bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
      writingMode: "horizontal-tb"
    },
    ...overrides
  };
}

function installFontMeasurement(options: { missingCharacter?: string } = {}) {
  const fonts = {
    check: vi.fn(() => true)
  };
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  const measureText = vi.fn((text: string) => ({
    width: text === options.missingCharacter ? 0 : 24,
    actualBoundingBoxAscent: text === options.missingCharacter ? 0 : 12,
    actualBoundingBoxDescent: text === options.missingCharacter ? 0 : 4
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    measureText
  }) as unknown as CanvasRenderingContext2D);
  return {
    fonts,
    measureText,
    restore: () => {
      vi.restoreAllMocks();
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
    }
  };
}

describe("typesetting readiness production font evidence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not accept a system-installed Pretendard without explicit production load evidence", () => {
    const environment = installFontMeasurement();

    const evidence = collectRenderReadinessEvidence([line()]);

    expect(evidence.font).toEqual({
      identity: "",
      resourceAvailable: false,
      metricsCalculated: false,
      glyphCoverageVerified: false
    });
  });

  it("reports the fixed identity only after the production face is loaded", () => {
    installFontMeasurement();

    const evidence = collectRenderReadinessEvidence([line()], { productionFontLoaded: true });

    expect(evidence.font).toEqual({
      identity: PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY,
      resourceAvailable: true,
      metricsCalculated: true,
      glyphCoverageVerified: true
    });
    expect(document.fonts.check).toHaveBeenCalledWith(
      `16px "${PRODUCTION_TYPESET_FONT_CSS_FAMILY}"`,
      expect.any(String)
    );
  });

  it("preserves missing-glyph blockers when a loaded production font cannot measure a character", () => {
    installFontMeasurement({ missingCharacter: "역" });

    const evidence = collectRenderReadinessEvidence([line()], { productionFontLoaded: true });

    expect(evidence.font.resourceAvailable).toBe(true);
    expect(evidence.font.metricsCalculated).toBe(true);
    expect(evidence.font.glyphCoverageVerified).toBe(false);
    expect(evidence.missingGlyphLineIds).toEqual(["line-1"]);
  });

  it("returns fail-closed evidence when the document font set accessor throws", () => {
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      get: () => {
        throw new Error("font set unavailable");
      }
    });

    try {
      const evidence = collectRenderReadinessEvidence([line()], { productionFontLoaded: true });

      expect(evidence.font).toEqual({
        identity: "",
        resourceAvailable: false,
        metricsCalculated: false,
        glyphCoverageVerified: false
      });
    } finally {
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
    }
  });
});
