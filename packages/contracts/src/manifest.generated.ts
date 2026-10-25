/* Generated from application-owned schemas by npm run contracts:generate. Do not edit. */

/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "version".
 */
export type Version = string;
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "time".
 */
export type Time = string;
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "counter".
 */
export type Counter = string;
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "positivePixels".
 */
export type PositivePixels = number;
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "decimal".
 */
export type Decimal = string;
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "digest".
 */
export type Digest = string;
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "reason".
 */
export type Reason =
  | "NONE"
  | "AUTH_REQUIRED"
  | "ACCESS_DENIED"
  | "OWNER_CHANGED"
  | "REVISION_CONFLICT"
  | "INTENT_CONFLICT"
  | "SLOT_OCCUPIED"
  | "ACTIVE_WORK"
  | "EXECUTION_UNKNOWN"
  | "COST_UNCONFIRMED"
  | "COST_BOUND_UNCONFIRMED"
  | "PROVIDER_LIMIT_WAIT"
  | "MODEL_CONTRACT_UNAVAILABLE"
  | "INPUT_INVALID"
  | "LIMIT_PROFILE_UNCONFIRMED"
  | "BATCH_CAPACITY_EXCEEDED"
  | "DUPLICATE_CHOICE_REQUIRED"
  | "DRAFT_UNACKNOWLEDGED"
  | "SNAPSHOT_STALE"
  | "CAPTURE_EXPIRED"
  | "FILE_INVALID"
  | "FILE_ACCESS_UNCONFIRMED"
  | "CHECKPOINT_REUSE_UNAVAILABLE"
  | "DELIVERY_EXPIRED"
  | "STORAGE_FAILED"
  | "RENDER_FAILED"
  | "PROOF_UNCONFIRMED"
  | "CLOCK_UNCONFIRMED"
  | "DEPENDENCY_UNAVAILABLE";

export interface ProjectManifest {
  format: "trio.manga-project";
  schemaVersion: 1;
  issuer: Version;
  keyId: Version;
  algorithm: "Ed25519";
  exportId: Id;
  createdAt: Time;
  creatorAccountId: Id;
  projectLineageId: Id;
  snapshotRevision: Counter;
  projectStatus: "IN_PROGRESS" | "COMPLETED";
  settings: Settings | null;
  /**
   * @minItems 0
   */
  pages: Page[];
  /**
   * @minItems 0
   */
  assets: Asset[];
  /**
   * @minItems 0
   */
  unsettledReferences: {
    executionId: Id;
    costItemId: Id | null;
    pageLineageId: Id;
    originRequestId: Id;
    completionKind: "NORMAL_COMPLETED" | "OTHER";
  }[];
  /**
   * @minItems 0
   */
  optionalCheckpoints: Checkpoint[];
  fonts: FontProvenance[];
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "settings".
 */
export interface Settings {
  settingsVersion: Counter;
  contractVersion: Version;
  sourceLanguage: "ja" | "zh-Hans" | "en";
  targetLanguage: "ko" | "en" | "ja";
  modelId: Version;
  reasoningLevel: "LOW" | "MEDIUM" | "HIGH";
  fontAssetId: Id;
  baseFontSizePx: PositivePixels;
  minFontSizePx: PositivePixels;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "page".
 */
export interface Page {
  pageLineageId: Id;
  originalAssetId: Id;
  widthPx: number;
  heightPx: number;
  skip: boolean;
  resultRevision: Counter;
  cleanedAssetId: Id | null;
  renderAssetId: Id | null;
  /**
   * @minItems 0
   */
  blocks: Block[];
  paidCumulativeBaselineCredit: Decimal;
  /**
   * @minItems 0
   */
  baselineContributionIds: Id[];
  geometryContract: Version;
  renderContract: Version;
  cleanupQa: "NOT_RUN" | "NEEDS_REVIEW" | "PASSED" | "FAILED";
  displayName: string;
  paidCumulativeBaselineState: "CONFIRMED" | "UNCONFIRMED";
  renderSpecification?: RenderSpecification | null;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "block".
 */
export interface Block {
  regionId: Id;
  geometry: Geometry;
  sourceText: TextValue;
  translatedText: TextValue;
  fontAssetId: Id;
  fontSizePx: PositivePixels;
  appliedTranslation: AppliedTranslation | null;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "geometry".
 */
export interface Geometry {
  /**
   * @minItems 3
   */
  polygon: [Point, Point, Point, ...Point[]];
  angleDegrees: number;
  readingOrder: number;
  orientation: "HORIZONTAL" | "VERTICAL";
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "point".
 */
export interface Point {
  x: number;
  y: number;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "textValue".
 */
export interface TextValue {
  value: string;
  status: "AI_PROPOSED" | "USER_MODIFIED" | "USER_CONFIRMED";
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "appliedTranslation".
 */
export interface AppliedTranslation {
  sourceLanguage: "ja" | "zh-Hans" | "en";
  targetLanguage: "ko" | "en" | "ja";
  modelId: Version;
  reasoningLevel: "LOW" | "MEDIUM" | "HIGH";
  modelContract: Version;
  promptContract: Version;
  originExecutionId: Id | null;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "renderSpecification".
 */
export interface RenderSpecification {
  version: 1;
  fontCatalogVersion: Version;
  blocks: {
    regionId: Id;
    minimumFontSizePx: PositivePixels;
    sizing: "AUTO_FIT" | "EXACT";
    rendererVersion?: "pango-canonical-v1" | "pango-overflow-v2" | "pango-balloon-v3";
    typesetBox?: TypesetBox;
    targetOrientation?: "HORIZONTAL" | "VERTICAL";
  }[];
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "typesetBox".
 */
export interface TypesetBox {
  left: number;
  top: number;
  width: PositivePixels;
  height: PositivePixels;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "asset".
 */
export interface Asset {
  assetId: Id;
  entry: string;
  purpose: "ORIGINAL" | "CLEANED" | "RENDER" | "FONT" | "LICENSE" | "CHECKPOINT";
  mediaType: "image/png" | "image/jpeg" | "font/otf" | "font/ttf" | "text/plain" | "application/octet-stream";
  bytesLength: Counter;
  sha256: Digest;
  requiredFor: "EDIT" | "CHECKPOINT";
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "checkpoint".
 */
export interface Checkpoint {
  checkpointId: Id;
  originRequestId: Id;
  originExecutionId: Id;
  logicalStepId: Version;
  stageContract: Version;
  modelContract: Version | null;
  inputDigest: Digest;
  dependencyDigest: Digest;
  /**
   * @minItems 0
   */
  assetIds: Id[];
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "fontProvenance".
 */
export interface FontProvenance {
  fontAssetId: Id;
  family: string;
  fontVersion: Version;
  fontCatalogVersion: Version;
  licenseAssetId: Id;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "ownedTarget".
 */
export interface OwnedTarget {
  contextId: Id;
  contextGeneration: Counter;
  tabId: Id;
  expectedOwnerRevision: Counter;
  expectedWorkspaceRevision: Counter;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "workspaceCommand".
 */
export interface WorkspaceCommand {
  commandId: Id;
  intentVersion: 1;
  target: OwnedTarget;
  operation:
    | {
        kind: "PATCH_SETTINGS";
        payload: {
          settings: Settings;
        };
      }
    | {
        kind: "COMMIT_UPLOAD";
        payload: {
          uploadId: Id;
          /**
           * @minItems 0
           */
          candidateIdsInOrder: Id[];
          /**
           * @minItems 0
           */
          explicitDuplicateIds: Id[];
          previewRevision: Counter;
        };
      }
    | {
        kind: "EXCLUDE_PAGES";
        payload: {
          /**
           * @minItems 1
           */
          pageIds: [Id, ...Id[]];
        };
      }
    | {
        kind: "SET_SKIP";
        payload: {
          /**
           * @minItems 1
           */
          pageIds: [Id, ...Id[]];
          skip: boolean;
        };
      }
    | {
        kind: "REORDER_PAGES";
        payload: {
          /**
           * @minItems 0
           */
          pageIdsInOrder: Id[];
        };
      }
    | {
        kind: "REQUEST_TRANSLATION";
        payload: {
          pageId: Id;
          scope:
            | {
                kind: "PAGE";
              }
            | {
                kind: "REGIONS";
                /**
                 * @minItems 1
                 */
                regionIds: [Id, ...Id[]];
              };
          expectedResultRevision: Counter;
          settingsVersion: Counter;
        };
      }
    | {
        kind: "BATCH_TRANSLATION";
        payload: {
          /**
           * @minItems 0
           */
          pageIdsInOrder: Id[];
          settingsVersion: Counter;
        };
      }
    | {
        kind: "RETRY_REQUEST";
        payload: {
          requestId: Id;
        };
      }
    | {
        kind: "RETRANSLATE";
        payload: {
          pageId: Id;
          scope:
            | {
                kind: "PAGE";
              }
            | {
                kind: "REGIONS";
                /**
                 * @minItems 1
                 */
                regionIds: [Id, ...Id[]];
              };
          expectedResultRevision: Counter;
          settingsVersion: Counter;
        };
      }
    | {
        kind: "MANUAL_EDIT";
        payload: {
          pageId: Id;
          regionId: Id;
          expectedResultRevision: Counter;
          patch: {
            sourceText?: string;
            translatedText?: string;
            fontAssetId?: Id;
            fontSizePx?: PositivePixels;
            orientation?: "HORIZONTAL" | "VERTICAL";
            typesetBox?: TypesetBox | null;
            targetOrientation?: ("HORIZONTAL" | "VERTICAL") | null;
          };
        };
      }
    | {
        kind: "UNDO";
        payload: {
          pageId: Id;
          expectedHistoryRevision: Counter;
          cursorId: Id | null;
        };
      }
    | {
        kind: "REDO";
        payload: {
          pageId: Id;
          expectedHistoryRevision: Counter;
          cursorId: Id | null;
        };
      }
    | {
        kind: "HANDOFF";
        payload: {
          newTabId: Id;
        };
      }
    | {
        kind: "BEGIN_EXIT";
        payload: {
          purpose: "SAVE_AND_EXIT" | "LOGOUT_CURRENT";
        };
      }
    | {
        kind: "DECLARE_DRAFT_BARRIER";
        payload: {
          exitOperationId: Id;
          /**
           * @minItems 0
           */
          acknowledgedMutationIds: Id[];
          localDraftsFlushed: true;
        };
      }
    | {
        kind: "CAPTURE_PROJECT_FILE";
        payload: {
          exitOperationId: Id;
          draftBarrierId: Id;
        };
      }
    | {
        kind: "ATTEST_PROJECT_FILE";
        payload: {
          exitOperationId: Id;
          exportId: Id;
          draftBarrierId: Id;
          snapshotRevision: Counter;
          fileSha256: Digest;
          userKeptFile: true;
        };
      }
    | {
        kind: "CAPTURE_ZIP";
        payload: {};
      }
    | {
        kind: "RETRY_ZIP";
        payload: {
          exportId: Id;
        };
      }
    | {
        kind: "RETRY_LIBRARY_STORE";
        payload: {
          storeOperationId: Id;
          retryGroupId: Id;
        };
      }
    | {
        kind: "SET_PROJECT_STATUS";
        payload: {
          status: "IN_PROGRESS" | "COMPLETED";
        };
      };
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "createWorkspace".
 */
export interface CreateWorkspace {
  commandId: Id;
  intentVersion: 1;
  tabId: Id;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "importProjectFile".
 */
export interface ImportProjectFile {
  commandId: Id;
  intentVersion: 1;
  uploadId: Id;
  tabId: Id;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "authAttempt".
 */
export interface AuthAttempt {
  commandId: Id;
  intentVersion: 1;
  method: "GOOGLE" | "EMAIL_OTP";
  purpose:
    "LOGIN" | "CONFIRM_CURRENT_ACCOUNT" | "PROVE_LOGIN_BINDING" | "CONFIRM_RETAINED_BINDING" | "CONFIRM_ALL_LOGOUT";
  bindingId: Id | null;
  email: string | null;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "verifyOtp".
 */
export interface VerifyOtp {
  commandId: Id;
  intentVersion: 1;
  attemptId: Id;
  code: string;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "completeAuthCallback".
 */
export interface CompleteAuthCallback {
  commandId: Id;
  intentVersion: 1;
  attemptId: Id;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "linkBinding".
 */
export interface LinkBinding {
  commandId: Id;
  intentVersion: 1;
  currentAccountProofId: Id;
  newBindingProofId: Id;
  expectedBindingRevision: Counter;
  explicitLink: true;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "unlinkBinding".
 */
export interface UnlinkBinding {
  commandId: Id;
  intentVersion: 1;
  bindingId: Id;
  retainedBindingProofId: Id;
  expectedBindingRevision: Counter;
  explicitRemove: true;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "logoutCurrent".
 */
export interface LogoutCurrent {
  commandId: Id;
  intentVersion: 1;
  exitOperationId: Id | null;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "logoutAll".
 */
export interface LogoutAll {
  commandId: Id;
  intentVersion: 1;
  proofId: Id;
  lossWarningVersion: 1;
  explicitDiscardAndRevoke: true;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "prepareUpload".
 */
export interface PrepareUpload {
  commandId: Id;
  intentVersion: 1;
  purpose: "PAGE_IMAGES" | "PROJECT_IMPORT";
  target: OwnedTarget | null;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "operationRef".
 */
export interface OperationRef {
  kind:
    | "AUTH_ATTEMPT"
    | "SESSION"
    | "BINDING"
    | "WORKSPACE"
    | "UPLOAD"
    | "REQUEST"
    | "BATCH"
    | "EXPORT"
    | "EXIT"
    | "LIBRARY_STORE"
    | "NONE";
  id: Id | null;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "commandReply".
 */
export interface CommandReply {
  commandId: Id;
  disposition: "APPLIED" | "ACCEPTED" | "EXISTING" | "REJECTED" | "RECONCILING";
  operationRef: OperationRef;
  observedRevision: Counter | null;
  reasonCode: Reason;
  nextAction:
    | "NONE"
    | "REFETCH"
    | "RETRY_SAME_COMMAND"
    | "WAIT"
    | "LOGIN"
    | "USE_OWNER_TAB"
    | "NEW_TRANSLATION"
    | "NEW_CAPTURE"
    | "RESELECT_UPLOAD"
    | "PROVE_ACCESS"
    | "KEEP_FILE";
  serverTime: Time;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "accountView".
 */
export interface AccountView {
  accountId: Id;
  balanceCredit: Decimal;
  freeStartedCount: number;
  freeReservedCount: number;
  liveContextId: Id | null;
  /**
   * @minItems 0
   */
  paidHoldReasons: Reason[];
  absoluteLoginExpiresAt: Time;
  serverTime: Time;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "requestView".
 */
export interface RequestView {
  requestId: Id;
  pageId: Id;
  state: "ACCEPTED" | "ACTIVE" | "WAITING" | "STOP_REQUESTED" | "COMPLETED" | "STOPPED" | "FAILED";
  executionState:
    "NOT_STARTED" | "PREPARED" | "DISPATCHING" | "RUNNING" | "UNKNOWN" | "SUCCEEDED" | "REJECTED" | "FAILED";
  resultState: "NONE" | "AVAILABLE" | "APPLIED" | "NOT_APPLICABLE";
  settlementState: "NOT_REQUIRED" | "PENDING" | "CONFIRMED" | "UNCONFIRMED";
  /**
   * @minItems 0
   */
  holdReasons: Reason[];
  providerWaitUntil: Time | null;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "actionAvailability".
 */
export interface ActionAvailability {
  action: Version;
  allowed: boolean;
  /**
   * @minItems 0
   */
  reasons: Reason[];
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "workspaceView".
 */
export interface WorkspaceView {
  contextId: Id;
  contextGeneration: Counter;
  workspaceRevision: Counter;
  ownerRevision: Counter;
  lifecycle: "OPEN" | "EXITING" | "CLOSED";
  isEditingOwner: boolean;
  closeReason: ("NORMAL_EXIT" | "DISCONNECT_EXPIRED" | "ALL_SESSIONS_LOGOUT") | null;
  reconnectUntil: Time | null;
  settings: Settings;
  projectStatus: "IN_PROGRESS" | "COMPLETED";
  /**
   * @minItems 0
   */
  pagesInOrder: Page[];
  /**
   * @minItems 0
   */
  requests: RequestView[];
  /**
   * @minItems 0
   */
  actions: ActionAvailability[];
  serverTime: Time;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "operationView".
 */
export interface OperationView {
  operationRef: OperationRef;
  state: "ACCEPTED" | "RUNNING" | "RECONCILING" | "AVAILABLE" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CLOSED";
  reasonCode: Reason;
  snapshotRevision: Counter | null;
  capturedAt: Time | null;
  expiresAt: Time | null;
  requiredEntryCount: number;
  /**
   * @minItems 0
   */
  failedPageIds: Id[];
  fileSha256: Digest | null;
  serverTime: Time;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "libraryItem".
 */
export interface LibraryItem {
  storeOperationId: Id;
  pageLineageId: Id;
  resultRevision: Counter;
  storeCompletedAt: Time;
  expiresAt: Time;
  accessState: "AVAILABLE" | "EXPIRED" | "UNCONFIRMED";
  deletionState: "NOT_DUE" | "PENDING" | "CONFIRMED" | "UNCONFIRMED";
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "libraryList".
 */
export interface LibraryList {
  /**
   * @minItems 0
   */
  items: LibraryItem[];
  serverTime: Time;
}
/**
 * This interface was referenced by `ProjectManifest`'s JSON-Schema
 * via the `definition` "uploadView".
 */
export interface UploadView {
  uploadId: Id;
  previewRevision: Counter;
  /**
   * @minItems 0
   */
  candidateIdsInOrder: Id[];
  /**
   * @minItems 0
   */
  duplicateCandidateIds: Id[];
  /**
   * @minItems 0
   */
  failures: {
    candidateId: Id;
    reasonCode: Reason;
  }[];
  expiresAt: Time;
  serverTime: Time;
}
