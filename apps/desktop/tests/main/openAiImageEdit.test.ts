import { afterEach, describe, expect, it, vi } from "vitest";
import { editImageWithOpenAI } from "../../src/main/openAiImageEdit";

describe("openAiImageEdit", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    vi.restoreAllMocks();
  });

  it("rejects missing OPENAI_API_KEY before making a request", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      editImageWithOpenAI({
        imageBytes: Buffer.from([1]),
        maskBytes: Buffer.from([2]),
        prompt: "remove text"
      })
    ).rejects.toThrow(/OPENAI_API_KEY/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts multipart image edit request and returns decoded png bytes", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const output = Buffer.from([9, 8, 7]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [{ b64_json: output.toString("base64") }] })
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await editImageWithOpenAI({
      imageBytes: Buffer.from([1]),
      maskBytes: Buffer.from([2]),
      prompt: "remove text"
    });

    expect(result).toEqual(output);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/edits",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-key" },
        body: expect.any(FormData)
      })
    );

    const callBody = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(callBody.get("model")).toBe("dall-e-2");
    expect(callBody.get("image")).not.toBeNull();
    expect(callBody.get("mask")).not.toBeNull();
    expect(callBody.get("prompt")).toBe("remove text");
    expect(callBody.get("response_format")).toBe("b64_json");
  });

  it("throws a useful error when the API returns an error body", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: { message: "bad mask" } }))
    }) as unknown as typeof fetch;

    await expect(
      editImageWithOpenAI({
        imageBytes: Buffer.from([1]),
        maskBytes: Buffer.from([2]),
        prompt: "remove text"
      })
    ).rejects.toThrow(/bad mask/);
  });

  it("propagates parent cancellation to the OpenAI request", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    let providerSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => {
      providerSignal = options?.signal ?? undefined;
      providerSignal?.addEventListener("abort", () => {
        reject(providerSignal?.reason ?? new DOMException("canceled", "AbortError"));
      }, { once: true });
    })) as typeof fetch;
    const controller = new AbortController();

    const pending = editImageWithOpenAI({
      imageBytes: Buffer.from([1]),
      maskBytes: Buffer.from([2]),
      prompt: "remove text",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort(new DOMException("manual cancel", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignal?.aborted).toBe(true);
  });
});
