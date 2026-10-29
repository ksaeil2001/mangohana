import { describe, expect, it } from "vitest";
import type { DialogueLine } from "../../src/shared/projectTypes.js";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction.js";
import {
  calculateBboxIou,
  isUserProtectedLine,
  matchAndPreserveDialogueLines
} from "../../src/main/ocr/pipeline/reRunMatcher.js";

describe("reRunMatcher (YSB Translator Tool State Preservation)", () => {
  describe("calculateBboxIou", () => {
    it("returns 1.0 for identical bounding boxes", () => {
      const box = { x: 0.1, y: 0.1, width: 0.3, height: 0.4 };
      expect(calculateBboxIou(box, box)).toBeCloseTo(1.0);
    });

    it("returns 0.0 for non-overlapping bounding boxes", () => {
      const boxA = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
      const boxB = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 };
      expect(calculateBboxIou(boxA, boxB)).toBe(0.0);
    });

    it("returns correct partial overlap ratio", () => {
      const boxA = { x: 0.0, y: 0.0, width: 0.5, height: 0.5 }; // area = 0.25
      const boxB = { x: 0.25, y: 0.0, width: 0.5, height: 0.5 }; // area = 0.25, overlap = 0.25*0.5 = 0.125
      // union = 0.25 + 0.25 - 0.125 = 0.375
      // iou = 0.125 / 0.375 = 1/3
      expect(calculateBboxIou(boxA, boxB)).toBeCloseTo(1 / 3);
    });
  });

  describe("isUserProtectedLine", () => {
    it("identifies user_confirmed or user_modified lines as protected", () => {
      const lineConfirmed: DialogueLine = {
        id: "l1",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "こんにちは",
        parseConfidence: 0.9,
        parseWarnings: [],
        ocrEditStatus: "user_confirmed"
      };
      expect(isUserProtectedLine(lineConfirmed)).toBe(true);

      const lineModified: DialogueLine = {
        ...lineConfirmed,
        ocrEditStatus: "user_modified"
      };
      expect(isUserProtectedLine(lineModified)).toBe(true);
    });

    it("identifies lines with user translation or override text as protected", () => {
      const lineWithTranslation: DialogueLine = {
        id: "l2",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "こんにちは",
        userTranslation: "안녕하세요",
        parseConfidence: 0.9,
        parseWarnings: []
      };
      expect(isUserProtectedLine(lineWithTranslation)).toBe(true);

      const lineWithOverride: DialogueLine = {
        id: "l3",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "こんには",
        userOverrideSourceText: "こんにちは",
        parseConfidence: 0.9,
        parseWarnings: []
      };
      expect(isUserProtectedLine(lineWithOverride)).toBe(true);
    });

    it("identifies pristine ai_proposed lines as unprotected", () => {
      const aiLine: DialogueLine = {
        id: "l4",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "こんにちは",
        parseConfidence: 0.9,
        parseWarnings: [],
        ocrEditStatus: "ai_proposed"
      };
      expect(isUserProtectedLine(aiLine)).toBe(false);
    });
  });

  describe("matchAndPreserveDialogueLines", () => {
    const existingLines: DialogueLine[] = [
      {
        id: "line-user-edited",
        order: 1,
        pageNumber: 1,
        speaker: "주인공",
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "사용자가 수정한 완벽한 원문",
        userTranslation: "사용자 번역문",
        ocrEditStatus: "user_confirmed",
        parseConfidence: 0.95,
        parseWarnings: [],
        typesetting: {
          bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
          writingMode: "vertical-rl"
        }
      },
      {
        id: "line-ai-pristine",
        order: 2,
        pageNumber: 1,
        speaker: "행인",
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "이전 AI 텍스트 (오타 있음)",
        ocrEditStatus: "ai_proposed",
        parseConfidence: 0.7,
        parseWarnings: [],
        typesetting: {
          bbox: { x: 0.5, y: 0.1, width: 0.2, height: 0.3 },
          writingMode: "vertical-rl"
        }
      },
      {
        id: "line-page-2",
        order: 1,
        pageNumber: 2,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "2페이지 대사",
        parseConfidence: 0.9,
        parseWarnings: []
      }
    ];

    const newExtractedResult: SpeechBubbleExtractionResult = {
      pageNumber: 1,
      speechBubbles: [
        {
          id: "bubble-reocr-1",
          type: "speech_bubble",
          text: "새로 OCR된 텍스트 1",
          language: "ja",
          bbox: { x: 0.11, y: 0.11, width: 0.19, height: 0.29 }, // high IoU with line-user-edited
          readingOrder: 1,
          confidence: 0.98,
          notes: "",
          speakerCandidates: [{ speaker: "AI추천화자", confidence: 0.9, reason: "말풍선 꼬리" }]
        },
        {
          id: "bubble-reocr-2",
          type: "speech_bubble",
          text: "새로 개선된 깨끗한 AI 텍스트",
          language: "ja",
          bbox: { x: 0.51, y: 0.09, width: 0.2, height: 0.3 }, // high IoU with line-ai-pristine
          readingOrder: 2,
          confidence: 0.96,
          notes: "",
          speakerCandidates: [{ speaker: "새화자", confidence: 0.85, reason: "얼굴 근처" }]
        },
        {
          id: "bubble-reocr-3",
          type: "speech_bubble",
          text: "새로 발견된 3번째 말풍선",
          language: "ja",
          bbox: { x: 0.1, y: 0.6, width: 0.3, height: 0.3 }, // no existing match
          readingOrder: 3,
          confidence: 0.91,
          notes: "",
          speakerCandidates: []
        }
      ],
      nonSpeechText: [],
      warnings: []
    };

    it("preserves user_confirmed line text and speaker while updating metadata", () => {
      const result = matchAndPreserveDialogueLines({
        existingLines,
        extractedResult: newExtractedResult,
        pageNumber: 1
      });

      expect(result.stats.preservedCount).toBe(1);
      expect(result.stats.updatedCount).toBe(1);
      expect(result.stats.newCount).toBe(1);

      // 1. Check user edited line: sourceText and speaker must NOT be overwritten
      const preserved = result.mergedLines.find((l) => l.id === "line-user-edited");
      expect(preserved).toBeDefined();
      expect(preserved?.sourceText).toBe("사용자가 수정한 완벽한 원문");
      expect(preserved?.speaker).toBe("주인공");
      expect(preserved?.userTranslation).toBe("사용자 번역문");
      expect(preserved?.ocrEditStatus).toBe("user_confirmed");

      // 2. Check pristine AI line: must be updated with improved text
      const updated = result.mergedLines.find((l) => l.id === "line-ai-pristine");
      expect(updated).toBeDefined();
      expect(updated?.sourceText).toBe("새로 개선된 깨끗한 AI 텍스트");
      expect(updated?.speaker).toBe("새화자");

      // 3. Check new bubble: must be added as a new line
      const brandNew = result.mergedLines.find((l) => l.sourceText === "새로 발견된 3번째 말풍선");
      expect(brandNew).toBeDefined();
      expect(brandNew?.pageNumber).toBe(1);
      expect(brandNew?.ocrEditStatus).toBe("ai_proposed");

      // 4. Check other page lines: must be preserved untouched
      const page2Line = result.mergedLines.find((l) => l.pageNumber === 2);
      expect(page2Line).toBeDefined();
      expect(page2Line?.sourceText).toBe("2페이지 대사");
    });
  });
});
