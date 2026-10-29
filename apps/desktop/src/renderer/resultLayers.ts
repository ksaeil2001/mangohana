import type {
  DerivedImageAsset,
  PageImage,
  PageProcessingRecord,
  ProcessingRunRecord,
  ProcessingState
} from "../shared/projectTypes";
import type { ResultLayer } from "./trioState";

export const RESULT_LAYER_STATUSES = [
  "missing",
  "processing",
  "ready",
  "stale",
  "partial-failure",
  "render-failed"
] as const;

export type ResultLayerStatus = (typeof RESULT_LAYER_STATUSES)[number];

import type { InpaintingQaResult } from "../shared/inpaintingQa.js";

export type ResultLayerDescriptor = {
  layer: ResultLayer;
  image: PageImage | null;
  status: ResultLayerStatus;
  message: string;
  fallbackImage?: PageImage | null;
  retryable?: boolean;
  renderFailed?: boolean;
  processing?: boolean;
  stale?: boolean;
  partialFailure?: boolean;
  asset?: DerivedImageAsset | null;
  inpaintingQa?: InpaintingQaResult;
};

export type ResultLayerStatusInput = {
  layer: ResultLayer;
  image?: PageImage | null;
  sourceImage?: PageImage | null;
  sourceSha256?: string;
  processing?: boolean;
  partialFailure?: boolean;
  totalFailure?: boolean;
  renderFailed?: boolean;
  fallbackImage?: PageImage | null;
  message?: string;
};

const DEFAULT_MESSAGES: Record<ResultLayerStatus, string> = {
  missing: "이 결과가 아직 생성되지 않았습니다.",
  processing: "결과 처리 중입니다.",
  ready: "결과를 표시하고 있습니다.",
  stale: "이 결과는 이전 원본을 기준으로 생성되었습니다.",
  "partial-failure": "일부 영역만 처리되었습니다. 처리되지 않은 영역을 확인하세요.",
  "render-failed": "결과를 표시하지 못해 원본으로 전환했습니다. 다시 시도할 수 있습니다."
};

export type ApprovedResultAssetResolution = {
  asset: DerivedImageAsset | null;
  run: ProcessingRunRecord | null;
  invalidReference: boolean;
};

export function resolveApprovedResultAsset(args: {
  processing?: ProcessingState;
  pageRecord?: PageProcessingRecord;
  sourceImage?: PageImage | null;
  layer: Exclude<ResultLayer, "original">;
}): ApprovedResultAssetResolution {
  const sourceImage = args.sourceImage ?? null;
  const approvedAssetId = args.layer === "inpainted"
    ? args.pageRecord?.approvedCleanedAssetId
    : args.pageRecord?.approvedTranslatedAssetId;
  if (!approvedAssetId) {
    return { asset: null, run: null, invalidReference: false };
  }

  const processing = args.processing;
  const pageRecord = args.pageRecord;
  const expectedRole = args.layer === "inpainted" ? "cleaned" : "translated";
  const asset = processing?.assets.find((candidate) => candidate.assetId === approvedAssetId) ?? null;
  const run = asset && processing
    ? processing.runs.find((candidate) => candidate.runId === asset.runId) ?? null
    : null;
  const valid = Boolean(
    sourceImage &&
      pageRecord &&
      pageRecord.pageImageId === sourceImage.id &&
      asset &&
      asset.role === expectedRole &&
      asset.sourcePageImageId === sourceImage.id &&
      run &&
      run.pageImageId === sourceImage.id &&
      asset.source === run.source
  );

  return valid
    ? { asset, run, invalidReference: false }
    : { asset: null, run: null, invalidReference: true };
}

export function getResultLayerStatus(input: ResultLayerStatusInput): ResultLayerDescriptor {
  const image = input.image ?? null;
  const fallbackImage = input.fallbackImage ?? input.sourceImage ?? null;
  const stale = Boolean(
    image &&
      input.sourceSha256 &&
      input.sourceImage?.sha256 &&
      input.sourceSha256 !== input.sourceImage.sha256
  );
  const processing = Boolean(input.processing);
  const partialFailure = Boolean(input.partialFailure);

  if (input.renderFailed) {
    return describeResultLayer({
      layer: input.layer,
      image,
      status: "render-failed",
      fallbackImage,
      retryable: true,
      renderFailed: true,
      processing,
      stale,
      partialFailure,
      message: input.message ?? createCompoundStatusMessage({
        status: "render-failed",
        processing,
        stale,
        partialFailure
      })
    });
  }

  if (!image) {
    return describeResultLayer({
      layer: input.layer,
      image: null,
      status: processing ? "processing" : "missing",
      fallbackImage,
      processing,
      stale,
      partialFailure,
      message: input.message ?? createCompoundStatusMessage({
        status: processing ? "processing" : "missing",
        processing,
        stale,
        partialFailure
      })
    });
  }

  if (partialFailure) {
    return describeResultLayer({
      layer: input.layer,
      image,
      status: "partial-failure",
      fallbackImage,
      processing,
      stale,
      partialFailure,
      message: input.message ?? createCompoundStatusMessage({
        status: "partial-failure",
        processing,
        stale,
        partialFailure
      })
    });
  }

  if (stale) {
    return describeResultLayer({
      layer: input.layer,
      image,
      status: "stale",
      fallbackImage,
      processing,
      stale,
      partialFailure,
      message: input.message ?? createCompoundStatusMessage({
        status: "stale",
        processing,
        stale,
        partialFailure
      })
    });
  }

  if (processing) {
    return describeResultLayer({
      layer: input.layer,
      image,
      status: "processing",
      fallbackImage,
      processing,
      stale,
      partialFailure,
      message: input.message ?? createCompoundStatusMessage({
        status: "processing",
        processing,
        stale,
        partialFailure
      })
    });
  }

  return describeResultLayer({
    layer: input.layer,
    image,
    status: "ready",
    fallbackImage,
    processing,
    stale,
    partialFailure,
    message: input.message ?? createCompoundStatusMessage({
      status: "ready",
      processing,
      stale,
      partialFailure
    })
  });
}

export function describeResultLayer(
  descriptor: ResultLayerDescriptor
): ResultLayerDescriptor {
  const status = descriptor.renderFailed ? "render-failed" : descriptor.status;
  return {
    ...descriptor,
    status,
    image: descriptor.image ?? null,
    message: descriptor.renderFailed
      ? DEFAULT_MESSAGES["render-failed"]
      : descriptor.message || createCompoundStatusMessage({
          status,
          processing: descriptor.processing,
          stale: descriptor.stale,
          partialFailure: descriptor.partialFailure
        }),
    fallbackImage: descriptor.fallbackImage ?? null,
    retryable: descriptor.retryable ?? status === "render-failed",
    renderFailed: descriptor.renderFailed ?? status === "render-failed"
  };
}

function createCompoundStatusMessage(args: {
  status: ResultLayerStatus;
  processing?: boolean;
  stale?: boolean;
  partialFailure?: boolean;
}): string {
  const messages: string[] = [];
  if (args.processing) messages.push(DEFAULT_MESSAGES.processing);
  if (args.stale) messages.push(DEFAULT_MESSAGES.stale);
  if (args.partialFailure) messages.push(DEFAULT_MESSAGES["partial-failure"]);
  return messages.join(" ") || DEFAULT_MESSAGES[args.status];
}

export function createOriginalResultLayer(image: PageImage | null): ResultLayerDescriptor {
  return describeResultLayer({
    layer: "original",
    image,
    status: image ? "ready" : "missing",
    message: image ? DEFAULT_MESSAGES.ready : "현재 페이지의 원본 이미지가 없습니다."
  });
}

export function createMissingResultLayer(
  layer: Exclude<ResultLayer, "original">,
  message = DEFAULT_MESSAGES.missing,
  fallbackImage: PageImage | null = null,
  options: Pick<ResultLayerStatusInput, "processing" | "partialFailure"> = {}
): ResultLayerDescriptor {
  return describeResultLayer({
    layer,
    image: null,
    status: options.processing ? "processing" : "missing",
    message,
    fallbackImage,
    processing: options.processing,
    partialFailure: options.partialFailure
  });
}
