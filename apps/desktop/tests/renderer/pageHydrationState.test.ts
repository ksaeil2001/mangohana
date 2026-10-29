import { describe, expect, it, vi } from "vitest";
import { createPageHydrationCoordinator } from "../../src/renderer/pageHydrationState.js";
import type { ElectronProjectApi } from "../../src/renderer/electronApi.js";
import type { HydratedPageChunkDto } from "../../src/shared/projectChunkTypes.js";

function createMockChunk(pageNumber: number): HydratedPageChunkDto {
  return {
    pageNumber,
    pageImageId: `img-${pageNumber}`,
    chunkHash: `hash-${pageNumber}`,
    dialogueLines: [
      {
        id: `line-${pageNumber}`,
        order: 1,
        pageNumber,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: `Page ${pageNumber} text`,
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    ],
    runs: [],
    assets: []
  };
}

describe("pageHydrationState - Client Page Hydration Coordinator", () => {
  it("requests page chunk via IPC and caches it for future requests", async () => {
    const mockHydratePage = vi.fn().mockImplementation(async (args: { pageNumber: number }) => {
      return {
        ok: true,
        chunk: createMockChunk(args.pageNumber),
        prefetchedPageNumbers: []
      };
    });

    const api: Partial<ElectronProjectApi> = {
      hydratePage: mockHydratePage
    };

    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-1",
      api: api as ElectronProjectApi
    });

    expect(coordinator.isPageLoaded(1)).toBe(false);

    // 1. Initial request (fetches via IPC)
    const chunk = await coordinator.requestPage(1);
    expect(chunk?.pageNumber).toBe(1);
    expect(mockHydratePage).toHaveBeenCalledTimes(1);
    expect(coordinator.isPageLoaded(1)).toBe(true);
    expect(coordinator.getLoadedPageNumbers()).toEqual([1]);

    // 2. Second request (cache hit, no second IPC call)
    const cached = await coordinator.requestPage(1);
    expect(cached?.pageNumber).toBe(1);
    expect(mockHydratePage).toHaveBeenCalledTimes(1);
  });


  it("handles IPC failures and records error message", async () => {
    const mockHydratePage = vi.fn().mockResolvedValue({
      ok: false,
      message: "Page 999 not found"
    });

    const api: Partial<ElectronProjectApi> = {
      hydratePage: mockHydratePage
    };

    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-1",
      api: api as ElectronProjectApi
    });

    const chunk = await coordinator.requestPage(999);
    expect(chunk).toBeUndefined();
    expect(coordinator.isPageLoaded(999)).toBe(false);
    expect(coordinator.getPageError(999)).toBe("Page 999 not found");
  });

  it("prefetches neighboring page chunks in background", async () => {
    const mockHydratePage = vi.fn().mockImplementation(async (args: { pageNumber: number }) => {
      return {
        ok: true,
        chunk: createMockChunk(args.pageNumber),
        prefetchedPageNumbers: []
      };
    });
    const mockPrefetchPages = vi.fn().mockResolvedValue([2, 3]);

    const api: Partial<ElectronProjectApi> = {
      hydratePage: mockHydratePage,
      prefetchPages: mockPrefetchPages
    };

    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-1",
      api: api as ElectronProjectApi
    });

    await coordinator.prefetchNeighbors(1, 2);
    expect(mockPrefetchPages).toHaveBeenCalledWith({
      projectSessionId: "session-1",
      pageNumber: 1,
      radius: 2
    });
  });

  it("updates cached chunk in place and notifies listeners", async () => {
    const coordinator = createPageHydrationCoordinator({
      initialChunks: [createMockChunk(1)]
    });

    expect(coordinator.isPageLoaded(1)).toBe(true);

    coordinator.updateChunk(1, (chunk) => {
      chunk.dialogueLines[0]!.userTranslation = "클라이언트 수정";
    });

    const updated = coordinator.getChunk(1);
    expect(updated?.dialogueLines[0]?.userTranslation).toBe("클라이언트 수정");
  });

  it("clears cache when switching project session id", () => {
    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-1",
      initialChunks: [createMockChunk(1), createMockChunk(2)]
    });

    expect(coordinator.getLoadedPageNumbers()).toEqual([1, 2]);

    coordinator.setProjectSessionId("session-2");
    expect(coordinator.getLoadedPageNumbers()).toEqual([]);
  });

  it("does not put a previous session hydrate result into the new session cache", async () => {
    let resolveHydrate!: (value: {
      ok: true;
      chunk: HydratedPageChunkDto;
      prefetchedPageNumbers: number[];
    }) => void;
    const deferredHydrate = new Promise<{
      ok: true;
      chunk: HydratedPageChunkDto;
      prefetchedPageNumbers: number[];
    }>((resolve) => {
      resolveHydrate = resolve;
    });
    const mockHydratePage = vi.fn().mockReturnValueOnce(deferredHydrate);
    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-a",
      api: { hydratePage: mockHydratePage } as unknown as ElectronProjectApi
    });

    const requestA = coordinator.requestPage(1);
    coordinator.setProjectSessionId("session-b");
    expect(coordinator.getLoadedPageNumbers()).toEqual([]);

    resolveHydrate({
      ok: true,
      chunk: createMockChunk(1),
      prefetchedPageNumbers: []
    });
    await expect(requestA).resolves.toBeUndefined();
    expect(coordinator.getLoadedPageNumbers()).toEqual([]);
    expect(coordinator.isPageLoaded(1)).toBe(false);
    expect(coordinator.isPageLoading(1)).toBe(false);
  });

  it("does not record a previous session hydrate rejection as the new session error", async () => {
    let rejectHydrate!: (reason: unknown) => void;
    const deferredHydrate = new Promise((_resolve, reject) => {
      rejectHydrate = reject;
    });
    const mockHydratePage = vi.fn().mockReturnValueOnce(deferredHydrate);
    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-a",
      api: { hydratePage: mockHydratePage } as unknown as ElectronProjectApi
    });

    const requestA = coordinator.requestPage(1);
    coordinator.setProjectSessionId("session-b");
    rejectHydrate(new Error("session A hydrate failed"));
    await expect(requestA).resolves.toBeUndefined();

    expect(coordinator.getPageError(1)).toBeUndefined();
    expect(coordinator.isPageLoading(1)).toBe(false);
    expect(coordinator.getLoadedPageNumbers()).toEqual([]);
  });

  it("does not hydrate previous-session pages after a late prefetch response", async () => {
    let resolvePrefetch!: (value: number[]) => void;
    const deferredPrefetch = new Promise<number[]>((resolve) => {
      resolvePrefetch = resolve;
    });
    const mockHydratePage = vi.fn().mockResolvedValue({
      ok: true,
      chunk: createMockChunk(2),
      prefetchedPageNumbers: []
    });
    const mockPrefetchPages = vi.fn().mockReturnValueOnce(deferredPrefetch);
    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-a",
      api: {
        hydratePage: mockHydratePage,
        prefetchPages: mockPrefetchPages
      } as unknown as ElectronProjectApi
    });

    const prefetchA = coordinator.prefetchNeighbors(1, 1);
    coordinator.setProjectSessionId("session-b");
    resolvePrefetch([2, 3]);
    await prefetchA;

    expect(mockHydratePage).not.toHaveBeenCalled();
    expect(coordinator.getLoadedPageNumbers()).toEqual([]);
  });

  it("shares one hydrate IPC across concurrent requestPage calls for the same page", async () => {
    let resolveHydrate!: (value: {
      ok: true;
      chunk: HydratedPageChunkDto;
      prefetchedPageNumbers: number[];
    }) => void;
    const deferredHydrate = new Promise<{
      ok: true;
      chunk: HydratedPageChunkDto;
      prefetchedPageNumbers: number[];
    }>((resolve) => {
      resolveHydrate = resolve;
    });
    const mockHydratePage = vi.fn().mockReturnValue(deferredHydrate);
    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-1",
      api: { hydratePage: mockHydratePage } as unknown as ElectronProjectApi
    });

    const first = coordinator.requestPage(4);
    const second = coordinator.requestPage(4);
    expect(mockHydratePage).toHaveBeenCalledTimes(1);
    expect(coordinator.isPageLoading(4)).toBe(true);

    const chunk = createMockChunk(4);
    resolveHydrate({
      ok: true,
      chunk,
      prefetchedPageNumbers: []
    });
    const [left, right] = await Promise.all([first, second]);
    expect(left?.pageNumber).toBe(4);
    expect(right?.pageNumber).toBe(4);
    expect(left?.dialogueLines[0]?.sourceText).toBe(right?.dialogueLines[0]?.sourceText);
    expect(mockHydratePage).toHaveBeenCalledTimes(1);
    expect(coordinator.isPageLoaded(4)).toBe(true);
  });

  it("allows a new hydrate request after a failed shared request", async () => {
    const mockHydratePage = vi.fn()
      .mockRejectedValueOnce(new Error("temporary hydrate failure"))
      .mockResolvedValueOnce({
        ok: true,
        chunk: createMockChunk(5),
        prefetchedPageNumbers: []
      });
    const coordinator = createPageHydrationCoordinator({
      projectSessionId: "session-1",
      api: { hydratePage: mockHydratePage } as unknown as ElectronProjectApi
    });

    const first = coordinator.requestPage(5);
    const second = coordinator.requestPage(5);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(coordinator.getPageError(5)).toBe("temporary hydrate failure");
    expect(mockHydratePage).toHaveBeenCalledTimes(1);

    const retried = await coordinator.requestPage(5);
    expect(retried?.pageNumber).toBe(5);
    expect(mockHydratePage).toHaveBeenCalledTimes(2);
    expect(coordinator.isPageLoaded(5)).toBe(true);
    expect(coordinator.getPageError(5)).toBeUndefined();
  });
});
