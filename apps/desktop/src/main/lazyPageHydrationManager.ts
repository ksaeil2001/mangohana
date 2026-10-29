import type {
  HydratedPageChunkDto,
  PageChunk,
  ProjectManifest
} from "../shared/projectChunkTypes.js";
import { computeChunkHash } from "../shared/projectChunkAdapter.js";
import {
  computeViewportHydrationPlan,
  DEFAULT_PREFETCH_RADIUS,
  DEFAULT_VIEWPORT_CAPACITY
} from "../shared/viewportCache.js";

export type PageChunkLoader = (
  pageNumber: number
) => Promise<PageChunk | undefined> | PageChunk | undefined;

export type LazyPageHydrationManagerOptions = {
  manifest: ProjectManifest;
  chunkLoader: PageChunkLoader;
  maxCapacity?: number;
  prefetchRadius?: number;
  initialChunks?: PageChunk[];
};

export type LazyPageHydrationManager = {
  getManifest: () => ProjectManifest;
  isPageHydrated: (pageNumber: number) => boolean;
  getHydratedPageNumbers: () => number[];
  getDirtyPageNumbers: () => number[];
  isDirty: () => boolean;
  isManifestDirty: () => boolean;
  requestPage: (
    pageNumber: number,
    options?: { prefetchRadius?: number }
  ) => Promise<HydratedPageChunkDto>;
  prefetchNeighbors: (
    currentPageNumber: number,
    radius?: number
  ) => Promise<number[]>;
  updatePage: (
    pageNumber: number,
    updater: (chunk: PageChunk) => void
  ) => void;
  updateManifest: (updater: (manifest: ProjectManifest) => void) => void;
  evictCleanPage: (pageNumber: number) => boolean;
  markClean: (savedPageNumbers?: number[]) => void;
  flushDirtyChunks: () => PageChunk[];
  getAllHydratedChunks: () => PageChunk[];
};

export function createLazyPageHydrationManager(
  options: LazyPageHydrationManagerOptions
): LazyPageHydrationManager {
  let manifest = structuredClone(options.manifest);
  const chunkLoader = options.chunkLoader;
  const maxCapacity = options.maxCapacity ?? DEFAULT_VIEWPORT_CAPACITY;
  const defaultRadius = options.prefetchRadius ?? DEFAULT_PREFETCH_RADIUS;

  const cache = new Map<number, PageChunk>();
  const cleanHashes = new Map<number, string>();
  const dirtyPages = new Set<number>();
  let dirtyManifest = false;
  const accessHistory: number[] = [];

  if (options.initialChunks) {
    for (const chunk of options.initialChunks) {
      cache.set(chunk.pageNumber, structuredClone(chunk));
      cleanHashes.set(chunk.pageNumber, computeChunkHash(chunk));
    }
  }

  function recordAccess(pageNumber: number): void {
    const idx = accessHistory.indexOf(pageNumber);
    if (idx >= 0) {
      accessHistory.splice(idx, 1);
    }
    accessHistory.push(pageNumber);
  }

  function getAllPageNumbers(): number[] {
    return manifest.pageIndex.map((p) => p.pageNumber).sort((a, b) => a - b);
  }

  function getManifest(): ProjectManifest {
    return structuredClone(manifest);
  }

  function isPageHydrated(pageNumber: number): boolean {
    return cache.has(pageNumber);
  }

  function getHydratedPageNumbers(): number[] {
    return [...cache.keys()].sort((a, b) => a - b);
  }

  function getDirtyPageNumbers(): number[] {
    return [...dirtyPages].sort((a, b) => a - b);
  }

  function isDirty(): boolean {
    return dirtyManifest || dirtyPages.size > 0;
  }

  function isManifestDirty(): boolean {
    return dirtyManifest;
  }

  async function loadChunkInternal(pageNumber: number): Promise<PageChunk> {
    const existing = cache.get(pageNumber);
    if (existing) return existing;

    const loaded = await chunkLoader(pageNumber);
    if (!loaded) {
      throw new Error(`Page chunk ${pageNumber} could not be loaded`);
    }

    cache.set(pageNumber, structuredClone(loaded));
    cleanHashes.set(pageNumber, computeChunkHash(loaded));
    return loaded;
  }

  function applyEviction(toEvict: number[]): void {
    for (const pageNumber of toEvict) {
      if (!dirtyPages.has(pageNumber)) {
        cache.delete(pageNumber);
        cleanHashes.delete(pageNumber);
        const idx = accessHistory.indexOf(pageNumber);
        if (idx >= 0) accessHistory.splice(idx, 1);
      }
    }
  }

  async function requestPage(
    pageNumber: number,
    opts?: { prefetchRadius?: number }
  ): Promise<HydratedPageChunkDto> {
    recordAccess(pageNumber);

    const chunk = await loadChunkInternal(pageNumber);
    const radius = opts?.prefetchRadius ?? defaultRadius;

    // Run prefetch & eviction planning
    const plan = computeViewportHydrationPlan({
      currentPageNumber: pageNumber,
      allPageNumbers: getAllPageNumbers(),
      currentlyHydratedPages: getHydratedPageNumbers(),
      dirtyPages: getDirtyPageNumbers(),
      maxCapacity,
      prefetchRadius: radius,
      accessHistory
    });

    // Execute planned evictions
    applyEviction(plan.toEvict);

    // Background pre-fetch without blocking the active page return
    if (plan.toHydrate.length > 0) {
      Promise.all(
        plan.toHydrate.map(async (prefetchPage) => {
          try {
            await loadChunkInternal(prefetchPage);
          } catch {
            // Pre-fetch is opportunistic; failure is non-fatal
          }
        })
      ).catch(() => undefined);
    }

    return {
      ...structuredClone(chunk),
      chunkHash: computeChunkHash(chunk)
    };
  }

  async function prefetchNeighbors(
    currentPageNumber: number,
    radius = defaultRadius
  ): Promise<number[]> {
    const plan = computeViewportHydrationPlan({
      currentPageNumber,
      allPageNumbers: getAllPageNumbers(),
      currentlyHydratedPages: getHydratedPageNumbers(),
      dirtyPages: getDirtyPageNumbers(),
      maxCapacity,
      prefetchRadius: radius,
      accessHistory
    });

    applyEviction(plan.toEvict);

    const prefetched: number[] = [];
    for (const pageNum of plan.toHydrate) {
      try {
        await loadChunkInternal(pageNum);
        prefetched.push(pageNum);
      } catch {
        // Opportunistic
      }
    }
    return prefetched;
  }

  function updatePage(
    pageNumber: number,
    updater: (chunk: PageChunk) => void
  ): void {
    const chunk = cache.get(pageNumber);
    if (!chunk) {
      throw new Error(`Cannot update unhydrated page ${pageNumber}. Hydrate it first.`);
    }

    updater(chunk);
    const newHash = computeChunkHash(chunk);
    if (newHash !== cleanHashes.get(pageNumber)) {
      dirtyPages.add(pageNumber);
    }

    // Update manifest summary entry
    const indexEntry = manifest.pageIndex.find((p) => p.pageNumber === pageNumber);
    if (indexEntry) {
      indexEntry.dialogueCount = chunk.dialogueLines.length;
      indexEntry.hasTypesetting = chunk.dialogueLines.some((l) => l.typesetting !== undefined);
      indexEntry.chunkHash = newHash;
      dirtyManifest = true;
    }
  }

  function updateManifest(updater: (m: ProjectManifest) => void): void {
    updater(manifest);
    dirtyManifest = true;
  }

  function evictCleanPage(pageNumber: number): boolean {
    if (dirtyPages.has(pageNumber) || !cache.has(pageNumber)) {
      return false;
    }
    cache.delete(pageNumber);
    cleanHashes.delete(pageNumber);
    const idx = accessHistory.indexOf(pageNumber);
    if (idx >= 0) accessHistory.splice(idx, 1);
    return true;
  }

  function markClean(savedPageNumbers?: number[]): void {
    if (savedPageNumbers) {
      for (const pageNum of savedPageNumbers) {
        dirtyPages.delete(pageNum);
        const chunk = cache.get(pageNum);
        if (chunk) {
          cleanHashes.set(pageNum, computeChunkHash(chunk));
        }
      }
    } else {
      dirtyPages.clear();
      dirtyManifest = false;
      for (const [pageNum, chunk] of cache.entries()) {
        cleanHashes.set(pageNum, computeChunkHash(chunk));
      }
    }
  }

  function flushDirtyChunks(): PageChunk[] {
    const dirtyList: PageChunk[] = [];
    for (const pageNum of dirtyPages) {
      const chunk = cache.get(pageNum);
      if (chunk) {
        dirtyList.push(structuredClone(chunk));
      }
    }
    return dirtyList;
  }

  function getAllHydratedChunks(): PageChunk[] {
    return [...cache.values()].map((c) => structuredClone(c));
  }

  return {
    getManifest,
    isPageHydrated,
    getHydratedPageNumbers,
    getDirtyPageNumbers,
    isDirty,
    isManifestDirty,
    requestPage,
    prefetchNeighbors,
    updatePage,
    updateManifest,
    evictCleanPage,
    markClean,
    flushDirtyChunks,
    getAllHydratedChunks
  };
}
