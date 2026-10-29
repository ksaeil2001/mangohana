import {
  buildSpeechBubbleValidationPrompt,
  normalizeSpeechBubbleExtractionResult
} from "../shared/speechBubbleExtraction.js";
import type { OcrCharacterContext, SpeechBubbleExtractionResult } from "../shared/speechBubbleExtraction.js";
import { createLinkedAbortController, isAbortError } from "./abortSignals.js";

type ValidateSpeechBubblesWithOpenAIArgs = {
  imageBytes: Buffer;
  sourceMimeType: string;
  geminiExtraction: SpeechBubbleExtractionResult;
  characters?: OcrCharacterContext[];
  signal?: AbortSignal;
};

type OpenAIResponsesPayload = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

type OpenAIErrorResponse = {
  error?: {
    message?: string;
  };
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_VALIDATION_MODEL = "gpt-5.5";

export async function validateSpeechBubblesWithOpenAI(
  args: ValidateSpeechBubblesWithOpenAIArgs
): Promise<SpeechBubbleExtractionResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to validate speech bubble extraction.");
  }

  const linked = createLinkedAbortController(args.signal, 45_000);

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      signal: linked.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_VALIDATION_MODEL || DEFAULT_OPENAI_VALIDATION_MODEL,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildSpeechBubbleValidationPrompt(args.geminiExtraction, args.characters ?? [])
              },
              {
                type: "input_image",
                image_url: buildImageDataUrl(args.sourceMimeType, args.imageBytes)
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_object"
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(await buildOpenAIErrorMessage(response));
    }

    const payload = (await response.json()) as OpenAIResponsesPayload;
    const text = findTextOutput(payload);
    if (!text) {
      throw new Error("OpenAI validation response did not include text output.");
    }

    return normalizeSpeechBubbleExtractionResult(
      parseJsonOutput(text),
      args.geminiExtraction.pageNumber
    );
  } catch (error) {
    if (isAbortError(error) && args.signal?.aborted) throw args.signal.reason ?? error;
    if (isAbortError(error) && linked.didTimeOut()) {
      throw new Error("OpenAI validation request timed out after 45s.");
    }
    throw error;
  } finally {
    linked.dispose();
  }
}

function findTextOutput(payload: OpenAIResponsesPayload): string | undefined {
  if (payload.output_text) return payload.output_text;

  for (const output of payload.output ?? []) {
    if (output.type !== undefined && output.type !== "message") continue;
    for (const content of output.content ?? []) {
      if ((content.type === undefined || content.type === "output_text") && content.text) {
        return content.text;
      }
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
      throw new Error("OpenAI validation response was not valid JSON.");
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new Error("OpenAI validation response was not valid JSON.");
    }
  }
}

function buildImageDataUrl(mimeType: string, imageBytes: Buffer): string {
  return `data:${normalizeImageMimeType(mimeType)};base64,${imageBytes.toString("base64")}`;
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") {
    return normalized;
  }
  return "image/png";
}

async function buildOpenAIErrorMessage(response: Response): Promise<string> {
  const fallback = `OpenAI validation request failed with status ${response.status}.`;

  try {
    const body = (await response.text()) || "";
    const parsed = JSON.parse(body) as OpenAIErrorResponse;
    const message = parsed.error?.message;

    return message ? `OpenAI validation request failed: ${message}` : fallback;
  } catch {
    return fallback;
  }
}
