import { describe, expect, it } from "vitest";
import {
  autoFitFontSizeForBubbleShape,
  clientPointToNormalized,
  constrainTypesettingDraftToSafeArea,
  createTypesettingDraft,
  deriveTypesettingSafeArea,
  dialogueTypesettingToDraft,
  draftToDialogueTypesetting,
  getRotatedCorners,
  isDraftWithinSafeArea,
  layoutTextForBubbleShape,
  moveTypesettingDraft,
  resizeTypesettingDraft,
  rotateTypesettingDraft,
  type TypesettingDraft
} from "../../src/renderer/typesettingGeometry";


const ocrBbox = { x: 0.4, y: 0.35, width: 0.2, height: 0.1 };
const safeArea = { x: 0.35, y: 0.3, width: 0.3, height: 0.2 };

describe("typesettingGeometry", () => {
  it("creates an independent horizontal draft without mutating the OCR bbox", () => {
    const source = structuredClone(ocrBbox);
    const draft = createTypesettingDraft({ id: "draft-1", sourceOcrId: "ocr-1", ocrBbox, safeArea });

    expect(draft.writingMode).toBe("horizontal-tb");
    expect(draft.rotationDegrees).toBe(0);
    expect(draft.bbox).not.toBe(ocrBbox);
    expect(draft.bbox).toEqual(ocrBbox);
    expect(ocrBbox).toEqual(source);

    const moved = moveTypesettingDraft(draft, { x: 0.08, y: -0.04 }, safeArea);
    const resized = resizeTypesettingDraft(moved, "se", { x: 0.08, y: 0.08 }, safeArea);
    const rotated = rotateTypesettingDraft(resized, 18, safeArea);
    expect(ocrBbox).toEqual(source);
    expect(draft.bbox).toEqual(ocrBbox);
    expect(resized).not.toBe(moved);
    expect(rotated).not.toBe(resized);
  });

  it("maps client coordinates through the actual media rect after fit margin and zoom/pan", () => {
    expect(clientPointToNormalized({ clientX: 200, clientY: 150 }, {
      left: 100,
      top: 50,
      width: 400,
      height: 800,
      right: 500,
      bottom: 850
    })).toEqual({ x: 0.25, y: 0.125 });
    expect(clientPointToNormalized({ clientX: -100, clientY: 1000 }, {
      left: -300,
      top: -150,
      width: 800,
      height: 1200,
      right: 500,
      bottom: 1050
    })).toEqual({ x: 0.25, y: 0.9583333333333334 });
  });

  it("clamps move and resize to the safe area and enforces a minimum size", () => {
    const draft = createTypesettingDraft({ id: "draft-2", sourceOcrId: "ocr-2", ocrBbox, safeArea });
    const moved = moveTypesettingDraft(draft, { x: 1, y: 1 }, safeArea);
    expect(moved.bbox.x + moved.bbox.width).toBeLessThanOrEqual(safeArea.x + safeArea.width);
    expect(moved.bbox.y + moved.bbox.height).toBeLessThanOrEqual(safeArea.y + safeArea.height);
    expect(moved.bbox.x).toBeGreaterThanOrEqual(safeArea.x);
    expect(moved.bbox.y).toBeGreaterThanOrEqual(safeArea.y);

    const tiny = resizeTypesettingDraft(draft, "se", { x: -1, y: -1 }, safeArea);
    expect(tiny.bbox.width).toBeGreaterThanOrEqual(0.02);
    expect(tiny.bbox.height).toBeGreaterThanOrEqual(0.02);
    expect(isDraftWithinSafeArea(tiny, safeArea)).toBe(true);
  });

  it("never moves a rotated draft beyond the safe-area corners", () => {
    const area = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
    const rotatedDraft: TypesettingDraft = {
      id: "rotated-move",
      sourceOcrId: "ocr-rotated-move",
      bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      rotationDegrees: 45,
      writingMode: "horizontal-tb"
    };
    const moved = moveTypesettingDraft(rotatedDraft, { x: 0.4, y: 0 }, area);
    expect(isDraftWithinSafeArea(moved, area)).toBe(true);
  });

  it("never resizes a rotated draft beyond the safe-area corners", () => {
    const area = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
    const rotatedDraft: TypesettingDraft = {
      id: "rotated-resize",
      sourceOcrId: "ocr-rotated-resize",
      bbox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
      rotationDegrees: 45,
      writingMode: "horizontal-tb"
    };
    const resized = resizeTypesettingDraft(rotatedDraft, "se", { x: 0.4, y: 0.4 }, area);
    expect(isDraftWithinSafeArea(resized, area)).toBe(true);
  });

  it("rejects a loaded draft that no longer fits the current OCR safe area", () => {
    const area = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const loaded: TypesettingDraft = {
      id: "loaded-outdated",
      sourceOcrId: "ocr-outdated",
      bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      rotationDegrees: 25,
      writingMode: "horizontal-tb"
    };
    const constrained = constrainTypesettingDraftToSafeArea(loaded, area);
    expect(constrained).toBeNull();
    expect(loaded.bbox).toEqual({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
  });

  it("rejects sub-minimum and non-normalized drafts before they reach the editor", () => {
    const area = { x: 0, y: 0, width: 1, height: 1 };
    for (const bbox of [
      { x: 0.2, y: 0.2, width: 0, height: 0.1 },
      { x: 0.2, y: 0.2, width: 0.019, height: 0.1 },
      { x: 0.99, y: 0.2, width: 0.1, height: 0.1 }
    ]) {
      const loaded: TypesettingDraft = {
        id: "invalid-loaded",
        sourceOcrId: "ocr-invalid-loaded",
        bbox,
        rotationDegrees: 0,
        writingMode: "horizontal-tb"
      };
      expect(constrainTypesettingDraftToSafeArea(loaded, area)).toBeNull();
    }
  });

  it("keeps every rotated corner inside the safe area, rejecting unsafe rotations", () => {
    const draft = createTypesettingDraft({
      id: "draft-3",
      sourceOcrId: "ocr-3",
      ocrBbox: { x: 0.46, y: 0.43, width: 0.08, height: 0.06 },
      safeArea: { x: 0.4, y: 0.35, width: 0.2, height: 0.2 }
    });
    const rotated = rotateTypesettingDraft(draft, 45, safeArea);
    expect(isDraftWithinSafeArea(rotated, safeArea)).toBe(true);
    for (const corner of getRotatedCorners(rotated)) {
      expect(corner.x).toBeGreaterThanOrEqual(safeArea.x - 1e-9);
      expect(corner.y).toBeGreaterThanOrEqual(safeArea.y - 1e-9);
      expect(corner.x).toBeLessThanOrEqual(safeArea.x + safeArea.width + 1e-9);
      expect(corner.y).toBeLessThanOrEqual(safeArea.y + safeArea.height + 1e-9);
    }
    const edgeDraft = createTypesettingDraft({
      id: "draft-4",
      sourceOcrId: "ocr-4",
      ocrBbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
      safeArea: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }
    });
    const edgeArea = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
    expect(isDraftWithinSafeArea(rotateTypesettingDraft(edgeDraft, 45, edgeArea), edgeArea)).toBe(true);
  });

  it("derives a deterministic expanded safe area and falls back to the image", () => {
    const derived = deriveTypesettingSafeArea(ocrBbox);
    expect(derived.x).toBeCloseTo(0.38);
    expect(derived.y).toBeCloseTo(0.33);
    expect(derived.width).toBeCloseTo(0.24);
    expect(derived.height).toBeCloseTo(0.14);
    expect(deriveTypesettingSafeArea(null)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("lays out text within ellipse chord widths", () => {
    const result = layoutTextForBubbleShape("안녕! 나는 루피라고 해. 해적왕이 될 사나이지!", {
      shape: "ellipse",
      fontSizeRatio: 0.15
    });

    expect(result.lines.length).toBeGreaterThan(1);
    // Every line's text should not be empty
    for (const line of result.lines) {
      expect(line.text.length).toBeGreaterThan(0);
      expect(line.width).toBeGreaterThan(0);
    }
  });

  it("converts between DialogueTypesetting and TypesettingDraft seamlessly", () => {
    const dt = {
      bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
      writingMode: "horizontal-tb" as const,
      rotationDegrees: 15,
      shape: "ellipse" as const,
      fontFamily: "Pretendard",
      color: "#000000",
      strokeColor: "#ffffff",
      strokeWidth: 2,
      align: "center" as const,
      lineHeight: 1.2
    };

    const draft = dialogueTypesettingToDraft("draft-1", "ocr-1", dt);
    expect(draft).toEqual({
      id: "draft-1",
      sourceOcrId: "ocr-1",
      bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
      rotationDegrees: 15,
      writingMode: "horizontal-tb",
      shape: "ellipse"
    });

    const convertedBack = draftToDialogueTypesetting(draft, {
      fontFamily: "Pretendard",
      color: "#000000",
      strokeColor: "#ffffff",
      strokeWidth: 2,
      align: "center",
      lineHeight: 1.2
    });

    expect(convertedBack).toEqual(dt);
  });

  it("applies KLReq line start/end rules and YSB evaluation across bubble layout", () => {
    const text = "“정말이야…!? 그가 나타났어!”라고 말했다.";
    const result = layoutTextForBubbleShape(text, {
      shape: "ellipse",
      fontSizeRatio: 0.12
    });

    expect(result.lines.length).toBeGreaterThan(0);
    // Ensure no line starts with a line-start prohibited character like '!', '?', '…', or '”'
    for (let i = 1; i < result.lines.length; i += 1) {
      const firstChar = result.lines[i]!.text[0]!;
      expect([")", "]", "}", "!", "?", ".", ",", "…", "”", "’"]).not.toContain(firstChar);
    }
  });

  it("handles various bubble shapes (cloud, spiky, rounded_rectangle) with auto-fit", () => {
    const text = "우와아아악! 저 괴물은 대체 어디서 나타난 거야!?";
    for (const shape of ["cloud", "spiky", "rounded_rectangle", "rectangle"] as const) {
      const fit = autoFitFontSizeForBubbleShape(text, { shape });
      expect(fit.lines.length).toBeGreaterThan(0);
      expect(fit.fontSizeRatio).toBeGreaterThanOrEqual(0.04);
      expect(fit.totalHeightRatio).toBeLessThanOrEqual(0.95);
      for (const line of fit.lines) {
        expect(line.width).toBeGreaterThan(0);
      }
    }
  });
});
