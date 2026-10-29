export type GeminiRetryOptions = {
  maxAttempts: number;
  attemptTimeoutMs?: number;
  signal?: AbortSignal;
  operationLabel?: string;
};

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;
const JITTER_RATIO = 0.2;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 45_000;

export class GeminiRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(operationLabel: string, timeoutMs: number) {
    super(`${operationLabel} 요청이 ${formatTimeoutSeconds(timeoutMs)}초 안에 응답하지 않았습니다.`);
    this.name = "GeminiRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function fetchWithGeminiRetry(
  input: string | URL,
  init: RequestInit,
  options: GeminiRetryOptions
): Promise<Response> {
  validateOptions(options);
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const operationLabel = options.operationLabel?.trim() || "Gemini";
  const parentSignals = uniqueSignals(options.signal, init.signal ?? undefined);

  throwIfAnySignalAborted(parentSignals);
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const response = await fetchAttempt(input, init, parentSignals, attemptTimeoutMs, operationLabel);
      if (!isRetryableStatus(response.status) || attempt === options.maxAttempts) {
        return response;
      }

      await wait(resolveDelayMs(response.headers.get("Retry-After"), attempt), parentSignals);
    } catch (error) {
      throwIfAnySignalAborted(parentSignals);
      if (!isRetryableNetworkError(error) || attempt === options.maxAttempts) {
        throw error;
      }

      await wait(resolveDelayMs(null, attempt), parentSignals);
    }
  }

  throw new Error("Gemini retry loop exited unexpectedly.");
}

async function fetchAttempt(
  input: string | URL,
  init: RequestInit,
  parentSignals: readonly AbortSignal[],
  attemptTimeoutMs: number,
  operationLabel: string
): Promise<Response> {
  throwIfAnySignalAborted(parentSignals);
  const controller = new AbortController();
  let timeoutError: GeminiRequestTimeoutError | undefined;
  const parentAbortListeners = parentSignals.map((signal) => {
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  const timeoutId = setTimeout(() => {
    timeoutError = new GeminiRequestTimeoutError(operationLabel, attemptTimeoutMs);
    controller.abort(timeoutError);
  }, attemptTimeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    throwIfAnySignalAborted(parentSignals);
    if (timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeoutId);
    for (const { signal, listener } of parentAbortListeners) {
      signal.removeEventListener("abort", listener);
    }
  }
}

function validateOptions(options: GeminiRetryOptions): void {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer.");
  }
  if (
    options.attemptTimeoutMs !== undefined &&
    (!Number.isFinite(options.attemptTimeoutMs) || options.attemptTimeoutMs <= 0)
  ) {
    throw new RangeError("attemptTimeoutMs must be a positive finite number.");
  }
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof GeminiRequestTimeoutError || error instanceof TypeError) return true;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("fetch failed") || message.includes("network") || message.includes("timeout") || message.includes("econnreset")) {
      return true;
    }
  }
  return false;
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

function wait(delayMs: number, signals: readonly AbortSignal[]): Promise<void> {
  throwIfAnySignalAborted(signals);
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    const listeners = signals.map((signal) => {
      const listener = () => {
        cleanup();
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", listener, { once: true });
      return { signal, listener };
    });
    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    function cleanup(): void {
      clearTimeout(timeoutId);
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  });
}

function uniqueSignals(...signals: Array<AbortSignal | undefined>): AbortSignal[] {
  return [...new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal)))];
}

function throwIfAnySignalAborted(signals: readonly AbortSignal[]): void {
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted) throw abortReason(aborted);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function formatTimeoutSeconds(timeoutMs: number): string {
  return Number.isInteger(timeoutMs / 1_000)
    ? String(timeoutMs / 1_000)
    : (timeoutMs / 1_000).toFixed(1);
}
