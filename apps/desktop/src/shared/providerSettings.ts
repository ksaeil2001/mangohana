import { ocrEngines, type OcrEngine } from "./speechBubbleExtraction.js";

export type LocalAiRuntime = "ollama" | "lmstudio" | "vllm" | "custom";
export type LocalInpaintingProvider = "local-lama" | "sd-webui" | "comfyui";

export type ProviderSettings = {
  theme: "system" | "light" | "dark";
  geminiModel: string;
  translationEngine: "gemini" | "local_ai";
  translationStyle: string;
  ocrEngine: OcrEngine;
  ocrEndpoint: string;
  mangaOcrEndpoint?: string;
  paddleOcrEndpoint?: string;
  localAiRuntime: LocalAiRuntime;
  localAiEndpoint: string;
  localAiModel: string;
  localInpaintingProvider: LocalInpaintingProvider;
  localInpaintingEndpoint: string;
  autoBackupInterval: string;
  defaultFont: string;
  defaultFontSize: string;
  smartWrap: boolean;
  appLanguage: string;
  startScreen: string;
  defaultStoragePath: string;
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  theme: "light",
  geminiModel: "gemini-2.5-flash",
  translationEngine: "gemini",
  translationStyle: "natural",
  ocrEngine: "gemini",
  ocrEndpoint: "http://localhost:5000/ocr",
  mangaOcrEndpoint: "http://localhost:5000/ocr",
  paddleOcrEndpoint: "http://localhost:5001/ocr",
  localAiRuntime: "ollama",
  localAiEndpoint: "http://localhost:11434",
  localAiModel: "qwen2.5:7b-instruct",
  localInpaintingProvider: "local-lama",
  localInpaintingEndpoint: "http://localhost:8080/inpaint",
  autoBackupInterval: "15",
  defaultFont: "Noto Sans KR",
  defaultFontSize: "16",
  smartWrap: true,
  appLanguage: "ko",
  startScreen: "home",
  defaultStoragePath: "기본 문서 폴더 (Trio Projects)"
};

export function validateProviderSettingsPatch(input: unknown): Partial<ProviderSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid provider settings patch: payload must be an object");
  }

  const record = input as Record<string, unknown>;
  const patch: Partial<ProviderSettings> = {};

  if ("theme" in record) {
    if (record.theme !== "system" && record.theme !== "light" && record.theme !== "dark") {
      throw new Error(`Invalid provider settings patch: theme must be 'system', 'light', or 'dark', received ${String(record.theme)}`);
    }
    patch.theme = record.theme;
  }

  if ("geminiModel" in record) {
    if (typeof record.geminiModel !== "string" || !record.geminiModel.trim()) {
      throw new Error("Invalid provider settings patch: geminiModel must be a non-empty string");
    }
    patch.geminiModel = record.geminiModel.trim();
  }

  if ("translationEngine" in record) {
    if (record.translationEngine !== "gemini" && record.translationEngine !== "local_ai") {
      throw new Error(`Invalid provider settings patch: translationEngine must be 'gemini' or 'local_ai', received ${String(record.translationEngine)}`);
    }
    patch.translationEngine = record.translationEngine;
  }

  if ("translationStyle" in record) {
    if (typeof record.translationStyle !== "string") {
      throw new Error("Invalid provider settings patch: translationStyle must be a string");
    }
    patch.translationStyle = record.translationStyle;
  }

  if ("ocrEngine" in record) {
    if (typeof record.ocrEngine !== "string" || !(ocrEngines as readonly string[]).includes(record.ocrEngine)) {
      throw new Error(`Invalid provider settings patch: ocrEngine must be one of [${ocrEngines.join(", ")}], received ${String(record.ocrEngine)}`);
    }
    patch.ocrEngine = record.ocrEngine as OcrEngine;
  }

  if ("ocrEndpoint" in record) {
    if (typeof record.ocrEndpoint !== "string") {
      throw new Error("Invalid provider settings patch: ocrEndpoint must be a string");
    }
    patch.ocrEndpoint = record.ocrEndpoint;
  }

  if ("mangaOcrEndpoint" in record) {
    if (record.mangaOcrEndpoint !== undefined && typeof record.mangaOcrEndpoint !== "string") {
      throw new Error("Invalid provider settings patch: mangaOcrEndpoint must be a string or undefined");
    }
    patch.mangaOcrEndpoint = record.mangaOcrEndpoint;
  }

  if ("paddleOcrEndpoint" in record) {
    if (record.paddleOcrEndpoint !== undefined && typeof record.paddleOcrEndpoint !== "string") {
      throw new Error("Invalid provider settings patch: paddleOcrEndpoint must be a string or undefined");
    }
    patch.paddleOcrEndpoint = record.paddleOcrEndpoint;
  }

  if ("localAiRuntime" in record) {
    const validRuntimes = ["ollama", "lmstudio", "vllm", "custom"];
    if (typeof record.localAiRuntime !== "string" || !validRuntimes.includes(record.localAiRuntime)) {
      throw new Error(`Invalid provider settings patch: localAiRuntime must be one of [${validRuntimes.join(", ")}], received ${String(record.localAiRuntime)}`);
    }
    patch.localAiRuntime = record.localAiRuntime as LocalAiRuntime;
  }

  if ("localAiEndpoint" in record) {
    if (typeof record.localAiEndpoint !== "string") {
      throw new Error("Invalid provider settings patch: localAiEndpoint must be a string");
    }
    patch.localAiEndpoint = record.localAiEndpoint;
  }

  if ("localAiModel" in record) {
    if (typeof record.localAiModel !== "string") {
      throw new Error("Invalid provider settings patch: localAiModel must be a string");
    }
    patch.localAiModel = record.localAiModel;
  }

  if ("localInpaintingProvider" in record) {
    const validProviders = ["local-lama", "sd-webui", "comfyui"];
    if (typeof record.localInpaintingProvider !== "string" || !validProviders.includes(record.localInpaintingProvider)) {
      throw new Error(`Invalid provider settings patch: localInpaintingProvider must be one of [${validProviders.join(", ")}], received ${String(record.localInpaintingProvider)}`);
    }
    patch.localInpaintingProvider = record.localInpaintingProvider as LocalInpaintingProvider;
  }

  if ("localInpaintingEndpoint" in record) {
    if (typeof record.localInpaintingEndpoint !== "string") {
      throw new Error("Invalid provider settings patch: localInpaintingEndpoint must be a string");
    }
    patch.localInpaintingEndpoint = record.localInpaintingEndpoint;
  }

  if ("autoBackupInterval" in record) {
    if (typeof record.autoBackupInterval !== "string") {
      throw new Error("Invalid provider settings patch: autoBackupInterval must be a string");
    }
    patch.autoBackupInterval = record.autoBackupInterval;
  }

  if ("defaultFont" in record) {
    if (typeof record.defaultFont !== "string") {
      throw new Error("Invalid provider settings patch: defaultFont must be a string");
    }
    patch.defaultFont = record.defaultFont;
  }

  if ("defaultFontSize" in record) {
    if (typeof record.defaultFontSize !== "string") {
      throw new Error("Invalid provider settings patch: defaultFontSize must be a string");
    }
    patch.defaultFontSize = record.defaultFontSize;
  }

  if ("smartWrap" in record) {
    if (typeof record.smartWrap !== "boolean") {
      throw new Error("Invalid provider settings patch: smartWrap must be a boolean");
    }
    patch.smartWrap = record.smartWrap;
  }

  if ("appLanguage" in record) {
    if (typeof record.appLanguage !== "string") {
      throw new Error("Invalid provider settings patch: appLanguage must be a string");
    }
    patch.appLanguage = record.appLanguage;
  }

  if ("startScreen" in record) {
    if (typeof record.startScreen !== "string") {
      throw new Error("Invalid provider settings patch: startScreen must be a string");
    }
    patch.startScreen = record.startScreen;
  }

  if ("defaultStoragePath" in record) {
    if (typeof record.defaultStoragePath !== "string") {
      throw new Error("Invalid provider settings patch: defaultStoragePath must be a string");
    }
    patch.defaultStoragePath = record.defaultStoragePath;
  }

  return patch;
}
