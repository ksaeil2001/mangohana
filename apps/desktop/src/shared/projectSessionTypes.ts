import type { ProjectMutation } from "./projectChanges.js";
import type { TranslationProjectV2 } from "./projectTypes.js";

export type TranslationProjectDto = {
  revision: number;
  project: TranslationProjectV2;
  pendingPageImages: PendingPageImageDto[];
  dirty: boolean;
  status: "active" | "needs_recovery" | "closing";
};

export type PreparedPageImageDto = {
  preparedImageId: string;
  importBatchId: string;
  originalFileName: string;
  byteSize: number;
  mimeType: string;
  previewToken: string;
};

export type PreparedPageImageBatchDto = {
  importBatchId: string;
  images: PreparedPageImageDto[];
};

export type PendingPageImageDto = {
  importBatchId: string;
  preparedImageId: string;
  pageImageId: string;
  pageNumber: number;
  originalFileName: string;
  byteSize: number;
  mimeType: string;
  previewToken: string;
};

export type PageImageImportResult =
  | { ok: true; pendingPageImage: PendingPageImageDto }
  | { ok: false; preparedImageId: string; message: string };

export type PendingPageImageImportJournalV1 = {
  schemaVersion: 1;
  projectSessionId: string;
  targetProjectPath: string;
  preparedPageImages: Array<
    PreparedPageImageDto & {
      temporaryFilePath: string;
    }
  >;
  pendingPageImageLinks: PendingPageImageDto[];
  createdAt: string;
  updatedAt: string;
};

export type SaveTransactionStage =
  | "preparing"
  | "assets_staged"
  | "candidate_validated"
  | "project_replaced"
  | "committed";

export type SaveTransactionJournalV1 = {
  schemaVersion: 1;
  transactionId: string;
  projectSessionId: string;
  targetProjectPath: string;
  candidateProjectPath: string;
  backupProjectPath?: string;
  stage: SaveTransactionStage;
  promotedAssets: Array<{
    sourceTemporaryPath: string;
    finalRelativePath: string;
    sha256: string;
    byteSize: number;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSessionResult = {
  projectSessionId: string;
  project: TranslationProjectDto;
  encrypted: boolean;
  recentProject?: {
    recentProjectId: string;
    title: string;
    openedAt: string;
  };
};

export type ProjectPasswordRequiredResult = {
  unlockToken: string;
  encrypted: true;
  passwordRequired: true;
};

export type ProjectOpenFailureCode =
  | "RECENT_NOT_FOUND"
  | "PROJECT_FILE_NOT_FOUND"
  | "INVALID_PASSWORD"
  | "PROJECT_BUSY"
  | "PERMISSION_DENIED"
  | "RECOVERY_FAILED"
  | "OPEN_FAILED";

export type ProjectOpenFailureResult = {
  openFailed: true;
  code: ProjectOpenFailureCode;
  retryable: boolean;
  message: string;
};

export type ApplyProjectMutationArgs = {
  projectSessionId: string;
  baseRevision: number;
  mutation: ProjectMutation;
};

/** Captured at the user's click; Main must reject a changed revision without retry. */
export type ReviewCleanedAssetArgs = {
  projectSessionId: string;
  pageImageId: string;
  cleanedAssetId: string;
  expectedRevision: number;
};

export type ProjectChangeResult =
  | {
      status: "applied";
      revision: number;
      project: TranslationProjectDto;
    }
  | {
      status: "revision_conflict";
      code: "REVISION_CONFLICT";
      revision: number;
      project: TranslationProjectDto;
      conflictingPaths: string[];
    };

export type ProjectSaveResult = {
  projectSessionId: string;
  project: TranslationProjectDto;
  recentProject?: {
    recentProjectId: string;
    title: string;
    openedAt: string;
  };
  staleLineIds?: string[];
  appliedDialogueUpdates?: Array<{
    id: string;
    appliedTranslation: boolean;
    appliedTypesetting: boolean;
  }>;
};
