import { describe, expect, it } from "vitest";
import { computeViewportHydrationPlan } from "../../src/shared/viewportCache.js";

describe("viewportCache - computeViewportHydrationPlan", () => {
  const allPageNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("plans hydration for active page and immediate neighbors", () => {
    const plan = computeViewportHydrationPlan({
      currentPageNumber: 5,
      allPageNumbers,
      currentlyHydratedPages: [],
      maxCapacity: 5,
      prefetchRadius: 1
    });

    expect(plan.toHydrate).toEqual([5, 6, 4]);
    expect(plan.toEvict).toHaveLength(0);
    expect(plan.retained).toEqual([4, 5, 6]);
  });

  it("handles boundary pages correctly at the start of a document", () => {
    const plan = computeViewportHydrationPlan({
      currentPageNumber: 1,
      allPageNumbers,
      currentlyHydratedPages: [1],
      maxCapacity: 5,
      prefetchRadius: 2
    });

    expect(plan.toHydrate).toEqual([2, 3]);
    expect(plan.toEvict).toHaveLength(0);
    expect(plan.retained).toEqual([1, 2, 3]);
  });

  it("evicts oldest clean pages when memory capacity is exceeded", () => {
    const plan = computeViewportHydrationPlan({
      currentPageNumber: 8,
      allPageNumbers,
      currentlyHydratedPages: [1, 2, 3, 4],
      maxCapacity: 4,
      prefetchRadius: 1,
      accessHistory: [1, 2, 3, 4]
    });

    expect(plan.toHydrate).toEqual([8, 9, 7]);
    // Excess = (4 currently hydrated + 3 to hydrate) - 4 max = 3 to evict
    // Access history: 1 (oldest), 2, 3 -> should evict [1, 2, 3]
    expect(plan.toEvict).toEqual([1, 2, 3]);
    expect(plan.retained).toEqual([4, 7, 8, 9]);
  });

  it("never evicts dirty pages even when cache capacity is exceeded", () => {
    const plan = computeViewportHydrationPlan({
      currentPageNumber: 10,
      allPageNumbers,
      currentlyHydratedPages: [1, 2, 3],
      dirtyPages: [1], // Page 1 has unsaved user edits!
      maxCapacity: 3,
      prefetchRadius: 1,
      accessHistory: [1, 2, 3]
    });

    expect(plan.toHydrate).toEqual([10, 9]);
    // Page 1 is dirty so it's protected. Page 2 and 3 can be evicted.
    expect(plan.toEvict).toEqual([2, 3]);
    expect(plan.retained).toContain(1);
    expect(plan.retained).toContain(10);
    expect(plan.retained).toContain(9);
  });
});
