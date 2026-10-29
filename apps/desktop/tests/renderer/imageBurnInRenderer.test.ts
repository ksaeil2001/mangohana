import { describe, expect, it, vi } from "vitest";
import {
  getResolvedDialogueText,
  renderTypesettingToCanvas
} from "../../src/renderer/imageBurnInRenderer.js";
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
    expect(fillTextMock).toHaveBeenCalled();
  });
});
