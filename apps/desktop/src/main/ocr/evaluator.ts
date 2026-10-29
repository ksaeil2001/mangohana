import type { CrossValidationResult } from "./types.js";

/**
 * Calculates normalized string similarity ratio using Levenshtein distance (0.0 to 1.0).
 */
export function calculateTextSimilarity(str1: string, str2: string): number {
  const s1 = str1.replace(/\s+/g, "").trim();
  const s2 = str2.replace(/\s+/g, "").trim();

  if (s1 === s2) return 1.0;
  if (!s1.length || !s2.length) return 0.0;

  const len1 = s1.length;
  const len2 = s2.length;

  const dp: number[][] = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) dp[i][0] = i;
  for (let j = 0; j <= len2; j++) dp[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  const distance = dp[len1][len2];
  const maxLen = Math.max(len1, len2);
  return Math.max(0, 1 - distance / maxLen);
}

export type CrossValidationOptions = {
  highSimilarityThreshold?: number;
  moderateSimilarityThreshold?: number;
  minReliableConfidence?: number;
};

const DEFAULT_HIGH_THRESHOLD = 0.82;
const DEFAULT_MODERATE_THRESHOLD = 0.50;

/**
 * Cross-validates text recognition between MangaOCR and PaddleOCR.
 * Prioritizes MangaOCR for Japanese manga font glyphs, but leverages PaddleOCR's
 * confidence score and detects discrepancies to flag low-confidence review queues.
 */
export function evaluateOcrCrossValidation({
  mangaOcrText,
  paddleOcrText,
  paddleConfidence = 0.8,
  options = {}
}: {
  mangaOcrText: string;
  paddleOcrText: string;
  paddleConfidence?: number;
  options?: CrossValidationOptions;
}): CrossValidationResult {
  const highThreshold = options.highSimilarityThreshold ?? DEFAULT_HIGH_THRESHOLD;
  const modThreshold = options.moderateSimilarityThreshold ?? DEFAULT_MODERATE_THRESHOLD;

  const cleanManga = mangaOcrText.trim();
  const cleanPaddle = paddleOcrText.trim();

  // If one engine produced empty text
  if (!cleanManga && !cleanPaddle) {
    return {
      selectedText: "",
      confidence: 0.0,
      isConsistent: true,
      rawMangaOcrText: cleanManga,
      rawPaddleOcrText: cleanPaddle,
      similarityRatio: 1.0,
      warnings: ["텍스트를 인식하지 못했습니다."]
    };
  }

  if (!cleanManga || !cleanPaddle) {
    const selected = cleanManga || cleanPaddle;
    return {
      selectedText: selected,
      confidence: Math.min(paddleConfidence, 0.65),
      isConsistent: false,
      rawMangaOcrText: cleanManga,
      rawPaddleOcrText: cleanPaddle,
      similarityRatio: 0.0,
      warnings: ["하나의 OCR 엔진에서만 텍스트가 인식되었습니다."]
    };
  }

  const similarityRatio = calculateTextSimilarity(cleanManga, cleanPaddle);
  const warnings: string[] = [];

  let isConsistent = false;
  let finalConfidence = paddleConfidence;

  if (similarityRatio >= highThreshold) {
    isConsistent = true;
    finalConfidence = Math.max(paddleConfidence, 0.90);
  } else if (similarityRatio >= modThreshold) {
    isConsistent = false;
    finalConfidence = Math.min(paddleConfidence, 0.70);
    warnings.push(
      `OCR 엔진 간 인식 차이 발생 (유사도 ${(similarityRatio * 100).toFixed(0)}%). MangaOCR: "${cleanManga}", PaddleOCR: "${cleanPaddle}"`
    );
  } else {
    isConsistent = false;
    finalConfidence = Math.min(paddleConfidence, 0.48);
    warnings.push(
      `MangaOCR과 PaddleOCR 결과가 크게 다릅니다. 원본 확인이 필요합니다.`
    );
  }

  // Selected text: prioritize MangaOCR for Japanese manga nuances
  const selectedText = cleanManga || cleanPaddle;

  return {
    selectedText,
    confidence: Number(finalConfidence.toFixed(2)),
    isConsistent,
    rawMangaOcrText: cleanManga,
    rawPaddleOcrText: cleanPaddle,
    similarityRatio: Number(similarityRatio.toFixed(2)),
    warnings
  };
}
