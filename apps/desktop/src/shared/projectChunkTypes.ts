import type {
  CharacterProfile,
  DerivedImageAsset,
  DialogueLineV2,
  DictionaryTerm,
  PageImage,
  PageProcessingRecord,
  ProcessingRunRecord,
  SecretProjectSecurityV1,
  TranslationProjectV2
} from "./projectTypes.js";

export type PageSummaryStatus =
  | "pending"
  | "auto_approved"
  | "needs_review"
  | "rolled_back"
  | "skipped"
  | "failed"
  | "untranslated"
  | "draft"
  | "complete"
  | "review";

export type PageSummaryIndex = {
  pageNumber: number;
  pageImageId: string;
  dialogueCount: number;
  status: PageSummaryStatus;
  hasInpainting: boolean;
  hasTypesetting: boolean;
  updatedAt: string;
  chunkHash: string;
};

export type ProjectManifest = {
  schemaVersion: 2;
  metadata: TranslationProjectV2["metadata"];
  characters: CharacterProfile[];
  dictionaryTerms: DictionaryTerm[];
  pageImages: PageImage[];
  settings: TranslationProjectV2["settings"];
  pageIndex: PageSummaryIndex[];
  security?: SecretProjectSecurityV1;
};

export type PageChunk = {
  pageNumber: number;
  pageImageId: string;
  dialogueLines: DialogueLineV2[];
  pageProcessing?: PageProcessingRecord;
  runs: ProcessingRunRecord[];
  assets: DerivedImageAsset[];
};

export type ChunkedProjectSnapshot = {
  manifest: ProjectManifest;
  chunks: PageChunk[];
};

export type HydratedPageChunkDto = PageChunk & {
  chunkHash: string;
};

export type PageHydrationRequest = {
  projectSessionId: string;
  pageNumber: number;
  prefetchRadius?: number;
};

export type PageHydrationResult =
  | {
      ok: true;
      chunk: HydratedPageChunkDto;
      prefetchedPageNumbers: number[];
    }
  | {
      ok: false;
      message: string;
    };

export type ViewportCacheConfig = {
  maxCapacity: number;
  prefetchRadius: number;
};

export type ViewportHydrationPlan = {
  toHydrate: number[];
  toEvict: number[];
  retained: number[];
};
