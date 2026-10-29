import { describe, expect, it } from "vitest";
import { parseProductionOcrDetections } from "../../src/main/ocr/detection/productionDetectorParser.js";

describe("Production OCR detector parser", () => {
  it("preserves a detector quad, derives both bboxes, and keeps its score", () => {
    const [detection] = parseProductionOcrDetections({
      detections: [
        {
          detectionId: "det-7",
          quad: [[20, 10], [120, 10], [120, 30], [20, 30]],
          score: 0.87
        }
      ]
    }, 200, 100);

    expect(detection).toEqual({
      detectionId: "det-7",
      sourceQuadPx: [
        { x: 20, y: 10 },
        { x: 120, y: 10 },
        { x: 120, y: 30 },
        { x: 20, y: 30 }
      ],
      sourceBboxPx: { x: 20, y: 10, width: 100, height: 20 },
      bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
      polygon: [
        { x: 0.1, y: 0.1 },
        { x: 0.6, y: 0.1 },
        { x: 0.6, y: 0.3 },
        { x: 0.1, y: 0.3 }
      ],
      score: 0.87,
      orientation: "horizontal",
      imageWidth: 200,
      imageHeight: 100
    });
  });

  it("classifies a tall detector quad as vertical", () => {
    const [detection] = parseProductionOcrDetections({
      detections: [{ detectionId: "det-v", quad: [[10, 5], [30, 5], [30, 105], [10, 105]], score: 0.9 }]
    }, 200, 200);

    expect(detection?.orientation).toBe("vertical");
  });

  it("keeps a near-square character box ambiguous for orientation-aware grouping", () => {
    const [detection] = parseProductionOcrDetections({
      detections: [{ detectionId: "det-square", quad: [[10, 10], [30, 10], [30, 30], [10, 30]], score: 0.9 }]
    }, 100, 100);

    expect(detection?.orientation).toBe("unknown");
  });

  it.each([
    { detections: [{ detectionId: "bad-score", quad: [[0, 0], [10, 0], [10, 10], [0, 10]], score: 1.1 }] },
    { detections: [{ detectionId: "nan", quad: [[0, 0], [10, 0], [Number.NaN, 10], [0, 10]], score: 0.5 }] },
    { detections: [{ detectionId: "outside", quad: [[-1, 0], [10, 0], [10, 10], [0, 10]], score: 0.5 }] },
    { detections: [{ detectionId: "triangle", quad: [[0, 0], [10, 0], [0, 10]], score: 0.5 }] }
  ])("rejects malformed detector output instead of correcting it", (payload) => {
    expect(() => parseProductionOcrDetections(payload, 100, 100)).toThrow("Invalid Production OCR detector output");
  });
});
