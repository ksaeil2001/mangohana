import { listLocalAiModels, testLocalAiConnection, type LocalAiRuntime } from "./localAiClient.js";
import { DEFAULT_MANGA_OCR_ENDPOINT, normalizeMangaOcrEndpoint } from "./localMangaOcr.js";
import type { LocalInpaintingProvider } from "./localInpainting.js";
import type { ProviderStatusReport } from "./environmentPreparation.js";

export type LocalAiProbeResult = {
  ready: boolean;
  message: string;
  disabledReason?: string;
  modelCount?: number;
};

export type LocalOcrProbeResult = {
  ready: boolean;
  message: string;
  disabledReason?: string;
};

export type LocalInpaintingProbeResult = {
  ready: boolean;
  message: string;
  disabledReason?: string;
};

export function isModelMatch(candidate: string | undefined, target: string): boolean {
  if (!candidate || !target) return false;
  const cleanCandidate = candidate.trim().toLowerCase();
  const cleanTarget = target.trim().toLowerCase();
  if (cleanCandidate === cleanTarget) return true;

  // Canonicalize tag: if no tag is specified, defaults to :latest
  const candWithTag = cleanCandidate.includes(":") ? cleanCandidate : `${cleanCandidate}:latest`;
  const targWithTag = cleanTarget.includes(":") ? cleanTarget : `${cleanTarget}:latest`;
  return candWithTag === targWithTag;
}

export type EvaluateProviderReadinessOptions = {
  geminiConfigured: boolean;
  openAiConfigured?: boolean;
  productionOcrStatus?: {
    ready: boolean;
    message: string;
    disabledReason?: string;
  };
  ocrEngine?: "gemini" | "manga-ocr" | "paddle-ocr" | "hybrid" | "windows-ocr";
  translationEngine?: "gemini" | "local_ai";
  localAiRuntime?: LocalAiRuntime;
  localAiEndpoint?: string;
  selectedModel?: string;
  localOcrEndpoint?: string;
  mangaOcrEndpoint?: string;
  paddleOcrEndpoint?: string;
  localInpaintingProvider?: LocalInpaintingProvider;
  localInpaintingEndpoint?: string;
};

export async function probeLocalAiReadiness(options?: {
  runtime?: LocalAiRuntime;
  endpoint?: string;
  selectedModel?: string;
}): Promise<LocalAiProbeResult> {
  const runtime = options?.runtime || "ollama";
  const endpoint = options?.endpoint || "http://localhost:11434";
  const selectedModel = options?.selectedModel?.trim();

  try {
    const testResult = await testLocalAiConnection({ runtime, endpoint });
    if (!testResult.ok) {
      return {
        ready: false,
        message: testResult.message,
        disabledReason: testResult.message
      };
    }

    const models = await listLocalAiModels({ runtime, endpoint }).catch(() => []);
    if (models.length === 0) {
      return {
        ready: false,
        message: `로컬 AI 서버(${runtime})에 연결되었으나 설치된 모델이 없습니다.`,
        disabledReason: "로컬 AI 모델(qwen2.5:7b-instruct 등)을 설치해야 로컬 번역을 실행할 수 있습니다.",
        modelCount: 0
      };
    }

    if (selectedModel) {
      const modelExists = models.some(
        (m) => isModelMatch(m.id, selectedModel) || isModelMatch(m.name, selectedModel)
      );
      if (!modelExists) {
        return {
          ready: false,
          message: `로컬 AI 서버(${runtime})에 선택된 모델(${selectedModel})이 설치되어 있지 않습니다.`,
          disabledReason: `선택된 로컬 AI 모델(${selectedModel})을 설치하거나 설치된 모델을 선택하세요.`,
          modelCount: models.length
        };
      }
    }

    return {
      ready: true,
      message: `로컬 AI 번역 엔진(${runtime})이 준비되었습니다. (${models.length}개 모델 설치됨${selectedModel ? `, ${selectedModel} 사용` : ""})`,
      modelCount: models.length
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      message: `로컬 AI 서버 연결 실패: ${msg}`,
      disabledReason: `로컬 AI 서버(${endpoint})가 실행 중인지 확인하세요.`
    };
  }
}

export async function probeLocalOcrReadiness(options?: {
  endpoint?: string;
}): Promise<LocalOcrProbeResult> {
  const rawEndpoint = options?.endpoint || DEFAULT_MANGA_OCR_ENDPOINT;
  const testUrl = normalizeMangaOcrEndpoint(rawEndpoint);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    // Quick probe with GET or HEAD
    const response = await fetch(testUrl, {
      method: "GET",
      signal: controller.signal
    }).catch(async () => {
      // If GET fails with 405 Method Not Allowed or similar, try HEAD
      return fetch(testUrl, {
        method: "HEAD",
        signal: controller.signal
      });
    });

    // 200 and 405 (Method Not Allowed) indicate an active endpoint server
    // Note: 404 is intentionally excluded as it means the OCR route is missing
    if (response.ok || response.status === 405) {
      return {
        ready: true,
        message: "로컬 온디바이스 OCR(PaddleOCR/Manga-OCR)이 준비되었습니다."
      };
    }

    return {
      ready: false,
      message: `로컬 OCR 서버 응답 오류 (HTTP ${response.status})`,
      disabledReason: "PaddleOCR/Manga-OCR 로컬 서버를 준비해야 로컬 OCR을 실행할 수 있습니다."
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      message: `로컬 OCR 서버 연결 실패: ${msg}`,
      disabledReason: "PaddleOCR/Manga-OCR 로컬 서버를 준비해야 로컬 OCR을 실행할 수 있습니다."
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function probeLocalInpaintingReadiness(options?: {
  provider?: LocalInpaintingProvider;
  endpoint?: string;
}): Promise<LocalInpaintingProbeResult> {
  const provider = options?.provider || "local-lama";
  const defaultEndpoint = provider === "sd-webui"
    ? "http://localhost:7860/sdapi/v1/img2img"
    : provider === "comfyui"
      ? "http://localhost:8188/prompt"
      : "http://localhost:8080/inpaint";
  const endpoint = options?.endpoint || defaultEndpoint;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: controller.signal
    }).catch(async () => {
      return fetch(endpoint, {
        method: "HEAD",
        signal: controller.signal
      });
    });

    // 200 and 405 (Method Not Allowed) indicate an active endpoint server
    // Note: 404 is excluded as it means the endpoint route does not exist
    if (response.ok || response.status === 405) {
      return {
        ready: true,
        message: `로컬 인페인팅 엔진(${provider})이 준비되었습니다.`
      };
    }

    return {
      ready: false,
      message: `로컬 인페인팅 서버 응답 오류 (HTTP ${response.status})`,
      disabledReason: "인페인팅 리소스가 준비될 때까지 인페인팅을 사용할 수 없습니다."
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      message: `로컬 인페인팅 서버 연결 실패: ${msg}`,
      disabledReason: "인페인팅 리소스가 준비될 때까지 인페인팅을 사용할 수 없습니다."
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function evaluateProviderReadiness(
  options: EvaluateProviderReadinessOptions
): Promise<ProviderStatusReport> {
  const { geminiConfigured, openAiConfigured } = options;

  // Legacy OCR probing is retained only for experimental callers. Production
  // supplies a fixed signed-pack status and never enters provider routing.
  let ocrReady = false;
  let ocrMessage = "OCR 엔진(Gemini API 키 또는 PaddleOCR/Manga-OCR)이 설정되지 않았습니다.";
  let ocrDisabledReason: string | undefined =
    "Gemini API 키를 등록하거나 PaddleOCR/Manga-OCR 로컬 서버를 준비해야 OCR을 실행할 수 있습니다.";

  if (options.productionOcrStatus) {
    ocrReady = options.productionOcrStatus.ready;
    ocrMessage = options.productionOcrStatus.message;
    ocrDisabledReason = options.productionOcrStatus.disabledReason;
  } else if (options.ocrEngine === "gemini") {
    if (geminiConfigured) {
      ocrReady = true;
      ocrMessage = "Gemini OCR 엔진이 준비되었습니다.";
      ocrDisabledReason = undefined;
    } else {
      ocrReady = false;
      ocrMessage = "Gemini OCR API 키가 설정되지 않았습니다.";
      ocrDisabledReason = "Gemini OCR을 사용하려면 설정에서 Gemini API 키를 등록해야 합니다.";
    }
  } else if (options.ocrEngine === "manga-ocr") {
    const localOcr = await probeLocalOcrReadiness({
      endpoint: options.mangaOcrEndpoint || options.localOcrEndpoint || DEFAULT_MANGA_OCR_ENDPOINT
    });
    ocrReady = localOcr.ready;
    ocrMessage = localOcr.ready ? "로컬 Manga-OCR 엔진이 준비되었습니다." : localOcr.message;
    ocrDisabledReason = localOcr.disabledReason;
  } else if (options.ocrEngine === "paddle-ocr") {
    const localOcr = await probeLocalOcrReadiness({
      endpoint: options.paddleOcrEndpoint || "http://localhost:5001/ocr"
    });
    ocrReady = localOcr.ready;
    ocrMessage = localOcr.ready ? "로컬 PaddleOCR 엔진이 준비되었습니다." : localOcr.message;
    ocrDisabledReason = localOcr.disabledReason ?? "PaddleOCR 로컬 서버(localhost:5001)가 실행 중인지 확인하세요.";
  } else if (options.ocrEngine === "hybrid") {
    const mangaEndpoint = options.mangaOcrEndpoint || options.localOcrEndpoint || DEFAULT_MANGA_OCR_ENDPOINT;
    const paddleEndpoint = options.paddleOcrEndpoint || "http://localhost:5001/ocr";
    const [mangaRes, paddleRes] = await Promise.all([
      geminiConfigured ? Promise.resolve({ ready: true, message: "Gemini OK" }) : probeLocalOcrReadiness({ endpoint: mangaEndpoint }),
      probeLocalOcrReadiness({ endpoint: paddleEndpoint })
    ]);
    if (mangaRes.ready && paddleRes.ready) {
      ocrReady = true;
      ocrMessage = "하이브리드 OCR 엔진(MangaOCR + PaddleOCR)이 준비되었습니다.";
      ocrDisabledReason = undefined;
    } else {
      ocrReady = false;
      ocrMessage = "하이브리드 OCR을 위한 로컬 서버가 준비되지 않았습니다.";
      ocrDisabledReason = `Manga-OCR(${mangaRes.ready ? "정상" : "미준비"}) 및 PaddleOCR(${paddleRes.ready ? "정상" : "미준비"}) 서버를 확인하세요.`;
    }
  } else {
    // Unspecified default: Gemini first, then local probe
    if (geminiConfigured) {
      ocrReady = true;
      ocrMessage = "Gemini OCR 엔진이 준비되었습니다.";
      ocrDisabledReason = undefined;
    } else {
      const localOcr = await probeLocalOcrReadiness({ endpoint: options.localOcrEndpoint });
      if (localOcr.ready) {
        ocrReady = true;
        ocrMessage = localOcr.message;
        ocrDisabledReason = undefined;
      } else if (localOcr.disabledReason) {
        ocrDisabledReason = localOcr.disabledReason;
      }
    }
  }

  // 2. Translation evaluation: check selected engine
  let translationReady = false;
  let translationMessage = "번역 엔진(Gemini API 키 또는 로컬 AI 서버)이 설정되지 않았습니다.";
  let translationDisabledReason: string | undefined =
    "Gemini API 키를 등록하거나 로컬 AI 서버(Ollama 등)를 연결해야 번역을 실행할 수 있습니다.";

  if (options.translationEngine === "gemini") {
    if (geminiConfigured) {
      translationReady = true;
      translationMessage = "Gemini 번역 엔진이 준비되었습니다.";
      translationDisabledReason = undefined;
    } else {
      translationReady = false;
      translationMessage = "Gemini 번역 API 키가 설정되지 않았습니다.";
      translationDisabledReason = "Gemini 번역을 사용하려면 설정에서 Gemini API 키를 등록해야 합니다.";
    }
  } else if (options.translationEngine === "local_ai") {
    const localAi = await probeLocalAiReadiness({
      runtime: options.localAiRuntime,
      endpoint: options.localAiEndpoint,
      selectedModel: options.selectedModel
    });
    translationReady = localAi.ready;
    translationMessage = localAi.message;
    translationDisabledReason = localAi.disabledReason;
  } else {
    // Unspecified default: Gemini first, then local probe
    if (geminiConfigured) {
      translationReady = true;
      translationMessage = "Gemini 번역 엔진이 준비되었습니다.";
      translationDisabledReason = undefined;
    } else {
      const localAi = await probeLocalAiReadiness({
        runtime: options.localAiRuntime,
        endpoint: options.localAiEndpoint,
        selectedModel: options.selectedModel
      });
      if (localAi.ready) {
        translationReady = true;
        translationMessage = localAi.message;
        translationDisabledReason = undefined;
      } else if (localAi.disabledReason) {
        translationDisabledReason = localAi.disabledReason;
      }
    }
  }

  // 3. Inpainting evaluation: Gemini / OpenAI cloud first, fallback to local inpainting probe
  let inpaintingReady = false;
  let inpaintingMessage = "인페인팅 엔진(Gemini 또는 OpenAI/로컬)이 설정되지 않았습니다.";
  let inpaintingDisabledReason: string | undefined =
    "Gemini API 키 또는 지원 인페인팅 엔진이 준비될 때까지 인페인팅을 사용할 수 없습니다.";

  if (geminiConfigured || openAiConfigured) {
    inpaintingReady = true;
    inpaintingMessage = geminiConfigured
      ? "Gemini 인페인팅 엔진이 준비되었습니다."
      : "OpenAI 인페인팅 엔진이 준비되었습니다.";
    inpaintingDisabledReason = undefined;
  } else {
    const localInpaint = await probeLocalInpaintingReadiness({
      provider: options.localInpaintingProvider,
      endpoint: options.localInpaintingEndpoint
    });
    if (localInpaint.ready) {
      inpaintingReady = true;
      inpaintingMessage = localInpaint.message;
      inpaintingDisabledReason = undefined;
    } else if (localInpaint.disabledReason) {
      inpaintingDisabledReason = localInpaint.disabledReason;
    }
  }

  return {
    ocrReady,
    translationReady,
    inpaintingReady,
    ocrMessage,
    translationMessage,
    inpaintingMessage,
    ocrDisabledReason,
    translationDisabledReason,
    inpaintingDisabledReason
  };
}
