import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  generateLocalAiTranslation,
  listLocalAiModels,
  testLocalAiConnection
} from "../../src/main/localAiClient.js";

describe("localAiClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("testLocalAiConnection", () => {
    it("successfully connects to Ollama endpoint", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.5.7" })
      } as Response);

      const result = await testLocalAiConnection({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("Ollama 서버에 성공적으로 연결되었습니다.");
      expect(result.version).toBe("0.5.7");
      expect(typeof result.latencyMs).toBe("number");
    });

    it("successfully connects to LM Studio / OpenAI-compatible endpoint", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "qwen2.5-7b" }] })
      } as Response);

      const result = await testLocalAiConnection({
        runtime: "lmstudio",
        endpoint: "http://localhost:1234"
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("로컬 AI 서버에 성공적으로 연결되었습니다.");
      expect(typeof result.latencyMs).toBe("number");
    });

    it("returns error status when endpoint returns HTTP error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error"
      } as Response);

      const result = await testLocalAiConnection({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("500");
    });

    it("returns connection failure when server is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await testLocalAiConnection({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("서버에 연결할 수 없습니다");
    });
  });

  describe("listLocalAiModels", () => {
    it("parses Ollama tags response into model list with formatted byte sizes", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            { name: "sakura-13b:latest", size: 8589934592, modified_at: "2026-01-01" },
            { name: "qwen2.5:7b", size: 4831838208, modified_at: "2026-02-01" }
          ]
        })
      } as Response);

      const models = await listLocalAiModels({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });

      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        id: "sakura-13b:latest",
        name: "sakura-13b:latest",
        size: "8.0 GB",
        modifiedAt: "2026-01-01"
      });
      expect(models[1]?.size).toBe("4.5 GB");
    });

    it("parses LM Studio / OpenAI-compatible models list", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: "sakura-13b-q4_k_m", object: "model" },
            { id: "llama-3.3-70b-instruct", object: "model" }
          ]
        })
      } as Response);

      const models = await listLocalAiModels({
        runtime: "lmstudio",
        endpoint: "http://localhost:1234"
      });

      expect(models).toHaveLength(2);
      expect(models[0]?.id).toBe("sakura-13b-q4_k_m");
      expect(models[1]?.name).toBe("llama-3.3-70b-instruct");
    });
  });

  describe("generateLocalAiTranslation", () => {
    it("sends chat completion request and cleans reasoning tags", async () => {
      let requestBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: "<think>대사를 한국어로 자연스럽게 바꾼다.</think>정말 고마워요!"
                }
              }
            ]
          })
        };
      });

      const translation = await generateLocalAiTranslation({
        endpoint: "http://localhost:11434",
        model: "sakura-13b-q4",
        sourceText: "本当にありがとう！",
        characterNotes: "유우키: 활발한 여고생",
        previousContext: ["안녕", "오늘 날씨 좋다"]
      });

      expect(translation).toBe("정말 고마워요!");
      expect(requestBody.model).toBe("sakura-13b-q4");
      expect(requestBody.messages[1].content).toContain("[등장인물 설정]\n유우키: 활발한 여고생");
      expect(requestBody.messages[1].content).toContain("[이전 대사 문맥]\n안녕\n오늘 날씨 좋다");
      expect(requestBody.messages[1].content).toContain("[번역할 원문 대사]\n本当にありがとう！");
    });

    it.each(["custom", "ollama"] as const)("%s 경로에서 이전 glossaryNotes 입력을 무시하고 캐릭터 문맥을 보존한다", async (runtime) => {
      const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
        requests.push(JSON.parse(options.body as string));
        if (runtime === "ollama" && url.endsWith("/v1/chat/completions")) {
          return { ok: false, status: 404, statusText: "Not Found" };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "선배, 감사합니다." } }] })
        };
      });

      const args = {
        runtime,
        endpoint: "http://local-ai.invalid",
        model: "fake-model",
        sourceText: "先輩、ありがとう",
        characterNotes: "유우키: 정중한 존댓말",
        previousContext: ["선배를 다시 만났다."]
      };
      await generateLocalAiTranslation(args);
      const baseline = requests.splice(0);

      for (const glossaryNotes of ["先輩 -> 선배님", "先輩 -> 이전 용어 강제 번역"]) {
        const legacyArgs = { ...args, glossaryNotes };
        expect(await generateLocalAiTranslation(legacyArgs)).toBe("선배, 감사합니다.");
        expect(requests.splice(0)).toEqual(baseline);
      }

      expect(baseline).toHaveLength(runtime === "ollama" ? 2 : 1);
      for (const request of baseline) {
        expect(request.messages[1]?.content).toContain("[등장인물 설정]\n유우키: 정중한 존댓말");
        expect(request.messages[1]?.content).toContain("[이전 대사 문맥]\n선배를 다시 만났다.");
        expect(request.messages[1]?.content).not.toContain("[용어집");
      }
    });

    it("strips outer quotes from generated translation", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '"여기서 기다려!"'
              }
            }
          ]
        })
      } as Response);

      const translation = await generateLocalAiTranslation({
        endpoint: "http://localhost:11434",
        model: "qwen2.5:7b-instruct",
        sourceText: "ここで待ってて！"
      });

      expect(translation).toBe("여기서 기다려!");
    });

    it("falls back to native Ollama /api/chat when /v1/chat/completions returns 404", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/v1/chat/completions")) {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            text: async () => "404 page not found"
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              content: "오빠, 밥 먹어!"
            }
          })
        };
      });

      const translation = await generateLocalAiTranslation({
        runtime: "ollama",
        endpoint: "http://localhost:11434",
        model: "qwen2.5:7b-instruct",
        sourceText: "お兄ちゃん、ご飯食べて！"
      });

      expect(translation).toBe("오빠, 밥 먹어!");
    });
  });
});
