import { describe, expect, it } from "vitest";
import type { CharacterProfile, DialogueLine, DictionaryTerm } from "../../src/shared/projectTypes";
import {
  buildDialogueTranslationContext,
  formatMangaTranslationSystemPrompt,
  formatMangaTranslationUserPrompt
} from "../../src/shared/translationContext";

const mockLines: DialogueLine[] = [
  {
    id: "line-1",
    order: 1,
    pageNumber: 1,
    speaker: "루피",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "海賊王に俺はなる！",
    userTranslation: "해적왕이 내가 될 거야!",
    parseConfidence: 0.95,
    parseWarnings: []
  },
  {
    id: "line-2",
    order: 2,
    pageNumber: 1,
    speaker: "조로",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "好きにしろ。",
    aiTranslation: "마음대로 해라.",
    parseConfidence: 0.9,
    parseWarnings: []
  },
  {
    id: "line-3",
    order: 3,
    pageNumber: 1,
    speaker: "루피",
    dialogueType: "thought",
    sourceLanguage: "ja",
    sourceText: "肉が食べたいな…",
    parseConfidence: 0.88,
    parseWarnings: []
  },
  {
    id: "line-4",
    order: 4,
    pageNumber: 2,
    speaker: "나미",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "ちょっと、ルフィ！ゴムゴムの実を使わないで！",
    parseConfidence: 0.99,
    parseWarnings: []
  }
];

const mockCharacters: CharacterProfile[] = [
  {
    id: "char-1",
    name: "루피",
    aliases: ["ルフィ", "밀짚모자"],
    description: "밀짚모자 일당의 선장",
    speechStyle: "활기차고 거침없는 반말",
    relationshipNotes: "동료들을 매우 소중히 여김"
  },
  {
    id: "char-2",
    name: "나미",
    aliases: ["ナミ", "항해사"],
    speechStyle: "야무지고 똑 부러진 어조"
  }
];

const mockDictionary: DictionaryTerm[] = [
  { id: "term-1", source: "ゴムゴムの実", target: "고무고무 열매", note: "악마의 열매" },
  { id: "term-2", source: "海賊王", target: "해적왕" },
  { id: "term-3", source: "ワンピース", target: "원피스" }
];

describe("translationContext", () => {
  it("builds context with sliding window of previous turns", () => {
    const context = buildDialogueTranslationContext({
      dialogueLines: mockLines,
      targetLineId: "line-3",
      characters: mockCharacters,
      options: { contextWindowSize: 2 }
    });

    expect(context.targetLine.id).toBe("line-3");
    expect(context.previousTurns).toHaveLength(2);
    expect(context.previousTurns[0]?.speaker).toBe("루피");
    expect(context.previousTurns[0]?.resolvedTranslation).toBe("해적왕이 내가 될 거야!");
    expect(context.previousTurns[1]?.speaker).toBe("조로");
    expect(context.previousTurns[1]?.resolvedTranslation).toBe("마음대로 해라.");
  });

  it("matches speaker profile and aliases correctly", () => {
    const context = buildDialogueTranslationContext({
      dialogueLines: mockLines,
      targetLineId: "line-3",
      characters: mockCharacters
    });

    expect(context.speakerProfile).toBeDefined();
    expect(context.speakerProfile?.name).toBe("루피");
    expect(context.formattedSystemPrompt).toContain("활기차고 거침없는 반말");
    expect(context.formattedSystemPrompt).toContain("독백 / 속마음(생각)");
  });

  it("이전 용어 데이터와 includeGlossary 값이 달라도 문맥과 프롬프트는 동일하다", () => {
    const args = {
      dialogueLines: mockLines,
      targetLineId: "line-4",
      characters: mockCharacters,
      options: { contextWindowSize: 2 }
    };
    const context = buildDialogueTranslationContext(args);

    for (const includeGlossary of [true, false]) {
      for (const target of ["고무고무 열매", "이전 용어 강제 번역"]) {
        const legacyArgs = {
          ...args,
          dictionaryTerms: mockDictionary.map((term) => ({ ...term, target })),
          options: { ...args.options, includeGlossary }
        };
        expect(buildDialogueTranslationContext(legacyArgs)).toEqual(context);
      }
    }

    expect(context).not.toHaveProperty("matchedTerms");
    expect(context.speakerProfile?.name).toBe("나미");
    expect(context.formattedSystemPrompt).toContain("야무지고 똑 부러진 어조");
    expect(context.formattedUserPrompt).toContain("말투: 야무지고 똑 부러진 어조");
    expect(context.formattedUserPrompt).not.toContain("[용어집");
  });

  it("excludes previous page when includePreviousPageContext is false", () => {
    const context = buildDialogueTranslationContext({
      dialogueLines: mockLines,
      targetLineId: "line-4", // page 2
      options: { includePreviousPageContext: false }
    });

    // line-1, line-2, line-3 are on page 1, so previousTurns should be empty
    expect(context.previousTurns).toHaveLength(0);
  });

  it("formats expanded style presets correctly", () => {
    const promptHonorific = formatMangaTranslationSystemPrompt(undefined, "speech", "honorific");
    expect(promptHonorific).toContain("존댓말/경어체");

    const promptTsundere = formatMangaTranslationSystemPrompt(undefined, "speech", "tsundere");
    expect(promptTsundere).toContain("츤데레");

    const promptArchaic = formatMangaTranslationSystemPrompt(undefined, "speech", "archaic");
    expect(promptArchaic).toContain("고풍체/사극조");

    const promptDialectic = formatMangaTranslationSystemPrompt(undefined, "speech", "dialectic");
    expect(promptDialectic).toContain("사투리/방언");

    const promptCold = formatMangaTranslationSystemPrompt(undefined, "speech", "cold");
    expect(promptCold).toContain("냉철한 어조");
  });

  it("extracts lookahead next turns context when lookaheadWindowSize > 0", () => {
    const context = buildDialogueTranslationContext({
      dialogueLines: mockLines,
      targetLineId: "line-2",
      options: { lookaheadWindowSize: 1 }
    });

    expect(context.nextTurns).toHaveLength(1);
    expect(context.nextTurns[0]?.speaker).toBe("루피");
    expect(context.nextTurns[0]?.sourceText).toBe("肉が食べたいな…");
    expect(context.formattedUserPrompt).toContain("[이후 대화 맥락 (참고용)]");
  });

  it("finds fuzzy TM matches and injects them into the prompt", () => {
    const targetLine = mockLines[0]!;
    const translatedLine: DialogueLine = { ...targetLine, id: "tm-line", order: 5 };
    const context = buildDialogueTranslationContext({
      dialogueLines: [...mockLines, translatedLine],
      targetLineId: targetLine.id,
      options: { includeFuzzyTm: true }
    });

    expect(context.fuzzyTmMatches?.[0]?.entry.id).toBe("tm-line");
    expect(context.formattedUserPrompt).toContain("[유사 번역 메모리(TM) 참고]");
    expect(context.formattedUserPrompt).toContain("해적왕이 내가 될 거야!");
  });

  it("직접 프롬프트 입력의 이전 matchedTerms도 무시하고 화자 정보는 보존한다", () => {
    const args = {
      sourceText: mockLines[0]!.sourceText,
      previousTurns: [],
      nextTurns: [],
      speakerProfile: mockCharacters[0],
      dialogueType: "speech" as const
    };
    const legacyArgs = {
      ...args,
      matchedTerms: mockDictionary
    };
    const prompt = formatMangaTranslationUserPrompt(args);

    expect(formatMangaTranslationUserPrompt(legacyArgs)).toBe(prompt);
    expect(prompt).toContain("말투: 활기차고 거침없는 반말");
    expect(prompt).toContain("관계: 동료들을 매우 소중히 여김");
    expect(prompt).not.toContain("[용어집");
  });
});
