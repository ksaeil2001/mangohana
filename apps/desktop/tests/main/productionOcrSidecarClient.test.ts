import { describe, expect, it } from "vitest";
import { ProductionOcrSidecarClient } from "../../src/main/ocr/runtime/productionOcrSidecarClient.js";

describe("Production OCR sidecar client", () => {
  it("accepts only the pinned CPU runtime probe", async () => {
    const client = new ProductionOcrSidecarClient(async () => ({
      operation: "probe",
      protocolVersion: 1,
      detector: {
        modelId: "PaddlePaddle/PP-OCRv6_medium_det",
        revision: "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
        device: "cpu"
      },
      recognizer: {
        modelId: "genshiai-daichi/baberu-ocr",
        revision: "d9cc13153e9a1cd8fdfa3b7b1cc329da2020aeae",
        executionProvider: "CPUExecutionProvider"
      },
      packages: {
        paddlepaddle: "3.3.1",
        paddleocr: "3.7.0",
        onnxruntime: "1.23.2",
        numpy: "2.2.6",
        pillow: "12.1.0"
      }
    }));

    await expect(client.probe()).resolves.toBeUndefined();
  });

  it("sends detector bytes without a provider selector and parses PP-OCR quads", async () => {
    const requests: unknown[] = [];
    const client = new ProductionOcrSidecarClient(async (request) => {
      requests.push(request);
      return {
        operation: "detect",
        imageWidth: 200,
        imageHeight: 100,
        detections: [
          { detectionId: "det-1", quad: [[20, 10], [120, 10], [120, 30], [20, 30]], score: 0.88 }
        ]
      };
    });

    const detections = await client.detect({ imageBytes: Buffer.from("source") });

    expect(requests).toEqual([{
      protocolVersion: 1,
      operation: "detect",
      imageBase64: Buffer.from("source").toString("base64")
    }]);
    expect(detections[0]).toMatchObject({
      detectionId: "det-1",
      sourceBboxPx: { x: 20, y: 10, width: 100, height: 20 },
      score: 0.88
    });
  });

  it("uses the sole Baberu operation without language or fallback fields", async () => {
    const requests: unknown[] = [];
    const client = new ProductionOcrSidecarClient(async (request) => {
      requests.push(request);
      return { operation: "recognize", text: "こんにちは" };
    });

    await expect(client.recognizeGroup({
      cropBytes: Buffer.from("crop"),
      group: group("vertical")
    })).resolves.toEqual({ text: "こんにちは" });
    expect(requests).toEqual([{
      protocolVersion: 1,
      operation: "recognize",
      imageBase64: Buffer.from("crop").toString("base64")
    }]);
  });

  it("rejects malformed sidecar output instead of falling back", async () => {
    const client = new ProductionOcrSidecarClient(async () => ({ operation: "recognize", text: 42 }));
    await expect(client.recognizeGroup({ cropBytes: Buffer.from("crop"), group: group("horizontal") }))
      .rejects.toThrow("Invalid Production OCR sidecar response");
  });
});

function group(orientation: "horizontal" | "vertical") {
  return {
    groupId: "group-1",
    sourceDetectionIds: ["det-1"],
    memberQuadsPx: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 0, y: 20 }]] as const,
    memberScores: [0.9],
    groupBboxPx: { x: 0, y: 0, width: 10, height: 20 },
    bbox: { x: 0, y: 0, width: 0.1, height: 0.2 },
    polygon: [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.2 }, { x: 0, y: 0.2 }] as const,
    orientation,
    readingOrder: 1,
    confidence: 0.9,
    imageWidth: 100,
    imageHeight: 100
  };
}
