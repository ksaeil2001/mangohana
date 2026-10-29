import { describe, expect, it } from "vitest";
import { buildRenderReadinessReport } from "../../src/shared/renderReadiness";
import type { DialogueLine } from "../../src/shared/projectTypes";

function line(overrides: Partial<DialogueLine> = {}): DialogueLine {
  return {
    id: "line-1",
    order: 1,
    pageNumber: 1,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "原文",
    userTranslation: "번역",
    parseConfidence: 1,
    parseWarnings: [],
    typesetting: {
      bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
      writingMode: "horizontal-tb"
    },
    ...overrides
  };
}

describe("render readiness", () => {
  it("is ready only with user translation, valid geometry, font evidence and matching revision", () => {
    const report = buildRenderReadinessReport({
      pageImageId: "page-1",
      revision: 3,
      resultRevision: 3,
      lines: [line()],
      font: { identity: "Pretendard@1", resourceAvailable: true, metricsCalculated: true, glyphCoverageVerified: true }
    });
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.userTranslationFingerprint).toEqual(expect.any(String));
  });

  it("blocks AI-only text and unsafe output conditions", () => {
    const report = buildRenderReadinessReport({
      pageImageId: "page-1",
      revision: 4,
      resultRevision: 3,
      lines: [line({ userTranslation: undefined, aiTranslation: "AI 초안" })],
      approvedCleanedAssetId: "asset-1",
      cleanedAssetQaStatus: "manual_review",
      safeAreaProvisionalLineIds: ["line-1"],
      missingGlyphLineIds: ["line-1"],
      overflowLineIds: ["line-1"],
      font: { identity: "Pretendard@1", resourceAvailable: false, metricsCalculated: false, glyphCoverageVerified: false }
    });
    expect(report.ready).toBe(false);
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "ai_only_translation",
      "provisional_safe_area",
      "missing_glyph",
      "text_overflow",
      "font_resource_missing",
      "font_metrics_unavailable",
      "cleaned_asset_qa_failed",
      "stale_result"
    ]));
  });

  it("requires approval when a cleaned asset is explicitly required", () => {
    const report = buildRenderReadinessReport({
      pageImageId: "page-1",
      revision: 1,
      resultRevision: 1,
      lines: [line()],
      cleanedAssetRequired: true,
      font: { identity: "Pretendard@1", resourceAvailable: true, metricsCalculated: true, glyphCoverageVerified: true }
    });
    expect(report.blockers.map((blocker) => blocker.code)).toContain("cleaned_asset_not_approved");
  });
});
