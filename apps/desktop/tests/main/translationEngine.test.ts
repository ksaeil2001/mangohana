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
      matchedGlossary: [],
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

  it("calls the requested adapter and attaches Glossarion QA inspection report", async () => {
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
});
