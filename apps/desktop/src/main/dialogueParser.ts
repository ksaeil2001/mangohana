import { randomUUID } from "node:crypto";
import type { DialogueLine, DialogueType, SourceLanguage } from "../shared/projectTypes.js";

type MutableLine = Omit<DialogueLine, "id" | "order" | "parseConfidence" | "parseWarnings"> & {
  parseWarnings: string[];
};

const REFERENCE_PREFIX = /^(KR|KOR|REFERENCE|REF|\uCC38\uACE0)\s*:\s*(.+)$/i;
const SPEAKER_PREFIX = /^([^:\-\n]{1,40})\s*[:\-]\s*(.+)$/;
const MARKER_ONLY = /^\s*\[([^\]]+)]\s*(?:\(([^)]+)\))?\s*$/;
const AMBIGUOUS_SPEAKER_CANDIDATES = new Set([
  "ah",
  "eh",
  "hey",
  "huh",
  "i",
  "it",
  "no",
  "oh",
  "ok",
  "okay",
  "please",
  "she",
  "stop",
  "they",
  "wait",
  "we",
  "what",
  "why",
  "yes",
  "you"
]);

export function parseDialogueText(input: string): DialogueLine[] {
  const blocks = input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const parsedLines: DialogueLine[] = [];
  let currentPageNumber = 1;

  for (const block of blocks) {
    const parsedBlock = parseBlock(block, currentPageNumber);
    currentPageNumber = parsedBlock.currentPageNumber;

    if (!parsedBlock.isPageMarkerOnly) {
      parsedLines.push(finalizeLine(parsedBlock.line, parsedLines.length + 1));
    }
  }

  return parsedLines;
}

function parseBlock(
  block: string,
  initialPageNumber: number
): { line: MutableLine; currentPageNumber: number; isPageMarkerOnly: boolean } {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed: MutableLine = {
    pageNumber: initialPageNumber,
    dialogueType: "speech",
    lineStatus: "untranslated",
    sourceLanguage: "unknown",
    sourceText: "",
    parseWarnings: []
  };
  let currentPageNumber = initialPageNumber;
  let hasNonPageMarkerLine = false;

  const sourceParts: string[] = [];

  for (const rawLine of lines) {
    const pageNumber = parsePageMarker(rawLine);
    if (pageNumber !== null) {
      currentPageNumber = pageNumber;
      if (sourceParts.length === 0) parsed.pageNumber = pageNumber;
      continue;
    }

    hasNonPageMarkerLine = true;

    const marker = rawLine.match(MARKER_ONLY);
    if (marker) {
      const dialogueType = parseDialogueType(marker[1]);
      if (dialogueType === "unknown") {
        sourceParts.push(rawLine);
        parsed.parseWarnings.push("Unknown marker preserved");
        continue;
      }

      parsed.dialogueType = dialogueType;
      if (marker[2]) parsed.position = marker[2].trim();
      continue;
    }

    const reference = rawLine.match(REFERENCE_PREFIX);
    if (reference) {
      parsed.referenceTranslation = reference[2].trim();
      continue;
    }

    const speaker = rawLine.match(SPEAKER_PREFIX);
    if (speaker && !parsed.speaker) {
      const speakerCandidate = speaker[1].trim();
      if (isSpeakerLabelCandidate(speakerCandidate)) {
        parsed.speaker = speakerCandidate;
        sourceParts.push(speaker[2].trim());
      } else {
        sourceParts.push(rawLine);
        parsed.parseWarnings.push("Ambiguous speaker prefix preserved");
      }
      continue;
    }

    sourceParts.push(rawLine);
  }

  parsed.sourceText = sourceParts.join(" ").trim();
  parsed.sourceLanguage = detectSourceLanguage(parsed.sourceText);

  if (!parsed.speaker) parsed.parseWarnings.push("No speaker detected");
  if (!parsed.sourceText) parsed.parseWarnings.push("No source text detected");

  return { line: parsed, currentPageNumber, isPageMarkerOnly: !hasNonPageMarkerLine };
}

function finalizeLine(line: MutableLine, order: number): DialogueLine {
  const confidencePenalty = line.parseWarnings.length * 0.2;

  return {
    id: randomUUID(),
    order,
    ...line,
    parseConfidence: Math.max(0.2, 1 - confidencePenalty)
  };
}

function parseDialogueType(label: string): DialogueType {
  const normalized = label.toLowerCase();
  if (normalized.includes("thought") || normalized.includes("monologue") || normalized.includes("\uB3C5\uBC31")) {
    return "thought";
  }
  if (normalized.includes("narration") || normalized.includes("narrator")) return "narration";
  return "unknown";
}

function parsePageMarker(line: string): number | null {
  let normalized = line.trim();
  const bracketed = normalized.match(/^\[([^\]]+)]$/);
  if (bracketed) normalized = bracketed[1].trim();

  normalized = normalized.replace(/^-+\s*/, "").replace(/\s*-+$/, "").trim();

  const marker =
    normalized.match(/^(?:page\s+|p\.\s*)(\d+)$/i) ??
    normalized.match(/^\uD398\uC774\uC9C0\s*(\d+)$/) ??
    normalized.match(/^(\d+)\s*\uD398\uC774\uC9C0$/);

  if (!marker) return null;

  const pageNumber = Number(marker[1]);
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

function isSpeakerLabelCandidate(candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  if (AMBIGUOUS_SPEAKER_CANDIDATES.has(normalized)) return false;
  if (candidate.split(/\s+/).length > 4) return false;

  return /^[\p{L}\p{N}][\p{L}\p{N} ._'()]*$/u.test(candidate);
}

function detectSourceLanguage(text: string): SourceLanguage {
  const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
  const hasEnglish = /[A-Za-z]/.test(text);
  if (hasJapanese && hasEnglish) return "mixed";
  if (hasJapanese) return "ja";
  if (hasEnglish) return "en";
  return "unknown";
}
