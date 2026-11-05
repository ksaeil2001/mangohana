import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiTranslationAdapter } from "../../src/main/translation/adapters/geminiAdapter.js";
import { buildTranslationContextPayload, type TranslationContextPayload } from "../../src/shared/translationContext.js";
import type { DialogueLine } from "../../src/shared/projectTypes.js";

describe("geminiTranslationAdapter", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("이전 용어 데이터가 Gemini 요청을 바꾸지 않고 말투와 이웃 문맥 및 TM을 유지한다", async () => {
    process.env.GEMINI_API_KEY = "fake-gemini-key";
    const requests: Array<{
      system_instruction: { parts: Array<{ text: string }> };
      contents: Array<{ parts: Array<{ text: string }> }>;
    }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
      requests.push(JSON.parse(options.body as string));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "선배, 감사합니다." }] } }] }), { status: 200 });
    }));

    const line: DialogueLine = {
      id: "target", order: 2, pageNumber: 1, speaker: "Hero", sourceText: "先輩、ありがとう",
      sourceLanguage: "ja", dialogueType: "speech", parseConfidence: 1, parseWarnings: []
    };
    const payload = buildTranslationContextPayload({
      dialogueLines: [
        { ...line, id: "previous", order: 1, userTranslation: "선배, 고마워" },
        line,
        { ...line, id: "next", order: 3, sourceText: "また明日。" }
      ],
      targetLineId: line.id,
      characters: [{ id: "hero", name: "Hero", aliases: [], speechStyle: "정중한 존댓말" }],
      stylePreset: "honorific"
    });
    const adapter = createGeminiTranslationAdapter(mockApiKeyStore as any);
    await adapter.translate(payload);

    for (const target of ["선배님", "이전 용어 강제 번역"]) {
      const legacyPayload = {
        ...payload,
        entities: { ...payload.entities, matchedGlossary: [{ source: "先輩", target, note: "이전 용어 메모" }] }
      };
      expect((await adapter.translate(legacyPayload)).translatedText).toBe("선배, 감사합니다.");
      expect(requests.at(-1)).toEqual(requests[0]);
    }

    const systemPrompt = requests[0]!.system_instruction.parts[0]!.text;
    const userPrompt = requests[0]!.contents[0]!.parts[0]!.text;
    expect(systemPrompt).toContain("정중한 존댓말");
    expect(userPrompt).toContain("말투: 정중한 존댓말");
    expect(userPrompt).toContain("[이전 대화 맥락]");
    expect(userPrompt).toContain("[이후 대화 맥락 (참고용)]");
    expect(userPrompt).toContain("また明日。");
    expect(userPrompt).toContain("[유사 번역 메모리(TM) 참고]");
    expect(userPrompt).not.toContain("[용어집");
  });
});
