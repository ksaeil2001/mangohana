import type { DialogueLine } from "../projectTypes.js";
import { calculateFuzzySimilarity, normalizeTextForMatching } from "./fuzzyMatcher.js";

export type TranslationMemoryEntry = {
  id: string;
  sourceText: string;
  targetTranslation: string;
  speaker?: string;
  dialogueType?: string;
  pageNumber?: number;
  order?: number;
  confirmedAt?: string;
};

export type FuzzyTmCandidate = {
  entry: TranslationMemoryEntry;
  similarity: number;
  isExactMatch: boolean;
};

export type TranslationMemoryQueryOptions = {
  minSimilarity?: number; // default 0.70
  maxCandidates?: number; // default 3
  filterSpeaker?: string;
  excludeLineId?: string;
};

export type TranslationMemoryIndex = {
  entries: TranslationMemoryEntry[];
  exactIndex: Map<string, TranslationMemoryEntry>;
  findExact: (sourceText: string) => TranslationMemoryEntry | undefined;
  findFuzzy: (sourceText: string, options?: TranslationMemoryQueryOptions) => FuzzyTmCandidate[];
  addEntry: (entry: TranslationMemoryEntry) => void;
};

/**
 * Builds a Translation Memory index from project dialogue lines or external TM entries.
 */
export function createTranslationMemory(
  dialogueLines: readonly DialogueLine[],
  additionalEntries: readonly TranslationMemoryEntry[] = []
): TranslationMemoryIndex {
  const entries: TranslationMemoryEntry[] = [];
  const exactIndex = new Map<string, TranslationMemoryEntry>();

  function addEntry(entry: TranslationMemoryEntry): void {
    if (!entry.sourceText?.trim() || !entry.targetTranslation?.trim()) return;

    entries.push(entry);
    const norm = normalizeTextForMatching(entry.sourceText);
    if (norm && !exactIndex.has(norm)) {
      exactIndex.set(norm, entry);
    }
  }

  // Index lines that have confirmed translations (userTranslation or verified aiTranslation)
  for (const line of dialogueLines) {
    const resolved = line.userTranslation?.trim() || line.referenceTranslation?.trim();
    if (resolved && line.sourceText?.trim()) {
      addEntry({
        id: line.id,
        sourceText: line.sourceText.trim(),
        targetTranslation: resolved,
        speaker: line.speaker?.trim() || undefined,
        dialogueType: line.dialogueType,
        pageNumber: line.pageNumber,
        order: line.order
      });
    }
  }

  for (const entry of additionalEntries) {
    addEntry(entry);
  }

  function findExact(sourceText: string): TranslationMemoryEntry | undefined {
    if (!sourceText?.trim()) return undefined;
    const norm = normalizeTextForMatching(sourceText);
    return exactIndex.get(norm);
  }

  function findFuzzy(
    sourceText: string,
    options: TranslationMemoryQueryOptions = {}
  ): FuzzyTmCandidate[] {
    if (!sourceText?.trim()) return [];
    const minSim = options.minSimilarity ?? 0.7;
    const maxCand = options.maxCandidates ?? 3;
    const normSource = normalizeTextForMatching(sourceText);

    const candidates: FuzzyTmCandidate[] = [];
    const seenNorms = new Set<string>();

    for (const entry of entries) {
      if (options.excludeLineId && entry.id === options.excludeLineId) continue;

      const normEntry = normalizeTextForMatching(entry.sourceText);
      if (!normEntry || seenNorms.has(normEntry)) continue;
      seenNorms.add(normEntry);

      if (normSource === normEntry) {
        candidates.push({
          entry,
          similarity: 1.0,
          isExactMatch: true
        });
        continue;
      }

      const matchResult = calculateFuzzySimilarity(sourceText, entry.sourceText);
      if (matchResult.score >= minSim) {
        candidates.push({
          entry,
          similarity: matchResult.score,
          isExactMatch: false
        });
      }
    }

    // Sort by similarity descending, then by speaker match
    candidates.sort((a, b) => {
      if (Math.abs(b.similarity - a.similarity) > 0.001) {
        return b.similarity - a.similarity;
      }
      if (options.filterSpeaker) {
        const aMatchesSpeaker = a.entry.speaker === options.filterSpeaker ? 1 : 0;
        const bMatchesSpeaker = b.entry.speaker === options.filterSpeaker ? 1 : 0;
        return bMatchesSpeaker - aMatchesSpeaker;
      }
      return 0;
    });

    return candidates.slice(0, maxCand);
  }

  return {
    entries,
    exactIndex,
    findExact,
    findFuzzy,
    addEntry
  };
}
