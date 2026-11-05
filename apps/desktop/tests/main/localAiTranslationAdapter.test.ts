import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAiTranslationAdapter } from "../../src/main/translation/adapters/localAiAdapter.js";
import { buildTranslationContextPayload } from "../../src/shared/translationContext.js";
import type { DialogueLine } from "../../src/shared/projectTypes.js";

describe("localAiTranslationAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("이전 용어 데이터가 로컬 AI 요청을 바꾸지 않고 말투와 이웃 문맥 및 TM을 유지한다", async () => {
    const requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
      requests.push(JSON.parse(options.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: "선배, 감사합니다." } }] }), { status: 200 });
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
    const adapter = createLocalAiTranslationAdapter();
    const options = { localAiRuntime: "custom" as const, localAiEndpoint: "http://local-ai.invalid", localAiModel: "fake-model" };
    const result = await adapter.translate(payload, options);

    for (const target of ["선배님", "이전 용어 강제 번역"]) {
      const legacyPayload = {
        ...payload,
        entities: { ...payload.entities, matchedGlossary: [{ source: "先輩", target, note: "이전 용어 메모" }] }
      };
      expect(await adapter.translate(legacyPayload, options)).toEqual(result);
      expect(requests.at(-1)).toEqual(requests[0]);
    }

    expect(result).toEqual({ translatedText: "선배, 감사합니다.", engine: "local_ai" });
    expect(requests[0]!.model).toBe("fake-model");
    expect(requests[0]!.messages[0]!.content).toContain("정중한 존댓말");
    const userPrompt = requests[0]!.messages[1]!.content;
    expect(userPrompt).toContain("말투: 정중한 존댓말");
    expect(userPrompt).toContain("[이전 대화 맥락]");
    expect(userPrompt).toContain("[이후 대화 맥락 (참고용)]");
    expect(userPrompt).toContain("また明日。");
    expect(userPrompt).toContain("[유사 번역 메모리(TM) 참고]");
    expect(userPrompt).not.toContain("[용어집");
  });
});
