import type { NormalizedBbox } from "./speechBubbleExtraction.js";

export type InpaintingQaStatus = "pass" | "retry" | "manual_review";

export type ResidualTextRegion = {
  bbox: NormalizedBbox;
  detectedText?: string;
  residualConfidence: number;
  severity: "minor" | "severe";
  notes?: string;
};

export type InpaintingQaRecommendedAction =
  | "none"
  | "auto_retry_dilate"
  | "fallback_local"
  | "manual_brush";

export type InpaintingQaResult = {
  qaStatus: InpaintingQaStatus;
  cleanlinessScore: number; // 0.0 to 1.0, where 1.0 means completely clean
  residualRegions: ResidualTextRegion[];
  attemptCount: number;
  maxRetryAttempts: number;
  reason?: string;
  evaluatedAt: string;
  recommendedAction?: InpaintingQaRecommendedAction;
  recommendedDilation?: number;
};

export const DEFAULT_MAX_INPAINTING_RETRIES = 2;
export const RESIDUAL_CONFIDENCE_THRESHOLD = 0.25;
export const SEVERE_RESIDUAL_CONFIDENCE_THRESHOLD = 0.65;

export const inpaintingQaStatusLabels: Record<InpaintingQaStatus, string> = {
  pass: "정상 (PASS)",
  retry: "자동 재시도 권장 (RETRY)",
  manual_review: "수동 검수 필요 (MANUAL_REVIEW)"
};

/**
 * 잔여 텍스트 영역 목록과 재시도 횟수를 기반으로 인페인팅 품질 상태(PASS / RETRY / MANUAL_REVIEW)를 판정합니다.
 */
export function evaluateInpaintingQuality(args: {
  residualRegions: readonly ResidualTextRegion[];
  attemptCount?: number;
  maxRetryAttempts?: number;
}): InpaintingQaResult {
  const attemptCount = args.attemptCount ?? 1;
  const maxRetryAttempts = args.maxRetryAttempts ?? DEFAULT_MAX_INPAINTING_RETRIES;
  const regions = [...args.residualRegions].filter(
    (r) => r.residualConfidence >= RESIDUAL_CONFIDENCE_THRESHOLD
  );

  const cleanlinessScore = calculateCleanlinessScore(regions);
  const now = new Date().toISOString();

  // 1. 잔여 텍스트가 없으면 즉시 PASS
  if (regions.length === 0) {
    return {
      qaStatus: "pass",
      cleanlinessScore: 1.0,
      residualRegions: [],
      attemptCount,
      maxRetryAttempts,
      reason: "잔여 텍스트가 감지되지 않아 인페인팅 검수를 통과했습니다.",
      evaluatedAt: now,
      recommendedAction: "none",
      recommendedDilation: 0
    };
  }

  const hasSevereResidual = regions.some(
    (r) => r.severity === "severe" || r.residualConfidence >= SEVERE_RESIDUAL_CONFIDENCE_THRESHOLD
  );

  // 2. 최대 재시도 횟수를 초과했거나 심각한 잔여물이 다수 존재하는 경우 MANUAL_REVIEW
  if (attemptCount >= maxRetryAttempts || (hasSevereResidual && regions.length > 2)) {
    return {
      qaStatus: "manual_review",
      cleanlinessScore,
      residualRegions: regions,
      attemptCount,
      maxRetryAttempts,
      reason:
        attemptCount >= maxRetryAttempts
          ? `최대 재시도 횟수(${maxRetryAttempts}회)를 초과하여 수동 검토가 필요합니다.`
          : "복잡한 배경 또는 잔여 글자가 뚜렷하여 수동 브러시 수정이 필요합니다.",
      evaluatedAt: now,
      recommendedAction: "manual_brush"
    };
  }

  // 3. 경미한 잔여물이며 재시도 횟수가 남아있는 경우 RETRY
  return {
    qaStatus: "retry",
    cleanlinessScore,
    residualRegions: regions,
    attemptCount,
    maxRetryAttempts,
    reason: "경미한 텍스트 잔여물이 감지되었습니다. 마스크 확장 후 재인페인팅을 권장합니다.",
    evaluatedAt: now,
    recommendedAction: "auto_retry_dilate",
    recommendedDilation: 2 * attemptCount
  };
}

/**
 * 잔여 텍스트 영역의 면적과 신뢰도를 기반으로 청결도 점수(0.0 ~ 1.0)를 계산합니다.
 */
export function calculateCleanlinessScore(regions: readonly ResidualTextRegion[]): number {
  if (regions.length === 0) return 1.0;

  let penalty = 0;
  for (const region of regions) {
    const area = Math.max(0.01, (region.bbox.width || 0.1) * (region.bbox.height || 0.1));
    const severityFactor = region.severity === "severe" ? 1.5 : 1.0;
    penalty += area * region.residualConfidence * severityFactor * 10;
  }

  return Math.max(0.0, Math.min(1.0, Number((1.0 - penalty).toFixed(2))));
}
