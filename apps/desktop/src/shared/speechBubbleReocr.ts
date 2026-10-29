import type {
  ExtractedNonSpeechText,
  ExtractedSpeechBubble,
  NormalizedBbox,
  OcrTextType,
  SpeechBubbleExtractionResult
} from "./speechBubbleExtraction.js";

export type ReocrTargetKind = "speechBubbles" | "nonSpeechText";

export type ReocrTarget = {
  kind: ReocrTargetKind;
  index: number;
  type: OcrTextType;
  text: string;
  bbox: NormalizedBbox;
  readingOrder: number;
  confidence: number;
  notes: string;
};

export type CropReocrResult = {
  text: string;
  confidence: number;
  notes: string;
};

export type CropReocrMergeResult = {
  target: ReocrTarget;
  result: CropReocrResult;
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const UNCERTAIN_MARKER = "[?]";

export function selectCropReocrTargets(
  result: SpeechBubbleExtractionResult,
  options: { confidenceThreshold?: number } = {}
): ReocrTarget[] {
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const speechTargets = result.speechBubbles
    .map((bubble, index): ReocrTarget => toTarget("speechBubbles", bubble, index))
    .filter((target) => shouldReocr(target, confidenceThreshold));
  const nonSpeechTargets = result.nonSpeechText
    .map((textRegion, index): ReocrTarget => toTarget("nonSpeechText", textRegion, index))
    .filter((target) => shouldReocr(target, confidenceThreshold));

  return [...speechTargets, ...nonSpeechTargets].sort((left, right) => left.readingOrder - right.readingOrder);
}

export function mergeCropReocrResults(
  result: SpeechBubbleExtractionResult,
  cropResults: CropReocrMergeResult[]
): SpeechBubbleExtractionResult {
  let next: SpeechBubbleExtractionResult = {
    pageNumber: result.pageNumber,
    speechBubbles: result.speechBubbles.map((bubble) => ({ ...bubble, bbox: { ...bubble.bbox } })),
    nonSpeechText: result.nonSpeechText.map((textRegion) => ({ ...textRegion, bbox: { ...textRegion.bbox } })),
    warnings: [...result.warnings]
  };

  for (const cropResult of cropResults) {
    next = mergeSingleCropResult(next, cropResult);
  }

  return next;
}

function mergeSingleCropResult(
  result: SpeechBubbleExtractionResult,
  cropResult: CropReocrMergeResult
): SpeechBubbleExtractionResult {
  const { target } = cropResult;
  const existing = target.kind === "speechBubbles" ? result.speechBubbles[target.index] : result.nonSpeechText[target.index];
  if (!existing) return result;

  const cropText = cropResult.result.text.trim();
  if (!cropText) return result;

  const existingText = existing.text;
  const applyCropText = countUncertaintyMarkers(cropText) < countUncertaintyMarkers(existingText);
  const textsDiffer = cropText !== existingText;
  const notes = appendNote(
    existing.notes,
    buildCropNote(existingText, cropText, cropResult.result.confidence, cropResult.result.notes, applyCropText)
  );
  const confidence = applyCropText
    ? Math.min(Math.max(existing.confidence, cropResult.result.confidence), 0.95)
    : Math.min(existing.confidence, cropResult.result.confidence);

  const warnings =
    textsDiffer && !applyCropText
      ? [
          ...result.warnings,
          `Crop ReOCR disagreement for #${existing.readingOrder}: whole image "${existingText}" vs crop "${cropText}".`
        ]
      : result.warnings;

  if (target.kind === "speechBubbles") {
    const speechBubbles = result.speechBubbles.map((bubble, index) =>
      index === target.index
        ? {
            ...bubble,
            text: applyCropText ? cropText : bubble.text,
            confidence,
            notes
          }
        : bubble
    );
    return { ...result, speechBubbles, warnings };
  }

  const nonSpeechText = result.nonSpeechText.map((textRegion, index) =>
    index === target.index
      ? {
          ...textRegion,
          text: applyCropText ? cropText : textRegion.text,
          confidence,
          notes
        }
      : textRegion
  );
  return { ...result, nonSpeechText, warnings };
}

function toTarget(
  kind: ReocrTargetKind,
  region: ExtractedSpeechBubble | ExtractedNonSpeechText,
  index: number
): ReocrTarget {
  return {
    kind,
    index,
    type: region.type,
    text: region.text,
    bbox: region.bbox,
    readingOrder: region.readingOrder,
    confidence: region.confidence,
    notes: region.notes
  };
}

function shouldReocr(target: ReocrTarget, confidenceThreshold: number): boolean {
  return target.confidence < confidenceThreshold || target.text.includes(UNCERTAIN_MARKER);
}

function countUncertaintyMarkers(text: string): number {
  return text.split(UNCERTAIN_MARKER).length - 1;
}

function appendNote(existingNotes: string, cropNote: string): string {
  return [existingNotes.trim(), cropNote].filter(Boolean).join(" ");
}

function buildCropNote(
  existingText: string,
  cropText: string,
  cropConfidence: number,
  cropNotes: string,
  applied: boolean
): string {
  const action = applied ? "applied" : "reviewed";
  const basis = applied
    ? `reduced uncertainty from "${existingText}" to "${cropText}"`
    : `crop text "${cropText}" differed from whole image "${existingText}"`;
  const notes = cropNotes.trim() ? ` ${cropNotes.trim()}` : "";
  return `Crop ReOCR ${action}: ${basis}; crop confidence ${cropConfidence.toFixed(2)}.${notes}`;
}
