import type { ViewportHydrationPlan } from "./projectChunkTypes.js";

export type ViewportHydrationPlanArgs = {
  currentPageNumber: number;
  allPageNumbers: readonly number[];
  currentlyHydratedPages: readonly number[];
  dirtyPages?: readonly number[];
  maxCapacity?: number;
  prefetchRadius?: number;
  accessHistory?: readonly number[];
};

export const DEFAULT_VIEWPORT_CAPACITY = 6;
export const DEFAULT_PREFETCH_RADIUS = 1;

/**
 * Computes which pages need to be loaded (toHydrate), evicted (toEvict),
 * and retained in memory based on the current active viewport and LRU constraints.
 *
 * Guaranteed invariants:
 * 1. The current active page is ALWAYS in the retained/hydrated set.
 * 2. Unsaved dirty pages are NEVER evicted from memory.
 * 3. Pre-fetch pages closest to the active page receive highest priority.
 */
export function computeViewportHydrationPlan(
  args: ViewportHydrationPlanArgs
): ViewportHydrationPlan {
  const maxCapacity = Math.max(1, args.maxCapacity ?? DEFAULT_VIEWPORT_CAPACITY);
  const radius = Math.max(0, args.prefetchRadius ?? DEFAULT_PREFETCH_RADIUS);
  const allPagesSet = new Set(args.allPageNumbers);
  const currentlyHydratedSet = new Set(args.currentlyHydratedPages);
  const dirtySet = new Set(args.dirtyPages ?? []);

  // 1. Determine active target window (active page + radius neighbors)
  const priorityTargetList: number[] = [];
  if (allPagesSet.has(args.currentPageNumber)) {
    priorityTargetList.push(args.currentPageNumber);
  }

  for (let r = 1; r <= radius; r += 1) {
    const next = args.currentPageNumber + r;
    if (allPagesSet.has(next) && !priorityTargetList.includes(next)) {
      priorityTargetList.push(next);
    }
    const prev = args.currentPageNumber - r;
    if (allPagesSet.has(prev) && !priorityTargetList.includes(prev)) {
      priorityTargetList.push(prev);
    }
  }

  // 2. Identify pages that must be hydrated (target window pages not currently in memory)
  const toHydrate = priorityTargetList.filter((p) => !currentlyHydratedSet.has(p));

  // 3. Pool of all pages that will be in memory before eviction
  const workingSet = new Set<number>([
    ...currentlyHydratedSet,
    ...priorityTargetList,
    ...dirtySet
  ]);

  // 4. If workingSet <= maxCapacity, nothing needs to be evicted
  if (workingSet.size <= maxCapacity) {
    return {
      toHydrate,
      toEvict: [],
      retained: [...workingSet].sort((a, b) => a - b)
    };
  }

  // 5. We need to evict some clean pages.
  // Never evict: dirty pages or pages in priorityTargetList.
  const protectedSet = new Set<number>([...priorityTargetList, ...dirtySet]);
  const evictionCandidates = [...currentlyHydratedSet].filter(
    (p) => !protectedSet.has(p)
  );

  // Sort eviction candidates: least recently used / farthest from current page first
  const historyMap = new Map<number, number>();
  if (args.accessHistory) {
    args.accessHistory.forEach((p, idx) => historyMap.set(p, idx));
  }

  evictionCandidates.sort((a, b) => {
    // If access history is provided, lowest index (oldest access) comes first
    const aHist = historyMap.get(a) ?? -1;
    const bHist = historyMap.get(b) ?? -1;
    if (aHist !== bHist) return aHist - bHist;

    // Otherwise, farthest distance from current page is evicted first
    const distA = Math.abs(a - args.currentPageNumber);
    const distB = Math.abs(b - args.currentPageNumber);
    return distB - distA;
  });

  const excessCount = workingSet.size - maxCapacity;
  const toEvict = evictionCandidates.slice(0, excessCount);
  const evictSet = new Set(toEvict);

  const retained = [...workingSet]
    .filter((p) => !evictSet.has(p))
    .sort((a, b) => a - b);

  return {
    toHydrate,
    toEvict,
    retained
  };
}
