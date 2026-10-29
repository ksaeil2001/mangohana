import type { DialogueLine, TranslationProject } from "./projectTypes.js";
import { mangaSpeechStylePresets, type MangaSpeechStylePreset } from "./translationContext.js";
import {
  autoFitFontSizeForBubbleShape,
  calculateContrastStroke,
  getRecommendedFontFallbackChain
} from "./typesettingGeometry.js";

export type BatchPipelineStage =
  | "idle"
  | "ocr"
  | "glossary"
  | "translate"
  | "inpaint"
  | "typeset"
  | "completed"
  | "partial"
  | "failed"
  | "canceled"
  | "error";

export type BatchPipelineConfig = {
  targetPages: number[] | "all";
  runOcr: boolean;
  runGlossary: boolean;
  runTranslate: boolean;
  runInpaint: boolean;
  runTypeset: boolean;
  speechStylePreset: MangaSpeechStylePreset;
  overwriteExisting: boolean;
};

export type BatchPageStatus = {
  pageNumber: number;
  ocrDone: boolean;
  translatedCount: number;
  inpaintingDone: boolean;
  typesettingDone: boolean;
  error?: string;
};

export type BatchProgressState = {
  stage: BatchPipelineStage;
  currentPageIndex: number;
  totalPages: number;
  percent: number;
  currentMessage: string;
  pageStatuses: Record<number, BatchPageStatus>;
  errors: Array<{ pageNumber?: number; message: string }>;
  isCanceled: boolean;
};

export function getDefaultBatchConfig(): BatchPipelineConfig {
  return {
    targetPages: "all",
    runOcr: false,
    runGlossary: false,
    runTranslate: true,
    runInpaint: false,
    runTypeset: true,
    speechStylePreset: "informal",
    overwriteExisting: false
  };
}

export function validateBatchPipelineConfig(input: unknown): BatchPipelineConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid batch pipeline config: payload must be an object");
  }

  const record = input as Record<string, unknown>;

  let targetPages: number[] | "all" = "all";
  if ("targetPages" in record) {
    if (record.targetPages === "all") {
      targetPages = "all";
    } else if (Array.isArray(record.targetPages)) {
      if (record.targetPages.length === 0) {
        throw new Error("Invalid batch pipeline config: targetPages cannot be empty array");
      }
      for (const page of record.targetPages) {
        if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
          throw new Error(`Invalid batch pipeline config: targetPages must contain positive integers, received ${String(page)}`);
        }
      }
      targetPages = [...record.targetPages];
    } else {
      throw new Error("Invalid batch pipeline config: targetPages must be 'all' or an array of positive page numbers");
    }
  }

  const booleanFields = [
    "runTranslate",
    "runTypeset",
    "overwriteExisting",
    "runOcr",
    "runGlossary",
    "runInpaint"
  ] as const;

  for (const field of booleanFields) {
    if (field in record && typeof record[field] !== "boolean") {
      throw new Error(`Invalid batch pipeline config: ${field} must be a boolean`);
    }
  }

  // Unsupported stages check
  if (record.runOcr === true) {
    throw new Error("지원하지 않는 일괄 처리 단계입니다: 말풍선 OCR 일괄 처리는 아직 지원되지 않습니다 (작업대 개별 실행).");
  }
  if (record.runGlossary === true) {
    throw new Error("지원하지 않는 일괄 처리 단계입니다: 용어집 일괄 처리는 아직 지원되지 않습니다.");
  }
  if (record.runInpaint === true) {
    throw new Error("지원하지 않는 일괄 처리 단계입니다: 배경 인페인팅 일괄 처리는 아직 지원되지 않습니다 (작업대 개별 실행).");
  }

  const runTranslate = typeof record.runTranslate === "boolean" ? record.runTranslate : true;
  const runTypeset = typeof record.runTypeset === "boolean" ? record.runTypeset : true;
  const overwriteExisting = typeof record.overwriteExisting === "boolean" ? record.overwriteExisting : false;

  if (!runTranslate && !runTypeset) {
    throw new Error("실행할 일괄 처리 단계가 없습니다: 번역 또는 식자 중 적어도 하나는 활성화되어야 합니다.");
  }

  if (typeof record.speechStylePreset !== "string" || !(mangaSpeechStylePresets as readonly string[]).includes(record.speechStylePreset)) {
    throw new Error(`Invalid batch pipeline config: speechStylePreset must be one of [${mangaSpeechStylePresets.join(", ")}], received ${String(record.speechStylePreset)}`);
  }
  const speechStylePreset = record.speechStylePreset as MangaSpeechStylePreset;

  return {
    targetPages,
    runOcr: false,
    runGlossary: false,
    runTranslate,
    runInpaint: false,
    runTypeset,
    speechStylePreset,
    overwriteExisting
  };
}

export function createInitialBatchProgress(
  pageCount: number,
  config: BatchPipelineConfig
): BatchProgressState {
  const targetPages =
    !config.targetPages || config.targetPages === "all" || !Array.isArray(config.targetPages)
      ? Array.from({ length: Math.max(1, pageCount) }, (_, i) => i + 1)
      : config.targetPages;

  const pageStatuses: Record<number, BatchPageStatus> = {};
  for (const pageNumber of targetPages) {
    pageStatuses[pageNumber] = {
      pageNumber,
      ocrDone: false,
      translatedCount: 0,
      inpaintingDone: false,
      typesettingDone: false
    };
  }

  return {
    stage: "idle",
    currentPageIndex: 0,
    totalPages: targetPages.length,
    percent: 0,
    currentMessage: "일괄 처리 준비됨",
    pageStatuses,
    errors: [],
    isCanceled: false
  };
}

export function calculateBatchPercent(
  stage: BatchPipelineStage,
  pageIndex: number,
  totalPages: number
): number {
  if (stage === "completed" || stage === "partial") return 100;
  if (stage === "idle" || totalPages === 0) return 0;
  if (stage === "canceled" || stage === "error" || stage === "failed") return Math.min(100, Math.round((pageIndex / totalPages) * 100));

  const stageWeights: Record<BatchPipelineStage, { base: number; weight: number }> = {
    idle: { base: 0, weight: 0 },
    ocr: { base: 0, weight: 25 },
    glossary: { base: 25, weight: 10 },
    translate: { base: 35, weight: 30 },
    inpaint: { base: 65, weight: 25 },
    typeset: { base: 90, weight: 10 },
    completed: { base: 100, weight: 0 },
    partial: { base: 100, weight: 0 },
    failed: { base: 0, weight: 0 },
    canceled: { base: 0, weight: 0 },
    error: { base: 0, weight: 0 }
  };

  const { base, weight } = stageWeights[stage] ?? { base: 0, weight: 0 };
  const pageFraction = totalPages > 0 ? (pageIndex + 1) / totalPages : 0;
  return Math.min(99, Math.round(base + weight * pageFraction));
}

/**
 * Generates automated typesetting configurations for dialogue lines based on shape and bounding box.
 * Only an explicitly adopted user translation may produce persisted typesetting.
 */
export function generateBatchTypesetting(lines: readonly DialogueLine[]): DialogueLine[] {
  return lines.map((line) => {
    const text = line.userTranslation?.trim() ?? "";

    if (!text) return line;

    const existingTs = line.typesetting;
    let bbox = existingTs?.bbox;

    if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
      if (line.polygon && line.polygon.length >= 3) {
        const xs = line.polygon.map((p) => p.x);
        const ys = line.polygon.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const w = maxX - minX;
        const h = maxY - minY;
        if (w > 0 && h > 0) {
          bbox = { x: minX, y: minY, width: w, height: h };
        }
      }
    }

    // Do not invent arbitrary geometry if no valid bbox or polygon exists
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
      return line;
    }

    const shape = existingTs?.shape ?? "ellipse";
    const layout = autoFitFontSizeForBubbleShape(text, { shape });
    const contrast = calculateContrastStroke({
      textColor: existingTs?.color || "#000000",
      isDarkBackground: false,
      fontSizeRatio: layout.fontSizeRatio
    });

    return {
      ...line,
      typesetting: {
        bbox,
        writingMode: existingTs?.writingMode ?? "horizontal-tb",
        shape,
        fontSizeRatio: layout.fontSizeRatio,
        fontFamily: existingTs?.fontFamily ?? getRecommendedFontFallbackChain("ko", "Pretendard"),
        color: existingTs?.color ?? "#000000",
        strokeColor: existingTs?.strokeColor ?? contrast.strokeColor,
        strokeWidth: existingTs?.strokeWidth ?? contrast.strokeWidth,
        align: existingTs?.align ?? "center",
        rotationDegrees: existingTs?.rotationDegrees ?? 0
      }
    };
  });
}
