import { describe, expect, it } from "vitest";
import { groupProductionOcrDetections } from "../../src/main/ocr/grouping/productionRegionGrouping.js";
import type { ProductionOcrDetection, ProductionOcrOrientation } from "../../src/shared/productionOcr.js";

describe("Production OCR mandatory region grouping", () => {
  it.each([0.5, 1, 2])("keeps detected annotation text separate from larger horizontal text at scale %s", (scale) => {
    // Real detector geometry from japanese-furigana: the combined crop loses
    // the small line in Baberu, while each individual crop is readable.
    const inputs = [
      detection("body", 475 * scale, 212 * scale, 500 * scale, 190 * scale, "horizontal"),
      detection("annotation", 597 * scale, 128 * scale, 235 * scale, 70 * scale, "horizontal")
    ].map((item) => ({ ...item, imageWidth: 1429 * scale, imageHeight: 572 * scale }));
    const groups = groupProductionOcrDetections(inputs);
    expect(groups.map((group) => group.sourceDetectionIds)).toEqual([["annotation"], ["body"]]);
    expect(groups.map((group) => group.readingOrder)).toEqual([1, 2]);
    expect(groupProductionOcrDetections([...inputs].reverse())).toEqual(groups);
  });

  it("keeps narrow vertical annotations separate without using text or language routing", () => {
    const groups = groupProductionOcrDetections([
      detection("body", 80, 20, 40, 150, "vertical"),
      detection("annotation", 123, 35, 12, 110, "vertical")
    ]);
    expect(groups.map((group) => group.sourceDetectionIds)).toEqual([["annotation"], ["body"]]);
  });

  it("still groups comparable line thickness even when the line lengths differ", () => {
    const groups = groupProductionOcrDetections([
      detection("line-1", 20, 10, 150, 20, "horizontal"),
      detection("line-2", 20, 34, 35, 16, "horizontal")
    ]);
    expect(groups).toHaveLength(1);
  });

  it("merges aligned horizontal lines from one text region", () => {
    const groups = groupProductionOcrDetections([
      detection("line-2", 20, 34, 100, 20, "horizontal"),
      detection("line-1", 20, 10, 100, 20, "horizontal")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      sourceDetectionIds: ["line-1", "line-2"],
      memberScores: [0.8, 0.9],
      groupBboxPx: { x: 20, y: 10, width: 100, height: 44 },
      orientation: "horizontal",
      readingOrder: 1,
      confidence: 0.8
    });
  });

  it("does not merge nearby boxes without enough cross-axis overlap", () => {
    const groups = groupProductionOcrDetections([
      detection("left", 10, 10, 60, 20, "horizontal"),
      detection("right", 72, 34, 60, 20, "horizontal")
    ]);

    expect(groups.map((group) => group.sourceDetectionIds)).toEqual([["left"], ["right"]]);
  });

  it("merges vertical columns only with vertical neighbors", () => {
    const groups = groupProductionOcrDetections([
      detection("v-right", 80, 10, 20, 100, "vertical"),
      detection("v-left", 56, 10, 20, 100, "vertical"),
      detection("h", 55, 115, 50, 14, "horizontal")
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.sourceDetectionIds).toEqual(["v-left", "v-right"]);
    expect(groups[0]?.orientation).toBe("vertical");
    expect(groups[1]?.sourceDetectionIds).toEqual(["h"]);
  });

  it("assigns deterministic mixed reading order independent of detector output order", () => {
    const inputs = [
      detection("h-bottom", 10, 140, 100, 20, "horizontal"),
      detection("v-left", 80, 10, 20, 100, "vertical"),
      detection("v-right", 130, 10, 20, 100, "vertical")
    ];

    const forward = groupProductionOcrDetections(inputs);
    const reversed = groupProductionOcrDetections([...inputs].reverse());

    expect(forward.map((group) => group.sourceDetectionIds)).toEqual([
      ["v-right"],
      ["v-left"],
      ["h-bottom"]
    ]);
    expect(reversed.map((group) => group.sourceDetectionIds)).toEqual(
      forward.map((group) => group.sourceDetectionIds)
    );
    expect(forward.map((group) => group.readingOrder)).toEqual([1, 2, 3]);
    expect(reversed.map((group) => group.groupId)).toEqual(forward.map((group) => group.groupId));
  });

  it("resolves unknown orientation only when one grouping direction is uniquely supported", () => {
    const groups = groupProductionOcrDetections([
      detection("unknown-line-2", 20, 34, 100, 20, "unknown"),
      detection("unknown-line-1", 20, 10, 100, 20, "unknown")
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      sourceDetectionIds: ["unknown-line-1", "unknown-line-2"],
      orientation: "horizontal"
    });
  });

  it("keeps unknown orientation as a singleton when horizontal and vertical evidence conflict", () => {
    const groups = groupProductionOcrDetections([
      detection("ambiguous", 50, 50, 20, 20, "unknown"),
      detection("horizontal-neighbor", 50, 74, 20, 20, "horizontal"),
      detection("vertical-neighbor", 26, 50, 20, 20, "vertical")
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.find((group) => group.sourceDetectionIds.includes("ambiguous"))).toMatchObject({
      sourceDetectionIds: ["ambiguous"],
      orientation: "unknown"
    });
  });
});

function detection(
  detectionId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  orientation: ProductionOcrOrientation
): ProductionOcrDetection {
  const imageWidth = 200;
  const imageHeight = 200;
  return {
    detectionId,
    sourceQuadPx: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ],
    sourceBboxPx: { x, y, width, height },
    bbox: { x: x / imageWidth, y: y / imageHeight, width: width / imageWidth, height: height / imageHeight },
    polygon: [
      { x: x / imageWidth, y: y / imageHeight },
      { x: (x + width) / imageWidth, y: y / imageHeight },
      { x: (x + width) / imageWidth, y: (y + height) / imageHeight },
      { x: x / imageWidth, y: (y + height) / imageHeight }
    ],
    score: detectionId === "line-1" ? 0.8 : 0.9,
    orientation,
    imageWidth,
    imageHeight
  };
}
