import type {
  ExtractedSpeechBubble,
  ExtractedNonSpeechText,
  NormalizedBbox,
  PolygonPoint,
  SpeechBubbleExtractionResult
} from "../../shared/speechBubbleExtraction.js";

export type TextOrientation = "vertical" | "horizontal" | "unknown";

export type DetectedRegion = {
  id?: string;
  bbox: NormalizedBbox;
  polygon?: PolygonPoint[];
  readingOrder: number;
  orientation?: TextOrientation;
  type?: string;
};

export type OcrCropRecognitionInput = {
  cropBytes: Buffer;
  bbox: NormalizedBbox;
  polygon?: PolygonPoint[];
  readingOrder: number;
  orientation?: TextOrientation;
  sourceMimeType?: string;
  signal?: AbortSignal;
};

export type OcrCropRecognitionOutput = {
  text: string;
  confidence: number;
  language?: string;
  notes?: string;
  rawMangaOcrText?: string;
  rawPaddleOcrText?: string;
};

export type CrossValidationResult = {
  selectedText: string;
  confidence: number;
  isConsistent: boolean;
  rawMangaOcrText?: string;
  rawPaddleOcrText?: string;
  similarityRatio: number;
  warnings: string[];
};

export interface OcrTextRecognizer {
  readonly name: string;
  recognizeCrop(input: OcrCropRecognitionInput): Promise<OcrCropRecognitionOutput>;
}

export type OcrPipelineExecutionArgs = {
  imageBytes: Buffer;
  pageNumber: number | null;
  sourceMimeType?: string;
  engine?: "gemini" | "manga-ocr" | "paddle-ocr" | "hybrid" | "windows-ocr";
  ocrEndpoint?: string;
  paddleEndpoint?: string;
  interestMaskBytes?: Buffer;
  signal?: AbortSignal;
};
