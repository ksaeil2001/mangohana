import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  applyApprovedInpaintingResult,
  isInpaintPageImageResult,
  pageImageFromInpaintingResult,
  type InpaintingMode,
  type InpaintingProvider
} from "../shared/inpainting";
import type { DialogueUserPatch, ProjectMutation } from "../shared/projectChanges";
import {
  createInitialEnvironmentSnapshot,
  getCapabilityDisabledReason,
  type EnvironmentPreparationSnapshot
} from "../shared/environmentPreparation";
import { createAutoUpdateState, type AutoUpdateState } from "../shared/autoUpdateStatus";
import {
  acknowledgeCancelIpc,
  BACKEND_CANCEL_CONFIRMING_MESSAGE,
  messageForBackendCancelAcknowledgment,
  type BackendCancelAcknowledgment
} from "../shared/cancelAcknowledgment";
import { createEmptyProject, normalizeProject } from "../shared/projectValidation";
import {
  buildDialogueTranslationContext,
  buildTranslationContextPayload,
  computeTranslationPayloadFingerprint
} from "../shared/translationContext";
import { inspectApprovedCleanedAsset } from "../shared/approvedCleanedAsset";
import { calculateTypesettingSafeArea } from "../shared/geometry/panelAndBubbleLayout";
import { buildRenderReadinessReport } from "../shared/renderReadiness";
import type { DialogueLine, DialogueTypesetting, EditableTranslationProject, LineStatus, PageImage, PreparedPageImage, TranslationProjectV2 } from "../shared/projectTypes";
import type { ProviderSettings } from "../shared/providerSettings";

import type {
  PreparedPageImageBatchDto,
  ProjectChangeResult,
  ProjectOpenFailureResult,
  ProjectSessionResult,
  TranslationProjectDto
} from "../shared/projectSessionTypes";
import {
  type NormalizedBbox,
  type SpeechBubbleExtractionResult
} from "../shared/speechBubbleExtraction";
import { CharacterDictionaryPanel } from "./components/CharacterDictionaryPanel";
import { AppDialogProvider, useAppDialogs } from "./components/AppDialogs";
import { BatchAutomationModal, type BatchRunScope } from "./components/BatchAutomationModal";
import { burnTypesettingFromUrl } from "./imageBurnInRenderer";
import { collectRenderReadinessEvidence } from "./typesettingReadiness";
import { ensureProductionTypesetFontLoaded } from "./productionTypesetFont";
import { ContextualIssueEditorControl } from "./components/ContextualIssueEditorControl";
import { DialogueFilmstrip } from "./components/DialogueFilmstrip";
import { ProcessingQueuePanel, type ProcessingQueueRequestScope } from "./components/ProcessingQueuePanel";
import { EnvironmentPreparationScreen } from "./components/EnvironmentPreparationScreen";
import { FocusDeckShell, type WorkspacePanelActions } from "./components/FocusDeckShell";
import { GuidedWorkPanel } from "./components/GuidedWorkPanel";
import { ImageImportPanel } from "./components/ImageImportPanel";
import { ImportPanel, importTxtLines } from "./components/ImportPanel";
import { IssueLinePanel } from "./components/IssueLinePanel";
import type { IssueLineItem } from "./components/IssueLinePanel";
import { PageStrip } from "./components/PageStrip";
import type { PageStripItem } from "./components/PageStrip";
import { ProjectActionsPanel } from "./components/ProjectActionsPanel";
import { ProjectHomeScreen } from "./components/ProjectHomeScreen";
import { ProjectsPage } from "./components/ProjectsPage";
import { SettingsPage } from "./components/SettingsPage";
import { AiDashboardPage } from "./components/AiDashboardPage";
import { FileBrowserPage } from "./components/FileBrowserPage";
import { DictionaryPage } from "./components/DictionaryPage";
import { ToolsPage } from "./components/ToolsPage";
import { ProjectSetupScreen } from "./components/ProjectSetupScreen";
import { RuntimeStatusControl } from "./components/RuntimeStatusControl";
import { AutoUpdateStatusControl } from "./components/AutoUpdateStatusControl";
import { useAppEnvironment } from "./useAppEnvironment";
import { useProjectSetup } from "./useProjectSetup";
import { useTranslationWorkflow } from "./useTranslationWorkflow";
import { useInpaintingWorkflow } from "./useInpaintingWorkflow";
import { useProjectSession } from "./useProjectSession";
import { useSessionMutationQueue, mergePendingPageNumbers, type SessionMutationObserver } from "./useSessionMutationQueue.js";
import { useProjectSaveWorkflow } from "./useProjectSaveWorkflow.js";
import { useOcrWorkflow } from "./useOcrWorkflow";
import { useWorkspaceState } from "./useWorkspaceState";
import type { SpeechBubbleReviewDraft, SpeechBubbleReviewItem } from "./components/SpeechBubbleReviewDialog";
import type { ProjectFileResult, ProjectPasswordRequiredResult } from "./electronApi";
import {
  getGuidedStage,
  getNextActionableLineId,
  type GuidanceDensity,
  type ReviewStage
} from "./guidedWorkflow";
import {
  DEFAULT_WORKSPACE_PANELS,
  loadFocusDeckPreferences,
  saveFocusDeckPreferences,
  type WorkspacePanelState
} from "./focusDeck";
import {
  createWorkspaceSessionSnapshot,
  getWorkspaceSessionRecentProjectId,
  loadWorkspaceSession,
  markWorkspaceSessionClosed,
  saveWorkspaceSession,
  validateWorkspaceSession,
  type WorkspaceSessionComparison,
  type WorkspaceSessionIdentity,
  type WorkspaceSessionSnapshot
} from "./workspaceSession";
import { entryFlowReducer, initialEntryFlowState, type PreparationReturnScreen } from "./entryFlow";
import { createImageProject, type ImageProjectStartPhase, type ImageProjectStartResult } from "./imageProjectStart";
import { IMAGE_ZOOM_STEP, clampImageZoom, createImageViewportState, type ImageViewportState } from "./imageViewport";
import type { InpaintingMaskDraft } from "./inpaintingMaskDraft";
import {
  createMissingResultLayer,
  createOriginalResultLayer,
  getResultLayerStatus,
  resolveApprovedResultAsset,
  type ResultLayerDescriptor
} from "./resultLayers";
import type { OverlayKind, ResultLayer } from "./trioState";
import { buildSemanticOverlayDescriptors, OVERLAY_KIND_ORDER } from "./semanticOverlays";
import type { SemanticOverlayBbox } from "./semanticOverlays";
import {
  createTypesettingDraft,
  constrainTypesettingDraftToSafeArea,
  deriveTypesettingSafeArea,
  dialogueTypesettingFromDraft,
  isValidTypesettingBbox,
  type TypesettingDraft
} from "./typesettingGeometry";
import {
  clearTranslationDraft,
  createTranslationSourceIdentity,
  loadTranslationDraft,
  saveTranslationDraft
} from "./translationDrafts";
import type { TranslationDraftScope } from "./translationDrafts";
import { canConfirmTranslation, confirmTranslation, markTranslationDraft, mergeAiTranslationProposal } from "./translationOwnership";
import {
  clearTypesettingDraft,
  loadTypesettingDraft,
  saveTypesettingDraft,
  type TypesettingDraftScope
} from "./typesettingDrafts";
import { initialProjectSetupState, projectSetupReducer } from "./projectSetupState";
import { addRecentProject, loadRecentProjects, removeRecentProject } from "./recentProjects";
import { getWorkspacePresentation } from "./workspacePresentation";
import { useWorkspaceAdaptation } from "./workspaceAdaptation";
import {
  commitOrRollbackIssueNavigation,
  getIssueLineItems,
  prepareIssueNavigation,
  type IssueNavigationState,
  type IssueNavigationTarget
} from "./issueNavigation";
import {
  createInitialIssueEditorState,
  issueEditorReducer,
  loadIssueEditorPreference,
  saveIssueEditorPreference
} from "./issueEditorState";
import type { PageImageFocusRequest, PageImageRenderState } from "./components/PageImagePanel";
import type { ManualTypesettingBoxFields } from "./components/ManualTypesettingBoxEditor";
import mangohanaMark from "./brand/mangohana-mark.svg";
import { DialogueTable } from "./components/DialogueTable";
import "./design-tokens.css";
import "./styles.css";
import "./design-system.css";
import "./studio.css";
import "./stitch-workbench.css";
import "./stitch-suite.css";
import "./stitch-flow.css";
import "./stitch-dialogs.css";
import "./mangohana-workspace.css";

// Inkline Production Bench: the selected page and its active object determine the UI.
const PageImagePanel = lazy(() => import("./components/PageImagePanel").then((module) => ({ default: module.PageImagePanel })));
const StageEditor = lazy(() => import("./components/StageEditor").then((module) => ({ default: module.StageEditor })));

type WorkspaceMode = "viewer" | "line-edit" | "ocr-review" | "inpainting";
type BottomPanel = "dialogue" | "ocr-candidates" | "issues";

const PROVIDER_SETTINGS_LOAD_ERROR = "Provider 설정을 불러오지 못해 작업을 시작하지 않았습니다.";
type NavigatorView = "pages" | "context" | "guide" | "settings";

function DeferredViewFallback({ label }: { label: string }) {
  return <div className="deferred-view-fallback" role="status">{label}</div>;
}

async function loadRequiredProviderSettings(): Promise<ProviderSettings> {
  const getProviderSettings = window.projectApi?.getProviderSettings;
  if (!getProviderSettings) throw new Error(PROVIDER_SETTINGS_LOAD_ERROR);
  try {
    return await getProviderSettings();
  } catch {
    throw new Error(PROVIDER_SETTINGS_LOAD_ERROR);
  }
}

type InpaintingMaskDraftContext = {
  projectId: string;
  pageNumber: number;
  pageImageId: string;
  draft: InpaintingMaskDraft;
};

type PageResultContext = {
  original: PageImage | null;
  inpainted: PageImage | null;
  translated: PageImage | null;
};

type PageResultContextMap = Record<string, PageResultContext>;

type PendingInpaintingContext = {
  projectId: string;
  pageNumber: number;
  pageImageId: string;
};

type TypesettingDraftContext = TypesettingDraftScope & {
  pageNumber: number;
  sourceOcrBbox: NormalizedBbox;
  draft: TypesettingDraft;
};

/**
 * A renderer-only typesetting draft may outlive the OCR review surface that
 * originally created it.  Keep a small synthetic review item so the direct
 * editor can still render without mutating the immutable OCR extraction.
 */
function createRestoredTypesettingReviewItem(draft: TypesettingDraft, sourceOcrBbox: NormalizedBbox): SpeechBubbleReviewItem {
  return {
    id: draft.sourceOcrId,
    textType: "speech_bubble",
    text: "",
    language: "unknown",
    bbox: { ...sourceOcrBbox },
    readingOrder: 1,
    confidence: 1,
    notes: "",
    speakerCandidates: [],
    selectedSpeaker: ""
  };
}

type TranslationDraftContext = TranslationDraftScope & {
  text: string;
};

type IssueNavigationSnapshot = IssueNavigationState & {
  currentIssue: IssueNavigationTarget | null;
  reviewStage: ReviewStage;
  speechBubbleReview: SpeechBubbleExtractionResult | null;
  activeReviewItem: SpeechBubbleReviewItem | null;
  focusRequest: PageImageFocusRequest | null;
  initialViewport: ({ key: string; preserveInpainting?: boolean } & ImageViewportState) | undefined;
  imageResetRevision: number;
  workspaceZoom: number;
};

type PendingOcrReview = {
  result: SpeechBubbleExtractionResult;
  sourceSha256: string;
  stage: ReviewStage;
  draft?: SpeechBubbleReviewDraft;
};

type PendingIssueNavigation = {
  token: string;
  projectId: string;
  target: IssueNavigationTarget;
  snapshot: IssueNavigationSnapshot;
  expectedPageImageId: string | null;
};

function resultContextKey(projectId: string, pageNumber: number): string {
  return `${projectId}:${pageNumber}`;
}

function pageImageFromDerivedAsset(asset: {
  assetId: string;
  storedRelativePath: string;
  sha256: string;
  byteSize: number;
  mimeType: "image/png";
  createdAt: string;
}, sourceImage: PageImage): PageImage {
  return {
    ...sourceImage,
    id: asset.assetId,
    storedRelativePath: asset.storedRelativePath,
    originalFileName: asset.storedRelativePath.split(/[\\/]/).pop() ?? sourceImage.originalFileName,
    sha256: asset.sha256,
    byteSize: asset.byteSize,
    mimeType: asset.mimeType,
    copiedAt: asset.createdAt
  };
}

function isPasswordRequiredResult(
  result: unknown
): result is ProjectPasswordRequiredResult & { unlockToken?: string } {
  return Boolean(result && typeof result === "object" && "passwordRequired" in result);
}

function isProjectSessionResult(result: unknown): result is ProjectSessionResult {
  return Boolean(
    result &&
    typeof result === "object" &&
    "projectSessionId" in result &&
    typeof (result as { projectSessionId?: unknown }).projectSessionId === "string"
  );
}

type ActiveAiTranslationRequest = {
  requestId: string;
  token: number;
  projectSessionId: string | null;
  sessionGeneration: number;
  projectId: string;
  targetLineId: string;
  contextFingerprint: string;
  stylePreset?: string;
};

type ActiveOcrRequest = {
  requestId: string;
  token: number;
  projectSessionId: string | null;
  sessionGeneration: number;
  projectId: string;
  filePath: string;
  pageImageId: string;
  storedRelativePath: string;
  backendStarted: boolean;
};

type ActiveInpaintingRequest = {
  requestId: string;
  projectSessionId: string | null;
  projectId: string;
  filePath: string;
  pageImageId: string;
  storedRelativePath: string;
  canceledByUser?: boolean;
};

type ProjectSessionReadiness =
  | "not-required"
  | "initializing"
  | "ready"
  | "password-required"
  | "error";

export default function App() {
  return <AppDialogProvider><AppContent /></AppDialogProvider>;
}

function AppContent() {
  const dialogs = useAppDialogs();
  const [entryFlow, dispatchEntryFlow] = useReducer(entryFlowReducer, initialEntryFlowState);
  const {
    projectSetup,
    dispatchProjectSetup,
    projectSetupStoragePath,
    setProjectSetupStoragePath,
    projectSetupOperationTokenRef
  } = useProjectSetup();
  const {
    isInpaintingRunning: isInpainting,
    setIsInpaintingRunning: setIsInpainting,
    pageResultContexts,
    setPageResultContexts,
    pendingInpaintingContext,
    setPendingInpaintingContext
  } = useInpaintingWorkflow();
  const {
    isTranslating: isAiTranslating,
    setIsTranslating: setIsAiTranslating
  } = useTranslationWorkflow();
  const {
    projectSessionId,
    setProjectSessionId,
    activeProjectFilePath: currentFilePath,
    setActiveProjectFilePath: setCurrentFilePath,
    recentProjectId: activeRecentProjectId,
    setRecentProjectId: setActiveRecentProjectId,
    sessionRevision: projectRevision,
    setSessionRevision: setProjectRevision
  } = useProjectSession({ initialRevision: 0 });
  const {
    isOcrRunning: isExtractingSpeechBubbles,
    setIsOcrRunning: setIsExtractingSpeechBubbles,
    ocrError,
    setOcrError
  } = useOcrWorkflow();
  const {
    bottomPanel,
    setBottomPanel,
    selectedPageNumber: currentPage,
    setSelectedPageNumber: setCurrentPage,
    selectedLineId,
    setSelectedLineId,
    guidanceDensity,
    setGuidanceDensity,
    visibleOverlayKinds,
    setVisibleOverlayKinds,
    focusDeckPreferences: workspacePanels,
    setFocusDeckPreferences: setWorkspacePanels
  } = useWorkspaceState();

  const [project, setProject] = useState(() => createEmptyProject("새 프로젝트", false));
  const [statusMessage, setStatusMessage] = useState("준비됨.");
  const [projectSessionStatus, setProjectSessionStatus] = useState<TranslationProjectDto["status"]>("active");
  const projectSessionStatusRef = useRef<TranslationProjectDto["status"]>("active");
  const sessionNeedsRecovery = projectSessionStatus === "needs_recovery";
  const projectSessionRecoveryMessage =
    "세션 복구가 필요합니다. 화면에 표시된 내용은 마지막으로 안전하게 반영된 프로젝트입니다. 저장되지 않은 편집을 합치지 못했으며 자동으로 버리지 않았습니다. 추가 편집이나 처리 작업은 상태를 더 악화시킬 수 있습니다. 프로젝트를 다시 열어 복구하세요.";
  const [projectSessionReadiness, setProjectSessionReadiness] =
    useState<ProjectSessionReadiness>(() =>
      window.projectApi?.createProjectSession ? "initializing" : "not-required"
    );
  const [sessionBootstrapAttempt, setSessionBootstrapAttempt] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [finalReading, setFinalReading] = useState(false);
  const readingSelectionsRef = useRef(new Map<number, string | null>());
  useEffect(() => setFinalReading(false), [project.metadata.id, projectSessionId]);
  const [currentPageImageLoadFailed, setCurrentPageImageLoadFailed] = useState(false);
  const [focusNewManualTranslation, setFocusNewManualTranslation] = useState(false);
  const [speechBubbleReview, setSpeechBubbleReview] = useState<SpeechBubbleExtractionResult | null>(null);
  const ocrReviewDraftsRef = useRef(new Map<string, PendingOcrReview>());
  const [ocrReviewDraftCount, setOcrReviewDraftCount] = useState(0);
  const inpaintingMaskDraftsRef = useRef(new Map<string, { pageImageId: string; sourceSha256: string; draft: InpaintingMaskDraft }>());
  const [inpaintingMaskDraftCount, setInpaintingMaskDraftCount] = useState(0);
  const manualTypesettingDraftsRef = useRef(new Map<string, {
    projectId: string; pageImageId: string; sourceSha256: string; lineId: string; bbox: NormalizedBbox | null; fields?: ManualTypesettingBoxFields
  }>());
  const [manualTypesettingDraftCount, setManualTypesettingDraftCount] = useState(0);
  const [, setManualTypesettingDraftVersion] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceZoom, setWorkspaceZoom] = useState(1);
  const [issueRenderRevision, setIssueRenderRevision] = useState(0);
  const [initialImageViewport, setInitialImageViewport] = useState<({ key: string; preserveInpainting?: boolean } & ImageViewportState) | undefined>();
  const [workspaceViewport, setWorkspaceViewport] = useState<ImageViewportState | null>(null);
  const [resultLayer, setResultLayer] = useState<ResultLayer>("original");
  const resultLayerRef = useRef<ResultLayer>("original");
  const resultLayerUserRevisionRef = useRef(0);
  const [pendingPageNumbers, setPendingPageNumbers] = useState<number[]>([]);
  const [imageResetRevision, setImageResetRevision] = useState(0);
  const [hydratedPreferenceKey, setHydratedPreferenceKey] = useState<string | null>(null);
  const [dialogueView, setDialogueView] = useState<"queue" | "full">("queue");
  const [inpaintingEditorOpen, setInpaintingEditorOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<"source" | "translation" | "typesetting">("translation");
  const [manualTypesettingControlsTarget, setManualTypesettingControlsTarget] = useState<HTMLDivElement | null>(null);
  const [inpaintingMaskBbox, setInpaintingMaskBbox] = useState<SemanticOverlayBbox | null>(null);
  const [typesettingDraftContext, setTypesettingDraftContext] = useState<TypesettingDraftContext | null>(null);
  const [translationDraftContext, setTranslationDraftContext] = useState<TranslationDraftContext | null>(null);
  const [contextOpen, setContextOpen] = useState<boolean | null>(null);
  const [reviewStage, setReviewStage] = useState<ReviewStage>("ocr");
  const [activeReviewItem, setActiveReviewItem] = useState<SpeechBubbleReviewItem | null>(null);
  const [currentIssue, setCurrentIssue] = useState<IssueNavigationTarget | null>(null);
  const [issueFocusRequest, setIssueFocusRequest] = useState<PageImageFocusRequest | null>(null);
  const [issueEditor, setIssueEditor] = useState<IssueNavigationTarget["editor"] | null>(null);
  const [issueEditorState, dispatchIssueEditor] = useReducer(issueEditorReducer, undefined, createInitialIssueEditorState);
  const [issueEditorHydratedProjectKey, setIssueEditorHydratedProjectKey] = useState<string | null>(null);
  const [workspaceComparison, setWorkspaceComparison] = useState<WorkspaceSessionComparison>({
    mode: "single",
    revealPosition: 50,
    opacity: 0.5
  });
  const [workspaceSessionHydratedKey, setWorkspaceSessionHydratedKey] = useState<string | null>(null);
  const [workspaceComparisonHydrationRevision, setWorkspaceComparisonHydrationRevision] = useState(0);
  const [activeNavigator, setActiveNavigator] = useState<NavigatorView>("pages");
  const [uiThemeChoice, setUiTheme] = useState<"light" | "dark" | null>(() => {
    const persisted = window.localStorage.getItem("trio:ui-theme");
    return persisted === "light" || persisted === "dark" ? persisted : null;
  });
  const uiTheme = uiThemeChoice ?? "dark";
  const workspaceAdaptation = useWorkspaceAdaptation();
  const [imageImportFailureCount, setImageImportFailureCount] = useState(0);
  const [isImportingTxt, setIsImportingTxt] = useState(false);
  const [isImportingPageImages, setIsImportingPageImages] = useState(false);
  const [recentProjects, setRecentProjects] = useState(() => loadRecentProjects(window.localStorage));
  const [recentProjectsError, setRecentProjectsError] = useState<string | null>(null);
  const [recentProjectsReloadAttempt, setRecentProjectsReloadAttempt] = useState(0);
  const [unavailableRecentPath, setUnavailableRecentPath] = useState<string | null>(null);
  const {
    environmentSnapshot,
    setEnvironmentSnapshot,
    environmentLoading,
    environmentError,
    setEnvironmentError,
    refreshEnvironmentPreparation,
    chooseEnvironmentResourceRoot,
    installProductionOcr,
    resetEnvironmentState
  } = useAppEnvironment();
  const [autoUpdateState, setAutoUpdateState] = useState<AutoUpdateState>(() =>
    createAutoUpdateState("unavailable", {
      message: "업데이트 확인은 설치된 망고하나 앱에서 사용할 수 있습니다."
    })
  );
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const currentBatchRunRef = useRef<{ scope: BatchRunScope; queueId: string | null; isCurrent: () => boolean } | null>(null);
  const [imageExportInFlight, setImageExportInFlight] = useState(false);
  const [cleanedReviewInFlight, setCleanedReviewInFlight] = useState(false);
  const cleanedReviewOperationRef = useRef<Promise<boolean> | null>(null);
  const imageExportInFlightRef = useRef(false);
  const imagePrimaryActionRef = useRef<HTMLButtonElement>(null);

  const stageEditorPrimaryActionRef = useRef<HTMLButtonElement>(null);
  const workspacePanelActionsRef = useRef<WorkspacePanelActions>(null);
  const entryPrimaryActionRef = useRef<(() => boolean) | null>(null);
  const settingsPanelRef = useRef<HTMLElement>(null);
  const ocrRequestTokenRef = useRef(0);
  const activeOcrRequestRef = useRef<ActiveOcrRequest | null>(null);
  const activeInpaintingRequestRef = useRef<ActiveInpaintingRequest | null>(null);
  const manualOperationScopeRef = useRef<string | null>(null);
  const aiTranslationTokenRef = useRef(0);
  const activeAiTranslationRequestRef = useRef<ActiveAiTranslationRequest | null>(null);
  const backendCancelFeedbackGenerationRef = useRef(0);
  const viewportSeedRevisionRef = useRef(0);

  const activeProjectCreateTokenRef = useRef<number | null>(null);
  const newProjectSwitchInFlightRef = useRef(false);
  const openProjectOperationRef = useRef<object | null>(null);
  const cleanupPendingSessionIdsRef = useRef(new Set<string>());
  const projectSwitchCleanupErrorRef = useRef<AggregateError | null>(null);
  const activeTxtImportOperationRef = useRef<object | null>(null);
  const activePageImageImportOperationRef = useRef<object | null>(null);
  const projectRef = useRef(project);
  const selectedLineIdRef = useRef(selectedLineId);
  const projectSessionIdRef = useRef<string | null>(null);
  const projectSessionInstanceRef = useRef<object | null>(null);
  const projectRevisionRef = useRef(0);
  const sessionConflictNoticeRef = useRef("");
  const initialSessionPromiseRef = useRef<Promise<ProjectSessionResult> | null>(null);
  const initialSessionRequestIdRef = useRef(0);
  useEffect(() => () => {
    projectSessionInstanceRef.current = null;
    openProjectOperationRef.current = null;
    projectSetupOperationTokenRef.current += 1;
  }, []);
  const sessionPersistenceRequired = Boolean(
    window.projectApi?.createProjectSession
  );
  const projectSessionReady =
    !sessionPersistenceRequired || projectSessionReadiness === "ready";

  function blockProjectSessionRecovery(): boolean {
    if (projectSessionStatusRef.current !== "needs_recovery") return false;
    setStatusMessage(projectSessionRecoveryMessage);
    return true;
  }

  function adoptProjectSessionDto(dto: TranslationProjectDto) {
    projectSessionStatusRef.current = dto.status;
    setProjectSessionStatus(dto.status);
    if (dto.status === "needs_recovery") {
      setStatusMessage(projectSessionRecoveryMessage);
    }
  }

  function markProjectSessionStatus(status: TranslationProjectDto["status"]) {
    projectSessionStatusRef.current = status;
    setProjectSessionStatus(status);
  }

  const {
    sessionProjectRef,
    sessionMutationQueueRef,
    queuedSessionMutationCountRef,
    sessionGenerationRef,
    localLineIdMapRef,
    sessionConflictRef,
    sessionMutationFailedRef,
    lockSessionConflict,
    applySessionChange,
    queueSessionMutation,
    queueCleanedAssetReview,
    drainSessionMutationQueue,
    queueProjectDiff,
    syncProjectToSession,
    resetSessionMutationState
  } = useSessionMutationQueue({
    projectSessionIdRef,
    projectRevisionRef,
    setProjectRevision,
    projectRef,
    setProject,
    selectedLineIdRef,
    setSelectedLineId,
    setPendingPageNumbers,
    setIsDirty,
    setStatusMessage: (message) => {
      if (sessionConflictRef.current) sessionConflictNoticeRef.current = message;
      setStatusMessage(message);
    },
    sessionStatusRef: projectSessionStatusRef,
    onProjectDto: adoptProjectSessionDto,
    onLineIdRemapped: remapManualTypesettingDrafts
  });

  function hasUnappliedSessionEdits(): boolean {
    return sessionMutationFailedRef.current || queuedSessionMutationCountRef.current > 0 ||
      (sessionProjectRef.current !== null && projectRef.current !== sessionProjectRef.current);
  }

  function keepLocalEditsAfterSessionResult(dto: TranslationProjectDto): boolean {
    if (!hasUnappliedSessionEdits()) return false;
    setProjectRevision(dto.revision);
    projectRevisionRef.current = dto.revision;
    setPendingPageNumbers((current) => mergePendingPageNumbers(current, dto.pendingPageImages));
    sessionProjectRef.current = dto.project;
    setIsDirty(true);
    setStatusMessage("작업 결과는 세션에 반영됐지만, 이후 편집과 초안은 화면에 유지했습니다. 저장 전에 내용을 확인하세요.");
    return true;
  }

  function blockUnappliedSessionEdits(): boolean {
    if (!hasUnappliedSessionEdits()) return false;
    setStatusMessage("세션에 반영되지 않은 편집이 있어 작업을 중단했습니다. 먼저 저장을 다시 시도하세요.");
    return true;
  }

  const registeredBatchRun = currentBatchRunRef.current;
  if (registeredBatchRun && (!batchModalOpen ||
    registeredBatchRun.scope.projectSessionId !== projectSessionIdRef.current ||
    registeredBatchRun.scope.sessionGeneration !== sessionGenerationRef.current ||
    registeredBatchRun.scope.projectId !== project.metadata.id)) {
    currentBatchRunRef.current = null;
  }
  useEffect(() => () => { currentBatchRunRef.current = null; }, []);

  function isCurrentBatchRun(scope: BatchRunScope): boolean {
    const run = currentBatchRunRef.current;
    return Boolean(run && run.scope.requestId === scope.requestId && run.isCurrent() &&
      projectSessionIdRef.current === scope.projectSessionId && sessionGenerationRef.current === scope.sessionGeneration &&
      projectRef.current.metadata.id === scope.projectId);
  }

  function bindBatchRunQueue(scope: BatchRunScope, queueId: string, isCurrent: () => boolean): boolean {
    if (!isCurrent() || !isCurrentBatchRun(scope)) return false;
    const run = currentBatchRunRef.current!;
    if (run.queueId !== null && run.queueId !== queueId) return false;
    const currentQueueId = projectRef.current.processing.queue?.queueId ?? null;
    if (currentQueueId !== null && currentQueueId !== scope.initialQueueId && currentQueueId !== queueId) return false;
    run.queueId = queueId;
    return true;
  }

  async function adoptBatchSessionDto(
    dto: TranslationProjectDto,
    scope: { projectSessionId: string; sessionGeneration: number; projectId: string },
    isCurrent: () => boolean,
    ownsQueue: () => boolean
  ): Promise<"adopted" | "ignored"> {
    const matchesScope = () => isCurrent() && projectSessionIdRef.current === scope.projectSessionId &&
      sessionGenerationRef.current === scope.sessionGeneration && projectRef.current.metadata.id === scope.projectId &&
      dto.project.metadata.id === scope.projectId && ownsQueue();
    if (!matchesScope()) return "ignored";
    const drainingQueue = sessionMutationQueueRef.current;
    if (queuedSessionMutationCountRef.current > 0) await drainSessionMutationQueue();
    if (!matchesScope() || dto.revision <= projectRevisionRef.current || queuedSessionMutationCountRef.current > 0 ||
      sessionMutationQueueRef.current !== drainingQueue ||
      sessionConflictRef.current || sessionMutationFailedRef.current || projectSessionStatusRef.current !== "active" || dto.status !== "active" ||
      (sessionProjectRef.current !== null && projectRef.current !== sessionProjectRef.current)) return "ignored";
    applySessionChange({ status: "applied", revision: dto.revision, project: dto });
    return "adopted";
  }

  const {
    saveInFlightRef,
    saveProject,
    saveProjectAs,
    saveProjectTo,
    exportTranslations,
    prepareSyncedSessionForExport
  } = useProjectSaveWorkflow({
    project,
    setProject,
    projectRef,
    currentFilePath,
    setCurrentFilePath,
    projectSessionIdRef,
    sessionGenerationRef,
    projectRevisionRef,
    setProjectRevision,
    setPendingPageNumbers,
    sessionProjectRef,
    sessionConflictRef,
    initialSessionPromiseRef,
    sessionPersistenceRequired,
    drainSessionMutationQueue,
    syncProjectToSession,
    setIsDirty,
    setStatusMessage,
    setRecentProjects,
    sessionStatusRef: projectSessionStatusRef,
    onProjectDto: adoptProjectSessionDto,
    requestPassword: (message) => dialogs.prompt({ title: message, message: "암호는 이 프로젝트를 열고 저장하는 데만 사용합니다.", password: true, fieldLabel: "프로젝트 암호" })
  });
  const startupRestoreAttemptedRef = useRef(false);
  const startupRestoreInFlightRef = useRef(false);
  const retryInitialSessionOnlyRef = useRef(false);
  const workspaceRestoreSnapshotRef = useRef<WorkspaceSessionSnapshot | null>(null);
  const workspaceSessionSaveEnabledRef = useRef(false);
  const preferenceProjectIdRef = useRef<string | null>(null);
  const activeRecentProjectIdRef = useRef<string | null>(null);
  const workspaceSessionRestoredNoticeRef = useRef(false);
  const restoredTypesettingIdentityRef = useRef<{ pageImageId: string; sourceOcrId: string; pageNumber: number } | null>(null);
  const activeInpaintingIdentityRef = useRef<{ projectId: string; pageNumber: number; pageImageId: string; sourceSha256: string } | null>(null);
  const pendingIssueNavigationRef = useRef<PendingIssueNavigation | null>(null);
  const issueNavigationTokenRef = useRef(0);
  const pageRenderStateRef = useRef<PageImageRenderState>({ status: "ready", currentPage: 1, pageImageId: null, renderRequestKey: "initial", renderGeneration: 0 });
  // The controlled request key is the authority for accepting asynchronous
  // image callbacks. A callback must never promote its own (possibly stale)
  // identity to the active request.
  const currentRenderRequestKeyRef = useRef<string | null>(null);
  const currentRenderGenerationRef = useRef<number | null>(null);
  const readyPageImageIdsRef = useRef(new Set<string>());
  const issueRenderRevisionRef = useRef(0);
  const currentPageRef = useRef(currentPage);

  const closeInpaintingEditor = useCallback(() => {
    setInpaintingEditorOpen(false);
    setInpaintingMaskBbox(null);
  }, []);

  const pageCount = useMemo(() => getPageCount(project.dialogueLines, project.pageImages), [project.dialogueLines, project.pageImages]);

  const currentPageLines = useMemo(
    () => project.dialogueLines.filter((line) => line.pageNumber === currentPage),
    [currentPage, project.dialogueLines]
  );

  const pageSummary = useMemo(() => summarizePageLines(currentPageLines), [currentPageLines]);
  const issueLineItems = useMemo(() => getIssueLineItems(project.dialogueLines), [project.dialogueLines]);
  const pageStripItems = useMemo(
    () => getPageStripItems(project.dialogueLines, project.pageImages ?? [], pageCount),
    [pageCount, project.dialogueLines, project.pageImages]
  );
  const currentPageImage = useMemo(
    () => (project.pageImages ?? []).find((image) => image.pageNumber === currentPage) ?? null,
    [currentPage, project.pageImages]
  );
  useEffect(() => {
    const scope = [
      project.metadata.id,
      projectSessionId ?? "legacy",
      currentPage,
      currentPageImage?.id ?? "none",
      currentPageImage?.storedRelativePath ?? "none",
      currentPageImage?.sha256 ?? "none"
    ].join("\0");
    const previous = manualOperationScopeRef.current;
    manualOperationScopeRef.current = scope;
    if (previous && previous !== scope) {
      cancelActiveOcr();
      cancelActiveInpainting();
    }
  }, [project.metadata.id, projectSessionId, currentPage, currentPageImage?.id, currentPageImage?.storedRelativePath, currentPageImage?.sha256]);
  currentPageRef.current = currentPage;
  issueRenderRevisionRef.current = issueRenderRevision;
  const controlledRenderRequestKey = `${project.metadata.id}:page:${currentPage}:image:${currentPageImage?.id ?? "none"}:issue:${issueRenderRevision}:reset:${imageResetRevision}:viewport:${initialImageViewport?.key ?? "none"}`;
  if (currentRenderRequestKeyRef.current !== controlledRenderRequestKey) {
    currentRenderRequestKeyRef.current = controlledRenderRequestKey;
    currentRenderGenerationRef.current = null;
  }
  activeInpaintingIdentityRef.current = currentPageImage
    ? { projectId: project.metadata.id, pageNumber: currentPage, pageImageId: currentPageImage.id, sourceSha256: currentPageImage.sha256 }
    : null;
  const handleInpaintingMaskBoundsChange = useCallback((bbox: SemanticOverlayBbox | null) => {
    setInpaintingMaskBbox(bbox);
  }, []);
  const handleInpaintingMaskDraftChange = useCallback((draft: InpaintingMaskDraft | null) => {
    if (
      !currentPageImage ||
      activePageImageImportOperationRef.current !== null ||
      activeInpaintingIdentityRef.current?.projectId !== project.metadata.id ||
      activeInpaintingIdentityRef.current.pageNumber !== currentPage ||
      activeInpaintingIdentityRef.current.pageImageId !== currentPageImage.id ||
      activeInpaintingIdentityRef.current.sourceSha256 !== currentPageImage.sha256
    ) {
      return;
    }
    const key = JSON.stringify([project.metadata.id, currentPageImage.id, currentPageImage.sha256]);
    if (draft) {
      inpaintingMaskDraftsRef.current.set(key, { pageImageId: currentPageImage.id, sourceSha256: currentPageImage.sha256, draft });
      setInpaintingMaskBbox(draft.bounds);
    } else {
      inpaintingMaskDraftsRef.current.delete(key);
      setInpaintingMaskBbox(null);
    }
    setInpaintingMaskDraftCount(inpaintingMaskDraftsRef.current.size);
  }, [currentPage, currentPageImage, project.metadata.id]);
  const currentInpaintingMaskDraft = currentPageImage
    ? inpaintingMaskDraftsRef.current.get(JSON.stringify([project.metadata.id, currentPageImage.id, currentPageImage.sha256]))?.draft ?? null
    : null;
  const semanticOverlays = useMemo(
    () => {
      const descriptors = buildSemanticOverlayDescriptors({
        extraction: speechBubbleReview,
        activeItemId: activeReviewItem?.id ?? null,
        inpaintingMaskBbox: inpaintingEditorOpen ? currentInpaintingMaskDraft?.bounds ?? null : null
      });
      if (!currentIssue) return descriptors;
      return [
        ...descriptors,
        {
          id: `issue:${currentIssue.lineId}`,
          kind: "issue" as const,
          bbox: currentIssue.focusBbox ?? { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
          selected: true,
          label: `문제 라인 ${currentIssue.line.order}`,
          accessibleLabel: `문제 라인 ${currentIssue.line.order} 대상`
        }
      ];
    },
    [activeReviewItem?.id, currentInpaintingMaskDraft, currentIssue, inpaintingEditorOpen, speechBubbleReview]
  );
  const typesettingScope = useMemo<TypesettingDraftContext | null>(() => {
    if (!currentPageImage || !activeReviewItem) return null;
    const scope: TypesettingDraftScope = {
      projectId: project.metadata.id,
      pageImageId: currentPageImage.id,
      sourceOcrId: activeReviewItem.id
    };
    const safeArea = deriveTypesettingSafeArea(activeReviewItem.bbox);
    return {
      ...scope,
      pageNumber: currentPage,
      sourceOcrBbox: { ...activeReviewItem.bbox },
      draft: createTypesettingDraft({
        id: `typeset:${project.metadata.id}:${currentPageImage.id}:${activeReviewItem.id}`,
        sourceOcrId: activeReviewItem.id,
        ocrBbox: activeReviewItem.bbox,
        safeArea
      })
    };
  }, [activeReviewItem, currentPage, currentPageImage, project.metadata.id]);
  const typesettingSafeArea = useMemo(
    () => activeReviewItem ? deriveTypesettingSafeArea(activeReviewItem.bbox) : null,
    [activeReviewItem]
  );
  const currentTypesettingDraft = useMemo(() => {
    if (!typesettingDraftContext || !typesettingScope) return null;
    return typesettingDraftContext.projectId === typesettingScope.projectId &&
      typesettingDraftContext.pageImageId === typesettingScope.pageImageId &&
      typesettingDraftContext.sourceOcrId === typesettingScope.sourceOcrId &&
      typesettingDraftContext.pageNumber === typesettingScope.pageNumber
      ? typesettingDraftContext.draft
      : null;
  }, [typesettingDraftContext, typesettingScope]);
  useEffect(() => {
    if (!typesettingScope || !activeReviewItem) {
      setTypesettingDraftContext(null);
      return;
    }
    const loadedDraft = loadTypesettingDraft(window.localStorage, typesettingScope);
    const safeLoadedDraft = loadedDraft
      ? constrainTypesettingDraftToSafeArea(loadedDraft, deriveTypesettingSafeArea(activeReviewItem.bbox))
      : null;
    setTypesettingDraftContext({
      ...typesettingScope,
      draft: safeLoadedDraft ?? typesettingScope.draft
    });
  }, [activeReviewItem, typesettingScope]);
  const handleTypesettingDraftChange = useCallback((draft: TypesettingDraft) => {
    const context = typesettingDraftContext;
    if (!context || draft.sourceOcrId !== context.sourceOcrId) return;
    const scope: TypesettingDraftScope = {
      projectId: context.projectId,
      pageImageId: context.pageImageId,
      sourceOcrId: context.sourceOcrId
    };
    saveTypesettingDraft(window.localStorage, scope, draft);
    setTypesettingDraftContext((current) => current &&
      current.projectId === context.projectId &&
      current.pageImageId === context.pageImageId &&
      current.sourceOcrId === context.sourceOcrId
      ? { ...current, draft }
      : current
    );
  }, [typesettingDraftContext]);
  const currentPageResultContext = pageResultContexts[resultContextKey(project.metadata.id, currentPage)] ?? null;
  const currentPageOriginalImage = currentPageResultContext?.original ?? currentPageImage;
  const currentPageResultLayers = useMemo<Record<ResultLayer, ResultLayerDescriptor>>(() => {
    const pageRecord = project.processing?.pages.find((page) => page.pageImageId === currentPageOriginalImage?.id);
    const activeRun = pageRecord?.activeRunId
      ? project.processing?.runs.find((run) => run.runId === pageRecord.activeRunId)
      : undefined;
    const pendingManualInpainting = Boolean(
      pendingInpaintingContext &&
        pendingInpaintingContext.projectId === project.metadata.id &&
        pendingInpaintingContext.pageNumber === currentPage &&
        pendingInpaintingContext.pageImageId === currentPageImage?.id
    );
    const pipelineProcessing = Boolean(
      activeRun && ["queued", "running", "committing", "cancelling"].includes(activeRun.status)
    );
    const inpaintedProcessing = pipelineProcessing || pendingManualInpainting;
    const cleanedResolution = resolveApprovedResultAsset({
      processing: project.processing,
      pageRecord,
      sourceImage: currentPageOriginalImage,
      layer: "inpainted"
    });
    const translatedResolution = resolveApprovedResultAsset({
      processing: project.processing,
      pageRecord,
      sourceImage: currentPageOriginalImage,
      layer: "translated"
    });
    const cleanedAsset = cleanedResolution.asset;
    const translatedAsset = translatedResolution.asset;
    const contextInpaintedImage = currentPageResultContext?.inpainted;
    const contextTranslatedImage = currentPageResultContext?.translated;
    const inpaintedImage = cleanedResolution.invalidReference
      ? null
      : cleanedAsset && currentPageOriginalImage
        ? contextInpaintedImage?.id === cleanedAsset.assetId &&
          contextInpaintedImage.storedRelativePath === cleanedAsset.storedRelativePath &&
          contextInpaintedImage.sha256 === cleanedAsset.sha256
          ? contextInpaintedImage
          : pageImageFromDerivedAsset(cleanedAsset, currentPageOriginalImage)
        : contextInpaintedImage ?? null;
    const translatedImage = translatedResolution.invalidReference
      ? null
      : translatedAsset && currentPageOriginalImage
        ? contextTranslatedImage?.id === translatedAsset.assetId &&
          contextTranslatedImage.storedRelativePath === translatedAsset.storedRelativePath
          ? contextTranslatedImage
          : pageImageFromDerivedAsset(translatedAsset, currentPageOriginalImage)
        : contextTranslatedImage ?? null;
    const partialFailure = pageRecord?.finalStatus === "needs_review";
    const cleanedResultMessage = cleanedResolution.invalidReference
      ? "저장된 인페인팅 결과 연결이 유효하지 않아 원본을 표시합니다. 다시 생성하세요."
      : undefined;
    const translatedResultMessage = translatedResolution.invalidReference
      ? "저장된 번역 결과 연결이 유효하지 않아 원본을 표시합니다. 다시 생성하세요."
      : undefined;
    return {
      original: createOriginalResultLayer(currentPageOriginalImage),
      inpainted: {
        ...(inpaintedImage
        ? getResultLayerStatus({
            layer: "inpainted",
            image: inpaintedImage,
            sourceImage: currentPageOriginalImage,
            sourceSha256: cleanedResolution.run?.sourceSha256,
            processing: inpaintedProcessing,
            partialFailure,
            fallbackImage: currentPageOriginalImage,
            message: cleanedResultMessage
          })
        : createMissingResultLayer(
            "inpainted",
            inpaintedProcessing
              ? "인페인팅 결과 처리 중입니다."
              : cleanedResultMessage ?? "인페인팅 결과가 아직 없습니다.",
            currentPageOriginalImage,
            { processing: inpaintedProcessing, partialFailure }
          )),
        asset: cleanedAsset,
        inpaintingQa: pageRecord?.inpaintingQa
      },
      translated: translatedImage
        ? getResultLayerStatus({
            layer: "translated",
            image: translatedImage,
            sourceImage: currentPageOriginalImage,
            sourceSha256: translatedResolution.run?.sourceSha256,
            processing: pipelineProcessing,
            partialFailure,
            fallbackImage: currentPageOriginalImage,
            message: translatedResultMessage
          })
        : createMissingResultLayer(
            "translated",
            pipelineProcessing
              ? "번역 결과 처리 중입니다."
              : translatedResultMessage ?? "번역 결과가 아직 생성되지 않았습니다.",
            currentPageOriginalImage,
            { processing: pipelineProcessing, partialFailure }
          )
    };
  }, [
    currentPageImage,
    currentPageOriginalImage,
    currentPageResultContext,
    currentPage,
    pendingInpaintingContext,
    project.metadata.id,
    project.processing
  ]);
  const currentCleanedInspection = useMemo(() => currentPageImage
    ? inspectApprovedCleanedAsset(project, currentPageImage)
    : null, [project.processing, currentPageImage]);
  const currentFilePathRef = useRef(currentFilePath);
  const currentPageImageRef = useRef(currentPageImage);
  const projectIdRef = useRef(project.metadata.id);
  const resultContextProjectIdRef = useRef(project.metadata.id);
  const imageRelinkProcessingDisabledReason = isInpainting || isExtractingSpeechBubbles
    ? "현재 페이지 처리가 끝난 뒤 이미지를 다시 연결하세요."
    : undefined;
  const imageImportDisabledReason =
    sessionNeedsRecovery
      ? projectSessionRecoveryMessage
      : getImageImportDisabledReason(project.metadata.secret, currentFilePath) ??
        imageRelinkProcessingDisabledReason;
  const environmentSnapshotPendingReason =
    "환경 상태를 확인하는 중입니다. 환경 준비에서 다시 확인하세요.";
  const environmentSnapshotAvailable = Boolean(window.projectApi?.getEnvironmentSnapshot);
  const pendingPageImageProcessingReason = pendingPageNumbers.includes(currentPage)
    ? "새로 연결한 이미지를 먼저 저장해야 OCR/인페인팅할 수 있습니다."
    : undefined;
  const ocrEnvironmentDisabledReason = environmentSnapshot
    ? getCapabilityDisabledReason(environmentSnapshot, "ocr")
    : environmentSnapshotAvailable
      ? environmentSnapshotPendingReason
      : undefined;
  const inpaintingEnvironmentDisabledReason = environmentSnapshot
    ? getCapabilityDisabledReason(environmentSnapshot, "inpainting")
    : environmentSnapshotAvailable
      ? environmentSnapshotPendingReason
      : undefined;
  const ocrDisabledReason = sessionNeedsRecovery
    ? projectSessionRecoveryMessage
    : pendingPageImageProcessingReason ?? ocrEnvironmentDisabledReason;
  const inpaintingDisabledReason = sessionNeedsRecovery
    ? projectSessionRecoveryMessage
    : pendingPageImageProcessingReason ?? inpaintingEnvironmentDisabledReason;
  const apiReady = Boolean(window.projectApi);
  const workspacePresentation = getWorkspacePresentation({
    currentFilePath,
    lineCount: project.dialogueLines.length,
    imageCount: project.pageImages?.length ?? 0,
    isDirty,
    apiReady
  });
  const focusDeckProjectKey = currentFilePath ?? `${project.metadata.title}:unsaved`;
  const workspaceProjectKey = activeRecentProjectId ?? project.metadata.id;
  const workspaceIdentity: WorkspaceSessionIdentity = {
    projectId: project.metadata.id,
    projectKey: workspaceProjectKey,
    recentProjectId: activeRecentProjectId,
    revision: projectRevision
  };
  const workspaceIdentityKey = `${workspaceIdentity.projectId}:${workspaceIdentity.projectKey}:${workspaceIdentity.recentProjectId ?? ""}:${workspaceIdentity.revision}`;

  projectRef.current = project;
  selectedLineIdRef.current = selectedLineId;
  activeRecentProjectIdRef.current = activeRecentProjectId;

  useEffect(() => {
    const active = activeAiTranslationRequestRef.current;
    if (!active) return;
    if (
      active.projectSessionId !== projectSessionIdRef.current ||
      active.sessionGeneration !== sessionGenerationRef.current ||
      active.projectId !== project.metadata.id ||
      active.targetLineId !== selectedLineId
    ) {
      cancelActiveAiTranslation();
      return;
    }
    if (!active.contextFingerprint) return;
    try {
      const payload = buildTranslationContextPayload({
        dialogueLines: project.dialogueLines,
        targetLineId: active.targetLineId,
        characters: project.characters,
        dictionaryTerms: project.dictionaryTerms,
        stylePreset: active.stylePreset
      });
      if (computeTranslationPayloadFingerprint(payload) !== active.contextFingerprint) {
        cancelActiveAiTranslation();
      }
    } catch {
      cancelActiveAiTranslation();
    }
  }, [project, selectedLineId]);

  useEffect(() => () => {
    cancelActiveAiTranslation({ updateUi: false });
  }, []);

  function setProgrammaticResultLayer(layer: ResultLayer) {
    resultLayerRef.current = layer;
    setResultLayer(layer);
  }

  function setRestoredResultLayer(layer: ResultLayer) {
    // A restored selection is user intent.  Advance the same revision fence
    // used by asynchronous inpainting so a late completion cannot silently
    // replace it with its default result layer.
    resultLayerUserRevisionRef.current += 1;
    setProgrammaticResultLayer(layer);
  }

  function handleUserResultLayerChange(layer: ResultLayer) {
    resultLayerRef.current = layer;
    resultLayerUserRevisionRef.current += 1;
    setResultLayer(layer);
  }

  function confirmDisplayedCleanedAsset(assetId: string) {
    const page = currentPageImageRef.current;
    const viewedAsset = currentCleanedInspection?.asset;
    if (!page || !viewedAsset || viewedAsset.assetId !== assetId || resultLayerRef.current !== "inpainted" ||
      cleanedReviewOperationRef.current) return;
    const latest = inspectApprovedCleanedAsset(projectRef.current, page);
    if (latest.status !== "valid" || latest.asset?.assetId !== assetId ||
      latest.asset.sha256 !== viewedAsset.sha256 || latest.asset.storedRelativePath !== viewedAsset.storedRelativePath ||
      page.sha256 !== currentPageImage?.sha256) {
      setStatusMessage("배경 정리 결과가 바뀌었습니다. 현재 결과를 다시 확인하세요.");
      return;
    }
    const operation = queueCleanedAssetReview({
      pageImageId: page.id,
      cleanedAssetId: assetId,
      // Use the revision from this rendered view, never a later ref value.
      expectedRevision: projectRevision
    });
    if (!operation) {
      setStatusMessage("프로젝트 변경을 반영한 뒤 배경 정리 결과를 다시 확인하세요.");
      return;
    }
    cleanedReviewOperationRef.current = operation;
    setCleanedReviewInFlight(true);
    void operation.finally(() => {
      if (cleanedReviewOperationRef.current === operation) {
        cleanedReviewOperationRef.current = null;
        setCleanedReviewInFlight(false);
      }
    });
  }

  const handleWorkspaceComparisonStateChange = useCallback((comparison: WorkspaceSessionComparison) => {
    setWorkspaceComparison((current) => (
      current.mode === comparison.mode &&
      current.revealPosition === comparison.revealPosition &&
      current.opacity === comparison.opacity
        ? current
        : comparison
    ));
  }, []);

  useEffect(() => {
    if (resultContextProjectIdRef.current === project.metadata.id) return;
    resultContextProjectIdRef.current = project.metadata.id;
    setPageResultContexts({});
    setProgrammaticResultLayer("original");
  }, [project.metadata.id]);

  useEffect(() => {
    setPageResultContexts((current) => {
      let next = current;
      for (const pageImage of project.pageImages ?? []) {
        const key = resultContextKey(project.metadata.id, pageImage.pageNumber);
        const existing = current[key];
        if (!existing) {
          if (next === current) next = { ...current };
          next[key] = { original: pageImage, inpainted: null, translated: null };
          continue;
        }
        if (!existing.original) {
          if (next === current) next = { ...current };
          next[key] = { ...existing, original: pageImage };
        }
      }
      return next;
    });
  }, [project.metadata.id, project.pageImages]);

  useEffect(() => {
    const api = window.projectApi;
    if (
      !api?.createProjectSession ||
      projectSessionId ||
      startupRestoreAttemptedRef.current ||
      startupRestoreInFlightRef.current
    ) return;
    let active = true;
    startupRestoreInFlightRef.current = true;
    setProjectSessionReadiness("initializing");
    const requestId = ++initialSessionRequestIdRef.current;
    const createInitialOnly = retryInitialSessionOnlyRef.current;
    retryInitialSessionOnlyRef.current = false;
    const persisted = loadWorkspaceSession(window.localStorage);
    const recentProjectId = getWorkspaceSessionRecentProjectId(persisted);
    const createInitialSession = () => {
      const initialProject = projectRef.current;
      const request = api.createProjectSession!({ title: initialProject.metadata.title, secret: false });
      initialSessionPromiseRef.current = request;
      return request.then((created) => {
        if (!active || requestId !== initialSessionRequestIdRef.current) {
          if (api.closeProject) void api.closeProject({ projectSessionId: created.projectSessionId });
          return;
        }
        const desiredProject = projectRef.current;
        const changedWhileCreating = JSON.stringify(desiredProject) !== JSON.stringify(initialProject);
        installSessionResult(created, false);
        if (changedWhileCreating) {
          projectRef.current = desiredProject;
          setProject(desiredProject);
          setIsDirty(true);
          queueProjectDiff(created.project.project, desiredProject);
        }
      });
    };

    const continueAfterRecent = (result: Awaited<ReturnType<NonNullable<typeof api.openRecentProject>>>) => {
      if (!active || requestId !== initialSessionRequestIdRef.current) {
        if (result && isProjectSessionResult(result) && api.closeProject) {
          void api.closeProject({ projectSessionId: result.projectSessionId });
        }
        return null;
      }
      if (result && isProjectSessionResult(result)) {
        workspaceRestoreSnapshotRef.current = persisted;
        installSessionResult(result, true, recentProjectId ?? undefined);
        installOpenedSessionProject(result);
        return null;
      }
      if (result && isPasswordRequiredResult(result)) {
        setProjectSessionReadiness("password-required");
        setStatusMessage("이전 프로젝트를 복원하려면 홈에서 암호를 입력해 여세요.");
        return null;
      }
      return createInitialSession();
    };

    const startupRequest = (api.getProviderSettings
      ? api.getProviderSettings().catch(() => null)
      : Promise.resolve(null)
    ).then((settings) => {
      if (active && requestId === initialSessionRequestIdRef.current &&
        (settings?.theme === "light" || settings?.theme === "dark")) {
        const theme = settings.theme;
        // A stored choice or an edit made during the lookup always takes precedence.
        setUiTheme((current) => current ?? theme);
      }
      if (settings?.startScreen === "projects") {
        dispatchEntryFlow({ type: "navigate", screen: "projects" });
        return createInitialSession();
      }
      if (createInitialOnly) return createInitialSession();
      return recentProjectId && api.openRecentProject
        ? Promise.resolve(api.openRecentProject({ recentProjectId }))
            .then(continueAfterRecent, () => {
              if (active) {
                setStatusMessage(
                  "최근 프로젝트를 복원하지 못해 안전한 새 프로젝트 세션을 준비합니다."
                );
              }
              return createInitialSession();
            })
        : createInitialSession();
    });
    void startupRequest.catch((error) => {
      if (active) {
        setProjectSessionReadiness("error");
        setStatusMessage(
          error instanceof Error
            ? `프로젝트 세션을 준비하지 못했습니다: ${error.message}`
            : "프로젝트 세션을 준비하지 못했습니다."
        );
      }
    }).finally(() => {
      if (initialSessionPromiseRef.current) initialSessionPromiseRef.current = null;
      startupRestoreAttemptedRef.current = true;
      startupRestoreInFlightRef.current = false;
    });
    return () => {
      active = false;
    };
  }, [projectSessionId, sessionBootstrapAttempt]);

  function retryProjectSessionBootstrap() {
    if (!window.projectApi?.createProjectSession || startupRestoreInFlightRef.current) {
      return;
    }
    startupRestoreAttemptedRef.current = false;
    retryInitialSessionOnlyRef.current = true;
    setProjectSessionReadiness("initializing");
    setStatusMessage("프로젝트 세션을 다시 준비하는 중입니다.");
    setSessionBootstrapAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    const api = window.projectApi;
    if (!api?.listRecentProjects) return;
    void api.listRecentProjects().then((items) => {
      setRecentProjects(items);
      setRecentProjectsError(null);
    }).catch(() => {
      setRecentProjectsError("최근 프로젝트 목록을 불러오지 못했습니다.");
    });
  }, [recentProjectsReloadAttempt]);

  useEffect(() => {
    if (entryFlow.screen !== "workspace" || !window.projectApi?.getEnvironmentSnapshot) return;
    void refreshEnvironmentPreparation();
  }, [entryFlow.screen]);

  useEffect(() => {
    const api = window.projectApi;
    if (!api?.getAutoUpdateState) return;
    let active = true;
    void api.getAutoUpdateState().then((state) => {
      if (active) setAutoUpdateState(state);
    }).catch(() => {
      if (active) {
        setAutoUpdateState(createAutoUpdateState("error", {
          message: "업데이트 상태를 불러오지 못했습니다. 다시 확인해 보세요."
        }));
      }
    });
    const unsubscribe = api.onAutoUpdateState?.((state) => {
      if (active) setAutoUpdateState(state);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    setHydratedPreferenceKey(null);
    const preferences = loadFocusDeckPreferences(window.localStorage, focusDeckProjectKey);
    const changedProject = preferenceProjectIdRef.current !== project.metadata.id;
    preferenceProjectIdRef.current = project.metadata.id;
    setWorkspacePanels((current) => changedProject ? {
      pagesOpen: false,
      inspectorOpen: false,
      resultsOpen: false,
      focusMode: false,
      inspectorWidth: preferences.inspectorWidth
    } : current);
    if (!changedProject) {
      setHydratedPreferenceKey(focusDeckProjectKey);
      return;
    }
    setWorkspaceZoom(preferences.zoom);
    const preferredViewport: ImageViewportState = {
      ...createImageViewportState(),
      viewMode: preferences.zoom === 1 ? "fit" : "actual",
      zoom: preferences.zoom
    };
    setWorkspaceViewport(preferredViewport);
    viewportSeedRevisionRef.current += 1;
    setInitialImageViewport({
      key: `${focusDeckProjectKey}:${viewportSeedRevisionRef.current}`,
      ...preferredViewport
    });
    setHydratedPreferenceKey(focusDeckProjectKey);
  }, [focusDeckProjectKey]);

  useEffect(() => {
    if (hydratedPreferenceKey !== focusDeckProjectKey) return;
    saveFocusDeckPreferences(window.localStorage, focusDeckProjectKey, {
      ...workspacePanels,
      zoom: workspaceZoom
    });
  }, [focusDeckProjectKey, hydratedPreferenceKey, workspacePanels, workspaceZoom]);

  useEffect(() => {
    if (
      entryFlow.screen !== "workspace" ||
      !projectSessionId ||
      hydratedPreferenceKey !== focusDeckProjectKey ||
      workspaceSessionHydratedKey === workspaceIdentityKey
    ) return;
    const persisted = workspaceRestoreSnapshotRef.current ?? loadWorkspaceSession(window.localStorage);
    const lineIds = new Set(project.dialogueLines.map((line) => line.id));
    const issueLineIds = new Set(issueLineItems.map((item) => item.line.id));
    const validation = validateWorkspaceSession(
      persisted,
      workspaceIdentity,
      pageCount,
      { lineIds, issueLineIds }
    );
    if (validation.valid) {
      const restored = validation.snapshot;
      setCurrentPage(restored.currentPage);
      setSelectedLineId(restored.selectedLineId);
      if (!workspaceSessionSaveEnabledRef.current) {
        setWorkspacePanels({ ...restored.workspacePanels, pagesOpen: false, inspectorOpen: false, resultsOpen: false, focusMode: false });
      }
      setBottomPanel(restored.bottomPanel);
      setDialogueView(restored.dialogueView);
      setWorkspaceComparison(restored.comparison);
      setWorkspaceComparisonHydrationRevision((current) => current + 1);
      setRestoredResultLayer(restored.resultLayer);
      setVisibleOverlayKinds([...restored.visibleOverlays]);
      setWorkspaceZoom(restored.viewport.zoom);
      setWorkspaceViewport(restored.viewport);
      viewportSeedRevisionRef.current += 1;
      setInitialImageViewport({
        key: `${project.metadata.id}:workspace-restore:${viewportSeedRevisionRef.current}`,
        ...restored.viewport
      });
      dispatchIssueEditor({
        type: "hydrate",
        activeEditor: restored.issueEditor.activeEditor,
        pinned: restored.issueEditor.pinned
      });
      restoredTypesettingIdentityRef.current = null;
      setTypesettingDraftContext(null);
      if (restored.currentIssue) {
        const line = project.dialogueLines.find((candidate) => candidate.id === restored.currentIssue?.lineId);
        const target = line
          ? prepareIssueNavigation(line, { focusBbox: findIssueFocusBbox(line, null) })
          : null;
        setCurrentIssue(target);
        setIssueEditor(target?.editor ?? restored.issueEditor.activeEditor);
        if (target) {
          setVisibleOverlayKinds((current) => [
            ...new Set([
              ...current,
              ...target.requiredOverlays
            ])
          ]);
        }
      } else {
        setCurrentIssue(null);
        setIssueEditor(restored.issueEditor.activeEditor);
      }
      if (restored.drafts.translationLineId && restored.drafts.translationSourceIdentity) {
        const line = project.dialogueLines.find((candidate) => candidate.id === restored.drafts.translationLineId);
        if (line && createTranslationSourceIdentity(line.sourceText) === restored.drafts.translationSourceIdentity) {
          const scope: TranslationDraftScope = {
            projectId: project.metadata.id,
            projectRevision,
            lineId: line.id,
            sourceIdentity: restored.drafts.translationSourceIdentity,
            lineStatus: line.lineStatus ?? "untranslated"
          };
          const draft = loadTranslationDraft(window.localStorage, scope);
          if (draft !== null) setTranslationDraftContext({ ...scope, text: draft });
        }
      }
      if (restored.drafts.typesettingPageImageId && restored.drafts.typesettingSourceOcrId && restored.drafts.typesettingSourceOcrBbox) {
        const pageImage = project.pageImages.find((candidate) => candidate.id === restored.drafts.typesettingPageImageId);
        if (pageImage && pageImage.pageNumber === restored.currentPage) {
          const typesettingScope: TypesettingDraftScope = {
            projectId: project.metadata.id,
            pageImageId: pageImage.id,
            sourceOcrId: restored.drafts.typesettingSourceOcrId
          };
          const draft = loadTypesettingDraft(window.localStorage, typesettingScope);
          if (draft) {
            restoredTypesettingIdentityRef.current = {
              pageImageId: pageImage.id,
              sourceOcrId: draft.sourceOcrId,
              pageNumber: pageImage.pageNumber
            };
            setTypesettingDraftContext({
              ...typesettingScope,
              pageNumber: pageImage.pageNumber,
              sourceOcrBbox: { ...restored.drafts.typesettingSourceOcrBbox },
              draft
            });
            setActiveReviewItem(createRestoredTypesettingReviewItem(draft, restored.drafts.typesettingSourceOcrBbox));
          }
        }
      }
      if (!workspaceSessionRestoredNoticeRef.current) {
        workspaceSessionRestoredNoticeRef.current = true;
        setStatusMessage("이전 작업 문맥을 복원했습니다.");
      }
    }
    workspaceRestoreSnapshotRef.current = null;
    workspaceSessionSaveEnabledRef.current = true;
    setWorkspaceSessionHydratedKey(workspaceIdentityKey);
  }, [
    entryFlow.screen,
    focusDeckProjectKey,
    hydratedPreferenceKey,
    issueLineItems,
    pageCount,
    project,
    projectRevision,
    projectSessionId,
    workspaceIdentity,
    workspaceIdentityKey
  ]);

  const selectedLine = useMemo(
    () => project.dialogueLines.find((line) => line.id === selectedLineId) ?? null,
    [project.dialogueLines, selectedLineId]
  );
  useEffect(() => {
    if (!selectedLine || selectedLine.lineStatus === "complete") {
      setTranslationDraftContext(null);
      return;
    }
    const scope: TranslationDraftScope = {
      projectId: project.metadata.id,
      projectRevision,
      lineId: selectedLine.id,
      sourceIdentity: createTranslationSourceIdentity(selectedLine.sourceText),
      lineStatus: selectedLine.lineStatus ?? "untranslated"
    };
    const draft = loadTranslationDraft(window.localStorage, scope);
    if (!draft || draft === selectedLine.userTranslation) {
      setTranslationDraftContext(null);
      return;
    }
    setTranslationDraftContext({ ...scope, text: draft });
    if (!workspaceSessionRestoredNoticeRef.current) {
      setStatusMessage("저장된 번역 초안을 복원했습니다.");
    }
  }, [project.metadata.id, projectRevision, selectedLine]);
  const selectedLineDraft = translationDraftContext && selectedLine &&
    translationDraftContext.projectId === project.metadata.id &&
    translationDraftContext.lineId === selectedLine.id &&
    translationDraftContext.sourceIdentity === createTranslationSourceIdentity(selectedLine.sourceText)
    ? translationDraftContext.text
    : null;
  const selectedLineForEditor: DialogueLine | null = selectedLineDraft === null || !selectedLine
    ? selectedLine
    : {
      ...selectedLine,
      userTranslation: selectedLineDraft,
      lineStatus: selectedLine.lineStatus === "review" ? ("review" as const) : ("draft" as const)
    };
  const manualTypesettingKey = currentPageImage && selectedLineForEditor && selectedLineForEditor.pageNumber === currentPage
    ? JSON.stringify([project.metadata.id, currentPageImage.id, currentPageImage.sha256, selectedLineForEditor.id])
    : null;
  const manualTypesettingDraft = manualTypesettingKey ? manualTypesettingDraftsRef.current.get(manualTypesettingKey) : undefined;

  function updateManualTypesettingDraft(update: { bbox?: NormalizedBbox | null; fields?: ManualTypesettingBoxFields }) {
    if (!manualTypesettingKey || !currentPageImage || !selectedLineForEditor || activePageImageImportOperationRef.current) return;
    const current = manualTypesettingDraftsRef.current.get(manualTypesettingKey) ?? {
      projectId: project.metadata.id, pageImageId: currentPageImage.id, sourceSha256: currentPageImage.sha256, lineId: selectedLineForEditor.id,
      bbox: selectedLineForEditor.typesetting?.bbox ?? null
    };
    manualTypesettingDraftsRef.current.set(manualTypesettingKey, { ...current, ...update });
    setManualTypesettingDraftCount(manualTypesettingDraftsRef.current.size);
    setManualTypesettingDraftVersion((version) => version + 1);
  }

  function remapManualTypesettingDrafts(clientLineId: string, mainLineId: string) {
    let changed = false;
    for (const [key, draft] of manualTypesettingDraftsRef.current) {
      if (draft.lineId !== clientLineId || draft.projectId !== projectRef.current.metadata.id) continue;
      const nextKey = JSON.stringify([draft.projectId, draft.pageImageId, draft.sourceSha256, mainLineId]);
      manualTypesettingDraftsRef.current.delete(key);
      manualTypesettingDraftsRef.current.set(nextKey, { ...draft, lineId: mainLineId });
      changed = true;
    }
    if (changed) setManualTypesettingDraftVersion((version) => version + 1);
  }

  function applyManualTypesettingBox(bbox: NormalizedBbox) {
    if (!manualTypesettingKey || !currentPageImage || !selectedLineForEditor || activePageImageImportOperationRef.current || !isValidTypesettingBbox(bbox) || blockProjectSessionRecovery()) return;
    const latestPage = currentPageImageRef.current;
    const latestLine = projectRef.current.dialogueLines.find((line) => line.id === selectedLineForEditor.id);
    if (!latestPage || latestPage.id !== currentPageImage.id || latestPage.sha256 !== currentPageImage.sha256 ||
      selectedLineIdRef.current !== selectedLineForEditor.id || latestLine?.pageNumber !== currentPage) {
      setStatusMessage("대사나 페이지가 바뀌었습니다. 영역을 다시 확인하세요.");
      return;
    }
    const typesetting = { ...latestLine.typesetting, bbox: { ...bbox }, writingMode: latestLine.typesetting?.writingMode ?? "horizontal-tb" as const };
    const submitted = manualTypesettingDraftsRef.current.get(manualTypesettingKey);
    const clearSubmittedDraft = () => {
      if (manualTypesettingDraftsRef.current.get(manualTypesettingKey) !== submitted) return;
      manualTypesettingDraftsRef.current.delete(manualTypesettingKey);
      setManualTypesettingDraftCount(manualTypesettingDraftsRef.current.size);
      setManualTypesettingDraftVersion((version) => version + 1);
    };
    const queued = queueSessionMutation({ type: "update_dialogue_typesetting", lineId: latestLine.id, typesetting }, undefined, (result, adopted) => {
      if (result?.status === "applied" && adopted) {
        clearSubmittedDraft();
        setStatusMessage("글자 배치 영역을 적용했습니다. 프로젝트를 저장하세요.");
      }
    });
    if (!queued && sessionPersistenceRequired) {
      setStatusMessage("프로젝트 세션을 준비한 뒤 영역을 다시 적용하세요.");
      return;
    }
    setProject((current) => ({
      ...current,
      dialogueLines: current.dialogueLines.map((line) => line.id === latestLine.id ? { ...line, typesetting } : line),
      metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
    }));
    setIsDirty(true);
    if (!queued) {
      clearSubmittedDraft();
      setStatusMessage("글자 배치 영역을 적용했습니다. 프로젝트를 저장하세요.");
    }
  }
  useEffect(() => {
    if (
      !workspaceSessionSaveEnabledRef.current ||
      entryFlow.screen !== "workspace" ||
      hydratedPreferenceKey !== focusDeckProjectKey ||
      workspaceSessionHydratedKey !== workspaceIdentityKey
    ) return;
    const viewport = workspaceViewport ?? {
      ...createImageViewportState(),
      viewMode: workspaceZoom === 1 ? "fit" : "actual",
      zoom: workspaceZoom
    };
    const snapshot = createWorkspaceSessionSnapshot({
      identity: workspaceIdentity,
      currentPage,
      pageCount,
      viewport,
      comparison: workspaceComparison,
      resultLayer,
      visibleOverlays: visibleOverlayKinds,
      workspacePanels,
      bottomPanel,
      dialogueView,
      selectedLineId,
      currentIssue: currentIssue
        ? { lineId: currentIssue.lineId, kind: currentIssue.kind, editor: currentIssue.editor }
        : null,
      issueEditor: {
        activeEditor: issueEditorState.activeEditor,
        pinned: issueEditorState.pinned
      },
      drafts: {
        translationLineId: translationDraftContext?.lineId ?? null,
        translationSourceIdentity: translationDraftContext?.sourceIdentity ?? null,
        typesettingPageImageId: typesettingDraftContext?.pageImageId ?? null,
        typesettingSourceOcrId: typesettingDraftContext?.sourceOcrId ?? null,
        typesettingSourceOcrBbox: typesettingDraftContext?.sourceOcrBbox ?? null
      },
      lifecycle: "active"
    });
    saveWorkspaceSession(window.localStorage, snapshot);
  }, [
    bottomPanel,
    currentIssue,
    currentPage,
    dialogueView,
    entryFlow.screen,
    focusDeckProjectKey,
    hydratedPreferenceKey,
    issueEditorState.activeEditor,
    issueEditorState.pinned,
    pageCount,
    resultLayer,
    selectedLineId,
    translationDraftContext,
    typesettingDraftContext,
    visibleOverlayKinds,
    workspaceComparison,
    workspaceIdentity,
    workspacePanels,
    workspaceSessionHydratedKey,
    workspaceViewport,
    workspaceZoom
  ]);

  useEffect(() => {
    const handlePageHide = () => {
      if (workspaceSessionSaveEnabledRef.current) markWorkspaceSessionClosed(window.localStorage);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);
  const issueEditorProjectKey = project.metadata.id;

  useEffect(() => {
    const preference = loadIssueEditorPreference(window.localStorage, issueEditorProjectKey);
    dispatchIssueEditor({
      type: "hydrate",
      activeEditor: preference?.activeEditor ?? null,
      pinned: preference?.pinned ?? false
    });
    setIssueEditorHydratedProjectKey(issueEditorProjectKey);
  }, [issueEditorProjectKey]);

  useEffect(() => {
    if (issueEditorHydratedProjectKey !== issueEditorProjectKey) return;
    saveIssueEditorPreference(window.localStorage, issueEditorProjectKey, {
      activeEditor: issueEditorState.activeEditor,
      pinned: issueEditorState.pinned
    });
  }, [issueEditorHydratedProjectKey, issueEditorProjectKey, issueEditorState.activeEditor, issueEditorState.pinned]);

  useEffect(() => {
    dispatchIssueEditor({
      type: "issue-confirmed",
      requiredEditor: currentIssue?.editor ?? null
    });
  }, [currentIssue?.editor, currentIssue?.lineId]);

  useEffect(() => {
    if (currentIssue && !project.dialogueLines.some((line) => line.id === currentIssue.lineId)) {
      pendingIssueNavigationRef.current = null;
      setCurrentIssue(null);
      setIssueFocusRequest(null);
      setIssueEditor(null);
    }
  }, [currentIssue, project.dialogueLines]);
  useEffect(() => {
    const pending = pendingIssueNavigationRef.current;
    if (!pending) return;
    const targetLine = project.dialogueLines.find((line) => line.id === pending.target.lineId);
    const targetImageId = (project.pageImages ?? []).find(
      (image) => image.pageNumber === pending.target.pageNumber
    )?.id ?? null;
    if (
      pending.projectId !== project.metadata.id ||
      !targetLine ||
      targetImageId !== pending.expectedPageImageId
    ) {
      rollbackIssueNavigation(pending, "대상 문제가 변경되어 이동 문맥을 복원했습니다.");
    }
  }, [project]);
  const guidedStage = getGuidedStage({
    hasReview: Boolean(speechBubbleReview),
    reviewStage,
    hasSelectedLine: Boolean(selectedLine)
  });
  const guidedSummaries = {
    ocr: activeReviewItem?.text.trim() || selectedLine?.sourceText || "OCR 후보를 선택하세요.",
    speaker: activeReviewItem?.selectedSpeaker.trim() || selectedLine?.speaker || "화자를 확인하세요.",
    translation: selectedLineForEditor?.userTranslation?.trim() || selectedLineForEditor?.sourceText || "번역할 대사가 없습니다.",
    complete: `현재 페이지 완료 ${pageSummary.completeCount}개`
  };
  const hasActionableProjectLines = useMemo(
    () => project.dialogueLines.some((line) => (line.lineStatus ?? "untranslated") !== "complete"),
    [project.dialogueLines]
  );
  const nextActionableProjectLine = useMemo(
    () =>
      [...project.dialogueLines]
        .sort((left, right) => left.pageNumber - right.pageNumber || left.order - right.order)
        .find((line) => (line.lineStatus ?? "untranslated") !== "complete") ?? null,
    [project.dialogueLines]
  );
  const workspaceMode: WorkspaceMode = speechBubbleReview
    ? "ocr-review"
    : inpaintingEditorOpen
      ? "inpainting"
      : selectedLine
        ? "line-edit"
      : "viewer";
  useEffect(() => {
    document.documentElement.dataset.theme = uiThemeChoice ?? "dark";
    if (uiThemeChoice !== null) window.localStorage.setItem("trio:ui-theme", uiThemeChoice);
  }, [uiThemeChoice]);
  useLayoutEffect(() => {
    entryPrimaryActionRef.current = () => {
      if (entryFlow.screen === "home") {
        beginNewImageProject();
        return true;
      }
      if (
        entryFlow.screen === "setup" &&
        !projectSetup.isPreparing &&
        activeProjectCreateTokenRef.current === null
      ) {
        if (projectSetup.files.length > 0) {
          void confirmProjectSetup();
        } else {
          void chooseProjectSetupImages();
        }
        return true;
      }
      return false;
    };
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (dialogs.isPending()) return;
      if (finalReading && entryFlow.screen === "workspace") {
        if (event.key === "Escape") {
          event.preventDefault();
          setFinalReading(false);
          return;
        }
        const pageNavigation = !event.ctrlKey && !event.altKey && !event.metaKey &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight");
        const fileOrViewControl = event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey &&
          ["s", "o", "n", "b", "=", "+", "-", "0"].includes(event.key.toLowerCase());
        if (!pageNavigation && !fileOrViewControl) return;
      }
      const eventTarget = event.target instanceof HTMLElement ? event.target : null;
      const target = eventTarget?.matches("input, textarea, select, [contenteditable='true']")
        ? eventTarget
        : document.activeElement as HTMLElement | null;
      const isEditable = target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
      const isTranslationEditor = target?.matches("textarea.user-translation-editor") ?? false;
      const isExactCtrlEnter = event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key === "Enter";

      if (
        entryFlow.screen === "workspace" &&
        isExactCtrlEnter &&
        !event.isComposing &&
        (isTranslationEditor || !isEditable)
      ) {
        const primaryAction = stageEditorPrimaryActionRef.current;
        if (primaryAction && !primaryAction.disabled) {
          event.preventDefault();
          primaryAction.click();
        }
        return;
      }
      if (isEditable) return;

      if (entryFlow.screen !== "workspace") {
        if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key === "Enter") {
          if (entryPrimaryActionRef.current?.()) {
            event.preventDefault();
          }
        }
        return;
      }

      if (inpaintingEditorOpen || batchModalOpen) {
        if (event.key === "Escape" && inpaintingEditorOpen) {
          event.preventDefault();
          closeInpaintingEditor();
        }
        return;
      }

      if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        if ((event.key === " " || event.key === "Spacebar") && !event.repeat) {
          const isInteractiveElement = target?.matches("button, summary, a, [role='button'], [role='tab'], [role='checkbox'], [role='radio']");
          if (isInteractiveElement) return;
          const canRunSpaceOcr = Boolean(
            currentPageImage &&
            currentFilePath &&
            !isExtractingSpeechBubbles &&
            !inpaintingEditorOpen &&
            !speechBubbleReview
          );
          if (ocrDisabledReason && canRunSpaceOcr) {
            event.preventDefault();
            setStatusMessage(ocrDisabledReason);
            return;
          }
          if (canRunSpaceOcr) {
            event.preventDefault();
            void extractSpeechBubblesFromCurrentPage();
          }
          return;
        }

        if (event.key === "Escape") {
          if (inpaintingEditorOpen) {
            event.preventDefault();
            closeInpaintingEditor();
            return;
          }
          if (workspacePanels.pagesOpen || workspacePanels.inspectorOpen || workspacePanels.resultsOpen) {
            event.preventDefault();
            setWorkspacePanels((current) => ({
              ...current,
              pagesOpen: false,
              inspectorOpen: false,
              resultsOpen: false
            }));
            return;
          }
        }

        if (event.key === "ArrowRight") {
          if (currentPage < pageCount) {
            event.preventDefault();
            setPageAndSelection(currentPage + 1);
          }
          return;
        }

        if (event.key === "ArrowLeft") {
          if (currentPage > 1) {
            event.preventDefault();
            setPageAndSelection(currentPage - 1);
          }
          return;
        }

        if (event.key === "ArrowDown" && selectedLineId) {
          event.preventDefault();
          moveSelectedLine(1);
          return;
        }

        if (event.key === "ArrowUp" && selectedLineId) {
          event.preventDefault();
          moveSelectedLine(-1);
          return;
        }

        if (event.key === "[") {
          if (inpaintingEditorOpen) return;
          if (issueLineItems.length > 0) {
            event.preventDefault();
            const currentIndex = issueLineItems.findIndex((item) => item.line.id === currentIssue?.lineId || item.line.id === selectedLineId);
            const prevIndex = currentIndex <= 0 ? issueLineItems.length - 1 : currentIndex - 1;
            selectIssueLine(issueLineItems[prevIndex].line);
          }
          return;
        }

        if (event.key === "]") {
          if (inpaintingEditorOpen) return;
          if (issueLineItems.length > 0) {
            event.preventDefault();
            const currentIndex = issueLineItems.findIndex((item) => item.line.id === currentIssue?.lineId || item.line.id === selectedLineId);
            const nextIndex = currentIndex < 0 || currentIndex >= issueLineItems.length - 1 ? 0 : currentIndex + 1;
            selectIssueLine(issueLineItems[nextIndex].line);
          }
          return;
        }

        if (event.key === "Enter") {
          if (!ownsWorkspacePlainEnter(event)) return;
          const primaryAction = stageEditorPrimaryActionRef.current;
          if (primaryAction && !primaryAction.disabled) {
            event.preventDefault();
            primaryAction.click();
          }
          return;
        }
      }

      if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
        if (selectedLineId && event.key === "ArrowDown") {
          event.preventDefault();
          moveSelectedLine(1);
          return;
        }

        if (selectedLineId && event.key === "ArrowUp") {
          event.preventDefault();
          moveSelectedLine(-1);
          return;
        }

        if (selectedLineId && event.key === "1") {
          event.preventDefault();
          updateSelectedLineStatus("draft");
          return;
        }

        if (selectedLineId && event.key === "2") {
          event.preventDefault();
          updateSelectedLineStatus("complete");
          return;
        }

        if (selectedLineId && event.key === "3") {
          event.preventDefault();
          updateSelectedLineStatus("review");
          return;
        }

        if ((event.key === "t" || event.key === "T") && selectedLineForEditor) {
          event.preventDefault();
          void handleRequestAiTranslation(selectedLineForEditor);
          return;
        }

        return;
      }

      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;

      const keyLower = event.key.toLowerCase();

      if (keyLower === "s") {
        event.preventDefault();
        void saveProject();
        return;
      }

      if (keyLower === "o") {
        event.preventDefault();
        void openProjectFromFileDialog();
        return;
      }

      if (keyLower === "n") {
        event.preventDefault();
        beginNewImageProject();
        return;
      }

      if (keyLower === "b") {
        event.preventDefault();
        workspacePanelActionsRef.current?.togglePages();
        return;
      }

      if (event.key === "Enter") {
        const primaryAction = stageEditorPrimaryActionRef.current;
        if (primaryAction && !primaryAction.disabled) {
          event.preventDefault();
          primaryAction.click();
        }
        return;
      }

      if (keyLower === "r" && selectedLineId) {
        event.preventDefault();
        updateSelectedLineStatus("review");
        return;
      }

      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setWorkspaceZoom((prev) => clampImageZoom(prev + IMAGE_ZOOM_STEP));
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setWorkspaceZoom((prev) => clampImageZoom(prev - IMAGE_ZOOM_STEP));
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        setWorkspaceZoom(1);
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    dialogs,
    batchModalOpen,
    finalReading,
    currentFilePath,
    currentPageImage,
    currentPage,
    closeInpaintingEditor,
    currentIssue?.lineId,
    entryFlow.screen,
    issueLineItems,
    ocrDisabledReason,
    inpaintingEditorOpen,
    isExtractingSpeechBubbles,
    pageCount,
    project.dialogueLines,
    projectSetup.files.length,
    projectSetup.isPreparing,
    selectedLineId,
    selectedLineForEditor,
    speechBubbleReview,
    workspacePanels.inspectorOpen,
    workspacePanels.pagesOpen,
    workspacePanels.resultsOpen
  ]);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!isDirty && ocrReviewDraftCount === 0 && inpaintingMaskDraftCount === 0 && manualTypesettingDraftCount === 0) return;
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty, ocrReviewDraftCount, inpaintingMaskDraftCount, manualTypesettingDraftCount]);

  useEffect(() => {
    currentFilePathRef.current = currentFilePath;
    currentPageImageRef.current = currentPageImage;
    projectIdRef.current = project.metadata.id;
  }, [currentFilePath, currentPageImage, project.metadata.id]);

  useLayoutEffect(() => {
    const legacyStatus = settingsPanelRef.current?.querySelector<HTMLElement>('.project-actions .status-message[role="status"]');
    if (!legacyStatus) return;
    legacyStatus.removeAttribute("role");
    legacyStatus.setAttribute("aria-live", "off");
  }, [settingsOpen, statusMessage]);

  function replaceLines(lines: DialogueLine[]) {
    if (blockProjectSessionRecovery()) return;
    cancelActiveAiTranslation();
    invalidateOpenProjectOperation();
    invalidateTxtImportOperation();
    invalidatePageImageImportOperation();
    manualTypesettingDraftsRef.current.clear();
    setManualTypesettingDraftCount(0);
    const firstPage = lines[0]?.pageNumber ?? 1;
    const nextProject = {
      ...project,
      dialogueLines: lines,
      metadata: { ...project.metadata, updatedAt: new Date().toISOString() }
    } as TranslationProjectV2;
    queueProjectDiff(project, nextProject);
    setIsDirty(true);
    projectRef.current = nextProject;
    setProject(nextProject);
    setPageAndSelection(firstPage, { lines });
    setStatusMessage(`대사 ${lines.length}개를 불러왔습니다.`);
    dispatchEntryFlow({
      type: "project-installed",
      hasContent: lines.length > 0 || (project.pageImages?.length ?? 0) > 0
    });
  }

  async function importTxt() {
    if (blockProjectSessionRecovery()) return;
    if (activeTxtImportOperationRef.current !== null) return;
    if (!projectSessionReady) {
      setStatusMessage(
        "프로젝트 세션이 준비되지 않았습니다. 세션을 다시 시도한 뒤 TXT를 불러오세요."
      );
      return;
    }
    if (manualTypesettingDraftsRef.current.size > 0) {
      const isCurrentScope = captureProjectDialogScope();
      const drafts = [...manualTypesettingDraftsRef.current.entries()];
      const approved = await dialogs.confirm({
        title: "TXT 대사로 바꿀까요?",
        message: "기존 대사를 TXT 내용으로 바꾸면 미적용 글자 배치 초안이 사라집니다.",
        confirmLabel: "초안을 버리고 불러오기", cancelLabel: "계속 편집", danger: true
      });
      if (!approved || !isCurrentScope() || drafts.some(([key, value]) => manualTypesettingDraftsRef.current.get(key) !== value)) return;
    }
    const importScope = captureProjectDialogScope();
    const confirmedDrafts = new Map(manualTypesettingDraftsRef.current);
    const operation = {};
    const operationSessionId = projectSessionIdRef.current;
    const operationSessionGeneration = sessionGenerationRef.current;
    const operationProjectId = projectRef.current.metadata.id;
    activeTxtImportOperationRef.current = operation;
    const isCurrentOperation = () =>
      activeTxtImportOperationRef.current === operation &&
      projectSessionIdRef.current === operationSessionId &&
      sessionGenerationRef.current === operationSessionGeneration &&
      projectRef.current.metadata.id === operationProjectId;
    setIsImportingTxt(true);
    try {
      await importTxtLines({
        onImported: (lines) => {
          if (!isCurrentOperation()) return;
          if (!importScope() || confirmedDrafts.size !== manualTypesettingDraftsRef.current.size ||
            [...confirmedDrafts].some(([key, value]) => manualTypesettingDraftsRef.current.get(key) !== value)) {
            setStatusMessage("프로젝트나 글자 배치 초안이 바뀌어 TXT를 적용하지 않았습니다. 다시 확인하세요.");
            return;
          }
          replaceLines(lines);
        },
        onCanceled: () => {
          if (isCurrentOperation()) setStatusMessage("TXT 불러오기를 취소했습니다.");
        }
      });
    } catch {
      if (isCurrentOperation()) {
        setStatusMessage("TXT 파일을 불러오지 못했습니다. 파일과 접근 권한을 확인하세요.");
      }
    } finally {
      if (isCurrentOperation()) {
        activeTxtImportOperationRef.current = null;
        setIsImportingTxt(false);
      }
    }
  }

  function updateLine(updated: DialogueLine) {
    if (blockProjectSessionRecovery()) return;
    const previous = project.dialogueLines.find((line) => line.id === updated.id);
    const userTextChanged = Boolean(previous && updated.userTranslation !== previous.userTranslation);
    const nextUpdated = userTextChanged && updated.lineStatus !== "review"
      ? markTranslationDraft(updated, updated.userTranslation ?? "")
      : updated;
    const nextLines = project.dialogueLines.map((line) => (line.id === nextUpdated.id ? nextUpdated : line));
    const activeTranslation = activeAiTranslationRequestRef.current;
    if (activeTranslation) {
      const targetUserFieldChanged = previous?.id === activeTranslation.targetLineId && Boolean(previous) && (
        previous.userTranslation !== nextUpdated.userTranslation ||
        previous.sourceText !== nextUpdated.sourceText ||
        previous.sourceLanguage !== nextUpdated.sourceLanguage ||
        previous.speaker !== nextUpdated.speaker ||
        previous.dialogueType !== nextUpdated.dialogueType
      );
      let contextChanged = false;
      if (activeTranslation.contextFingerprint) {
        try {
          contextChanged = computeTranslationPayloadFingerprint(buildTranslationContextPayload({
            dialogueLines: nextLines,
            targetLineId: activeTranslation.targetLineId,
            characters: project.characters,
            dictionaryTerms: project.dictionaryTerms,
            stylePreset: activeTranslation.stylePreset
          })) !== activeTranslation.contextFingerprint;
        } catch {
          contextChanged = true;
        }
      }
      if (targetUserFieldChanged || contextChanged) cancelActiveAiTranslation();
    }
    if (previous) {
      const patch: DialogueUserPatch = {};
      const fields = [
        "speaker",
        "position",
        "dialogueType",
        "lineStatus",
        "sourceLanguage",
        "sourceText",
        "referenceTranslation",
        "userTranslation",
        "notes"
      ] as const;
      for (const field of fields) {
        if (nextUpdated[field] !== previous[field]) {
          Object.assign(patch, { [field]: nextUpdated[field] ?? "" });
        }
      }
      if (nextUpdated.pageNumber !== previous.pageNumber) {
        patch.pageNumber = nextUpdated.pageNumber;
      }
      if (Object.keys(patch).length > 0) {
        queueSessionMutation({ type: "update_dialogue_line", lineId: nextUpdated.id, patch });
      }
      if (userTextChanged) {
        const scope = {
          projectId: project.metadata.id,
          projectRevision: projectRevisionRef.current,
          lineId: nextUpdated.id,
          sourceIdentity: createTranslationSourceIdentity(previous.sourceText),
          lineStatus: nextUpdated.lineStatus ?? "draft"
        };
        if (nextUpdated.userTranslation) {
          saveTranslationDraft(window.localStorage, scope, nextUpdated.userTranslation);
          setTranslationDraftContext({ ...scope, text: nextUpdated.userTranslation });
        } else {
          clearTranslationDraft(window.localStorage, scope);
          setTranslationDraftContext(null);
        }
      }
      if (nextUpdated.sourceText !== previous.sourceText) setTranslationDraftContext(null);
    }

    setIsDirty(true);
    setProject((current) => ({
      ...current,
      dialogueLines: current.dialogueLines.map((line) => (line.id === nextUpdated.id ? nextUpdated : line)),
      metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
    }));

    if (selectedLineId === nextUpdated.id && nextUpdated.pageNumber !== currentPage) {
      setSelectedLineId(getNextActionableLineId(nextLines, null, currentPage));
    }
  }

  function reportBackendCancelAcknowledgment(
    ack: BackendCancelAcknowledgment,
    options: {
      confirmedMessage?: string;
      updateUi?: boolean;
      generation: number;
    }
  ) {
    if (options.updateUi === false || options.generation !== backendCancelFeedbackGenerationRef.current ||
      sessionConflictRef.current || projectSessionStatusRef.current === "needs_recovery") return;
    if (ack.kind === "confirmed") {
      if (options.confirmedMessage) setStatusMessage(options.confirmedMessage);
      return;
    }
    const message = messageForBackendCancelAcknowledgment(ack.kind);
    if (message) setStatusMessage(message);
  }

  function requestBackendCancel(
    invoke: (() => Promise<{ canceled: boolean }>) | undefined,
    options: {
      confirmedMessage?: string;
      notify?: boolean;
      updateUi?: boolean;
    }
  ) {
    const generation = ++backendCancelFeedbackGenerationRef.current;
    if (options.notify && options.updateUi !== false) {
      setStatusMessage(BACKEND_CANCEL_CONFIRMING_MESSAGE);
    }
    void acknowledgeCancelIpc(invoke).then((ack) => {
      reportBackendCancelAcknowledgment(ack, {
        confirmedMessage: options.confirmedMessage,
        updateUi: options.updateUi,
        generation
      });
    });
  }

  function cancelActiveAiTranslation(options: { notify?: boolean; updateUi?: boolean } = {}): boolean {
    const active = activeAiTranslationRequestRef.current;
    if (!active) return false;
    activeAiTranslationRequestRef.current = null;
    aiTranslationTokenRef.current += 1;
    if (options.updateUi !== false) setIsAiTranslating(false);
    requestBackendCancel(
      window.projectApi?.cancelTranslation
        ? () => window.projectApi.cancelTranslation!({ requestId: active.requestId })
        : undefined,
      {
        notify: options.notify,
        updateUi: options.updateUi,
        confirmedMessage: options.notify
          ? "AI 번역 요청을 취소했습니다."
          : "오래된 AI 번역 요청을 취소하고 최신 작업을 유지했습니다."
      }
    );
    return true;
  }

  function isCurrentAiTranslationRequest(active: ActiveAiTranslationRequest): boolean {
    return activeAiTranslationRequestRef.current === active &&
      active.token === aiTranslationTokenRef.current &&
      active.projectSessionId === projectSessionIdRef.current &&
      active.sessionGeneration === sessionGenerationRef.current &&
      projectSessionStatusRef.current === "active" && !sessionConflictRef.current &&
      active.projectId === projectRef.current.metadata.id &&
      active.targetLineId === selectedLineIdRef.current;
  }

  async function handleRequestAiTranslation(targetLine: DialogueLine) {
    if (!targetLine.sourceText?.trim()) return;
    if (blockProjectSessionRecovery()) return;
    if (sessionConflictRef.current) {
      if (sessionConflictNoticeRef.current) setStatusMessage(sessionConflictNoticeRef.current);
      return;
    }
    if (sessionMutationFailedRef.current && blockUnappliedSessionEdits()) return;
    cancelActiveAiTranslation();
    backendCancelFeedbackGenerationRef.current += 1;
    const token = ++aiTranslationTokenRef.current;
    const active: ActiveAiTranslationRequest = {
      requestId: createRendererId("translation", `${Date.now()}-${targetLine.id}`),
      token,
      projectSessionId: projectSessionIdRef.current,
      sessionGeneration: sessionGenerationRef.current,
      projectId: projectRef.current.metadata.id,
      targetLineId: targetLine.id,
      contextFingerprint: ""
    };
    activeAiTranslationRequestRef.current = active;
    setIsAiTranslating(true);
    setStatusMessage("AI 문맥 번역을 생성하는 중입니다...");

    try {
      const providerSettings = await loadRequiredProviderSettings();
      if (!isCurrentAiTranslationRequest(active)) return;
      active.stylePreset = providerSettings.translationStyle || undefined;

      if (active.projectSessionId) {
        await drainSessionMutationQueue();
        if (!isCurrentAiTranslationRequest(active)) return;
        if (blockUnappliedSessionEdits()) return;
      }

      const requestProject = projectRef.current;
      const payload = buildTranslationContextPayload({
        dialogueLines: requestProject.dialogueLines,
        targetLineId: active.targetLineId,
        characters: requestProject.characters,
        dictionaryTerms: requestProject.dictionaryTerms,
        stylePreset: active.stylePreset
      });
      active.contextFingerprint = computeTranslationPayloadFingerprint(payload);
      if (!isCurrentAiTranslationRequest(active)) return;

      const executeTranslation = window.projectApi?.executeTranslation;
      if (!executeTranslation) throw new Error("통합 번역 Provider를 사용할 수 없습니다.");
      const result = await executeTranslation({
        ...(active.projectSessionId
          ? { projectSessionId: active.projectSessionId, targetLineId: active.targetLineId }
          : { payload }),
        stylePreset: active.stylePreset,
        requestId: active.requestId,
        options: {
          engineType: providerSettings.translationEngine,
          localAiEndpoint: providerSettings.localAiEndpoint,
          localAiModel: providerSettings.localAiModel,
          localAiRuntime: providerSettings.localAiRuntime,
          geminiModel: providerSettings.geminiModel
        }
      });
      if (!isCurrentAiTranslationRequest(active)) return;

      const translatedText = result.translatedText?.trim();
      if (!translatedText) return;
      const responseFingerprint = result.contextFingerprint || active.contextFingerprint;
      const latestPayload = buildTranslationContextPayload({
        dialogueLines: projectRef.current.dialogueLines,
        targetLineId: active.targetLineId,
        characters: projectRef.current.characters,
        dictionaryTerms: projectRef.current.dictionaryTerms,
        stylePreset: active.stylePreset
      });
      if (
        responseFingerprint !== active.contextFingerprint ||
        computeTranslationPayloadFingerprint(latestPayload) !== active.contextFingerprint
      ) {
        cancelActiveAiTranslation();
        return;
      }

      if (active.projectSessionId) {
        await drainSessionMutationQueue();
        if (!isCurrentAiTranslationRequest(active)) return;
        if (blockUnappliedSessionEdits()) return;
        const currentFingerprint = computeTranslationPayloadFingerprint(buildTranslationContextPayload({
          dialogueLines: projectRef.current.dialogueLines,
          targetLineId: active.targetLineId,
          characters: projectRef.current.characters,
          dictionaryTerms: projectRef.current.dictionaryTerms,
          stylePreset: active.stylePreset
        }));
        if (currentFingerprint !== active.contextFingerprint) {
          cancelActiveAiTranslation();
          return;
        }
        const commitProposal = window.projectApi?.commitTranslationProposal;
        if (!commitProposal) throw new Error("AI 번역 제안을 저장할 수 없습니다.");
        const committed = await commitProposal({
          projectSessionId: active.projectSessionId,
          targetLineId: active.targetLineId,
          proposal: translatedText,
          expectedTranslationFingerprint: active.contextFingerprint,
          stylePreset: active.stylePreset
        });
        if (!isCurrentAiTranslationRequest(active)) return;
        if (committed.projectSessionId !== active.projectSessionId ||
          committed.project.project.metadata.id !== active.projectId ||
          committed.project.revision < projectRevisionRef.current) {
          setStatusMessage("AI 번역 결과가 현재 세션과 맞지 않아 화면에 반영하지 않았습니다.");
          return;
        }
        if (committed.project.status !== "active") {
          if (committed.project.status === "needs_recovery") adoptProjectSessionDto(committed.project);
          return;
        }
        if (keepLocalEditsAfterSessionResult(committed.project)) return;
        applySessionChange({
          status: "applied",
          revision: committed.project.revision,
          project: committed.project
        });
        const applied = committed.appliedDialogueUpdates?.find((update) => update.id === active.targetLineId)?.appliedTranslation;
        if (!applied) {
          setStatusMessage("번역 문맥이 바뀌어 오래된 AI 제안을 적용하지 않았습니다.");
          return;
        }
      } else {
        const nextProject = {
          ...projectRef.current,
          dialogueLines: projectRef.current.dialogueLines.map((line) =>
            line.id === active.targetLineId ? mergeAiTranslationProposal(line, translatedText) : line
          ),
          metadata: { ...projectRef.current.metadata, updatedAt: new Date().toISOString() }
        } as TranslationProjectV2;
        projectRef.current = nextProject;
        setProject(nextProject);
        setIsDirty(true);
      }

      if (result.usedExactTm) {
        setStatusMessage("번역 메모리(TM) 100% 일치 결과를 AI 제안으로 생성했습니다.");
      } else {
        setStatusMessage(result.qaReport?.passed === false
          ? "AI 문맥 번역 제안을 생성했습니다 (품질 검사 주의 필요)."
          : "AI 문맥 번역 제안을 생성했습니다 (품질 검사 통과)."
        );
      }
    } catch (error) {
      if (!isCurrentAiTranslationRequest(active) || isAbortLikeError(error)) return;
      console.error("AI translation request failed:", error);
      setStatusMessage(error instanceof Error ? `AI 번역 실패: ${error.message}` : "AI 번역 요청에 실패했습니다.");
    } finally {
      if (activeAiTranslationRequestRef.current === active) {
        activeAiTranslationRequestRef.current = null;
        setIsAiTranslating(false);
      }
    }
  }




  function getNextIssueLine(lines: DialogueLine[], currentLineId: string): DialogueLine | null {
    const candidates = getIssueLineItems(lines)
      .filter((item) => item.line.id !== currentLineId)
      .sort((left, right) => left.line.pageNumber - right.line.pageNumber || left.line.order - right.line.order);
    return candidates[0]?.line ?? null;
  }

  function confirmSelectedTranslation() {
    if (!selectedLineForEditor) return;
    if (blockProjectSessionRecovery()) return;
    if (!canConfirmTranslation(selectedLineForEditor)) {
      setStatusMessage("확정할 번역문을 먼저 입력하거나 제안을 만드세요.");
      return;
    }
    const confirmed = confirmTranslation(selectedLineForEditor);
    const nextLines = project.dialogueLines.map((line) => line.id === confirmed.id ? confirmed : line);
    const draftScope: TranslationDraftScope = {
      projectId: project.metadata.id,
      projectRevision: projectRevisionRef.current,
      lineId: confirmed.id,
      sourceIdentity: createTranslationSourceIdentity(confirmed.sourceText),
      lineStatus: "draft"
    };
    const queued = queueSessionMutation(
      {
        type: "update_dialogue_line",
        lineId: confirmed.id,
        patch: { userTranslation: confirmed.userTranslation ?? "", lineStatus: "complete" }
      },
      undefined,
      (result, adopted) => {
        if (result?.status !== "applied" || !adopted) {
          if (result?.status === "revision_conflict" && confirmed.userTranslation) {
            const conflictScope: TranslationDraftScope = {
              ...draftScope,
              projectRevision: result.revision,
              lineStatus: "draft"
            };
            saveTranslationDraft(window.localStorage, conflictScope, confirmed.userTranslation);
            if (selectedLineIdRef.current === confirmed.id) {
              setTranslationDraftContext({ ...conflictScope, text: confirmed.userTranslation });
            }
          }
          return;
        }
        clearTranslationDraft(window.localStorage, draftScope);
        setTranslationDraftContext((current) => current?.lineId === confirmed.id ? null : current);
        setCurrentIssue((current) => current?.lineId === confirmed.id ? null : current);
        if (selectedLineIdRef.current === confirmed.id) {
          setIssueEditor(null);
          setStatusMessage("선택한 대사의 검수를 확정했습니다.");
        }
      }
    );
    if (queued) return;
    clearTranslationDraft(window.localStorage, draftScope);
    setTranslationDraftContext(null);
    const nextProject = {
      ...project,
      dialogueLines: nextLines,
      metadata: { ...project.metadata, updatedAt: new Date().toISOString() }
    } as TranslationProjectV2;
    projectRef.current = nextProject;
    setProject(nextProject);
    setIsDirty(true);
    setCurrentIssue(null);
    setIssueEditor(null);
    setStatusMessage("선택한 대사의 검수를 확정했습니다.");
  }

  function postponeTranslation() {
    if (!selectedLine || !currentIssue) return;
    const nextIssue = getNextIssueLine(project.dialogueLines, selectedLine.id);
    if (!nextIssue) {
      setStatusMessage("보류할 다음 문제가 없습니다. 현재 초안을 유지합니다.");
      return;
    }
    selectIssueLine(nextIssue);
    setStatusMessage("번역 문제를 보류하고 다음 문제로 이동했습니다.");
  }

  function updateSelectedLineStatus(lineStatus: LineStatus) {
    if (!selectedLineId) return;
    if (blockProjectSessionRecovery()) return;
    if (lineStatus === "complete" && !selectedLineForEditor?.userTranslation?.trim()) {
      setStatusMessage("사용자 번역을 먼저 입력하거나 제안을 채택하세요.");
      return;
    }

    queueSessionMutation({
      type: "update_dialogue_line",
      lineId: selectedLineId,
      patch: { lineStatus }
    });
    setIsDirty(true);
    setProject((current) => ({
      ...current,
      dialogueLines: current.dialogueLines.map((line) => (line.id === selectedLineId ? { ...line, lineStatus } : line)),
      metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
    }));
  }

  function createManualDialogueLine(sourceText: string) {
    const trimmed = sourceText.trim();
    if (!trimmed || !currentPageImage) return;
    if (blockProjectSessionRecovery()) return;
    const baseProject = projectRef.current;
    const clientLineId = createRendererId("manual-line", `${baseProject.metadata.id}-${currentPage}-${Date.now()}`);
    const clientLine = {
      id: clientLineId,
      order: Math.max(0, ...baseProject.dialogueLines.map((line) => line.order)) + 1,
      pageNumber: currentPage,
      dialogueType: "speech" as const,
      lineStatus: "untranslated" as const,
      sourceLanguage: baseProject.settings.defaultSourceLanguage,
      sourceText: trimmed,
      parseConfidence: 1,
      parseWarnings: [],
      origin: { kind: "manual" as const }
    };
    queueSessionMutation({
      type: "add_dialogue_line",
      input: {
        pageNumber: currentPage,
        sourceLanguage: clientLine.sourceLanguage,
        sourceText: clientLine.sourceText,
        dialogueType: clientLine.dialogueType,
        lineStatus: clientLine.lineStatus
      }
    }, clientLineId);
    const nextProject = {
      ...baseProject,
      dialogueLines: [...baseProject.dialogueLines, clientLine],
      metadata: { ...baseProject.metadata, updatedAt: new Date().toISOString() }
    };
    projectRef.current = nextProject;
    selectedLineIdRef.current = clientLineId;
    setProject(nextProject);
    setSelectedLineId(clientLineId);
    setBottomPanel("dialogue");
    setWorkspacePanels((current) => ({ ...current, inspectorOpen: true, focusMode: false }));
    setFocusNewManualTranslation(true);
    setIsDirty(true);
    setStatusMessage("수동 대사를 추가했습니다. 번역문을 입력하세요.");
  }

  function moveSelectedLine(direction: 1 | -1) {
    if (!selectedLineId) return;

    const currentIndex = project.dialogueLines.findIndex((line) => line.id === selectedLineId);
    if (currentIndex < 0) return;

    const nextIndex = Math.min(project.dialogueLines.length - 1, Math.max(0, currentIndex + direction));
    const nextLine = project.dialogueLines[nextIndex];
    if (nextLine && nextLine.pageNumber !== currentPage) {
      flushSync(() => {
        selectLine(nextLine.id);
      });
      return;
    }
    if (nextLine) selectLine(nextLine.id);
  }

  function captureProjectDialogScope() {
    const snapshot = projectRef.current;
    const sessionId = projectSessionIdRef.current;
    const generation = sessionGenerationRef.current;
    const revision = projectRevisionRef.current;
    return () => projectRef.current === snapshot && projectSessionIdRef.current === sessionId &&
      sessionGenerationRef.current === generation && projectRevisionRef.current === revision;
  }

  async function deleteSelectedLine() {
    if (!selectedLineId || dialogs.isPending()) return;
    if (blockProjectSessionRecovery()) return;
    const lineId = selectedLineId;
    const isCurrentScope = captureProjectDialogScope();
    const matchingDrafts = [...manualTypesettingDraftsRef.current.entries()].filter(([, draft]) => draft.lineId === lineId);
    const approved = await dialogs.confirm({ title: "선택한 대사를 삭제할까요?", message: matchingDrafts.length > 0 ? "선택한 대사와 미적용 글자 배치 초안을 삭제합니다. 원본 이미지는 유지됩니다." : "선택한 대사와 해당 대사의 편집 내용을 삭제합니다. 원본 이미지는 유지됩니다.", confirmLabel: "대사 삭제", cancelLabel: "계속 편집", danger: true });
    if (!isCurrentScope()) return;
    if (!approved) {
      setStatusMessage("라인 삭제를 취소했습니다.");
      return;
    }

    const currentIndex = project.dialogueLines.findIndex((line) => line.id === lineId);
    if (currentIndex < 0) return;

    const nextLines = project.dialogueLines.filter((line) => line.id !== lineId);
    const nextPageCount = getPageCount(nextLines, project.pageImages);
    const nextPage = Math.min(currentPage, nextPageCount);
    if (pendingIssueNavigationRef.current?.target.lineId === lineId) {
      pendingIssueNavigationRef.current = null;
    }
    const clearDeletedDrafts = () => {
      for (const [key, value] of matchingDrafts) {
        if (manualTypesettingDraftsRef.current.get(key) === value) manualTypesettingDraftsRef.current.delete(key);
      }
      setManualTypesettingDraftCount(manualTypesettingDraftsRef.current.size);
    };
    const queued = queueSessionMutation({ type: "remove_dialogue_line", lineId }, undefined, (result, adopted) => {
      if (result?.status === "applied" && adopted) clearDeletedDrafts();
    });
    if (!queued && sessionPersistenceRequired) {
      setStatusMessage("프로젝트 세션을 준비한 뒤 대사를 다시 삭제하세요.");
      return;
    }
    if (!queued) clearDeletedDrafts();
    setIsDirty(true);
    setProject((current) => ({
      ...current,
      dialogueLines: current.dialogueLines.filter((line) => line.id !== lineId),
      metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
    }));
    setPageAndSelection(nextPage, { lines: nextLines, pageImages: project.pageImages });
    dispatchEntryFlow({
      type: "project-installed",
      hasContent: nextLines.length > 0 || (project.pageImages?.length ?? 0) > 0
    });
    setStatusMessage("라인을 삭제했습니다.");
  }

  function replaceProject(
    nextProject: import("../shared/projectTypes").TranslationProject | TranslationProjectV2
  ) {
    if (blockProjectSessionRecovery()) return;
    cancelActiveAiTranslation();
    const normalizedNext = {
      ...project,
      ...nextProject,
      schemaVersion: 2,
      processing: "processing" in nextProject ? nextProject.processing : project.processing
    } as TranslationProjectV2;
    queueProjectDiff(project, normalizedNext);
    setIsDirty(true);
    projectRef.current = normalizedNext;
    setProject(normalizedNext);
  }

  async function confirmDiscardUnsavedChanges() {
    if (!isDirty && ocrReviewDraftsRef.current.size === 0 && inpaintingMaskDraftsRef.current.size === 0 && manualTypesettingDraftsRef.current.size === 0) return true;
    const isCurrentScope = captureProjectDialogScope();
    const message = ocrReviewDraftsRef.current.size > 0 || inpaintingMaskDraftsRef.current.size > 0 || manualTypesettingDraftsRef.current.size > 0
      ? "계속 이동하면 미적용 OCR 검토 초안, 배경 마스크 또는 글자 배치 초안과 저장하지 않은 프로젝트 변경사항이 사라집니다."
      : "계속 이동하면 저장하지 않은 프로젝트 변경사항이 사라집니다.";
    const approved = await dialogs.confirm({ title: "저장하지 않은 변경사항을 버릴까요?", message, confirmLabel: "버리고 이동", cancelLabel: "계속 편집", danger: true });
    return isCurrentScope() && approved;
  }

  function openEnvironmentPreparation(returnTo: PreparationReturnScreen) {
    dispatchEntryFlow({ type: "open-preparation", returnTo });
    void refreshEnvironmentPreparation();
  }

  function closeEnvironmentPreparation() {
    resetEnvironmentState();
    if (entryFlow.preparationReturnScreen === "workspace" && workspaceViewport) {
      viewportSeedRevisionRef.current += 1;
      setInitialImageViewport({
        key: `${focusDeckProjectKey}:environment-return:${viewportSeedRevisionRef.current}`,
        preserveInpainting: inpaintingEditorOpen,
        ...workspaceViewport
      });
    }
    dispatchEntryFlow({ type: "preparation-closed" });
  }

  async function checkForAutoUpdate() {
    if (!window.projectApi?.checkForAutoUpdate) return;
    try {
      setAutoUpdateState(await window.projectApi.checkForAutoUpdate());
    } catch {
      setAutoUpdateState(createAutoUpdateState("error", {
        message: "업데이트를 확인하지 못했습니다. 잠시 후 다시 시도하세요."
      }));
    }
  }

  async function downloadAutoUpdate() {
    if (!window.projectApi?.downloadAutoUpdate) return;
    try {
      setAutoUpdateState(await window.projectApi.downloadAutoUpdate());
    } catch {
      setAutoUpdateState(createAutoUpdateState("error", {
        message: "업데이트를 다운로드하지 못했습니다. 잠시 후 다시 시도하세요."
      }));
    }
  }

  async function installAutoUpdate() {
    if (isDirty || ocrReviewDraftsRef.current.size > 0 || inpaintingMaskDraftsRef.current.size > 0 || manualTypesettingDraftsRef.current.size > 0) {
      setStatusMessage("업데이트를 설치하기 전에 저장하지 않은 변경사항과 미적용 초안을 확인하세요.");
      return;
    }
    await window.projectApi?.installAutoUpdate?.();
  }

  async function openAutoUpdateRelease() {
    await window.projectApi?.openAutoUpdateRelease?.();
  }

  function invalidateOpenProjectOperation() {
    openProjectOperationRef.current = null;
  }

  function invalidateTxtImportOperation() {
    activeTxtImportOperationRef.current = null;
    setIsImportingTxt(false);
  }

  function invalidatePageImageImportOperation() {
    activePageImageImportOperationRef.current = null;
    setIsImportingPageImages(false);
  }

  async function beginNewImageProject() {
    if (dialogs.isPending()) return;
    if (activeProjectCreateTokenRef.current !== null) return;
    if (newProjectSwitchInFlightRef.current) return;
    if (!projectSessionReady) {
      setStatusMessage(
        "프로젝트 세션이 준비되지 않았습니다. 세션을 다시 시도한 뒤 새 프로젝트를 만드세요."
      );
      return;
    }
    const isCurrentScope = captureProjectDialogScope();
    const approved = await confirmDiscardUnsavedChanges();
    if (!isCurrentScope() || newProjectSwitchInFlightRef.current || activeProjectCreateTokenRef.current !== null) return;
    if (!approved) {
      setStatusMessage("새 프로젝트 생성을 취소했습니다.");
      return;
    }
    // Keep the gated startup session available for the Setup picker. A new
    // project launched from Home has no saved path to close yet; dropping this
    // session here would make the first image selection lose its opaque batch.
    const preserveStartupSession = !currentFilePath && projectSessionIdRef.current !== null;
    const sessionToClose = !preserveStartupSession ? projectSessionIdRef.current : null;
    if (!preserveStartupSession && sessionPersistenceRequired) {
      void closeCurrentSessionThenBeginNewProject(sessionToClose);
      return;
    }
    enterNewImageProjectSetup({ preserveStartupSession });
  }

  async function closeCurrentSessionThenBeginNewProject(projectSessionId: string | null) {
    if (newProjectSwitchInFlightRef.current) return;
    const api = window.projectApi;
    if (!api?.createProjectSession || !api.closeProject) {
      setStatusMessage("새 프로젝트 세션을 준비할 수 없습니다. 기존 프로젝트를 유지합니다.");
      return;
    }
    newProjectSwitchInFlightRef.current = true;
    const previousSessionInstance = projectSessionInstanceRef.current;
    const isCurrentScope = captureProjectDialogScope();
    const approvedDrafts = JSON.stringify([
      [...ocrReviewDraftsRef.current], [...inpaintingMaskDraftsRef.current], [...manualTypesettingDraftsRef.current]
    ]);
    const hasApprovedScope = () => isCurrentScope() && approvedDrafts === JSON.stringify([
      [...ocrReviewDraftsRef.current], [...inpaintingMaskDraftsRef.current], [...manualTypesettingDraftsRef.current]
    ]);
    cancelActiveAiTranslation();
    cancelActiveOcr();
    cancelActiveInpainting();
    invalidateOpenProjectOperation();
    invalidateTxtImportOperation();
    invalidatePageImageImportOperation();
    const operation = {};
    openProjectOperationRef.current = operation;
    const isCurrentOperation = () => openProjectOperationRef.current === operation;
    setBatchModalOpen(false);
    setStatusMessage("새 프로젝트 세션을 준비하는 중입니다.");
    let createdSession: ProjectSessionResult | null = null;
    let closingPrevious = false;
    let previousClosed = false;
    const rollbackCreatedSession = async () => {
      if (!createdSession) return;
      const sessionId = createdSession.projectSessionId;
      createdSession = null;
      try {
        await api.closeProject!({ projectSessionId: sessionId });
      } catch (error) {
        cleanupPendingSessionIdsRef.current.add(sessionId);
        projectSwitchCleanupErrorRef.current = new AggregateError([error], "New project session rollback cleanup failed");
        if (isCurrentOperation()) {
          setStatusMessage("새 프로젝트 세션을 정리하지 못했습니다. 다음 전환에서 정리를 다시 시도합니다.");
        }
      }
    };
    try {
      for (const sessionId of [...cleanupPendingSessionIdsRef.current]) {
        await api.closeProject({ projectSessionId: sessionId });
        cleanupPendingSessionIdsRef.current.delete(sessionId);
      }
      projectSwitchCleanupErrorRef.current = null;
      await drainSessionMutationQueue();
      if (!isCurrentOperation()) return;
      if (!hasApprovedScope()) {
        setStatusMessage("현재 작업이 바뀌어 새 프로젝트 전환을 취소했습니다. 변경사항을 확인한 뒤 다시 시도하세요.");
        return;
      }
      createdSession = await api.createProjectSession({ title: "새 프로젝트", secret: false });
      if (!isCurrentOperation() || !hasApprovedScope()) {
        if (isCurrentOperation()) {
          setStatusMessage("현재 작업이 바뀌어 새 프로젝트 전환을 취소했습니다. 변경사항을 확인한 뒤 다시 시도하세요.");
        }
        await rollbackCreatedSession();
        return;
      }
      if (projectSessionId) {
        closingPrevious = true;
        setStatusMessage("이전 프로젝트를 닫는 중입니다.");
        await api.closeProject({ projectSessionId });
        previousClosed = true;
      }
      if (!isCurrentOperation() || !hasApprovedScope()) {
        // A close cannot be undone. Keep any edits made while it was pending
        // visible and require recovery rather than silently discarding them.
        if (previousClosed && projectSessionIdRef.current === projectSessionId &&
          previousSessionInstance !== null && projectSessionInstanceRef.current === previousSessionInstance) {
          markProjectSessionStatus("needs_recovery");
          setStatusMessage(projectSessionRecoveryMessage);
        }
        await rollbackCreatedSession();
        return;
      }
      enterNewImageProjectSetup({ preserveStartupSession: true, session: createdSession });
      createdSession = null;
    } catch (error) {
      if (isCurrentOperation()) {
        const message = closingPrevious
          ? "이전 프로젝트를 닫지 못해 새 프로젝트로 전환하지 못했습니다."
          : "새 프로젝트 세션을 준비하지 못했습니다. 기존 프로젝트를 유지합니다.";
        setStatusMessage(error instanceof Error ? `${message} ${error.message}` : message);
      }
      await rollbackCreatedSession();
    } finally {
      if (isCurrentOperation()) openProjectOperationRef.current = null;
      newProjectSwitchInFlightRef.current = false;
    }
  }

  function enterNewImageProjectSetup(options: { preserveStartupSession: boolean; session?: ProjectSessionResult }) {
    cancelActiveAiTranslation();
    setBatchModalOpen(false);
    invalidateOpenProjectOperation();
    invalidateTxtImportOperation();
    const stalePreparedImages = projectSetup.files;
    projectSetupOperationTokenRef.current += 1;
    dispatchProjectSetup({ type: "reset" });
    setProjectSetupStoragePath(null);
    if (stalePreparedImages.length > 0) void releasePreparedImages(stalePreparedImages);
    if (options.session) installSessionResult(options.session, false);
    if (!options.preserveStartupSession) {
      resetSessionMutationState(null);
      markProjectSessionStatus("active");
      projectSessionIdRef.current = null;
      projectSessionInstanceRef.current = null;
      setProjectSessionId(null);
      projectRevisionRef.current = 0;
      setProjectRevision(0);
    }
    activeRecentProjectIdRef.current = null;
    setActiveRecentProjectId(null);
    workspaceRestoreSnapshotRef.current = null;
    workspaceSessionSaveEnabledRef.current = false;
    setWorkspaceSessionHydratedKey(null);
    setWorkspaceComparison({ mode: "single", revealPosition: 50, opacity: 0.5 });
    setWorkspaceComparisonHydrationRevision((current) => current + 1);
    setPendingPageNumbers([]);
    const emptyProject = options.session?.project.project ?? createEmptyProject("새 프로젝트", false);
    projectRef.current = emptyProject;
    setProject(emptyProject);
    setCurrentFilePath(null);
    setCurrentPage(1);
    setSelectedLineId(null);
    clearAllSpeechBubbleReviews();
    setSettingsOpen(false);
    setIsDirty(false);
    setImageImportFailureCount(0);
    setUnavailableRecentPath(null);
    setStatusMessage("");
    dispatchEntryFlow({ type: "new-project" });
  }

  function updateProjectSetupTitle(title: string) {
    const nextTitle = title || "새 프로젝트";
    setProject((current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        title: nextTitle
      }
    }));
  }

  async function chooseProjectSetupStorageLocation() {
    const api = window.projectApi;
    if (!api?.chooseSaveFile) {
      setStatusMessage("프로젝트 저장 위치 선택 기능을 사용할 수 없습니다.");
      return;
    }
    try {
      const filePath = await api.chooseSaveFile({
        defaultPath: `${project.metadata.title || "새 프로젝트"}.ctp`
      });
      if (!filePath) {
        setStatusMessage("저장 위치 선택을 취소했습니다.");
        return;
      }
      setProjectSetupStoragePath(filePath);
      setStatusMessage("프로젝트 저장 위치를 선택했습니다.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "프로젝트 저장 위치를 선택하지 못했습니다.");
    }
  }

  async function chooseProjectSetupImages() {
    const api = window.projectApi;
    if (
      !api?.choosePageImages &&
      !api?.choosePreparedPageImageFiles &&
      !(api?.choosePageImageFiles && api.preparePageImageFiles)
    ) {
      setStatusMessage("이미지 준비 기능을 사용할 수 없습니다.");
      return;
    }

    const operationToken = ++projectSetupOperationTokenRef.current;
    dispatchProjectSetup({ type: "preparation-changed", isPreparing: true });
    try {
      await initialSessionPromiseRef.current;
      if (operationToken !== projectSetupOperationTokenRef.current) return;
      const activeSessionId = projectSessionIdRef.current;
      if (sessionPersistenceRequired && !activeSessionId) {
        throw new Error("프로젝트 세션이 준비되지 않아 이미지를 선택할 수 없습니다.");
      }
      let preparedImages: PreparedPageImage[];
      if (activeSessionId && api.choosePageImages) {
        const batch = await api.choosePageImages({ projectSessionId: activeSessionId });
        preparedImages = batch ? preparedImagesFromBatch(batch) : [];
      } else if (api.choosePreparedPageImageFiles) {
        preparedImages = (await api.choosePreparedPageImageFiles()) ?? [];
      } else {
        const sourcePaths = (await api.choosePageImageFiles?.()) ?? [];
        preparedImages = sourcePaths.length > 0 ? await api.preparePageImageFiles!(sourcePaths) : [];
      }

      if (operationToken !== projectSetupOperationTokenRef.current) {
        await releasePreparedImages(preparedImages, activeSessionId);
        return;
      }
      if (preparedImages.length === 0) {
        setStatusMessage("이미지 선택을 취소했습니다.");
        return;
      }
      dispatchProjectSetup({ type: "picker-files-added", files: preparedImages });
      setStatusMessage(`이미지 ${preparedImages.length}장을 준비했습니다.`);
    } catch (error) {
      if (operationToken === projectSetupOperationTokenRef.current) {
        setStatusMessage(error instanceof Error ? error.message : "이미지를 준비하지 못했습니다.");
      }
    } finally {
      if (operationToken === projectSetupOperationTokenRef.current) {
        dispatchProjectSetup({ type: "preparation-changed", isPreparing: false });
      }
    }
  }

  async function prepareDroppedProjectImages(files: File[]) {
    const api = window.projectApi;
    if (
      !api?.preparePageImages &&
      (!api?.getPathForFile || !api.preparePageImageFiles)
    ) {
      setStatusMessage("끌어놓은 이미지 파일을 준비할 수 없습니다.");
      return;
    }

    const operationToken = ++projectSetupOperationTokenRef.current;
    dispatchProjectSetup({ type: "preparation-changed", isPreparing: true });
    try {
      await initialSessionPromiseRef.current;
      if (operationToken !== projectSetupOperationTokenRef.current) return;
      const activeSessionId = projectSessionIdRef.current;
      if (sessionPersistenceRequired && !activeSessionId) {
        throw new Error("프로젝트 세션이 준비되지 않아 이미지를 준비할 수 없습니다.");
      }
      let preparedImages: PreparedPageImage[];
      if (activeSessionId && api.preparePageImages) {
        preparedImages = preparedImagesFromBatch(
          await api.preparePageImages({
            projectSessionId: activeSessionId,
            files
          })
        );
      } else {
        const sourcePaths = files
          .map((file) => api.getPathForFile!(file))
          .filter((filePath) => filePath.length > 0);
        preparedImages = sourcePaths.length > 0
          ? await api.preparePageImageFiles!(sourcePaths)
          : [];
      }
      if (operationToken !== projectSetupOperationTokenRef.current) {
        await releasePreparedImages(preparedImages, activeSessionId);
        return;
      }
      if (preparedImages.length === 0) {
        setStatusMessage("추가할 이미지가 없습니다.");
        return;
      }
      dispatchProjectSetup({ type: "dropped-files-added", files: preparedImages });
      setStatusMessage(`이미지 ${preparedImages.length}장을 준비했습니다.`);
    } catch (error) {
      if (operationToken === projectSetupOperationTokenRef.current) {
        setStatusMessage(error instanceof Error ? error.message : "이미지를 준비하지 못했습니다.");
      }
    } finally {
      if (operationToken === projectSetupOperationTokenRef.current) {
        dispatchProjectSetup({ type: "preparation-changed", isPreparing: false });
      }
    }
  }

  function removeProjectSetupImage(id: string) {
    const removed = projectSetup.files.find((file) => file.id === id);
    const sameBatchCount = removed?.importBatchId
      ? projectSetup.files.filter((file) => file.importBatchId === removed.importBatchId).length
      : 0;
    dispatchProjectSetup({ type: "file-removed", id });
    if (removed && (!removed.importBatchId || sameBatchCount === 1)) {
      void releasePreparedImages([removed]);
    }
  }

  function cancelProjectSetup() {
    const preparedImages = projectSetup.files;
    const ownerSessionId = projectSessionIdRef.current;
    invalidateOpenProjectOperation();
    projectSetupOperationTokenRef.current += 1;
    activeProjectCreateTokenRef.current = null;
    dispatchProjectSetup({ type: "reset" });
    setProjectSetupStoragePath(null);
    dispatchEntryFlow({ type: "setup-canceled" });
    setStatusMessage("프로젝트 만들기를 취소했습니다.");
    if (ownerSessionId && sessionPersistenceRequired) {
      setProjectSessionReadiness("initializing");
      resetSessionMutationState();
      markProjectSessionStatus("active");
      void abandonProjectSetupSession(ownerSessionId, preparedImages);
    } else if (preparedImages.length > 0) {
      void releasePreparedImages(preparedImages, ownerSessionId);
    }
  }

  async function abandonProjectSetupSession(
    ownerSessionId: string,
    preparedImages: PreparedPageImage[]
  ) {
    const api = window.projectApi;
    try {
      if (!api?.closeProject) {
        throw new Error("Project session close is unavailable");
      }
      if (preparedImages.length > 0) {
        await releasePreparedImages(preparedImages, ownerSessionId);
      }
      await api.closeProject({ projectSessionId: ownerSessionId });
      if (projectSessionIdRef.current === ownerSessionId) {
        projectSessionIdRef.current = null;
        projectSessionInstanceRef.current = null;
        setProjectSessionId(null);
        projectRevisionRef.current = 0;
        setProjectRevision(0);
        sessionProjectRef.current = null;
        setCurrentFilePath(null);
        setIsDirty(false);
      }
      startupRestoreAttemptedRef.current = false;
      retryInitialSessionOnlyRef.current = true;
      setSessionBootstrapAttempt((attempt) => attempt + 1);
    } catch {
      setProjectSessionReadiness("error");
      setStatusMessage(
        "취소한 프로젝트 세션을 정리하지 못했습니다. 세션을 다시 시도하기 전에는 새 프로젝트를 시작할 수 없습니다."
      );
    }
  }

  async function releasePreparedPreviewIds(ids: string[]) {
    if (ids.length === 0 || !window.projectApi?.releasePreparedPageImages) return;
    try {
      await window.projectApi.releasePreparedPageImages(ids);
    } catch {
      // Preview cleanup is best-effort and paths are intentionally never logged.
    }
  }

  async function releasePreparedImages(
    images: PreparedPageImage[],
    ownerSessionId: string | null = projectSessionIdRef.current
  ) {
    const batches = [...new Set(images.flatMap((image) => image.importBatchId ? [image.importBatchId] : []))];
    if (ownerSessionId && window.projectApi?.releasePageImageImportBatch) {
      await Promise.all(batches.map(async (importBatchId) => {
        try {
          await window.projectApi.releasePageImageImportBatch!({
            projectSessionId: ownerSessionId,
            importBatchId
          });
        } catch {
          // Temporary import cleanup is best-effort and paths are intentionally never logged.
        }
      }));
    }
    await releasePreparedPreviewIds(
      images.filter((image) => !image.importBatchId).map(({ id }) => id)
    );
  }

  async function confirmProjectSetup() {
    if (activeProjectCreateTokenRef.current !== null) return;
    const api = window.projectApi;
    if (!api?.importPageImages) {
      setStatusMessage("이미지 프로젝트 기능을 사용할 수 없습니다.");
      return;
    }

    const operationToken = ++projectSetupOperationTokenRef.current;
    activeProjectCreateTokenRef.current = operationToken;
    dispatchProjectSetup({ type: "preparation-changed", isPreparing: true });
    let failurePhase: "initial-save" | "import" | "final-save" =
      projectSetup.creationCheckpoint === "initial-saved"
        ? "import"
        : "initial-save";
    let usingSessionWorkflow = false;
    let importAttempted = false;
    let setupSessionId: string | null = null;
    let setupSessionGeneration = -1;
    const isCurrentSetupOperation = () =>
      operationToken === projectSetupOperationTokenRef.current &&
      activeProjectCreateTokenRef.current === operationToken &&
      (
        setupSessionId === null ||
        (
          projectSessionIdRef.current === setupSessionId &&
          sessionGenerationRef.current === setupSessionGeneration
        )
      );
    try {
      await initialSessionPromiseRef.current;
      const activeSessionId = projectSessionIdRef.current;
      setupSessionId = activeSessionId;
      setupSessionGeneration = sessionGenerationRef.current;
      if (activeSessionId && !isCurrentSetupOperation()) return;
      if (sessionPersistenceRequired && !activeSessionId) {
        throw new Error("프로젝트 세션이 준비되지 않았습니다.");
      }
      if (activeSessionId && api.saveProjectAs && api.applyProjectMutation) {
        usingSessionWorkflow = true;
        await drainSessionMutationQueue();
        if (!isCurrentSetupOperation()) return;
        if (!(await syncProjectToSession()) || !isCurrentSetupOperation()) return;
        if (projectSetup.creationCheckpoint === "draft") {
          failurePhase = "initial-save";
          const initialSave = await api.saveProjectAs({
            projectSessionId: activeSessionId,
            ...(projectSetupStoragePath ? { filePath: projectSetupStoragePath } : {})
          });
          if (!isCurrentSetupOperation()) return;
          if (!initialSave) {
            setStatusMessage("프로젝트 만들기를 취소했습니다.");
            return;
          }
          setProjectRevision(initialSave.project.revision);
          projectRevisionRef.current = initialSave.project.revision;
          sessionProjectRef.current = initialSave.project.project;
          projectRef.current = initialSave.project.project;
          setProject(initialSave.project.project);
          setCurrentFilePath(`session:${activeSessionId}`);
          setIsDirty(initialSave.project.dirty);
          dispatchProjectSetup({
            type: "creation-checkpoint-changed",
            checkpoint: "initial-saved"
          });
          if (initialSave.recentProject) {
            setRecentProjects((current) => [
              initialSave.recentProject!,
              ...current.filter(
                (item) => item.recentProjectId !== initialSave.recentProject!.recentProjectId
              )
            ].slice(0, 8));
          }
        }
        failurePhase = "import";
        const opaqueBatches = new Map<string, Array<{ preparedImageId: string; pageNumber: number }>>();
        const legacyFiles: Array<{ sourcePath: string; pageNumber: number }> = [];
        projectSetup.files.forEach((file, index) => {
          if (file.importBatchId && file.preparedImageId) {
            const pages = opaqueBatches.get(file.importBatchId) ?? [];
            pages.push({ preparedImageId: file.preparedImageId, pageNumber: index + 1 });
            opaqueBatches.set(file.importBatchId, pages);
          } else if (file.sourcePath) {
            legacyFiles.push({ sourcePath: file.sourcePath, pageNumber: index + 1 });
          }
        });
        if (sessionPersistenceRequired && legacyFiles.length > 0) {
          throw new Error("Session-backed image setup requires opaque prepared images");
        }
        const results = [] as Awaited<ReturnType<NonNullable<typeof api.importPageImages>>>;
        for (const [importBatchId, pages] of opaqueBatches) {
          importAttempted = true;
          results.push(
            ...(await api.importPageImages({
              projectSessionId: activeSessionId,
              importBatchId,
              pages
            }))
          );
          if (!isCurrentSetupOperation()) return;
        }
        if (legacyFiles.length > 0) {
          importAttempted = true;
          results.push(
            ...(await api.importPageImages({
              projectSessionId: activeSessionId,
              files: legacyFiles
            }))
          );
          if (!isCurrentSetupOperation()) return;
        }
        const importedCount = results.filter((result) => result.ok).length;
        const failedCount = results.length - importedCount;
        if (importedCount === 0) {
          setStatusMessage(results.find((result) => !result.ok)?.message ?? "이미지를 불러오지 못했습니다.");
          return;
        }
        setIsDirty(true);
        failurePhase = "final-save";
        const finalSave = await api.saveProject({ projectSessionId: activeSessionId });
        if (!isCurrentSetupOperation()) return;
        if (!finalSave || !("project" in finalSave)) throw new Error("이미지 프로젝트를 저장하지 못했습니다.");
        setProjectRevision(finalSave.project.revision);
        projectRevisionRef.current = finalSave.project.revision;
        sessionProjectRef.current = finalSave.project.project;
        applyImageProjectStartResult({
          kind: failedCount > 0 ? "partial" : "success",
          filePath: `session:${activeSessionId}`,
          project: finalSave.project.project,
          importedCount,
          failedCount,
          dirty: false
        });
        if (!isCurrentSetupOperation()) return;
        await releasePreparedImages(projectSetup.files, activeSessionId);
        if (!isCurrentSetupOperation()) return;
        dispatchProjectSetup({ type: "reset" });
        return;
      }
      const result = await createImageProject({
        project,
        preparedImages: projectSetup.files,
        chooseSaveFile: async (args) => projectSetupStoragePath ?? api.chooseSaveFile!(args),
        saveProject: api.saveProject,
        importPageImages: api.importPageImages,
        releasePreparedPageImages: releasePreparedPreviewIds,
        onProgress: (phase) => {
          if (
            operationToken === projectSetupOperationTokenRef.current &&
            activeProjectCreateTokenRef.current === operationToken
          ) {
            setStatusMessage(progressMessage(phase));
          }
        }
      });

      if (
        operationToken !== projectSetupOperationTokenRef.current ||
        activeProjectCreateTokenRef.current !== operationToken
      ) return;

      if (result.kind === "canceled") {
        dispatchEntryFlow({ type: "create-canceled" });
        setStatusMessage("프로젝트 만들기를 취소했습니다.");
        return;
      }
      if (result.kind === "success" || result.kind === "partial") {
        applyImageProjectStartResult(result);
        dispatchProjectSetup({ type: "reset" });
        rememberRecentProject(result.filePath, result.project.metadata.title);
        return;
      }
      if ("filePath" in result && result.importedCount > 0) {
        await releasePreparedImages(projectSetup.files);
        if (
          operationToken !== projectSetupOperationTokenRef.current ||
          activeProjectCreateTokenRef.current !== operationToken
        ) return;
        applyImageProjectStartResult(result);
        dispatchProjectSetup({ type: "reset" });
        return;
      }
      if (result.kind === "failed") setStatusMessage(result.message);
    } catch (error) {
      if (!isCurrentSetupOperation()) return;
      if (!usingSessionWorkflow) {
        setStatusMessage(
          error instanceof Error ? error.message : "프로젝트를 만들지 못했습니다."
        );
      } else if (failurePhase === "initial-save") {
        setStatusMessage("프로젝트 저장 위치를 만들지 못했습니다. 다시 시도하세요.");
      } else if (failurePhase === "import") {
        if (importAttempted) setIsDirty(true);
        setStatusMessage("이미지 연결 중 실패했습니다. 이미 연결된 항목은 유지됩니다.");
      } else {
        setIsDirty(true);
        setStatusMessage(
          "이미지 연결 후 최종 저장에 실패했습니다. 다시 저장할 수 있습니다."
        );
      }
    } finally {
      if (activeProjectCreateTokenRef.current === operationToken) {
        activeProjectCreateTokenRef.current = null;
        dispatchProjectSetup({ type: "preparation-changed", isPreparing: false });
      }
    }
  }

  function progressMessage(phase: ImageProjectStartPhase): string {
    if (phase === "image-selection") return "이미지를 선택하세요.";
    if (phase === "save-selection") return "프로젝트 저장 위치를 선택하세요.";
    if (phase === "initial-save") return "프로젝트를 만드는 중입니다.";
    if (phase === "image-import") return "이미지를 불러오는 중입니다.";
    return "이미지를 프로젝트에 저장하는 중입니다.";
  }

  function applyImageProjectStartResult(result: ImageProjectStartResult) {
    if (result.kind === "canceled") {
      setStatusMessage(result.step === "image-selection" ? "이미지 불러오기를 취소했습니다." : "프로젝트 만들기를 취소했습니다.");
      return;
    }
    if (result.kind === "failed" && !("filePath" in result)) {
      setStatusMessage(result.message);
      return;
    }

    invalidateOpenProjectOperation();
    invalidateTxtImportOperation();
    resetImagePanelContext();
    setProject(normalizeProject(result.project));
    setPendingPageNumbers([]);
    setCurrentFilePath(result.filePath);
    clearSpeechBubbleReview();
    setPageAndSelection(1, { lines: result.project.dialogueLines, pageImages: result.project.pageImages, selectedLineId: null });
    setIsDirty(result.dirty);
    setImageImportFailureCount(result.failedCount);
    dispatchEntryFlow({
      type: "project-installed",
      hasContent: result.project.dialogueLines.length > 0 || result.project.pageImages.length > 0
    });

    if (result.kind === "success") {
      setStatusMessage(`이미지 ${result.importedCount}개를 불러왔습니다.`);
    } else if (result.kind === "partial") {
      setStatusMessage(`이미지 ${result.importedCount}개를 불러왔고 ${result.failedCount}개를 불러오지 못했습니다.`);
    } else if (result.kind === "failed") {
      setStatusMessage(result.message);
    }
  }

  function rememberRecentProject(_filePath: string, title: string) {
    const recentProjectId = globalThis.crypto?.randomUUID?.() ?? `recent-${Date.now()}`;
    setRecentProjects(
      addRecentProject(window.localStorage, {
        recentProjectId,
        title: title.trim() || "제목 없는 프로젝트",
        openedAt: new Date().toISOString()
      })
    );
  }

  function renameProject(title: string) {
    if (blockProjectSessionRecovery()) return;
    queueSessionMutation({ type: "set_project_title", title });
    setIsDirty(true);
    setProject((current) => ({
      ...current,
      metadata: {
        ...current.metadata,
        title,
        updatedAt: new Date().toISOString()
      }
    }));
  }

  async function toggleSecret(secret: boolean) {
    if (dialogs.isPending()) return;
    if (secret === project.metadata.secret) return;
    if (blockProjectSessionRecovery()) return;
    if (sessionConflictRef.current) {
      if (sessionConflictNoticeRef.current) setStatusMessage(sessionConflictNoticeRef.current);
      return;
    }
    if (currentFilePath) {
      setStatusMessage("저장한 프로젝트의 보호 모드는 바꿀 수 없습니다. Rekey를 사용하세요.");
      return;
    }
    const api = window.projectApi;
    if (!api?.createProjectSession) {
      setIsDirty(true);
      setProject((current) => ({
        ...current,
        metadata: {
          ...current.metadata,
          secret,
          updatedAt: new Date().toISOString()
        }
      }));
      return;
    }
    const startedSessionId = projectSessionIdRef.current;
    const startedSessionInstance = projectSessionInstanceRef.current;
    const startedGeneration = sessionGenerationRef.current;
    const startedProjectId = projectRef.current.metadata.id;
    const isCurrentToggleScope = () =>
      projectSessionIdRef.current === startedSessionId &&
      projectSessionInstanceRef.current === startedSessionInstance &&
      sessionGenerationRef.current === startedGeneration &&
      projectRef.current.metadata.id === startedProjectId &&
      projectSessionStatusRef.current === "active" && !sessionConflictRef.current;
    const isCurrentPromptScope = captureProjectDialogScope();
    const password = secret ? (await dialogs.prompt({ title: "새 시크릿 프로젝트의 암호", message: "프로젝트를 보호할 암호를 입력하세요.", password: true, fieldLabel: "프로젝트 암호", confirmLabel: "보호 모드 적용" }))?.trim() : undefined;
    if (!isCurrentPromptScope() || !isCurrentToggleScope()) return;
    if (secret && !password) {
      setStatusMessage("시크릿 프로젝트 암호가 필요합니다.");
      return;
    }

    const closeCreatedSession = async (sessionId: string) => {
      if (!api.closeProject || projectSessionIdRef.current === sessionId) return;
      try {
        await api.closeProject({ projectSessionId: sessionId });
      } catch {
        cleanupPendingSessionIdsRef.current.add(sessionId);
      }
    };

    let createdSessionId: string | null = null;
    try {
      await drainSessionMutationQueue();
      if (!isCurrentToggleScope()) return;

      const result = await api.createProjectSession({
        title: projectRef.current.metadata.title,
        secret,
        ...(password ? { password } : {})
      });
      createdSessionId = result.projectSessionId;
      if (!isCurrentToggleScope()) {
        await closeCreatedSession(result.projectSessionId);
        return;
      }

      await drainSessionMutationQueue();
      if (!isCurrentToggleScope()) {
        await closeCreatedSession(result.projectSessionId);
        return;
      }

      const desiredProject = {
        ...projectRef.current,
        metadata: {
          ...projectRef.current.metadata,
          secret,
          updatedAt: new Date().toISOString()
        }
      } as TranslationProjectV2;
      installSessionResult(result, false);
      projectRef.current = desiredProject;
      setProject(desiredProject);
      setIsDirty(true);
      queueProjectDiff(result.project.project, desiredProject);
      if (startedSessionId && startedSessionId !== result.projectSessionId && api.closeProject) {
        await api.closeProject({ projectSessionId: startedSessionId });
      }
    } catch (error) {
      if (createdSessionId && projectSessionIdRef.current !== createdSessionId) {
        await closeCreatedSession(createdSessionId);
      }
      const stillOnStartedScope = isCurrentToggleScope();
      const installedCreatedSession = createdSessionId !== null &&
        projectSessionIdRef.current === createdSessionId;
      if (!stillOnStartedScope && !installedCreatedSession) return;
      setStatusMessage(error instanceof Error ? error.message : "프로젝트 보호 모드를 바꾸지 못했습니다.");
    }
  }

  function goToPreviousPage() {
    pendingIssueNavigationRef.current = null;
    setCurrentIssue(null);
    setIssueFocusRequest(null);
    setIssueEditor(null);
    setPageAndSelection(Math.max(1, currentPage - 1));
  }

  function goToNextPage() {
    pendingIssueNavigationRef.current = null;
    setCurrentIssue(null);
    setIssueFocusRequest(null);
    setIssueEditor(null);
    setPageAndSelection(Math.min(pageCount, currentPage + 1));
  }

  function goToRemainingActionableLine() {
    if (!nextActionableProjectLine) return;
    setPageAndSelection(nextActionableProjectLine.pageNumber, { selectedLineId: nextActionableProjectLine.id });
    setStatusMessage("남은 번역 대사로 이동했습니다.");
  }

  function setPageAndSelection(
    page: number,
    options: {
      lines?: DialogueLine[];
      pageImages?: { pageNumber: number }[];
      selectedLineId?: string | null;
    } = {}
  ) {
    const nextLines = options.lines ?? project.dialogueLines;
    const nextPageCount = getPageCount(nextLines, options.pageImages ?? project.pageImages);
    const nextPage = Math.min(nextPageCount, Math.max(1, page));
    const hadOcrError = Boolean(ocrError);
    if (finalReading) readingSelectionsRef.current.set(currentPage, selectedLineId);
    const readingSelection = finalReading ? readingSelectionsRef.current.get(nextPage) : undefined;

    if (nextPage !== currentPage) {
      cancelActiveOcr();
      cancelActiveInpainting();
      const nextPageImage = project.pageImages.find((image) => image.pageNumber === nextPage);
      const savedReview = nextPageImage ? ocrReviewDraftsRef.current.get(nextPageImage.id) : undefined;
      const matchingReview = savedReview && savedReview.sourceSha256 === nextPageImage?.sha256 ? savedReview : undefined;
      setSpeechBubbleReview(matchingReview?.result ?? null);
      setReviewStage(matchingReview?.stage ?? "ocr");
      setActiveReviewItem(null);
      setOcrError(null);
      if (matchingReview) {
        setStatusMessage("이 페이지의 미적용 OCR 검토 초안을 복원했습니다.");
      } else if (hadOcrError) {
        setStatusMessage("페이지를 이동해 이전 OCR 오류를 지웠습니다.");
      }
    }
    setCurrentPage(nextPage);
    setSelectedLineId(
      options.selectedLineId !== undefined
        ? options.selectedLineId
        : readingSelection !== undefined
          ? readingSelection
          : getNextActionableLineId(nextLines, null, nextPage)
    );
  }

  const selectLine = useCallback((lineId: string) => {
    setFinalReading(false);
    const line = project.dialogueLines.find((candidate) => candidate.id === lineId);
    if (!line) return;
    pendingIssueNavigationRef.current = null;
    setCurrentIssue(null);
    setIssueEditor(null);
    setPageAndSelection(line.pageNumber, { selectedLineId: lineId });
  }, [currentPage, finalReading, selectedLineId, ocrError, pageCount, project.dialogueLines, project.pageImages, speechBubbleReview]);

  function bumpIssueRenderRevision() {
    issueRenderRevisionRef.current += 1;
    setIssueRenderRevision(issueRenderRevisionRef.current);
  }

  function selectIssueLine(line: DialogueLine) {
    setFinalReading(false);
    const focusBbox = findIssueFocusBbox(line, speechBubbleReview);
    const target = prepareIssueNavigation(line, { focusBbox });
    if (!target) return;

    // A pending transaction is only preliminary UI. Superseding it must start
    // from the last confirmed snapshot, so a fast second click cannot commit
    // against page/editor/overlay state from the first target.
    const superseded = pendingIssueNavigationRef.current;
    if (superseded) {
      pendingIssueNavigationRef.current = null;
      bumpIssueRenderRevision();
    }
    const snapshot: IssueNavigationSnapshot = superseded?.snapshot ?? {
      currentIssueId: currentIssue?.lineId ?? null,
      currentPage,
      selectedLineId,
      editor: issueEditor,
      visibleOverlayKinds: [...visibleOverlayKinds],
      viewport: workspaceViewport,
      currentIssue,
      reviewStage,
      speechBubbleReview,
      activeReviewItem,
      focusRequest: issueFocusRequest,
      initialViewport: initialImageViewport,
      imageResetRevision,
      workspaceZoom
    };
    const token = `issue-navigation-${++issueNavigationTokenRef.current}`;
    const targetPageImage = (project.pageImages ?? []).find((image) => image.pageNumber === target.pageNumber) ?? null;
    const expectedPageImageId = targetPageImage?.id ?? null;
    const pending: PendingIssueNavigation = {
      token,
      projectId: project.metadata.id,
      target,
      snapshot,
      expectedPageImageId
    };

    setPageAndSelection(target.pageNumber, { selectedLineId: target.lineId });
    setVisibleOverlayKinds([
      ...snapshot.visibleOverlayKinds,
      ...target.requiredOverlays.filter((kind) => !snapshot.visibleOverlayKinds.includes(kind))
    ]);
    if (target.editor === "ocr" || target.editor === "speaker") setReviewStage(target.editor);

    if (!targetPageImage) {
      commitIssueNavigation(pending);
      return;
    }

    const currentRender = pageRenderStateRef.current;
    const targetWasReady = expectedPageImageId !== null && readyPageImageIdsRef.current.has(
      `${target.pageNumber}:${expectedPageImageId}`
    );
    if (
      target.pageNumber === snapshot.currentPage &&
      ((currentRender.status === "ready" && currentRender.pageImageId === expectedPageImageId) || targetWasReady)
    ) {
      commitIssueNavigation(pending);
      return;
    }

    bumpIssueRenderRevision();
    pendingIssueNavigationRef.current = pending;
  }

  function commitIssueNavigation(pending: PendingIssueNavigation) {
    if (pendingIssueNavigationRef.current && pendingIssueNavigationRef.current.token !== pending.token) return;
    const committed = commitOrRollbackIssueNavigation(
      pending.snapshot,
      pending.target,
      { ok: true, transactionId: pending.token, expectedTransactionId: pending.token }
    );
    setCurrentIssue(pending.target);
    setIssueEditor(committed.editor);
    setIssueFocusRequest({ key: pending.token, bbox: pending.target.focusBbox });
    if (pending.target.editor === "translation") setFocusNewManualTranslation(true);
    resetIssueViewport(pending.token, committed.viewport);
    pendingIssueNavigationRef.current = null;
    setStatusMessage(`문제 라인 ${pending.target.line.order}으로 이동했습니다.`);
  }

  function rollbackIssueNavigation(pending: PendingIssueNavigation, reason = "문제 라인으로 이동하지 못해 이전 문맥을 유지했습니다.") {
    if (pendingIssueNavigationRef.current && pendingIssueNavigationRef.current.token !== pending.token) return;
    const restored = commitOrRollbackIssueNavigation(
      pending.snapshot,
      pending.target,
      { ok: false, transactionId: pending.token, expectedTransactionId: pending.token }
    );
    const restoredPage = Math.min(
      getPageCount(projectRef.current.dialogueLines, projectRef.current.pageImages),
      Math.max(1, restored.currentPage)
    );
    const restoredSelectedLineId = restored.selectedLineId && projectRef.current.dialogueLines.some(
      (line) => line.id === restored.selectedLineId
    )
      ? restored.selectedLineId
      : getNextActionableLineId(projectRef.current.dialogueLines, null, restoredPage);
    setCurrentPage(restoredPage);
    setSelectedLineId(restoredSelectedLineId);
    setCurrentIssue(pending.snapshot.currentIssue);
    setIssueEditor(pending.snapshot.editor);
    // Restoring a snapshot must not re-run a previous focus request after its
    // viewport has been restored; the current issue overlay remains visible
    // without moving the user's restored pan.
    setIssueFocusRequest(null);
    setVisibleOverlayKinds([...pending.snapshot.visibleOverlayKinds]);
    setReviewStage(pending.snapshot.reviewStage);
    setSpeechBubbleReview(pending.snapshot.speechBubbleReview);
    setActiveReviewItem(pending.snapshot.activeReviewItem);
    restoreIssueViewport(pending.snapshot);
    bumpIssueRenderRevision();
    pendingIssueNavigationRef.current = null;
    setStatusMessage(reason);
  }

  const handlePageImageRenderState = useCallback((state: PageImageRenderState) => {
    const currentPageImageId = (projectRef.current.pageImages ?? []).find(
      (image) => image.pageNumber === currentPageRef.current
    )?.id ?? null;
    if (state.currentPage !== currentPageRef.current || state.pageImageId !== currentPageImageId) return;
    const expectedRequestKey = currentRenderRequestKeyRef.current;
    if (!expectedRequestKey || state.renderRequestKey !== expectedRequestKey) return;
    const acceptedGeneration = currentRenderGenerationRef.current;
    if (acceptedGeneration !== null && state.renderGeneration !== acceptedGeneration) return;
    // The first callback for this App-controlled request establishes only the
    // render generation. The request key itself was set synchronously from
    // controlled props above, so a late callback cannot replace it.
    if (acceptedGeneration === null) currentRenderGenerationRef.current = state.renderGeneration;
    pageRenderStateRef.current = state;
    if (state.pageImageId) {
      const readyKey = `${state.currentPage}:${state.pageImageId}`;
      if (state.status === "ready") readyPageImageIdsRef.current.add(readyKey);
      if (state.status === "failed") readyPageImageIdsRef.current.delete(readyKey);
    }
    setCurrentPageImageLoadFailed(state.status === "failed");
    const pending = pendingIssueNavigationRef.current;
    if (!pending || currentPageRef.current !== pending.target.pageNumber || state.currentPage !== pending.target.pageNumber) return;
    if (state.pageImageId !== pending.expectedPageImageId) return;
    if (state.status === "ready") {
      commitIssueNavigation(pending);
    } else if (state.status === "failed") {
      rollbackIssueNavigation(pending, "대상 페이지 이미지를 불러오지 못해 이전 문제 문맥을 복원했습니다.");
    }
  }, []);

  function resetIssueViewport(token: string, previousViewport: ImageViewportState | null) {
    const base = previousViewport ?? createImageViewportState();
    const preservedZoom = Math.max(1, base.zoom);
    const nextViewport: ImageViewportState = {
      ...base,
      viewMode: preservedZoom === 1 ? "fit" : "actual",
      zoom: preservedZoom,
      pan: { x: 0, y: 0 }
    };
    setWorkspaceViewport(nextViewport);
    setWorkspaceZoom(preservedZoom);
    viewportSeedRevisionRef.current += 1;
    setInitialImageViewport({
      key: `${projectRef.current.metadata.id}:issue:${token}:${viewportSeedRevisionRef.current}`,
      ...nextViewport
    });
    setImageResetRevision((current) => current + 1);
  }

  function restoreIssueViewport(snapshot: IssueNavigationSnapshot) {
    const restored = snapshot.viewport
      ? {
          ...snapshot.viewport,
          pan: { ...snapshot.viewport.pan },
          layers: { ...snapshot.viewport.layers }
        }
      : createImageViewportState();
    setWorkspaceViewport(restored);
    setWorkspaceZoom(snapshot.workspaceZoom);
    viewportSeedRevisionRef.current += 1;
    setInitialImageViewport({
      key: `${projectRef.current.metadata.id}:issue-rollback:${issueNavigationTokenRef.current}:${viewportSeedRevisionRef.current}`,
      ...restored
    });
    setImageResetRevision((current) => current + 1);
  }

  async function importPageImages() {
    if (blockProjectSessionRecovery()) return;
    if (!window.projectApi?.importPageImages) return;
    if (newProjectSwitchInFlightRef.current) return;
    if (activePageImageImportOperationRef.current !== null) return;
    if (imageRelinkProcessingDisabledReason) {
      setStatusMessage(imageRelinkProcessingDisabledReason);
      return;
    }
    if (project.metadata.secret) {
      setStatusMessage("시크릿 프로젝트에서는 이미지 업로드가 아직 지원되지 않습니다.");
      return;
    }
    if (!currentFilePath) {
      setStatusMessage("이미지를 업로드하려면 먼저 프로젝트를 저장하세요.");
      return;
    }

    const operation = {};
    const operationSessionId = projectSessionIdRef.current;
    const operationSessionGeneration = sessionGenerationRef.current;
    const operationProjectId = projectRef.current.metadata.id;
    const isCurrentOperation = () =>
      activePageImageImportOperationRef.current === operation &&
      projectSessionIdRef.current === operationSessionId &&
      sessionGenerationRef.current === operationSessionGeneration &&
      projectRef.current.metadata.id === operationProjectId;
    let preparedBatch: PreparedPageImageBatchDto | null = null;
    let linkedPreparedBatch = false;
    activePageImageImportOperationRef.current = operation;
    setIsImportingPageImages(true);

    try {
      if (operationSessionId && window.projectApi.choosePageImages) {
        const batch = await window.projectApi.choosePageImages({
          projectSessionId: operationSessionId
        });
        preparedBatch = batch;
        if (!isCurrentOperation()) {
          if (batch) {
            await releasePreparedImages(preparedImagesFromBatch(batch), operationSessionId);
          }
          return;
        }
        if (!batch || batch.images.length === 0) {
          setStatusMessage("이미지 업로드를 취소했습니다.");
          return;
        }
        if (!(await confirmRelinkDraftLoss(batch.images.length)) || !isCurrentOperation()) {
          await releasePreparedImages(preparedImagesFromBatch(batch), operationSessionId);
          preparedBatch = null;
          return;
        }
        const results = await window.projectApi.importPageImages({
          projectSessionId: operationSessionId,
          importBatchId: batch.importBatchId,
          pages: batch.images.map((image, index) => ({
            preparedImageId: image.preparedImageId,
            pageNumber: currentPage + index
          }))
        });
        linkedPreparedBatch = results.some(
          (result) => result.ok && "pendingPageImage" in result
        );
        if (!isCurrentOperation()) return;
        const linkedCount = results.filter(
          (result) => result.ok && "pendingPageImage" in result
        ).length;
        const linkedPageNumbers = results.flatMap((result) =>
          result.ok && "pendingPageImage" in result ? [result.pendingPageImage.pageNumber] : []
        );
        const failedCount = results.length - linkedCount;
        setImageImportFailureCount(failedCount);
        if (linkedCount === 0) {
          setStatusMessage(
            results[0]?.ok === false
              ? results[0].message
              : "이미지 파일을 불러오지 못했습니다."
          );
          return;
        }
        discardDraftsForRelink(linkedPageNumbers);
        setPageResultContexts((current) => {
          let next = current;
          for (const pageNumber of linkedPageNumbers) {
            const key = resultContextKey(project.metadata.id, pageNumber);
            if (next === current) next = { ...current };
            next[key] = {
              // Keep the pending link independent of the old file. Until the
              // session save returns its new PageImage, the current project
              // image is the safe fallback; the seed effect then fills the
              // fresh original after the DTO is installed.
              original: null,
              inpainted: null,
              translated: null
            };
          }
          return next;
        });
        setPendingPageNumbers((current) => [
          ...new Set([...current, ...linkedPageNumbers])
        ]);
        setIsDirty(true);
        setStatusMessage(
          `이미지 ${linkedCount}개를 저장 대기 상태로 등록했습니다.`
        );
        return;
      }

      const sourcePaths = await chooseImageSourcePaths();
      if (!isCurrentOperation()) return;
      if (sourcePaths.length === 0) {
        setStatusMessage("이미지 업로드를 취소했습니다.");
        return;
      }
      if (!(await confirmRelinkDraftLoss(sourcePaths.length)) || !isCurrentOperation()) return;

      const results = await window.projectApi.importPageImages({
        ...(operationSessionId
          ? { projectSessionId: operationSessionId }
          : { projectFilePath: currentFilePath }),
        files: sourcePaths.map((sourcePath, index) => ({
          sourcePath,
          pageNumber: currentPage + index
        }))
      });
      if (!isCurrentOperation()) return;
      const importedImages = results.flatMap((result) =>
        result.ok && "pageImage" in result ? [result.pageImage] : []
      );
      setImageImportFailureCount(results.length - importedImages.length);
      if (importedImages.length === 0) {
        setStatusMessage(
          results[0]?.ok === false
            ? results[0].message
            : "이미지 파일을 불러오지 못했습니다."
        );
        return;
      }
      discardDraftsForRelink(importedImages.map((image) => image.pageNumber));

      setPageResultContexts((current) => {
        let next = current;
        for (const importedImage of importedImages) {
          const key = resultContextKey(project.metadata.id, importedImage.pageNumber);
          if (next === current) next = { ...current };
          next[key] = { original: importedImage, inpainted: null, translated: null };
        }
        return next;
      });
      setProject((current) => ({
        ...current,
        pageImages: [
          ...(current.pageImages ?? []).filter(
            (image) => !importedImages.some(
              (nextImage) => nextImage.pageNumber === image.pageNumber
            )
          ),
          ...importedImages
        ],
        metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
      }));
      if (operationSessionId) {
        setPendingPageNumbers((current) => [
          ...new Set([...current, ...importedImages.map((image) => image.pageNumber)])
        ]);
      }
      setIsDirty(true);
      setStatusMessage(`이미지 ${importedImages.length}개를 등록했습니다.`);
    } catch {
      if (preparedBatch && !linkedPreparedBatch && operationSessionId) {
        await releasePreparedImages(
          preparedImagesFromBatch(preparedBatch),
          operationSessionId
        );
      }
      if (isCurrentOperation()) {
        setStatusMessage("이미지 파일을 불러오지 못했습니다. 파일과 저장 권한을 확인하세요.");
      }
    } finally {
      if (activePageImageImportOperationRef.current === operation) {
        activePageImageImportOperationRef.current = null;
        setIsImportingPageImages(false);
      }
    }
  }

  async function confirmRelinkDraftLoss(count: number): Promise<boolean> {
    const pageIds = new Set(projectRef.current.pageImages
      .filter((image) => image.pageNumber >= currentPage && image.pageNumber < currentPage + count)
      .map((image) => image.id));
    const ocrDrafts = [...ocrReviewDraftsRef.current.entries()].filter(([id]) => pageIds.has(id));
    const maskDrafts = [...inpaintingMaskDraftsRef.current.entries()].filter(([, value]) => pageIds.has(value.pageImageId));
    const typesettingDrafts = [...manualTypesettingDraftsRef.current.entries()].filter(([, value]) => pageIds.has(value.pageImageId));
    if (ocrDrafts.length === 0 && maskDrafts.length === 0 && typesettingDrafts.length === 0) return true;
    const isCurrentScope = captureProjectDialogScope();
    const approved = await dialogs.confirm({
      title: "이미지를 다시 연결할까요?",
      message: "바뀌는 페이지의 미적용 OCR 검토, 배경 마스크와 글자 배치 초안은 복원할 수 없습니다.",
      confirmLabel: "초안을 버리고 연결",
      cancelLabel: "계속 편집",
      danger: true
    });
    return approved && isCurrentScope() &&
      ocrDrafts.every(([id, value]) => ocrReviewDraftsRef.current.get(id) === value) &&
      maskDrafts.every(([key, value]) => inpaintingMaskDraftsRef.current.get(key) === value) &&
      typesettingDrafts.every(([key, value]) => manualTypesettingDraftsRef.current.get(key) === value);
  }

  function discardDraftsForRelink(pageNumbers: number[]) {
    const pageIds = new Set(projectRef.current.pageImages.filter((image) => pageNumbers.includes(image.pageNumber)).map((image) => image.id));
    for (const id of pageIds) ocrReviewDraftsRef.current.delete(id);
    for (const [key, value] of inpaintingMaskDraftsRef.current) {
      if (pageIds.has(value.pageImageId)) inpaintingMaskDraftsRef.current.delete(key);
    }
    for (const [key, value] of manualTypesettingDraftsRef.current) {
      if (pageIds.has(value.pageImageId)) manualTypesettingDraftsRef.current.delete(key);
    }
    setOcrReviewDraftCount(ocrReviewDraftsRef.current.size);
    setInpaintingMaskDraftCount(inpaintingMaskDraftsRef.current.size);
    setManualTypesettingDraftCount(manualTypesettingDraftsRef.current.size);
    if (currentPageImageRef.current && pageIds.has(currentPageImageRef.current.id)) clearSpeechBubbleReview();
  }

  async function inpaintCurrentPageImage(args: {
    maskPngBase64: string;
    mode: InpaintingMode;
    provider: InpaintingProvider;
    promptOverride?: string;
    options?: {
      conservative?: boolean;
      skipOnLowConfidence?: boolean;
      dilatePixels?: number;
    };
  }): Promise<boolean> {
    if (blockProjectSessionRecovery()) return false;
    if (sessionConflictRef.current) {
      if (sessionConflictNoticeRef.current) setStatusMessage(sessionConflictNoticeRef.current);
      return false;
    }
    if (newProjectSwitchInFlightRef.current) return false;
    if (inpaintingDisabledReason) {
      setStatusMessage(inpaintingDisabledReason);
      return false;
    }
    if (isInpainting) return false;
    if (!window.projectApi?.inpaintPageImage) {
      setStatusMessage("인페인팅 기능을 사용할 수 없습니다.");
      return false;
    }
    if (!currentFilePath) {
      setStatusMessage("인페인팅을 실행하려면 먼저 프로젝트를 저장하세요.");
      return false;
    }
    if (!currentPageImage) {
      setStatusMessage("현재 페이지 이미지가 없어 인페인팅을 실행할 수 없습니다.");
      return false;
    }

    const requestFilePath = currentFilePath;
    const requestPageImage = currentPageImage;
    const requestProjectId = project.metadata.id;
    const requestSessionId = projectSessionIdRef.current ?? projectSessionId;
    const requestSessionInstance = projectSessionInstanceRef.current;
    const requestSessionGeneration = sessionGenerationRef.current;
    const requestResultLayer = resultLayerRef.current;
    const requestResultLayerUserRevision = resultLayerUserRevisionRef.current;
    const active: ActiveInpaintingRequest = {
      requestId: createRendererId("inpainting", `${Date.now()}-${requestPageImage.id}`),
      projectSessionId: requestSessionId,
      projectId: requestProjectId,
      filePath: requestFilePath,
      pageImageId: requestPageImage.id,
      storedRelativePath: requestPageImage.storedRelativePath
    };
    const isCurrentInpaintingSession = () =>
      !active.canceledByUser && projectSessionIdRef.current === requestSessionId &&
      projectSessionInstanceRef.current === requestSessionInstance &&
      sessionGenerationRef.current === requestSessionGeneration &&
      projectRef.current.metadata.id === requestProjectId &&
      projectSessionStatusRef.current === "active" && !sessionConflictRef.current;
    activeInpaintingRequestRef.current = active;
    backendCancelFeedbackGenerationRef.current += 1;
    setPendingInpaintingContext({
      projectId: requestProjectId,
      pageNumber: requestPageImage.pageNumber,
      pageImageId: requestPageImage.id
    });
    setIsInpainting(true);
    try {
      const inpaintedResult = await window.projectApi.inpaintPageImage({
        requestId: active.requestId,
        ...(projectSessionId
          ? { projectSessionId, pageImageId: requestPageImage.id }
          : { projectFilePath: requestFilePath, pageImage: requestPageImage }),
        maskPngBase64: args.maskPngBase64,
        mode: args.mode,
        provider: args.provider,
        promptOverride: args.promptOverride,
        options: args.options
      });
      if (!isCurrentInpaintingSession()) return false;
      const inpaintedImage = pageImageFromInpaintingResult(inpaintedResult);

      const sessionResult = isInpaintPageImageResult(inpaintedResult)
        ? inpaintedResult.sessionResult
        : undefined;
      let acceptedSessionResult = !sessionResult;
      if (sessionResult) {
        const sessionProject = sessionResult.project;
        const sameSessionAndProject = Boolean(
          requestSessionId &&
          sessionResult.projectSessionId === requestSessionId &&
          projectSessionIdRef.current === requestSessionId &&
          projectIdRef.current === requestProjectId &&
          sessionProject.project.metadata.id === requestProjectId
        );
        acceptedSessionResult =
          sameSessionAndProject && sessionProject.revision >= projectRevisionRef.current;
        if (acceptedSessionResult) {
          if (sessionProject.status !== "active") {
            if (sessionProject.status === "needs_recovery") adoptProjectSessionDto(sessionProject);
            return false;
          }
          const hasLocalChanges = sessionMutationFailedRef.current || queuedSessionMutationCountRef.current > 0 ||
            (sessionProjectRef.current !== null && projectRef.current !== sessionProjectRef.current);
          setProjectRevision(sessionProject.revision);
          projectRevisionRef.current = sessionProject.revision;
          setPendingPageNumbers((current) => mergePendingPageNumbers(current, sessionProject.pendingPageImages));
          sessionProjectRef.current = sessionProject.project;
          if (!hasLocalChanges) {
            projectRef.current = sessionProject.project;
            setProject(sessionProject.project);
            setIsDirty(sessionProject.dirty);
          } else {
            setIsDirty(true);
          }
        }
      }

      const latestImage = currentPageImageRef.current;
      const currentImageMismatch = (
        activeInpaintingRequestRef.current !== active ||
        currentFilePathRef.current !== requestFilePath ||
        projectIdRef.current !== requestProjectId ||
        !latestImage ||
        latestImage.id !== requestPageImage.id ||
        latestImage.storedRelativePath !== requestPageImage.storedRelativePath
      );
      if (currentImageMismatch) {
        return false;
      }

      const staleSessionResult = Boolean(sessionResult && !acceptedSessionResult);
      const contextKey = resultContextKey(requestProjectId, requestPageImage.pageNumber);
      setPageResultContexts((current) => {
        const existing = current[contextKey];
        return {
          ...current,
          [contextKey]: {
            original: existing?.original ?? requestPageImage,
            inpainted: inpaintedImage,
            translated: existing?.translated ?? null
          }
        };
      });
      if (isInpaintPageImageResult(inpaintedResult)) {
        if (!inpaintedResult.sessionResult) {
          setProject((current) => applyApprovedInpaintingResult(current, inpaintedResult));
          setIsDirty(true);
        }
      } else {
        setProject((current) => ({
          ...current,
          pageImages: [
            ...(current.pageImages ?? []).filter((image) => image.pageNumber !== requestPageImage.pageNumber),
            inpaintedImage
          ],
          metadata: { ...current.metadata, updatedAt: new Date().toISOString() }
        }));
        setIsDirty(true);
      }
      if (staleSessionResult) {
        setStatusMessage("인페인팅 결과가 오래되어 최신 작업대 상태를 유지했습니다.");
        return true;
      }
      const providerName = args.provider === "gemini" ? "Gemini" : "OpenAI";
      const userKeptResultLayer = (
        resultLayerUserRevisionRef.current !== requestResultLayerUserRevision ||
        resultLayerRef.current !== requestResultLayer
      );
      if (userKeptResultLayer) {
        setStatusMessage(`${providerName} 인페인팅 결과가 준비되었습니다. 현재 결과 레이어를 유지합니다.`);
      } else {
        setProgrammaticResultLayer("inpainted");
        setStatusMessage(`${providerName} 인페인팅 결과 레이어로 전환했습니다.`);
      }
      return true;
    } catch (error) {
      if (activeInpaintingRequestRef.current !== active || !isCurrentInpaintingSession() || isAbortLikeError(error)) return false;
      setStatusMessage(error instanceof Error ? error.message : "인페인팅을 실행하지 못했습니다.");
      return false;
    } finally {
      if (activeInpaintingRequestRef.current === active) {
        activeInpaintingRequestRef.current = null;
        setPendingInpaintingContext((current) =>
          current &&
          current.projectId === requestProjectId &&
          current.pageNumber === requestPageImage.pageNumber &&
          current.pageImageId === requestPageImage.id
            ? null
            : current
        );
        setIsInpainting(false);
      }
    }
  }

  function cancelActiveInpainting(options: { notify?: boolean } = {}): boolean {
    const active = activeInpaintingRequestRef.current;
    if (!active) return false;
    if (options.notify) active.canceledByUser = true;
    activeInpaintingRequestRef.current = null;
    setIsInpainting(false);
    setPendingInpaintingContext(null);
    requestBackendCancel(
      window.projectApi?.cancelInpainting
        ? () => window.projectApi.cancelInpainting!({ requestId: active.requestId })
        : undefined,
      {
        notify: options.notify,
        confirmedMessage: options.notify ? "인페인팅 요청을 취소했습니다." : undefined
      }
    );
    return true;
  }

  function isCurrentPageImageRequest(
    requestFilePath: string,
    requestProjectId: string,
    requestPageImage: { id: string; storedRelativePath: string },
    requestToken: number,
    latestImage: { id: string; storedRelativePath: string } | null
  ) {
    return (
      ocrRequestTokenRef.current === requestToken &&
      currentFilePathRef.current === requestFilePath &&
      projectIdRef.current === requestProjectId &&
      Boolean(
        latestImage &&
          latestImage.id === requestPageImage.id &&
          latestImage.storedRelativePath === requestPageImage.storedRelativePath
      )
    );
  }

  function isCurrentOcrRequest(active: ActiveOcrRequest): boolean {
    return (
      activeOcrRequestRef.current === active &&
      active.projectSessionId === projectSessionIdRef.current &&
      active.sessionGeneration === sessionGenerationRef.current &&
      active.projectId === projectRef.current.metadata.id &&
      isCurrentPageImageRequest(
        active.filePath,
        active.projectId,
        { id: active.pageImageId, storedRelativePath: active.storedRelativePath },
        active.token,
        currentPageImageRef.current
      )
    );
  }

  function resetSpeechBubbleReviewState() {
    setSpeechBubbleReview(null);
    setReviewStage("ocr");
    setActiveReviewItem(null);
    setOcrError(null);
  }

  function clearSpeechBubbleReview() {
    ocrRequestTokenRef.current += 1;
    resetSpeechBubbleReviewState();
  }

  function discardSpeechBubbleReview(pageImageId: string) {
    ocrReviewDraftsRef.current.delete(pageImageId);
    setOcrReviewDraftCount(ocrReviewDraftsRef.current.size);
  }

  function clearAllSpeechBubbleReviews() {
    ocrReviewDraftsRef.current.clear();
    setOcrReviewDraftCount(0);
    inpaintingMaskDraftsRef.current.clear();
    setInpaintingMaskDraftCount(0);
    manualTypesettingDraftsRef.current.clear();
    setManualTypesettingDraftCount(0);
    clearSpeechBubbleReview();
  }

  function setCurrentReviewStage(stage: ReviewStage) {
    const pageImageId = speechBubbleReview?.productionOcrContext?.pageImageId;
    const pending = pageImageId ? ocrReviewDraftsRef.current.get(pageImageId) : undefined;
    if (pageImageId && pending?.result === speechBubbleReview && pending.stage !== stage) {
      ocrReviewDraftsRef.current.set(pageImageId, { ...pending, stage });
    }
    setReviewStage(stage);
  }

  function rememberSpeechBubbleReviewDraft(draft: SpeechBubbleReviewDraft) {
    if (activePageImageImportOperationRef.current) return;
    const pageImageId = speechBubbleReview?.productionOcrContext?.pageImageId;
    const pending = pageImageId ? ocrReviewDraftsRef.current.get(pageImageId) : undefined;
    if (pageImageId && pending?.result === speechBubbleReview &&
      (pending.draft?.items !== draft.items || pending.draft.activeReviewId !== draft.activeReviewId)) {
      ocrReviewDraftsRef.current.set(pageImageId, { ...pending, draft });
    }
  }

  function resumeSpeechBubbleReview() {
    if (!currentPageImage) return;
    const pending = ocrReviewDraftsRef.current.get(currentPageImage.id);
    if (!pending || pending.sourceSha256 !== currentPageImage.sha256) return;
    closeInpaintingEditor();
    setSpeechBubbleReview(pending.result);
    setReviewStage(pending.stage);
    setActiveReviewItem(null);
    setOcrError(null);
    setWorkspacePanels((current) => ({ ...current, inspectorOpen: true, focusMode: false }));
    setStatusMessage("이 페이지의 미적용 OCR 검토 초안을 복원했습니다.");
  }

  function advanceReviewToSpeaker(items: SpeechBubbleReviewItem[]) {
    setActiveReviewItem(items[0] ?? null);
    if (items.length === 0) {
      setStatusMessage("화자를 확인할 OCR 텍스트가 없습니다.");
      return;
    }
    setCurrentReviewStage("speaker");
    setStatusMessage(`OCR 텍스트 ${items.length}개를 확인했습니다. 화자를 검토하세요.`);
  }

  async function extractSpeechBubblesFromCurrentPage() {
    if (blockProjectSessionRecovery()) return;
    if (newProjectSwitchInFlightRef.current) return;
    if (ocrDisabledReason) {
      setStatusMessage(ocrDisabledReason);
      return;
    }
    if (isExtractingSpeechBubbles || activeOcrRequestRef.current) {
      cancelActiveOcr({ notify: true });
      return;
    }
    if (!window.projectApi?.extractSpeechBubbles) {
      setStatusMessage("말풍선 OCR 기능을 사용할 수 없습니다.");
      return;
    }
    if (!currentFilePath) {
      setStatusMessage("말풍선 OCR을 실행하려면 먼저 프로젝트를 저장하세요.");
      return;
    }
    if (!currentPageImage) {
      setStatusMessage("현재 페이지 이미지가 없어 말풍선 OCR을 실행할 수 없습니다.");
      return;
    }
    if (!projectSessionIdRef.current) {
      setStatusMessage("Production OCR을 실행하려면 활성 프로젝트 세션이 필요합니다.");
      return;
    }

    const previousReview = ocrReviewDraftsRef.current.get(currentPageImage.id);
    if (previousReview) {
      const isCurrentScope = captureProjectDialogScope();
      const pageImageId = currentPageImage.id;
      const sourceSha256 = currentPageImage.sha256;
      const approved = await dialogs.confirm({
        title: "OCR을 다시 실행할까요?",
        message: "이 페이지의 미적용 OCR 검토 초안을 버리고 다시 인식합니다.",
        confirmLabel: "초안을 버리고 다시 실행",
        cancelLabel: "계속 검토",
        danger: true
      });
      if (!approved || !isCurrentScope() || currentPageImageRef.current?.id !== pageImageId ||
        currentPageImageRef.current?.sha256 !== sourceSha256 || ocrReviewDraftsRef.current.get(pageImageId) !== previousReview) return;
      discardSpeechBubbleReview(pageImageId);
    }

    const requestFilePath = currentFilePath;
    const requestPageImage = currentPageImage;
    const requestProjectId = project.metadata.id;
    backendCancelFeedbackGenerationRef.current += 1;
    const requestToken = ++ocrRequestTokenRef.current;
    const active: ActiveOcrRequest = {
      requestId: createRendererId("ocr", `${Date.now()}-${requestPageImage.id}`),
      token: requestToken,
      projectSessionId: projectSessionIdRef.current,
      sessionGeneration: sessionGenerationRef.current,
      projectId: requestProjectId,
      filePath: requestFilePath,
      pageImageId: requestPageImage.id,
      storedRelativePath: requestPageImage.storedRelativePath,
      backendStarted: false
    };
    activeOcrRequestRef.current = active;
    setIsExtractingSpeechBubbles(true);

    try {
      resetSpeechBubbleReviewState();
      setStatusMessage("Production OCR로 텍스트를 검출하고 그룹 단위로 인식하는 중입니다.");
      active.backendStarted = true;
      const productionExtraction = await window.projectApi.extractSpeechBubbles({
        requestId: active.requestId,
        projectSessionId: active.projectSessionId!,
        pageImageId: requestPageImage.id,
        sourceSha256: requestPageImage.sha256
      });
      if (!isCurrentOcrRequest(active) || !isCurrentPageImageRequest(
        requestFilePath,
        requestProjectId,
        requestPageImage,
        requestToken,
        currentPageImageRef.current
      )) return;

      const latestImage = currentPageImageRef.current;
      if (!isCurrentPageImageRequest(requestFilePath, requestProjectId, requestPageImage, requestToken, latestImage)) {
        setStatusMessage("말풍선 OCR 중 프로젝트 또는 페이지 이미지가 바뀌어 결과를 적용하지 않았습니다.");
        return;
      }

      setReviewStage("ocr");
      setActiveReviewItem(null);
      setOcrError(null);
      ocrReviewDraftsRef.current.set(requestPageImage.id, {
        result: productionExtraction, sourceSha256: requestPageImage.sha256, stage: "ocr"
      });
      setOcrReviewDraftCount(ocrReviewDraftsRef.current.size);
      setSpeechBubbleReview(productionExtraction);
      setBottomPanel("ocr-candidates");
      setStatusMessage(`Production OCR 후보 ${productionExtraction.speechBubbles.length}개를 검토한 뒤 적용하세요.`);
    } catch (error) {
      if (!isCurrentOcrRequest(active) || isAbortLikeError(error)) return;
      if (
        !isCurrentPageImageRequest(
          requestFilePath,
          requestProjectId,
          requestPageImage,
          requestToken,
          currentPageImageRef.current
        )
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : "말풍선 OCR을 실행하지 못했습니다.";
      setOcrError(message);
      setStatusMessage(message);
    } finally {
      if (activeOcrRequestRef.current === active) {
        activeOcrRequestRef.current = null;
        setIsExtractingSpeechBubbles(false);
      }
    }
  }

  function cancelActiveOcr(options: { notify?: boolean } = {}): boolean {
    const active = activeOcrRequestRef.current;
    if (!active) return false;
    activeOcrRequestRef.current = null;
    ocrRequestTokenRef.current += 1;
    setIsExtractingSpeechBubbles(false);
    if (!active.backendStarted) {
      if (options.notify) {
        setStatusMessage("말풍선 OCR 요청을 취소했습니다.");
      }
      return true;
    }
    requestBackendCancel(
      window.projectApi?.cancelSpeechBubbleOcr
        ? () => window.projectApi.cancelSpeechBubbleOcr!({ requestId: active.requestId })
        : undefined,
      {
        notify: options.notify,
        confirmedMessage: options.notify ? "말풍선 OCR 요청을 취소했습니다." : undefined
      }
    );
    return true;
  }

  async function applySpeechBubbleReview(items: SpeechBubbleReviewItem[]) {
    if (blockProjectSessionRecovery()) return;
    if (sessionConflictRef.current) {
      if (sessionConflictNoticeRef.current) setStatusMessage(sessionConflictNoticeRef.current);
      return;
    }
    if (sessionMutationFailedRef.current && blockUnappliedSessionEdits()) return;
    if (items.length === 0) {
      setStatusMessage("적용할 말풍선 텍스트가 없습니다.");
      return;
    }

    const context = speechBubbleReview?.productionOcrContext;
    const activeSessionId = projectSessionIdRef.current;
    const pageImage = currentPageImage;
    const applyReview = window.projectApi?.applyProductionOcrReview;
    if (!context || !activeSessionId || !pageImage || !applyReview) {
      setStatusMessage("Production OCR 후보의 검증된 실행 문맥이 없어 결과를 적용하지 않았습니다.");
      return;
    }
    if (
      context.pageImageId !== pageImage.id ||
      context.sourceSha256 !== pageImage.sha256 ||
      items.some((item) => !item.productionOcrProvenance || !item.orientation)
    ) {
      setStatusMessage("Production OCR 후보가 현재 원본 이미지 또는 모델 provenance와 일치하지 않습니다.");
      return;
    }

    const applySessionGeneration = sessionGenerationRef.current;
    const applySessionInstance = projectSessionInstanceRef.current;
    const applyProjectId = projectRef.current.metadata.id;
    const submittedReview = ocrReviewDraftsRef.current.get(pageImage.id);
    setStatusMessage("검토한 Production OCR 후보를 사용자 보호 merge로 적용하는 중입니다.");
    try {
      await drainSessionMutationQueue();
      if (projectSessionIdRef.current !== activeSessionId ||
        projectSessionInstanceRef.current !== applySessionInstance || projectRef.current.metadata.id !== applyProjectId) return;
      if (sessionConflictRef.current) {
        if (sessionConflictNoticeRef.current) setStatusMessage(sessionConflictNoticeRef.current);
        return;
      }
      if (
        sessionGenerationRef.current !== applySessionGeneration ||
        projectSessionStatusRef.current !== "active" ||
        currentPageImageRef.current?.id !== pageImage.id ||
        currentPageImageRef.current?.sha256 !== pageImage.sha256
      ) return;
      if (blockUnappliedSessionEdits()) return;
      if (ocrReviewDraftsRef.current.get(pageImage.id) !== submittedReview) {
        setStatusMessage("OCR 검토 초안이 변경되어 이전 적용을 중단했습니다. 변경한 초안을 다시 확인하세요.");
        return;
      }
      const submittedTypesettingDrafts = items.map((item) => JSON.stringify(loadTypesettingDraft(window.localStorage, {
        projectId: applyProjectId, pageImageId: pageImage.id, sourceOcrId: item.id
      })));
      const committed = await applyReview({
        projectSessionId: activeSessionId,
        pageImageId: pageImage.id,
        sourceSha256: pageImage.sha256,
        runId: context.runId,
        candidates: items.map((item) => ({
          id: item.id,
          textType: item.textType,
          text: item.text,
          language: item.language,
          bbox: { ...item.bbox },
          polygon: item.polygon?.map((point) => ({ ...point })) ?? [
            { x: item.bbox.x, y: item.bbox.y },
            { x: item.bbox.x + item.bbox.width, y: item.bbox.y },
            { x: item.bbox.x + item.bbox.width, y: item.bbox.y + item.bbox.height },
            { x: item.bbox.x, y: item.bbox.y + item.bbox.height }
          ],
          readingOrder: item.readingOrder,
          confidence: item.confidence,
          notes: item.notes,
          selectedSpeaker: item.selectedSpeaker,
          orientation: item.orientation!,
          productionOcrProvenance: item.productionOcrProvenance!,
          typesetting: resolveReviewItemTypesetting(item, {
            projectId: applyProjectId,
            pageImageId: pageImage.id
          })
        }))
      });
      if (
        projectSessionIdRef.current !== activeSessionId ||
        projectSessionInstanceRef.current !== applySessionInstance ||
        sessionGenerationRef.current !== applySessionGeneration ||
        projectSessionStatusRef.current !== "active" || sessionConflictRef.current ||
        projectRef.current.metadata.id !== applyProjectId ||
        currentPageImageRef.current?.id !== pageImage.id ||
        currentPageImageRef.current?.sha256 !== pageImage.sha256
      ) return;
      if (committed.projectSessionId !== activeSessionId || committed.project.project.metadata.id !== applyProjectId) {
        setStatusMessage("Production OCR 결과가 현재 세션과 맞지 않아 적용하지 않았습니다. 검토 초안은 유지됩니다.");
        return;
      }
      if (committed.project.status === "active" && hasUnappliedSessionEdits()) {
        lockSessionConflict("OCR 결과와 로컬 편집이 충돌해 안전하게 합칠 수 없습니다. 새 저장·내보내기를 중단했습니다. 진행 중인 저장·내보내기는 완료될 수 있습니다. 미저장 내용과 OCR 초안을 기록한 뒤 다시 여세요. 다시 열면 미저장 내용과 OCR 초안은 사라집니다.");
        return;
      }
      if (committed.project.revision < projectRevisionRef.current) {
        setStatusMessage("Production OCR 결과가 현재 세션과 맞지 않아 적용하지 않았습니다. 검토 초안은 유지됩니다.");
        return;
      }
      if (committed.project.status !== "active") {
        if (committed.project.status === "needs_recovery") adoptProjectSessionDto(committed.project);
        return;
      }
      applySessionChange({
        status: "applied",
        revision: committed.project.revision,
        project: committed.project
      });
      const hasNewerReview = ocrReviewDraftsRef.current.get(pageImage.id) !== submittedReview;
      const hasNewerTypesettingDraft = items.some((item, index) => JSON.stringify(loadTypesettingDraft(window.localStorage, {
        projectId: applyProjectId, pageImageId: pageImage.id, sourceOcrId: item.id
      })) !== submittedTypesettingDrafts[index]);
      if (hasNewerReview || hasNewerTypesettingDraft) {
        setStatusMessage("이전 OCR 검토 내용은 반영됐으며, 이후 수정한 초안은 유지했습니다.");
        return;
      }
      const appliedLine = committed.project.project.dialogueLines.find((line) =>
        line.origin.kind === "pipeline" &&
        line.origin.pageImageId === pageImage.id &&
        line.origin.latestRunId === context.runId);
      setSelectedLineId(appliedLine?.id ?? selectedLineId);
      if (appliedLine) setFocusNewManualTranslation(true);
      for (const item of items) {
        clearTypesettingDraft(window.localStorage, {
          projectId: applyProjectId,
          pageImageId: pageImage.id,
          sourceOcrId: item.id
        });
      }
      discardSpeechBubbleReview(pageImage.id);
      clearSpeechBubbleReview();
      setBottomPanel("dialogue");
      setStatusMessage(`Production OCR 결과 ${items.length}개를 사용자 수정 보호 상태로 적용했습니다.`);
    } catch (error) {
      if (projectSessionIdRef.current !== activeSessionId || projectSessionInstanceRef.current !== applySessionInstance ||
        sessionGenerationRef.current !== applySessionGeneration || projectSessionStatusRef.current !== "active" ||
        sessionConflictRef.current || projectRef.current.metadata.id !== applyProjectId) return;
      setStatusMessage(error instanceof Error ? error.message : "Production OCR 결과를 적용하지 못했습니다.");
    }
  }

  async function chooseImageSourcePaths() {
    if (window.projectApi?.choosePageImageFiles) {
      return (await window.projectApi.choosePageImageFiles()) ?? [];
    }

    const sourcePath = (await dialogs.prompt({ title: "업로드할 이미지 파일 경로", message: "가져올 이미지 파일의 경로를 입력하세요.", fieldLabel: "이미지 파일 경로", confirmLabel: "이미지 선택" }))?.trim();
    return sourcePath ? [sourcePath] : [];
  }

  function installSessionResult(result: ProjectSessionResult, saved: boolean, recentProjectIdOverride?: string) {
    cancelActiveAiTranslation();
    cancelActiveOcr();
    setBatchModalOpen(false);
    setProjectSessionReadiness("ready");
    dispatchProjectSetup({ type: "reset" });
    resetSessionMutationState(result.project.project);
    adoptProjectSessionDto(result.project);
    setProjectSessionId(result.projectSessionId);
    projectSessionIdRef.current = result.projectSessionId;
    projectSessionInstanceRef.current = {};
    setProjectRevision(result.project.revision);
    projectRevisionRef.current = result.project.revision;
    const recentProjectId = result.recentProject?.recentProjectId ?? recentProjectIdOverride ?? null;
    activeRecentProjectIdRef.current = recentProjectId;
    setActiveRecentProjectId(recentProjectId);
    workspaceSessionSaveEnabledRef.current = false;
    setWorkspaceSessionHydratedKey(null);
    setWorkspaceComparison({ mode: "single", revealPosition: 50, opacity: 0.5 });
    setWorkspaceComparisonHydrationRevision((current) => current + 1);
    setPendingPageNumbers(result.project.pendingPageImages.map((page) => page.pageNumber));
    sessionProjectRef.current = result.project.project;
    projectRef.current = result.project.project;
    setProject(result.project.project);
    setCurrentFilePath(saved ? `session:${result.projectSessionId}` : null);
    setIsDirty(result.project.dirty);
    if (result.recentProject) {
      setRecentProjects((current) => [
        result.recentProject!,
        ...current.filter((item) => item.recentProjectId !== result.recentProject!.recentProjectId)
      ].slice(0, 8));
    }
  }

  async function reopenProjectForRecovery() {
    if (projectSessionStatusRef.current !== "needs_recovery") return;
    const recentProjectId = activeRecentProjectIdRef.current;
    await openProjectFromFileDialog(recentProjectId ?? undefined);
  }


  async function openProjectFromFileDialog(filePath?: string, mode: "project" | "example" = "project") {
    if (dialogs.isPending()) return;
    const api = window.projectApi;
    if (!api) return;
    if (mode === "example" && (!api.openExampleProject || !api.closeProject)) {
      setStatusMessage("예시 프로젝트 기능이 준비되지 않았습니다.");
      return;
    }
    const operation = {};
    initialSessionRequestIdRef.current += 1;
    initialSessionPromiseRef.current = null;
    openProjectOperationRef.current = operation;
    invalidateTxtImportOperation();
    invalidatePageImageImportOperation();
    const isCurrentOperation = () => openProjectOperationRef.current === operation;
    const completeCurrentOperation = () => {
      if (isCurrentOperation()) openProjectOperationRef.current = null;
    };
    const rollbackOpenedSession = async (
      result: ProjectSessionResult,
      cause?: unknown
    ): Promise<boolean> => {
      if (!api.closeProject) return false;
      try {
        await api.closeProject({ projectSessionId: result.projectSessionId });
        return true;
      } catch (rollbackError) {
        cleanupPendingSessionIdsRef.current.add(result.projectSessionId);
        projectSwitchCleanupErrorRef.current = new AggregateError(
          cause === undefined ? [rollbackError] : [cause, rollbackError],
          "Opened project session rollback cleanup failed"
        );
        return false;
      }
    };

    const isCurrentDiscardScope = captureProjectDialogScope();
    const approved = await confirmDiscardUnsavedChanges();
    if (!isCurrentOperation() || !isCurrentDiscardScope()) { completeCurrentOperation(); return; }
    if (!approved) {
      if (isCurrentOperation()) {
        setStatusMessage("열기를 취소했습니다.");
        completeCurrentOperation();
      }
      return;
    }

    // A project may open or close asynchronously. Only discard the state that
    // was present when the user approved the switch; keep later edits intact.
    const approvedOcrDrafts = new Map(ocrReviewDraftsRef.current);
    const approvedMaskDrafts = new Map(inpaintingMaskDraftsRef.current);
    const approvedTypesettingDrafts = new Map(manualTypesettingDraftsRef.current);
    const unchangedDrafts = <T,>(current: Map<string, T>, snapshot: Map<string, T>) =>
      current.size === snapshot.size && [...snapshot].every(([key, value]) => current.get(key) === value);
    const hasApprovedSwitchScope = () => isCurrentDiscardScope() &&
      unchangedDrafts(ocrReviewDraftsRef.current, approvedOcrDrafts) &&
      unchangedDrafts(inpaintingMaskDraftsRef.current, approvedMaskDrafts) &&
      unchangedDrafts(manualTypesettingDraftsRef.current, approvedTypesettingDrafts);

    setUnavailableRecentPath(null);
    if (api.openProjectFromDialog && api.openRecentProject && api.unlockProject) {
      let openedSession: ProjectSessionResult | null = null;
      let installed = false;
      try {
        for (const cleanupSessionId of [...cleanupPendingSessionIdsRef.current]) {
          if (!api.closeProject) break;
          await api.closeProject({ projectSessionId: cleanupSessionId });
          cleanupPendingSessionIdsRef.current.delete(cleanupSessionId);
        }
        if (cleanupPendingSessionIdsRef.current.size === 0) {
          projectSwitchCleanupErrorRef.current = null;
        }
        let result = mode === "example"
          ? await api.openExampleProject!()
          : filePath
            ? await api.openRecentProject({ recentProjectId: filePath })
            : await api.openProjectFromDialog();
        if (!isCurrentOperation()) {
          if (isProjectSessionResult(result) && api.closeProject) {
            await rollbackOpenedSession(result);
          }
          return;
        }
        if (!result) {
          setStatusMessage(filePath ? "최근 프로젝트를 열 수 없습니다. 파일이 이동되었거나 삭제되었을 수 있습니다." : "열기를 취소했습니다.");
          if (filePath) setUnavailableRecentPath(filePath);
          completeCurrentOperation();
          return;
        }
        if (isProjectOpenFailureResult(result)) {
          if (
            filePath &&
            (result.code === "RECENT_NOT_FOUND" || result.code === "PROJECT_FILE_NOT_FOUND")
          ) {
            setUnavailableRecentPath(filePath);
          }
          setStatusMessage(result.message);
          completeCurrentOperation();
          return;
        }
        if (isPasswordRequiredResult(result)) {
          const isCurrentPromptScope = captureProjectDialogScope();
          const password = (await dialogs.prompt({ title: "시크릿 프로젝트 암호", message: "이 프로젝트를 열려면 암호가 필요합니다.", password: true, fieldLabel: "프로젝트 암호", confirmLabel: "프로젝트 열기" }))?.trim();
          if (!isCurrentOperation() || !isCurrentPromptScope()) { completeCurrentOperation(); return; }
          if (!password || !result.unlockToken) {
            setStatusMessage("시크릿 프로젝트 암호가 필요합니다.");
            completeCurrentOperation();
            return;
          }
          result = await api.unlockProject({ unlockToken: result.unlockToken, password });
          if (!isCurrentOperation()) {
            if (isProjectSessionResult(result) && api.closeProject) {
              await rollbackOpenedSession(result);
            }
            return;
          }
          if (isProjectOpenFailureResult(result)) {
            setStatusMessage(result.message);
            completeCurrentOperation();
            return;
          }
        }
        if (isPasswordRequiredResult(result)) throw new Error("시크릿 프로젝트 잠금을 해제하지 못했습니다.");
        openedSession = result as ProjectSessionResult;
        if (!hasApprovedSwitchScope()) {
          const rolledBack = await rollbackOpenedSession(openedSession);
          setStatusMessage(rolledBack
            ? "프로젝트를 여는 동안 현재 작업이 바뀌어 전환을 취소했습니다. 변경사항을 확인한 뒤 다시 시도하세요."
            : "현재 작업은 유지했지만 새 세션을 정리하지 못했습니다. 다음 전환에서 정리를 다시 시도합니다.");
          completeCurrentOperation();
          return;
        }
        if (
          projectSessionIdRef.current &&
          projectSessionIdRef.current !== openedSession.projectSessionId &&
          api.closeProject
        ) {
          const previousSessionId = projectSessionIdRef.current;
          try {
            await api.closeProject({ projectSessionId: previousSessionId });
          } catch (closeError) {
            try {
              await api.closeProject({ projectSessionId: openedSession.projectSessionId });
            } catch (rollbackError) {
              cleanupPendingSessionIdsRef.current.add(openedSession.projectSessionId);
              projectSwitchCleanupErrorRef.current = new AggregateError(
                [closeError, rollbackError],
                "Project switch and rollback cleanup failed"
              );
              setStatusMessage(
                "기존 프로젝트를 닫지 못했고 새 세션 정리도 완료하지 못했습니다. 다시 열면 정리를 먼저 재시도합니다."
              );
              completeCurrentOperation();
              return;
            }
            setStatusMessage("기존 프로젝트를 닫지 못해 전환을 취소했습니다. 다시 시도하세요.");
            completeCurrentOperation();
            return;
          }
          if (!isCurrentOperation() || !hasApprovedSwitchScope()) {
            // The old session has already closed. Keep later drafts on screen
            // and require recovery instead of installing another project.
            if (projectSessionIdRef.current === previousSessionId) {
              markProjectSessionStatus("needs_recovery");
              setStatusMessage(projectSessionRecoveryMessage);
            }
            const rolledBack = await rollbackOpenedSession(openedSession);
            if (!rolledBack && isCurrentOperation()) {
              setStatusMessage("현재 초안은 유지했지만 새 세션을 정리하지 못했습니다. 프로젝트 복구와 세션 정리가 필요합니다.");
            }
            completeCurrentOperation();
            return;
          }
        }
        installSessionResult(openedSession, true, filePath);
        installOpenedSessionProject(openedSession);
        installed = true;
        completeCurrentOperation();
        return;
      } catch (error) {
        if (!isCurrentOperation()) return;
        let rollbackCompleted = true;
        if (openedSession && !installed) {
          rollbackCompleted = api.closeProject
            ? await rollbackOpenedSession(openedSession, error)
            : false;
        }
        if (!rollbackCompleted || cleanupPendingSessionIdsRef.current.size > 0) {
          setStatusMessage(
            "열기 중 생성된 프로젝트 세션을 정리하지 못했습니다. 다시 열면 정리를 먼저 재시도합니다."
          );
          completeCurrentOperation();
          return;
        }
        setStatusMessage(
          projectOpenErrorMessage(error)
        );
        completeCurrentOperation();
        return;
      }
    }
    try {
      let result = filePath
        ? await api.openProject!({ filePath })
        : await api.openProject!();
      if (!isCurrentOperation()) return;
      if (!result) {
        if (filePath) {
          if (!isCurrentOperation()) return;
          setUnavailableRecentPath(filePath);
          setStatusMessage("최근 프로젝트를 열 수 없습니다. 파일이 이동되었거나 삭제되었을 수 있습니다.");
        } else {
          if (!isCurrentOperation()) return;
          setStatusMessage("열기를 취소했습니다.");
        }
        completeCurrentOperation();
        return;
      }

      if (isPasswordRequiredResult(result)) {
        if (!isCurrentOperation()) return;
        const isCurrentPromptScope = captureProjectDialogScope();
        const password = (await dialogs.prompt({ title: "시크릿 프로젝트 암호", message: "이 프로젝트를 열려면 암호가 필요합니다.", password: true, fieldLabel: "프로젝트 암호", confirmLabel: "프로젝트 열기" }))?.trim();
        if (!isCurrentOperation() || !isCurrentPromptScope()) { completeCurrentOperation(); return; }
        if (!password) {
          if (!isCurrentOperation()) return;
          setStatusMessage("시크릿 프로젝트 암호가 필요합니다.");
          completeCurrentOperation();
          return;
        }

        result = await api.openProject!({ filePath: result.filePath, password });
        if (!isCurrentOperation()) return;
        if (!result || isPasswordRequiredResult(result)) {
          if (!isCurrentOperation()) return;
          setStatusMessage("열기를 취소했습니다.");
          completeCurrentOperation();
          return;
        }
      }

      if (!isCurrentOperation()) return;
      if (!hasApprovedSwitchScope()) {
        setStatusMessage("프로젝트를 여는 동안 현재 작업이 바뀌어 전환을 취소했습니다. 변경사항을 확인한 뒤 다시 시도하세요.");
        completeCurrentOperation();
        return;
      }
      const openedProject = result as ProjectFileResult;
      installOpenedProject(openedProject);
      if (!isCurrentOperation()) return;
      rememberRecentProject(openedProject.filePath, openedProject.project.metadata.title);
      completeCurrentOperation();
    } catch (error) {
      if (!isCurrentOperation()) return;
      if (filePath) {
        if (!isCurrentOperation()) return;
        setUnavailableRecentPath(filePath);
        setStatusMessage("최근 프로젝트를 열 수 없습니다. 파일이 이동되었거나 삭제되었을 수 있습니다.");
      } else {
        if (!isCurrentOperation()) return;
        setStatusMessage(projectOpenErrorMessage(error));
      }
      completeCurrentOperation();
    }
  }

  function installOpenedSessionProject(result: ProjectSessionResult) {
    const openedProject = result.project.project;
    const hasContent = openedProject.dialogueLines.length > 0 || openedProject.pageImages.length > 0;
    resetImagePanelContext();
    setWorkspacePanels((current) => ({ ...current, pagesOpen: false, inspectorOpen: false, resultsOpen: false, focusMode: false }));
    setPendingPageNumbers(result.project.pendingPageImages.map((page) => page.pageNumber));
    clearAllSpeechBubbleReviews();
    setPageAndSelection(openedProject.dialogueLines[0]?.pageNumber ?? 1, {
      lines: openedProject.dialogueLines,
      pageImages: openedProject.pageImages
    });
    setImageImportFailureCount(0);
    dispatchEntryFlow({ type: "project-installed", hasContent });
    if (result.project.status === "needs_recovery") {
      adoptProjectSessionDto(result.project);
      return;
    }
    setStatusMessage(
      hasContent
        ? result.encrypted
          ? "암호화된 프로젝트를 열었습니다."
          : "프로젝트를 열었습니다."
        : "프로젝트에 번역할 내용이 없어 홈으로 돌아왔습니다."
    );
  }

  function installOpenedProject(result: ProjectFileResult) {
    invalidateTxtImportOperation();
    cancelActiveOcr();
    const hasContent = result.project.dialogueLines.length > 0 || (result.project.pageImages?.length ?? 0) > 0;
    resetImagePanelContext();
    setProject(normalizeProject(result.project));
    setWorkspacePanels((current) => ({ ...current, pagesOpen: false, inspectorOpen: false, resultsOpen: false, focusMode: false }));
    clearAllSpeechBubbleReviews();
    setPageAndSelection(result.project.dialogueLines[0]?.pageNumber ?? 1, {
      lines: result.project.dialogueLines,
      pageImages: result.project.pageImages
    });
    setCurrentFilePath(result.filePath);
    setIsDirty(false);
    setImageImportFailureCount(0);
    dispatchEntryFlow({ type: "project-installed", hasContent });
    setStatusMessage(
      hasContent
        ? result.encrypted
          ? "암호화된 프로젝트를 열었습니다."
          : "프로젝트를 열었습니다."
        : "프로젝트에 번역할 내용이 없어 홈으로 돌아왔습니다."
    );
  }

  async function removeUnavailableRecentProject(recentProjectId: string) {
    if (window.projectApi?.removeRecentProject) {
      setRecentProjects(await window.projectApi.removeRecentProject({ recentProjectId }));
    } else {
      setRecentProjects(removeRecentProject(window.localStorage, recentProjectId));
    }
    setUnavailableRecentPath(null);
    setStatusMessage("최근 프로젝트 목록에서 제거했습니다.");
  }



  async function exportProjectImagePackage() {
    if (imageExportInFlightRef.current) return;
    const startedSessionId = projectSessionIdRef.current;
    const startedGeneration = sessionGenerationRef.current;
    const isCurrentSession = () =>
      projectSessionIdRef.current === startedSessionId &&
      sessionGenerationRef.current === startedGeneration;

    if (!startedSessionId || !window.projectApi?.exportProjectImages) {
      setStatusMessage("프로젝트 이미지 내보내기는 먼저 저장된 프로젝트에서 사용할 수 있습니다.");
      return;
    }

    imageExportInFlightRef.current = true;
    setImageExportInFlight(true);
    try {
      if (!(await prepareSyncedSessionForExport()) || !isCurrentSession()) return;

      const currentProject = projectRef.current;
      const currentRevision = projectRevisionRef.current;
      const pageImages = [...(currentProject.pageImages ?? [])].sort(
        (left, right) => left.pageNumber - right.pageNumber || left.id.localeCompare(right.id)
      );
      if (pageImages.length === 0) {
        setStatusMessage("내보낼 페이지 이미지가 없습니다.");
        return;
      }

      const productionFontLoaded = await ensureProductionTypesetFontLoaded();
      if (!isCurrentSession()) return;
      const typesetPages: Array<{
        pageImageId: string;
        pngBase64: string;
        readiness: ReturnType<typeof buildRenderReadinessReport>;
      }> = [];

      for (const pageImage of pageImages) {
        if (!isCurrentSession()) return;
        const lines = currentProject.dialogueLines.filter((line) => line.pageNumber === pageImage.pageNumber);
        const cleanedAssetInspection = inspectApprovedCleanedAsset(currentProject, pageImage);
        const evidence = collectRenderReadinessEvidence(lines, { productionFontLoaded });
        const reportApprovedCleanedAssetId = cleanedAssetInspection.status === "invalid_reference" || cleanedAssetInspection.status === "missing"
          ? undefined
          : cleanedAssetInspection.approvedCleanedAssetId;
        const readiness = buildRenderReadinessReport({
          pageImageId: pageImage.id,
          revision: currentRevision,
          resultRevision: currentRevision,
          lines,
          approvedCleanedAssetId: reportApprovedCleanedAssetId,
          cleanedAssetQaStatus: cleanedAssetInspection.qaStatus,
          cleanedAssetRequired: cleanedAssetInspection.required,
          safeAreaProvisionalLineIds: evidence.safeAreaProvisionalLineIds,
          missingGlyphLineIds: evidence.missingGlyphLineIds,
          overflowLineIds: evidence.overflowLineIds,
          font: evidence.font
        });
        if (!readiness.ready) continue;

        try {
          const useApprovedCleanedAsset = cleanedAssetInspection.status === "valid" && Boolean(cleanedAssetInspection.asset);
          const storedRelativePath = useApprovedCleanedAsset
            ? cleanedAssetInspection.asset!.storedRelativePath
            : pageImage.storedRelativePath;
          const imageSrc = window.projectApi.resolvePageImageSrc
            ? await window.projectApi.resolvePageImageSrc({
                projectSessionId: startedSessionId,
                storedRelativePath
              })
            : storedRelativePath;
          if (!isCurrentSession()) return;
          const blob = await burnTypesettingFromUrl(imageSrc, lines, "image/png", 0.95, 15000, {
            textResolver: (line) => line.userTranslation?.trim() ?? ""
          });
          if (!isCurrentSession()) return;
          typesetPages.push({
            pageImageId: pageImage.id,
            pngBase64: await blobToBase64(blob),
            readiness
          });
        } catch {
          // Omit this page from typesetPages so Main records TYPESET_RENDER_NOT_PROVIDED
          // without aborting later renderer burns or original/cleaned export.
        }
      }

      if (!isCurrentSession()) return;
      const result = await window.projectApi.exportProjectImages({
        projectSessionId: startedSessionId,
        defaultPath: undefined,
        includeZip: true,
        typesetPages
      });
      if (!isCurrentSession()) return;
      if (!result) {
        setStatusMessage("내보내기를 취소했습니다.");
      } else {
        const reportPath = `${result.exportRoot}/report.json`;
        const failureCount = result.report.failures.length;
        if (result.report.status === "completed") {
          setStatusMessage(`전체 ${pageImages.length}페이지의 original/cleaned/typeset 결과를 내보냈습니다. 보고서: ${reportPath}`);
        } else if (result.report.status === "partial") {
          setStatusMessage(`이미지 내보내기 일부 완료: ${failureCount}건 실패. 보고서: ${reportPath}`);
        } else {
          setStatusMessage(`이미지 내보내기 실패: ${failureCount}건. 보고서: ${reportPath}`);
        }
      }
    } catch (err) {
      if (!isCurrentSession()) return;
      setStatusMessage(`이미지 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      imageExportInFlightRef.current = false;
      setImageExportInFlight(false);
    }
  }

  function cancelSpeechBubbleReview() {
    setWorkspacePanels((current) => ({ ...current, inspectorOpen: false }));
    setStatusMessage("OCR 검토를 닫았습니다. 미적용 초안은 현재 프로젝트에서 유지됩니다.");
    requestAnimationFrame(() => imagePrimaryActionRef.current?.focus());
  }

  if (entryFlow.screen === "home") {
    return (
      <ProjectHomeScreen
        onResumeWorkspace={project.dialogueLines.length > 0 || (project.pageImages?.length ?? 0) > 0 ? () => dispatchEntryFlow({ type: "navigate", screen: "workspace" }) : undefined}
        recentProjects={recentProjects}
        apiReady={apiReady}
        projectSessionReady={projectSessionReady}
        sessionRetryAvailable={
          projectSessionReadiness === "error" ||
          projectSessionReadiness === "password-required"
        }
        onRetryProjectSession={retryProjectSessionBootstrap}
        isImportingTxt={isImportingTxt}
        statusMessage={statusMessage === "준비됨." ? undefined : statusMessage}
        unavailableRecentPath={unavailableRecentPath}
        onNewProject={beginNewImageProject}
        onOpenProject={() => void openProjectFromFileDialog()}
        onOpenExample={window.projectApi?.openExampleProject ? () => void openProjectFromFileDialog(undefined, "example") : undefined}
        onOpenRecent={(filePath) => void openProjectFromFileDialog(filePath)}
        onRemoveRecent={removeUnavailableRecentProject}
        onImportTxt={() => void importTxt()}
        onOpenSettings={() => dispatchEntryFlow({ type: "navigate", screen: "settings" })}
        onOpenPreparation={() => openEnvironmentPreparation("home")}
        onNavigate={(nav) => dispatchEntryFlow({ type: "navigate", screen: nav })}
      />
    );
  }

  if (entryFlow.screen === "projects") {
    return (
      <ProjectsPage
        onResumeWorkspace={project.dialogueLines.length > 0 || (project.pageImages?.length ?? 0) > 0 ? () => dispatchEntryFlow({ type: "navigate", screen: "workspace" }) : undefined}
        recentProjects={recentProjects}
        apiReady={apiReady}
        onNewProject={beginNewImageProject}
        onOpenProject={() => void openProjectFromFileDialog()}
        onOpenRecent={(filePath) => void openProjectFromFileDialog(filePath)}
        onRemoveRecent={removeUnavailableRecentProject}
        onOpenSettings={() => dispatchEntryFlow({ type: "navigate", screen: "settings" })}
        onOpenPreparation={() => openEnvironmentPreparation("projects")}
        onNavigate={(nav) => dispatchEntryFlow({ type: "navigate", screen: nav })}
      />
    );
  }

  if (entryFlow.screen === "files") {
    return (
      <FileBrowserPage
        onResumeWorkspace={project.dialogueLines.length > 0 || (project.pageImages?.length ?? 0) > 0 ? () => dispatchEntryFlow({ type: "navigate", screen: "workspace" }) : undefined}
        recentProjects={recentProjects}
        apiReady={apiReady}
        onNewProject={beginNewImageProject}
        onOpenProject={() => void openProjectFromFileDialog()}
        onOpenRecent={(filePath) => void openProjectFromFileDialog(filePath)}
        onRemoveRecent={removeUnavailableRecentProject}
        onOpenSettings={() => dispatchEntryFlow({ type: "navigate", screen: "settings" })}
        onOpenPreparation={() => openEnvironmentPreparation("files")}
        onNavigate={(nav) => dispatchEntryFlow({ type: "navigate", screen: nav })}
      />
    );
  }

  if (entryFlow.screen === "ai") {
    return (
      <AiDashboardPage
        onResumeWorkspace={project.dialogueLines.length > 0 || (project.pageImages?.length ?? 0) > 0 ? () => dispatchEntryFlow({ type: "navigate", screen: "workspace" }) : undefined}
        recentProjects={recentProjects}
        apiReady={apiReady}
        recentProjectsError={recentProjectsError}
        onRetryRecentProjects={() => setRecentProjectsReloadAttempt((attempt) => attempt + 1)}
        onNewProject={beginNewImageProject}
        onOpenProject={() => void openProjectFromFileDialog()}
        onOpenRecent={(filePath) => void openProjectFromFileDialog(filePath)}
        onRemoveRecent={removeUnavailableRecentProject}
        onOpenSettings={() => dispatchEntryFlow({ type: "navigate", screen: "settings" })}
        onOpenPreparation={() => openEnvironmentPreparation("ai")}
        onNavigate={(nav) => dispatchEntryFlow({ type: "navigate", screen: nav })}
      />
    );
  }

  if (entryFlow.screen === "tools") {
    return (
      <ToolsPage
        onResumeWorkspace={project.dialogueLines.length > 0 || (project.pageImages?.length ?? 0) > 0 ? () => dispatchEntryFlow({ type: "navigate", screen: "workspace" }) : undefined}
        recentProjects={recentProjects}
        apiReady={apiReady}
        onNewProject={beginNewImageProject}
        onOpenProject={() => void openProjectFromFileDialog()}
        onOpenRecent={(filePath) => void openProjectFromFileDialog(filePath)}
        onRemoveRecent={removeUnavailableRecentProject}
        onOpenSettings={() => dispatchEntryFlow({ type: "navigate", screen: "settings" })}
        onOpenPreparation={() => openEnvironmentPreparation("tools")}
        onNavigate={(nav) => dispatchEntryFlow({ type: "navigate", screen: nav })}
      />
    );
  }

  if (entryFlow.screen === "dictionary") {
    return (
      <DictionaryPage
        onResumeWorkspace={project.dialogueLines.length > 0 || (project.pageImages?.length ?? 0) > 0 ? () => dispatchEntryFlow({ type: "navigate", screen: "workspace" }) : undefined}
        recentProjects={recentProjects}
        apiReady={apiReady}
        currentProject={project}
        projectSessionId={projectSessionId}
        projectEditingDisabled={sessionNeedsRecovery}
        projectEditingDisabledReason={sessionNeedsRecovery ? projectSessionRecoveryMessage : undefined}
        onChangeProject={replaceProject}
        onNewProject={beginNewImageProject}
        onOpenProject={() => void openProjectFromFileDialog()}
        onOpenRecent={(filePath) => void openProjectFromFileDialog(filePath)}
        onRemoveRecent={removeUnavailableRecentProject}
        onOpenSettings={() => dispatchEntryFlow({ type: "navigate", screen: "settings" })}
        onOpenPreparation={() => openEnvironmentPreparation("dictionary")}
        onNavigate={(nav) => dispatchEntryFlow({ type: "navigate", screen: nav })}
      />
    );
  }

  if (entryFlow.screen === "settings") {
    return (
      <SettingsPage
        onResumeWorkspace={project.dialogueLines.length > 0 || (project.pageImages?.length ?? 0) > 0 ? () => dispatchEntryFlow({ type: "navigate", screen: "workspace" }) : undefined}
        recentProjects={recentProjects}
        apiReady={apiReady}
        uiTheme={uiTheme}
        uiThemeResolved={uiThemeChoice !== null}
        onUiThemeChange={setUiTheme}
        onNewProject={beginNewImageProject}
        onOpenProject={() => void openProjectFromFileDialog()}
        onOpenRecent={(filePath) => void openProjectFromFileDialog(filePath)}
        onRemoveRecent={removeUnavailableRecentProject}
        onOpenSettings={() => dispatchEntryFlow({ type: "navigate", screen: "settings" })}
        onOpenPreparation={() => openEnvironmentPreparation("settings")}
        onNavigate={(nav) => dispatchEntryFlow({ type: "navigate", screen: nav })}
      />
    );
  }

  if (entryFlow.screen === "setup") {
    return (
      <ProjectSetupScreen
        state={projectSetup}
        statusMessage={statusMessage}
        projectName={project.metadata.title}
        storageLocation={projectSetupStoragePath}
        onProjectNameChange={updateProjectSetupTitle}
        onChooseStorageLocation={() => void chooseProjectSetupStorageLocation()}
        onChooseImages={() => void chooseProjectSetupImages()}
        onDropFiles={(files) => void prepareDroppedProjectImages(files)}
        onAutoSort={() => dispatchProjectSetup({ type: "auto-sorted" })}
        onMove={(id, destinationIndex) => dispatchProjectSetup({ type: "file-moved", id, destinationIndex })}
        onRemove={removeProjectSetupImage}
        onDismissDuplicates={() => dispatchProjectSetup({ type: "duplicates-dismissed" })}
        onCancel={cancelProjectSetup}
        onConfirm={() => void confirmProjectSetup()}
      />
    );
  }

  function resetImagePanelContext() {
    pendingIssueNavigationRef.current = null;
    setCurrentIssue(null);
    setIssueFocusRequest(null);
    setIssueEditor(null);
    setImageResetRevision((current) => current + 1);
    setPageResultContexts({});
    setPendingInpaintingContext(null);
    setPendingPageNumbers([]);
    setProgrammaticResultLayer("original");
    setEditingTool("translation");
    setInpaintingEditorOpen(false);
  }

  if (entryFlow.screen === "preparation") {
    return (
      <EnvironmentPreparationScreen
        snapshot={environmentSnapshot}
        returnTarget={entryFlow.preparationReturnScreen ?? "home"}
        isLoading={environmentLoading}
        errorMessage={environmentError}
        onRefresh={() => void refreshEnvironmentPreparation()}
        onChooseResourceRoot={() => void chooseEnvironmentResourceRoot()}
        onInstallProductionOcr={() => void installProductionOcr()}
        onBack={closeEnvironmentPreparation}
      />
    );
  }

  return (
    <>
    <FocusDeckShell
      panelActionsRef={workspacePanelActionsRef}
      readingMode={finalReading}
      statusBar={
        <div className="mangohana-workbench-bottom">
          {workspacePresentation.showPageControls ? <div className="top-page-actions" aria-label="페이지 이동">
            <button type="button" onClick={goToPreviousPage} disabled={currentPage <= 1}>이전 페이지</button>
            <strong aria-label="현재 페이지">{currentPage} / {pageCount}</strong>
            <button type="button" onClick={goToNextPage} disabled={currentPage >= pageCount}>다음 페이지</button>
          </div> : null}
          {selectedLineForEditor && !finalReading && !speechBubbleReview ? (
            <div className="mangohana-selected-line" aria-label="선택한 대사 작업">
              <details>
                <summary>대사 {selectedLineForEditor.order} 확인</summary>
                <div className="mangohana-selected-line-detail">
                  <strong>원문</strong><p>{selectedLineForEditor.sourceText}</p>
                  <strong>{selectedLineForEditor.userTranslation ? "사용자 번역" : "AI 제안"}</strong>
                  <p>{selectedLineForEditor.userTranslation || selectedLineForEditor.aiTranslation || "번역 없음"}</p>
                </div>
              </details>
              <button type="button" onClick={() => workspacePanelActionsRef.current?.openInspector()}>대사 수정</button>
              <button type="button" onClick={confirmSelectedTranslation}
                aria-label={!selectedLineForEditor.userTranslation && selectedLineForEditor.aiTranslation?.trim() ? "선택 대사 제안 채택 및 검수 확정" : "선택 대사 검수 확정"}
                disabled={sessionNeedsRecovery || selectedLineForEditor.lineStatus === "complete" || !canConfirmTranslation(selectedLineForEditor)}
                title={!canConfirmTranslation(selectedLineForEditor) ? "확정할 번역문을 먼저 입력하거나 제안을 만드세요." : undefined}>
                {!selectedLineForEditor.userTranslation && selectedLineForEditor.aiTranslation?.trim() ? "제안 채택 및 검수 확정" : "검수 확정"}
              </button>
            </div>
          ) : null}
          <div className="workbench-status" role="status" aria-label="작업대 현황">
            <span>프로젝트 확인 필요 {issueLineItems.length}개</span>
            <span>{finalReading ? "최종 읽기 진행 중" : "대사 검수·편집"}</span>
            {ocrReviewDraftCount + inpaintingMaskDraftCount + manualTypesettingDraftCount > 0 ? (
              <span>미적용 초안 {ocrReviewDraftCount + inpaintingMaskDraftCount + manualTypesettingDraftCount}개</span>
            ) : null}
            <span className="mangohana-latest-status" aria-hidden="true" title={statusMessage}>{statusMessage}</span>
            <span>{workspacePresentation.saveLabel} · 수동 저장</span>
          </div>
        </div>
      }
      currentStage={guidedStage}
      canvasPriority={workspaceMode === "viewer" || workspaceMode === "inpainting"}
      showWorkflow={false}
      showWorkspaceChrome={workspacePresentation.showWorkspaceChrome}
      panelState={workspacePanels}
      onPanelStateChange={setWorkspacePanels}
      pagesBadge={imageImportFailureCount > 0 ? `페이지 ${pageCount} · 실패 ${imageImportFailureCount}` : pageCount}
      inspectorBadge={ocrError ? 1 : pageSummary.reviewCount}
      resultsBadge={issueLineItems.length || pageSummary.dialogueCount}
      navigation={({ pagesVisible, inspectorVisible, resultsVisible, openPages, togglePages, toggleInspector, toggleResults }) => (
        <nav className="mangohana-workspace-navigation" aria-label="작업 영역">
          {([
            { key: "pages", label: "페이지", active: pagesVisible && activeNavigator === "pages", action: () => {
              if (pagesVisible && activeNavigator === "pages") togglePages();
              else { setActiveNavigator("pages"); openPages(); }
            } },
            { key: "progress", label: "진행", active: resultsVisible, action: toggleResults, disabled: finalReading },
            { key: "edit", label: "수정", active: inspectorVisible, action: toggleInspector, disabled: finalReading },
            { key: "context", label: "문맥", active: pagesVisible && activeNavigator === "context", action: () => {
              if (pagesVisible && activeNavigator === "context") togglePages();
              else { setActiveNavigator("context"); openPages(); }
            } },
            { key: "settings", label: "설정", active: settingsOpen, action: () => setSettingsOpen((open) => !open) }
          ] as const).map(({ key, label, active, action, ...rest }) => (
            <button key={key} type="button" aria-expanded={active} onClick={action}
              disabled={"disabled" in rest && rest.disabled}
              title={"disabled" in rest && rest.disabled ? "최종 읽기를 종료한 뒤 사용할 수 있습니다." : label}>
              <WorkspaceNavigationIcon kind={key} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
      topBar={({ resultsVisible, toggleResults }) => (
      <div className="app-top-bar inkline-command-bar" role="banner" aria-label="앱 상단 바">
        <p className="sr-only" role="status" aria-label="작업 상태" aria-atomic="true">
          {statusMessage}
        </p>
        {currentIssue ? (
          <span
            className="sr-only"
            data-testid="current-issue"
            data-issue-id={currentIssue.lineId}
            data-issue-kind={currentIssue.kind}
            aria-label={`현재 문제 라인 ${currentIssue.line.order}`}
          >
            {currentIssue.line.sourceText}
          </span>
        ) : null}
        <div className="app-top-brand">
          <img className="mangohana-workspace-mark" src={mangohanaMark} alt="" aria-hidden="true" />
          <h1>망고하나</h1>
          <span className="sr-only" aria-hidden="true">대사 편집기</span>
          <span className="workspace-product-type" title={project.metadata.title}>{project.metadata.title}</span>
          <span className={isDirty ? "top-save-state dirty" : "top-save-state"} data-status-tone={workspacePresentation.saveLabel === "저장됨" ? "success" : workspacePresentation.saveLabel === "새 프로젝트" ? "neutral" : "warning"}>{workspacePresentation.saveLabel}</span>
          {ocrReviewDraftCount + inpaintingMaskDraftCount + manualTypesettingDraftCount > 0 ? (
            <span className="top-save-state dirty" title="OCR, 배경 마스크 또는 글자 배치 초안은 적용하기 전까지 프로젝트 저장에 포함되지 않습니다.">
              미적용 초안 {ocrReviewDraftCount + inpaintingMaskDraftCount + manualTypesettingDraftCount}개
            </span>
          ) : null}
        </div>
        <p className="top-file-path">{currentFilePath ?? "선택된 프로젝트 파일이 없습니다."}</p>
        {sessionNeedsRecovery ? (
          <div className="processing-queue-notice" role="alert">
            <p>{projectSessionRecoveryMessage}</p>
            <button type="button" onClick={() => void reopenProjectForRecovery()}>
              세션 복구하기
            </button>
          </div>
        ) : null}
        <div className="top-file-actions" role="group" aria-label="파일 작업">
          <button type="button" aria-label={finalReading ? "대사 편집으로 돌아가기" : "전체 페이지 최종 읽기"}
            aria-pressed={finalReading}
            disabled={workspacePresentation.isEmptyWorkspace || isExtractingSpeechBubbles || isInpainting || inpaintingEditorOpen || Boolean(speechBubbleReview)}
            onClick={() => {
              if (!finalReading) {
                readingSelectionsRef.current.clear();
                readingSelectionsRef.current.set(currentPage, selectedLineId);
              }
              setFinalReading((current) => !current);
            }}>
            {finalReading ? "편집으로 돌아가기" : "최종 읽기"}
          </button>
          {!finalReading ? <button type="button" aria-label="확인 필요 대사 목록 열기"
            aria-expanded={resultsVisible && bottomPanel === "issues"}
            onClick={() => {
              if (bottomPanel === "issues" || !resultsVisible) toggleResults();
              setBottomPanel("issues");
            }}>확인 필요 {issueLineItems.length}</button> : null}
          {!workspacePresentation.showStartPanel ? <button type="button" aria-label="새로 만들기" onClick={beginNewImageProject}>
            새 프로젝트
          </button> : null}
          {!workspacePresentation.showStartPanel ? <button type="button" onClick={() => void openProjectFromFileDialog()} disabled={!apiReady}>
            열기
          </button> : null}
          {!workspacePresentation.showStartPanel && workspacePresentation.showSave ? <button type="button" onClick={saveProject} disabled={sessionNeedsRecovery}>
            저장
          </button> : null}
          {!workspacePresentation.showStartPanel && workspacePresentation.showSaveAs ? <button type="button" aria-label="다른 이름 저장" onClick={saveProjectAs} disabled={sessionNeedsRecovery}>
            다른 이름
          </button> : null}
          {!workspacePresentation.showStartPanel && workspacePresentation.showExport ? (
            <>
              <button type="button" aria-label="TXT 내보내기" onClick={exportTranslations} disabled={sessionNeedsRecovery}>
                내보내기
              </button>
              <button
                type="button"
                aria-label="전체 프로젝트 이미지 내보내기"
                title="전체 페이지의 original·cleaned·typeset 결과를 폴더와 ZIP으로 내보냅니다"
                onClick={() => void exportProjectImagePackage()}
                disabled={sessionNeedsRecovery || imageExportInFlight}
                aria-busy={imageExportInFlight}
              >
                이미지 내보내기
              </button>
              <button
                type="button"
                aria-label="일괄 자동화"
                title="전체 페이지 번역·식자 일괄 실행"
                onClick={() => setBatchModalOpen(true)}
                disabled={sessionNeedsRecovery}
              >
                ⚡ 일괄 자동화
              </button>
            </>
          ) : null}
          <details className="top-utility-menu">
            <summary aria-label="작업 도구와 상태 열기" title="작업 도구와 상태">도구</summary>
            <div className="top-utility-menu-content">
              <button type="button" onClick={() => dispatchEntryFlow({ type: "navigate", screen: "home" })}>작업실 홈</button>
              <RuntimeStatusControl
                snapshot={environmentSnapshot}
                isLoading={environmentLoading}
                onOpenPreparation={() => openEnvironmentPreparation("workspace")}
              />
              <AutoUpdateStatusControl
                state={autoUpdateState}
                hasUnsavedChanges={isDirty || ocrReviewDraftCount > 0 || inpaintingMaskDraftCount > 0 || manualTypesettingDraftCount > 0}
                onCheck={() => void checkForAutoUpdate()}
                onDownload={() => void downloadAutoUpdate()}
                onInstall={() => void installAutoUpdate()}
                onOpenRelease={() => void openAutoUpdateRelease()}
              />
              <button
                type="button"
                className="theme-toggle"
                aria-label={uiTheme === "light" ? "다크 테마로 전환" : "라이트 테마로 전환"}
                title={uiTheme === "light" ? "다크 테마로 전환" : "라이트 테마로 전환"}
                onClick={() => setUiTheme((theme) => theme === "light" ? "dark" : "light")}
              >
                {uiTheme === "light" ? "다크 테마" : "라이트 테마"}
              </button>
            </div>
          </details>
        </div>
        {settingsOpen ? (
          <section
            ref={settingsPanelRef}
            id="workspace-project-settings"
            className="top-settings-panel"
            role="region"
            aria-label="프로젝트 설정"
          >
            <ProjectActionsPanel
              project={project}
              currentFilePath={currentFilePath}
              statusMessage={statusMessage}
              isDirty={isDirty}
              imageImportDisabledReason={imageImportDisabledReason}
              projectEditingDisabled={sessionNeedsRecovery}
              showFileActions={false}
              showFilePath
              onNewProject={beginNewImageProject}
              onOpenProject={() => openProjectFromFileDialog()}
              onSaveProject={saveProject}
              onSaveProjectAs={saveProjectAs}
              onExportTranslations={exportTranslations}
              onRenameProject={renameProject}
              onToggleSecret={toggleSecret}
            />
          </section>
        ) : null}
      </div>
      )}
      pages={
      <aside
        className="left-drawer"
        aria-label="왼쪽 보조 패널"
      >
          <nav className="workspace-navigator" aria-label="워크스페이스 탐색">
            {([
              ["pages", "페이지"],
              ["context", "문맥"],
              ["guide", "가이드"],
              ["settings", "설정"]
            ] as Array<[NavigatorView, string]>).map(([view, label]) => (
              <button
                key={view}
                type="button"
                aria-label={`탐색: ${label}`}
                aria-pressed={activeNavigator === view}
                onClick={() => setActiveNavigator(view)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="workspace-navigator-content">
          {activeNavigator === "pages" ? (
            <>
            <PageStrip key={projectSessionId ?? project.metadata.id} pages={pageStripItems} currentPage={currentPage} onSelectPage={setPageAndSelection} currentFilePath={projectSessionId ? `session:${projectSessionId}` : currentFilePath} />
            <ImportPanel
              hasProjectLines={project.dialogueLines.length > 0}
              importing={isImportingTxt}
              disabled={sessionNeedsRecovery}
              onImport={importTxt}
            />
            <ImageImportPanel
              disabled={sessionNeedsRecovery || imageImportDisabledReason !== undefined || isImportingPageImages}
              disabledReason={
                sessionNeedsRecovery
                  ? projectSessionRecoveryMessage
                  : isImportingPageImages ? "이미지를 불러오는 중입니다." : imageImportDisabledReason
              }
              hasPageImages={(project.pageImages?.length ?? 0) > 0}
              onImportImages={importPageImages}
            />
            </>
          ) : null}
          {activeNavigator === "context" ? (
            <section className="navigator-context panel-section" aria-label="등장인물과 용어 문맥">
              <div className="navigator-section-heading">
                <span>문맥</span>
                <strong>{project.characters.length + project.dictionaryTerms.length}</strong>
              </div>
              <p>현재 프로젝트의 등장인물과 용어를 관리합니다.</p>
              <CharacterDictionaryPanel project={project} onChangeProject={replaceProject} projectEditingDisabled={sessionNeedsRecovery} />
            </section>
          ) : null}
          {activeNavigator === "guide" ? (
            <section className="panel-section workflow-guide" aria-label="이미지 작업 가이드">
              <span className="navigator-kicker">현재 워크플로</span>
              <strong>이미지에서 시작해, 선택한 대사에서 끝냅니다.</strong>
              <p>프로젝트 저장 → 이미지 연결 → OCR → 검토·수정 → 저장 또는 TXT 내보내기</p>
              <p>Space는 OCR을, Esc는 현재 도구를 닫습니다. 텍스트 편집 중에는 단축키가 동작하지 않습니다.</p>
            </section>
          ) : null}
          {activeNavigator === "settings" ? (
            <section className="navigator-settings" aria-label="워크스페이스 설정">
              <ProjectActionsPanel
                project={project}
                currentFilePath={currentFilePath}
                statusMessage={statusMessage}
                isDirty={isDirty}
                imageImportDisabledReason={imageImportDisabledReason}
                projectEditingDisabled={sessionNeedsRecovery}
                showFileActions={false}
                showFilePath
                onNewProject={beginNewImageProject}
                onOpenProject={() => openProjectFromFileDialog()}
                onSaveProject={saveProject}
                onSaveProjectAs={saveProjectAs}
                onExportTranslations={exportTranslations}
                onRenameProject={renameProject}
                onToggleSecret={toggleSecret}
              />
            </section>
          ) : null}
          </div>
      </aside>
      }
      canvas={
      <section className="workspace-main" aria-label="이미지 중심 작업 영역" data-workspace-enter-context>
        <section className="image-canvas-shell">
          <Suspense fallback={<DeferredViewFallback label="이미지 작업대를 여는 중입니다." />}>
            <PageImagePanel
            currentPage={currentPage}
            currentFilePath={currentFilePath}
            image={currentPageImage}
            resetKey={`${project.metadata.id}:${imageResetRevision}`}
            renderRequestKey={controlledRenderRequestKey}
            focusRequest={issueFocusRequest ?? undefined}
            resultLayer={resultLayer}
            resultLayers={currentPageResultLayers}
            cleanedReview={currentCleanedInspection?.asset && currentPageImage ? {
              assetId: currentCleanedInspection.asset.assetId,
              assetSha256: currentCleanedInspection.asset.sha256,
              sourceSha256: currentPageImage.sha256,
              reviewed: currentCleanedInspection.status === "valid" &&
                currentCleanedInspection.pageRecord?.userReviewedCleanedAssetId === currentCleanedInspection.asset.assetId,
              disabledReason: currentCleanedInspection.status !== "valid"
                ? "결과의 현재 상태와 품질 검사를 확인하세요."
                : !projectSessionId || !currentFilePath || !window.projectApi?.reviewCleanedAsset
                  ? "프로젝트 저장과 세션 준비가 필요합니다."
                  : sessionNeedsRecovery ? "세션 복구가 필요합니다." : undefined,
              busy: cleanedReviewInFlight,
              onConfirm: confirmDisplayedCleanedAsset
            } : undefined}
            onResultLayerChange={handleUserResultLayerChange}
            initialViewport={initialImageViewport}
            onViewportZoomChange={setWorkspaceZoom}
            onViewportChangeWithIdentity={(viewport, renderRequestKey, renderGeneration) => {
                if (
                !currentRenderRequestKeyRef.current ||
                renderRequestKey !== currentRenderRequestKeyRef.current ||
                (currentRenderGenerationRef.current !== null && renderGeneration !== currentRenderGenerationRef.current)
              ) return;
              if (currentRenderGenerationRef.current === null) currentRenderGenerationRef.current = renderGeneration;
              setWorkspaceViewport(viewport);
              setWorkspaceZoom(viewport.zoom);
            }}
            initialComparisonState={{
              key: `${project.metadata.id}:workspace-comparison:${workspaceIdentityKey}:${workspaceComparisonHydrationRevision}`,
              ...workspaceComparison
            }}
            onComparisonStateChange={handleWorkspaceComparisonStateChange}
            uploadDisabledReason={imageImportDisabledReason}
            ocrDisabledReason={isImportingPageImages ? "이미지 연결이 끝난 뒤 다시 시도하세요." : finalReading ? "최종 읽기 중입니다. 편집으로 돌아가서 실행하세요." : ocrDisabledReason}
            inpaintingDisabledReason={isImportingPageImages ? "이미지 연결이 끝난 뒤 다시 시도하세요." : finalReading ? "최종 읽기 중입니다. 편집으로 돌아가서 실행하세요." : inpaintingDisabledReason}
            precisionEditingDisabled={workspaceAdaptation.precisionEditingDisabled || isImportingPageImages}
            onImportImages={importPageImages}
            onInpaintImage={inpaintCurrentPageImage}
            onCancelInpainting={() => cancelActiveInpainting({ notify: true })}
            onExtractSpeechBubbles={extractSpeechBubblesFromCurrentPage}
            onRenderStateChange={handlePageImageRenderState}
            isInpainting={isInpainting}
            isExtractingSpeechBubbles={isExtractingSpeechBubbles}
            activeOcrBbox={finalReading ? null : activeReviewItem?.bbox ?? currentIssue?.focusBbox ?? selectedLineForEditor?.typesetting?.bbox ?? null}
            stageHint={activeReviewItem ? `OCR 후보 #${activeReviewItem.readingOrder}` : selectedLineForEditor ? `대사 #${selectedLineForEditor.order} · ${selectedLineForEditor.speaker || "화자 없음"}` : undefined}
            semanticOverlays={finalReading ? [] : semanticOverlays}
            dialogueTargets={finalReading || speechBubbleReview ? [] : currentPageLines.flatMap((line) => {
              const bbox = getDialogueTargetBbox(line);
              return bbox ? [{ id: line.id, order: line.order, bbox, selected: selectedLineId === line.id }] : [];
            })}
            onSelectLine={selectLine}
            visibleOverlayKinds={visibleOverlayKinds}
            onVisibleOverlayKindsChange={(kinds) => setVisibleOverlayKinds([...kinds])}
            typesettingDraft={finalReading || !workspacePanels.inspectorOpen || editingTool !== "typesetting" || inpaintingEditorOpen ? null : currentTypesettingDraft}
            typesettingSafeArea={typesettingSafeArea}
            typesettingPreviewText={selectedLineForEditor?.userTranslation || selectedLineForEditor?.aiTranslation || selectedLineForEditor?.sourceText || undefined}
            onTypesettingDraftChange={handleTypesettingDraftChange}
            manualTypesetting={!finalReading && workspacePanels.inspectorOpen && editingTool === "typesetting" && !inpaintingEditorOpen &&
              !speechBubbleReview && manualTypesettingKey && selectedLineForEditor && resultLayer === "original" ? {
                key: manualTypesettingKey,
                draft: manualTypesettingDraft ? manualTypesettingDraft.bbox : selectedLineForEditor.typesetting?.bbox ?? null,
                initialFields: manualTypesettingDraft?.fields,
                controlsTarget: manualTypesettingControlsTarget,
                previewText: selectedLineForEditor.userTranslation,
                onDraftChange: (bbox) => updateManualTypesettingDraft({ bbox }),
                onFieldsChange: (fields) => updateManualTypesettingDraft({ fields }),
                onApply: applyManualTypesettingBox,
                disabled: sessionNeedsRecovery || workspaceAdaptation.precisionEditingDisabled || isImportingPageImages,
                disabledReason: isImportingPageImages ? "이미지 연결이 끝난 뒤 영역을 수정하세요." : sessionNeedsRecovery ? "세션 복구가 필요합니다." : "창을 넓혀 글자 배치 영역을 지정하세요."
              } : undefined}
            onInpaintingMaskBoundsChange={handleInpaintingMaskBoundsChange}
            initialMaskDraft={currentInpaintingMaskDraft}
            onInpaintingMaskDraftChange={handleInpaintingMaskDraftChange}
            inpaintingOpen={inpaintingEditorOpen}
            onInpaintingOpenChange={(open) => {
              if (open) {
                setInpaintingEditorOpen(true);
                clearSpeechBubbleReview();
              } else {
                closeInpaintingEditor();
              }
              }}
            />
          </Suspense>
        </section>
      </section>
      }
      editor={workspacePresentation.showInspector ?
      <aside className="right-inspector" aria-label="오른쪽 작업 패널" data-issue-editor={issueEditorState.activeEditor ?? issueEditor ?? "none"}>
        <div className="mangohana-editing-tools" role="group" aria-label="수정 도구">
          <button type="button" aria-pressed={!inpaintingEditorOpen && editingTool === "source"} onClick={() => { closeInpaintingEditor(); setEditingTool("source"); }}>원문</button>
          <button type="button" aria-pressed={!inpaintingEditorOpen && editingTool === "translation"} onClick={() => { closeInpaintingEditor(); setEditingTool("translation"); }}>번역</button>
          <button type="button" aria-pressed={inpaintingEditorOpen}
            disabled={isImportingPageImages || sessionNeedsRecovery || !currentPageImage || currentPageImageLoadFailed || !currentFilePath || imageImportDisabledReason !== undefined || inpaintingDisabledReason !== undefined || workspaceAdaptation.precisionEditingDisabled || isInpainting}
            onClick={() => { setInpaintingEditorOpen(true); clearSpeechBubbleReview(); }}>배경 정리</button>
          <button type="button" aria-pressed={!inpaintingEditorOpen && editingTool === "typesetting"}
            onClick={() => { closeInpaintingEditor(); setEditingTool("typesetting"); }}>글자 배치</button>
        </div>
        {currentIssue ? (
          <ContextualIssueEditorControl
            state={issueEditorState}
            onTogglePin={() => dispatchIssueEditor({ type: "toggle-pin" })}
            onSwitchToRequired={() => dispatchIssueEditor({ type: "switch-to-required" })}
          />
        ) : null}
        <section className="panel-section inspector-image-actions" aria-label="현재 페이지 이미지 작업">
          <h2>이미지 작업</h2>
          {(ocrDisabledReason || inpaintingDisabledReason || workspaceAdaptation.precisionEditingDisabled) ? (
          <details className="inspector-capabilities" open={workspaceMode !== "line-edit"}>
            <summary>이미지 도구 · 준비 상태 확인</summary>
          {ocrDisabledReason ? (
            <p id="inspector-ocr-disabled-reason" className="capability-disabled-reason" role="status">
              환경 준비에서 OCR 상태를 확인하세요. {ocrDisabledReason}
            </p>
          ) : null}
          {inpaintingDisabledReason ? (
            <p id="inspector-inpainting-disabled-reason" className="capability-disabled-reason" role="status">
              환경 준비에서 인페인팅 상태를 확인하세요. {inpaintingDisabledReason}
            </p>
          ) : null}
          {workspaceAdaptation.precisionEditingDisabled ? (
            <p id="inspector-precision-disabled-reason" className="capability-disabled-reason" role="status">
              창이 작아 인페인팅과 식자 상자 직접 조작을 잠시 비활성화했습니다. 이미지 열람, OCR, 수동 번역, 저장은 계속 사용할 수 있습니다.
            </p>
          ) : null}
          </details>
          ) : null}
          <div className="inspector-image-action-buttons">
            <button type="button" onClick={importPageImages} disabled={imageImportDisabledReason !== undefined}>
              {currentPageImage ? "다시 연결" : "이미지 연결"}
            </button>
            <button
              type="button"
              onClick={() => {
                setInpaintingEditorOpen(true);
                clearSpeechBubbleReview();
              }}
              aria-describedby={workspaceAdaptation.precisionEditingDisabled ? "inspector-precision-disabled-reason" : inpaintingDisabledReason ? "inspector-inpainting-disabled-reason" : undefined}
              disabled={isImportingPageImages || sessionNeedsRecovery || !currentPageImage || currentPageImageLoadFailed || !currentFilePath || imageImportDisabledReason !== undefined || inpaintingDisabledReason !== undefined || workspaceAdaptation.precisionEditingDisabled || isInpainting}
            >
              인페인팅
            </button>
            <button
              ref={imagePrimaryActionRef}
              type="button"
              onClick={extractSpeechBubblesFromCurrentPage}
              aria-describedby={ocrDisabledReason ? "inspector-ocr-disabled-reason" : undefined}
              disabled={isImportingPageImages || (!isExtractingSpeechBubbles && (sessionNeedsRecovery || !currentPageImage || !currentFilePath || ocrDisabledReason !== undefined))}
            >
              {isExtractingSpeechBubbles ? "OCR 취소" : "말풍선 OCR"}
            </button>
            {!speechBubbleReview && currentPageImage &&
              ocrReviewDraftsRef.current.get(currentPageImage.id)?.sourceSha256 === currentPageImage.sha256 ? (
              <button type="button" onClick={resumeSpeechBubbleReview} disabled={isInpainting}>
                OCR 검토 계속
              </button>
            ) : null}
          </div>
        </section>
        {workspaceMode === "inpainting" ? (
          <section className="panel-section inspector-task-panel">
            <h2>인페인팅</h2>
            <p>이미지 stage에서 마스크를 칠한 뒤 실행하세요. 실패하면 마스크와 편집 상태를 유지합니다.</p>
            <button
              type="button"
              className="secondary-button"
              aria-label="인스펙터에서 이미지로 돌아가기"
              onClick={closeInpaintingEditor}
              disabled={isInpainting}
            >
              이미지로 돌아가기
            </button>
          </section>
        ) : (
          <GuidedWorkPanel
            stage={guidedStage}
            density={guidanceDensity}
            summaries={guidedSummaries}
            onDensityChange={setGuidanceDensity}
          >
            {!inpaintingEditorOpen && editingTool === "typesetting" ? (
              <section className="panel-section mangohana-typesetting-instructions" aria-label="글자 배치 안내">
                <h2>글자 배치</h2>
                <p>{activeReviewItem ? "이미지 위의 상자를 움직여 이 OCR 후보의 글자 위치를 조정하세요." : selectedLineForEditor ? "상자 안의 번역문은 위치 미리보기입니다." : "먼저 글자를 배치할 대사를 선택하세요."}</p>
                <div ref={setManualTypesettingControlsTarget} />
                {selectedLineForEditor && !speechBubbleReview && resultLayer !== "original" ? <button type="button" onClick={() => handleUserResultLayerChange("original")}>원본에서 영역 지정</button> : null}
              </section>
            ) : null}
            <div className="mangohana-stage-container" hidden={!inpaintingEditorOpen && editingTool === "typesetting"} inert={!inpaintingEditorOpen && editingTool === "typesetting"}>
            <Suspense fallback={<DeferredViewFallback label="번역 편집기를 여는 중입니다." />}>
              <StageEditor
              primaryActionRef={stageEditorPrimaryActionRef}
              stage={guidedStage}
              currentPage={currentPage}
              review={speechBubbleReview}
              line={selectedLineForEditor}
              busy={isExtractingSpeechBubbles}
              error={ocrError}
              onApproveOcr={advanceReviewToSpeaker}
              onApproveSpeaker={applySpeechBubbleReview}
              onCancelReview={cancelSpeechBubbleReview}
              onBackToOcr={() => setCurrentReviewStage("ocr")}
              onActiveReviewItemChange={setActiveReviewItem}
              reviewDraft={currentPageImage ? ocrReviewDraftsRef.current.get(currentPageImage.id)?.draft : undefined}
              onReviewDraftChange={rememberSpeechBubbleReviewDraft}
              onUpdateLine={updateLine}
              onDeleteLine={deleteSelectedLine}
              onMoveLine={moveSelectedLine}
              canMovePrevious={Boolean(selectedLineId && project.dialogueLines.findIndex((line) => line.id === selectedLineId) > 0)}
              canMoveNext={Boolean(selectedLineId && project.dialogueLines.findIndex((line) => line.id === selectedLineId) >= 0 && project.dialogueLines.findIndex((line) => line.id === selectedLineId) < project.dialogueLines.length - 1)}
              onApproveTranslation={confirmSelectedTranslation}
              onPostponeTranslation={currentIssue?.editor === "translation" ? postponeTranslation : undefined}
              hasActionableProjectLines={hasActionableProjectLines}
              hasProjectLines={project.dialogueLines.length > 0}
              hasPageLines={pendingPageNumbers.includes(currentPage) || pageSummary.dialogueCount > 0}
              nextActionableLine={nextActionableProjectLine}
              onContinueProject={goToRemainingActionableLine}
              onExport={exportTranslations}
              onReviewProject={() => {
                setBottomPanel("issues");
                setWorkspacePanels((current) => ({ ...current, resultsOpen: true }));
              }}
              onRetry={extractSpeechBubblesFromCurrentPage}
              issueEditorOverride={currentIssue ? issueEditorState.activeEditor : !speechBubbleReview && editingTool === "source" ? "ocr" : null}
              issueContextId={currentIssue?.lineId ?? null}
              dialogueLines={project.dialogueLines}
              characters={project.characters}
              dictionaryTerms={project.dictionaryTerms}
              onRequestAiTranslation={handleRequestAiTranslation}
              onCancelAiTranslation={() => cancelActiveAiTranslation({ notify: true })}
              isTranslating={isAiTranslating}
              hasPageImage={Boolean(currentPageImage)}
              ocrDisabledReason={ocrDisabledReason}
              onOpenEnvironmentPreparation={() => openEnvironmentPreparation("workspace")}
              onRunOcr={extractSpeechBubblesFromCurrentPage}
              onCreateManualLine={createManualDialogueLine}
              focusUserTranslation={focusNewManualTranslation}
              onUserTranslationFocus={() => setFocusNewManualTranslation(false)}
              projectEditingDisabled={sessionNeedsRecovery || isImportingPageImages}
              />
            </Suspense>
            </div>
          </GuidedWorkPanel>
        )}

        <details
          className="inspector-context-section"
          open={contextOpen ?? false}
          onToggle={(event) => setContextOpen(event.currentTarget.open)}
        >
          <summary>
            등장인물·용어
            <span className="focus-deck-panel-badge">{project.characters.length + project.dictionaryTerms.length}</span>
          </summary>
          <CharacterDictionaryPanel project={project} onChangeProject={replaceProject} projectEditingDisabled={sessionNeedsRecovery} />
        </details>
      </aside> : null
      }
      filmstrip={workspacePresentation.showBottomPanel ?
      <section className="bottom-line-panel" aria-label="하단 대사 패널">
        <div className="bottom-line-panel-header">
          <div>
            <h2>{bottomPanel === "ocr-candidates" ? "OCR 후보" : bottomPanel === "issues" ? "문제 라인" : "대사"}</h2>
            <span aria-label="페이지 요약">
              대사 {pageSummary.dialogueCount}개 · 완료 {pageSummary.completeCount}개 · 검토필요 {pageSummary.reviewCount}개
            </span>
          </div>
          <div className="bottom-panel-tabs" role="tablist" aria-label="하단 패널 탭">
            <button
              type="button"
              role="tab"
              aria-selected={bottomPanel === "dialogue"}
              onClick={() => setBottomPanel("dialogue")}
            >
              대사
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={bottomPanel === "ocr-candidates"}
              onClick={() => setBottomPanel("ocr-candidates")}
            >
              OCR 후보
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={bottomPanel === "issues"}
              onClick={() => setBottomPanel("issues")}
            >
              문제 라인
            </button>
          </div>
          {bottomPanel === "dialogue" ? (
            <button
              type="button"
              onClick={() => setDialogueView((current) => (current === "queue" ? "full" : "queue"))}
            >
              {dialogueView === "queue" ? "전체 대사 보기" : "작업 큐 보기"}
            </button>
          ) : null}
        </div>
        {bottomPanel === "dialogue" ? (
          dialogueView === "queue" ? (
            <div className="processing-queue-view">
              <DialogueFilmstrip
                lines={currentPageLines}
                selectedLineId={selectedLineId}
                onSelectLine={selectLine}
              />
              <ProcessingQueuePanel
                project={project}
                projectSessionId={projectSessionId}
                sessionGeneration={sessionGenerationRef.current}
                disabled={sessionNeedsRecovery}
                onOpenBatchAutomation={() => setBatchModalOpen(true)}
                onResult={async (result, scope: ProcessingQueueRequestScope, isCurrent) => {
                  const adopted = await adoptBatchSessionDto(result.project, {
                    ...scope, projectId: projectRef.current.metadata.id
                  }, isCurrent, () => projectRef.current.processing.queue?.queueId === scope.queueId &&
                    result.queue?.queueId === scope.queueId && result.project.project.processing.queue?.queueId === scope.queueId);
                  if (adopted === "adopted" && isCurrent()) setStatusMessage(result.control?.status === "failed" ? result.control.message : "작업 큐 상태를 갱신했습니다.");
                  return adopted;
                }}
                onError={(message, scope: ProcessingQueueRequestScope) => {
                  if (
                    projectSessionIdRef.current === scope.projectSessionId &&
                    sessionGenerationRef.current === scope.sessionGeneration
                  ) {
                    setStatusMessage(message);
                  }
                }}
              />
            </div>
          ) : (
            <Suspense fallback={<DeferredViewFallback label="전체 대사를 여는 중입니다." />}>
              <DialogueTable
              lines={currentPageLines}
              allLines={project.dialogueLines}
              currentPage={currentPage}
              hasProjectLines={project.dialogueLines.length > 0}
              selectedLineId={selectedLineId}
              variant="full"
              onSelectLine={selectLine}
                onUpdateLine={updateLine}
                disabled={sessionNeedsRecovery}
              />
            </Suspense>
          )
        ) : null}
        {bottomPanel === "ocr-candidates" ? renderOcrCandidatePanel(speechBubbleReview) : null}
        {bottomPanel === "issues" ? (
          <IssueLinePanel issues={issueLineItems} currentIssueId={currentIssue?.lineId ?? null} onSelectLine={selectIssueLine} />
        ) : null}
      </section> : null
      }
    />
    <BatchAutomationModal
      project={project}
      projectSessionId={projectSessionId}
      sessionGeneration={sessionGenerationRef.current}
      pageCount={pageCount}
      isOpen={batchModalOpen}
      onClose={() => setBatchModalOpen(false)}
      onOpenProcessingQueue={() => {
        setBatchModalOpen(false);
        setFinalReading(false);
        workspacePanelActionsRef.current?.openResults();
        setBottomPanel("dialogue");
        setDialogueView("queue");
        setStatusMessage(projectRef.current.processing.queue?.status === "paused"
          ? "작업 큐에서 현재 페이지·단계를 확인한 뒤 재개할 수 있습니다."
          : "실패 페이지를 작업 큐에서 확인하고 재시도할 수 있습니다.");
      }}
      onRegisterRun={(scope, isCurrent) => {
        if (!isCurrent() || scope.projectSessionId !== projectSessionIdRef.current ||
          scope.sessionGeneration !== sessionGenerationRef.current || scope.projectId !== projectRef.current.metadata.id ||
          scope.initialQueueId !== (projectRef.current.processing.queue?.queueId ?? null)) return false;
        currentBatchRunRef.current = { scope, queueId: null, isCurrent };
        return true;
      }}
      onBindRunQueue={bindBatchRunQueue}
      onFinishRun={(scope) => {
        if (currentBatchRunRef.current?.scope.requestId === scope.requestId) currentBatchRunRef.current = null;
      }}
      onApplyBatchProject={async (updated, sessionChange, scope, isCurrent) => {
        if (!isCurrent() || !isCurrentBatchRun(scope)) return "ignored";
        if (scope.projectSessionId) {
          if (!sessionChange || sessionChange.status !== "applied" || sessionChange.revision !== sessionChange.project.revision) return "ignored";
          const queue = sessionChange.project.project.processing.queue;
          if (queue && !bindBatchRunQueue(scope, queue.queueId, isCurrent)) return "ignored";
          const adopted = await adoptBatchSessionDto(sessionChange.project, { ...scope, projectSessionId: scope.projectSessionId },
            () => isCurrent() && isCurrentBatchRun(scope), () => {
              const run = currentBatchRunRef.current;
              if (!queue) return run?.queueId === null && (projectRef.current.processing.queue?.queueId ?? null) === scope.initialQueueId;
              return bindBatchRunQueue(scope, queue.queueId, isCurrent);
            });
          if (adopted === "adopted" && isCurrent() && isCurrentBatchRun(scope)) {
            setStatusMessage("일괄 자동화 결과와 작업 큐 상태를 프로젝트에 반영했습니다.");
          }
          return adopted;
        }
        if (updated.metadata.id !== scope.projectId || projectSessionStatusRef.current !== "active") return "ignored";
        replaceProject(updated);
        setStatusMessage("일괄 자동화 결과와 작업 큐 상태를 프로젝트에 반영했습니다.");
        return "adopted";
      }}
    />
    </>
  );
}



const rootElement = document.getElementById("root");

if (rootElement) {
  const container = rootElement as HTMLElement & { __translationEditorRoot?: Root };
  container.__translationEditorRoot ??= createRoot(container);
  container.__translationEditorRoot.render(<App />);
}

function summarizePageLines(lines: DialogueLine[]) {
  return {
    dialogueCount: lines.length,
    completeCount: lines.filter((line) => line.lineStatus === "complete").length,
    reviewCount: lines.filter((line) => line.lineStatus === "review").length
  };
}

function getPageCount(lines: DialogueLine[], pageImages: { pageNumber: number }[] = []) {
  return Math.max(1, ...lines.map((line) => line.pageNumber), ...pageImages.map((image) => image.pageNumber));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function WorkspaceNavigationIcon({ kind }: { kind: "pages" | "progress" | "edit" | "context" | "settings" }) {
  const paths: Record<typeof kind, string> = {
    pages: "M3 5.5c3-1 6-.6 9 1.3v13c-3-1.9-6-2.3-9-1.3zm18 0c-3-1-6-.6-9 1.3v13c3-1.9 6-2.3 9-1.3z",
    progress: "M4 19v-7h3v7zm6 0V5h3v14zm6 0v-10h3v10z",
    edit: "M4 20l4.2-.8L19 8.4 15.6 5 4.8 15.8zM13.8 6.8l3.4 3.4M4 20h16",
    context: "M20 11.5a8 8 0 0 1-8 8 8.6 8.6 0 0 1-3.3-.7L4 20l1.3-4.2A8 8 0 1 1 20 11.5zM8 11.5h.01M12 11.5h.01M16 11.5h.01",
    settings: "M12 8.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6zM19 12a7 7 0 0 0-.1-1l1.6-1.2-1.5-2.6-1.9.7a7 7 0 0 0-1.7-1L15 5h-3l-.4 1.9a7 7 0 0 0-1.7 1L8 7.2 6.5 9.8 8.1 11a7 7 0 0 0 0 2l-1.6 1.2L8 16.8l1.9-.7a7 7 0 0 0 1.7 1L12 19h3l.4-1.9a7 7 0 0 0 1.7-1l1.9.7 1.5-2.6-1.6-1.2a7 7 0 0 0 .1-1z"
  };
  return <svg className="mangohana-navigation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

function resolveReviewItemTypesetting(
  item: SpeechBubbleReviewItem,
  args: {
    projectId: string;
    pageImageId: string | null;
  }
): DialogueTypesetting {
  const fallback: DialogueTypesetting = {
    bbox: calculateTypesettingSafeArea(item.bbox),
    writingMode: "horizontal-tb"
  };
  if (!args.pageImageId) return fallback;
  const loaded = loadTypesettingDraft(window.localStorage, {
    projectId: args.projectId,
    pageImageId: args.pageImageId,
    sourceOcrId: item.id
  });
  if (!loaded) return fallback;
  const constrained = constrainTypesettingDraftToSafeArea(loaded, deriveTypesettingSafeArea(item.bbox));
  if (!constrained) return fallback;
  return dialogueTypesettingFromDraft(constrained);
}

function getPageStripItems(lines: DialogueLine[], pageImages: { pageNumber: number; storedRelativePath?: string; sha256?: string }[], pageCount: number): PageStripItem[] {
  const imagePages = new Set(pageImages.map((image) => image.pageNumber));
  const imagesByPage = new Map(pageImages.map((image) => [image.pageNumber, image]));

  return Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const pageLines = lines.filter((line) => line.pageNumber === pageNumber);

    return {
      pageNumber,
      hasImage: imagePages.has(pageNumber),
      storedRelativePath: imagesByPage.get(pageNumber)?.storedRelativePath,
      imageRevision: imagesByPage.get(pageNumber)?.sha256,
      lineCount: pageLines.length,
      issueCount: getIssueLineItems(pageLines).length
    };
  });
}

function getDialogueTargetBbox(line: DialogueLine): SemanticOverlayBbox | undefined {
  const points = line.polygon;
  if (points && points.length >= 3 && points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
    const x = Math.min(...points.map((point) => point.x));
    const y = Math.min(...points.map((point) => point.y));
    const width = Math.max(...points.map((point) => point.x)) - x;
    const height = Math.max(...points.map((point) => point.y)) - y;
    if (width > 0 && height > 0) return { x, y, width, height };
  }
  return line.typesetting?.bbox;
}

function findIssueFocusBbox(
  line: DialogueLine,
  review: SpeechBubbleExtractionResult | null
): NormalizedBbox | undefined {
  if (!review || review.pageNumber !== line.pageNumber) return undefined;
  const exact = review.speechBubbles.find((item) => item.id === line.id);
  if (exact) return exact.bbox;
  const text = line.sourceText.trim().toLocaleLowerCase();
  const byReadingOrder = review.speechBubbles.find((item) =>
    item.readingOrder === line.order && item.text.trim().toLocaleLowerCase() === text
  );
  return byReadingOrder?.bbox;
}

function renderOcrCandidatePanel(result: SpeechBubbleExtractionResult | null) {
  if (!result) {
    return <p className="empty-state">검토 중인 OCR 후보가 없습니다.</p>;
  }

  if (result.speechBubbles.length === 0) {
    return <p className="empty-state">OCR 후보가 없습니다.</p>;
  }

  return (
    <div className="ocr-candidate-panel" aria-label="OCR 후보 목록">
      {result.speechBubbles.map((bubble) => {
        const speakerCandidates = bubble.speakerCandidates ?? [];

        return (
          <div className="ocr-candidate-row" key={`${bubble.id}-${bubble.readingOrder}`}>
            <span className="ocr-candidate-id">#{bubble.readingOrder}</span>
            <div className="ocr-candidate-copy">
              <p>{bubble.text || "텍스트 없음"}</p>
              <span>{bubble.type}</span>
              {speakerCandidates.length > 0 ? (
                <small>화자 후보 {speakerCandidates.map((candidate) => candidate.speaker).join(", ")}</small>
              ) : (
                <small>화자 후보 없음</small>
              )}
            </div>
            <span className="ocr-candidate-confidence">신뢰도 {Math.round(bubble.confidence * 100)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function createRendererId(prefix: string, seed: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${seed}`;
}

function isProjectOpenFailureResult(result: unknown): result is ProjectOpenFailureResult {
  return Boolean(
    result &&
    typeof result === "object" &&
    "openFailed" in result &&
    (result as { openFailed?: unknown }).openFailed === true
  );
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /abort|cancel/i.test(error.message);
}

function preparedImagesFromBatch(batch: PreparedPageImageBatchDto): PreparedPageImage[] {
  return batch.images.map((image) => ({
    id: image.preparedImageId,
    importBatchId: image.importBatchId,
    preparedImageId: image.preparedImageId,
    fileName: image.originalFileName,
    previewSrc: `translation-image://asset/${image.previewToken}`,
    byteSize: image.byteSize,
    mimeType: image.mimeType
  }));
}

function getImageImportDisabledReason(secret: boolean, currentFilePath: string | null) {
  if (secret) return "시크릿 프로젝트에서는 이미지 업로드가 아직 지원되지 않습니다.";
  if (!currentFilePath) return "프로젝트를 저장하면 페이지 이미지를 업로드할 수 있습니다.";
  return undefined;
}

function ownsWorkspacePlainEnter(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return false;
  // Plain Enter belongs to controls and open auxiliary surfaces before the workspace.
  const interactive = "button, a[href], input, textarea, select, summary, [contenteditable]:not([contenteditable='false']), [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='option'], [role='combobox'], [role='listbox'], [role='checkbox'], [role='radio'], [role='switch'], [role='slider'], [role='spinbutton'], [role='treeitem']";
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (target?.closest(interactive) || document.activeElement?.closest(interactive)) return false;
  const workspace = target?.closest(".focus-deck-shell");
  if (workspace?.querySelector("[role='dialog'], [role='alertdialog'], [aria-modal='true'], #workspace-project-settings, details[open]")) return false;
  return Boolean(target?.closest("[data-workspace-enter-context]"));
}

function projectOpenErrorMessage(error: unknown) {
  if (error instanceof Error && /\bENOENT\b|PROJECT_FILE_NOT_FOUND/.test(error.message)) {
    return "프로젝트 파일을 찾을 수 없습니다. 파일이 이동되었거나 삭제되었는지 확인한 뒤 다시 선택하세요.";
  }
  return error instanceof Error ? error.message : "프로젝트를 열지 못했습니다.";
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

