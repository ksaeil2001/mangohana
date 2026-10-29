export type LocalAiRuntime = "ollama" | "lmstudio" | "vllm" | "custom";

export type LocalAiModelPreset = {
  id: string;
  name: string;
  recommendedVram: string;
  description: string;
};

export const MANGA_LOCAL_MODEL_PRESETS: readonly LocalAiModelPreset[] = [
  {
    id: "qwen2.5:7b-instruct",
    name: "Qwen 2.5 7B Instruct",
    recommendedVram: "6GB ~ 8GB VRAM (CUDA 권장)",
    description: "일본어·영어 만화 대사 번역 정확도 및 뉘앙스 최상위 모델"
  },
  {
    id: "llama3.2:3b",
    name: "Llama 3.2 3B",
    recommendedVram: "4GB VRAM (초경량·초고속)",
    description: "가벼운 VRAM 환경에서도 빠른 속도로 대사 초안을 생성"
  },
  {
    id: "deepseek-r1:7b",
    name: "DeepSeek R1 7B",
    recommendedVram: "8GB VRAM",
    description: "문맥 추론 기반의 고품질 만화/소설 번역"
  },
  {
    id: "gemma2:9b",
    name: "Gemma 2 9B",
    recommendedVram: "8GB ~ 12GB VRAM",
    description: "자연스럽고 생생한 한국어 구어체 표현"
  }
] as const;

export type TestLocalAiConnectionArgs = {
  runtime: LocalAiRuntime;
  endpoint: string;
};

export type TestLocalAiConnectionResult = {
  ok: boolean;
  message: string;
  latencyMs?: number;
  version?: string;
  hardwareAcceleration?: string;
};

export type LocalAiModelInfo = {
  id: string;
  name: string;
  size?: string;
  modifiedAt?: string;
};

export type ListLocalAiModelsArgs = {
  runtime: LocalAiRuntime;
  endpoint: string;
};

export type GenerateLocalAiTranslationArgs = {
  runtime?: LocalAiRuntime;
  endpoint: string;
  model: string;
  sourceText: string;
  sourceLanguage?: "ja" | "en" | "auto";
  previousContext?: string[];
  characterNotes?: string;
  glossaryNotes?: string;
  systemPrompt?: string;
  temperature?: number;
  numCtx?: number;
  gpuLayers?: number;
  signal?: AbortSignal;
};


const DEFAULT_TIMEOUT_MS = 5000;

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "http://localhost:11434";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function formatByteSize(bytes?: number): string | undefined {
  if (typeof bytes !== "number" || isNaN(bytes) || bytes <= 0) return undefined;
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export async function testLocalAiConnection(
  args: TestLocalAiConnectionArgs
): Promise<TestLocalAiConnectionResult> {
  const base = normalizeEndpoint(args.endpoint);
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    if (args.runtime === "ollama") {
      const response = await fetch(`${base}/api/version`, {
        method: "GET",
        signal: controller.signal
      }).catch(async () => {
        // Fallback to /api/tags if /api/version is unavailable
        return fetch(`${base}/api/tags`, { method: "GET", signal: controller.signal });
      });

      const latencyMs = Date.now() - startTime;
      if (!response.ok) {
        return {
          ok: false,
          message: `Ollama 응답 오류 (HTTP ${response.status}: ${response.statusText})`,
          latencyMs
        };
      }

      const data = (await response.json().catch(() => ({}))) as { version?: string };
      return {
        ok: true,
        message: `Ollama 서버에 성공적으로 연결되었습니다. (${latencyMs}ms)`,
        latencyMs,
        version: data.version
      };
    } else {
      // LM Studio / vLLM / Custom (OpenAI compatible /v1/models)
      const response = await fetch(`${base}/v1/models`, {
        method: "GET",
        signal: controller.signal
      });

      const latencyMs = Date.now() - startTime;
      if (!response.ok) {
        return {
          ok: false,
          message: `로컬 AI 서버 응답 오류 (HTTP ${response.status}: ${response.statusText})`,
          latencyMs
        };
      }

      return {
        ok: true,
        message: `로컬 AI 서버에 성공적으로 연결되었습니다. (${latencyMs}ms)`,
        latencyMs
      };
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        message: `서버 연결 시간 초과 (${DEFAULT_TIMEOUT_MS / 1000}초 초과)`,
        latencyMs
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `서버에 연결할 수 없습니다 (${message}). 로컬 서버가 실행 중인지 확인하세요.`,
      latencyMs
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function listLocalAiModels(
  args: ListLocalAiModelsArgs
): Promise<LocalAiModelInfo[]> {
  const base = normalizeEndpoint(args.endpoint);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    if (args.runtime === "ollama") {
      const response = await fetch(`${base}/api/tags`, {
        method: "GET",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Ollama 모델 목록 조회 실패 (HTTP ${response.status})`);
      }

      const data = (await response.json()) as {
        models?: Array<{ name: string; model?: string; size?: number; modified_at?: string }>;
      };

      if (!data.models || !Array.isArray(data.models)) return [];

      return data.models.map((item) => ({
        id: item.name || item.model || "unknown",
        name: item.name || item.model || "unknown",
        size: formatByteSize(item.size),
        modifiedAt: item.modified_at
      }));
    } else {
      // LM Studio / vLLM / OpenAI compatible
      const response = await fetch(`${base}/v1/models`, {
        method: "GET",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`로컬 모델 목록 조회 실패 (HTTP ${response.status})`);
      }

      const data = (await response.json()) as {
        data?: Array<{ id: string; object?: string; owned_by?: string }>;
      };

      if (!data.data || !Array.isArray(data.data)) return [];

      return data.data.map((item) => ({
        id: item.id,
        name: item.id
      }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`로컬 AI 모델 목록을 가져오지 못했습니다: ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function generateLocalAiTranslation(
  args: GenerateLocalAiTranslationArgs
): Promise<string> {
  if (args.signal?.aborted) {
    throw new Error("로컬 AI 번역 요청이 취소되었습니다.");
  }

  const base = normalizeEndpoint(args.endpoint);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for generation

  const onAbort = () => controller.abort();
  if (args.signal) {
    args.signal.addEventListener("abort", onAbort, { once: true });
  }

  const systemInstructions =
    args.systemPrompt?.trim() ||
    "당신은 일본어/영어 만화 및 웹툰 대사를 자연스럽고 생생한 한국어로 번역하는 전문 만화 번역가입니다. 대사의 뉘앙스, 캐릭터 말투, 상황적 맥락을 살려 번역문만 정확히 출력하십시오. 설명이나 부연 해설, 따옴표 없이 번역문만 반환하십시오.";

  const contextPromptParts: string[] = [];
  if (args.characterNotes?.trim()) {
    contextPromptParts.push(`[등장인물 설정]\n${args.characterNotes.trim()}`);
  }
  if (args.glossaryNotes?.trim()) {
    contextPromptParts.push(`[용어집/사전]\n${args.glossaryNotes.trim()}`);
  }
  if (args.previousContext && args.previousContext.length > 0) {
    contextPromptParts.push(
      `[이전 대사 문맥]\n${args.previousContext.slice(-5).join("\n")}`
    );
  }

  const userContent =
    contextPromptParts.length > 0
      ? `${contextPromptParts.join("\n\n")}\n\n[번역할 원문 대사]\n${args.sourceText}`
      : args.sourceText;

  try {
    const requestBody: Record<string, unknown> = {
      model: args.model,
      messages: [
        { role: "system", content: systemInstructions },
        { role: "user", content: userContent }
      ],
      temperature: args.temperature ?? 0.3,
      stream: false
    };

    if (args.numCtx || args.gpuLayers !== undefined) {
      requestBody.options = {
        ...(args.numCtx ? { num_ctx: args.numCtx } : {}),
        ...(args.gpuLayers !== undefined ? { num_gpu: args.gpuLayers } : {})
      };
    }

    let response: Response;
    response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    }).catch(async (fetchError) => {
      if (args.runtime === "ollama" || !args.runtime) {
        return fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: args.model,
            messages: [
              { role: "system", content: systemInstructions },
              { role: "user", content: userContent }
            ],
            stream: false,
            options: {
              temperature: args.temperature ?? 0.3,
              ...(args.numCtx ? { num_ctx: args.numCtx } : {}),
              ...(args.gpuLayers !== undefined ? { num_gpu: args.gpuLayers } : {})
            }
          })
        });
      }
      throw fetchError;
    });

    if (response.status === 404 && (args.runtime === "ollama" || !args.runtime)) {
      response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: args.model,
          messages: [
            { role: "system", content: systemInstructions },
            { role: "user", content: userContent }
          ],
          stream: false,
          options: {
            temperature: args.temperature ?? 0.3,
            ...(args.numCtx ? { num_ctx: args.numCtx } : {}),
            ...(args.gpuLayers !== undefined ? { num_gpu: args.gpuLayers } : {})
          }
        })
      });
    }

    if (!response.ok) {
      const errorText = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      throw new Error(
        `로컬 AI 번역 요청 실패 (HTTP ${response.status}): ${errorText || response.statusText}`
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string };
        text?: string;
      }>;
      message?: { content?: string };
    };

    const rawResult =
      data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? data.message?.content ?? "";

    // Clean up DeepSeek / Reasoning thoughts (<think>...</think>) and surrounding quotes/codeblocks
    const cleaned = rawResult
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^```[\w]*\n?/gi, "")
      .replace(/\n?```$/gi, "")
      .trim();

    const unquoted = cleaned
      .replace(/^["'「『]([\s\S]*)["'」』]$/, "$1")
      .trim();

    return unquoted || cleaned;

  } catch (error) {
    if (args.signal?.aborted) {
      throw new Error("로컬 AI 번역 요청이 취소되었습니다.");
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("로컬 AI 번역 요청 시간이 초과되었습니다 (30초).");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`로컬 AI 번역 실패: ${message}`);
  } finally {
    clearTimeout(timeoutId);
    if (args.signal) {
      args.signal.removeEventListener("abort", onAbort);
    }
  }
}
