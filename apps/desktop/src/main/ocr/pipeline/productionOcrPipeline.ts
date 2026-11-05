import type { SpeechBubbleExtractionResult } from "../../../shared/speechBubbleExtraction.js";
import type {
  ProductionOcrCropTransform,
  ProductionOcrDetection,
  ProductionOcrDetectionModelIdentity,
  ProductionOcrGroup,
  ProductionOcrRecognizerIdentity
} from "../../../shared/productionOcr.js";
import { deriveProductionOcrDetectorIdentity, isProductionOcrRecognizerIdentity } from "../../../shared/productionOcrValidation.js";
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
  groups?: readonly ProductionOcrGroup[];
}) => { cropBytes: Buffer; transform: ProductionOcrCropTransform };

export class ProductionOcrPipeline {
  private readonly detector: ProductionOcrDetector;
  private readonly recognizer: ProductionOcrRecognizer;
  private readonly cropGroup: ProductionOcrCropGroup;
  private readonly recognizerIdentity: ProductionOcrRecognizerIdentity;

  constructor(options: {
    detector: ProductionOcrDetector;
    recognizer: ProductionOcrRecognizer;
    cropGroup: ProductionOcrCropGroup;
    recognizerIdentity?: ProductionOcrRecognizerIdentity;
  }) {
    const recognizerIdentity = options.recognizerIdentity === undefined ? PRODUCTION_OCR_CONTRACT.recognizer : options.recognizerIdentity;
    if (!isProductionOcrRecognizerIdentity(recognizerIdentity)) throw new Error("Invalid Production OCR recognizer identity");
    this.recognizerIdentity = { ...recognizerIdentity };
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
      const memberModels = group.memberModels ?? group.sourceDetectionIds.map<ProductionOcrDetectionModelIdentity>(() => ({
        modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: PRODUCTION_OCR_CONTRACT.detector.revision
      }));
      const supportModels = group.memberSupportModels;
      const detectorIdentity = deriveProductionOcrDetectorIdentity(memberModels, supportModels);
      const warn = (code: string, reason: string) => warnings.push(
        `${code}: 영역 ${group.readingOrder} [${group.groupId}] ${reason}`
      );
      let crop: ReturnType<ProductionOcrCropGroup>;
      try {
        crop = this.cropGroup({ imageBytes: input.imageBytes, group, groups });
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
      if (group.memberSupportModels?.some((model) => model !== null) && group.confidence < 0.6) {
        warn("OCR_TEXT_REVIEW_REQUIRED", "약하게 검출된 작은 글씨입니다. 글자와 읽기 순서를 원본과 대조해 확인하세요.");
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
          detectorModelId: detectorIdentity.modelId,
          detectorRevision: detectorIdentity.revision,
          recognizerModelId: this.recognizerIdentity.modelId,
          recognizerRevision: this.recognizerIdentity.revision,
          groupId: group.groupId,
          sourceDetectionIds: [...group.sourceDetectionIds],
          sourceQuadsPx: group.memberQuadsPx.map((quad) => quad.map((point) => ({ ...point })) as unknown as typeof quad),
          sourceDetectionScores: [...group.memberScores],
          sourceDetectionModels: memberModels.map((model) => ({ ...model })),
          ...(supportModels === undefined ? {} : {
            sourceDetectionSupportModels: supportModels.map((model) => model === null ? null : { ...model })
          }),
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
