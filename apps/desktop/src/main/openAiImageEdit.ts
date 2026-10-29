import { createLinkedAbortController, isAbortError } from "./abortSignals.js";

type EditImageArgs = {
  imageBytes: Buffer;
  maskBytes: Buffer;
  prompt: string;
  signal?: AbortSignal;
};

type OpenAIImageEditResponse = {
  data?: Array<{
    b64_json?: string;
  }>;
};

type OpenAIErrorResponse = {
  error?: {
    message?: string;
  };
};

const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";

export async function editImageWithOpenAI(args: EditImageArgs): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to run inpainting.");
  }

  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || "dall-e-2";
  const formData = new FormData();
  formData.append("model", model);
  formData.append("image", new Blob([toBlobPart(args.imageBytes)], { type: "image/png" }), "source.png");
  formData.append("mask", new Blob([toBlobPart(args.maskBytes)], { type: "image/png" }), "mask.png");
  formData.append("prompt", args.prompt);
  formData.append("response_format", "b64_json");

  const linked = createLinkedAbortController(args.signal, 60_000);

  try {
    const response = await fetch(OPENAI_IMAGE_EDITS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: linked.signal,
      body: formData
    });

    if (!response.ok) {
      throw new Error(await buildOpenAIErrorMessage(response));
    }

    const payload = (await response.json()) as OpenAIImageEditResponse;
    const imageBase64 = payload.data?.[0]?.b64_json;

    if (!imageBase64) {
      throw new Error("OpenAI image edit response did not include image data.");
    }

    return Buffer.from(imageBase64, "base64");
  } catch (error) {
    if (isAbortError(error) && args.signal?.aborted) throw args.signal.reason ?? error;
    if (isAbortError(error) && linked.didTimeOut()) {
      throw new Error("OpenAI image edit request timed out after 60s.");
    }
    throw error;
  } finally {
    linked.dispose();
  }
}

function toBlobPart(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function buildOpenAIErrorMessage(response: Response): Promise<string> {
  const fallback = `OpenAI image edit request failed with status ${response.status}.`;

  try {
    const body = (await response.text()) || "";
    const parsed = JSON.parse(body) as OpenAIErrorResponse;
    const message = parsed.error?.message;

    return message ? `OpenAI image edit request failed: ${message}` : fallback;
  } catch {
    return fallback;
  }
}
