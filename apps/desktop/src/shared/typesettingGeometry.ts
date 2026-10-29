import type { NormalizedBbox } from "./speechBubbleExtraction.js";
import type { DialogueTypesetting } from "./projectTypes.js";
import {
  getAvailableSpanAtY,
  type BubbleShape,
  type ShapePadding
} from "./typesettingShape.js";
import { evaluateAndBreakKoreanText } from "./typesettingKoreanBreak.js";

export type TypesettingWritingMode = "horizontal-tb" | "vertical-rl";

export type TypesettingStyle = {
  fontFamily?: string;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  align?: "center" | "left" | "right";
  lineHeight?: number;
  shape?: BubbleShape;
};

/**
 * Returns a robust font fallback chain for comic typesetting.
 * Ensures consistent rendering across Windows/macOS/Linux without missing glyphs (Tofu).
 */
export function getRecommendedFontFallbackChain(
  language: "ko" | "ja" | "en" | string = "ko",
  primaryFont?: string
): string {
  const chains: Record<string, string[]> = {
    ko: [
      "Pretendard",
      "NanumGothic",
      "Apple SD Gothic Neo",
      "Malgun Gothic",
      "Noto Sans CJK KR",
      "sans-serif"
    ],
    ja: [
      "Noto Sans CJK JP",
      "Meiryo",
      "Yu Gothic",
      "Hiragino Kaku Gothic ProN",
      "sans-serif"
    ],
    en: [
      "-apple-system",
      "BlinkMacSystemFont",
      "Segoe UI",
      "Roboto",
      "Helvetica",
      "Arial",
      "sans-serif"
    ]
  };

  const selectedChain = chains[language] ?? chains.ko!;
  if (primaryFont?.trim()) {
    const trimmed = primaryFont.trim();
    const quoted = trimmed.includes(" ") && !trimmed.startsWith("'") && !trimmed.startsWith('"')
      ? `'${trimmed}'`
      : trimmed;
    return [quoted, ...selectedChain].join(", ");
  }

  return selectedChain.join(", ");
}

/**
 * Computes contrast stroke (outline) properties to ensure text legibility over complex comic backgrounds.
 */
export function calculateContrastStroke(options: {
  textColor?: string;
  isDarkBackground?: boolean;
  fontSizeRatio?: number;
}): { strokeColor: string; strokeWidth: number } {
  const { textColor = "#000000", isDarkBackground = false, fontSizeRatio = 0.15 } = options;

  const normalizedColor = textColor.toLowerCase().trim();
  const isLightText =
    normalizedColor === "#ffffff" ||
    normalizedColor === "white" ||
    normalizedColor === "#fff" ||
    normalizedColor.startsWith("rgb(255");

  // Relative stroke width scaled with font size
  const strokeWidth = Math.max(1.5, Math.round(fontSizeRatio * 20));

  if (isDarkBackground || isLightText) {
    return { strokeColor: "#000000", strokeWidth };
  }

  // Dark text on potentially textured/screentone background gets white stroke
  return { strokeColor: "#ffffff", strokeWidth };
}

export type TypesettingLineLayout = {
  text: string;
  relativeY: number;
  startX: number;
  width: number;
};

export type TypesettingLayoutResult = {
  lines: TypesettingLineLayout[];
  fontSizeRatio: number;
  totalHeightRatio: number;
};

export type TypesettingDraft = {
  id: string;
  sourceOcrId: string;
  bbox: NormalizedBbox;
  rotationDegrees: number;
  writingMode: TypesettingWritingMode;
  shape?: BubbleShape;
};

export type TypesettingSafeArea = NormalizedBbox;

export const DEFAULT_TYPESETTING_SAFE_AREA: TypesettingSafeArea = {
  x: 0,
  y: 0,
  width: 1,
  height: 1
};

export const TYPESETTING_MIN_SIZE = 0.02;

export function isValidTypesettingBbox(value: unknown): value is NormalizedBbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bbox = value as Partial<NormalizedBbox>;
  const parts = [bbox.x, bbox.y, bbox.width, bbox.height];
  if (!parts.every((part) => typeof part === "number" && Number.isFinite(part))) return false;
  return bbox.x !== undefined && bbox.y !== undefined && bbox.width !== undefined && bbox.height !== undefined &&
    bbox.x >= 0 && bbox.y >= 0 && bbox.width >= TYPESETTING_MIN_SIZE && bbox.height >= TYPESETTING_MIN_SIZE &&
    bbox.x + bbox.width <= 1 && bbox.y + bbox.height <= 1;
}

export type TextLayoutOptions = {
  shape?: BubbleShape;
  fontSizeRatio?: number; // relative to bbox height
  lineHeight?: number;
  padding?: ShapePadding;
};

/**
 * Estimates text width in units relative to bbox height, assuming Korean/CJK character width ≈ fontSize
 * and latin/punctuation/spaces ≈ 0.55 * fontSize.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // CJK Unified Ideographs, Hangul Syllables, Fullwidth forms
    if (
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul
      (code >= 0x4e00 && code <= 0x9fff) || // CJK
      (code >= 0x3040 && code <= 0x30ff) || // Kana
      (code >= 0xff00 && code <= 0xffef) // Fullwidth
    ) {
      width += fontSize;
    } else if (char === " " || char === "\t") {
      width += fontSize * 0.35;
    } else {
      width += fontSize * 0.55;
    }
  }
  return width;
}

/**
 * Layouts text into multiple lines fitted to the available chord widths of a bubble shape.
 */
export function layoutTextForBubbleShape(
  text: string,
  options: TextLayoutOptions = {}
): TypesettingLayoutResult {
  const shape = options.shape ?? "ellipse";
  const fontSizeRatio = Math.max(0.001, options.fontSizeRatio ?? 0.15);
  const lineHeight = Math.max(0.1, options.lineHeight ?? 1.25);
  const padding = options.padding;

  if (!text || text.trim().length === 0) {
    return {
      lines: [],
      fontSizeRatio,
      totalHeightRatio: 0
    };
  }

  const lineStep = fontSizeRatio * lineHeight;

  // Split text by explicit newlines first
  const rawParagraphs = text.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
  const brokenLines: string[] = [];

  for (const paragraph of rawParagraphs) {
    // Estimate total lines needed for this paragraph
    const approxCharsPerLine = Math.max(2, Math.floor(0.8 / Math.max(0.01, fontSizeRatio)));
    const estimatedLineCount = Math.max(1, Math.ceil(paragraph.length / approxCharsPerLine));
    const estimatedTotalHeight = estimatedLineCount * lineStep;
    const startY = Math.max(0.05, 0.5 - estimatedTotalHeight / 2 + lineStep / 2);

    const paraLines = evaluateAndBreakKoreanText(paragraph, {
      estimateWidth: (t) => estimateTextWidth(t, fontSizeRatio),
      getAvailableWidth: (lineIdx) => {
        const y = startY + (brokenLines.length + lineIdx) * lineStep;
        const span = getAvailableSpanAtY(shape, y, padding);
        return span.width > 0 ? span.width : 0.8;
      },
      maxLines: Math.max(1, Math.floor(0.9 / lineStep))
    });

    brokenLines.push(...paraLines);
  }

  // Layout the final lines vertically centered inside the bubble shape
  const totalLineCount = Math.max(1, brokenLines.length);
  const totalHeightRatio = totalLineCount * lineStep;
  const startY = Math.max(0.05, 0.5 - totalHeightRatio / 2 + lineStep / 2);

  const lines: TypesettingLineLayout[] = [];
  for (let i = 0; i < brokenLines.length; i += 1) {
    const lineText = brokenLines[i]!;
    const y = startY + i * lineStep;
    const span = getAvailableSpanAtY(shape, y, padding);

    lines.push({
      text: lineText,
      relativeY: y,
      startX: span.startX,
      width: span.width > 0 ? span.width : 0.8
    });
  }

  return {
    lines,
    fontSizeRatio,
    totalHeightRatio
  };
}

/**
 * Uses binary search to find the optimal font size ratio that fits all text within the bubble shape without overflowing.
 * Employs the manga-translator-studio auto-fit principle with CarrotMangaTranslator chord spans.
 */
export function autoFitFontSizeForBubbleShape(
  text: string,
  options: Omit<TextLayoutOptions, "fontSizeRatio"> = {}
): TypesettingLayoutResult {
  const minRatio = 0.04;
  const maxRatio = 0.35;
  const tolerance = 0.005;

  let low = minRatio;
  let high = maxRatio;
  let bestResult = layoutTextForBubbleShape(text, { ...options, fontSizeRatio: minRatio });

  for (let iter = 0; iter < 10; iter += 1) {
    const mid = (low + high) / 2;
    const result = layoutTextForBubbleShape(text, { ...options, fontSizeRatio: mid });

    // Check if all text was laid out, total height fits, and all individual lines fit their chord widths
    const totalChars = result.lines.reduce((acc, l) => acc + l.text.replace(/\s/g, "").length, 0);
    const expectedChars = text.replace(/\s/g, "").length;
    const allLinesFitWidth = result.lines.every((l) => estimateTextWidth(l.text, mid) <= l.width * 1.08);
    const fits = totalChars >= expectedChars && result.totalHeightRatio <= 0.92 && allLinesFitWidth;

    if (fits) {
      bestResult = result;
      low = mid; // Try larger font
    } else {
      high = mid; // Too large, reduce font
    }

    if (high - low < tolerance) break;
  }

  return bestResult;
}

/**
 * Reuses the same deterministic layout checks as the canvas renderer so a
 * readiness report can prove that the selected user text fits its bubble.
 */
export function hasTypesettingTextOverflow(
  text: string,
  options: TextLayoutOptions = {}
): boolean {
  const normalizedText = text.trim();
  if (!normalizedText) return false;
  const result = options.fontSizeRatio
    ? layoutTextForBubbleShape(normalizedText, options)
    : autoFitFontSizeForBubbleShape(normalizedText, options);
  const expectedChars = normalizedText.replace(/\s/g, "").length;
  const laidOutChars = result.lines.reduce((total, line) => total + line.text.replace(/\s/g, "").length, 0);
  const allLinesFitWidth = result.lines.every(
    (line) => estimateTextWidth(line.text, result.fontSizeRatio) <= line.width * 1.08
  );
  return result.lines.length === 0 ||
    laidOutChars < expectedChars ||
    result.totalHeightRatio > 0.92 ||
    !allLinesFitWidth;
}

/**
 * Converts a persisted DialogueTypesetting model from a project file to a live renderer TypesettingDraft.
 */
export function dialogueTypesettingToDraft(
  id: string,
  sourceOcrId: string,
  typesetting: DialogueTypesetting
): TypesettingDraft {
  return {
    id,
    sourceOcrId,
    bbox: { ...typesetting.bbox },
    rotationDegrees: typesetting.rotationDegrees ?? 0,
    writingMode: typesetting.writingMode,
    shape: typesetting.shape ?? "ellipse"
  };
}

/**
 * Converts a live renderer TypesettingDraft (with optional style) to the persisted DialogueTypesetting format.
 */
export function draftToDialogueTypesetting(
  draft: TypesettingDraft,
  style?: TypesettingStyle
): DialogueTypesetting {
  return {
    bbox: { ...draft.bbox },
    writingMode: draft.writingMode,
    rotationDegrees: draft.rotationDegrees || undefined,
    shape: draft.shape,
    fontFamily: style?.fontFamily,
    color: style?.color,
    strokeColor: style?.strokeColor,
    strokeWidth: style?.strokeWidth,
    align: style?.align,
    lineHeight: style?.lineHeight
  };
}
