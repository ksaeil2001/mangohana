import type { HydratedPageChunkDto } from "../shared/projectChunkTypes.js";
import type { ElectronProjectApi } from "./electronApi.js";

export type PageHydrationCoordinatorOptions = {
  projectSessionId?: string;
  api?: ElectronProjectApi;
  initialChunks?: HydratedPageChunkDto[];
  prefetchRadius?: number;
  onStateChange?: () => void;
};

export type PageHydrationCoordinator = {
  getChunk: (pageNumber: number) => HydratedPageChunkDto | undefined;
  isPageLoaded: (pageNumber: number) => boolean;
  isPageLoading: (pageNumber: number) => boolean;
  getPageError: (pageNumber: number) => string | undefined;
  getLoadedPageNumbers: () => number[];
  requestPage: (pageNumber: number) => Promise<HydratedPageChunkDto | undefined>;
  prefetchNeighbors: (pageNumber: number, radius?: number) => Promise<void>;
  updateChunk: (
    pageNumber: number,
    updater: (chunk: HydratedPageChunkDto) => void
  ) => void;
  setProjectSessionId: (sessionId: string | undefined) => void;
  clear: () => void;
};

export function createPageHydrationCoordinator(
  options: PageHydrationCoordinatorOptions = {}
): PageHydrationCoordinator {
  let projectSessionId = options.projectSessionId;
  const defaultRadius = options.prefetchRadius ?? 1;
  const api = options.api ?? (typeof window !== "undefined" ? window.projectApi : undefined);
  const notify = options.onStateChange ?? (() => undefined);

  const chunks = new Map<number, HydratedPageChunkDto>();
  const loadingPages = new Set<number>();
  const errors = new Map<number, string>();
  const inFlightPages = new Map<number, Promise<HydratedPageChunkDto | undefined>>();
  let hydrationEpoch = 0;

  if (options.initialChunks) {
    for (const chunk of options.initialChunks) {
      chunks.set(chunk.pageNumber, structuredClone(chunk));
    }
  }

  function getChunk(pageNumber: number): HydratedPageChunkDto | undefined {
    const chunk = chunks.get(pageNumber);
    return chunk ? structuredClone(chunk) : undefined;
  }

  function isPageLoaded(pageNumber: number): boolean {
    return chunks.has(pageNumber);
  }

  function isPageLoading(pageNumber: number): boolean {
    return loadingPages.has(pageNumber);
  }

  function getPageError(pageNumber: number): string | undefined {
    return errors.get(pageNumber);
  }

  function getLoadedPageNumbers(): number[] {
    return [...chunks.keys()].sort((a, b) => a - b);
  }

  async function requestPage(
    pageNumber: number
  ): Promise<HydratedPageChunkDto | undefined> {
    const existing = chunks.get(pageNumber);
    if (existing) {
      prefetchNeighbors(pageNumber).catch(() => undefined);
      return structuredClone(existing);
    }

    const inFlight = inFlightPages.get(pageNumber);
    if (inFlight) return inFlight;

    if (!projectSessionId || !api?.hydratePage) {
      return undefined;
    }

    const requestSessionId = projectSessionId;
    const requestEpoch = hydrationEpoch;
    const hydratePage = api.hydratePage;
    loadingPages.add(pageNumber);
    errors.delete(pageNumber);
    notify();

    let request!: Promise<HydratedPageChunkDto | undefined>;
    request = (async () => {
      try {
        const result = await hydratePage({
          projectSessionId: requestSessionId,
          pageNumber,
          prefetchRadius: defaultRadius
        });
        if (!isCurrentHydration(requestSessionId, requestEpoch)) {
          return undefined;
        }

        if (result.ok) {
          chunks.set(pageNumber, structuredClone(result.chunk));
          loadingPages.delete(pageNumber);
          errors.delete(pageNumber);
          notify();
          if (result.prefetchedPageNumbers && result.prefetchedPageNumbers.length > 0) {
            prefetchNeighbors(pageNumber, defaultRadius).catch(() => undefined);
          }
          return structuredClone(result.chunk);
        }

        errors.set(pageNumber, result.message);
        loadingPages.delete(pageNumber);
        notify();
        return undefined;
      } catch (err) {
        if (!isCurrentHydration(requestSessionId, requestEpoch)) {
          return undefined;
        }
        const message = err instanceof Error ? err.message : "Failed to hydrate page";
        errors.set(pageNumber, message);
        loadingPages.delete(pageNumber);
        notify();
        return undefined;
      } finally {
        if (inFlightPages.get(pageNumber) === request) {
          inFlightPages.delete(pageNumber);
        }
      }
    })();
    inFlightPages.set(pageNumber, request);
    return request;
  }

  async function prefetchNeighbors(
    pageNumber: number,
    radius = defaultRadius
  ): Promise<void> {
    if (!projectSessionId || !api?.prefetchPages) return;
    const requestSessionId = projectSessionId;
    const requestEpoch = hydrationEpoch;

    try {
      const targets = await api.prefetchPages({
        projectSessionId: requestSessionId,
        pageNumber,
        radius
      });
      if (!isCurrentHydration(requestSessionId, requestEpoch)) return;

      for (const targetPage of targets) {
        if (!chunks.has(targetPage) && !inFlightPages.has(targetPage)) {
          requestPage(targetPage).catch(() => undefined);
        }
      }
    } catch {
      // Opportunistic prefetch
    }
  }

  function updateChunk(
    pageNumber: number,
    updater: (chunk: HydratedPageChunkDto) => void
  ): void {
    const chunk = chunks.get(pageNumber);
    if (!chunk) return;
    updater(chunk);
    notify();
  }

  function isCurrentHydration(sessionId: string | undefined, epoch: number): boolean {
    return projectSessionId === sessionId && hydrationEpoch === epoch;
  }

  function setProjectSessionId(sessionId: string | undefined): void {
    if (projectSessionId !== sessionId) {
      projectSessionId = sessionId;
      clear();
    }
  }

  function clear(): void {
    hydrationEpoch += 1;
    chunks.clear();
    loadingPages.clear();
    errors.clear();
    inFlightPages.clear();
    notify();
  }

  return {
    getChunk,
    isPageLoaded,
    isPageLoading,
    getPageError,
    getLoadedPageNumbers,
    requestPage,
    prefetchNeighbors,
    updateChunk,
    setProjectSessionId,
    clear
  };
}
