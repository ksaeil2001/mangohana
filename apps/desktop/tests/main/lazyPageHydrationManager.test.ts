import { describe, expect, it } from "vitest";
import { createLazyPageHydrationManager } from "../../src/main/lazyPageHydrationManager.js";
import type { PageChunk, ProjectManifest } from "../../src/shared/projectChunkTypes.js";

function createMockManifest(pageCount: number): ProjectManifest {
  const pageIndex = Array.from({ length: pageCount }, (_, i) => ({
    pageNumber: i + 1,
    pageImageId: `img-${i + 1}`,
    dialogueCount: 1,
    status: "untranslated" as const,
    hasInpainting: false,
    hasTypesetting: false,
    updatedAt: "2026-08-21T00:00:00.000Z",
    chunkHash: `hash-${i + 1}`
  }));

  return {
    schemaVersion: 2,
    metadata: {
      id: "lazy-proj",
      title: "Lazy Project",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      secret: false
    },
    characters: [],
    dictionaryTerms: [],
    pageImages: Array.from({ length: pageCount }, (_, i) => ({
      id: `img-${i + 1}`,
      pageNumber: i + 1,
      storedRelativePath: `images/${i + 1}.png`,
      originalFileName: `${i + 1}.png`,
      sha256: `sha-${i + 1}`,
      byteSize: 1000,
      mimeType: "image/png",
      copiedAt: "2026-08-21T00:00:00.000Z"
    })),
    settings: { defaultSourceLanguage: "ja" },
    pageIndex
  };
}

function createMockChunk(pageNumber: number): PageChunk {
  return {
    pageNumber,
    pageImageId: `img-${pageNumber}`,
    dialogueLines: [
      {
        id: `line-${pageNumber}-1`,
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

describe("lazyPageHydrationManager", () => {
  it("hydrates requested page on demand via loader and attaches hash", async () => {
    const loadedPages: number[] = [];
    const manifest = createMockManifest(10);

    const manager = createLazyPageHydrationManager({
      manifest,
      chunkLoader: async (pageNum) => {
        loadedPages.push(pageNum);
        return createMockChunk(pageNum);
      },
      maxCapacity: 5,
      prefetchRadius: 1
    });

    expect(manager.isPageHydrated(1)).toBe(false);

    const result = await manager.requestPage(1);

    expect(result.pageNumber).toBe(1);
    expect(result.chunkHash).toBeDefined();
    expect(manager.isPageHydrated(1)).toBe(true);
    expect(loadedPages).toContain(1);
  });

  it("modifies a hydrated page and marks it dirty", async () => {
    const manifest = createMockManifest(5);
    const manager = createLazyPageHydrationManager({
      manifest,
      chunkLoader: (p) => createMockChunk(p),
      maxCapacity: 3
    });

    await manager.requestPage(2);
    expect(manager.isDirty()).toBe(false);

    manager.updatePage(2, (chunk) => {
      chunk.dialogueLines[0]!.userTranslation = "페이지 2 번역 완료";
    });

    expect(manager.isDirty()).toBe(true);
    expect(manager.getDirtyPageNumbers()).toEqual([2]);

    const dirtyChunks = manager.flushDirtyChunks();
    expect(dirtyChunks).toHaveLength(1);
    expect(dirtyChunks[0]?.dialogueLines[0]?.userTranslation).toBe("페이지 2 번역 완료");
  });

  it("evicts clean pages according to LRU and keeps dirty pages safe", async () => {
    const manifest = createMockManifest(10);
    const manager = createLazyPageHydrationManager({
      manifest,
      chunkLoader: (p) => createMockChunk(p),
      maxCapacity: 3,
      prefetchRadius: 0 // Disable auto-prefetch to precisely test sequential requests
    });

    // Hydrate pages 1, 2, 3
    await manager.requestPage(1);
    await manager.requestPage(2);
    await manager.requestPage(3);

    // Make page 1 dirty
    manager.updatePage(1, (chunk) => {
      chunk.dialogueLines[0]!.notes = "중요 메모";
    });

    // Request page 4 -> exceeds capacity (maxCapacity = 3)
    // Page 1 is dirty (protected). Page 2 was accessed before Page 3.
    // Page 2 should be evicted!
    await manager.requestPage(4);

    expect(manager.isPageHydrated(1)).toBe(true); // dirty protected
    expect(manager.isPageHydrated(4)).toBe(true); // just accessed
    expect(manager.isPageHydrated(2)).toBe(false); // evicted clean page
  });
});
