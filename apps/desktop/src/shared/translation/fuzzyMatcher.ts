export type FuzzyMatchResult = {
  score: number;
  levenshteinSimilarity: number;
  diceSimilarity: number;
  diffSummary?: string;
};

export function normalizeTextForMatching(text: string): string {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[、。！？!?,.~…「」『』()（）\-—―\s\r\n\t]/g, "")
    .trim();
}

/**
 * Calculates the Levenshtein distance between two strings.
 */
export function calculateLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i += 1) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j += 1) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= b.length; i += 1) {
    for (let j = 1; j <= a.length; j += 1) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1,     // insertion
          matrix[i - 1]![j]! + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length]![a.length]!;
}

/**
 * Calculates normalized Levenshtein similarity between 0.0 and 1.0.
 */
export function calculateLevenshteinSimilarity(a: string, b: string): number {
  const normA = normalizeTextForMatching(a);
  const normB = normalizeTextForMatching(b);

  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;

  const maxLength = Math.max(normA.length, normB.length);
  if (maxLength === 0) return 1.0;

  const distance = calculateLevenshteinDistance(normA, normB);
  return Math.max(0, 1 - distance / maxLength);
}

/**
 * Generates character bigrams for Dice coefficient calculation.
 */
function getBigrams(str: string): Set<string> {
  const bigrams = new Set<string>();
  if (str.length < 2) {
    if (str.length === 1) bigrams.add(str);
    return bigrams;
  }
  for (let i = 0; i < str.length - 1; i += 1) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * Calculates Dice coefficient similarity between two strings (0.0 to 1.0).
 */
export function calculateDiceSimilarity(a: string, b: string): number {
  const normA = normalizeTextForMatching(a);
  const normB = normalizeTextForMatching(b);

  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;

  const bigramsA = getBigrams(normA);
  const bigramsB = getBigrams(normB);

  let intersection = 0;
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) {
      intersection += 1;
    }
  }

  const total = bigramsA.size + bigramsB.size;
  if (total === 0) return 0.0;

  return (2.0 * intersection) / total;
}

/**
 * Hybrid fuzzy matching score (combines Levenshtein, Bigram Dice, and common prefix boost).
 */
export function calculateFuzzySimilarity(query: string, target: string): FuzzyMatchResult {
  const normQ = normalizeTextForMatching(query);
  const normT = normalizeTextForMatching(target);

  if (normQ === normT) {
    return { score: 1.0, levenshteinSimilarity: 1.0, diceSimilarity: 1.0 };
  }

  const levSim = calculateLevenshteinSimilarity(normQ, normT);
  const diceSim = calculateDiceSimilarity(normQ, normT);

  // Short strings (< 6 chars) rely more heavily on Levenshtein; longer on Dice
  const weightLev = normQ.length <= 6 ? 0.7 : 0.4;
  const weightDice = 1.0 - weightLev;

  let baseScore = levSim * weightLev + diceSim * weightDice;

  // Common prefix boost for verb/exclamation variations (e.g. 助けてくれ vs 助けてください)
  let commonPrefixLen = 0;
  const minLen = Math.min(normQ.length, normT.length);
  while (commonPrefixLen < minLen && normQ[commonPrefixLen] === normT[commonPrefixLen]) {
    commonPrefixLen += 1;
  }

  const maxLen = Math.max(normQ.length, normT.length);
  if (commonPrefixLen >= 2 && maxLen > 0) {
    const prefixRatio = commonPrefixLen / maxLen;
    baseScore = Math.min(1.0, baseScore + prefixRatio * 0.15);
  }

  const score = Math.round(baseScore * 100) / 100;

  return {
    score,
    levenshteinSimilarity: Math.round(levSim * 100) / 100,
    diceSimilarity: Math.round(diceSim * 100) / 100
  };
}
