import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultInpaintingRegistry,
  InpaintingEngineRegistry
} from "../../src/main/inpainting/inpaintingRegistry.js";
import type {
  InpaintingEngine,
  InpaintingEngineAvailability
} from "../../src/main/inpainting/types.js";
import type {
  InpaintExecutionRequest,
  InpaintExecutionResult,
  InpaintingProvider
} from "../../src/shared/inpainting.js";

describe("InpaintingEngineRegistry", () => {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }

    if (originalOpenAiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("registers, lists, and checks engines", () => {
    const registry = new InpaintingEngineRegistry();
    const mockEngine: InpaintingEngine = {
      providerId: "local-lama",
      displayName: "Mock LaMa",
      isLocal: true,
      isAvailable: async () => ({ available: true }),
      inpaint: async () => ({
        editedImageBytes: Buffer.from("mock-result"),
        provider: "local-lama"
      })
    };

    expect(registry.hasEngine("local-lama")).toBe(false);
    expect(registry.listEngines()).toHaveLength(0);

    registry.register(mockEngine);

    expect(registry.hasEngine("local-lama")).toBe(true);
    expect(registry.getEngine("local-lama")).toBe(mockEngine);
    expect(registry.listEngines()).toEqual([mockEngine]);
  });

  it("checks availability of registered and unregistered engines", async () => {
    const registry = new InpaintingEngineRegistry();

    const resultUnregistered = await registry.checkAvailability("gemini");
    expect(resultUnregistered.available).toBe(false);
    expect(resultUnregistered.reason).toContain("등록되지 않은 인페인팅 엔진");

    registry.register({
      providerId: "gemini",
      displayName: "Mock Gemini",
      isLocal: false,
      isAvailable: async () => ({ available: false, reason: "API key missing" }),
      inpaint: async () => ({
        editedImageBytes: Buffer.from(""),
        provider: "gemini"
      })
    });

    const resultRegistered = await registry.checkAvailability("gemini");
    expect(resultRegistered.available).toBe(false);
    expect(resultRegistered.reason).toBe("API key missing");
  });

  it("executes inpainting with registered engine", async () => {
    const registry = new InpaintingEngineRegistry();
    const mockInpaint = vi.fn().mockResolvedValue({
      editedImageBytes: Buffer.from("success-bytes"),
      provider: "local-aot",
      durationMs: 120
    });

    registry.register({
      providerId: "local-aot",
      displayName: "Mock AOT",
      isLocal: true,
      isAvailable: async () => ({ available: true }),
      inpaint: mockInpaint
    });

    const request: InpaintExecutionRequest = {
      imageBytes: Buffer.from("input-img"),
      maskBytes: Buffer.from("input-mask"),
      mode: "speech-bubble",
      sourceMimeType: "image/png"
    };

    const result = await registry.execute("local-aot", request);

    expect(result.editedImageBytes.toString()).toBe("success-bytes");
    expect(result.provider).toBe("local-aot");
    expect(mockInpaint).toHaveBeenCalledWith(request);
  });

  it("throws when trying to execute an unregistered provider", async () => {
    const registry = new InpaintingEngineRegistry();
    const request: InpaintExecutionRequest = {
      imageBytes: Buffer.from("input-img"),
      maskBytes: Buffer.from("input-mask"),
      mode: "speech-bubble",
      sourceMimeType: "image/png"
    };

    await expect(registry.execute("sd-webui", request)).rejects.toThrow(
      /지원하지 않거나 등록되지 않은/
    );
  });

  it("throws when engine is unavailable", async () => {
    const registry = new InpaintingEngineRegistry();
    registry.register({
      providerId: "openai",
      displayName: "Mock OpenAI",
      isLocal: false,
      isAvailable: async () => ({ available: false, reason: "Quota exceeded" }),
      inpaint: async () => ({
        editedImageBytes: Buffer.from(""),
        provider: "openai"
      })
    });

    const request: InpaintExecutionRequest = {
      imageBytes: Buffer.from("input-img"),
      maskBytes: Buffer.from("input-mask"),
      mode: "speech-bubble",
      sourceMimeType: "image/png"
    };

    await expect(registry.execute("openai", request)).rejects.toThrow(
      /인페인팅 엔진\(Mock OpenAI\)을 사용할 수 없습니다: Quota exceeded/
    );
  });

  it("createDefaultInpaintingRegistry sets up all standard providers", () => {
    const defaultRegistry = createDefaultInpaintingRegistry();

    expect(defaultRegistry.hasEngine("gemini")).toBe(true);
    expect(defaultRegistry.hasEngine("openai")).toBe(true);
    expect(defaultRegistry.hasEngine("local-lama")).toBe(true);
    expect(defaultRegistry.hasEngine("local-aot")).toBe(true);
    expect(defaultRegistry.hasEngine("sd-webui")).toBe(true);
    expect(defaultRegistry.hasEngine("comfyui")).toBe(true);
  });

  it("executes with fallback when primary provider fails (MangaTranslator principle)", async () => {
    const registry = new InpaintingEngineRegistry();
    const primaryEngine: InpaintingEngine = {
      providerId: "openai",
      displayName: "Mock OpenAI",
      isLocal: false,
      isAvailable: async () => ({ available: true }),
      inpaint: async () => {
        throw new Error("OpenAI API rate limited");
      }
    };
    const fallbackEngine: InpaintingEngine = {
      providerId: "local-lama",
      displayName: "Mock Local LaMa",
      isLocal: true,
      isAvailable: async () => ({ available: true }),
      inpaint: async () => ({
        editedImageBytes: Buffer.from("lama-fallback-result"),
        provider: "local-lama"
      })
    };

    registry.register(primaryEngine);
    registry.register(fallbackEngine);

    const request: InpaintExecutionRequest = {
      imageBytes: Buffer.from("source"),
      maskBytes: Buffer.from("mask"),
      mode: "speech-bubble",
      sourceMimeType: "image/png"
    };

    const result = await registry.executeWithFallback("openai", "local-lama", request);

    expect(result.fallbackTriggered).toBe(true);
    expect(result.provider).toBe("local-lama");
    expect(result.editedImageBytes.toString()).toBe("lama-fallback-result");
    expect(result.primaryError).toContain("rate limited");
  });
});
