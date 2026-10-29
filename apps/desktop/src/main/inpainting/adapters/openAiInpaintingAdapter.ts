import { buildInpaintingPrompt } from "../../../shared/inpainting.js";
import type {
  InpaintExecutionRequest,
  InpaintExecutionResult,
  InpaintingProvider
} from "../../../shared/inpainting.js";
import { editImageWithOpenAI } from "../../openAiImageEdit.js";
import type { InpaintingEngine, InpaintingEngineAvailability } from "../types.js";

export class OpenAiInpaintingAdapter implements InpaintingEngine {
  readonly providerId: InpaintingProvider = "openai";
  readonly displayName = "OpenAI DALL-E";
  readonly isLocal = false;

  async isAvailable(): Promise<InpaintingEngineAvailability> {
    const hasKey = typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim().length > 0;
    if (!hasKey) {
      return {
        available: false,
        reason: "OPENAI_API_KEY 환경 변수 또는 등록된 API 키가 없습니다."
      };
    }
    return { available: true };
  }

  async inpaint(request: InpaintExecutionRequest): Promise<InpaintExecutionResult> {
    const startTime = Date.now();
    const prompt = buildInpaintingPrompt(request.mode, request.promptOverride);
    const editedImageBytes = await editImageWithOpenAI({
      imageBytes: request.imageBytes,
      maskBytes: request.maskBytes,
      prompt,
      signal: request.signal
    });

    return {
      editedImageBytes,
      provider: this.providerId,
      durationMs: Date.now() - startTime
    };
  }
}
