import type { DialogueTypesetting, PageImage } from "./projectTypes.js";
import type { ProductionOcrOrientation, ProductionOcrProvenance } from "./productionOcr.js";
import type { CropReocrResult, ReocrTarget } from "./speechBubbleReocr.js";

export type ExtractionLanguage = "ja" | "en" | "ko" | "unknown";
export type SpeechBubbleTextType = "speech_bubble" | "thought_bubble" | "filtered_speech";
export type NonSpeechTextType =
  | "narration_box"
  | "caption_time_place"
  | "sign_or_label"
  | "handwritten_note"
  | "letter_or_document"
  | "screen_text"
  | "ui_text"
  | "sound_effect"
  | "decorative_text"
  | "background_noise_text"
  | "unknown";
export type OcrTextType = SpeechBubbleTextType | NonSpeechTextType;

export type NormalizedBbox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SpeakerCandidate = {
  speaker: string;
  confidence: number;
  reason: string;
};

export type OcrCharacterContext = {
  name: string;
  aliases: string[];
  description?: string;
  speechStyle?: string;
  relationshipNotes?: string;
};

export type PolygonPoint = {
  x: number;
  y: number;
};

export type ExtractedSpeechBubble = {
  id: string;
  type: SpeechBubbleTextType;
  text: string;
  language: ExtractionLanguage;
  bbox: NormalizedBbox;
  polygon?: PolygonPoint[];
  readingOrder: number;
  confidence: number;
  notes: string;
  speakerCandidates: SpeakerCandidate[];
  rawMangaOcrText?: string;
  rawPaddleOcrText?: string;
  isCrossValidated?: boolean;
  orientation?: ProductionOcrOrientation;
  productionOcrProvenance?: ProductionOcrProvenance;
};

export type ExtractedNonSpeechText = {
  type: NonSpeechTextType;
  text: string;
  bbox: NormalizedBbox;
  polygon?: PolygonPoint[];
  confidence: number;
  notes: string;
  readingOrder: number;
  speakerCandidates: SpeakerCandidate[];
  rawMangaOcrText?: string;
  rawPaddleOcrText?: string;
  isCrossValidated?: boolean;
  orientation?: ProductionOcrOrientation;
  productionOcrProvenance?: ProductionOcrProvenance;
};

export type SpeechBubbleExtractionResult = {
  pageNumber: number | null;
  speechBubbles: ExtractedSpeechBubble[];
  nonSpeechText: ExtractedNonSpeechText[];
  warnings: string[];
  productionOcrContext?: {
    runId: string;
    pageImageId: string;
    sourceSha256: string;
  };
};

export const OCR_VALIDATION_DEGRADED_WARNING_PREFIX = "2차 AI 검증 미완료, 원본 OCR 후보 사용 중";

export function createOcrValidationDegradedWarning(reason?: string): string {
  const normalizedReason = reason?.trim();
  return normalizedReason
    ? `${OCR_VALIDATION_DEGRADED_WARNING_PREFIX}. ${normalizedReason}`
    : `${OCR_VALIDATION_DEGRADED_WARNING_PREFIX}.`;
}

export function hasOcrValidationDegradedWarning(result: Pick<SpeechBubbleExtractionResult, "warnings">): boolean {
  return result.warnings.some((warning) => warning.startsWith(OCR_VALIDATION_DEGRADED_WARNING_PREFIX));
}

export const ocrEngines = ["gemini", "manga-ocr", "paddle-ocr", "hybrid", "windows-ocr"] as const;
export type OcrEngine = (typeof ocrEngines)[number];

export type ExtractSpeechBubblesRequest = {
  requestId: string;
  projectSessionId: string;
  pageImageId: PageImage["id"];
  sourceSha256: PageImage["sha256"];
};

export type ApplyProductionOcrReviewCandidate = {
  id: string;
  textType: OcrTextType;
  text: string;
  language: ExtractionLanguage;
  bbox: NormalizedBbox;
  polygon: PolygonPoint[];
  readingOrder: number;
  confidence: number;
  notes: string;
  selectedSpeaker: string;
  orientation: ProductionOcrOrientation;
  productionOcrProvenance: ProductionOcrProvenance;
  typesetting?: DialogueTypesetting;
};

export type ApplyProductionOcrReviewRequest = {
  projectSessionId: string;
  pageImageId: string;
  sourceSha256: string;
  runId: string;
  candidates: ApplyProductionOcrReviewCandidate[];
};

export type ValidateSpeechBubbleExtractionRequest = {
  requestId: string;
  projectFilePath: string;
  pageImage: PageImage;
  geminiExtraction: SpeechBubbleExtractionResult;
  characters?: OcrCharacterContext[];
};

export const extractionLanguages = ["ja", "en", "ko", "unknown"] as const;
export const speechBubbleTextTypes = ["speech_bubble", "thought_bubble", "filtered_speech"] as const;
export const optionalApplyTextTypes = [
  "narration_box",
  "caption_time_place",
  "handwritten_note",
  "letter_or_document"
] as const;
export const contextOnlyTextTypes = [
  "sign_or_label",
  "screen_text",
  "ui_text",
  "sound_effect",
  "decorative_text",
  "background_noise_text",
  "unknown"
] as const;
export const nonSpeechTextTypes = [...optionalApplyTextTypes, ...contextOnlyTextTypes] as const;
export const ocrTextTypes = [...speechBubbleTextTypes, ...nonSpeechTextTypes] as const;

export const SPEECH_BUBBLE_EXTRACTION_PROMPT = `You are extracting translation-relevant OCR text from a manga/comic/webtoon page.

Task:
Find visible original text, do not translate it, and classify each region into exactly one type.

Image basis:
- Treat the first provided image as the only OCR target image.
- Do not infer text from any other page, project page, neighboring image, or spread.
- If a second image is provided, it is only an interest mask for the first image. Do not OCR the interest mask as a separate page or image.
- bbox and readingOrder must be based only on the first OCR target image.
- readingOrder starts at 1 within this single OCR target image.

Types:
- speech_bubble: normal spoken dialogue in a speech balloon.
- thought_bubble: inner thought text in a thought balloon or clearly styled thought bubble.
- filtered_speech: voice/dialogue-like text from shouting, broadcast, phone, machine voice, loudspeaker, off-screen voice, radio, or similar filtered speech.
- narration_box: narration in a boxed/rectangular narrative area.
- caption_time_place: time/place labels and scene transition captions.
- sign_or_label: signs, labels, posters, book covers, package/object labels.
- handwritten_note: handwritten notes or slips.
- letter_or_document: letters, documents, paper text.
- screen_text: text inside TV, phone, computer, game, or device screens.
- ui_text: app UI, game UI, chat windows, notifications, buttons, menus.
- sound_effect: sound effects.
- decorative_text: decorative or stylized text not needed as dialogue.
- background_noise_text: incidental background chatter/noise text.
- unknown: visible text whose purpose is unclear.

Placement rules:
- Put only speech_bubble, thought_bubble, and filtered_speech in speechBubbles.
- Put every other type in nonSpeechText.
- Do not mix narration boxes, captions, notes, documents, signs, labels, screen/UI text, sound effects, decorative text, or background noise into speechBubbles.

OCR rules:
- Do not translate.
- Preserve the original language and line breaks as much as possible.
- If a character is unclear, use [?] for that character instead of guessing.
- If a whole text region is uncertain, include it with low confidence and explain in notes or warnings.
- Detect reading order using manga/comic layout. If uncertain, explain why in notes or warnings.
- Use confidence below 0.75 for uncertain regions.

Speaker candidate rules:
- Do not decide or finalize the speaker.
- For each speechBubbles item, provide 1 to 3 speakerCandidates.
- Each candidate must include speaker, confidence, and reason.
- Use visual evidence only: bubble tail direction, nearest face/character, panel position, and provided project character context.
- If evidence is weak, include unknown with low confidence instead of guessing.
- For narration_box or caption_time_place in nonSpeechText, speakerCandidates may include Narrator or unknown.
- Keep reasons short and specific, including why it is uncertain when confidence is low.

Return strict JSON only:
{
  "pageNumber": number | null,
  "speechBubbles": [
    {
      "id": "bubble-001",
      "type": "speech_bubble|thought_bubble|filtered_speech",
      "text": "original text",
      "language": "ja|en|ko|unknown",
      "bbox": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
      "readingOrder": 1,
      "confidence": 0.0,
      "notes": "short note if uncertain",
      "speakerCandidates": [
        { "speaker": "unknown", "confidence": 0.0, "reason": "tail is not visible" }
      ]
    }
  ],
  "nonSpeechText": [
    {
      "type": "narration_box|caption_time_place|sign_or_label|handwritten_note|letter_or_document|screen_text|ui_text|sound_effect|decorative_text|background_noise_text|unknown",
      "text": "original text",
      "bbox": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
      "readingOrder": 1,
      "confidence": 0.0,
      "notes": "short note if uncertain",
      "speakerCandidates": [
        { "speaker": "unknown", "confidence": 0.0, "reason": "not character speech" }
      ]
    }
  ],
  "warnings": ["missing/uncertain/overlap notes"]
}

BBox rules:
- Use normalized coordinates from 0.0 to 1.0 relative to the full first OCR target image.
- BBox should enclose the text region, not necessarily the full bubble or object.`;

export function buildSpeechBubbleExtractionPrompt(pageNumber: number | null, hasInterestMask: boolean): string {
  const pageInstruction =
    pageNumber === null ? "Current page number is unknown." : `Current page number is ${pageNumber}.`;
  const maskInstruction = hasInterestMask
    ? "A second image is provided as an optional user interest mask. Prioritize masked regions, but still classify visible contextual text separately when needed."
    : "No user interest mask is provided.";

  return [SPEECH_BUBBLE_EXTRACTION_PROMPT, pageInstruction, maskInstruction].join("\n\n");
}

export const SPEECH_BUBBLE_VALIDATION_PROMPT = `You are validating OCR extraction from a manga/comic/webtoon page.

Input:
- The original page image. Validate against the single provided page image only.
- Gemini JSON extraction

Task:
Review the extraction and produce corrected strict JSON without translating any text.

Check:
1. Are all speech_bubble, thought_bubble, and filtered_speech texts included in speechBubbles?
2. Are phone, broadcast, machine, loudspeaker, shouting, and off-screen voice texts classified as filtered_speech when they function as dialogue?
3. Move narration_box and caption_time_place to nonSpeechText when they are not dialogue balloons.
4. Keep handwritten_note, letter_or_document, sign_or_label, screen_text, and ui_text separate from speechBubbles.
5. Keep sound_effect, decorative_text, background_noise_text, and unknown out of default dialogue.
6. Are uncertain characters marked with [?] instead of guessed?
7. Are uncertain regions assigned low confidence with notes or warnings?
8. Are bounding boxes normalized 0.0 to 1.0 and placed around the text region?
9. Are reading order, duplicates, and merged regions corrected?

Correction rules:
- Do not translate.
- Preserve original text and line breaks.
- Keep bbox and readingOrder relative to that one image.
- speechBubbles may contain only speech_bubble, thought_bubble, and filtered_speech.
- nonSpeechText must contain narration_box, caption_time_place, handwritten_note, letter_or_document, sign_or_label, screen_text, ui_text, sound_effect, decorative_text, background_noise_text, and unknown.
- Use confidence below 0.75 for uncertain text or bbox.
- Put uncertainty details in notes and broader issues in warnings.
- Do not decide or finalize the speaker.
- For each speechBubbles item, provide 1 to 3 speakerCandidates.
- Each speakerCandidates entry must include speaker, confidence, and reason.
- Use visual evidence only: bubble tail direction, nearest face/character, panel position, and provided project character context.
- If evidence is weak, include unknown with low confidence instead of guessing.
- For narration_box or caption_time_place in nonSpeechText, speakerCandidates may include Narrator or unknown.
- Keep speaker reason short and specific, including why it is uncertain when confidence is low.

Return the same JSON schema only, including speakerCandidates on each text item.`;

export function buildSpeechBubbleValidationPrompt(
  geminiExtraction: SpeechBubbleExtractionResult,
  characters: OcrCharacterContext[] = []
): string {
  const characterContext = characters.length
    ? ["Project character context:", JSON.stringify(characters, null, 2)].join("\n")
    : "Project character context: none provided.";

  return [
    SPEECH_BUBBLE_VALIDATION_PROMPT,
    characterContext,
    "Gemini JSON extraction:",
    JSON.stringify(geminiExtraction, null, 2)
  ].join("\n\n");
}

export function buildSpeechBubbleCropReocrPrompt(target: ReocrTarget): string {
  return [
    "You are improving OCR text accuracy for one manga/comic/webtoon text crop.",
    "",
    "Task:",
    "- OCR only this single crop image.",
    "- Do not translate.",
    "- Do not infer text from the full page, neighboring panels, other bubbles, or any area outside this crop.",
    "- The original region type/context is provided only to help text accuracy; do not reclassify the region.",
    "- If a character is unclear, use [?] for that character instead of guessing.",
    "- If the crop is still uncertain, use low confidence and explain briefly in notes.",
    "",
    "Original whole-image OCR context:",
    `- type: ${target.type}`,
    `- readingOrder: ${target.readingOrder}`,
    `- previous text: ${target.text}`,
    `- previous confidence: ${target.confidence.toFixed(2)}`,
    target.notes ? `- previous notes: ${target.notes}` : "- previous notes: none",
    "",
    "Return strict JSON only:",
    '{ "text": "original text", "confidence": 0.0, "notes": "short uncertainty note" }'
  ].join("\n");
}

export function normalizeCropReocrResult(value: unknown): CropReocrResult {
  const record = isRecord(value) ? value : {};
  return {
    text: typeof record.text === "string" ? record.text : "",
    confidence: normalizeConfidence(record.confidence),
    notes: typeof record.notes === "string" ? record.notes : ""
  };
}

export function normalizeSpeechBubbleExtractionResult(
  value: unknown,
  fallbackPageNumber: number | null
): SpeechBubbleExtractionResult {
  if (!isRecord(value)) throw new Error("Speech bubble extraction JSON must be an object.");

  const pageNumber =
    typeof value.pageNumber === "number" && Number.isFinite(value.pageNumber) ? value.pageNumber : fallbackPageNumber;
  const speechBubbles: ExtractedSpeechBubble[] = [];
  const nonSpeechText: ExtractedNonSpeechText[] = [];

  if (Array.isArray(value.speechBubbles)) {
    value.speechBubbles.forEach((bubble, index) => {
      const normalized = normalizeOcrTextRegion(bubble, index, "speech_bubble");
      if (isSpeechBubbleTextType(normalized.type)) {
        speechBubbles.push(normalizeSpeechBubbleFromRegion(normalized, speechBubbles.length));
      } else {
        nonSpeechText.push(normalizeNonSpeechTextFromRegion(normalized));
      }
    });
  }

  if (Array.isArray(value.nonSpeechText)) {
    value.nonSpeechText.forEach((textRegion, index) => {
      const normalized = normalizeOcrTextRegion(textRegion, index, "unknown");
      if (isSpeechBubbleTextType(normalized.type)) {
        speechBubbles.push(normalizeSpeechBubbleFromRegion(normalized, speechBubbles.length));
      } else {
        nonSpeechText.push(normalizeNonSpeechTextFromRegion(normalized));
      }
    });
  }

  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];

  return {
    pageNumber,
    speechBubbles: speechBubbles.sort((left, right) => left.readingOrder - right.readingOrder),
    nonSpeechText: nonSpeechText.sort((left, right) => left.readingOrder - right.readingOrder),
    warnings
  };
}

export function isExtractionLanguage(value: unknown): value is ExtractionLanguage {
  return typeof value === "string" && (extractionLanguages as readonly string[]).includes(value);
}

export function isSpeechBubbleTextType(value: unknown): value is SpeechBubbleTextType {
  return typeof value === "string" && (speechBubbleTextTypes as readonly string[]).includes(value);
}

export function isNonSpeechTextType(value: unknown): value is NonSpeechTextType {
  return typeof value === "string" && (nonSpeechTextTypes as readonly string[]).includes(value);
}

export function isOcrTextType(value: unknown): value is OcrTextType {
  return typeof value === "string" && (ocrTextTypes as readonly string[]).includes(value);
}

function normalizeSpeechBubbleFromRegion(region: NormalizedOcrTextRegion, index: number): ExtractedSpeechBubble {
  return {
    id: region.id || `bubble-${String(index + 1).padStart(3, "0")}`,
    type: region.type as SpeechBubbleTextType,
    text: region.text,
    language: region.language,
    bbox: region.bbox,
    polygon: region.polygon,
    readingOrder: region.readingOrder,
    confidence: region.confidence,
    notes: region.notes,
    speakerCandidates: region.speakerCandidates,
    rawMangaOcrText: region.rawMangaOcrText,
    rawPaddleOcrText: region.rawPaddleOcrText,
    isCrossValidated: region.isCrossValidated
  };
}

function normalizeNonSpeechTextFromRegion(region: NormalizedOcrTextRegion): ExtractedNonSpeechText {
  return {
    type: isNonSpeechTextType(region.type) ? region.type : "unknown",
    text: region.text,
    bbox: region.bbox,
    polygon: region.polygon,
    readingOrder: region.readingOrder,
    confidence: region.confidence,
    notes: region.notes,
    speakerCandidates: region.speakerCandidates,
    rawMangaOcrText: region.rawMangaOcrText,
    rawPaddleOcrText: region.rawPaddleOcrText,
    isCrossValidated: region.isCrossValidated
  };
}

type NormalizedOcrTextRegion = {
  id: string;
  type: OcrTextType;
  text: string;
  language: ExtractionLanguage;
  bbox: NormalizedBbox;
  polygon?: PolygonPoint[];
  readingOrder: number;
  confidence: number;
  notes: string;
  speakerCandidates: SpeakerCandidate[];
  rawMangaOcrText?: string;
  rawPaddleOcrText?: string;
  isCrossValidated?: boolean;
};

function normalizeOcrTextRegion(value: unknown, index: number, fallbackType: OcrTextType): NormalizedOcrTextRegion {
  const record = isRecord(value) ? value : {};
  const readingOrder =
    typeof record.readingOrder === "number" && Number.isFinite(record.readingOrder)
      ? Math.max(1, Math.round(record.readingOrder))
      : index + 1;

  const polygon = Array.isArray(record.polygon)
    ? record.polygon
        .filter((pt): pt is { x: number; y: number } => isRecord(pt) && typeof pt.x === "number" && typeof pt.y === "number")
        .map((pt) => ({ x: clampUnitNumber(pt.x), y: clampUnitNumber(pt.y) }))
    : undefined;

  return {
    id: typeof record.id === "string" ? record.id : "",
    type: normalizeOcrTextType(record.type, fallbackType),
    text: typeof record.text === "string" ? record.text : "",
    language: isExtractionLanguage(record.language) ? record.language : "unknown",
    bbox: normalizeBbox(record.bbox),
    polygon: polygon && polygon.length >= 3 ? polygon : undefined,
    readingOrder,
    confidence: normalizeConfidence(record.confidence),
    notes: typeof record.notes === "string" ? record.notes : "",
    speakerCandidates: normalizeSpeakerCandidates(record.speakerCandidates),
    rawMangaOcrText: typeof record.rawMangaOcrText === "string" ? record.rawMangaOcrText : undefined,
    rawPaddleOcrText: typeof record.rawPaddleOcrText === "string" ? record.rawPaddleOcrText : undefined,
    isCrossValidated: typeof record.isCrossValidated === "boolean" ? record.isCrossValidated : undefined
  };
}

export function normalizeSpeakerCandidates(value: unknown): SpeakerCandidate[] {
  if (!Array.isArray(value)) return [];

  const candidates: SpeakerCandidate[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.speaker !== "string") continue;
    const speaker = candidate.speaker.trim();
    if (!speaker) continue;
    candidates.push({
      speaker,
      confidence: normalizeConfidence(candidate.confidence),
      reason: typeof candidate.reason === "string" ? candidate.reason.trim() : ""
    });
    if (candidates.length >= 3) break;
  }
  return candidates;
}

function normalizeOcrTextType(value: unknown, fallbackType: OcrTextType): OcrTextType {
  if (isOcrTextType(value)) return value;
  if (value === "caption") return "caption_time_place";
  if (value === "background_text") return "background_noise_text";
  if (value === "sign") return "sign_or_label";
  return fallbackType;
}

function normalizeBbox(value: unknown): NormalizedBbox {
  const record = isRecord(value) ? value : {};
  const x = clampUnitNumber(record.x);
  const y = clampUnitNumber(record.y);
  const width = Math.min(clampUnitNumber(record.width), 1 - x);
  const height = Math.min(clampUnitNumber(record.height), 1 - y);

  return { x, y, width, height };
}

function normalizeConfidence(value: unknown): number {
  return clampUnitNumber(value);
}

function clampUnitNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
