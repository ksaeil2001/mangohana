import type {
  CharacterProfile,
  DialogueLine,
  DialogueType,
  DictionaryTerm
} from "./projectTypes.js";
import { type ScoredTurnContext, selectRelevantDialogueContext } from "./translation/contextSelector.js";
import { type FuzzyTmCandidate, createTranslationMemory } from "./translation/translationMemory.js";
import { type ConditionalDictionaryTerm, createTrieMatcher } from "./translation/trieMatcher.js";

export * from "./translation/trieMatcher.js";
export * from "./translation/fuzzyMatcher.js";
export * from "./translation/translationMemory.js";
export * from "./translation/contextSelector.js";
export * from "./translation/translationQa.js";
export * from "./translation/translationPayload.js";

export const mangaSpeechStylePresets = [
  "literal",
  "action",
  "romance",
  "honorific",
  "informal",
  "tsundere",
  "archaic",
  "dialectic",
  "cold"
] as const;

export type MangaSpeechStylePreset = (typeof mangaSpeechStylePresets)[number];

export const mangaSpeechStylePresetLabels: Record<MangaSpeechStylePreset, string> = {
  literal: "직역 (원문 충실)",
  action: "액션 / 배틀",
  romance: "로맨스 / 순정",
  honorific: "존댓말 / 경어",
  informal: "반말 / 일상",
  tsundere: "츤데레",
  archaic: "고풍체 / 사극",
  dialectic: "사투리 / 방언",
  cold: "냉철 / 쿨데레"
};

export type ContextWindowOptions = {
  contextWindowSize?: number;
  lookaheadWindowSize?: number;
  includePreviousPageContext?: boolean;
  includeNextPageContext?: boolean;
  includeCharacterNotes?: boolean;
  includeGlossary?: boolean;
  includeFuzzyTm?: boolean;
  recentHistory?: readonly DialogueTurnContext[];
  stylePreset?: string;
};

export type DialogueTurnContext = {
  order: number;
  pageNumber: number;
  speaker?: string;
  sourceText: string;
  resolvedTranslation?: string;
  dialogueType: DialogueType;
  direction?: "previous" | "next";
};

export type DialogueTranslationContext = {
  targetLine: DialogueLine;
  speakerProfile?: CharacterProfile;
  previousTurns: DialogueTurnContext[];
  nextTurns: DialogueTurnContext[];
  recentHistory?: DialogueTurnContext[];
  matchedTerms: DictionaryTerm[];
  fuzzyTmMatches?: FuzzyTmCandidate[];
  formattedSystemPrompt: string;
  formattedUserPrompt: string;
};

export type BuildTranslationContextArgs = {
  dialogueLines: readonly DialogueLine[];
  targetLineId: string;
  characters?: readonly CharacterProfile[];
  dictionaryTerms?: readonly (DictionaryTerm | ConditionalDictionaryTerm)[];
  options?: ContextWindowOptions;
  customSystemPrompt?: string;
};

const DEFAULT_CONTEXT_WINDOW_SIZE = 5;

export function buildDialogueTranslationContext(
  args: BuildTranslationContextArgs
): DialogueTranslationContext {
  const {
    dialogueLines,
    targetLineId,
    characters = [],
    dictionaryTerms = [],
    options = {},
    customSystemPrompt
  } = args;

  const sortedLines = [...dialogueLines].sort((a, b) =>
    a.pageNumber !== b.pageNumber ? a.pageNumber - b.pageNumber : a.order - b.order
  );

  const targetIndex = sortedLines.findIndex((line) => line.id === targetLineId);
  if (targetIndex === -1) {
    throw new Error(`Target dialogue line with id "${targetLineId}" not found`);
  }

  const targetLine = sortedLines[targetIndex]!;

  const windowSize = options.contextWindowSize ?? DEFAULT_CONTEXT_WINDOW_SIZE;
  const lookaheadSize = options.lookaheadWindowSize ?? 2;
  const includePrevPage = options.includePreviousPageContext ?? true;
  const includeNextPage = options.includeNextPageContext ?? false;
  const includeCharNotes = options.includeCharacterNotes ?? true;
  const includeGlossary = options.includeGlossary ?? true;
  const includeFuzzyTm = options.includeFuzzyTm ?? true;

  // 1. Sliding window & Relevance: Select previous N lines
  const previousTurns: DialogueTurnContext[] = [];
  if (windowSize > 0) {
    for (let i = targetIndex - 1; i >= 0 && previousTurns.length < windowSize; i -= 1) {
      const prev = sortedLines[i]!;
      if (!includePrevPage && prev.pageNumber !== targetLine.pageNumber) {
        break;
      }

      const resolved =
        prev.userTranslation?.trim() ||
        prev.aiTranslation?.trim() ||
        prev.referenceTranslation?.trim() ||
        undefined;

      previousTurns.unshift({
        order: prev.order,
        pageNumber: prev.pageNumber,
        speaker: prev.speaker?.trim() || undefined,
        sourceText: prev.sourceText,
        resolvedTranslation: resolved,
        dialogueType: prev.dialogueType,
        direction: "previous"
      });
    }
  }

  // 2. Lookahead window: Select next M lines
  const nextTurns: DialogueTurnContext[] = [];
  if (lookaheadSize > 0) {
    for (let i = targetIndex + 1; i < sortedLines.length && nextTurns.length < lookaheadSize; i += 1) {
      const next = sortedLines[i]!;
      if (!includeNextPage && next.pageNumber !== targetLine.pageNumber) {
        break;
      }

      const resolved =
        next.userTranslation?.trim() ||
        next.aiTranslation?.trim() ||
        next.referenceTranslation?.trim() ||
        undefined;

      nextTurns.push({
        order: next.order,
        pageNumber: next.pageNumber,
        speaker: next.speaker?.trim() || undefined,
        sourceText: next.sourceText,
        resolvedTranslation: resolved,
        dialogueType: next.dialogueType,
        direction: "next"
      });
    }
  }

  // 3. Speaker profile lookup
  let speakerProfile: CharacterProfile | undefined;
  if (includeCharNotes && targetLine.speaker?.trim()) {
    const rawSpeaker = targetLine.speaker.trim();
    const speakerNormalized = rawSpeaker.toLowerCase();
    const speakerTokens = extractSearchTokens(rawSpeaker);

    speakerProfile = characters.find((c) => {
      const cNameNorm = c.name.trim().toLowerCase();
      if (cNameNorm === speakerNormalized || speakerTokens.includes(cNameNorm)) return true;
      const cAliasesNorm = c.aliases.map((a) => a.trim().toLowerCase());
      return (
        cAliasesNorm.includes(speakerNormalized) ||
        speakerTokens.some((token) => cAliasesNorm.includes(token))
      );
    });
  }

  // 4. Dynamic & Conditional glossary matching (Trie-based)
  const matchedTerms: DictionaryTerm[] = [];
  if (includeGlossary && dictionaryTerms.length > 0) {
    const trie = createTrieMatcher(dictionaryTerms);
    const textPool = [
      targetLine.sourceText,
      ...previousTurns.map((t) => t.sourceText),
      ...nextTurns.map((t) => t.sourceText)
    ].join(" ");

    // First check with Trie matcher (condition-aware)
    const trieMatches = trie.findMatches(textPool, {
      speaker: targetLine.speaker,
      dialogueType: targetLine.dialogueType
    });

    const seenSources = new Set<string>();
    for (const match of trieMatches) {
      matchedTerms.push(match);
      seenSources.add(match.source.trim().normalize("NFKC").toLowerCase());
    }

    // Secondary fallback token matching for complex patterns (e.g. bracketed readings)
    const normalizedPool = textPool.normalize("NFKC").toLowerCase();
    for (const term of dictionaryTerms) {
      if (term.condition) continue;
      const termSource = term.source.trim().normalize("NFKC").toLowerCase();
      if (!termSource || seenSources.has(termSource)) continue;

      const candidateTokens = extractSearchTokens(termSource);
      const isMatched =
        normalizedPool.includes(termSource) ||
        candidateTokens.some((token) => token.length >= 2 && normalizedPool.includes(token));

      if (isMatched) {
        matchedTerms.push(term);
        seenSources.add(termSource);
      }
    }
  }

  // 5. Supervertaler: Fuzzy Translation Memory Search
  let fuzzyTmMatches: FuzzyTmCandidate[] | undefined;
  if (includeFuzzyTm) {
    const tm = createTranslationMemory(dialogueLines);
    fuzzyTmMatches = tm.findFuzzy(targetLine.sourceText, {
      excludeLineId: targetLine.id,
      minSimilarity: 0.7,
      maxCandidates: 2,
      filterSpeaker: targetLine.speaker
    });
  }

  // 6. Prompt formatting
  const formattedSystemPrompt =
    customSystemPrompt?.trim() ||
    formatMangaTranslationSystemPrompt(speakerProfile, targetLine.dialogueType, options.stylePreset);

  const formattedUserPrompt = formatMangaTranslationUserPrompt({
    sourceText: targetLine.sourceText,
    previousTurns,
    nextTurns,
    matchedTerms,
    fuzzyTmMatches,
    speakerProfile,
    dialogueType: targetLine.dialogueType
  });

  return {
    targetLine,
    speakerProfile,
    previousTurns,
    nextTurns,
    recentHistory: options.recentHistory ? [...options.recentHistory] : undefined,
    matchedTerms,
    fuzzyTmMatches,
    formattedSystemPrompt,
    formattedUserPrompt
  };
}

export function formatMangaTranslationSystemPrompt(
  speakerProfile?: CharacterProfile,
  dialogueType: DialogueType = "speech",
  stylePreset?: string
): string {
  const parts: string[] = [
    "당신은 일본어/영어 만화, 웹툰, 라노벨 대사를 자연스럽고 생동감 넘치는 한국어로 번역하는 전문 만화 번역가입니다.",
    "대사의 감정선, 뉘앙스, 문맥적 호칭, 어조(존댓말/반말)를 완벽하게 살려 번역하십시오.",
    "출력 규칙: 부연 설명, 해설, 따옴표, 마크다운 코드블록 없이 번역된 한국어 대사 문장만 단독으로 출력하십시오."
  ];

  if (stylePreset === "literal") {
    parts.push("※ 번역 문체 스타일: 원문에 충실한 직역 위주로 번역하십시오.");
  } else if (stylePreset === "action") {
    parts.push("※ 번역 문체 스타일: 박진감 넘치고 긴박한 액션 만화 어조로 번역하십시오.");
  } else if (stylePreset === "romance") {
    parts.push("※ 번역 문체 스타일: 감정이 풍부하고 부드러운 로맨스 구어체로 번역하십시오.");
  } else if (stylePreset === "honorific") {
    parts.push("※ 번역 문체 스타일: 정중하고 공손한 존댓말/경어체로 번역하십시오.");
  } else if (stylePreset === "informal") {
    parts.push("※ 번역 문체 스타일: 자연스럽고 편안한 반말/일상 구어체로 번역하십시오.");
  } else if (stylePreset === "tsundere") {
    parts.push("※ 번역 문체 스타일: 겉으로는 퉁명스럽고 새침하지만 속정이 묻어나는 츤데레 어조로 번역하십시오.");
  } else if (stylePreset === "archaic") {
    parts.push("※ 번역 문체 스타일: 위엄 있고 고전적인 고풍체/사극조 어투로 번역하십시오.");
  } else if (stylePreset === "dialectic") {
    parts.push("※ 번역 문체 스타일: 토속적이고 개성 있는 사투리/방언 어조로 번역하십시오.");
  } else if (stylePreset === "cold") {
    parts.push("※ 번역 문체 스타일: 감정을 극도로 배제한 차갑고 냉철한 어조로 번역하십시오.");
  }

  if (dialogueType === "thought") {
    parts.push("※ 이 대사는 [독백 / 속마음(생각)]입니다. 차분하거나 내면적인 어조를 살려 번역하십시오.");
  } else if (dialogueType === "narration") {
    parts.push("※ 이 대사는 [내레이션 / 설명문]입니다. 상황을 서술하는 정돈된 문체로 번역하십시오.");
  }

  if (speakerProfile?.speechStyle?.trim()) {
    parts.push(`※ 현재 화자 말투/어조 규칙: ${speakerProfile.speechStyle.trim()}`);
  }

  return parts.join("\n");
}

export function formatMangaTranslationUserPrompt(args: {
  sourceText: string;
  previousTurns: DialogueTurnContext[];
  nextTurns?: DialogueTurnContext[];
  matchedTerms: DictionaryTerm[];
  fuzzyTmMatches?: FuzzyTmCandidate[];
  speakerProfile?: CharacterProfile;
  dialogueType: DialogueType;
}): string {
  const sections: string[] = [];

  // Character Profile Section
  if (args.speakerProfile) {
    const profileLines = [`이름: ${args.speakerProfile.name}`];
    if (args.speakerProfile.aliases.length > 0) {
      profileLines.push(`별칭: ${args.speakerProfile.aliases.join(", ")}`);
    }
    if (args.speakerProfile.description?.trim()) {
      profileLines.push(`설정: ${args.speakerProfile.description.trim()}`);
    }
    if (args.speakerProfile.speechStyle?.trim()) {
      profileLines.push(`말투: ${args.speakerProfile.speechStyle.trim()}`);
    }
    if (args.speakerProfile.relationshipNotes?.trim()) {
      profileLines.push(`관계: ${args.speakerProfile.relationshipNotes.trim()}`);
    }
    sections.push(`[현재 화자 정보]\n${profileLines.join("\n")}`);
  }

  // Glossary Section
  if (args.matchedTerms.length > 0) {
    const termLines = args.matchedTerms.map(
      (term) => `- ${term.source} -> ${term.target}${term.note ? ` (${term.note})` : ""}`
    );
    sections.push(`[용어집 및 고유명사 규칙]\n${termLines.join("\n")}`);
  }

  // Translation Memory (Few-shot fuzzy TM references)
  if (args.fuzzyTmMatches && args.fuzzyTmMatches.length > 0) {
    const tmLines = args.fuzzyTmMatches.map(
      (m) =>
        `- 원문: "${m.entry.sourceText}" -> 번역: "${m.entry.targetTranslation}" (${Math.round(m.similarity * 100)}% 유사)`
    );
    sections.push(`[유사 번역 메모리(TM) 참고]\n${tmLines.join("\n")}`);
  }

  // Previous Turns Context Section
  if (args.previousTurns.length > 0) {
    const turnLines = args.previousTurns.map((turn) => {
      const speakerTag = turn.speaker ? `[${turn.speaker}] ` : "";
      const trans = turn.resolvedTranslation
        ? ` -> ${turn.resolvedTranslation}`
        : "";
      return `(p.${turn.pageNumber} #${turn.order}) ${speakerTag}${turn.sourceText}${trans}`;
    });
    sections.push(`[이전 대화 맥락]\n${turnLines.join("\n")}`);
  }

  // Next Turns (Lookahead Context) Section
  if (args.nextTurns && args.nextTurns.length > 0) {
    const nextLines = args.nextTurns.map((turn) => {
      const speakerTag = turn.speaker ? `[${turn.speaker}] ` : "";
      const trans = turn.resolvedTranslation
        ? ` -> ${turn.resolvedTranslation}`
        : "";
      return `(p.${turn.pageNumber} #${turn.order}) ${speakerTag}${turn.sourceText}${trans}`;
    });
    sections.push(`[이후 대화 맥락 (참고용)]\n${nextLines.join("\n")}`);
  }

  // Target Source Text Section
  sections.push(`[번역할 원문 대사]\n${args.sourceText}`);

  return sections.join("\n\n");
}

export function extractSearchTokens(raw: string): string[] {
  if (!raw) return [];
  const normalized = raw.trim().normalize("NFKC").toLowerCase();
  const tokens = new Set<string>();

  // 1. Remove brackets/parentheses and extract inner content & outer content
  const bracketMatch = normalized.match(/^([^()（）[\]『』「」]+)[()（）[\]『』「」]([^()（）[\]『』「」]+)[()（）[\]『』「」]?$/);
  if (bracketMatch) {
    const outer = bracketMatch[1]?.trim();
    const inner = bracketMatch[2]?.trim();
    if (outer && outer.length >= 1) tokens.add(outer);
    if (inner && inner.length >= 1) tokens.add(inner);
  }

  // 2. Remove leading/trailing tildes, wave dashes (~, 〜, ～)
  const strippedTilde = normalized.replace(/^[~〜～]+|[~〜～]+$/g, "").trim();
  if (strippedTilde && strippedTilde.length >= 1) {
    tokens.add(strippedTilde);
  }

  // 3. Split by slash or middle dot (/, ・)
  const slashParts = normalized.split(/[/／・]/).map((p) => p.trim()).filter(Boolean);
  for (const part of slashParts) {
    if (part.length >= 1) tokens.add(part);
  }

  return Array.from(tokens);
}
