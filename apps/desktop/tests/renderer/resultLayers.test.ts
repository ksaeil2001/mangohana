import { describe, expect, it } from "vitest";
import type {
  DerivedImageAsset,
  PageImage,
  PageProcessingRecord,
  ProcessingRunRecord,
  ProcessingState
} from "../../src/shared/projectTypes";
import {
  RESULT_LAYER_STATUSES,
  describeResultLayer,
  getResultLayerStatus,
  resolveApprovedResultAsset,
  type ResultLayerDescriptor
} from "../../src/renderer/resultLayers";

const original: PageImage = {
  id: "page-original",
  pageNumber: 1,
  storedRelativePath: "/pages/original.png",
  originalFileName: "original.png",
  sha256: "source-hash",
  byteSize: 100,
  mimeType: "image/png",
  copiedAt: "2026-08-03T00:00:00.000Z"
};

function descriptor(overrides: Partial<ResultLayerDescriptor> = {}): ResultLayerDescriptor {
  return {
    layer: "inpainted",
    image: null,
    status: "missing",
    message: "인페인팅 결과가 아직 없습니다.",
    ...overrides
  };
}

describe("TRIO result layer contract", () => {
  it("enumerates the UI03 result statuses", () => {
    expect(RESULT_LAYER_STATUSES).toEqual([
      "missing",
      "processing",
      "ready",
      "stale",
      "partial-failure",
      "render-failed"
    ]);
  });

  it("keeps a previous result visible while processing a newer request", () => {
    const result = getResultLayerStatus({
      layer: "inpainted",
      image: { ...original, id: "inpainted-1" },
      processing: true,
      sourceImage: original
    });

    expect(result.status).toBe("processing");
    expect(result.image?.id).toBe("inpainted-1");
    expect(result.message).toContain("처리 중");
  });

  it("marks an approved result stale when its source hash is no longer current", () => {
    const result = getResultLayerStatus({
      layer: "translated",
      image: { ...original, id: "translated-1" },
      sourceImage: original,
      sourceSha256: "old-source-hash"
    });

    expect(result.status).toBe("stale");
    expect(result.image?.id).toBe("translated-1");
  });

  it("distinguishes partial failure from a total failure", () => {
    expect(
      getResultLayerStatus({
        ...descriptor(),
        layer: "inpainted",
        image: { ...original, id: "partial" },
        partialFailure: true,
        sourceImage: original
      }).status
    ).toBe("partial-failure");

    expect(
      getResultLayerStatus({
        ...descriptor(),
        layer: "inpainted",
        image: null,
        totalFailure: true,
        sourceImage: original
      }).status
    ).toBe("missing");
  });

  it("keeps overlapping stale, processing, and partial-failure facts", () => {
    const result = getResultLayerStatus({
      layer: "inpainted",
      image: { ...original, id: "inpainted-1" },
      sourceImage: original,
      sourceSha256: "old-source-hash",
      processing: true,
      partialFailure: true
    });

    expect(result.status).toBe("partial-failure");
    expect(result.processing).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.partialFailure).toBe(true);
    expect(result.message).toContain("처리 중");
    expect(result.message).toContain("이전 원본");
  });

  it("resolves an approved result only when its asset and run graph matches the current source", () => {
    const pageRecord: PageProcessingRecord = {
      pageImageId: original.id,
      latestCompletedRunId: "run-1",
      approvedCleanedAssetId: "asset-1",
      finalStatus: "auto_approved",
      updatedAt: "2026-08-03T00:00:00.000Z"
    };
    const run: ProcessingRunRecord = {
      runId: "run-1",
      pageImageId: original.id,
      source: "manual_openai",
      status: "completed",
      sourceSha256: original.sha256,
      appVersion: "0.1.0",
      queuedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:00.000Z"
    };
    const asset: DerivedImageAsset = {
      assetId: "asset-1",
      source: "manual_openai",
      sourcePageImageId: original.id,
      runId: run.runId,
      role: "cleaned",
      storedRelativePath: "Book-assets/images/page-001-cleaned.png",
      sha256: "b".repeat(64),
      byteSize: 10,
      mimeType: "image/png",
      createdAt: "2026-08-03T00:00:00.000Z"
    };
    const processing: ProcessingState = {
      pages: [pageRecord],
      runs: [run],
      assets: [asset]
    };

    const resolved = resolveApprovedResultAsset({
      processing,
      pageRecord,
      sourceImage: original,
      layer: "inpainted"
    });
    expect(resolved.asset?.assetId).toBe(asset.assetId);
    expect(resolved.run?.runId).toBe(run.runId);
    expect(resolved.invalidReference).toBe(false);

    const invalid = resolveApprovedResultAsset({
      processing: {
        ...processing,
        assets: [{ ...asset, role: "translated" }]
      },
      pageRecord,
      sourceImage: original,
      layer: "inpainted"
    });
    expect(invalid.asset).toBeNull();
    expect(invalid.run).toBeNull();
    expect(invalid.invalidReference).toBe(true);

    const translatedPageRecord: PageProcessingRecord = {
      ...pageRecord,
      approvedCleanedAssetId: undefined,
      approvedTranslatedAssetId: "translated-asset"
    };
    const translatedAsset: DerivedImageAsset = {
      ...asset,
      assetId: "translated-asset",
      role: "translated"
    };
    const translatedProcessing: ProcessingState = {
      pages: [translatedPageRecord],
      runs: [run],
      assets: [translatedAsset]
    };
    const translated = resolveApprovedResultAsset({
      processing: translatedProcessing,
      pageRecord: translatedPageRecord,
      sourceImage: original,
      layer: "translated"
    });
    expect(translated.asset?.assetId).toBe(translatedAsset.assetId);
    expect(translated.invalidReference).toBe(false);

    const wrongSource = resolveApprovedResultAsset({
      processing: {
        ...processing,
        assets: [{ ...asset, sourcePageImageId: "other-page" }]
      },
      pageRecord,
      sourceImage: original,
      layer: "inpainted"
    });
    expect(wrongSource.asset).toBeNull();
    expect(wrongSource.invalidReference).toBe(true);

    const missingRun = resolveApprovedResultAsset({
      processing: {
        ...processing,
        assets: [{ ...asset, runId: "missing-run" }]
      },
      pageRecord,
      sourceImage: original,
      layer: "inpainted"
    });
    expect(missingRun.asset).toBeNull();
    expect(missingRun.invalidReference).toBe(true);

    const wrongRunPage = resolveApprovedResultAsset({
      processing: {
        ...processing,
        runs: [{ ...run, pageImageId: "other-page" }]
      },
      pageRecord,
      sourceImage: original,
      layer: "inpainted"
    });
    expect(wrongRunPage.asset).toBeNull();
    expect(wrongRunPage.invalidReference).toBe(true);
  });

  it("rejects an approved result when the asset source differs from the run source", () => {
    const pageRecord: PageProcessingRecord = {
      pageImageId: original.id,
      approvedCleanedAssetId: "asset-1",
      finalStatus: "auto_approved",
      updatedAt: "2026-08-03T00:00:00.000Z"
    };
    const run: ProcessingRunRecord = {
      runId: "run-1",
      pageImageId: original.id,
      source: "manual_openai",
      status: "completed",
      sourceSha256: original.sha256,
      appVersion: "0.1.0",
      queuedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:00.000Z"
    };
    const asset: DerivedImageAsset = {
      assetId: "asset-1",
      source: "manual_gemini",
      sourcePageImageId: original.id,
      runId: run.runId,
      role: "cleaned",
      storedRelativePath: "Book-assets/images/page-001-cleaned.png",
      sha256: "b".repeat(64),
      byteSize: 10,
      mimeType: "image/png",
      createdAt: "2026-08-03T00:00:00.000Z"
    };

    const result = resolveApprovedResultAsset({
      processing: { pages: [pageRecord], runs: [run], assets: [asset] },
      pageRecord,
      sourceImage: original,
      layer: "inpainted"
    });

    expect(result.asset).toBeNull();
    expect(result.run).toBeNull();
    expect(result.invalidReference).toBe(true);
  });

  it("falls back to original without losing the selected result context", () => {
    const failed = describeResultLayer({
      ...descriptor(),
      layer: "translated",
      image: { ...original, id: "translated-1" },
      renderFailed: true,
      fallbackImage: original
    });

    expect(failed.status).toBe("render-failed");
    expect(failed.image?.id).toBe("translated-1");
    expect(failed.fallbackImage?.id).toBe(original.id);
    expect(failed.message).toContain("원본");
  });
});
