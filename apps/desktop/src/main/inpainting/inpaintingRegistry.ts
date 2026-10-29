import type {
  InpaintExecutionRequest,
  InpaintExecutionResult,
  InpaintingProvider
} from "../../shared/inpainting.js";
import { GeminiInpaintingAdapter } from "./adapters/geminiInpaintingAdapter.js";
import { LocalInpaintingAdapter } from "./adapters/localInpaintingAdapter.js";
import { OpenAiInpaintingAdapter } from "./adapters/openAiInpaintingAdapter.js";
import type { InpaintingEngine, InpaintingEngineAvailability } from "./types.js";
import { throwIfAborted } from "../abortSignals.js";

export class InpaintingEngineRegistry {
  private readonly engines = new Map<InpaintingProvider, InpaintingEngine>();

  register(engine: InpaintingEngine): void {
    this.engines.set(engine.providerId, engine);
  }

  getEngine(provider: InpaintingProvider): InpaintingEngine | undefined {
    return this.engines.get(provider);
  }

  hasEngine(provider: InpaintingProvider): boolean {
    return this.engines.has(provider);
  }

  listEngines(): InpaintingEngine[] {
    return Array.from(this.engines.values());
  }

  async checkAvailability(provider: InpaintingProvider): Promise<InpaintingEngineAvailability> {
    const engine = this.engines.get(provider);
    if (!engine) {
      return {
        available: false,
        reason: `등록되지 않은 인페인팅 엔진입니다: ${provider}`
      };
    }
    return engine.isAvailable();
  }

  async execute(
    provider: InpaintingProvider,
    request: InpaintExecutionRequest
  ): Promise<InpaintExecutionResult> {
    const engine = this.engines.get(provider);
    if (!engine) {
      throw new Error(`지원하지 않거나 등록되지 않은 인페인팅 엔진입니다: ${provider}`);
    }

    throwIfAborted(request.signal);
    const availability = await engine.isAvailable();
    throwIfAborted(request.signal);
    if (!availability.available) {
      throw new Error(
        `인페인팅 엔진(${engine.displayName})을 사용할 수 없습니다: ${availability.reason ?? "가용성 확인 실패"}`
      );
    }

    return engine.inpaint(request);
  }

  /**
   * MangaTranslator 원칙: 생성형 AI 실패 또는 이상 발생 시 Fallback 엔진으로 자동 전환 실행.
   */
  async executeWithFallback(
    primaryProvider: InpaintingProvider,
    fallbackProvider: InpaintingProvider,
    request: InpaintExecutionRequest
  ): Promise<InpaintExecutionResult & { fallbackTriggered?: boolean; primaryError?: string }> {
    try {
      return await this.execute(primaryProvider, request);
    } catch (primaryError) {
      const errorMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      console.warn(
        `기본 인페인팅 엔진(${primaryProvider}) 실패, 폴백 엔진(${fallbackProvider})으로 전환합니다:`,
        errorMessage
      );

      const fallbackResult = await this.execute(fallbackProvider, request);
      return {
        ...fallbackResult,
        fallbackTriggered: true,
        primaryError: errorMessage
      };
    }
  }
}

export function createDefaultInpaintingRegistry(): InpaintingEngineRegistry {
  const registry = new InpaintingEngineRegistry();

  registry.register(new GeminiInpaintingAdapter());
  registry.register(new OpenAiInpaintingAdapter());
  registry.register(new LocalInpaintingAdapter("local-lama"));
  registry.register(new LocalInpaintingAdapter("local-aot"));
  registry.register(new LocalInpaintingAdapter("sd-webui"));
  registry.register(new LocalInpaintingAdapter("comfyui"));

  return registry;
}
