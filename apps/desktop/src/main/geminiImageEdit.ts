import { fetchWithGeminiRetry } from "./geminiTransientRetry.js";

type EditImageWithGeminiArgs = {
  imageBytes: Buffer;
  maskBytes: Buffer;
  sourceMimeType: string;
  prompt: string;
  signal?: AbortSignal;
};

type GeminiImageResponse = {
  output_image?: {
    data?: string;
  };
  steps?: Array<{
    content?: Array<{
      type?: string;
      data?: string;
      mime_type?: string;
    }>;
  }>;
};

type GeminiErrorResponse = {
  error?: {
    message?: string;
  };
};

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
export const GEMINI_IMAGE_EDIT_ATTEMPT_TIMEOUT_MS = 60_000;

export async function editImageWithGemini(args: EditImageWithGeminiArgs): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to run Gemini inpainting.");
  }

  const response = await fetchWithGeminiRetry(
    GEMINI_INTERACTIONS_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        model: process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL,
        input: [
          { type: "text", text: buildGeminiPrompt(args.prompt) },
          {
            type: "image",
            mime_type: normalizeImageMimeType(args.sourceMimeType),
            data: args.imageBytes.toString("base64")
          },
          {
            type: "image",
            mime_type: "image/png",
            data: args.maskBytes.toString("base64")
          }
        ]
      })
    },
    {
      maxAttempts: 3,
      attemptTimeoutMs: GEMINI_IMAGE_EDIT_ATTEMPT_TIMEOUT_MS,
      signal: args.signal,
      operationLabel: "Gemini 이미지 편집"
    }
  );

  if (!response.ok) {
    throw new Error(await buildGeminiErrorMessage(response));
  }

  const payload = (await response.json()) as GeminiImageResponse;
  const imageBase64 = payload.output_image?.data ?? findImageOutput(payload);

  if (!imageBase64) {
    throw new Error("Gemini image edit response did not include image data.");
  }

  return Buffer.from(imageBase64, "base64");
}

function buildGeminiPrompt(basePrompt: string): string {
  return [
    basePrompt,
    "Use the second provided image as the edit mask.",
    "Only regenerate the transparent pixels in the mask image.",
    "Keep all opaque mask areas and all unselected source-image areas unchanged.",
    "Return one edited image only, without text explanations."
  ].join("\n");
}

function findImageOutput(payload: GeminiImageResponse): string | undefined {
  for (const step of payload.steps ?? []) {
    for (const content of step.content ?? []) {
      if (content.type === "image" && content.data) return content.data;
    }
  }
  return undefined;
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") {
    return normalized;
  }
  return "image/png";
}

async function buildGeminiErrorMessage(response: Response): Promise<string> {
  const fallback = `Gemini image edit request failed with status ${response.status}.`;

  try {
    const body = (await response.text()) || "";
    const parsed = JSON.parse(body) as GeminiErrorResponse;
    const message = parsed.error?.message;

    return message ? `Gemini image edit request failed: ${message}` : fallback;
  } catch {
    return fallback;
  }
}
