import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateProviderReadiness,
  probeLocalAiReadiness,
  probeLocalInpaintingReadiness,
  probeLocalOcrReadiness
} from "../../src/main/providerHealthCheck";

describe("providerHealthCheck", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("probeLocalAiReadiness", () => {
    it("returns ready: true when Ollama server is reachable and has models", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/version")) {
          return Promise.resolve(new Response(JSON.stringify({ version: "0.3.12" }), { status: 200 }));
        }
        if (url.includes("/api/tags")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                models: [
                  { name: "qwen2.5:7b-instruct", size: 4500000000 },
                  { name: "llama3.2:3b", size: 2000000000 }
                ]
              }),
              { status: 200 }
            )
          );
        }
        return Promise.reject(new Error("Not found"));
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeLocalAiReadiness({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });

      expect(result.ready).toBe(true);
      expect(result.modelCount).toBe(2);
      expect(result.message).toContain("2개 모델 설치됨");
    });

    it("returns ready: false when Ollama is running but has no models installed", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/version")) {
          return Promise.resolve(new Response(JSON.stringify({ version: "0.3.12" }), { status: 200 }));
        }
        if (url.includes("/api/tags")) {
          return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }));
        }
        return Promise.reject(new Error("Not found"));
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeLocalAiReadiness({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });

      expect(result.ready).toBe(false);
      expect(result.modelCount).toBe(0);
      expect(result.disabledReason).toContain("로컬 AI 모델");
    });

    it("returns ready: false when server is not running", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await probeLocalAiReadiness({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });

      expect(result.ready).toBe(false);
      expect(result.disabledReason).toContain("로컬 서버");
    });
    it("returns ready: false when selectedModel is specified but not installed", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/version")) {
          return Promise.resolve(new Response(JSON.stringify({ version: "0.3.12" }), { status: 200 }));
        }
        if (url.includes("/api/tags")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                models: [{ name: "llama3.2:3b", size: 2000000000 }]
              }),
              { status: 200 }
            )
          );
        }
        return Promise.reject(new Error("Not found"));
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeLocalAiReadiness({
        runtime: "ollama",
        endpoint: "http://localhost:11434",
        selectedModel: "qwen2.5:7b-instruct"
      });

      expect(result.ready).toBe(false);
      expect(result.message).toContain("qwen2.5:7b-instruct");
      expect(result.disabledReason).toContain("설치하거나");
    });

    it("returns ready: true when selectedModel is installed in Ollama", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/version")) {
          return Promise.resolve(new Response(JSON.stringify({ version: "0.3.12" }), { status: 200 }));
        }
        if (url.includes("/api/tags")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                models: [
                  { name: "qwen2.5:7b-instruct", size: 4500000000 },
                  { name: "llama3.2:3b", size: 2000000000 }
                ]
              }),
              { status: 200 }
            )
          );
        }
        return Promise.reject(new Error("Not found"));
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeLocalAiReadiness({
        runtime: "ollama",
        endpoint: "http://localhost:11434",
        selectedModel: "qwen2.5:7b-instruct"
      });

      expect(result.ready).toBe(true);
      expect(result.message).toContain("qwen2.5:7b-instruct 사용");
    });
  });

  describe("probeLocalOcrReadiness", () => {
    it("uses default port 5000 and returns ready: true when OCR server responds with 405", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        expect(url).toBe("http://localhost:5000/ocr");
        return Promise.resolve(new Response(null, { status: 405 }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeLocalOcrReadiness();
      expect(result.ready).toBe(true);
      expect(result.message).toContain("PaddleOCR/Manga-OCR");
    });

    it("rejects 404 Not Found as not ready", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

      const result = await probeLocalOcrReadiness({ endpoint: "http://localhost:5000/ocr" });
      expect(result.ready).toBe(false);
      expect(result.message).toContain("404");
    });

    it("returns ready: false when PaddleOCR is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await probeLocalOcrReadiness({ endpoint: "http://localhost:5000/ocr" });
      expect(result.ready).toBe(false);
      expect(result.disabledReason).toContain("PaddleOCR/Manga-OCR");
    });
  });

  describe("probeLocalInpaintingReadiness", () => {
    it("returns ready: true when local inpainting server responds with 200", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

      const result = await probeLocalInpaintingReadiness({
        provider: "local-lama",
        endpoint: "http://localhost:8080/inpaint"
      });
      expect(result.ready).toBe(true);
      expect(result.message).toContain("local-lama");
    });

    it("rejects 404 Not Found as not ready", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

      const result = await probeLocalInpaintingReadiness({
        provider: "local-lama",
        endpoint: "http://localhost:8080/inpaint"
      });
      expect(result.ready).toBe(false);
      expect(result.message).toContain("404");
    });

    it("returns ready: false when inpainting server is down", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const result = await probeLocalInpaintingReadiness({
        provider: "local-lama",
        endpoint: "http://localhost:8080/inpaint"
      });
      expect(result.ready).toBe(false);
    });
  });

  describe("evaluateProviderReadiness", () => {
    it("recognizes local Ollama and local OCR when Gemini key is absent", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/ocr")) {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        if (url.includes("/api/version") || url.includes("/api/tags")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                version: "0.3.12",
                models: [{ name: "qwen2.5:7b-instruct" }]
              }),
              { status: 200 }
            )
          );
        }
        return Promise.reject(new Error("Not reachable"));
      });
      vi.stubGlobal("fetch", fetchMock);

      const status = await evaluateProviderReadiness({
        geminiConfigured: false,
        openAiConfigured: false,
        selectedModel: "qwen2.5:7b-instruct"
      });

      expect(status.ocrReady).toBe(true);
      expect(status.ocrMessage).toContain("PaddleOCR/Manga-OCR");
      expect(status.translationReady).toBe(true);
      expect(status.translationMessage).toContain("로컬 AI 번역 엔진");
      expect(status.inpaintingReady).toBe(false);
    });

    it("prioritizes Gemini when configured", async () => {
      const status = await evaluateProviderReadiness({
        geminiConfigured: true,
        openAiConfigured: false
      });

      expect(status.ocrReady).toBe(true);
      expect(status.ocrMessage).toContain("Gemini");
      expect(status.translationReady).toBe(true);
      expect(status.translationMessage).toContain("Gemini");
      expect(status.inpaintingReady).toBe(true);
    });

    it("evaluates local_ai translation when explicitly selected, even if Gemini is configured", async () => {
      // Local AI unreachable
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const status = await evaluateProviderReadiness({
        geminiConfigured: true,
        openAiConfigured: false,
        translationEngine: "local_ai",
        localAiEndpoint: "http://localhost:11434"
      });

      expect(status.translationReady).toBe(false);
      expect(status.translationMessage).toMatch(/연결|실패/);
      expect(status.translationDisabledReason).toBeDefined();
    });

    it("marks gemini OCR not ready when gemini is selected without API key, even if local OCR is running", async () => {
      // Local OCR is running
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 405 })));

      const status = await evaluateProviderReadiness({
        geminiConfigured: false,
        ocrEngine: "gemini"
      });

      expect(status.ocrReady).toBe(false);
      expect(status.ocrMessage).toContain("Gemini OCR API 키");
      expect(status.ocrDisabledReason).toContain("Gemini API 키");
    });

    it("evaluates paddle-ocr engine specifically on its endpoint", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === "http://localhost:5001/ocr") {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        return Promise.reject(new Error("wrong port"));
      });
      vi.stubGlobal("fetch", fetchMock);

      const status = await evaluateProviderReadiness({
        geminiConfigured: false,
        ocrEngine: "paddle-ocr",
        paddleOcrEndpoint: "http://localhost:5001/ocr"
      });

      expect(status.ocrReady).toBe(true);
      expect(status.ocrMessage).toContain("PaddleOCR");
    });

    it("does not false-positive match models with different tags like 7b vs 3b", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/version")) {
          return Promise.resolve(new Response(JSON.stringify({ version: "0.3.12" }), { status: 200 }));
        }
        if (url.includes("/api/tags")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                models: [{ name: "qwen2.5:3b", size: 2000000000 }]
              }),
              { status: 200 }
            )
          );
        }
        return Promise.reject(new Error("Not found"));
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeLocalAiReadiness({
        runtime: "ollama",
        endpoint: "http://localhost:11434",
        selectedModel: "qwen2.5:7b-instruct"
      });

      // 3B should NOT match 7b-instruct
      expect(result.ready).toBe(false);
      expect(result.message).toContain("선택된 모델(qwen2.5:7b-instruct)이 설치되어 있지 않습니다");
    });
  });
});
