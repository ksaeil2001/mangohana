# Gemini Transient Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make temporary Gemini overload, rate-limit, timeout, and network failures recover automatically without changing the final manual retry experience.

**Architecture:** Add one focused main-process retry utility around the existing REST `fetch` calls. Extraction and validation use three total attempts because they are required stages; optional Crop ReOCR uses two total attempts and still falls back to the existing fail-soft warning behavior after exhaustion.

**Tech Stack:** Electron 42 main process, TypeScript 6, native `fetch`, Vitest 4 fake timers, existing Gemini Interactions REST API.

## Global Constraints

- Run every command in PowerShell from the repository root (the current isolated worktree).
- Do not add packages or change the project schema, IPC contract, provider selection, API-key handling, model selection, security settings, or Electron build configuration.
- Extraction and validation must use exactly three total attempts: the initial request plus at most two retries.
- Crop ReOCR must use exactly two total attempts: the initial request plus at most one retry.
- Retry only HTTP `408`, HTTP `429`, HTTP `500` through `599`, and transient `fetch` network failures represented by `TypeError`.
- Do not retry HTTP `400`, `401`, `403`, other non-transient `4xx` responses, response JSON parsing failures, or response normalization failures.
- Without `Retry-After`, wait with exponential backoff from 1,000 ms to 2,000 ms and apply plus or minus 20 percent jitter.
- Honor numeric-seconds and HTTP-date `Retry-After` values, capped at 10,000 ms.
- Never retry indefinitely and never switch Gemini models automatically.
- After the last failed attempt, preserve the current final Gemini error parsing and renderer `OCR 다시 실행` behavior.
- After Crop ReOCR exhausts its two attempts, preserve the existing validated whole-image OCR and append the existing sanitized fail-soft warning.
- Never include real API keys, request headers, image bytes, or local absolute paths in errors, logs, tests, or warnings; synthetic test credentials remain permitted.
- Do not add an IPC progress channel or change renderer loading copy in this change.
- Do not modify lock files, generated output, `node_modules`, `dist`, `dist-electron`, `dist-renderer`, or release files.

## File Map

- Create `src/main/geminiTransientRetry.ts`: own transient-status classification, `Retry-After` parsing, jittered delay calculation, network-error classification, bounded waiting, and the reusable fetch loop.
- Create `tests/main/geminiTransientRetry.test.ts`: prove timing, jitter, `Retry-After`, status boundaries, network retry, and maximum-attempt behavior with fake timers.
- Modify `src/main/geminiSpeechBubbleExtraction.ts`: route extraction, validation, and Crop ReOCR requests through the retry utility with their exact attempt budgets.
- Modify `tests/main/geminiSpeechBubbleExtraction.test.ts`: prove the three operation-specific budgets, eventual success, and preservation of the final Gemini error.
- Reuse `tests/renderer/App.test.tsx`: confirm the existing final-error and manual retry UI remains intact without renderer changes.

---

### Task 1: Build the Bounded Gemini Retry Utility

**Files:**
- Create: `src/main/geminiTransientRetry.ts`
- Create: `tests/main/geminiTransientRetry.test.ts`

**Interfaces:**
- Produces: `fetchWithGeminiRetry(input: string | URL, init: RequestInit, options: { maxAttempts: number }): Promise<Response>`.
- Consumes: native `fetch`, `Response.headers`, `setTimeout`, `Date.now`, and `Math.random` only.
- Guarantees: returns the first success or non-retryable response, returns the final retryable response after exhaustion, and rethrows the final network error after exhaustion.

- [ ] **Step 1: Add the failing unit tests for response retries and timing**

Create `tests/main/geminiTransientRetry.test.ts` with:

```ts
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
});
```

- [ ] **Step 2: Run the response retry tests and verify RED**

```powershell
npx.cmd vitest run tests/main/geminiTransientRetry.test.ts
```

Expected: FAIL because `src/main/geminiTransientRetry.ts` does not exist.

- [ ] **Step 3: Add the failing boundary and network tests**

Append these tests inside the same `describe` block before its closing brace:

```ts
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
```

- [ ] **Step 4: Implement the minimal retry utility**

Create `src/main/geminiTransientRetry.ts`:

```ts
type GeminiRetryOptions = {
  maxAttempts: number;
};

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;
const JITTER_RATIO = 0.2;

export async function fetchWithGeminiRetry(
  input: string | URL,
  init: RequestInit,
  options: GeminiRetryOptions
): Promise<Response> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer.");
  }

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!isRetryableStatus(response.status) || attempt === options.maxAttempts) {
        return response;
      }

      await wait(resolveDelayMs(response.headers.get("Retry-After"), attempt));
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === options.maxAttempts) {
        throw error;
      }

      await wait(resolveDelayMs(null, attempt));
    }
  }

  throw new Error("Gemini retry loop exited unexpectedly.");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function resolveDelayMs(retryAfter: string | null, failedAttempt: number): number {
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_DELAY_MS);

  const exponentialDelay = BASE_DELAY_MS * (2 ** (failedAttempt - 1));
  const jitterMultiplier = 1 - JITTER_RATIO + (Math.random() * JITTER_RATIO * 2);
  return Math.min(Math.round(exponentialDelay * jitterMultiplier), MAX_DELAY_MS);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
```

- [ ] **Step 5: Run unit tests and verify GREEN**

```powershell
npx.cmd vitest run tests/main/geminiTransientRetry.test.ts
npm.cmd run typecheck
```

Expected: the new retry suite and both TypeScript checks PASS with exit code 0.

- [ ] **Step 6: Commit the retry utility**

```powershell
git add -- src/main/geminiTransientRetry.ts tests/main/geminiTransientRetry.test.ts
git commit -m "feat: add bounded Gemini retries"
```

---

### Task 2: Apply Exact Retry Budgets to Gemini OCR Stages

**Files:**
- Modify: `src/main/geminiSpeechBubbleExtraction.ts:1-205`
- Modify: `tests/main/geminiSpeechBubbleExtraction.test.ts:1-430`

**Interfaces:**
- Consumes: `fetchWithGeminiRetry(input, init, { maxAttempts })` from Task 1.
- Produces: extraction and validation with `maxAttempts: 3`; Crop ReOCR with `maxAttempts: 2`.
- Preserves: existing request bodies, model selection, response parsing, final error construction, and Crop ReOCR fail-soft handling in `ipcHandlers.ts`.

- [ ] **Step 1: Add failing extraction retry tests**

Add `vi.useRealTimers();` to the existing `afterEach`, then add these tests after `uses the current stable Gemini text model by default`:

```ts
  it("uses three total attempts for transient extraction failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiSuccessResponse(emptyExtraction(1)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = extractSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      pageNumber: 1
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(emptyExtraction(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves the final Gemini extraction error after three failed attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiErrorResponse(503, "first overload"))
      .mockResolvedValueOnce(geminiErrorResponse(503, "second overload"))
      .mockResolvedValueOnce(geminiErrorResponse(503, "final overload"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = extractSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      pageNumber: 1
    }).then(
      () => new Error("Expected extraction to fail."),
      (error: unknown) => error
    );
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      message: "Gemini extraction request failed: final overload"
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
```

Add these exact response helpers after `emptyExtraction` at the bottom of the file:

```ts
function geminiErrorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify({ error: { message } }))
  } as unknown as Response;
}

function geminiSuccessResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({ output_text: JSON.stringify(payload) })
  } as unknown as Response;
}
```

- [ ] **Step 2: Run the extraction tests and verify RED**

```powershell
npx.cmd vitest run tests/main/geminiSpeechBubbleExtraction.test.ts -t "attempts|final Gemini extraction error"
```

Expected: FAIL because extraction currently performs only one `fetch` call.

- [ ] **Step 3: Add failing validation and Crop ReOCR budget tests**

Add these tests after the existing successful validation and Crop ReOCR tests respectively:

```ts
  it("uses three total attempts for transient validation failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiSuccessResponse(emptyExtraction(1)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = validateSpeechBubblesWithGemini({
      imageBytes: Buffer.from([1]),
      sourceMimeType: "image/png",
      geminiExtraction: emptyExtraction(1)
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(emptyExtraction(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses two total attempts for transient Crop ReOCR failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(geminiErrorResponse(503, "high demand"))
      .mockResolvedValueOnce(geminiSuccessResponse({
        text: "Hello",
        confidence: 0.84,
        notes: "clear after retry"
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = reocrSpeechBubbleCropWithGemini({
      cropImageBytes: Buffer.from([9, 8, 7]),
      sourceMimeType: "image/png",
      target: cropTarget()
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({
      text: "Hello",
      confidence: 0.84,
      notes: "clear after retry"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 4: Route all three Gemini requests through the retry utility**

Add this import near the top of `src/main/geminiSpeechBubbleExtraction.ts`:

```ts
import { fetchWithGeminiRetry } from "./geminiTransientRetry.js";
```

Add these constants after `DEFAULT_GEMINI_TEXT_MODEL`:

```ts
const CRITICAL_GEMINI_MAX_ATTEMPTS = 3;
const OPTIONAL_CROP_GEMINI_MAX_ATTEMPTS = 2;
```

Replace the extraction request with:

```ts
  const response = await fetchWithGeminiRetry(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      model: process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_TEXT_MODEL,
      input
    })
  }, { maxAttempts: CRITICAL_GEMINI_MAX_ATTEMPTS });
```

Replace the validation request with the same request shape and critical budget:

```ts
  const response = await fetchWithGeminiRetry(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      model: process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_TEXT_MODEL,
      input
    })
  }, { maxAttempts: CRITICAL_GEMINI_MAX_ATTEMPTS });
```

Replace the Crop ReOCR request with the same request shape and optional budget:

```ts
  const response = await fetchWithGeminiRetry(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      model: process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_TEXT_MODEL,
      input
    })
  }, { maxAttempts: OPTIONAL_CROP_GEMINI_MAX_ATTEMPTS });
```

Do not move `buildGeminiErrorMessage`, `findTextOutput`, parsing, or normalization into the retry utility. This keeps retry transport policy separate from operation-specific response interpretation.

- [ ] **Step 5: Run focused and task-level tests**

```powershell
npx.cmd vitest run tests/main/geminiTransientRetry.test.ts tests/main/geminiSpeechBubbleExtraction.test.ts tests/main/ipcHandlers.integration.test.ts
npm.cmd run typecheck
```

Expected: retry utility, Gemini operation, 17 IPC integration tests, and both TypeScript checks PASS. Existing final Crop ReOCR fail-soft tests remain green.

- [ ] **Step 6: Commit operation-specific retry budgets**

```powershell
git add -- src/main/geminiSpeechBubbleExtraction.ts tests/main/geminiSpeechBubbleExtraction.test.ts
git commit -m "fix: retry transient Gemini OCR failures"
```

---

### Task 3: Full Regression and Live Electron Verification

**Files:**
- No planned source changes.
- Modify only Task 1 or Task 2 files if verification reproduces a concrete defect.

**Interfaces:**
- Consumes: bounded retry helper, three-attempt extraction/validation, two-attempt Crop ReOCR, existing renderer error state, and existing manual retry callback.
- Produces: evidence that a temporary overload recovers automatically and a sustained overload still ends in the existing manual retry UI.

- [ ] **Step 1: Run complete automated verification**

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run smoke:ipc
npm.cmd run build
```

Expected: every command exits 0; all Vitest suites pass; IPC smoke passes; production build completes.

- [ ] **Step 2: Re-run the existing renderer manual retry regression**

```powershell
npx.cmd vitest run tests/renderer/App.test.tsx -t "keeps the page image visible and offers retry after OCR failure|preserves an edited translation when OCR failure focus and retry interrupt the editor"
```

Expected: both tests PASS, proving final failure still preserves the page and `OCR 다시 실행` behavior without renderer changes.

- [ ] **Step 3: Restart Electron from the worktree**

```powershell
npm.cmd run dev:electron
```

Expected: Vite becomes ready, the Electron TypeScript watcher reports zero errors, and the app window opens. Enter the Gemini API key through the app if the process-only key was cleared; never print or capture it.

- [ ] **Step 4: Verify the live saved-image flow**

1. Open the same saved image project that produced the high-demand error.
2. Run `빠른 OCR` on the same page.
3. If Gemini returns a brief transient overload, confirm the app remains busy while the bounded retries run and eventually opens OCR review after a successful retry.
4. Confirm extraction and validation never exceed three total requests per operation.
5. Confirm each optional Crop ReOCR target never exceeds two total requests.
6. If overload persists through all attempts, confirm the image remains visible and `OCR 다시 실행` is still the primary action.
7. If Crop ReOCR alone exhausts retries, confirm the validated whole-image OCR remains editable and a sanitized `Crop ReOCR skipped for #...` warning appears.

- [ ] **Step 5: Confirm repository hygiene**

```powershell
git status --short
git log -5 --oneline
```

Expected: no generated or unrelated files are tracked; only the intended retry commits appear after the prior Crop ReOCR fail-soft commits.
