import { describe, expect, it } from "vitest";
import { placeTypesettingToolbar, type ToolbarRect } from "../../src/renderer/typesettingToolbarPlacement";

describe("typesetting toolbar placement", () => {
  const bounds = { left: 0, top: 0, right: 600, bottom: 400 };
  const fixed = { left: 12, top: 10, right: 588, bottom: 72 };
  const size = { width: 180, height: 40 };
  const intersects = (a: ToolbarRect, b: ToolbarRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  it.each([
    { left: 348, top: 32, right: 468, bottom: 128 },
    { left: 220, top: 330, right: 340, bottom: 398 },
    { left: 0, top: 180, right: 60, bottom: 260 },
    { left: 560, top: 180, right: 600, bottom: 260 },
    { left: -220, top: -180, right: -20, bottom: -80 },
    { left: 650, top: 500, right: 850, bottom: 700 }
  ])("keeps tools in view and clear of fixed controls for %o", (anchor) => {
    const placed = placeTypesettingToolbar(anchor, size, bounds, [fixed])!;
    expect(placed).not.toBeNull();
    expect(placed.left).toBeGreaterThanOrEqual(bounds.left);
    expect(placed.top).toBeGreaterThanOrEqual(bounds.top);
    expect(placed.right).toBeLessThanOrEqual(bounds.right);
    expect(placed.bottom).toBeLessThanOrEqual(bounds.bottom);
    expect(intersects(placed, fixed)).toBe(false);
  });
  it("uses above when free, flips below when blocked, and reports insufficient space", () => {
    const anchor = { left: 200, top: 180, right: 300, bottom: 240 };
    expect(placeTypesettingToolbar(anchor, size, bounds, [])!.bottom).toBeLessThan(anchor.top);
    const topAnchor = { ...anchor, top: 60, bottom: 120 };
    expect(placeTypesettingToolbar(topAnchor, size, bounds, [fixed])!.top).toBeGreaterThan(topAnchor.bottom);
    expect(placeTypesettingToolbar(anchor, size, { ...bounds, bottom: 30 }, [])).toBeNull();
    expect(placeTypesettingToolbar(anchor, size, bounds, [bounds])).toBeNull();
  });
});
