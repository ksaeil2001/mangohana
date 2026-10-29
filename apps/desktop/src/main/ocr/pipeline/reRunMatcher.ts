import type { DialogueLine, OcrEditStatus, SourceLanguage } from "../../../shared/projectTypes.js";
import type {
  ExtractionLanguage,
  ExtractedSpeechBubble,
  NormalizedBbox,
  SpeechBubbleExtractionResult
} from "../../../shared/speechBubbleExtraction.js";

export type ReRunMatchResult = {
  mergedLines: DialogueLine[];
  stats: {
    preservedCount: number;
    updatedCount: number;
    newCount: number;
    orphanedCount: number;
  };
};

export type ReRunMatchOptions = {
  iouThreshold?: number;
  preserveUserTranslations?: boolean;
};

const DEFAULT_IOU_THRESHOLD = 0.45;

function toSourceLanguage(lang?: ExtractionLanguage): SourceLanguage {
  if (lang === "ja" || lang === "en") return lang;
  return "ja";
}

/**
 * Calculates the Intersection over Union (IoU) between two normalized bounding boxes.
 */
export function calculateBboxIou(a: NormalizedBbox, b: NormalizedBbox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  const intersectionArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersectionArea <= 0) return 0;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const unionArea = areaA + areaB - intersectionArea;

  if (unionArea <= 0) return 0;
  return intersectionArea / unionArea;
}

/**
 * Checks if a dialogue line has user modifications that must be protected.
 */
export function isUserProtectedLine(line: DialogueLine): boolean {
  if (line.ocrEditStatus === "user_confirmed" || line.ocrEditStatus === "user_modified") {
    return true;
  }
  if (line.userOverrideSourceText && line.userOverrideSourceText.trim().length > 0) {
    return true;
  }
  if (line.userTranslation && line.userTranslation.trim().length > 0) {
    return true;
  }
  return false;
}

/**
 * Merges newly extracted OCR speech bubbles with existing dialogue lines for a specific page,
 * strictly preserving any user edits or confirmations (YSB Translator Tool principle).
 */
export function matchAndPreserveDialogueLines({
  existingLines,
  extractedResult,
  pageNumber,
  options = {}
}: {
  existingLines: DialogueLine[];
  extractedResult: SpeechBubbleExtractionResult;
  pageNumber: number;
  options?: ReRunMatchOptions;
}): ReRunMatchResult {
  const iouThreshold = options.iouThreshold ?? DEFAULT_IOU_THRESHOLD;
  const otherPageLines = existingLines.filter((line) => line.pageNumber !== pageNumber);
  const currentPageLines = existingLines.filter((line) => line.pageNumber === pageNumber);

  const matchedExistingIds = new Set<string>();
  const matchedExtractedIds = new Set<string>();
  const mergedCurrentPageLines: DialogueLine[] = [];

  let preservedCount = 0;
  let updatedCount = 0;
  let newCount = 0;
  let orphanedCount = 0;

  // 1. Calculate pairwise IoU between existing lines and extracted speech bubbles
  type PairMatch = {
    existingLine: DialogueLine;
    extractedBubble: ExtractedSpeechBubble;
    iou: number;
  };

  const candidatePairs: PairMatch[] = [];

  for (const existingLine of currentPageLines) {
    const existingBbox = existingLine.typesetting?.bbox;
    if (!existingBbox) continue;

    for (const bubble of extractedResult.speechBubbles) {
      const iou = calculateBboxIou(existingBbox, bubble.bbox);
      if (iou >= iouThreshold) {
        candidatePairs.push({ existingLine, extractedBubble: bubble, iou });
      }
    }
  }

  // Sort candidate pairs by IoU descending (greedy best-match)
  candidatePairs.sort((a, b) => b.iou - a.iou);

  for (const pair of candidatePairs) {
    if (matchedExistingIds.has(pair.existingLine.id) || matchedExtractedIds.has(pair.extractedBubble.id)) {
      continue;
    }

    matchedExistingIds.add(pair.existingLine.id);
    matchedExtractedIds.add(pair.extractedBubble.id);

    const { existingLine, extractedBubble } = pair;
    const isProtected = isUserProtectedLine(existingLine);

    if (isProtected) {
      // Preserve user content and only update non-destructive metadata
      mergedCurrentPageLines.push({
        ...existingLine,
        order: extractedBubble.readingOrder || existingLine.order,
        polygon: extractedBubble.polygon ?? existingLine.polygon,
        parseConfidence: extractedBubble.confidence,
        ocrSourceInfo: {
          ocrEngine: extractedBubble.rawMangaOcrText ? "manga-ocr" : "gemini",
          rawMangaOcrText: extractedBubble.rawMangaOcrText,
          rawPaddleOcrText: extractedBubble.rawPaddleOcrText,
          confidence: extractedBubble.confidence,
          isCrossValidated: extractedBubble.isCrossValidated
        }
      });
      preservedCount++;
    } else {
      // AI-proposed line: update with the latest OCR extraction
      mergedCurrentPageLines.push({
        ...existingLine,
        order: extractedBubble.readingOrder || existingLine.order,
        sourceText: extractedBubble.text,
        dialogueType: extractedBubble.type === "thought_bubble" ? "thought" : "speech",
        speaker: extractedBubble.speakerCandidates[0]?.speaker ?? existingLine.speaker,
        sourceLanguage: toSourceLanguage(extractedBubble.language),
        parseConfidence: extractedBubble.confidence,
        notes: extractedBubble.notes || existingLine.notes,
        polygon: extractedBubble.polygon,
        typesetting: {
          bbox: extractedBubble.bbox,
          writingMode: "vertical-rl"
        },
        ocrEditStatus: "ai_proposed",
        ocrSourceInfo: {
          ocrEngine: extractedBubble.rawMangaOcrText ? "manga-ocr" : "gemini",
          rawMangaOcrText: extractedBubble.rawMangaOcrText,
          rawPaddleOcrText: extractedBubble.rawPaddleOcrText,
          confidence: extractedBubble.confidence,
          isCrossValidated: extractedBubble.isCrossValidated
        }
      });
      updatedCount++;
    }
  }

  // 2. Add remaining newly extracted speech bubbles as new dialogue lines
  for (const bubble of extractedResult.speechBubbles) {
    if (matchedExtractedIds.has(bubble.id)) continue;

    const newLineId = `line-p${pageNumber}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    mergedCurrentPageLines.push({
      id: newLineId,
      order: bubble.readingOrder,
      pageNumber,
      speaker: bubble.speakerCandidates[0]?.speaker,
      dialogueType: bubble.type === "thought_bubble" ? "thought" : "speech",
      lineStatus: "untranslated",
      sourceLanguage: toSourceLanguage(bubble.language),
      sourceText: bubble.text,
      parseConfidence: bubble.confidence,
      parseWarnings: [],
      notes: bubble.notes,
      polygon: bubble.polygon,
      typesetting: {
        bbox: bubble.bbox,
        writingMode: "vertical-rl"
      },
      ocrEditStatus: "ai_proposed",
      ocrSourceInfo: {
        ocrEngine: bubble.rawMangaOcrText ? "manga-ocr" : "gemini",
        rawMangaOcrText: bubble.rawMangaOcrText,
        rawPaddleOcrText: bubble.rawPaddleOcrText,
        confidence: bubble.confidence,
        isCrossValidated: bubble.isCrossValidated
      }
    });
    newCount++;
  }

  // 3. Keep unmatched existing lines with orphaned flag (never silently delete user work)
  for (const existingLine of currentPageLines) {
    if (matchedExistingIds.has(existingLine.id)) continue;

    mergedCurrentPageLines.push({
      ...existingLine,
      parseWarnings: [...(existingLine.parseWarnings || []), "재실행 OCR에서 해당 영역이 검출되지 않았습니다."]
    });
    orphanedCount++;
  }

  // Sort page lines by order
  mergedCurrentPageLines.sort((a, b) => a.order - b.order);

  // Combine other pages and current page, sorted by pageNumber then order
  const allMergedLines = [...otherPageLines, ...mergedCurrentPageLines].sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    return a.order - b.order;
  });

  return {
    mergedLines: allMergedLines,
    stats: {
      preservedCount,
      updatedCount,
      newCount,
      orphanedCount
    }
  };
}
