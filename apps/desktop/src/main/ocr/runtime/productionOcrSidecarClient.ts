import type { ProductionOcrDetector, ProductionOcrRecognizer } from "../pipeline/productionOcrPipeline.js";
import { parseProductionOcrDetections } from "../detection/productionDetectorParser.js";
import { PRODUCTION_OCR_CONTRACT } from "../../../shared/productionOcr.js";
import { PRODUCTION_OCR_RUNTIME } from "../../../shared/productionOcrResource.js";

export type ProductionOcrSidecarInvoke = (request: unknown, signal?: AbortSignal) => Promise<unknown>;

export class ProductionOcrSidecarClient implements ProductionOcrDetector, ProductionOcrRecognizer {
  private readonly invoke: ProductionOcrSidecarInvoke;

  constructor(invoke: ProductionOcrSidecarInvoke) {
    this.invoke = invoke;
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const response = await this.invoke({ protocolVersion: 1, operation: "probe" }, signal);
    if (
      !isRecord(response)
      || response.operation !== "probe"
      || response.protocolVersion !== 1
      || !isRecord(response.detector)
      || response.detector.modelId !== PRODUCTION_OCR_CONTRACT.detector.modelId
      || response.detector.revision !== PRODUCTION_OCR_CONTRACT.detector.revision
      || response.detector.device !== "cpu"
      || !isRecord(response.recognizer)
      || response.recognizer.modelId !== PRODUCTION_OCR_CONTRACT.recognizer.modelId
      || response.recognizer.revision !== PRODUCTION_OCR_CONTRACT.recognizer.revision
      || response.recognizer.executionProvider !== "CPUExecutionProvider"
      || !isRecord(response.packages)
      || response.packages.paddlepaddle !== PRODUCTION_OCR_RUNTIME.packages.paddlepaddle
      || response.packages.paddleocr !== PRODUCTION_OCR_RUNTIME.packages.paddleocr
      || response.packages.onnxruntime !== PRODUCTION_OCR_RUNTIME.packages.onnxruntime
      || response.packages.numpy !== PRODUCTION_OCR_RUNTIME.packages.numpy
      || response.packages.pillow !== PRODUCTION_OCR_RUNTIME.packages.pillow
    ) throwInvalidResponse(response);
  }

  async detect(input: Parameters<ProductionOcrDetector["detect"]>[0]) {
    const response = await this.invoke({
      protocolVersion: 1,
      operation: "detect",
      imageBase64: input.imageBytes.toString("base64")
    }, input.signal);
    if (
      !isRecord(response)
      || response.operation !== "detect"
      || typeof response.imageWidth !== "number"
      || typeof response.imageHeight !== "number"
    ) throwInvalidResponse(response);
    return parseProductionOcrDetections(
      { detections: response.detections },
      response.imageWidth,
      response.imageHeight,
      input.onWarning ? (index) => input.onWarning!(
        `OCR_DETECTION_INVALID: 검출 영역 ${index}의 좌표 또는 점수가 유효하지 않아 제외했습니다.`
      ) : undefined
    );
  }

  async recognizeGroup(input: Parameters<ProductionOcrRecognizer["recognizeGroup"]>[0]) {
    const response = await this.invoke({
      protocolVersion: 1,
      operation: "recognize",
      imageBase64: input.cropBytes.toString("base64")
    }, input.signal);
    if (!isRecord(response) || response.operation !== "recognize" || typeof response.text !== "string") {
      throwInvalidResponse(response);
    }
    return { text: response.text };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwInvalidResponse(value: unknown): never {
  if (isRecord(value) && value.operation === "error" && typeof value.message === "string") {
    throw new Error(`Production OCR sidecar failed: ${value.message}`);
  }
  throw new Error("Invalid Production OCR sidecar response");
}
