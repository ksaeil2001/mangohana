import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithGeminiRetry } from "../../src/main/geminiTransientRetry";

describe("fetchWithGeminiRetry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries 503 responses with one-second then two-second exponential backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const success = new Response("ok", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(success);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", { method: "POST" }, { maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("adds up to twenty percent jitter to fallback delays", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const success = new Response("ok", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(success);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_199);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After seconds before retrying a 429 response", async () => {
    vi.useFakeTimers();
    const success = new Response("ok", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("limited", {
        status: 429,
        headers: { "Retry-After": "2" }
      }))
      .mockResolvedValueOnce(success);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps HTTP-date Retry-After delays at ten seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const success = new Response("ok", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", {
        status: 503,
        headers: { "Retry-After": "Thu, 16 Jul 2026 00:01:00 GMT" }
      }))
      .mockResolvedValueOnce(success);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([408, 429, 500, 502, 503, 504, 599])("retries transient HTTP status %i", async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const success = new Response("ok", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("transient", { status }))
      .mockResolvedValueOnce(success);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 2 });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 409, 422])("does not retry non-transient HTTP status %i", async (status) => {
    const response = new Response("client error", { status });
    const fetchMock = vi.fn().mockResolvedValue(response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 3 })
    ).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient fetch TypeError", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const success = new Response("ok", { status: 200 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(success);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 2 });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(success);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-network exceptions", async () => {
    const failure = new Error("programming failure");
    const fetchMock = vi.fn().mockRejectedValue(failure);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 3 })
    ).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the final retryable response when maxAttempts is exhausted", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const finalResponse = new Response("still busy", { status: 503 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(finalResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 3 });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(finalResponse);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rethrows the final network error when maxAttempts is exhausted", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const finalFailure = new TypeError("fetch still failed");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(finalFailure);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, { maxAttempts: 2 });
    const assertion = expect(pending).rejects.toBe(finalFailure);
    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid maxAttempts value %s", async (maxAttempts) => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithGeminiRetry("https://example.test", {}, { maxAttempts })
    ).rejects.toThrow(new RangeError("maxAttempts must be a positive integer."));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out a pending attempt and retries it as a transient failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, {
      maxAttempts: 2,
      attemptTimeoutMs: 100,
      operationLabel: "OCR 검증"
    });
    const assertion = expect(pending).rejects.toThrow("OCR 검증 요청이 0.1초 안에 응답하지 않았습니다.");
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(100);

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry when a parent signal aborts a pending fetch", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancellation = new Error("사용자가 취소했습니다.");
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, {
      maxAttempts: 3,
      attemptTimeoutMs: 1_000,
      signal: controller.signal
    });
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts during retry backoff and leaves no timers behind", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const controller = new AbortController();
    const cancellation = new Error("backoff cancelled");
    const fetchMock = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = fetchWithGeminiRetry("https://example.test", {}, {
      maxAttempts: 3,
      attemptTimeoutMs: 5_000,
      signal: controller.signal
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up an attempt timeout after a successful response", async () => {
    vi.useFakeTimers();
    const response = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    await expect(fetchWithGeminiRetry("https://example.test", {}, {
      maxAttempts: 1,
      attemptTimeoutMs: 100
    })).resolves.toBe(response);
    expect(vi.getTimerCount()).toBe(0);
  });
});
