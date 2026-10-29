import { describe, expect, it } from "vitest";
import {
  getAvailableSpanAtY,
  inferBubbleShape,
  type BubbleShape
} from "../../src/shared/typesettingShape";

describe("typesettingShape", () => {
  it("computes maximum span at center and narrow span at edges for ellipse", () => {
    const centerSpan = getAvailableSpanAtY("ellipse", 0.5);
    const topSpan = getAvailableSpanAtY("ellipse", 0.15);
    const bottomSpan = getAvailableSpanAtY("ellipse", 0.85);

    expect(centerSpan.width).toBeGreaterThan(topSpan.width);
    expect(centerSpan.width).toBeGreaterThan(bottomSpan.width);
    expect(topSpan.width).toBeCloseTo(bottomSpan.width, 2);
  });

  it("returns zero span outside vertical padding", () => {
    const outsideTop = getAvailableSpanAtY("ellipse", 0.02);
    const outsideBottom = getAvailableSpanAtY("ellipse", 0.98);

    expect(outsideTop.width).toBe(0);
    expect(outsideBottom.width).toBe(0);
  });

  it("computes constant span across straight section of rounded rectangle", () => {
    const y30 = getAvailableSpanAtY("rounded_rectangle", 0.4);
    const y60 = getAvailableSpanAtY("rounded_rectangle", 0.6);

    expect(y30.width).toBe(y60.width);
  });

  it("infers shape from hints and aspect ratio", () => {
    expect(inferBubbleShape({ x: 0, y: 0, width: 0.2, height: 0.3 }, "thought_bubble")).toBe("cloud");
    expect(inferBubbleShape({ x: 0, y: 0, width: 0.2, height: 0.3 }, "filtered_speech")).toBe("spiky");
    expect(inferBubbleShape({ x: 0, y: 0, width: 0.2, height: 0.3 }, "narration_box")).toBe("rectangle");
    expect(inferBubbleShape({ x: 0, y: 0, width: 0.2, height: 0.25 })).toBe("ellipse");
  });
});
