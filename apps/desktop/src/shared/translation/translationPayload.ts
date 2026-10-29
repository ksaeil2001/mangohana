import type {
  CharacterProfile,
  DialogueLine,
  DialogueType,
  DictionaryTerm,
  SourceLanguage
} from "../projectTypes.js";
import { type ScoredTurnContext, selectRelevantDialogueContext } from "./contextSelector.js";
import { type FuzzyTmCandidate, createTranslationMemory } from "./translationMemory.js";
import { type ConditionalDictionaryTerm, createTrieMatcher } from "./trieMatcher.js";

export type TranslationSourceItem = {
  id: string;
  order: number;
  pageNumber: number;
  sourceText: string;
  sourceLanguage: SourceLanguage;
  speaker?: string;
  dialogueType: DialogueType;
};

export type ContextTurnItem = {
  order: number;
  pageNumber: number;
  speaker?: string;
  sourceText: string;
  resolvedTranslation?: string;
  dialogueType: DialogueType;
  direction?: "previous" | "next";
};

export type MatchedGlossaryEntry = {
  source: string;
  target: string;
  note?: string;
  isConditional?: boolean;
};

export type TranslationContextPayload = {
  version: "1.0";
  source: TranslationSourceItem;
  contextWindow: {
    previousTurns: ContextTurnItem[];
    nextTurns: ContextTurnItem[];
    recentHistory: ContextTurnItem[];
  };
  entities: {
    speakerProfile?: CharacterProfile;
    matchedGlossary: MatchedGlossaryEntry[];
    fuzzyTmMatches: Array<{
      sourceText: string;
      targetTranslation: string;
      similarity: number;
      speaker?: string;
    }>;
  };
  constraints: {
    stylePreset?: string;
    speechStyleRules?: string;
    formattingRules: {
      stripQuotes: boolean;
      keepToneConsistent: boolean;
    };
  };
};

export type BuildPayloadArgs = {
  dialogueLines: readonly DialogueLine[];
  targetLineId: string;
  characters?: readonly CharacterProfile[];
  dictionaryTerms?: readonly (DictionaryTerm | ConditionalDictionaryTerm)[];
  recentHistory?: readonly ContextTurnItem[];
  stylePreset?: string;
  maxPreviousTurns?: number;
  maxNextTurns?: number;
  tokenBudget?: number;
};

/**
 * Builds a structured, engine-agnostic TranslationContextPayload according to XUnity LLM architecture.
 */
export function buildTranslationContextPayload(args: BuildPayloadArgs): TranslationContextPayload {
  const {
    dialogueLines,
    targetLineId,
    characters = [],
    dictionaryTerms = [],
    recentHistory = [],
    stylePreset,
    maxPreviousTurns = 4,
    maxNextTurns = 2,
    tokenBudget = 600
  } = args;

  const targetLine = dialogueLines.find((l) => l.id === targetLineId);
  if (!targetLine) {
    throw new Error(`Target dialogue line with id "${targetLineId}" not found`);
  }

  // 1. CarrotMangaTranslator & context_translate: Select relevant bidirectional context
  const selectedContext = selectRelevantDialogueContext(dialogueLines, targetLineId, {
    maxPreviousTurns,
    maxNextTurns,
    tokenBudget
  });

  const previousTurns: ContextTurnItem[] = selectedContext.previousTurns.map((t) => ({
    order: t.order,
    pageNumber: t.pageNumber,
    speaker: t.speaker,
    sourceText: t.sourceText,
    resolvedTranslation: t.resolvedTranslation,
    dialogueType: t.dialogueType,
    direction: "previous"
  }));

  const nextTurns: ContextTurnItem[] = selectedContext.nextTurns.map((t) => ({
    order: t.order,
    pageNumber: t.pageNumber,
    speaker: t.speaker,
    sourceText: t.sourceText,
    resolvedTranslation: t.resolvedTranslation,
    dialogueType: t.dialogueType,
    direction: "next"
  }));

  // 2. Speaker profile lookup
  let speakerProfile: CharacterProfile | undefined;
  if (targetLine.speaker?.trim()) {
    const rawSpeaker = targetLine.speaker.trim().toLowerCase();
    speakerProfile = characters.find((c) => {
      if (c.name.trim().toLowerCase() === rawSpeaker) return true;
      return c.aliases.some((a) => a.trim().toLowerCase() === rawSpeaker);
    });
  }

  // 3. GalTransl: Trie-based conditional glossary matching
  const trie = createTrieMatcher(dictionaryTerms);
  const textPool = [
    targetLine.sourceText,
    ...previousTurns.map((t) => t.sourceText),
    ...nextTurns.map((t) => t.sourceText)
  ].join(" ");

  const matchedTerms = trie.findMatches(textPool, {
    speaker: targetLine.speaker,
    dialogueType: targetLine.dialogueType
  });

  const matchedGlossary: MatchedGlossaryEntry[] = matchedTerms.map((t) => ({
    source: t.source,
    target: t.target,
    note: t.note,
    isConditional: Boolean(t.condition?.speaker || t.condition?.dialogueType)
  }));

  // 4. Supervertaler: Fuzzy Translation Memory search
  const tm = createTranslationMemory(dialogueLines);
  const fuzzyCandidates = tm.findFuzzy(targetLine.sourceText, {
    excludeLineId: targetLine.id,
    minSimilarity: 0.7,
    maxCandidates: 2,
    filterSpeaker: targetLine.speaker
  });

  const fuzzyTmMatches = fuzzyCandidates.map((c) => ({
    sourceText: c.entry.sourceText,
    targetTranslation: c.entry.targetTranslation,
    similarity: c.similarity,
    speaker: c.entry.speaker
  }));

  // 5. Assemble Payload
  return {
    version: "1.0",
    source: {
      id: targetLine.id,
      order: targetLine.order,
      pageNumber: targetLine.pageNumber,
      sourceText: targetLine.sourceText,
      sourceLanguage: targetLine.sourceLanguage,
      speaker: targetLine.speaker?.trim() || undefined,
      dialogueType: targetLine.dialogueType
    },
    contextWindow: {
      previousTurns,
      nextTurns,
      recentHistory: recentHistory.slice(-5)
    },
    entities: {
      speakerProfile,
      matchedGlossary,
      fuzzyTmMatches
    },
    constraints: {
      stylePreset,
      speechStyleRules: speakerProfile?.speechStyle?.trim() || undefined,
      formattingRules: {
        stripQuotes: true,
        keepToneConsistent: true
      }
    }
  };
}

export function computeTranslationContextFingerprint(args: BuildPayloadArgs): string {
  const targetLine = args.dialogueLines.find((l) => l.id === args.targetLineId);
  if (!targetLine) {
    return "";
  }

  return computeTranslationPayloadFingerprint(buildTranslationContextPayload(args));
}

export function computeTranslationPayloadFingerprint(payload: TranslationContextPayload): string {
  return stableFingerprint(payload);
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(canonicalizeFingerprintValue(value));
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeFingerprintValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry !== undefined) {
      canonical[key] = canonicalizeFingerprintValue(entry);
    }
  }
  return canonical;
}

export function computeTypesettingContextFingerprint(line: DialogueLine): string {
  return JSON.stringify({
    text: line.userTranslation?.trim() || line.aiTranslation?.trim() || "",
    bbox: line.typesetting?.bbox ?? null,
    polygon: line.polygon ?? null,
    shape: line.typesetting?.shape ?? null,
    writingMode: line.typesetting?.writingMode ?? null,
    fontFamily: line.typesetting?.fontFamily ?? null,
    color: line.typesetting?.color ?? null,
    strokeColor: line.typesetting?.strokeColor ?? null,
    strokeWidth: line.typesetting?.strokeWidth ?? null,
    align: line.typesetting?.align ?? null,
    rotationDegrees: line.typesetting?.rotationDegrees ?? null
  });
}
