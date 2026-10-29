import {
  buildSpeechBubbleCropReocrPrompt,
  buildSpeechBubbleExtractionPrompt,
  buildSpeechBubbleValidationPrompt,
  normalizeCropReocrResult,
  normalizeSpeechBubbleExtractionResult
} from "../shared/speechBubbleExtraction.js";
import type { CropReocrResult, ReocrTarget } from "../shared/speechBubbleReocr.js";
import type { OcrCharacterContext, SpeechBubbleExtractionResult } from "../shared/speechBubbleExtraction.js";
import { fetchWithGeminiRetry } from "./geminiTransientRetry.js";

type ExtractSpeechBubblesWithGeminiArgs = {
  imageBytes: Buffer;
  sourceMimeType: string;
  pageNumber: number | null;
  interestMaskBytes?: Buffer;
  signal?: AbortSignal;
};

type ValidateSpeechBubblesWithGeminiArgs = {
  imageBytes: Buffer;
  sourceMimeType: string;
  geminiExtraction: SpeechBubbleExtractionResult;
  characters?: OcrCharacterContext[];
  signal?: AbortSignal;
};

type ReocrSpeechBubbleCropWithGeminiArgs = {
  cropImageBytes: Buffer;
  sourceMimeType: string;
  target: ReocrTarget;
  signal?: AbortSignal;
};

type GeminiTextResponse = {
  output_text?: string;
  text?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  steps?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

type GeminiErrorResponse = {
  error?: {
    message?: string;
  };
};

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_GEMINI_TEXT_MODEL = "gemini-3.5-flash";
const CRITICAL_GEMINI_MAX_ATTEMPTS = 3;
const OPTIONAL_CROP_GEMINI_MAX_ATTEMPTS = 2;
export const GEMINI_OCR_ATTEMPT_TIMEOUT_MS = 45_000;
export const GEMINI_CROP_REOCR_ATTEMPT_TIMEOUT_MS = 20_000;

export async function extractSpeechBubblesWithGemini(
  args: ExtractSpeechBubblesWithGeminiArgs
): Promise<SpeechBubbleExtractionResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to extract speech bubble text.");
  }

  const input: Array<{ type: string; text?: string; mime_type?: string; data?: string }> = [
    {
      type: "text",
      text: buildSpeechBubbleExtractionPrompt(args.pageNumber, Boolean(args.interestMaskBytes))
    },
    {
      type: "image",
      mime_type: normalizeImageMimeType(args.sourceMimeType),
      data: args.imageBytes.toString("base64")
    }
  ];

  if (args.interestMaskBytes) {
    input.push({
      type: "image",
      mime_type: "image/png",
      data: args.interestMaskBytes.toString("base64")
    });
  }

  const response = await fetchWithGeminiRetry(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      model: process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_TEXT_MODEL,
      input
    })
  }, {
    maxAttempts: CRITICAL_GEMINI_MAX_ATTEMPTS,
    attemptTimeoutMs: GEMINI_OCR_ATTEMPT_TIMEOUT_MS,
    signal: args.signal,
    operationLabel: "Gemini OCR 추출"
  });

  if (!response.ok) {
    throw new Error(await buildGeminiErrorMessage(response, "extraction"));
  }

  const payload = (await response.json()) as GeminiTextResponse;
  const text = findTextOutput(payload);
  if (!text) {
    throw new Error("Gemini extraction response did not include text output.");
  }

  return normalizeSpeechBubbleExtractionResult(parseJsonOutput(text), args.pageNumber);
}

export async function validateSpeechBubblesWithGemini(
  args: ValidateSpeechBubblesWithGeminiArgs
): Promise<SpeechBubbleExtractionResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to validate speech bubble extraction.");
  }

  const input: Array<{ type: string; text?: string; mime_type?: string; data?: string }> = [
    {
      type: "text",
      text: buildSpeechBubbleValidationPrompt(args.geminiExtraction, args.characters ?? [])
    },
    {
      type: "image",
      mime_type: normalizeImageMimeType(args.sourceMimeType),
      data: args.imageBytes.toString("base64")
    }
  ];

  const response = await fetchWithGeminiRetry(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      model: process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_TEXT_MODEL,
      input
    })
  }, {
    maxAttempts: CRITICAL_GEMINI_MAX_ATTEMPTS,
    attemptTimeoutMs: GEMINI_OCR_ATTEMPT_TIMEOUT_MS,
    signal: args.signal,
    operationLabel: "Gemini OCR 2차 검증"
  });

  if (!response.ok) {
    throw new Error(await buildGeminiErrorMessage(response, "validation"));
  }

  const payload = (await response.json()) as GeminiTextResponse;
  const text = findTextOutput(payload);
  if (!text) {
    throw new Error("Gemini validation response did not include text output.");
  }

  return normalizeSpeechBubbleExtractionResult(parseJsonOutput(text), args.geminiExtraction.pageNumber);
}

export async function reocrSpeechBubbleCropWithGemini(
  args: ReocrSpeechBubbleCropWithGeminiArgs
): Promise<CropReocrResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to re-OCR speech bubble crops.");
  }

  const input: Array<{ type: string; text?: string; mime_type?: string; data?: string }> = [
    {
      type: "text",
      text: buildSpeechBubbleCropReocrPrompt(args.target)
    },
    {
      type: "image",
      mime_type: normalizeImageMimeType(args.sourceMimeType),
      data: args.cropImageBytes.toString("base64")
    }
  ];

  const response = await fetchWithGeminiRetry(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      model: process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_TEXT_MODEL,
      input
    })
  }, {
    maxAttempts: OPTIONAL_CROP_GEMINI_MAX_ATTEMPTS,
    attemptTimeoutMs: GEMINI_CROP_REOCR_ATTEMPT_TIMEOUT_MS,
    signal: args.signal,
    operationLabel: "Gemini Crop 재OCR"
  });

  if (!response.ok) {
    throw new Error(await buildGeminiErrorMessage(response, "crop reOCR"));
  }

  const payload = (await response.json()) as GeminiTextResponse;
  const text = findTextOutput(payload);
  if (!text) {
    throw new Error("Gemini crop reOCR response did not include text output.");
  }

  return normalizeCropReocrResult(parseJsonOutput(text));
}

function findTextOutput(payload: GeminiTextResponse): string | undefined {
  if (payload.output_text) return payload.output_text;
  if (payload.text) return payload.text;

  const candidateText = payload.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text)
    .find((text) => typeof text === "string" && text.trim().length > 0);
  if (candidateText) return candidateText;

  for (const step of payload.steps ?? []) {
    for (const content of step.content ?? []) {
      if (content.type === "text" && content.text) return content.text;
    }
  }

  return undefined;
}

function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Gemini extraction response was not valid JSON.");
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new Error("Gemini extraction response was not valid JSON.");
    }
  }
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") {
    return normalized;
  }
  return "image/png";
}

async function buildGeminiErrorMessage(
  response: Response,
  operation: "extraction" | "validation" | "crop reOCR"
): Promise<string> {
  const fallback = `Gemini ${operation} request failed with status ${response.status}.`;

  try {
    const body = (await response.text()) || "";
    const parsed = JSON.parse(body) as GeminiErrorResponse;
    const message = parsed.error?.message;

    return message ? `Gemini ${operation} request failed: ${message}` : fallback;
  } catch {
    return fallback;
  }
}
