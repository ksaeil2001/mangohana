import type { DialogueLine, DialogueType } from "../projectTypes.js";

export type ScoredTurnContext = {
  lineId: string;
  order: number;
  pageNumber: number;
  speaker?: string;
  sourceText: string;
  resolvedTranslation?: string;
  dialogueType: DialogueType;
  direction: "previous" | "next";
  distance: number;
  relevanceScore: number;
};

export type SelectContextOptions = {
  maxPreviousTurns?: number; // default: 4
  maxNextTurns?: number;     // default: 2 (lookahead)
  tokenBudget?: number;      // approximate token budget for context, default: 600
  includePreviousPage?: boolean; // default: true
  includeNextPage?: boolean;     // default: false
};

/**
 * Estimates token count for Japanese/Korean/English mixed text.
 * CJK characters roughly equal 1~1.5 tokens, words roughly equal 1.3 tokens.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs, Hiragana, Katakana, Hangul Syllables
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      count += 1.2;
    } else if (code === 32 || code === 10) {
      count += 0.3;
    } else {
      count += 0.5;
    }
  }
  return Math.ceil(count);
}

/**
 * Calculates a relevance score for a surrounding dialogue line relative to target line.
 */
function scoreTurnRelevance(
  candidate: DialogueLine,
  target: DialogueLine,
  distance: number,
  direction: "previous" | "next"
): number {
  let score = 100;

  // 1. Distance penalty
  score -= distance * 15;

  // 2. Same page bonus
  if (candidate.pageNumber === target.pageNumber) {
    score += 30;
  }

  // 3. Speaker interaction bonus
  if (candidate.speaker && target.speaker) {
    if (candidate.speaker === target.speaker) {
      // Same speaker continuation
      score += 15;
    } else {
      // Direct conversation partner (turn-taking)
      score += 25;
    }
  }

  // 4. Direction adjustment: previous context usually has higher priority than lookahead
  if (direction === "previous") {
    score += 10;
  }

  // 5. Narration / Thought adjustment
  if (candidate.dialogueType === "speech") {
    score += 5;
  }

  return Math.max(1, score);
}

export type SelectedContextResult = {
  previousTurns: ScoredTurnContext[];
  nextTurns: ScoredTurnContext[];
  estimatedTotalTokens: number;
};

/**
 * Selects the most relevant bidirectional context within a defined token budget.
 */
export function selectRelevantDialogueContext(
  dialogueLines: readonly DialogueLine[],
  targetLineId: string,
  options: SelectContextOptions = {}
): SelectedContextResult {
  const maxPrev = options.maxPreviousTurns ?? 4;
  const maxNext = options.maxNextTurns ?? 2;
  const budget = options.tokenBudget ?? 600;
  const includePrevPage = options.includePreviousPage ?? true;
  const includeNextPage = options.includeNextPage ?? false;

  const sortedLines = [...dialogueLines].sort((a, b) =>
    a.pageNumber !== b.pageNumber ? a.pageNumber - b.pageNumber : a.order - b.order
  );

  const targetIndex = sortedLines.findIndex((line) => line.id === targetLineId);
  if (targetIndex === -1) {
    return { previousTurns: [], nextTurns: [], estimatedTotalTokens: 0 };
  }

  const targetLine = sortedLines[targetIndex]!;

  // 1. Candidate extraction: Previous turns
  const prevCandidates: ScoredTurnContext[] = [];
  for (let i = targetIndex - 1; i >= 0 && prevCandidates.length < maxPrev * 2; i -= 1) {
    const prev = sortedLines[i]!;
    if (!includePrevPage && prev.pageNumber !== targetLine.pageNumber) break;

    const distance = targetIndex - i;
    const resolved =
      prev.userTranslation?.trim() ||
      prev.aiTranslation?.trim() ||
      prev.referenceTranslation?.trim() ||
      undefined;

    const score = scoreTurnRelevance(prev, targetLine, distance, "previous");

    prevCandidates.push({
      lineId: prev.id,
      order: prev.order,
      pageNumber: prev.pageNumber,
      speaker: prev.speaker?.trim() || undefined,
      sourceText: prev.sourceText,
      resolvedTranslation: resolved,
      dialogueType: prev.dialogueType,
      direction: "previous",
      distance,
      relevanceScore: score
    });
  }

  // 2. Candidate extraction: Next turns (Lookahead)
  const nextCandidates: ScoredTurnContext[] = [];
  for (let i = targetIndex + 1; i < sortedLines.length && nextCandidates.length < maxNext * 2; i += 1) {
    const next = sortedLines[i]!;
    if (!includeNextPage && next.pageNumber !== targetLine.pageNumber) break;

    const distance = i - targetIndex;
    const resolved =
      next.userTranslation?.trim() ||
      next.aiTranslation?.trim() ||
      next.referenceTranslation?.trim() ||
      undefined;

    const score = scoreTurnRelevance(next, targetLine, distance, "next");

    nextCandidates.push({
      lineId: next.id,
      order: next.order,
      pageNumber: next.pageNumber,
      speaker: next.speaker?.trim() || undefined,
      sourceText: next.sourceText,
      resolvedTranslation: resolved,
      dialogueType: next.dialogueType,
      direction: "next",
      distance,
      relevanceScore: score
    });
  }

  // 3. Token-budgeted selection
  // Sort candidate pool by relevanceScore descending
  const allCandidates = [
    ...prevCandidates.slice(0, maxPrev),
    ...nextCandidates.slice(0, maxNext)
  ].sort((a, b) => b.relevanceScore - a.relevanceScore);

  let currentTokens = 0;
  const selectedIds = new Set<string>();

  for (const cand of allCandidates) {
    const lineTokens =
      estimateTokenCount(cand.sourceText) +
      (cand.resolvedTranslation ? estimateTokenCount(cand.resolvedTranslation) : 0) +
      10; // overhead per turn

    if (currentTokens + lineTokens <= budget || selectedIds.size === 0) {
      selectedIds.add(cand.lineId);
      currentTokens += lineTokens;
    }
  }

  // Restore chronological order for previousTurns and nextTurns
  const finalPrev = prevCandidates
    .filter((c) => selectedIds.has(c.lineId))
    .reverse();

  const finalNext = nextCandidates
    .filter((c) => selectedIds.has(c.lineId));

  return {
    previousTurns: finalPrev,
    nextTurns: finalNext,
    estimatedTotalTokens: currentTokens
  };
}
