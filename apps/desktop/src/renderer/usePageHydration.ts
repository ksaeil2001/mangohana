import { useCallback, useEffect, useReducer, useRef } from "react";
import type { HydratedPageChunkDto } from "../shared/projectChunkTypes.js";
import {
  createPageHydrationCoordinator,
  type PageHydrationCoordinator
} from "./pageHydrationState.js";
import type { ElectronProjectApi } from "./electronApi.js";

export type UsePageHydrationOptions = {
  projectSessionId?: string;
  currentPageNumber: number;
  prefetchRadius?: number;
  initialChunks?: HydratedPageChunkDto[];
  api?: ElectronProjectApi;
};

export type UsePageHydrationResult = {
  chunk: HydratedPageChunkDto | undefined;
  isLoading: boolean;
  error: string | undefined;
  isLoaded: (pageNumber: number) => boolean;
  prefetch: (pageNumber: number, radius?: number) => Promise<void>;
  updateChunk: (
    pageNumber: number,
    updater: (chunk: HydratedPageChunkDto) => void
  ) => void;
  getChunk: (pageNumber: number) => HydratedPageChunkDto | undefined;
  loadedPageNumbers: number[];
  coordinator: PageHydrationCoordinator;
};

export function usePageHydration(
  options: UsePageHydrationOptions
): UsePageHydrationResult {
  const [, forceUpdate] = useReducer((x) => x + 1, 0);

  const coordinatorRef = useRef<PageHydrationCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createPageHydrationCoordinator({
      projectSessionId: options.projectSessionId,
      prefetchRadius: options.prefetchRadius,
      initialChunks: options.initialChunks,
      api: options.api,
      onStateChange: () => forceUpdate()
    });
  }

  const coordinator = coordinatorRef.current;

  useEffect(() => {
    coordinator.setProjectSessionId(options.projectSessionId);
  }, [options.projectSessionId, coordinator]);

  useEffect(() => {
    if (options.currentPageNumber > 0 && options.projectSessionId) {
      coordinator.requestPage(options.currentPageNumber).catch(() => undefined);
    }
  }, [options.currentPageNumber, options.projectSessionId, coordinator]);

  const chunk = coordinator.getChunk(options.currentPageNumber);
  const isLoading = coordinator.isPageLoading(options.currentPageNumber);
  const error = coordinator.getPageError(options.currentPageNumber);
  const loadedPageNumbers = coordinator.getLoadedPageNumbers();

  const isLoaded = useCallback(
    (pageNumber: number) => coordinator.isPageLoaded(pageNumber),
    [coordinator]
  );

  const prefetch = useCallback(
    (pageNumber: number, radius?: number) =>
      coordinator.prefetchNeighbors(pageNumber, radius),
    [coordinator]
  );

  const updateChunk = useCallback(
    (pageNumber: number, updater: (chunk: HydratedPageChunkDto) => void) =>
      coordinator.updateChunk(pageNumber, updater),
    [coordinator]
  );

  const getChunk = useCallback(
    (pageNumber: number) => coordinator.getChunk(pageNumber),
    [coordinator]
  );

  return {
    chunk,
    isLoading,
    error,
    isLoaded,
    prefetch,
    updateChunk,
    getChunk,
    loadedPageNumbers,
    coordinator
  };
}
