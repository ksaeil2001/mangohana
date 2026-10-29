import { describe, expect, it } from "vitest";
import {
  validateApplyProductionOcrReviewArgs,
  validateProductionOcrRequestArgs
} from "../../src/main/ipcHandlers.js";
import { PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";

const validRequest = {
  requestId: "ocr-request-1",
  projectSessionId: "session-1",
  pageImageId: "page-1",
  sourceSha256: "a".repeat(64)
};

const validReviewRequest = {
  projectSessionId: "session-1",
  pageImageId: "page-1",
  sourceSha256: "a".repeat(64),
  runId: "ocr-run-1",
  candidates: [{
    id: "group-1",
    textType: "speech_bubble",
    text: "Production OCR",
    language: "en",
    bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    polygon: [
      { x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 },
      { x: 0.4, y: 0.3 }, { x: 0.1, y: 0.3 }
    ],
    readingOrder: 1,
    confidence: 0.91,
    notes: "",
    selectedSpeaker: "",
    orientation: "horizontal",
    productionOcrProvenance: {
      contractVersion: 1,
      detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
      detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
      recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
      recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
      groupId: "group-1",
      sourceDetectionIds: ["detection-1"],
      sourceDetectionScores: [0.91],
      sourceQuadsPx: [[
        { x: 100, y: 200 }, { x: 400, y: 200 },
        { x: 400, y: 300 }, { x: 100, y: 300 }
      ]],
      orientation: "horizontal",
      cropTransform: {
        sourceBboxPx: { x: 100, y: 200, width: 300, height: 100 },
        cropBboxPx: { x: 76, y: 192, width: 348, height: 116 },
        paddingRatio: 0.08,
        rotationDegrees: 0,
        imageWidth: 1000,
        imageHeight: 1000
      },
      confidenceSource: "detector_min"
    },
    typesetting: {
      bbox: { x: 0.12, y: 0.21, width: 0.26, height: 0.08 },
      writingMode: "horizontal-tb",
      rotationDegrees: 0
    }
  }]
};

describe("Production OCR IPC contract", () => {
  it("accepts only Main-resolved source identity fields", () => {
    expect(validateProductionOcrRequestArgs(validRequest)).toEqual(validRequest);
  });

  it.each([
    ["engine", "manga-ocr"],
    ["ocrEndpoint", "http://localhost:5000/ocr"],
    ["mangaOcrEndpoint", "http://localhost:5000/ocr"],
    ["paddleOcrEndpoint", "http://localhost:5001/ocr"],
    ["projectFilePath", "C:\\project.ctp"],
    ["interestMaskPngBase64", "mask"]
  ])("rejects the legacy %s routing field", (field, value) => {
    expect(() => validateProductionOcrRequestArgs({
      ...validRequest,
      [field]: value
    })).toThrow("Production OCR request");
  });

  it("accepts a review candidate only with exact frozen-model provenance", () => {
    expect(validateApplyProductionOcrReviewArgs(validReviewRequest)).toEqual(validReviewRequest);
  });

  it.each([
    ["legacy candidate routing", (request: typeof validReviewRequest) => Object.assign(request.candidates[0]!, { engine: "manga-ocr" })],
    ["unsupported language", (request: typeof validReviewRequest) => { request.candidates[0]!.language = "fr"; }],
    ["recognizer revision drift", (request: typeof validReviewRequest) => {
      Object.defineProperty(request.candidates[0]!.productionOcrProvenance, "recognizerRevision", { value: "latest" });
    }],
    ["rotated vertical shortcut", (request: typeof validReviewRequest) => { request.candidates[0]!.productionOcrProvenance.cropTransform.rotationDegrees = 90; }],
    ["truncated detection quad", (request: typeof validReviewRequest) => { request.candidates[0]!.productionOcrProvenance.sourceQuadsPx[0]!.pop(); }],
    ["missing detection score", (request: typeof validReviewRequest) => { request.candidates[0]!.productionOcrProvenance.sourceDetectionScores.pop(); }],
    ["unbounded typesetting", (request: typeof validReviewRequest) => { request.candidates[0]!.typesetting!.bbox.x = 0.9; }]
  ])("rejects %s in a review candidate", (_label, mutate) => {
    const request = structuredClone(validReviewRequest);
    mutate(request);
    expect(() => validateApplyProductionOcrReviewArgs(request)).toThrow("candidate contract mismatch");
  });
});
