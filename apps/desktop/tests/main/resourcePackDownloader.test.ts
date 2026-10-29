import {
  mkdtemp,
  open,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";
import {
  downloadResourcePack,
  ResourcePackDownloadError,
  type ResourcePackDownloadClock,
  type ResourcePackDownloadErrorCode,
  type ResourcePackDownloadOptions,
  type ResourcePackFetch
} from "../../src/main/resourcePackDownloader";

describe("resource pack downloader", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("streams a successful HTTPS response into the caller-owned open handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "resource-pack-download-"));
    temporaryDirectories.push(root);
    const path = join(root, "archive.partial");
    const destination = await open(path, "w+");
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetch: ResourcePackFetch = async (input, init) => {
      fetchCalls.push({ url: input.toString(), init });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Length": "3" }
      });
    };

    try {
      const result = await downloadResourcePack(
        "https://downloads.example.test/archive.zip",
        destination,
        { fetch }
      );

      expect(result).toEqual({
        bytesWritten: 3,
        finalUrl: "https://downloads.example.test/archive.zip",
        redirectCount: 0
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]).toMatchObject({
        url: "https://downloads.example.test/archive.zip",
        init: { redirect: "manual" }
      });
      expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
      await expect(destination.stat()).resolves.toMatchObject({ size: 3 });
    } finally {
      await destination.close();
    }
  });

  it.each([
    ["http://downloads.example.test/archive.zip", "non-HTTPS schemes"],
    ["https://user:secret@downloads.example.test/archive.zip", "credentials"],
    ["https://downloads.example.test/archive.zip#signed", "fragments"],
    ["https://downloads.example.test/archive.zip#", "empty fragments"],
    ["not a URL", "malformed URLs"]
  ])("rejects %s before making a request (%s)", async (source) => {
    let fetchCalled = false;
    await expectDownloadFailure(
      source,
      async () => {
        fetchCalled = true;
        throw new Error("fetch must not be called");
      },
      "RESOURCE_PACK_DOWNLOAD_URL_INVALID"
    );
    expect(fetchCalled).toBe(false);
  });

  it("follows a relative redirect manually and revalidates the final response", async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const fetch: ResourcePackFetch = async (input, init) => {
      const url = input.toString();
      calls.push({ url, redirect: init.redirect });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/release/archive.zip" }
        });
      }
      return new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: { "Content-Length": "2" }
      });
    };
    const fixture = await createDestination();

    try {
      const result = await downloadResourcePack(
        "https://downloads.example.test/start",
        fixture.handle,
        { fetch }
      );

      expect(calls).toEqual([
        {
          url: "https://downloads.example.test/start",
          redirect: "manual"
        },
        {
          url: "https://downloads.example.test/release/archive.zip",
          redirect: "manual"
        }
      ]);
      expect(result).toEqual({
        bytesWritten: 2,
        finalUrl: "https://downloads.example.test/release/archive.zip",
        redirectCount: 1
      });
      expect(await readFile(fixture.path)).toEqual(Buffer.from([4, 5]));
    } finally {
      await fixture.handle.close();
    }
  });

  it.each([
    [undefined, "missing Location"],
    ["", "empty Location"],
    ["http://[", "malformed Location"]
  ])("rejects a redirect with %s (%s)", async (location, _description) => {
    await expectDownloadFailure(
      "https://downloads.example.test/start",
      async () => new Response(null, {
        status: 302,
        headers: location === undefined ? undefined : { Location: location }
      }),
      "RESOURCE_PACK_DOWNLOAD_REDIRECT_INVALID"
    );
  });

  it.each([
    ["http://downloads.example.test/archive.zip", "non-HTTPS target"],
    ["https://user:secret@downloads.example.test/archive.zip", "credential target"],
    ["https://downloads.example.test/archive.zip#fragment", "fragment target"],
    ["#", "empty fragment target"]
  ])("reapplies URL policy to every redirect: %s (%s)", async (location) => {
    await expectDownloadFailure(
      "https://downloads.example.test/start",
      async () => new Response(null, {
        status: 302,
        headers: { Location: location }
      }),
      "RESOURCE_PACK_DOWNLOAD_URL_INVALID"
    );
  });

  it("allows an encoded fragment character in a redirected path", async () => {
    const fixture = await createDestination();
    let requestCount = 0;
    try {
      const result = await downloadResourcePack(
        "https://downloads.example.test/start",
        fixture.handle,
        {
          fetch: async () => {
            requestCount += 1;
            if (requestCount === 1) {
              return new Response(null, {
                status: 302,
                headers: { Location: "/archive%23v1.zip" }
              });
            }
            return new Response(new Uint8Array([1]));
          }
        }
      );

      expect(result.finalUrl).toBe(
        "https://downloads.example.test/archive%23v1.zip"
      );
      expect(await readFile(fixture.path)).toEqual(Buffer.from([1]));
    } finally {
      await fixture.handle.close();
    }
  });

  it("rejects redirect loops before requesting the repeated target", async () => {
    const calls: string[] = [];
    await expectDownloadFailure(
      "https://downloads.example.test/one",
      async (input) => {
        calls.push(input.toString());
        return new Response(null, {
          status: 302,
          headers: { Location: "/one" }
        });
      },
      "RESOURCE_PACK_DOWNLOAD_REDIRECT_LOOP"
    );
    expect(calls).toEqual(["https://downloads.example.test/one"]);
  });

  it("rejects redirects beyond the configured downward-only maximum", async () => {
    const calls: string[] = [];
    await expectDownloadFailure(
      "https://downloads.example.test/one",
      async (input) => {
        calls.push(input.toString());
        return new Response(null, {
          status: 302,
          headers: {
            Location: calls.length === 1 ? "/two" : "/three"
          }
        });
      },
      "RESOURCE_PACK_DOWNLOAD_REDIRECT_LIMIT",
      { policy: { maxRedirects: 1 } }
    );
    expect(calls).toEqual([
      "https://downloads.example.test/one",
      "https://downloads.example.test/two"
    ]);
  });

  it("rejects non-success HTTP status without exposing its response body", async () => {
    await expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response("server details", { status: 503 }),
      "RESOURCE_PACK_DOWNLOAD_HTTP_STATUS"
    );
  });

  it("aborts a request that exceeds the response timeout", async () => {
    const clock = new ManualClock();
    let requestSignal: AbortSignal | undefined;
    const fetch: ResourcePackFetch = async (_input, init) => {
      requestSignal = init.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(requestSignal?.reason);
        }, { once: true });
      });
    };
    const pending = expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      fetch,
      "RESOURCE_PACK_DOWNLOAD_RESPONSE_TIMEOUT",
      {
        clock,
        policy: { responseTimeoutMs: 5 }
      }
    );

    await waitForTimer(clock, 5);
    clock.advance(5);
    await pending;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("distinguishes a stalled body idle timeout from the response timeout", async () => {
    const clock = new ManualClock();
    const body = new ReadableStream<Uint8Array>();
    const pending = expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(body),
      "RESOURCE_PACK_DOWNLOAD_BODY_IDLE_TIMEOUT",
      {
        clock,
        policy: {
          responseTimeoutMs: 20,
          bodyIdleTimeoutMs: 5,
          bodyOverallTimeoutMs: 20
        }
      }
    );

    await waitForTimer(clock, 5);
    clock.advance(5);
    await pending;
  });

  it("finishes a body timeout without awaiting stalled stream cancellation", async () => {
    const clock = new ManualClock();
    const fixture = await createDestination();
    const cancellation = createStalledCancellationStream();
    let truncateCount = 0;
    let notifyFailureTruncate: (() => void) | undefined;
    const failureTruncateStarted = new Promise<void>((resolve) => {
      notifyFailureTruncate = resolve;
    });
    const destination = {
      write: fixture.handle.write.bind(fixture.handle),
      async truncate(length?: number) {
        truncateCount += 1;
        if (truncateCount === 2) notifyFailureTruncate?.();
        await fixture.handle.truncate(length);
      }
    };
    let thrown: unknown;

    try {
      const pending = downloadResourcePack(
        "https://downloads.example.test/archive.zip",
        destination,
        {
          fetch: async () => new Response(cancellation.body),
          clock,
          policy: {
            bodyIdleTimeoutMs: 5,
            bodyOverallTimeoutMs: 20
          }
        }
      ).catch((error: unknown) => {
        thrown = error;
      });
      await waitForTimer(clock, 5);
      clock.advance(5);
      await cancellation.started;
      await failureTruncateStarted;
      cancellation.release();
      await pending;

      expect(thrown).toMatchObject({
        code: "RESOURCE_PACK_DOWNLOAD_BODY_IDLE_TIMEOUT"
      });
      expect(clock.hasPendingTimer()).toBe(false);
      expect(await readFile(fixture.path)).toEqual(Buffer.alloc(0));
      await expect(fixture.handle.stat()).resolves.toMatchObject({ size: 0 });
    } finally {
      cancellation.release();
      await fixture.handle.close();
    }
  });

  it("distinguishes the body overall deadline from the idle timeout", async () => {
    const clock = new ManualClock();
    const pending = expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(new ReadableStream<Uint8Array>()),
      "RESOURCE_PACK_DOWNLOAD_BODY_OVERALL_TIMEOUT",
      {
        clock,
        policy: {
          responseTimeoutMs: 20,
          bodyIdleTimeoutMs: 20,
          bodyOverallTimeoutMs: 5
        }
      }
    );

    await waitForTimer(clock, 5);
    clock.advance(5);
    await pending;
  });

  it("honors a caller abort independently from all timeout codes", async () => {
    const abortController = new AbortController();
    const fetch: ResourcePackFetch = async (_input, init) => {
      const signal = init.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      });
    };
    const pending = expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      fetch,
      "RESOURCE_PACK_DOWNLOAD_ABORTED",
      { signal: abortController.signal }
    );

    abortController.abort(new Error("caller stopped"));
    await pending;
  });

  it("interrupts a stalled response body when the caller aborts", async () => {
    const abortController = new AbortController();
    const clock = new ManualClock();
    const fixture = await createDestination();
    let notifyReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        notifyReadStarted?.();
      }
    }, { highWaterMark: 0 });
    let thrown: unknown;

    try {
      const pending = downloadResourcePack(
        "https://downloads.example.test/archive.zip",
        fixture.handle,
        {
          fetch: async () => new Response(body),
          signal: abortController.signal,
          clock,
          policy: {
            bodyIdleTimeoutMs: 5,
            bodyOverallTimeoutMs: 20
          }
        }
      ).catch((error: unknown) => {
        thrown = error;
      });
      await readStarted;
      abortController.abort(new Error("caller stopped"));
      const settledBeforeBodyTimeout = await waitForSettlement(pending, 5_000);
      if (!settledBeforeBodyTimeout) {
        clock.advance(5);
      }
      await pending;

      expect(settledBeforeBodyTimeout).toBe(true);
      expect(thrown).toMatchObject({
        code: "RESOURCE_PACK_DOWNLOAD_ABORTED"
      });
      expect(await readFile(fixture.path)).toEqual(Buffer.alloc(0));
      await expect(fixture.handle.stat()).resolves.toMatchObject({ size: 0 });
    } finally {
      await fixture.handle.close();
    }
  });

  it("finishes caller abort without awaiting stalled stream cancellation", async () => {
    const abortController = new AbortController();
    const clock = new ManualClock();
    const fixture = await createDestination();
    const cancellation = createStalledCancellationStream();
    let truncateCount = 0;
    let notifyFailureTruncate: (() => void) | undefined;
    const failureTruncateStarted = new Promise<void>((resolve) => {
      notifyFailureTruncate = resolve;
    });
    const destination = {
      write: fixture.handle.write.bind(fixture.handle),
      async truncate(length?: number) {
        truncateCount += 1;
        if (truncateCount === 2) notifyFailureTruncate?.();
        await fixture.handle.truncate(length);
      }
    };
    let thrown: unknown;

    try {
      const pending = downloadResourcePack(
        "https://downloads.example.test/archive.zip",
        destination,
        {
          fetch: async () => new Response(cancellation.body),
          signal: abortController.signal,
          clock
        }
      ).catch((error: unknown) => {
        thrown = error;
      });
      await cancellation.pulled;
      abortController.abort(new Error("caller stopped"));
      await cancellation.started;
      await failureTruncateStarted;
      cancellation.release();
      await pending;

      expect(thrown).toMatchObject({
        code: "RESOURCE_PACK_DOWNLOAD_ABORTED"
      });
      expect(clock.hasPendingTimer()).toBe(false);
      expect(await readFile(fixture.path)).toEqual(Buffer.alloc(0));
      await expect(fixture.handle.stat()).resolves.toMatchObject({ size: 0 });
    } finally {
      cancellation.release();
      await fixture.handle.close();
    }
  });

  it("follows a redirect without awaiting stalled response cancellation", async () => {
    const fixture = await createDestination();
    const cancellation = createStalledCancellationStream();
    let requestCount = 0;
    let notifySecondRequest: (() => void) | undefined;
    const secondRequestStarted = new Promise<void>((resolve) => {
      notifySecondRequest = resolve;
    });

    try {
      const pending = downloadResourcePack(
        "https://downloads.example.test/start",
        fixture.handle,
        {
          fetch: async () => {
            requestCount += 1;
            if (requestCount === 1) {
              return new Response(cancellation.body, {
                status: 302,
                headers: { Location: "/archive.zip" }
              });
            }
            notifySecondRequest?.();
            return new Response(new Uint8Array([7]));
          }
        }
      );
      await cancellation.started;
      await secondRequestStarted;
      cancellation.release();
      const result = await pending;

      expect(requestCount).toBe(2);
      expect(result.redirectCount).toBe(1);
      expect(await readFile(fixture.path)).toEqual(Buffer.from([7]));
    } finally {
      cancellation.release();
      await fixture.handle.close();
    }
  });

  it("absorbs a synchronous redirect cancellation failure", async () => {
    const fixture = await createDestination();
    const redirectBody = new ReadableStream<Uint8Array>();
    redirectBody.cancel = (() => {
      throw new Error("cancel failed synchronously");
    }) as typeof redirectBody.cancel;
    let requestCount = 0;

    try {
      const result = await downloadResourcePack(
        "https://downloads.example.test/start",
        fixture.handle,
        {
          fetch: async () => {
            requestCount += 1;
            if (requestCount === 1) {
              return new Response(redirectBody, {
                status: 302,
                headers: { Location: "/archive.zip" }
              });
            }
            return new Response(new Uint8Array([8]));
          }
        }
      );

      expect(result.redirectCount).toBe(1);
      expect(await readFile(fixture.path)).toEqual(Buffer.from([8]));
    } finally {
      await fixture.handle.close();
    }
  });

  it("absorbs an asynchronous redirect cancellation rejection", async () => {
    const fixture = await createDestination();
    const redirectBody = new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(new Error("cancel rejected"));
      }
    });
    let requestCount = 0;

    try {
      const result = await downloadResourcePack(
        "https://downloads.example.test/start",
        fixture.handle,
        {
          fetch: async () => {
            requestCount += 1;
            if (requestCount === 1) {
              return new Response(redirectBody, {
                status: 302,
                headers: { Location: "/archive.zip" }
              });
            }
            return new Response(new Uint8Array([9]));
          }
        }
      );
      await Promise.resolve();

      expect(result.redirectCount).toBe(1);
      expect(await readFile(fixture.path)).toEqual(Buffer.from([9]));
    } finally {
      await fixture.handle.close();
    }
  });

  it.each([
    "-1",
    "3.5",
    "1, 1",
    "9007199254740992"
  ])("rejects malformed Content-Length %s before reading the body", async (value) => {
    let bodyPulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyPulled = true;
        controller.close();
      }
    }, { highWaterMark: 0 });
    await expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(body, {
        headers: { "Content-Length": value }
      }),
      "RESOURCE_PACK_DOWNLOAD_CONTENT_LENGTH_INVALID"
    );
    expect(bodyPulled).toBe(false);
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    let bodyPulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyPulled = true;
        controller.close();
      }
    }, { highWaterMark: 0 });
    await expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(body, {
        headers: { "Content-Length": "4" }
      }),
      "RESOURCE_PACK_DOWNLOAD_SIZE_LIMIT",
      { policy: { maxDownloadBytes: 3 } }
    );
    expect(bodyPulled).toBe(false);
  });

  it("counts actual streamed bytes and rejects overflow without retaining output", async () => {
    await expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(new Uint8Array([1, 2, 3, 4])),
      "RESOURCE_PACK_DOWNLOAD_SIZE_LIMIT",
      { policy: { maxDownloadBytes: 3 } }
    );
  });

  it("counts cumulative bytes across chunks before rejecting overflow", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      }
    });
    await expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(body),
      "RESOURCE_PACK_DOWNLOAD_SIZE_LIMIT",
      { policy: { maxDownloadBytes: 3 } }
    );
  });

  it("rejects a body whose actual size differs from valid Content-Length", async () => {
    await expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(new Uint8Array([1, 2]), {
        headers: { "Content-Length": "3" }
      }),
      "RESOURCE_PACK_DOWNLOAD_LENGTH_MISMATCH"
    );
  });

  it("rejects a success response without a readable body", async () => {
    await expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(null, { status: 204 }),
      "RESOURCE_PACK_DOWNLOAD_BODY_MISSING"
    );
  });

  it("converts a destination write failure and leaves the caller-owned handle empty and open", async () => {
    const fixture = await createDestination(Buffer.from([9, 9]));
    let writeCount = 0;
    const failingDestination = {
      truncate: fixture.handle.truncate.bind(fixture.handle),
      async write(
        buffer: Uint8Array,
        options: { offset: number; length: number; position: number }
      ) {
        writeCount += 1;
        if (writeCount === 1) {
          return await fixture.handle.write(buffer, options);
        }
        throw new Error("disk full");
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2]));
        controller.close();
      }
    });

    try {
      await expect(
        downloadResourcePack(
          "https://downloads.example.test/archive.zip",
          failingDestination,
          { fetch: async () => new Response(body) }
        )
      ).rejects.toMatchObject({
        code: "RESOURCE_PACK_DOWNLOAD_WRITE_FAILED"
      });
      expect(await readFile(fixture.path)).toEqual(Buffer.alloc(0));
      await expect(fixture.handle.stat()).resolves.toMatchObject({ size: 0 });
    } finally {
      await fixture.handle.close();
    }
  });

  it("continues valid partial writes until the complete chunk is persisted", async () => {
    const fixture = await createDestination();
    const partialDestination = {
      truncate: fixture.handle.truncate.bind(fixture.handle),
      async write(
        buffer: Uint8Array,
        options: { offset: number; length: number; position: number }
      ) {
        return await fixture.handle.write(buffer, {
          ...options,
          length: Math.min(1, options.length)
        });
      }
    };

    try {
      const result = await downloadResourcePack(
        "https://downloads.example.test/archive.zip",
        partialDestination,
        { fetch: async () => new Response(new Uint8Array([1, 2, 3])) }
      );

      expect(result.bytesWritten).toBe(3);
      expect(await readFile(fixture.path)).toEqual(Buffer.from([1, 2, 3]));
      await expect(fixture.handle.stat()).resolves.toMatchObject({ size: 3 });
    } finally {
      await fixture.handle.close();
    }
  });

  it.each([
    [0, "zero progress"],
    [-1, "negative progress"],
    [4, "progress beyond the requested length"],
    [1.5, "fractional progress"],
    [Number.NaN, "NaN progress"],
    [Number.POSITIVE_INFINITY, "infinite progress"]
  ])("rejects FileHandle.write %s (%s)", async (bytesWritten) => {
    const fixture = await createDestination();
    const invalidDestination = {
      truncate: fixture.handle.truncate.bind(fixture.handle),
      async write(buffer: Uint8Array) {
        return { bytesWritten, buffer };
      }
    };

    try {
      await expect(
        downloadResourcePack(
          "https://downloads.example.test/archive.zip",
          invalidDestination,
          { fetch: async () => new Response(new Uint8Array([1, 2, 3])) }
        )
      ).rejects.toMatchObject({
        code: "RESOURCE_PACK_DOWNLOAD_WRITE_FAILED"
      });
      expect(await readFile(fixture.path)).toEqual(Buffer.alloc(0));
      await expect(fixture.handle.stat()).resolves.toMatchObject({ size: 0 });
    } finally {
      await fixture.handle.close();
    }
  });

  it("does not allow injected policy values to raise production security limits", async () => {
    await expectDownloadFailure(
      "https://downloads.example.test/archive.zip",
      async () => new Response(new Uint8Array([1])),
      "RESOURCE_PACK_DOWNLOAD_POLICY_INVALID",
      { policy: { maxRedirects: 6 } }
    );
  });

  async function createDestination(initial = Buffer.from([9, 9, 9])) {
    const root = await mkdtemp(join(tmpdir(), "resource-pack-download-"));
    temporaryDirectories.push(root);
    const path = join(root, "archive.partial");
    const handle = await open(path, "w+");
    await handle.write(initial, {
      offset: 0,
      length: initial.byteLength,
      position: 0
    });
    return { path, handle };
  }

  async function expectDownloadFailure(
    source: string,
    fetch: ResourcePackFetch,
    code: ResourcePackDownloadErrorCode,
    options: Omit<ResourcePackDownloadOptions, "fetch"> = {}
  ): Promise<void> {
    const fixture = await createDestination();
    try {
      let thrown: unknown;
      try {
        await downloadResourcePack(source, fixture.handle, {
          ...options,
          fetch
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ResourcePackDownloadError);
      expect(thrown).toMatchObject({ code });
      if (thrown instanceof Error) {
        expect(thrown.message).not.toContain(source);
      }
      expect(await readFile(fixture.path)).toEqual(Buffer.alloc(0));
      await expect(fixture.handle.stat()).resolves.toMatchObject({ size: 0 });
    } finally {
      await fixture.handle.close();
    }
  }
});

class ManualClock implements ResourcePackDownloadClock {
  #now = 0;
  #nextId = 1;
  #timers = new Map<number, { deadline: number; callback: () => void }>();
  #timerWaiters: Array<{ maximumDelay: number; resolve: () => void }> = [];

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, {
      deadline: this.#now + delayMs,
      callback
    });
    const ready = this.#timerWaiters.filter(({ maximumDelay }) =>
      this.hasTimerWithin(maximumDelay)
    );
    this.#timerWaiters = this.#timerWaiters.filter(({ maximumDelay }) =>
      !this.hasTimerWithin(maximumDelay)
    );
    for (const { resolve } of ready) resolve();
    return id;
  }

  clearTimeout(timer: unknown): void {
    if (typeof timer === "number") this.#timers.delete(timer);
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    const due = [...this.#timers.entries()]
      .filter(([, timer]) => timer.deadline <= this.#now)
      .sort((left, right) => left[1].deadline - right[1].deadline);
    for (const [id, timer] of due) {
      if (!this.#timers.delete(id)) continue;
      timer.callback();
    }
  }

  hasPendingTimer(): boolean {
    return this.#timers.size > 0;
  }

  async waitForScheduledTimer(maximumDelay: number): Promise<void> {
    if (this.hasTimerWithin(maximumDelay)) return;
    await new Promise<void>((resolve) => {
      this.#timerWaiters.push({ maximumDelay, resolve });
    });
  }

  private hasTimerWithin(maximumDelay: number): boolean {
    return [...this.#timers.values()].some(
      ({ deadline }) => deadline <= this.#now + maximumDelay
    );
  }
}

async function waitForTimer(
  clock: ManualClock,
  maximumDelay: number
): Promise<void> {
  await clock.waitForScheduledTimer(maximumDelay);
}

async function waitForSettlement(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function createStalledCancellationStream() {
  let notifyPulled: (() => void) | undefined;
  let notifyStarted: (() => void) | undefined;
  let completeCancellation: (() => void) | undefined;
  const pulled = new Promise<void>((resolve) => {
    notifyPulled = resolve;
  });
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull() {
      notifyPulled?.();
    },
    cancel() {
      notifyStarted?.();
      return new Promise<void>((resolve) => {
        completeCancellation = resolve;
      });
    }
  }, { highWaterMark: 0 });
  return {
    body,
    pulled,
    started,
    release() {
      completeCancellation?.();
    }
  };
}
