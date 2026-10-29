import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { editImageWithLocalInpainting } from "../../src/main/localInpainting.js";

describe("localInpainting", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends inpainting request to SD WebUI and returns image buffer", async () => {
    const mockOutputBase64 = Buffer.from("mock-sd-result").toString("base64");
    let requestBody: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          images: [`data:image/png;base64,${mockOutputBase64}`]
        })
      };
    });

    const imageBytes = Buffer.from("source-image");
    const maskBytes = Buffer.from("mask-image");

    const result = await editImageWithLocalInpainting({
      imageBytes,
      maskBytes,
      provider: "sd-webui",
      prompt: "clean manga background"
    });

    expect(result.toString()).toBe("mock-sd-result");
    expect(requestBody.prompt).toBe("clean manga background");
    expect(requestBody.init_images[0]).toContain(imageBytes.toString("base64"));
  });

  it("sends inpainting request to Local LaMa endpoint and returns image buffer", async () => {
    const mockOutputArray = new TextEncoder().encode("mock-lama-result");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (h: string) => (h === "content-type" ? "image/png" : null)
      },
      arrayBuffer: async () => mockOutputArray.buffer
    } as unknown as Response);

    const imageBytes = Buffer.from("source-image");
    const maskBytes = Buffer.from("mask-image");

    const result = await editImageWithLocalInpainting({
      imageBytes,
      maskBytes,
      provider: "local-lama"
    });

    expect(result.toString()).toBe("mock-lama-result");
  });

  it("sends inpainting request to Local AOT endpoint and returns image buffer", async () => {
    const mockOutputArray = new TextEncoder().encode("mock-aot-result");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (h: string) => (h === "content-type" ? "image/png" : null)
      },
      arrayBuffer: async () => mockOutputArray.buffer
    } as unknown as Response);

    const imageBytes = Buffer.from("source-image");
    const maskBytes = Buffer.from("mask-image");

    const result = await editImageWithLocalInpainting({
      imageBytes,
      maskBytes,
      provider: "local-aot"
    });

    expect(result.toString()).toBe("mock-aot-result");
  });

  it("propagates parent cancellation to a local provider fetch", async () => {
    let providerSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => {
      providerSignal = options?.signal ?? undefined;
      providerSignal?.addEventListener("abort", () => {
        reject(providerSignal?.reason ?? new DOMException("canceled", "AbortError"));
      }, { once: true });
    })) as typeof fetch;
    const controller = new AbortController();

    const pending = editImageWithLocalInpainting({
      imageBytes: Buffer.from("source-image"),
      maskBytes: Buffer.from("mask-image"),
      provider: "local-lama",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort(new DOMException("manual cancel", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
  });
});
