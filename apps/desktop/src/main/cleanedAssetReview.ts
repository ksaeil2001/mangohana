import { inspectApprovedCleanedAsset } from "../shared/approvedCleanedAsset.js";
import type { TranslationProjectV2 } from "../shared/projectTypes.js";
import { readVerifiedProjectAsset } from "./projectAssetRead.js";

/** Both review and each cleaned-based export validate the bytes they actually use. */
export async function readVerifiedCleanedAsset(args: {
  project: TranslationProjectV2;
  projectFilePath: string;
  pageImageId: string;
  requireUserReview?: boolean;
}): Promise<Buffer> {
  const page = args.project.pageImages.find((candidate) => candidate.id === args.pageImageId);
  if (!page) throw new Error("CLEANED_ASSET_PAGE_MISSING");
  const inspection = inspectApprovedCleanedAsset(args.project, page);
  if (inspection.status !== "valid" || !inspection.asset) {
    throw new Error(`CLEANED_ASSET_INVALID: ${inspection.status}`);
  }
  if (args.requireUserReview !== false && inspection.pageRecord?.userReviewedCleanedAssetId !== inspection.asset.assetId) {
    throw new Error("CLEANED_ASSET_NOT_USER_REVIEWED");
  }

  const readArgs = { projectFilePath: args.projectFilePath, errorPrefix: "CLEANED_ASSET" as const };
  await readVerifiedProjectAsset({ ...readArgs, image: page });
  return readVerifiedProjectAsset({ ...readArgs, image: inspection.asset });
}
