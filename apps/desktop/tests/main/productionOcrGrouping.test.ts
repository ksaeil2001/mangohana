import { describe, expect, it } from "vitest";
import { groupProductionOcrDetections } from "../../src/main/ocr/grouping/productionRegionGrouping.js";
import type { ProductionOcrDetection, ProductionOcrOrientation } from "../../src/shared/productionOcr.js";
import { MANGA_OCR_MODELS, PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";

describe("Production OCR mandatory region grouping", () => {
  it("keeps independent Manga support parallel without changing PP source geometry or scores", () => {
    const supported = {
      ...detection("line-1", 20, 10, 100, 20, "horizontal"), supportedBy: MANGA_OCR_MODELS.detector
    };
    const plain = detection("line-2", 20, 34, 100, 20, "horizontal");
    const groups = groupProductionOcrDetections([plain, supported]);
    const pp = { modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: PRODUCTION_OCR_CONTRACT.detector.revision };

    expect(groups[0]).toMatchObject({
      sourceDetectionIds: [supported.detectionId, plain.detectionId],
      memberQuadsPx: [supported.sourceQuadPx, plain.sourceQuadPx],
      memberScores: [supported.score, plain.score], memberModels: [pp, pp],
      memberSupportModels: [MANGA_OCR_MODELS.detector, null]
    });
    expect(groupProductionOcrDetections([supported, plain])).toEqual(groups);
    expect(groupProductionOcrDetections([plain])[0]!.memberSupportModels).toBeUndefined();
  });

  it("keeps model identities parallel to IDs, quads and scores when input order changes", () => {
    const pp = detection("line-1", 20, 10, 100, 20, "horizontal");
    const manga = { ...detection("line-2", 20, 34, 100, 20, "horizontal"), sourceModel: MANGA_OCR_MODELS.detector };
    const groups = groupProductionOcrDetections([manga, pp]);

    expect(groups[0]).toMatchObject({
      sourceDetectionIds: [pp.detectionId, manga.detectionId],
      memberQuadsPx: [pp.sourceQuadPx, manga.sourceQuadPx], memberScores: [pp.score, manga.score],
      memberModels: [
        { modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: PRODUCTION_OCR_CONTRACT.detector.revision },
        MANGA_OCR_MODELS.detector
      ]
    });
    expect(groupProductionOcrDetections([pp, manga])).toEqual(groups);
    expect(pp.sourceModel).toBeUndefined();
  });

  it.each([0.5, 1, 2])("keeps a nearby caption and speech region separate at scale %s", (scale) => {
    // Detector bounds from the regression page: each region has two columns,
    // but the old large gap allowance joins all four into one recognition crop.
    const inputs = [
      detection("speech-right", 1082, 412, 70, 181, "vertical"),
      detection("speech-left", 1012, 403, 83, 270, "vertical"),
      detection("caption-right", 1284, 246, 96, 468, "vertical"),
      detection("caption-left", 1198, 234, 97, 280, "vertical")
    ].map((item) => scaleDetection(item, scale));

    const groups = groupProductionOcrDetections(inputs);
    expect(groups.map((group) => group.sourceDetectionIds)).toEqual([
      ["caption-left", "caption-right"],
      ["speech-left", "speech-right"]
    ]);
    expect(groupProductionOcrDetections([...inputs].reverse())).toEqual(groups);
  });

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

  it.each(["horizontal", "vertical"] as const)("does not bridge a wider gap using the larger %s line", (orientation) => {
    const bounds = orientation === "horizontal"
      ? [[20, 10, 100, 20], [20, 36, 100, 24], [20, 76, 100, 40]]
      : [[10, 20, 20, 100], [36, 20, 24, 100], [76, 20, 40, 100]];
    const groups = groupProductionOcrDetections(bounds.map(([x, y, width, height], index) =>
      detection(`line-${index}`, x!, y!, width!, height!, orientation)
    ));
    expect(groups.map((group) => group.sourceDetectionIds).sort()).toEqual([["line-0", "line-1"], ["line-2"]]);
  });

  it.each([
    ["horizontal", 9.9, 1], ["horizontal", 10, 1], ["horizontal", 10.1, 2],
    ["vertical", 9.9, 1], ["vertical", 10, 1], ["vertical", 10.1, 2]
  ] as const)("groups %s lines across a gap of %s only within half the line thickness", (orientation, gap, expected) => {
    const second = orientation === "horizontal"
      ? detection("second", 10, 30 + gap, 100, 20, orientation)
      : detection("second", 30 + gap, 10, 20, 100, orientation);
    const first = orientation === "horizontal"
      ? detection("first", 10, 10, 100, 20, orientation)
      : detection("first", 10, 10, 20, 100, orientation);
    expect(groupProductionOcrDetections([first, second])).toHaveLength(expected);
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

  it("does not infer the orientation of a short isolated region from a distant line", () => {
    const groups = groupProductionOcrDetections([
      detection("short", 20, 20, 10, 10, "unknown"),
      detection("distant", 20, 40, 100, 10, "horizontal")
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.sourceDetectionIds.includes("short"))?.orientation).toBe("unknown");
  });
});

function scaleDetection(item: ProductionOcrDetection, scale: number): ProductionOcrDetection {
  const imageWidth = 2598 * scale;
  const imageHeight = 3626 * scale;
  const scaled = detection(
    item.detectionId,
    item.sourceBboxPx.x * scale,
    item.sourceBboxPx.y * scale,
    item.sourceBboxPx.width * scale,
    item.sourceBboxPx.height * scale,
    item.orientation
  );
  return {
    ...scaled,
    imageWidth,
    imageHeight,
    bbox: {
      x: scaled.sourceBboxPx.x / imageWidth,
      y: scaled.sourceBboxPx.y / imageHeight,
      width: scaled.sourceBboxPx.width / imageWidth,
      height: scaled.sourceBboxPx.height / imageHeight
    },
    polygon: scaled.sourceQuadPx.map((point) => ({ x: point.x / imageWidth, y: point.y / imageHeight })) as unknown as ProductionOcrDetection["polygon"]
  };
}

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
