import type { SpeechBubbleExtractionResult } from "../../../shared/speechBubbleExtraction.js";
import type {
  ProductionOcrCropTransform,
  ProductionOcrDetection,
  ProductionOcrGroup
} from "../../../shared/productionOcr.js";
import {
  PRODUCTION_OCR_CONTRACT,
  normalizeProductionOcrText
} from "../../../shared/productionOcr.js";
import { isAbortError, throwIfAborted } from "../../abortSignals.js";
import { groupProductionOcrDetections } from "../grouping/productionRegionGrouping.js";

export type ProductionOcrDetector = Readonly<{
  detect: (input: { imageBytes: Buffer; signal?: AbortSignal; onWarning?: (warning: string) => void }) => Promise<readonly ProductionOcrDetection[]>;
}>;

export type ProductionOcrRecognizer = Readonly<{
  recognizeGroup: (input: {
    group: ProductionOcrGroup;
    cropBytes: Buffer;
    signal?: AbortSignal;
  }) => Promise<{ text: string }>;
}>;

export type ProductionOcrCropGroup = (input: {
  imageBytes: Buffer;
  group: ProductionOcrGroup;
}) => { cropBytes: Buffer; transform: ProductionOcrCropTransform };

export class ProductionOcrPipeline {
  private readonly detector: ProductionOcrDetector;
  private readonly recognizer: ProductionOcrRecognizer;
  private readonly cropGroup: ProductionOcrCropGroup;

  constructor(options: {
    detector: ProductionOcrDetector;
    recognizer: ProductionOcrRecognizer;
    cropGroup: ProductionOcrCropGroup;
  }) {
    this.detector = options.detector;
    this.recognizer = options.recognizer;
    this.cropGroup = options.cropGroup;
  }

  async execute(input: {
    imageBytes: Buffer;
    pageNumber: number | null;
    signal?: AbortSignal;
  }): Promise<SpeechBubbleExtractionResult> {
    throwIfAborted(input.signal);
    const warnings: string[] = [];
    const detections = await this.detector.detect({
      imageBytes: input.imageBytes,
      signal: input.signal,
      onWarning: (warning) => warnings.push(warning)
    });
    throwIfAborted(input.signal);
    const groups = groupProductionOcrDetections(detections);
    const speechBubbles: SpeechBubbleExtractionResult["speechBubbles"] = [];

    for (const group of groups) {
      throwIfAborted(input.signal);
      const warn = (code: string, reason: string) => warnings.push(
        `${code}: 영역 ${group.readingOrder} [${group.groupId}] ${reason}`
      );
      let crop: ReturnType<ProductionOcrCropGroup>;
      try {
        crop = this.cropGroup({ imageBytes: input.imageBytes, group });
      } catch (error) {
        throwIfAborted(input.signal);
        if (isAbortError(error)) throw error;
        warn("OCR_REGION_CROP_FAILED", "이미지 crop에 실패했습니다. 영역을 확인하고 다시 실행하세요.");
        continue;
      }
      if (crop.cropBytes.length === 0) {
        warn("OCR_REGION_CROP_EMPTY", "이미지 crop이 비어 있습니다. 영역을 확인하세요.");
        continue;
      }
      let recognition: { text: string };
      try {
        recognition = await this.recognizer.recognizeGroup({
          group,
          cropBytes: crop.cropBytes,
          signal: input.signal
        });
      } catch (error) {
        throwIfAborted(input.signal);
        if (isAbortError(error)) throw error;
        warn("OCR_REGION_RECOGNITION_FAILED", "문자 인식에 실패했습니다. 영역을 확인하고 다시 실행하세요.");
        continue;
      }
      throwIfAborted(input.signal);
      const text = normalizeProductionOcrText(recognition.text);
      if (text.trim().length === 0) {
        warn("OCR_REGION_RECOGNITION_EMPTY", "인식된 문자가 없습니다. 원본을 확인하세요.");
        continue;
      }
      speechBubbles.push({
        id: group.groupId,
        type: "speech_bubble",
        text,
        language: inferDisplayLanguage(text),
        bbox: { ...group.bbox },
        polygon: group.polygon.map((point) => ({ ...point })),
        readingOrder: group.readingOrder,
        confidence: group.confidence,
        notes: "",
        speakerCandidates: [],
        orientation: group.orientation,
        productionOcrProvenance: {
          contractVersion: 1,
          detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
          detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
          recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
          recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
          groupId: group.groupId,
          sourceDetectionIds: [...group.sourceDetectionIds],
          sourceQuadsPx: group.memberQuadsPx.map((quad) => quad.map((point) => ({ ...point })) as unknown as typeof quad),
          sourceDetectionScores: [...group.memberScores],
          orientation: group.orientation,
          cropTransform: crop.transform,
          confidenceSource: "detector_min",
          recognition: {
            rawOcrText: recognition.text,
            normalizedOcrText: text,
            normalization: PRODUCTION_OCR_CONTRACT.normalization
          }
        }
      });
    }

    return {
      pageNumber: input.pageNumber,
      speechBubbles,
      nonSpeechText: [],
      warnings
    };
  }
}

function inferDisplayLanguage(text: string): "ja" | "en" | "unknown" {
  if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u.test(text)) return "ja";
  if (/\p{Script=Latin}/u.test(text)) return "en";
  return "unknown";
}
