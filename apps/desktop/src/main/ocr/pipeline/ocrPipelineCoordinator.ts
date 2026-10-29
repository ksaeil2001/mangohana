import type {
  ExtractedSpeechBubble,
  ExtractedNonSpeechText,
  SpeechBubbleExtractionResult,
  NormalizedBbox
} from "../../../shared/speechBubbleExtraction.js";
import { normalizeSpeechBubbleExtractionResult } from "../../../shared/speechBubbleExtraction.js";
import type { OcrPipelineExecutionArgs } from "../types.js";
import { MangaOcrRunner } from "../recognition/mangaOcrRunner.js";
import { PaddleOcrRunner } from "../recognition/paddleOcrRunner.js";
import { evaluateOcrCrossValidation } from "../evaluator.js";
import { extractSpeechBubblesWithGemini } from "../../geminiSpeechBubbleExtraction.js";
import { extractSpeechBubblesWithLocalOcr } from "../../localMangaOcr.js";
import { extractSpeechBubblesWithLocalPaddleOcr } from "../../localPaddleOcr.js";
import { cropImageToPng } from "../../imageCrop.js";
import { isAbortError, throwIfAborted } from "../../abortSignals.js";

export type OcrCropImageFn = (args: {
  imageBytes: Buffer;
  bbox: NormalizedBbox;
  paddingRatio?: number;
}) => Buffer;

export class OcrPipelineCoordinator {
  private mangaRunner: MangaOcrRunner;
  private paddleRunner: PaddleOcrRunner;
  private cropImage: OcrCropImageFn;

  constructor(options?: {
    mangaEndpoint?: string;
    paddleEndpoint?: string;
    cropImage?: OcrCropImageFn;
  }) {
    this.mangaRunner = new MangaOcrRunner(options?.mangaEndpoint);
    this.paddleRunner = new PaddleOcrRunner(options?.paddleEndpoint);
    this.cropImage = options?.cropImage ?? cropImageToPng;
  }

  /**
   * Executes the decoupled OCR pipeline according to JMTrans architectural principles:
   * 1. Detection / Segmentation
   * 2. Text Recognition (MangaOCR / PaddleOCR / Gemini)
   * 3. Cross-Validation & Confidence Evaluation (in hybrid mode)
   * 4. Schema Normalization
   */
  async execute(args: OcrPipelineExecutionArgs): Promise<SpeechBubbleExtractionResult> {
    const engine = args.engine ?? "gemini";

    // 1. Single engine paths
    if (engine === "gemini") {
      return extractSpeechBubblesWithGemini({
        imageBytes: args.imageBytes,
        sourceMimeType: args.sourceMimeType ?? "image/png",
        pageNumber: args.pageNumber,
        interestMaskBytes: args.interestMaskBytes,
        signal: args.signal
      });
    }

    if (engine === "manga-ocr") {
      return extractSpeechBubblesWithLocalOcr({
        imageBytes: args.imageBytes,
        pageNumber: args.pageNumber ?? 1,
        endpoint: args.ocrEndpoint,
        signal: args.signal
      });
    }

    if (engine === "paddle-ocr") {
      return extractSpeechBubblesWithLocalPaddleOcr({
        imageBytes: args.imageBytes,
        pageNumber: args.pageNumber ?? 1,
        endpoint: args.paddleEndpoint || args.ocrEndpoint,
        signal: args.signal
      });
    }

    // 2. Hybrid Cross-Validation mode: MangaOCR (primary JP) + PaddleOCR (confidence & multi-lang)
    if (engine === "hybrid") {
      // Step 1: Base detection & extraction via Gemini or local MangaOCR
      let baseExtraction: SpeechBubbleExtractionResult;
      try {
        baseExtraction = await extractSpeechBubblesWithGemini({
          imageBytes: args.imageBytes,
          sourceMimeType: args.sourceMimeType ?? "image/png",
          pageNumber: args.pageNumber,
          interestMaskBytes: args.interestMaskBytes,
          signal: args.signal
        });
      } catch (error) {
        if (isAbortError(error) || args.signal?.aborted) throw error;
        baseExtraction = await extractSpeechBubblesWithLocalOcr({
          imageBytes: args.imageBytes,
          pageNumber: args.pageNumber ?? 1,
          endpoint: args.ocrEndpoint,
          signal: args.signal
        });
      }

      // Step 2 & 3: Cross-validate each extracted speech bubble
      const evaluatedBubbles: ExtractedSpeechBubble[] = await Promise.all(
        baseExtraction.speechBubbles.map(async (bubble: ExtractedSpeechBubble) => {
          try {
            throwIfAborted(args.signal);
            // Extract cropped image bytes for the specific speech bubble
            if (!bubble.bbox) {
              return {
                ...bubble,
                isCrossValidated: false
              };
            }

            let cropBytes: Buffer;
            try {
              cropBytes = this.cropImage({
                imageBytes: args.imageBytes,
                bbox: bubble.bbox,
                paddingRatio: 0.08
              });
            } catch {
              return {
                ...bubble,
                isCrossValidated: false,
                notes: [bubble.notes, "교차 검증 생략: 말풍선 영역(bbox) 크롭 실패"].filter(Boolean).join(" | ")
              };
            }

            // Recognize via PaddleOCR for validation
            const paddleOutput = await this.paddleRunner.recognizeCrop({
              cropBytes,
              bbox: bubble.bbox,
              polygon: bubble.polygon,
              readingOrder: bubble.readingOrder,
              signal: args.signal
            });

            const evalResult = evaluateOcrCrossValidation({
              mangaOcrText: bubble.text,
              paddleOcrText: paddleOutput.text,
              paddleConfidence: paddleOutput.confidence
            });

            return {
              ...bubble,
              text: evalResult.selectedText,
              confidence: evalResult.confidence,
              isCrossValidated: true,
              rawMangaOcrText: evalResult.rawMangaOcrText,
              rawPaddleOcrText: evalResult.rawPaddleOcrText,
              notes: [bubble.notes, ...evalResult.warnings].filter(Boolean).join(" | ")
            };
          } catch (error) {
            if (isAbortError(error) || args.signal?.aborted) throw error;
            // Fail-soft: keep base extraction if secondary recognition is unavailable
            return {
              ...bubble,
              isCrossValidated: false
            };
          }
        })
      );

      return {
        ...baseExtraction,
        speechBubbles: evaluatedBubbles
      };
    }

    // Fallback default
    return extractSpeechBubblesWithGemini({
      imageBytes: args.imageBytes,
      sourceMimeType: args.sourceMimeType ?? "image/png",
      pageNumber: args.pageNumber,
      interestMaskBytes: args.interestMaskBytes,
      signal: args.signal
    });
  }
}
