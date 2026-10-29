import { describe, expect, it } from "vitest";
import {
  calculateBatchPercent,
  createInitialBatchProgress,
  generateBatchTypesetting,
  getDefaultBatchConfig,
  validateBatchPipelineConfig
} from "../../src/shared/batchAutomation.js";
import type { DialogueLine } from "../../src/shared/projectTypes.js";

describe("batchAutomation", () => {
  it("initializes batch progress state correctly", () => {
    const config = getDefaultBatchConfig();
    const progress = createInitialBatchProgress(3, config);

    expect(progress.stage).toBe("idle");
    expect(progress.totalPages).toBe(3);
    expect(progress.percent).toBe(0);
    expect(Object.keys(progress.pageStatuses)).toEqual(["1", "2", "3"]);
  });

  it("calculates progress percentage based on stage and page fraction", () => {
    expect(calculateBatchPercent("idle", 0, 10)).toBe(0);
    expect(calculateBatchPercent("ocr", 4, 10)).toBe(13); // base 0 + 25 * 0.5 = 12.5 -> 13
    expect(calculateBatchPercent("completed", 10, 10)).toBe(100);
  });

  it("generates automatic typesetting for dialogue lines with existing geometry", () => {
    const lines: DialogueLine[] = [
      {
        id: "l1",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "こんにちは！",
        userTranslation: "안녕하세요!",
        parseConfidence: 1,
        parseWarnings: [],
        typesetting: {
          bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
          writingMode: "horizontal-tb"
        }
      }
    ];

    const typesetLines = generateBatchTypesetting(lines);
    expect(typesetLines[0].typesetting).toBeDefined();
    expect(typesetLines[0].typesetting?.bbox).toEqual({ x: 0.1, y: 0.1, width: 0.4, height: 0.2 });
    expect(typesetLines[0].typesetting?.shape).toBe("ellipse");
    expect(typesetLines[0].typesetting?.fontSizeRatio).toBeGreaterThan(0);
    expect(typesetLines[0].typesetting?.strokeWidth).toBeGreaterThan(0);
  });

  it("does not generate typesetting when dialogue line has no geometry", () => {
    const lines: DialogueLine[] = [
      {
        id: "l-no-geo",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "こんにちは！",
        userTranslation: "안녕하세요!",
        parseConfidence: 1,
        parseWarnings: []
      }
    ];

    const typesetLines = generateBatchTypesetting(lines);
    expect(typesetLines[0].typesetting).toBeUndefined();
  });

  it("does not create final typesetting from an AI-only translation proposal", () => {
    const lines: DialogueLine[] = [{
      id: "ai-only",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "こんにちは！",
      aiTranslation: "안녕하세요!",
      parseConfidence: 1,
      parseWarnings: [],
      typesetting: undefined,
      polygon: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.3 },
        { x: 0.1, y: 0.3 }
      ]
    }];

    expect(generateBatchTypesetting(lines)[0]?.typesetting).toBeUndefined();
  });

  it("preserves existing user typesetting when only an AI translation proposal exists", () => {
    const existingTypesetting = {
      bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
      writingMode: "vertical-rl" as const,
      fontSizeRatio: 0.08,
      fontFamily: "User Font",
      color: "#123456"
    };
    const line: DialogueLine = {
      id: "ai-only-existing-typesetting",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "こんにちは！",
      aiTranslation: "안녕하세요!",
      parseConfidence: 1,
      parseWarnings: [],
      typesetting: existingTypesetting
    };

    const [result] = generateBatchTypesetting([line]);

    expect(result).toBe(line);
    expect(result?.typesetting).toBe(existingTypesetting);
  });

  describe("validateBatchPipelineConfig", () => {
    it("accepts valid batch config and normalizes defaults", () => {
      const valid = validateBatchPipelineConfig({
        targetPages: [1, 2, 3],
        runTranslate: true,
        runTypeset: false,
        speechStylePreset: "honorific",
        overwriteExisting: true
      });

      expect(valid.targetPages).toEqual([1, 2, 3]);
      expect(valid.runTranslate).toBe(true);
      expect(valid.runTypeset).toBe(false);
      expect(valid.speechStylePreset).toBe("honorific");
      expect(valid.overwriteExisting).toBe(true);
      expect(valid.runOcr).toBe(false);
      expect(valid.runGlossary).toBe(false);
      expect(valid.runInpaint).toBe(false);
    });

    it("rejects non-object payload", () => {
      expect(() => validateBatchPipelineConfig(null)).toThrow("Invalid batch pipeline config: payload must be an object");
      expect(() => validateBatchPipelineConfig("string")).toThrow("Invalid batch pipeline config: payload must be an object");
      expect(() => validateBatchPipelineConfig([1, 2])).toThrow("Invalid batch pipeline config: payload must be an object");
    });

    it("rejects invalid targetPages", () => {
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", targetPages: [] })).toThrow("targetPages cannot be empty array");
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", targetPages: [-1] })).toThrow("positive integers");
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", targetPages: ["1"] })).toThrow("positive integers");
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", targetPages: 123 })).toThrow("must be 'all' or an array");
    });

    it("rejects unsupported pipeline stages", () => {
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", runOcr: true })).toThrow("말풍선 OCR 일괄 처리는 아직 지원되지 않습니다");
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", runGlossary: true })).toThrow("용어집 일괄 처리는 아직 지원되지 않습니다");
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", runInpaint: true })).toThrow("배경 인페인팅 일괄 처리는 아직 지원되지 않습니다");
    });

    it("rejects non-boolean types in boolean fields instead of silently coercing", () => {
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", runTranslate: "false" })).toThrow("runTranslate must be a boolean");
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", runTypeset: "true" })).toThrow("runTypeset must be a boolean");
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", overwriteExisting: "yes" })).toThrow("overwriteExisting must be a boolean");
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", runOcr: 1 })).toThrow("runOcr must be a boolean");
    });

    it("rejects when neither translate nor typeset is requested", () => {
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "informal", runTranslate: false, runTypeset: false })).toThrow("실행할 일괄 처리 단계가 없습니다");
    });

    it("rejects unknown speechStylePreset", () => {
      expect(() => validateBatchPipelineConfig({ speechStylePreset: "unknown_preset" })).toThrow("speechStylePreset must be one of");
    });
  });
});
