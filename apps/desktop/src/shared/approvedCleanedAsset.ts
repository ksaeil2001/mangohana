import type {
  DerivedImageAsset,
  PageImage,
  PageProcessingRecord,
  ProcessingRunRecord,
  TranslationProjectV2
} from "./projectTypes.js";
import type { InpaintingQaStatus } from "./inpaintingQa.js";

export type ApprovedCleanedAssetInspection = {
  status: "missing" | "invalid_reference" | "qa_failed" | "valid";
  required: boolean;
  pageRecord?: PageProcessingRecord;
  approvedCleanedAssetId?: string;
  asset?: DerivedImageAsset;
  run?: ProcessingRunRecord;
  qaStatus?: InpaintingQaStatus;
};

/**
 * Resolves the page-owned cleaned asset without trusting the persisted pointer
 * by itself. This is deliberately pure so renderer and Main agree on the
 * asset graph before either one uses the derived image.
 */
export function inspectApprovedCleanedAsset(
  project: Pick<TranslationProjectV2, "processing">,
  pageImage: PageImage
): ApprovedCleanedAssetInspection {
  const pageRecord = project.processing.pages.find((page) => page.pageImageId === pageImage.id);
  const approvedCleanedAssetId = pageRecord?.approvedCleanedAssetId;
  const required = Boolean(approvedCleanedAssetId || pageRecord?.inpaintingQa);
  if (!approvedCleanedAssetId) {
    return {
      status: "missing",
      required,
      pageRecord,
      ...(pageRecord?.inpaintingQa?.qaStatus ? { qaStatus: pageRecord.inpaintingQa.qaStatus } : {})
    };
  }

  const asset = project.processing.assets.find((candidate) => candidate.assetId === approvedCleanedAssetId);
  const run = asset
    ? project.processing.runs.find((candidate) => candidate.runId === asset.runId)
    : undefined;
  const qaStatuses = [pageRecord?.inpaintingQa?.qaStatus, asset?.inpaintingQa?.qaStatus]
    .filter((status): status is InpaintingQaStatus => status !== undefined);
  const failedQaStatus = qaStatuses.find((status) => status !== "pass");

  if (
    !asset ||
    asset.role !== "cleaned" ||
    asset.sourcePageImageId !== pageImage.id ||
    asset.runId !== pageRecord?.latestCompletedRunId ||
    !run ||
    run.status !== "completed" ||
    run.pageImageId !== pageImage.id ||
    run.source !== asset.source ||
    run.sourceSha256 !== pageImage.sha256 ||
    (pageRecord.activeRunId !== undefined && pageRecord.activeRunId !== run.runId)
  ) {
    return {
      status: "invalid_reference",
      required: true,
      pageRecord,
      approvedCleanedAssetId,
      ...(asset ? { asset } : {}),
      ...(run ? { run } : {}),
      ...(failedQaStatus ? { qaStatus: failedQaStatus } : {})
    };
  }

  if (qaStatuses.length === 0 || failedQaStatus) {
    return {
      status: "qa_failed",
      required: true,
      pageRecord,
      approvedCleanedAssetId,
      asset,
      run,
      ...(failedQaStatus ? { qaStatus: failedQaStatus } : {})
    };
  }

  return {
    status: "valid",
    required: true,
    pageRecord,
    approvedCleanedAssetId,
    asset,
    run,
    qaStatus: "pass"
  };
}
