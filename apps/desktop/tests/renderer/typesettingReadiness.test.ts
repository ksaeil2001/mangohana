import { afterEach, describe, expect, it, vi } from "vitest";
import type { DialogueLine } from "../../src/shared/projectTypes";
import {
  PRODUCTION_TYPESET_FONT_CSS_FAMILY,
  PRODUCTION_TYPESET_FONT_EVIDENCE_IDENTITY
} from "../../src/shared/productionTypesetFontResource";
import { collectRenderReadinessEvidence } from "../../src/renderer/typesettingReadiness";
import { burnTypesettingToBlob, renderTypesettingToCanvas } from "../../src/renderer/imageBurnInRenderer";

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

  it.each([
    { label: "a 600x100 caption on a 1200x1000 page", imageSize: { width: 1200, height: 1000 }, boxWidth: 600, boxHeight: 100, fontSizeRatio: 0.3, text: "가나다라마바사아자차카타", overflow: false },
    { label: "an oversized glyph in an 80x400 box on an 800x1200 page", imageSize: { width: 800, height: 1200 }, boxWidth: 80, boxHeight: 400, fontSizeRatio: 0.2, text: "가", overflow: true }
  ])("matches canvas physical overflow for $label", ({ imageSize, boxWidth, boxHeight, fontSizeRatio, text, overflow }) => {
    const environment = installFontMeasurement();
    const dialogueLine = line({
      userTranslation: text,
      typesetting: {
        bbox: { x: 0.1, y: 0.1, width: boxWidth / imageSize.width, height: boxHeight / imageSize.height },
        writingMode: "horizontal-tb",
        shape: "rectangle",
        fontSizeRatio
      }
    });
    const fillText = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      strokeText: vi.fn(),
      fillText
    } as unknown as CanvasRenderingContext2D;

    try {
      renderTypesettingToCanvas(context, [dialogueLine], imageSize.width, imageSize.height);
      const fontPx = Number(context.font.match(/bold (\d+)px/)?.[1]);
      // Full-width Hangul glyphs and rectangle padding use the same physical pixels.
      const canvasOverflow = fillText.mock.calls.some(([renderedText]) =>
        (renderedText as string).length * fontPx > boxWidth * 0.84 * 1.08
      );
      expect(fillText).toHaveBeenCalledTimes(1);
      expect(canvasOverflow).toBe(overflow);

      const evidence = collectRenderReadinessEvidence([dialogueLine], {
        productionFontLoaded: true,
        imageSize
      });
      expect(evidence.overflowLineIds).toEqual(overflow ? [dialogueLine.id] : []);
      expect(evidence.font.glyphCoverageVerified).toBe(true);
    } finally {
      environment.restore();
    }
  });

  it.each([
    { label: "wide text that fits", width: 1200, height: 1000, boxWidth: 600, boxHeight: 100, fontSizeRatio: 0.3, text: "가나다라마바사아자차카타", overflow: false },
    { label: "narrow text that overflows", width: 800, height: 1200, boxWidth: 80, boxHeight: 400, fontSizeRatio: 0.2, text: "가", overflow: true }
  ])("checks readiness with the loaded image dimensions before burning $label", async ({ width, height, boxWidth, boxHeight, fontSizeRatio, text, overflow }) => {
    const environment = installFontMeasurement();
    const drawImage = vi.fn();
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
      measureText: environment.measureText,
      drawImage
    } as unknown as CanvasRenderingContext2D;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => context);
    const blob = new Blob(["local canvas fixture"], { type: "image/png" });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(blob));
    const dialogueLine = line({
      userTranslation: text,
      typesetting: {
        bbox: { x: 0.1, y: 0.1, width: boxWidth / width, height: boxHeight / height },
        writingMode: "horizontal-tb",
        shape: "rectangle",
        fontSizeRatio
      }
    });
    const imageSource = { width: 12, height: 10, naturalWidth: width, naturalHeight: height } as HTMLImageElement;
    const beforeRender = vi.fn((imageSize: { width: number; height: number }) => {
      expect(drawImage).not.toHaveBeenCalled();
      const evidence = collectRenderReadinessEvidence([dialogueLine], { productionFontLoaded: true, imageSize });
      expect(evidence.overflowLineIds).toEqual(overflow ? [dialogueLine.id] : []);
      if (evidence.overflowLineIds.length > 0) throw new Error("text overflow");
    });

    try {
      const rendering = burnTypesettingToBlob(imageSource, [dialogueLine], "image/png", 0.95, { beforeRender });
      if (overflow) {
        await expect(rendering).rejects.toThrow("text overflow");
        expect(drawImage).not.toHaveBeenCalled();
        expect(toBlob).not.toHaveBeenCalled();
      } else {
        await expect(rendering).resolves.toBe(blob);
        expect(drawImage).toHaveBeenCalledWith(imageSource, 0, 0, width, height);
        expect(toBlob).toHaveBeenCalledOnce();
      }
      expect(beforeRender).toHaveBeenCalledExactlyOnceWith({ width, height });
    } finally {
      environment.restore();
    }
  });

  it("keeps square-box overflow compatibility when image dimensions are omitted", () => {
    const environment = installFontMeasurement();
    try {
      const evidence = collectRenderReadinessEvidence([line({
        userTranslation: "가나다라마바사아자차카타",
        typesetting: {
          bbox: { x: 0.1, y: 0.1, width: 0.6, height: 0.1 },
          writingMode: "horizontal-tb",
          shape: "rectangle",
          fontSizeRatio: 0.3
        }
      })], { productionFontLoaded: true });

      expect(evidence.overflowLineIds).toEqual(["line-1"]);
    } finally {
      environment.restore();
    }
  });

  it("preserves vertical-writing overflow evidence when image dimensions are supplied", () => {
    const environment = installFontMeasurement();
    const dialogueLine = line({
      userTranslation: "가",
      typesetting: {
        bbox: { x: 0.1, y: 0.1, width: 0.1, height: 1 / 3 },
        writingMode: "vertical-rl",
        shape: "rectangle",
        fontSizeRatio: 0.2
      }
    });
    try {
      const legacyEvidence = collectRenderReadinessEvidence([dialogueLine], { productionFontLoaded: true });
      const evidence = collectRenderReadinessEvidence([dialogueLine], {
        productionFontLoaded: true,
        imageSize: { width: 800, height: 1200 }
      });

      expect(evidence.overflowLineIds).toEqual([]);
      expect(evidence).toEqual(legacyEvidence);
    } finally {
      environment.restore();
    }
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
