import { buildInpaintingPrompt } from "../../../shared/inpainting.js";
import type {
  InpaintExecutionRequest,
  InpaintExecutionResult,
  InpaintingProvider
} from "../../../shared/inpainting.js";
import {
  editImageWithLocalInpainting,
  type LocalInpaintingProvider
} from "../../localInpainting.js";
import type { InpaintingEngine, InpaintingEngineAvailability } from "../types.js";

const LOCAL_PROVIDER_DISPLAY_NAMES: Record<LocalInpaintingProvider, string> = {
  "local-lama": "Local LaMa (Manga)",
  "local-aot": "Local AOT-GAN (Manga)",
  "sd-webui": "Stable Diffusion WebUI",
  "comfyui": "ComfyUI"
};

export class LocalInpaintingAdapter implements InpaintingEngine {
  readonly providerId: LocalInpaintingProvider;
  readonly displayName: string;
  readonly isLocal = true;

  constructor(providerId: LocalInpaintingProvider, displayName?: string) {
    this.providerId = providerId;
    this.displayName = displayName ?? LOCAL_PROVIDER_DISPLAY_NAMES[providerId];
  }

  async isAvailable(): Promise<InpaintingEngineAvailability> {
    // Local endpoints can be checked or assumed ready for request attempt
    return { available: true };
  }

  async inpaint(request: InpaintExecutionRequest): Promise<InpaintExecutionResult> {
    const startTime = Date.now();
    const prompt = buildInpaintingPrompt(request.mode, request.promptOverride);
    const editedImageBytes = await editImageWithLocalInpainting({
      imageBytes: request.imageBytes,
      maskBytes: request.maskBytes,
      provider: this.providerId,
      prompt,
      endpoint: request.endpoint,
      signal: request.signal
    });

    return {
      editedImageBytes,
      provider: this.providerId,
      durationMs: Date.now() - startTime
    };
  }
}
