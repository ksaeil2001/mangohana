import { describe, expect, it, vi } from "vitest";
import type { TranslationContextPayload } from "../../src/shared/translationContext";
import {
  createTranslationEngineRegistry,
  type TranslationEngineAdapter
} from "../../src/main/translation/translationEngineRegistry";

describe("translationEngineRegistry", () => {
  const dummyPayload: TranslationContextPayload = {
    version: "1.0",
    source: {
      id: "l1",
      order: 1,
      pageNumber: 1,
      sourceText: "海賊王に俺はなる！",
      sourceLanguage: "ja",
      dialogueType: "speech"
    },
    contextWindow: {
      previousTurns: [],
      nextTurns: [],
      recentHistory: []
    },
    entities: {
      fuzzyTmMatches: []
    },
    constraints: {
      formattingRules: {
        stripQuotes: true,
        keepToneConsistent: true
      }
    }
  };

  it("intercepts and returns 100% exact TM matches without calling adapter", async () => {
    const mockAdapter: TranslationEngineAdapter = {
      type: "local_ai",
      displayName: "Mock Local AI",
      isAvailable: async () => true,
      translate: vi.fn()
    };

    const registry = createTranslationEngineRegistry([mockAdapter]);

    const payloadWithExactTm: TranslationContextPayload = {
      ...dummyPayload,
      entities: {
        ...dummyPayload.entities,
        fuzzyTmMatches: [
          {
            sourceText: "海賊王に俺はなる！",
            targetTranslation: "해적왕이 내가 될 거야!",
            similarity: 1.0
          }
        ]
      }
    };

    const result = await registry.executeTranslation(payloadWithExactTm);

    expect(result.usedExactTm).toBe(true);
    expect(result.engine).toBe("tm_direct");
    expect(result.translatedText).toBe("해적왕이 내가 될 거야!");
    expect(mockAdapter.translate).not.toHaveBeenCalled();
  });

  it("calls the requested adapter and attaches QA inspection report", async () => {
    const mockAdapter: TranslationEngineAdapter = {
      type: "local_ai",
      displayName: "Mock Local AI",
      isAvailable: async () => true,
      translate: vi.fn().mockResolvedValue({
        translatedText: "해적왕이 내가 될 거다!",
        engine: "local_ai"
      })
    };

    const registry = createTranslationEngineRegistry([mockAdapter]);
    const result = await registry.executeTranslation(dummyPayload, { engineType: "local_ai" });

    expect(result.translatedText).toBe("해적왕이 내가 될 거다!");
    expect(result.engine).toBe("local_ai");
    expect(result.qaReport).toBeDefined();
    expect(result.qaReport?.passed).toBe(true);
  });

  it.each([false, true])("이전 matchedGlossary가 달라도 QA는 같고 말투를 검사한다 (exact TM: %s)", async (useExactTm) => {
    const translatedText = "내가 왕이 될 거다!";
    const mockAdapter: TranslationEngineAdapter = {
      type: "local_ai",
      displayName: "Mock Local AI",
      isAvailable: async () => true,
      translate: vi.fn().mockImplementation(async () => ({ translatedText, engine: "local_ai" }))
    };
    const registry = createTranslationEngineRegistry([mockAdapter]);
    const payload: TranslationContextPayload = {
      ...dummyPayload,
      entities: {
        speakerProfile: { id: "hero", name: "주인공", aliases: [], speechStyle: "정중한 존댓말" },
        fuzzyTmMatches: useExactTm
          ? [{ sourceText: dummyPayload.source.sourceText, targetTranslation: translatedText, similarity: 1 }]
          : []
      }
    };
    const result = await registry.executeTranslation(payload);

    for (const target of ["해적왕", "이전 용어 강제 번역"]) {
      const legacyPayload = {
        ...payload,
        entities: { ...payload.entities, matchedGlossary: [{ source: "海賊王", target }] }
      };
      expect(await registry.executeTranslation(legacyPayload)).toEqual(result);
    }

    expect(result.qaReport?.issues.map((issue) => issue.type)).toEqual(["SPEECH_STYLE_MISMATCH"]);
    expect(result.qaReport?.score).toBe(95);
    expect(result.engine).toBe(useExactTm ? "tm_direct" : "local_ai");
    expect(mockAdapter.translate).toHaveBeenCalledTimes(useExactTm ? 0 : 3);
  });
});
