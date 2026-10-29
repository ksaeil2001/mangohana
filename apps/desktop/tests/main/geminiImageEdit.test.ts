import { afterEach, describe, expect, it, vi } from "vitest";
import { editImageWithGemini } from "../../src/main/geminiImageEdit";

describe("geminiImageEdit", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_IMAGE_MODEL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.GEMINI_IMAGE_MODEL;
    else process.env.GEMINI_IMAGE_MODEL = originalModel;
    vi.restoreAllMocks();
  });

  it("rejects missing GEMINI_API_KEY before making a request", async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      editImageWithGemini({
        imageBytes: Buffer.from([1]),
        maskBytes: Buffer.from([2]),
        sourceMimeType: "image/png",
        prompt: "remove text"
      })
    ).rejects.toThrow(/GEMINI_API_KEY/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts Gemini interaction request and returns decoded image bytes", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_IMAGE_MODEL = "gemini-test-image";
    const output = Buffer.from([7, 8, 9]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ output_image: { data: output.toString("base64") } })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await editImageWithGemini({
      imageBytes: Buffer.from([1]),
      maskBytes: Buffer.from([2]),
      sourceMimeType: "image/jpeg",
      prompt: "remove text"
    });

    expect(result).toEqual(output);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": "test-gemini-key"
        },
        body: expect.any(String)
      })
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model: string;
      input: Array<{ type: string; text?: string; mime_type?: string; data?: string }>;
    };
    expect(requestBody.model).toBe("gemini-test-image");
    expect(requestBody.input).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("transparent pixels") }),
      expect.objectContaining({ type: "image", mime_type: "image/jpeg", data: Buffer.from([1]).toString("base64") }),
      expect.objectContaining({ type: "image", mime_type: "image/png", data: Buffer.from([2]).toString("base64") })
    ]);
  });

  it("propagates a parent abort without retrying image edit", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const controller = new AbortController();
    const cancellation = new Error("image edit canceled");
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = editImageWithGemini({
      imageBytes: Buffer.from([1]),
      maskBytes: Buffer.from([2]),
      sourceMimeType: "image/png",
      prompt: "remove text",
      signal: controller.signal
    });
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws a useful error when Gemini returns an error body", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: { message: "bad request" } }))
    }) as unknown as typeof fetch;

    await expect(
      editImageWithGemini({
        imageBytes: Buffer.from([1]),
        maskBytes: Buffer.from([2]),
        sourceMimeType: "image/png",
        prompt: "remove text"
      })
    ).rejects.toThrow(/bad request/);
  });

  it("can read image data from interaction steps", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const output = Buffer.from([3, 4, 5]);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        steps: [{ content: [{ type: "image", data: output.toString("base64"), mime_type: "image/png" }] }]
      })
    }) as unknown as typeof fetch;

    await expect(
      editImageWithGemini({
        imageBytes: Buffer.from([1]),
        maskBytes: Buffer.from([2]),
        sourceMimeType: "image/webp",
        prompt: "remove text"
      })
    ).resolves.toEqual(output);
  });
});
