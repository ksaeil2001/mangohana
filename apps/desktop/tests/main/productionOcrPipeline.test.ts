import { describe, expect, it } from "vitest";
import { parseProductionOcrDetections } from "../../src/main/ocr/detection/productionDetectorParser.js";
import { ProductionOcrPipeline } from "../../src/main/ocr/pipeline/productionOcrPipeline.js";
import { ProductionOcrSidecarClient } from "../../src/main/ocr/runtime/productionOcrSidecarClient.js";

describe("Production OCR pipeline", () => {
  it("runs detection, mandatory grouping, one group crop, and Baberu recognition in order", async () => {
    const events: string[] = [];
    const pipeline = new ProductionOcrPipeline({
      detector: {
        detect: async () => {
          events.push("detect");
          return parseProductionOcrDetections({
            detections: [
              { detectionId: "line-1", quad: [[20, 10], [120, 10], [120, 30], [20, 30]], score: 0.9 },
              { detectionId: "line-2", quad: [[20, 34], [120, 34], [120, 54], [20, 54]], score: 0.8 }
            ]
          }, 200, 100);
        }
      },
      cropGroup: ({ group }) => {
        events.push(`crop:${group.sourceDetectionIds.join("+")}`);
        return {
          cropBytes: Buffer.from("group-crop"),
          transform: {
            sourceBboxPx: { x: 20, y: 10, width: 100, height: 44 },
            cropBboxPx: { x: 12, y: 6, width: 116, height: 52 },
            paddingRatio: 0.08,
            rotationDegrees: 0,
            imageWidth: 200,
            imageHeight: 100
          }
        };
      },
      recognizer: {
        recognizeGroup: async ({ group, cropBytes }) => {
          events.push(`recognize:${group.sourceDetectionIds.join("+")}`);
          expect(cropBytes.toString()).toBe("group-crop");
          return { text: "ＡＢＣ﹁猫﹂" };
        }
      }
    });

    const result = await pipeline.execute({
      imageBytes: Buffer.from("immutable-source"),
      pageNumber: 3
    });

    expect(events).toEqual([
      "detect",
      "crop:line-1+line-2",
      "recognize:line-1+line-2"
    ]);
    expect(result.speechBubbles).toHaveLength(1);
    expect(result.speechBubbles[0]).toMatchObject({
      text: "ABC「猫」",
      language: "ja",
      readingOrder: 1,
      confidence: 0.8,
      orientation: "horizontal",
      productionOcrProvenance: {
        contractVersion: 1,
        detectorModelId: "PaddlePaddle/PP-OCRv6_medium_det",
        recognizerModelId: "genshiai-daichi/baberu-ocr",
        sourceDetectionIds: ["line-1", "line-2"],
        sourceDetectionScores: [0.9, 0.8],
        cropTransform: { rotationDegrees: 0 },
        confidenceSource: "detector_min",
        recognition: {
          rawOcrText: "ＡＢＣ﹁猫﹂",
          normalizedOcrText: "ABC「猫」",
          normalization: "NFKC_JAPANESE_QUOTES"
        }
      }
    });
  });

  it("uses the same recognizer interface for English and vertical Japanese groups", async () => {
    const seenOrientations: string[] = [];
    const pipeline = new ProductionOcrPipeline({
      detector: {
        detect: async () => parseProductionOcrDetections({
          detections: [
            { detectionId: "ja", quad: [[150, 10], [170, 10], [170, 110], [150, 110]], score: 0.9 },
            { detectionId: "en", quad: [[10, 150], [110, 150], [110, 170], [10, 170]], score: 0.95 }
          ]
        }, 200, 200)
      },
      cropGroup: ({ group }) => ({
        cropBytes: Buffer.from(group.orientation),
        transform: {
          sourceBboxPx: group.groupBboxPx,
          cropBboxPx: group.groupBboxPx,
          paddingRatio: 0.08,
          rotationDegrees: 0,
          imageWidth: 200,
          imageHeight: 200
        }
      }),
      recognizer: {
        recognizeGroup: async ({ group }) => {
          seenOrientations.push(group.orientation);
          return { text: group.orientation === "vertical" ? "猫です" : "HELLO" };
        }
      }
    });

    const result = await pipeline.execute({ imageBytes: Buffer.from("source"), pageNumber: 1 });

    expect(seenOrientations).toEqual(["vertical", "horizontal"]);
    expect(result.speechBubbles.map((candidate) => [candidate.text, candidate.language])).toEqual([
      ["猫です", "ja"],
      ["HELLO", "en"]
    ]);
  });

  it.each([
    ["invalid crop", "OCR_REGION_CROP_FAILED"],
    ["empty crop", "OCR_REGION_CROP_EMPTY"],
    ["recognizer exception", "OCR_REGION_RECOGNITION_FAILED"],
    ["empty recognition", "OCR_REGION_RECOGNITION_EMPTY"]
  ])("preserves regions A/C and reports region B for %s", async (failure, code) => {
    const pipeline = regionPipeline(failure);
    const result = await pipeline.execute({ imageBytes: Buffer.from("source"), pageNumber: 1 });
    expect(result.speechBubbles.map((bubble) => bubble.text)).toEqual(["A", "C"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(code);
    expect(result.warnings[0]).toContain("영역 2");
    expect(result.warnings[0]).not.toContain("private-runtime-path");
  });

  it("does not turn cancellation into a partial-success warning and permits a new run", async () => {
    const controller = new AbortController();
    const pipeline = regionPipeline("cancel", controller);
    await expect(pipeline.execute({ imageBytes: Buffer.from("source"), pageNumber: 1, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    const retry = await regionPipeline().execute({ imageBytes: Buffer.from("source"), pageNumber: 1 });
    expect(retry.speechBubbles.map((bubble) => bubble.text)).toEqual(["A", "B", "C"]);
    expect(retry.warnings).toEqual([]);
  });

  it("isolates an invalid detector region while keeping validated regions", async () => {
    const client = new ProductionOcrSidecarClient(async (request) => {
      if ((request as { operation: string }).operation === "detect") {
        const detections = detectorRegions();
        detections[1]!.score = Number.NaN;
        return { operation: "detect", imageWidth: 800, imageHeight: 800, detections };
      }
      return { operation: "recognize", text: "accepted" };
    });
    const pipeline = new ProductionOcrPipeline({ detector: client, recognizer: client, cropGroup });
    const result = await pipeline.execute({ imageBytes: Buffer.from("source"), pageNumber: 1 });
    expect(result.speechBubbles.map((bubble) => bubble.productionOcrProvenance?.sourceDetectionIds)).toEqual([["A"], ["C"]]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("OCR_DETECTION_INVALID");
  });

  it("rejects an invalid detector envelope instead of reporting an empty successful page", async () => {
    const client = new ProductionOcrSidecarClient(async () => ({ operation: "detect", imageWidth: 0, imageHeight: 800, detections: [] }));
    const pipeline = new ProductionOcrPipeline({ detector: client, recognizer: client, cropGroup });
    await expect(pipeline.execute({ imageBytes: Buffer.from("source"), pageNumber: 1 })).rejects.toThrow("Invalid Production OCR detector output");
  });

  it("retains small kana and furigana in the recognition evidence", async () => {
    const pipeline = new ProductionOcrPipeline({
      detector: { detect: async () => parseProductionOcrDetections({ detections: detectorRegions().slice(0, 1) }, 800, 800) },
      cropGroup,
      recognizer: { recognizeGroup: async () => ({ text: "日本語\nにほんご\nぁぃぅ Ａ" }) }
    });
    const result = await pipeline.execute({ imageBytes: Buffer.from("source"), pageNumber: 1 });
    expect(result.speechBubbles[0]).toMatchObject({
      text: "日本語\nにほんご\nぁぃぅ A",
      productionOcrProvenance: { recognition: {
        rawOcrText: "日本語\nにほんご\nぁぃぅ Ａ", normalizedOcrText: "日本語\nにほんご\nぁぃぅ A"
      } }
    });
  });
});

function detectorRegions() {
  return [
    { detectionId: "A", quad: [[10, 10], [110, 10], [110, 30], [10, 30]], score: 0.9 },
    { detectionId: "B", quad: [[400, 350], [500, 350], [500, 370], [400, 370]], score: 0.9 },
    { detectionId: "C", quad: [[10, 710], [110, 710], [110, 730], [10, 730]], score: 0.9 }
  ];
}

const cropGroup: ConstructorParameters<typeof ProductionOcrPipeline>[0]["cropGroup"] = ({ group }) => ({
  cropBytes: Buffer.from(group.sourceDetectionIds[0]!),
  transform: {
    sourceBboxPx: group.groupBboxPx, cropBboxPx: group.groupBboxPx,
    paddingRatio: 0.08, rotationDegrees: 0, imageWidth: 800, imageHeight: 800
  }
});

function regionPipeline(failure?: string, controller?: AbortController): ProductionOcrPipeline {
  return new ProductionOcrPipeline({
    detector: { detect: async () => parseProductionOcrDetections({ detections: detectorRegions() }, 800, 800) },
    cropGroup: (input) => {
      const crop = cropGroup(input);
      if (input.group.sourceDetectionIds[0] === "B") {
        if (failure === "invalid crop") throw new Error("private-runtime-path");
        if (failure === "empty crop") return { ...crop, cropBytes: Buffer.alloc(0) };
      }
      return crop;
    },
    recognizer: { recognizeGroup: async ({ group }) => {
      const id = group.sourceDetectionIds[0]!;
      if (id === "B") {
        if (failure === "recognizer exception") throw new Error("private-runtime-path");
        if (failure === "empty recognition") return { text: " \n\t" };
        if (failure === "cancel") {
          controller!.abort();
          throw controller!.signal.reason;
        }
      }
      return { text: id };
    } }
  });
}
