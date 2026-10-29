import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiTranslationAdapter } from "../../src/main/translation/adapters/geminiAdapter.js";
import type { TranslationContextPayload } from "../../src/shared/translationContext.js";

describe("geminiTranslationAdapter", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    }
    vi.restoreAllMocks();
  });

  const dummyPayload: TranslationContextPayload = {
    version: "1.0",
    source: {
      id: "line-1",
      order: 1,
      pageNumber: 1,
      sourceText: "こんにちは",
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

  const mockApiKeyStore = {
    getStatus: () => ({ configured: true, source: "encrypted" as const }),
    getApiKey: async () => "fake-key",
    setApiKey: async () => ({ configured: true, source: "encrypted" as const }),
    clearApiKey: async () => ({ configured: false }),
    initialize: async () => {}
  };

  it("uses default gemini-2.5-flash when no geminiModel is specified", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    let requestedUrl = "";

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      requestedUrl = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "안녕하세요" }]
                }
              }
            ]
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGeminiTranslationAdapter(mockApiKeyStore as any);
    const result = await adapter.translate(dummyPayload);

    expect(requestedUrl).toContain("models/gemini-2.5-flash:generateContent");
    expect(result.translatedText).toBe("안녕하세요");
    expect(result.engine).toBe("gemini");
  });

  it("dynamically uses gemini-2.5-pro when specified in options", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    let requestedUrl = "";

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      requestedUrl = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "안녕하세요 (고품질)" }]
                }
              }
            ]
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGeminiTranslationAdapter(mockApiKeyStore as any);
    const result = await adapter.translate(dummyPayload, { geminiModel: "gemini-2.5-pro" });

    expect(requestedUrl).toContain("models/gemini-2.5-pro:generateContent");
    expect(result.translatedText).toBe("안녕하세요 (고품질)");
  });
});
