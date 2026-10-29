import type { DialogueLine, DialogueTypesetting } from "./projectTypes.js";

export type RenderReadinessBlockerCode =
  | "missing_user_translation"
  | "ai_only_translation"
  | "missing_typesetting_geometry"
  | "invalid_safe_area"
  | "provisional_safe_area"
  | "font_resource_missing"
  | "font_metrics_unavailable"
  | "missing_glyph"
  | "text_overflow"
  | "cleaned_asset_not_approved"
  | "cleaned_asset_qa_failed"
  | "stale_result";

export const renderReadinessBlockerCodes: readonly RenderReadinessBlockerCode[] = [
  "missing_user_translation",
  "ai_only_translation",
  "missing_typesetting_geometry",
  "invalid_safe_area",
  "provisional_safe_area",
  "font_resource_missing",
  "font_metrics_unavailable",
  "missing_glyph",
  "text_overflow",
  "cleaned_asset_not_approved",
  "cleaned_asset_qa_failed",
  "stale_result"
];

export type RenderReadinessBlocker = {
  code: RenderReadinessBlockerCode;
  message: string;
  lineId?: string;
};

export type RenderReadinessInput = {
  pageImageId: string;
  revision: number;
  resultRevision: number;
  lines: readonly DialogueLine[];
  approvedCleanedAssetId?: string;
  cleanedAssetQaStatus?: "pass" | "retry" | "manual_review";
  cleanedAssetRequired?: boolean;
  safeAreaProvisionalLineIds?: readonly string[];
  missingGlyphLineIds?: readonly string[];
  overflowLineIds?: readonly string[];
  font?: {
    identity: string;
    resourceAvailable: boolean;
    metricsCalculated: boolean;
    glyphCoverageVerified: boolean;
  };
};

export type RenderReadinessEvidence = {
  font: {
    identity: string;
    resourceAvailable: boolean;
    metricsCalculated: boolean;
    glyphCoverageVerified: boolean;
  };
  safeAreaProvisionalLineIds: string[];
  missingGlyphLineIds: string[];
  overflowLineIds: string[];
};

export type RenderReadinessReport = {
  ready: boolean;
  revision: number;
  blockers: RenderReadinessBlocker[];
  warnings: string[];
  pageImageId: string;
  lineIds: string[];
  sourceFingerprint: string;
  userTranslationFingerprint: string;
  typesettingGeometryFingerprint: string;
  fontIdentity: string;
  evidence: RenderReadinessEvidence;
  approvedCleanedAssetId?: string;
};

export function buildRenderReadinessReport(
  input: RenderReadinessInput
): RenderReadinessReport {
  const lines = [...input.lines].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const blockers: RenderReadinessBlocker[] = [];
  const safeAreaProvisionalLineIds = normalizeLineIds(input.safeAreaProvisionalLineIds);
  const missingGlyphLineIds = normalizeLineIds(input.missingGlyphLineIds);
  const overflowLineIds = normalizeLineIds(input.overflowLineIds);
  const provisional = new Set(safeAreaProvisionalLineIds);
  const missingGlyphs = new Set(missingGlyphLineIds);
  const overflow = new Set(overflowLineIds);

  for (const line of lines) {
    const userText = line.userTranslation?.trim();
    if (!userText) {
      blockers.push({
        code: line.aiTranslation?.trim() ? "ai_only_translation" : "missing_user_translation",
        message: line.aiTranslation?.trim()
          ? "AI 번역 초안만 있고 사용자가 적용한 번역문이 없습니다."
          : "사용자 번역문이 비어 있습니다.",
        lineId: line.id
      });
    }

    const bbox = line.typesetting?.bbox;
    if (!line.typesetting) {
      blockers.push({
        code: "missing_typesetting_geometry",
        message: "식자 geometry가 없습니다.",
        lineId: line.id
      });
    } else if (!isValidTypesettingGeometry(line.typesetting)) {
      blockers.push({
        code: "invalid_safe_area",
        message: "식자 안전 영역이 유효하지 않습니다.",
        lineId: line.id
      });
    }
    if (provisional.has(line.id)) {
      blockers.push({
        code: "provisional_safe_area",
        message: "사용자가 승인하지 않은 provisional 안전 영역입니다.",
        lineId: line.id
      });
    }
    if (missingGlyphs.has(line.id)) {
      blockers.push({ code: "missing_glyph", message: "필요한 글리프가 폰트에 없습니다.", lineId: line.id });
    }
    if (overflow.has(line.id)) {
      blockers.push({ code: "text_overflow", message: "텍스트가 안전 영역을 벗어납니다.", lineId: line.id });
    }
  }

  const fontIdentity = input.font?.identity?.trim() ?? "";
  if (!fontIdentity || !input.font?.resourceAvailable) {
    blockers.push({ code: "font_resource_missing", message: "식자에 필요한 폰트 resource가 없습니다." });
  }
  if (!input.font?.metricsCalculated) {
    blockers.push({ code: "font_metrics_unavailable", message: "폰트 metrics 계산이 완료되지 않았습니다." });
  }
  if (!input.font?.glyphCoverageVerified) {
    blockers.push({ code: "missing_glyph", message: "필요한 글리프 coverage evidence를 확인하지 못했습니다." });
  }
  if (input.cleanedAssetRequired && !input.approvedCleanedAssetId) {
    blockers.push({ code: "cleaned_asset_not_approved", message: "승인된 cleaned asset이 없습니다." });
  }
  if (input.approvedCleanedAssetId && input.cleanedAssetQaStatus !== "pass") {
    blockers.push({ code: "cleaned_asset_qa_failed", message: "cleaned asset의 인페인팅 QA가 PASS가 아닙니다." });
  }
  if (input.resultRevision !== input.revision) {
    blockers.push({ code: "stale_result", message: "현재 프로젝트 revision과 식자 결과 revision이 다릅니다." });
  }

  return {
    ready: blockers.length === 0,
    revision: input.revision,
    blockers,
    warnings: input.approvedCleanedAssetId ? [] : ["cleaned asset이 없어 원본 이미지 위에 식자를 적용합니다."],
    pageImageId: input.pageImageId,
    lineIds: lines.map((line) => line.id),
    sourceFingerprint: fingerprint(lines.map((line) => [line.id, line.sourceText, line.polygon ?? null])),
    userTranslationFingerprint: fingerprint(lines.map((line) => [line.id, line.userTranslation?.trim() ?? ""])),
    typesettingGeometryFingerprint: fingerprint(lines.map((line) => [line.id, line.typesetting ?? null])),
    fontIdentity,
    evidence: {
      font: {
        identity: fontIdentity,
        resourceAvailable: input.font?.resourceAvailable === true,
        metricsCalculated: input.font?.metricsCalculated === true,
        glyphCoverageVerified: input.font?.glyphCoverageVerified === true
      },
      safeAreaProvisionalLineIds,
      missingGlyphLineIds,
      overflowLineIds
    },
    ...(input.approvedCleanedAssetId ? { approvedCleanedAssetId: input.approvedCleanedAssetId } : {})
  };
}

export function isValidSafeArea(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const { x, y, width, height } = candidate;
  return [x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part)) &&
    (x as number) >= 0 && (y as number) >= 0 && (width as number) > 0 && (height as number) > 0 &&
    (x as number) + (width as number) <= 1 && (y as number) + (height as number) <= 1;
}

export function isValidTypesettingGeometry(value: unknown): value is DialogueTypesetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isValidSafeArea(candidate.bbox)) return false;
  if (candidate.writingMode !== "horizontal-tb" && candidate.writingMode !== "vertical-rl") return false;
  if (candidate.rotationDegrees !== undefined && (
    typeof candidate.rotationDegrees !== "number" || !Number.isFinite(candidate.rotationDegrees)
  )) return false;
  if (candidate.fontSizeRatio !== undefined && (
    typeof candidate.fontSizeRatio !== "number" || !Number.isFinite(candidate.fontSizeRatio) || candidate.fontSizeRatio <= 0
  )) return false;
  if (candidate.lineHeight !== undefined && (
    typeof candidate.lineHeight !== "number" || !Number.isFinite(candidate.lineHeight) || candidate.lineHeight <= 0
  )) return false;

  const bbox = candidate.bbox;
  const rotationDegrees = typeof candidate.rotationDegrees === "number" ? candidate.rotationDegrees : 0;
  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const radians = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    [bbox.x, bbox.y],
    [bbox.x + bbox.width, bbox.y],
    [bbox.x + bbox.width, bbox.y + bbox.height],
    [bbox.x, bbox.y + bbox.height]
  ].every(([x, y]) => {
    const rotatedX = centerX + ((x as number) - centerX) * cos - ((y as number) - centerY) * sin;
    const rotatedY = centerY + ((x as number) - centerX) * sin + ((y as number) - centerY) * cos;
    return rotatedX >= 0 && rotatedX <= 1 && rotatedY >= 0 && rotatedY <= 1;
  });
}

function normalizeLineIds(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
