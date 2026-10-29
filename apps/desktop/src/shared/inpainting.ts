import type {
  DerivedImageAsset,
  EditableTranslationProject,
  PageImage,
  PageProcessingRecord,
  ProcessingRunRecord,
  TranslationProjectV2
} from "./projectTypes.js";
import type { ProjectSaveResult } from "./projectSessionTypes.js";

export const inpaintingModes = ["speech-bubble", "caption-box", "background-text"] as const;
export const inpaintingProviders = ["openai", "gemini", "local-lama", "local-aot", "sd-webui", "comfyui"] as const;

export type InpaintingMode = (typeof inpaintingModes)[number];
export type InpaintingProvider = (typeof inpaintingProviders)[number];

export type InpaintExecutionRequest = {
  imageBytes: Buffer;
  maskBytes: Buffer;
  mode: InpaintingMode;
  sourceMimeType: string;
  promptOverride?: string;
  signal?: AbortSignal;
  endpoint?: string;
  options?: {
    dilatePixels?: number;
    useGpu?: boolean;
    timeoutMs?: number;
    conservative?: boolean;
    skipOnLowConfidence?: boolean;
  };
};

export type InpaintExecutionResult = {
  editedImageBytes: Buffer;
  provider: InpaintingProvider;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

export type InpaintPageImageRequest = {
  requestId: string;
  projectFilePath: string;
  pageImage: PageImage;
  maskPngBase64: string;
  mode: InpaintingMode;
  provider?: InpaintingProvider;
  promptOverride?: string;
  options?: {
    conservative?: boolean;
    skipOnLowConfidence?: boolean;
    dilatePixels?: number;
  };
};

export type InpaintPageImageSessionRequest = {
  requestId: string;
  projectSessionId: string;
  pageImageId: string;
  maskPngBase64: string;
  mode: InpaintingMode;
  provider?: InpaintingProvider;
  promptOverride?: string;
  options?: {
    conservative?: boolean;
    skipOnLowConfidence?: boolean;
    dilatePixels?: number;
  };
};

export type InpaintPageImageResult = {
  pageImage: PageImage;
  run: ProcessingRunRecord;
  asset: DerivedImageAsset;
  maskAsset?: DerivedImageAsset;
  sessionResult?: ProjectSaveResult;
};

export function pageImageFromInpaintingResult(result: PageImage | InpaintPageImageResult): PageImage {
  return "pageImage" in result ? result.pageImage : result;
}

export function isInpaintPageImageResult(
  result: PageImage | InpaintPageImageResult
): result is InpaintPageImageResult {
  return "pageImage" in result && "run" in result && "asset" in result;
}

export function createApprovedInpaintingPageRecord(
  result: InpaintPageImageResult,
  existing?: PageProcessingRecord
): PageProcessingRecord {
  const { activeRunId: _activeRunId, userReviewedCleanedAssetId: _userReviewedCleanedAssetId, ...preserved } = existing ?? {
    pageImageId: result.run.pageImageId,
    finalStatus: "pending" as const,
    updatedAt: result.asset.createdAt
  };
  const qa = result.asset.inpaintingQa;
  const finalStatus =
    qa && qa.qaStatus === "manual_review" ? "needs_review" : "auto_approved";

  return {
    ...preserved,
    pageImageId: result.run.pageImageId,
    latestCompletedRunId: result.run.runId,
    approvedCleanedAssetId: result.asset.assetId,
    ...(result.maskAsset ? { approvedMaskAssetId: result.maskAsset.assetId } : {}),
    finalStatus,
    updatedAt: result.asset.createdAt,
    ...(qa ? { inpaintingQa: qa } : {})
  };
}

export function applyApprovedInpaintingResult(
  project: EditableTranslationProject,
  result: InpaintPageImageResult
): EditableTranslationProject;
export function applyApprovedInpaintingResult(
  project: TranslationProjectV2,
  result: InpaintPageImageResult
): TranslationProjectV2;
export function applyApprovedInpaintingResult(
  project: TranslationProjectV2 | EditableTranslationProject,
  result: InpaintPageImageResult
): TranslationProjectV2 | EditableTranslationProject {
  const existingPage = project.processing.pages.find(
    (page) => page.pageImageId === result.run.pageImageId
  );
  let updatedAssets = upsertBy(project.processing.assets, result.asset, "assetId");
  if (result.maskAsset) {
    updatedAssets = upsertBy(updatedAssets, result.maskAsset, "assetId");
  }

  return {
    ...project,
    processing: {
      runs: upsertBy(project.processing.runs, result.run, "runId"),
      assets: updatedAssets,
      pages: upsertBy(
        project.processing.pages,
        createApprovedInpaintingPageRecord(result, existingPage),
        "pageImageId"
      )
    }
  };
}

function upsertBy<T, K extends keyof T>(items: T[], value: T, key: K): T[] {
  const index = items.findIndex((item) => item[key] === value[key]);
  if (index < 0) return [...items, value];
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}

export const inpaintingModeLabels: Record<InpaintingMode, string> = {
  "speech-bubble": "말풍선",
  "caption-box": "캡션 박스",
  "background-text": "배경 글자"
};

export const inpaintingModePrompts: Record<InpaintingMode, string> = {
  "speech-bubble":
    "Remove only the source text inside the speech bubble. Preserve the speech bubble outline, tail, fill color, screentone, shadows, and surrounding artwork. Do not add any new letters, symbols, captions, or decorative marks.",
  "caption-box":
    "Remove only the source text inside the caption or narration box. Preserve the rectangular box edges, fill color, screentone, texture, and surrounding artwork. Do not add any new letters, symbols, captions, or decorative marks.",
  "background-text":
    "Remove the selected source text and reconstruct the underlying background, linework, texture, gradients, clothing, scenery, or character art. Do not add any new letters, symbols, captions, or decorative marks."
};

export function isInpaintingMode(value: unknown): value is InpaintingMode {
  return typeof value === "string" && (inpaintingModes as readonly string[]).includes(value);
}

export function isInpaintingProvider(value: unknown): value is InpaintingProvider {
  return typeof value === "string" && (inpaintingProviders as readonly string[]).includes(value);
}

export function buildInpaintingPrompt(mode: InpaintingMode, promptOverride?: string): string {
  const basePrompt = inpaintingModePrompts[mode];
  const trimmedOverride = promptOverride?.trim();
  return trimmedOverride ? `${basePrompt}\n\nAdditional user instruction: ${trimmedOverride}` : basePrompt;
}
