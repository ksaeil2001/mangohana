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
      dictionaryTerms: mockDictionary,
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

  it("filters dynamic glossary terms present in target or context", () => {
    const context = buildDialogueTranslationContext({
      dialogueLines: mockLines,
      targetLineId: "line-4",
      characters: mockCharacters,
      dictionaryTerms: mockDictionary
    });

    // line-4 contains 'ゴムゴムの実', and context contains '海賊王'
    const matchedSources = context.matchedTerms.map((t) => t.source);
    expect(matchedSources).toContain("ゴムゴムの実");
    // 'ワンピース' is not in target or context
    expect(matchedSources).not.toContain("ワンピース");
    expect(context.formattedUserPrompt).toContain("고무고무 열매");
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

  it("matches glossary terms with NFKC normalization and case-insensitivity", () => {
    const linesWithFullwidth: DialogueLine[] = [
      {
        id: "line-fw",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "ここは ＤＥＭＯＮ ＫＩＮＧ の城다！ ｶﾀｶﾅ もある。",
        parseConfidence: 0.95,
        parseWarnings: []
      }
    ];

    const terms: DictionaryTerm[] = [
      { id: "term-1", source: "Demon King", target: "마왕" },
      { id: "term-2", source: "カタカナ", target: "카타카나" }
    ];

    const context = buildDialogueTranslationContext({
      dialogueLines: linesWithFullwidth,
      targetLineId: "line-fw",
      dictionaryTerms: terms
    });

    expect(context.matchedTerms).toHaveLength(2);
    expect(context.matchedTerms.map((t) => t.target)).toEqual(["마왕", "카타카나"]);
  });

  it("matches glossary terms with bracketed readings and tildes accurately", () => {
    const lines: DialogueLine[] = [
      {
        id: "line-reading",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "くらえ！月華一閃！そうじゃのう。",
        parseConfidence: 0.95,
        parseWarnings: []
      }
    ];

    const terms: DictionaryTerm[] = [
      { id: "term-1", source: "月華一閃 (げっかいっせん)", target: "월화일섬" },
      { id: "term-2", source: "〜じゃのう", target: "~인 게지" }
    ];

    const context = buildDialogueTranslationContext({
      dialogueLines: lines,
      targetLineId: "line-reading",
      dictionaryTerms: terms
    });

    expect(context.matchedTerms).toHaveLength(2);
    expect(context.matchedTerms.map((t) => t.target)).toEqual(["월화일섬", "~인 게지"]);
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
    const context = buildDialogueTranslationContext({
      dialogueLines: mockLines,
      targetLineId: "line-3",
      options: { includeFuzzyTm: true }
    });

    expect(context.fuzzyTmMatches).toBeDefined();
  });

  it("applies speaker conditional dictionary terms", () => {
    const conditionalTerms = [
      { id: "term-c1", source: "先輩", target: "선배" },
      { id: "term-c2", source: "先輩", target: "선배님", condition: { speaker: "나미" }, priority: 20 }
    ];

    const lines: DialogueLine[] = [
      {
        id: "line-nami",
        order: 1,
        pageNumber: 1,
        speaker: "나미",
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "先輩、助けて！",
        parseConfidence: 0.9,
        parseWarnings: []
      }
    ];

    const context = buildDialogueTranslationContext({
      dialogueLines: lines,
      targetLineId: "line-nami",
      dictionaryTerms: conditionalTerms
    });

    expect(context.matchedTerms).toHaveLength(1);
    expect(context.matchedTerms[0]?.target).toBe("선배님");
  });

  it("matches saved dialogueType and targetContext glossary conditions", () => {
    const conditionalTerms = [
      {
        id: "term-thought",
        source: "お前",
        target: "당신",
        condition: { dialogueType: "thought" as const },
        priority: 15
      },
      {
        id: "term-context",
        source: "月華",
        target: "달빛",
        condition: { targetContext: "一閃" },
        priority: 10
      }
    ];
    const thoughtLine: DialogueLine = {
      id: "line-thought",
      order: 1,
      pageNumber: 1,
      speaker: "주인공",
      dialogueType: "thought",
      sourceLanguage: "ja",
      sourceText: "お前は何者だ？ 月華一閃。",
      parseConfidence: 0.9,
      parseWarnings: []
    };
    const speechLine: DialogueLine = {
      ...thoughtLine,
      id: "line-speech",
      dialogueType: "speech"
    };

    const thoughtContext = buildDialogueTranslationContext({
      dialogueLines: [thoughtLine],
      targetLineId: "line-thought",
      dictionaryTerms: conditionalTerms
    });
    expect(thoughtContext.matchedTerms.map((term) => term.target)).toEqual(
      expect.arrayContaining(["당신", "달빛"])
    );

    const speechContext = buildDialogueTranslationContext({
      dialogueLines: [speechLine],
      targetLineId: "line-speech",
      dictionaryTerms: conditionalTerms
    });
    expect(speechContext.matchedTerms.map((term) => term.target)).not.toContain("당신");
    expect(speechContext.matchedTerms.map((term) => term.target)).toContain("달빛");
  });
});
