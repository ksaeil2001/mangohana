import { describe, expect, it } from "vitest";
import {
  assignBubblesToPanels,
  calculateBboxOverlapArea,
  calculateTypesettingSafeArea,
  isPointInsideBbox,
  sortMangaReadingOrder,
  sortPanels,
  type LayoutBubble,
  type PanelRegion
} from "../../src/shared/geometry/panelAndBubbleLayout.js";

describe("panelAndBubbleLayout (bubble-detector geometric principles)", () => {
  it("determines if a point is inside a normalized bbox correctly", () => {
    const bbox = { x: 0.1, y: 0.2, width: 0.4, height: 0.3 };

    expect(isPointInsideBbox({ x: 0.2, y: 0.3 }, bbox)).toBe(true);
    expect(isPointInsideBbox({ x: 0.05, y: 0.3 }, bbox)).toBe(false);
    expect(isPointInsideBbox({ x: 0.2, y: 0.55 }, bbox)).toBe(false);
  });

  it("calculates overlap area between two bounding boxes", () => {
    const boxA = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
    const boxB = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
    const boxC = { x: 0.6, y: 0.6, width: 0.2, height: 0.2 };

    const overlapAB = calculateBboxOverlapArea(boxA, boxB);
    expect(overlapAB).toBeCloseTo(0.2 * 0.2, 5);

    const overlapAC = calculateBboxOverlapArea(boxA, boxC);
    expect(overlapAC).toBe(0);
  });

  it("assigns speech bubbles to the containing panel", () => {
    const panels: PanelRegion[] = [
      { id: "p1", panelIndex: 1, bbox: { x: 0.5, y: 0.0, width: 0.5, height: 0.5 } }, // Top right
      { id: "p2", panelIndex: 2, bbox: { x: 0.0, y: 0.0, width: 0.5, height: 0.5 } }, // Top left
      { id: "p3", panelIndex: 3, bbox: { x: 0.0, y: 0.5, width: 1.0, height: 0.5 } }  // Bottom full
    ];

    const bubbles: LayoutBubble[] = [
      { id: "b1", bbox: { x: 0.6, y: 0.1, width: 0.2, height: 0.2 } }, // Inside p1
      { id: "b2", bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }, // Inside p2
      { id: "b3", bbox: { x: 0.4, y: 0.6, width: 0.3, height: 0.2 } }  // Inside p3
    ];

    const assigned = assignBubblesToPanels(panels, bubbles);

    expect(assigned[0]?.panelIndex).toBe(1);
    expect(assigned[1]?.panelIndex).toBe(2);
    expect(assigned[2]?.panelIndex).toBe(3);
  });

  it("sorts panels in Japanese manga (RTL) reading order: top-to-bottom, right-to-left", () => {
    const panels: PanelRegion[] = [
      { id: "p-top-left", panelIndex: 2, bbox: { x: 0.0, y: 0.0, width: 0.5, height: 0.5 } },
      { id: "p-top-right", panelIndex: 1, bbox: { x: 0.5, y: 0.0, width: 0.5, height: 0.5 } },
      { id: "p-bottom", panelIndex: 3, bbox: { x: 0.0, y: 0.55, width: 1.0, height: 0.45 } }
    ];

    const sorted = sortPanels(panels, "rtl");

    expect(sorted.map((p) => p.id)).toEqual(["p-top-right", "p-top-left", "p-bottom"]);
  });

  it("sorts manga reading order using 2-step panel-first hierarchy", () => {
    const panels: PanelRegion[] = [
      { id: "p1", panelIndex: 1, bbox: { x: 0.5, y: 0.0, width: 0.5, height: 0.5 } }, // Top-Right panel
      { id: "p2", panelIndex: 2, bbox: { x: 0.0, y: 0.0, width: 0.5, height: 0.5 } }  // Top-Left panel
    ];

    // Bubbles inside p1: b1-upper, b1-lower
    // Bubbles inside p2: b2-upper, b2-lower
    const bubbles: LayoutBubble[] = [
      { id: "b2-upper", bbox: { x: 0.25, y: 0.05, width: 0.15, height: 0.1 } },
      { id: "b1-upper", bbox: { x: 0.75, y: 0.05, width: 0.15, height: 0.1 } },
      { id: "b2-lower", bbox: { x: 0.1, y: 0.3, width: 0.15, height: 0.1 } },
      { id: "b1-lower", bbox: { x: 0.6, y: 0.3, width: 0.15, height: 0.1 } }
    ];

    const sorted = sortMangaReadingOrder(panels, bubbles, "rtl");

    // Expected order: Panel 1 bubbles first (b1-upper -> b1-lower), then Panel 2 bubbles (b2-upper -> b2-lower)
    expect(sorted.map((b) => b.id)).toEqual(["b1-upper", "b1-lower", "b2-upper", "b2-lower"]);
    expect(sorted.map((b) => b.readingOrder)).toEqual([1, 2, 3, 4]);
  });

  it("calculates inner typesetting safe-area with padding based on bubble shape", () => {
    const bubble = { x: 0.2, y: 0.2, width: 0.4, height: 0.3 };
    const safeAreaEllipse = calculateTypesettingSafeArea(bubble, { shape: "ellipse", paddingRatio: 0.1 });

    expect(safeAreaEllipse.x).toBeGreaterThan(bubble.x);
    expect(safeAreaEllipse.y).toBeGreaterThan(bubble.y);
    expect(safeAreaEllipse.width).toBeLessThan(bubble.width);
    expect(safeAreaEllipse.height).toBeLessThan(bubble.height);

    // Center of safe-area should match bubble center
    expect(safeAreaEllipse.x + safeAreaEllipse.width / 2).toBeCloseTo(bubble.x + bubble.width / 2, 4);
    expect(safeAreaEllipse.y + safeAreaEllipse.height / 2).toBeCloseTo(bubble.y + bubble.height / 2, 4);
  });
});
