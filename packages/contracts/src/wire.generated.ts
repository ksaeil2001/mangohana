/* Generated from application-owned schemas by npm run contracts:generate. Do not edit. */

export type WireEntity =
  | Id
  | Counter
  | Digest
  | Time
  | Decimal
  | Version
  | PositivePixels
  | Point
  | Reason
  | Settings
  | OwnedTarget
  | TextValue
  | Geometry
  | Block
  | Asset
  | Checkpoint
  | Page
  | WorkspaceCommand
  | CreateWorkspace
  | ImportProjectFile
  | AuthAttempt
  | VerifyOtp
  | CompleteAuthCallback
  | LinkBinding
  | UnlinkBinding
  | LogoutCurrent
  | LogoutAll
  | PrepareUpload
  | OperationRef
  | CommandReply
  | AccountView
  | RequestView
  | ActionAvailability
  | WorkspaceView
  | OperationView
  | LibraryItem
  | LibraryList
  | UploadView
  | AppliedTranslation
  | FontProvenance
  | OwnerHeartbeat
  | PageView
  | OwnerHeartbeatReply
  | UploadCandidateView
  | StageInputEnvelope
  | StageOutputEnvelope
  | OcrProposal
  | TranslationProposal
  | PageSummary
  | SignedDecimal
  | LedgerItem
  | LedgerList
  | HistoryView
  | RenderSpecification
  | TypesetBox;
export type Id = string;
export type Counter = string;
export type Digest = string;
export type Time = string;
export type Decimal = string;
export type Version = string;
export type PositivePixels = number;
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
export type SignedDecimal = string;

export interface Point {
  x: number;
  y: number;
}
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
export interface OwnedTarget {
  contextId: Id;
  contextGeneration: Counter;
  tabId: Id;
  expectedOwnerRevision: Counter;
  expectedWorkspaceRevision: Counter;
}
export interface TextValue {
  value: string;
  status: "AI_PROPOSED" | "USER_MODIFIED" | "USER_CONFIRMED";
}
export interface Geometry {
  /**
   * @minItems 3
   */
  polygon: [Point, Point, Point, ...Point[]];
  angleDegrees: number;
  readingOrder: number;
  orientation: "HORIZONTAL" | "VERTICAL";
}
export interface Block {
  regionId: Id;
  geometry: Geometry;
  sourceText: TextValue;
  translatedText: TextValue;
  fontAssetId: Id;
  fontSizePx: PositivePixels;
  appliedTranslation: AppliedTranslation | null;
}
export interface AppliedTranslation {
  sourceLanguage: "ja" | "zh-Hans" | "en";
  targetLanguage: "ko" | "en" | "ja";
  modelId: Version;
  reasoningLevel: "LOW" | "MEDIUM" | "HIGH";
  modelContract: Version;
  promptContract: Version;
  originExecutionId: Id | null;
}
export interface Asset {
  assetId: Id;
  entry: string;
  purpose: "ORIGINAL" | "CLEANED" | "RENDER" | "FONT" | "LICENSE" | "CHECKPOINT";
  mediaType: "image/png" | "image/jpeg" | "font/otf" | "font/ttf" | "text/plain" | "application/octet-stream";
  bytesLength: Counter;
  sha256: Digest;
  requiredFor: "EDIT" | "CHECKPOINT";
}
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
}
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
              }
            | {
                kind: "PAINTED";
                selectionId: Id;
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
              }
            | {
                kind: "PAINTED";
                selectionId: Id;
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
      }
    | {
        kind: "RECONNECT";
        payload: {
          priorConnectionGeneration: Counter;
        };
      }
    | {
        kind: "REQUEST_STOP";
        payload: {
          operationKind: "REQUEST" | "BATCH";
          operationId: Id;
        };
      }
    | {
        kind: "CANCEL_EXIT";
        payload: {
          exitOperationId: Id;
        };
      }
    | {
        kind: "CAPTURE_PAINT_SELECTION";
        payload: {
          pageId: Id;
          expectedResultRevision: Counter;
          /**
           * @minItems 1
           */
          strokes: [
            {
              radiusPx: PositivePixels;
              /**
               * @minItems 1
               */
              points: [Point, ...Point[]];
            },
            ...{
              radiusPx: PositivePixels;
              /**
               * @minItems 1
               */
              points: [Point, ...Point[]];
            }[]
          ];
        };
      }
    | {
        kind: "CONTINUE_BATCH";
        payload: {
          batchId: Id;
          expectedBatchRevision: Counter;
          failedRequestId: Id;
        };
      };
}
export interface TypesetBox {
  left: number;
  top: number;
  width: PositivePixels;
  height: PositivePixels;
}
export interface CreateWorkspace {
  commandId: Id;
  intentVersion: 1;
  tabId: Id;
}
export interface ImportProjectFile {
  commandId: Id;
  intentVersion: 1;
  uploadId: Id;
  tabId: Id;
}
export interface AuthAttempt {
  commandId: Id;
  intentVersion: 1;
  method: "GOOGLE" | "EMAIL_OTP";
  purpose:
    "LOGIN" | "CONFIRM_CURRENT_ACCOUNT" | "PROVE_LOGIN_BINDING" | "CONFIRM_RETAINED_BINDING" | "CONFIRM_ALL_LOGOUT";
  bindingId: Id | null;
  email: string | null;
}
export interface VerifyOtp {
  commandId: Id;
  intentVersion: 1;
  attemptId: Id;
  code: string;
}
export interface CompleteAuthCallback {
  commandId: Id;
  intentVersion: 1;
  attemptId: Id;
}
export interface LinkBinding {
  commandId: Id;
  intentVersion: 1;
  currentAccountProofId: Id;
  newBindingProofId: Id;
  expectedBindingRevision: Counter;
  explicitLink: true;
}
export interface UnlinkBinding {
  commandId: Id;
  intentVersion: 1;
  bindingId: Id;
  retainedBindingProofId: Id;
  expectedBindingRevision: Counter;
  explicitRemove: true;
}
export interface LogoutCurrent {
  commandId: Id;
  intentVersion: 1;
  exitOperationId: Id | null;
}
export interface LogoutAll {
  commandId: Id;
  intentVersion: 1;
  proofId: Id;
  lossWarningVersion: 1;
  explicitDiscardAndRevoke: true;
}
export interface PrepareUpload {
  commandId: Id;
  intentVersion: 1;
  purpose: "PAGE_IMAGES" | "PROJECT_IMPORT";
  target: OwnedTarget | null;
}
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
export interface ActionAvailability {
  action: Version;
  allowed: boolean;
  /**
   * @minItems 0
   */
  reasons: Reason[];
}
export interface WorkspaceView {
  contextId: Id;
  contextGeneration: Counter;
  workspaceRevision: Counter;
  ownerRevision: Counter;
  lifecycle: "OPEN" | "EXITING" | "CLOSED";
  isEditingOwner: boolean;
  closeReason: ("NORMAL_EXIT" | "DISCONNECT_EXPIRED" | "ALL_SESSIONS_LOGOUT") | null;
  reconnectUntil: Time | null;
  settings: Settings | null;
  projectStatus: "IN_PROGRESS" | "COMPLETED";
  pagesInOrder: PageSummary[];
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
export interface PageSummary {
  pageLineageId: Id;
  displayName: string;
  skip: boolean;
  resultRevision: Counter;
  translationState: "ORIGINAL" | "RESULT_AVAILABLE";
  editLocked: boolean;
  paidCumulativeCurrentCredit: Decimal | null;
  paidCumulativeState: "CONFIRMED" | "UNCONFIRMED";
}
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
export interface LibraryItem {
  storeOperationId: Id;
  pageLineageId: Id;
  resultRevision: Counter;
  storeCompletedAt: Time;
  expiresAt: Time;
  accessState: "AVAILABLE" | "EXPIRED" | "UNCONFIRMED";
  deletionState: "NOT_DUE" | "PENDING" | "CONFIRMED" | "UNCONFIRMED";
}
export interface LibraryList {
  /**
   * @minItems 0
   */
  items: LibraryItem[];
  serverTime: Time;
}
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
  candidates: UploadCandidateView[];
}
export interface UploadCandidateView {
  candidateId: Id;
  inputOrdinal: number;
  displayName: string;
  decodeState: "VALID" | "INVALID" | "UNCONFIRMED";
  assetId: Id | null;
  bytesLength: Counter | null;
  widthPx: number | null;
  heightPx: number | null;
  duplicateOfPageIds: Id[];
  duplicateOfCandidateIds: Id[];
  reasonCode: Reason;
}
export interface FontProvenance {
  fontAssetId: Id;
  family: string;
  fontVersion: Version;
  fontCatalogVersion: Version;
  licenseAssetId: Id;
}
export interface OwnerHeartbeat {
  contextId: Id;
  contextGeneration: Counter;
  tabId: Id;
  expectedOwnerRevision: Counter;
  connectionGeneration: Counter;
  heartbeatSeq: Counter;
}
export interface PageView {
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
  paidCumulativeCurrentCredit: Decimal | null;
  paidCumulativeState: "CONFIRMED" | "UNCONFIRMED";
  history: HistoryView;
  renderSpecification?: RenderSpecification | null;
}
export interface HistoryView {
  revision: Counter;
  cursorId: Id | null;
  canUndo: boolean;
  canRedo: boolean;
  reasonCode: Reason;
}
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
export interface OwnerHeartbeatReply {
  connectionGeneration: Counter;
  lastAcceptedSeq: Counter;
  lastValidAt: Time | null;
  reconnectUntil: Time | null;
  ownerRevision: Counter;
  reasonCode: Reason;
  serverTime: Time;
}
export interface StageInputEnvelope {
  executionId: Id;
  requestId: Id;
  logicalStepId: Version;
  contextId: Id;
  contextGeneration: Counter;
  pageLineageId: Id;
  stageContract: Version;
  inputDigest: Digest;
  assetIds: Id[];
  regionIds: Id[];
  capturedSettings: Settings;
  checkpointDependencies: Checkpoint[];
  costBoundUsd: Decimal | null;
  parameterProfileVersion: Version;
}
export interface StageOutputEnvelope {
  executionId: Id;
  inputDigest: Digest;
  stageContract: Version;
  outcome: "CONFIRMED_SUCCESS" | "CONFIRMED_NOT_STARTED" | "CONFIRMED_FAILURE" | "UNKNOWN";
  protectedEvidenceRef: Id;
  outputAssetIds: Id[];
  checkpointId: Id | null;
  usageState: "UNCONFIRMED" | "CONFIRMED";
  actualCostUsd: Decimal | null;
  finishReason: string;
}
export interface OcrProposal {
  regions: {
    geometry: Geometry;
    sourceText: string;
    confidence: number | null;
  }[];
}
export interface TranslationProposal {
  items: {
    inputRegionId: Id;
    targetText: string;
  }[];
}
export interface LedgerItem {
  ledgerEntryId: Id;
  kind: "SETTLEMENT" | "PURCHASE" | "REFUND_ADJUSTMENT";
  creditDelta: SignedDecimal;
  createdAt: Time;
  basisVersion: Version;
  costItemId: Id | null;
  requestId: Id | null;
}
export interface LedgerList {
  items: LedgerItem[];
  nextCursor: Id | null;
  serverTime: Time;
}
