export const RESOURCE_PACK_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const RESOURCE_PACK_DOWNLOAD_MAX_REDIRECTS = 5;
export const RESOURCE_PACK_DOWNLOAD_RESPONSE_TIMEOUT_MS = 30_000;
export const RESOURCE_PACK_DOWNLOAD_BODY_IDLE_TIMEOUT_MS = 30_000;
export const RESOURCE_PACK_DOWNLOAD_BODY_OVERALL_TIMEOUT_MS = 60 * 60 * 1_000;

export type ResourcePackDownloadPolicy = Readonly<{
  maxDownloadBytes: number;
  maxRedirects: number;
  responseTimeoutMs: number;
  bodyIdleTimeoutMs: number;
  bodyOverallTimeoutMs: number;
}>;

export const DEFAULT_RESOURCE_PACK_DOWNLOAD_POLICY: ResourcePackDownloadPolicy = Object.freeze({
  maxDownloadBytes: RESOURCE_PACK_DOWNLOAD_MAX_BYTES,
  maxRedirects: RESOURCE_PACK_DOWNLOAD_MAX_REDIRECTS,
  responseTimeoutMs: RESOURCE_PACK_DOWNLOAD_RESPONSE_TIMEOUT_MS,
  bodyIdleTimeoutMs: RESOURCE_PACK_DOWNLOAD_BODY_IDLE_TIMEOUT_MS,
  bodyOverallTimeoutMs: RESOURCE_PACK_DOWNLOAD_BODY_OVERALL_TIMEOUT_MS
});

export type WritableResourcePackFileHandle = {
  truncate(length?: number): Promise<void>;
  write(
    buffer: Uint8Array,
    options: {
      offset: number;
      length: number;
      position: number;
    }
  ): Promise<{
    bytesWritten: number;
    buffer: Uint8Array;
  }>;
};

export type ResourcePackFetch = (
  input: string | URL,
  init: RequestInit
) => Promise<Response>;

export type ResourcePackDownloadClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type ResourcePackDownloadOptions = {
  signal?: AbortSignal;
  fetch?: ResourcePackFetch;
  clock?: ResourcePackDownloadClock;
  policy?: Partial<ResourcePackDownloadPolicy>;
};

export type ResourcePackDownloadResult = {
  bytesWritten: number;
  finalUrl: string;
  redirectCount: number;
};

export type ResourcePackDownloadErrorCode =
  | "RESOURCE_PACK_DOWNLOAD_URL_INVALID"
  | "RESOURCE_PACK_DOWNLOAD_REDIRECT_INVALID"
  | "RESOURCE_PACK_DOWNLOAD_REDIRECT_LOOP"
  | "RESOURCE_PACK_DOWNLOAD_REDIRECT_LIMIT"
  | "RESOURCE_PACK_DOWNLOAD_HTTP_STATUS"
  | "RESOURCE_PACK_DOWNLOAD_REQUEST_FAILED"
  | "RESOURCE_PACK_DOWNLOAD_RESPONSE_TIMEOUT"
  | "RESOURCE_PACK_DOWNLOAD_BODY_IDLE_TIMEOUT"
  | "RESOURCE_PACK_DOWNLOAD_BODY_OVERALL_TIMEOUT"
  | "RESOURCE_PACK_DOWNLOAD_ABORTED"
  | "RESOURCE_PACK_DOWNLOAD_BODY_MISSING"
  | "RESOURCE_PACK_DOWNLOAD_BODY_STREAM_FAILED"
  | "RESOURCE_PACK_DOWNLOAD_CONTENT_LENGTH_INVALID"
  | "RESOURCE_PACK_DOWNLOAD_SIZE_LIMIT"
  | "RESOURCE_PACK_DOWNLOAD_LENGTH_MISMATCH"
  | "RESOURCE_PACK_DOWNLOAD_WRITE_FAILED"
  | "RESOURCE_PACK_DOWNLOAD_OUTPUT_RESET_FAILED"
  | "RESOURCE_PACK_DOWNLOAD_POLICY_INVALID";

export class ResourcePackDownloadError extends Error {
  readonly code: ResourcePackDownloadErrorCode;

  constructor(code: ResourcePackDownloadErrorCode) {
    super("Resource pack download failed");
    this.name = "ResourcePackDownloadError";
    this.code = code;
  }
}

/**
 * Streams one HTTPS resource into an already-open caller-owned handle.
 *
 * The caller retains handle lifecycle ownership: this function never closes it.
 * Before requesting and after every handled failure, the destination is
 * truncated to zero bytes. `RESOURCE_PACK_DOWNLOAD_OUTPUT_RESET_FAILED` means
 * truncation itself failed, so the caller must discard the transaction handle.
 * Policy overrides may only lower the exported production security limits.
 */
export async function downloadResourcePack(
  source: string | URL,
  destination: WritableResourcePackFileHandle,
  options: ResourcePackDownloadOptions = {}
): Promise<ResourcePackDownloadResult> {
  const clock = options.clock ?? systemClock;
  const fetchBoundary = options.fetch ?? globalThis.fetch;
  const requestController = new AbortController();
  const abortFromCaller = () => {
    requestController.abort(
      new ResourcePackDownloadError("RESOURCE_PACK_DOWNLOAD_ABORTED")
    );
  };
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    await resetDestination(destination);
    const policy = normalizePolicy(options.policy);
    if (options.signal?.aborted === true) {
      abortFromCaller();
      throw requestController.signal.reason;
    }

    let currentUrl = parseAndValidateUrl(source);
    const visited = new Set<string>([currentUrl.href]);
    let redirectCount = 0;
    let response: Response;

    while (true) {
      response = await fetchResponse(
        fetchBoundary,
        currentUrl,
        requestController,
        clock,
        policy.responseTimeoutMs
      );
      if (!redirectStatuses.has(response.status)) break;
      cancelBody(response.body);
      if (redirectCount >= policy.maxRedirects) {
        throw new ResourcePackDownloadError(
          "RESOURCE_PACK_DOWNLOAD_REDIRECT_LIMIT"
        );
      }
      const location = response.headers.get("Location");
      if (location === null || location.trim() === "") {
        throw new ResourcePackDownloadError(
          "RESOURCE_PACK_DOWNLOAD_REDIRECT_INVALID"
        );
      }
      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch {
        throw new ResourcePackDownloadError(
          "RESOURCE_PACK_DOWNLOAD_REDIRECT_INVALID"
        );
      }
      validateUrl(target);
      if (visited.has(target.href)) {
        throw new ResourcePackDownloadError(
          "RESOURCE_PACK_DOWNLOAD_REDIRECT_LOOP"
        );
      }
      visited.add(target.href);
      currentUrl = target;
      redirectCount += 1;
    }

    if (!response.ok) {
      throw new ResourcePackDownloadError("RESOURCE_PACK_DOWNLOAD_HTTP_STATUS");
    }
    if (response.body === null) {
      throw new ResourcePackDownloadError("RESOURCE_PACK_DOWNLOAD_BODY_MISSING");
    }
    const declaredLength = parseContentLength(
      response.headers.get("Content-Length"),
      policy.maxDownloadBytes
    );
    const bytesWritten = await streamBody(
      response.body,
      destination,
      requestController,
      clock,
      policy
    );
    if (declaredLength !== undefined && declaredLength !== bytesWritten) {
      throw new ResourcePackDownloadError(
        "RESOURCE_PACK_DOWNLOAD_LENGTH_MISMATCH"
      );
    }

    return {
      bytesWritten,
      finalUrl: currentUrl.href,
      redirectCount
    };
  } catch (error) {
    const downloadError = classifyFailure(error, requestController.signal);
    if (!requestController.signal.aborted) {
      requestController.abort(downloadError);
    }
    try {
      await destination.truncate(0);
    } catch {
      throw new ResourcePackDownloadError(
        "RESOURCE_PACK_DOWNLOAD_OUTPUT_RESET_FAILED"
      );
    }
    throw downloadError;
  } finally {
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const systemClock: ResourcePackDownloadClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => {
    globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>);
  }
};

function normalizePolicy(
  override: Partial<ResourcePackDownloadPolicy> | undefined
): ResourcePackDownloadPolicy {
  const policy = {
    ...DEFAULT_RESOURCE_PACK_DOWNLOAD_POLICY,
    ...override
  };
  const limits: Array<{
    value: number;
    maximum: number;
    allowZero: boolean;
  }> = [
    {
      value: policy.maxDownloadBytes,
      maximum: DEFAULT_RESOURCE_PACK_DOWNLOAD_POLICY.maxDownloadBytes,
      allowZero: false
    },
    {
      value: policy.maxRedirects,
      maximum: DEFAULT_RESOURCE_PACK_DOWNLOAD_POLICY.maxRedirects,
      allowZero: true
    },
    {
      value: policy.responseTimeoutMs,
      maximum: DEFAULT_RESOURCE_PACK_DOWNLOAD_POLICY.responseTimeoutMs,
      allowZero: false
    },
    {
      value: policy.bodyIdleTimeoutMs,
      maximum: DEFAULT_RESOURCE_PACK_DOWNLOAD_POLICY.bodyIdleTimeoutMs,
      allowZero: false
    },
    {
      value: policy.bodyOverallTimeoutMs,
      maximum: DEFAULT_RESOURCE_PACK_DOWNLOAD_POLICY.bodyOverallTimeoutMs,
      allowZero: false
    }
  ];
  if (limits.some(({ value, maximum, allowZero }) =>
    !Number.isSafeInteger(value)
    || value > maximum
    || value < (allowZero ? 0 : 1)
  )) {
    throw new ResourcePackDownloadError(
      "RESOURCE_PACK_DOWNLOAD_POLICY_INVALID"
    );
  }
  return Object.freeze(policy);
}

async function resetDestination(
  destination: WritableResourcePackFileHandle
): Promise<void> {
  try {
    await destination.truncate(0);
  } catch {
    throw new ResourcePackDownloadError(
      "RESOURCE_PACK_DOWNLOAD_OUTPUT_RESET_FAILED"
    );
  }
}

function parseAndValidateUrl(source: string | URL): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new ResourcePackDownloadError("RESOURCE_PACK_DOWNLOAD_URL_INVALID");
  }
  validateUrl(url);
  return url;
}

function validateUrl(url: URL): void {
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.href.includes("#")
  ) {
    throw new ResourcePackDownloadError("RESOURCE_PACK_DOWNLOAD_URL_INVALID");
  }
}

async function fetchResponse(
  fetchBoundary: ResourcePackFetch,
  url: URL,
  requestController: AbortController,
  clock: ResourcePackDownloadClock,
  timeoutMs: number
): Promise<Response> {
  const timeoutError = new ResourcePackDownloadError(
    "RESOURCE_PACK_DOWNLOAD_RESPONSE_TIMEOUT"
  );
  let timer: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimeout(() => {
      requestController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchBoundary(url, {
        redirect: "manual",
        signal: requestController.signal
      })),
      timeout
    ]);
  } catch (error) {
    if (requestController.signal.aborted) {
      throw requestController.signal.reason;
    }
    throw error;
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

function parseContentLength(
  value: string | null,
  maxDownloadBytes: number
): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new ResourcePackDownloadError(
      "RESOURCE_PACK_DOWNLOAD_CONTENT_LENGTH_INVALID"
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new ResourcePackDownloadError(
      "RESOURCE_PACK_DOWNLOAD_CONTENT_LENGTH_INVALID"
    );
  }
  if (length > maxDownloadBytes) {
    throw new ResourcePackDownloadError(
      "RESOURCE_PACK_DOWNLOAD_SIZE_LIMIT"
    );
  }
  return length;
}

async function streamBody(
  body: ReadableStream<Uint8Array>,
  destination: WritableResourcePackFileHandle,
  requestController: AbortController,
  clock: ResourcePackDownloadClock,
  policy: ResourcePackDownloadPolicy
): Promise<number> {
  const reader = body.getReader();
  const startedAt = clock.now();
  let bytesWritten = 0;
  let completed = false;
  try {
    while (true) {
      const result = await readWithTimeouts(
        reader,
        requestController,
        clock,
        policy,
        startedAt
      );
      if (result.done) {
        completed = true;
        return bytesWritten;
      }
      const chunk = result.value;
      if (!ArrayBuffer.isView(chunk) || chunk.BYTES_PER_ELEMENT !== 1) {
        throw new ResourcePackDownloadError(
          "RESOURCE_PACK_DOWNLOAD_BODY_STREAM_FAILED"
        );
      }
      if (chunk.byteLength > policy.maxDownloadBytes - bytesWritten) {
        throw new ResourcePackDownloadError(
          "RESOURCE_PACK_DOWNLOAD_SIZE_LIMIT"
        );
      }
      bytesWritten = await writeChunk(destination, chunk, bytesWritten);
    }
  } finally {
    if (!completed) {
      startCancellation(() => reader.cancel());
    }
    try {
      reader.releaseLock();
    } catch {
      // A synchronously broken cancellation boundary must not block cleanup.
    }
  }
}

function readWithTimeouts(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestController: AbortController,
  clock: ResourcePackDownloadClock,
  policy: ResourcePackDownloadPolicy,
  startedAt: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remainingOverallMs = policy.bodyOverallTimeoutMs
    - (clock.now() - startedAt);
  if (remainingOverallMs <= 0) {
    const error = new ResourcePackDownloadError(
      "RESOURCE_PACK_DOWNLOAD_BODY_OVERALL_TIMEOUT"
    );
    requestController.abort(error);
    throw error;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer: unknown;
    let overallTimer: unknown;
    const settle = (
      action: () => void
    ) => {
      if (settled) return;
      settled = true;
      if (idleTimer !== undefined) clock.clearTimeout(idleTimer);
      if (overallTimer !== undefined) clock.clearTimeout(overallTimer);
      requestController.signal.removeEventListener(
        "abort",
        abortForSignal
      );
      action();
    };
    const abortForSignal = () => {
      settle(() => reject(requestController.signal.reason));
    };
    const failForTimeout = (code: ResourcePackDownloadErrorCode) => {
      const error = new ResourcePackDownloadError(code);
      requestController.abort(error);
      settle(() => reject(error));
    };

    idleTimer = clock.setTimeout(
      () => failForTimeout("RESOURCE_PACK_DOWNLOAD_BODY_IDLE_TIMEOUT"),
      policy.bodyIdleTimeoutMs
    );
    overallTimer = clock.setTimeout(
      () => failForTimeout("RESOURCE_PACK_DOWNLOAD_BODY_OVERALL_TIMEOUT"),
      remainingOverallMs
    );
    requestController.signal.addEventListener("abort", abortForSignal, {
      once: true
    });
    if (requestController.signal.aborted) {
      abortForSignal();
      return;
    }
    reader.read().then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error))
    );
  });
}

async function writeChunk(
  destination: WritableResourcePackFileHandle,
  chunk: Uint8Array,
  initialPosition: number
): Promise<number> {
  let chunkOffset = 0;
  let position = initialPosition;
  while (chunkOffset < chunk.byteLength) {
    let bytesWritten: number;
    try {
      const result = await destination.write(chunk, {
        offset: chunkOffset,
        length: chunk.byteLength - chunkOffset,
        position
      });
      bytesWritten = result.bytesWritten;
    } catch {
      throw new ResourcePackDownloadError(
        "RESOURCE_PACK_DOWNLOAD_WRITE_FAILED"
      );
    }
    if (
      !Number.isSafeInteger(bytesWritten)
      || bytesWritten <= 0
      || bytesWritten > chunk.byteLength - chunkOffset
    ) {
      throw new ResourcePackDownloadError(
        "RESOURCE_PACK_DOWNLOAD_WRITE_FAILED"
      );
    }
    chunkOffset += bytesWritten;
    position += bytesWritten;
  }
  return position;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  startCancellation(() => body.cancel());
}

function startCancellation(action: () => Promise<unknown>): void {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never delay security cleanup.
  }
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal
): ResourcePackDownloadError {
  if (error instanceof ResourcePackDownloadError) return error;
  if (
    signal.aborted
    && signal.reason instanceof ResourcePackDownloadError
  ) {
    return signal.reason;
  }
  return new ResourcePackDownloadError(
    "RESOURCE_PACK_DOWNLOAD_REQUEST_FAILED"
  );
}
