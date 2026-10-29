import { buildInpaintingPrompt } from "../../../shared/inpainting.js";
import type {
  InpaintExecutionRequest,
  InpaintExecutionResult,
  InpaintingProvider
} from "../../../shared/inpainting.js";
import { editImageWithGemini } from "../../geminiImageEdit.js";
import type { InpaintingEngine, InpaintingEngineAvailability } from "../types.js";

export class GeminiInpaintingAdapter implements InpaintingEngine {
  readonly providerId: InpaintingProvider = "gemini";
  readonly displayName = "Google Gemini";
  readonly isLocal = false;

  async isAvailable(): Promise<InpaintingEngineAvailability> {
    const hasKey = typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.trim().length > 0;
    if (!hasKey) {
      return {
        available: false,
        reason: "GEMINI_API_KEY 환경 변수 또는 등록된 API 키가 없습니다."
      };
    }
    return { available: true };
  }

  async inpaint(request: InpaintExecutionRequest): Promise<InpaintExecutionResult> {
    const startTime = Date.now();
    const prompt = buildInpaintingPrompt(request.mode, request.promptOverride);
    const editedImageBytes = await editImageWithGemini({
      imageBytes: request.imageBytes,
      maskBytes: request.maskBytes,
      sourceMimeType: request.sourceMimeType,
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
