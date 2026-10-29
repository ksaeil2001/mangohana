import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePageHydration } from "../../src/renderer/usePageHydration.js";
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
        sourceText: `Page ${pageNumber} speech text`,
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    ],
    runs: [],
    assets: []
  };
}

describe("usePageHydration - React Hook", () => {
  it("automatically requests page chunk on mount and updates state", async () => {
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

    const { result } = renderHook(() =>
      usePageHydration({
        projectSessionId: "session-1",
        currentPageNumber: 1,
        api: api as ElectronProjectApi
      })
    );

    await waitFor(() => {
      expect(result.current.chunk).toBeDefined();
    });

    expect(result.current.chunk?.pageNumber).toBe(1);
    expect(result.current.chunk?.dialogueLines[0]?.sourceText).toBe("Page 1 speech text");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.isLoaded(1)).toBe(true);
  });

  it("loads new page when currentPageNumber changes", async () => {
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

    let pageNum = 1;
    const { result, rerender } = renderHook(() =>
      usePageHydration({
        projectSessionId: "session-1",
        currentPageNumber: pageNum,
        api: api as ElectronProjectApi
      })
    );

    await waitFor(() => {
      expect(result.current.chunk?.pageNumber).toBe(1);
    });

    pageNum = 2;
    rerender();

    await waitFor(() => {
      expect(result.current.chunk?.pageNumber).toBe(2);
    });

    expect(result.current.loadedPageNumbers).toEqual([1, 2]);
  });

  it("supports in-memory updates via updateChunk", async () => {
    const { result } = renderHook(() =>
      usePageHydration({
        initialChunks: [createMockChunk(1)],
        currentPageNumber: 1
      })
    );

    expect(result.current.chunk?.dialogueLines[0]?.userTranslation).toBeUndefined();

    act(() => {
      result.current.updateChunk(1, (c) => {
        c.dialogueLines[0]!.userTranslation = "번역 완료";
      });
    });

    expect(result.current.chunk?.dialogueLines[0]?.userTranslation).toBe("번역 완료");
  });

  it("does not apply a previous session hydrate result after the session id changes", async () => {
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
    const mockHydratePage = vi.fn()
      .mockReturnValueOnce(deferredHydrate)
      .mockReturnValue(new Promise(() => undefined));
    const api = { hydratePage: mockHydratePage } as unknown as ElectronProjectApi;
    let sessionId = "session-a";
    const { result, rerender } = renderHook(() =>
      usePageHydration({
        projectSessionId: sessionId,
        currentPageNumber: 1,
        api
      })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockHydratePage).toHaveBeenCalledTimes(1);

    sessionId = "session-b";
    rerender();
    await act(async () => {
      resolveHydrate({
        ok: true,
        chunk: createMockChunk(1),
        prefetchedPageNumbers: []
      });
      await Promise.resolve();
    });

    expect(result.current.chunk).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(result.current.isLoaded(1)).toBe(false);
  });
});
