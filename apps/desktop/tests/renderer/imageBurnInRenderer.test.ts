import { describe, expect, it, vi } from "vitest";
import {
  getResolvedDialogueText,
  renderTypesettingToCanvas
} from "../../src/renderer/imageBurnInRenderer.js";
import { autoFitFontSizeForBubbleShape } from "../../src/renderer/typesettingGeometry.js";
import type { DialogueLine } from "../../src/shared/projectTypes.js";

describe("imageBurnInRenderer", () => {
  it("resolves only the explicitly user-applied translation for final output", () => {
    const line1: DialogueLine = {
      id: "1",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "こんにちは",
      userTranslation: "안녕하세요!",
      aiTranslation: "안녕",
      parseConfidence: 1,
      parseWarnings: []
    };
    expect(getResolvedDialogueText(line1)).toBe("안녕하세요!");

    const line2: DialogueLine = {
      id: "2",
      order: 2,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "ありがとう",
      aiTranslation: "고마워",
      parseConfidence: 1,
      parseWarnings: []
    };
    expect(getResolvedDialogueText(line2)).toBe("");

    const line3: DialogueLine = {
      id: "3",
      order: 3,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "さようなら",
      parseConfidence: 1,
      parseWarnings: []
    };
    expect(getResolvedDialogueText(line3)).toBe("");
  });

  it("renders typesetting lines to canvas 2D context with stroke and fill", () => {
    const saveMock = vi.fn();
    const restoreMock = vi.fn();
    const translateMock = vi.fn();
    const rotateMock = vi.fn();
    const strokeTextMock = vi.fn();
    const fillTextMock = vi.fn();

    const mockCtx = {
      save: saveMock,
      restore: restoreMock,
      translate: translateMock,
      rotate: rotateMock,
      strokeText: strokeTextMock,
      fillText: fillTextMock,
      font: "",
      textBaseline: "",
      textAlign: "",
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      lineJoin: "",
      miterLimit: 0
    } as unknown as CanvasRenderingContext2D;

    const lines: DialogueLine[] = [
      {
        id: "line-1",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "お前を許さない！",
        userTranslation: "너를 용서하지 않겠다!",
        parseConfidence: 1,
        parseWarnings: [],
        typesetting: {
          bbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 },
          writingMode: "horizontal-tb",
          shape: "ellipse",
          fontFamily: "Pretendard",
          color: "#000000",
          strokeColor: "#ffffff",
          strokeWidth: 2,
          align: "center"
        }
      }
    ];

    renderTypesettingToCanvas(mockCtx, lines, 1000, 1500);

    expect(saveMock).toHaveBeenCalled();
    expect(restoreMock).toHaveBeenCalled();
    expect(translateMock).toHaveBeenCalledWith(400, 525); // (0.2 + 0.2) * 1000, (0.2 + 0.15) * 1500
    expect(fillTextMock).toHaveBeenCalled();
    expect(strokeTextMock).toHaveBeenCalled();
  });

  it("centers a single horizontal line at the translated bbox origin", () => {
    const userTranslation = "응!";
    const layout = autoFitFontSizeForBubbleShape(userTranslation, { shape: "ellipse", boxAspectRatio: 400 / 450 });
    const fillTextMock = vi.fn();
    const strokeTextMock = vi.fn();
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillText: fillTextMock,
      strokeText: strokeTextMock
    } as unknown as CanvasRenderingContext2D;
    const line: DialogueLine = {
      id: "center-single",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "",
      userTranslation,
      parseConfidence: 1,
      parseWarnings: [],
      typesetting: {
        bbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 },
        writingMode: "horizontal-tb",
        shape: "ellipse",
        fontSizeRatio: layout.fontSizeRatio,
        rotationDegrees: 30
      }
    };

    expect(layout.lines).toHaveLength(1);
    renderTypesettingToCanvas(mockCtx, [line], 1000, 1500);

    expect(mockCtx.translate).toHaveBeenCalledWith(400, 525);
    expect(mockCtx.rotate).toHaveBeenCalledWith(Math.PI / 6);
    expect(mockCtx.font).toContain(`${Math.max(10, Math.round(layout.fontSizeRatio * 450))}px`);
    expect(strokeTextMock.mock.calls).toEqual(fillTextMock.mock.calls);
    expect(fillTextMock).toHaveBeenCalledTimes(1);
    expect(fillTextMock).toHaveBeenCalledWith(userTranslation, 0, 0);
  });

  it("centers multiple horizontal lines without changing their layout spacing", () => {
    const userTranslation = "우리는 모두 같은 곳으로 향하고 있으니 조금만 더 힘을 내서 함께 걸어가자.";
    const layout = autoFitFontSizeForBubbleShape(userTranslation, { shape: "rectangle", boxAspectRatio: 400 / 450 });
    const fillTextMock = vi.fn();
    const strokeTextMock = vi.fn();
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillText: fillTextMock,
      strokeText: strokeTextMock
    } as unknown as CanvasRenderingContext2D;
    const line: DialogueLine = {
      id: "center-multiple",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "",
      userTranslation,
      parseConfidence: 1,
      parseWarnings: [],
      typesetting: {
        bbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 },
        writingMode: "horizontal-tb",
        shape: "rectangle",
        fontSizeRatio: layout.fontSizeRatio
      }
    };

    expect(layout.lines.length).toBeGreaterThan(1);
    renderTypesettingToCanvas(mockCtx, [line], 1000, 1500);

    expect(fillTextMock).toHaveBeenCalledTimes(layout.lines.length);
    expect(fillTextMock.mock.calls.map(([text]) => text)).toEqual(layout.lines.map(({ text }) => text));
    expect(strokeTextMock.mock.calls).toEqual(fillTextMock.mock.calls);
    const renderedYs = fillTextMock.mock.calls.map(([, , y]) => y as number);
    const lineStep = layout.fontSizeRatio * 1.25 * 450;
    for (let index = 1; index < renderedYs.length; index += 1) {
      expect(renderedYs[index]! - renderedYs[index - 1]!).toBeCloseTo(lineStep);
    }
    expect(renderedYs.reduce((sum, y) => sum + y, 0) / renderedYs.length).toBeCloseTo(0);
  });

  it.each([
    { label: "80x400 OCR box with a user font", width: 80, height: 400, fontSizeRatio: 0.075, userTranslation: "가나다라", expectedLines: ["가나", "다라"], minFontPx: 30, maxFontPx: 30 },
    { label: "600x100 caption with a user font", width: 600, height: 100, fontSizeRatio: 0.3, userTranslation: "가나다라마바사아자차카타", expectedLines: ["가나다라마바사아자차카타"], minFontPx: 30, maxFontPx: 30 },
    { label: "80x400 OCR box with auto-fit", width: 80, height: 400, fontSizeRatio: undefined, userTranslation: "가나다라", expectedLines: ["가나", "다라"], minFontPx: 16, maxFontPx: 36 },
    { label: "600x100 caption with auto-fit", width: 600, height: 100, fontSizeRatio: undefined, userTranslation: "가나다라마바사아자차카타", expectedLines: ["가나다라마바사아자차카타"], minFontPx: 30, maxFontPx: 35 }
  ])("uses the physical aspect ratio for $label without mutating user data", ({ width, height, fontSizeRatio, userTranslation, expectedLines, minFontPx, maxFontPx }) => {
    const fillTextMock = vi.fn();
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      fillText: fillTextMock,
      strokeText: vi.fn()
    } as unknown as CanvasRenderingContext2D;
    const line: DialogueLine = Object.freeze({
      id: "physical-box",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "",
      userTranslation,
      aiTranslation: "검토 중인 AI 제안",
      parseConfidence: 1,
      parseWarnings: [],
      typesetting: Object.freeze({
        bbox: Object.freeze({ x: 0.1, y: 0.1, width: width / 1000, height: height / 1000 }),
        writingMode: "horizontal-tb",
        shape: "rectangle",
        fontSizeRatio
      })
    });

    renderTypesettingToCanvas(mockCtx, Object.freeze([line]), 1000, 1000);

    expect(fillTextMock.mock.calls.map(([text]) => text)).toEqual(expectedLines);
    const fontPx = Number(mockCtx.font.match(/bold (\d+)px/)?.[1]);
    expect(fontPx).toBeGreaterThanOrEqual(minFontPx);
    expect(fontPx).toBeLessThanOrEqual(maxFontPx);
    expect(line.userTranslation).toBe(userTranslation);
    expect(line.typesetting?.fontSizeRatio).toBe(fontSizeRatio);
  });

  it("does not render an AI proposal without an explicitly user-applied translation", () => {
    const mockCtx = {
      save: vi.fn(),
      fillText: vi.fn(),
      strokeText: vi.fn()
    } as unknown as CanvasRenderingContext2D;
    const line: DialogueLine = {
      id: "ai-proposal",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "こんにちは",
      referenceTranslation: "안녕하세요",
      aiTranslation: "안녕",
      parseConfidence: 1,
      parseWarnings: []
    };

    renderTypesettingToCanvas(mockCtx, [line], 1000, 1500);

    expect(mockCtx.save).not.toHaveBeenCalled();
    expect(mockCtx.fillText).not.toHaveBeenCalled();
    expect(mockCtx.strokeText).not.toHaveBeenCalled();
  });

  it("renders vertical-rl writing mode column by column", () => {
    const strokeTextMock = vi.fn();
    const fillTextMock = vi.fn();

    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      strokeText: strokeTextMock,
      fillText: fillTextMock,
      font: "",
      textBaseline: "",
      textAlign: "",
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      lineJoin: "",
      miterLimit: 0
    } as unknown as CanvasRenderingContext2D;

    const lines: DialogueLine[] = [
      {
        id: "line-v",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "縦書きテスト",
        userTranslation: "세로쓰기",
        parseConfidence: 1,
        parseWarnings: [],
        typesetting: {
          bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.8 },
          writingMode: "vertical-rl",
          shape: "rectangle",
          fontFamily: "Pretendard",
          color: "#000000",
          strokeColor: "#ffffff",
          strokeWidth: 2,
          align: "center"
        }
      }
    ];

    renderTypesettingToCanvas(mockCtx, lines, 1000, 1000);
    expect(fillTextMock.mock.calls).toEqual([
      ["세", 179.4, -158.7],
      ["로", 179.4, 158.7],
      ["쓰", -179.4, -158.7],
      ["기", -179.4, 158.7]
    ]);
    expect(strokeTextMock.mock.calls).toEqual(fillTextMock.mock.calls);
  });
});
