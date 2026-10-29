import {
  clampComparisonOpacity,
  clampRevealPosition,
  type ComparisonMode
} from "./comparisonState";
import {
  clampEditorWidth,
  type WorkspacePanelState
} from "./focusDeck";
import {
  clampImageZoom,
  createImageViewportState,
  type ImageViewportState,
  type ImageViewMode
} from "./imageViewport";
import {
  COMPARISON_MODES,
  OVERLAY_KINDS,
  RESULT_LAYERS,
  type OverlayKind,
  type ResultLayer
} from "./trioState";
import type { NormalizedBbox } from "../shared/speechBubbleExtraction";

export const WORKSPACE_SESSION_VERSION = 1 as const;
export const WORKSPACE_SESSION_STORAGE_KEY = "translation-editor:workspace-session:v1";

export type WorkspaceSessionLifecycle = "active" | "closed";

/**
 * The renderer never persists a filesystem path as a locator. `recentProjectId`
 * is the opaque token owned by Main; `projectKey` is only used to keep the
 * existing renderer preference namespace stable after the project is opened.
 */
export type WorkspaceSessionIdentity = {
  projectId: string;
  projectKey: string;
  recentProjectId: string | null;
  revision: number;
};

export type WorkspaceSessionComparison = {
  mode: ComparisonMode;
  revealPosition: number;
  opacity: number;
};

export type WorkspaceSessionIssue = {
  lineId: string;
  kind: string;
  editor: "ocr" | "speaker" | "translation";
};

export type WorkspaceSessionIssueEditor = {
  activeEditor: "ocr" | "speaker" | "translation" | null;
  pinned: boolean;
};

export type WorkspaceSessionDraftContext = {
  translationLineId: string | null;
  translationSourceIdentity: string | null;
  typesettingPageImageId: string | null;
  typesettingSourceOcrId: string | null;
  /** Immutable OCR geometry used to constrain the mutable typesetting draft. */
  typesettingSourceOcrBbox?: NormalizedBbox | null;
};

export type WorkspaceSessionSnapshot = {
  version: typeof WORKSPACE_SESSION_VERSION;
  lifecycle: WorkspaceSessionLifecycle;
  savedAt: string;
  project: WorkspaceSessionIdentity;
  currentPage: number;
  pageCount: number;
  viewport: ImageViewportState;
  comparison: WorkspaceSessionComparison;
  resultLayer: ResultLayer;
  visibleOverlays: OverlayKind[];
  workspacePanels: WorkspacePanelState;
  bottomPanel: "dialogue" | "ocr-candidates" | "issues";
  dialogueView: "queue" | "full";
  selectedLineId: string | null;
  currentIssue: WorkspaceSessionIssue | null;
  issueEditor: WorkspaceSessionIssueEditor;
  drafts: WorkspaceSessionDraftContext;
};

export type WorkspaceSessionRestoreOptions = {
  lineIds?: ReadonlySet<string>;
  issueLineIds?: ReadonlySet<string>;
};

export type WorkspaceSessionValidation =
  | { valid: true; snapshot: WorkspaceSessionSnapshot }
  | { valid: false; reason: string };

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const VIEW_MODES: readonly ImageViewMode[] = ["fit", "width", "actual"];
const ISSUE_EDITORS: readonly WorkspaceSessionIssueEditor["activeEditor"][] = [
  null,
  "ocr",
  "speaker",
  "translation"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function parseNormalizedBbox(value: unknown): NormalizedBbox | null {
  if (!isRecord(value)) return null;
  const parts = [value.x, value.y, value.width, value.height];
  if (!parts.every(isFiniteNumber)) return null;
  const { x, y, width, height } = value as Record<string, number>;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return null;
  return { x, y, width, height };
}

function cloneViewport(viewport: ImageViewportState): ImageViewportState {
  return {
    viewMode: viewport.viewMode,
    zoom: viewport.zoom,
    pan: { ...viewport.pan },
    layers: { ...viewport.layers }
  };
}

function defaultWorkspacePanels(): WorkspacePanelState {
  return {
    pagesOpen: true,
    inspectorOpen: true,
    resultsOpen: true,
    focusMode: false,
    inspectorWidth: 392
  };
}

function defaultDrafts(): WorkspaceSessionDraftContext {
  return {
    translationLineId: null,
    translationSourceIdentity: null,
    typesettingPageImageId: null,
    typesettingSourceOcrId: null,
    typesettingSourceOcrBbox: null
  };
}

function parseViewport(value: unknown): ImageViewportState | null {
  if (!isRecord(value) || !isOneOf(value.viewMode, VIEW_MODES)) return null;
  if (!isFiniteNumber(value.zoom) || !isRecord(value.pan) || !isFiniteNumber(value.pan.x) || !isFiniteNumber(value.pan.y)) {
    return null;
  }
  if (!isRecord(value.layers)) return null;
  const layers = value.layers;
  const layerNames = ["original", "ocr", "sourceText", "translation", "final"] as const;
  if (layerNames.some((layer) => typeof layers[layer] !== "boolean")) return null;
  return {
    viewMode: value.viewMode,
    zoom: clampImageZoom(value.zoom),
    pan: {
      x: Math.max(0, value.pan.x),
      y: Math.max(0, value.pan.y)
    },
    layers: {
      original: layers.original as boolean,
      ocr: layers.ocr as boolean,
      sourceText: layers.sourceText as boolean,
      translation: layers.translation as boolean,
      final: layers.final as boolean
    }
  };
}

function parsePanels(value: unknown): WorkspacePanelState | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.pagesOpen !== "boolean" ||
    typeof value.inspectorOpen !== "boolean" ||
    typeof value.resultsOpen !== "boolean" ||
    typeof value.focusMode !== "boolean" ||
    !isFiniteNumber(value.inspectorWidth)
  ) return null;
  return {
    pagesOpen: value.pagesOpen,
    inspectorOpen: value.inspectorOpen,
    resultsOpen: value.resultsOpen,
    focusMode: value.focusMode,
    inspectorWidth: clampEditorWidth(value.inspectorWidth)
  };
}

function parseIssue(value: unknown): WorkspaceSessionIssue | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isNonEmptyString(value.lineId) || !isNonEmptyString(value.kind) || !isOneOf(value.editor, ["ocr", "speaker", "translation"] as const)) {
    return undefined;
  }
  return { lineId: value.lineId, kind: value.kind, editor: value.editor };
}

function parseIssueEditor(value: unknown): WorkspaceSessionIssueEditor | null {
  if (!isRecord(value) || !ISSUE_EDITORS.includes(value.activeEditor as WorkspaceSessionIssueEditor["activeEditor"]) || typeof value.pinned !== "boolean") {
    return null;
  }
  if (value.pinned === true && value.activeEditor === null) return null;
  return {
    activeEditor: value.activeEditor as WorkspaceSessionIssueEditor["activeEditor"],
    pinned: value.pinned
  };
}

function parseDrafts(value: unknown): WorkspaceSessionDraftContext | null {
  if (value === undefined) return defaultDrafts();
  if (!isRecord(value)) return null;
  const nullableStrings = [
    value.translationLineId,
    value.translationSourceIdentity,
    value.typesettingPageImageId,
    value.typesettingSourceOcrId
  ];
  if (nullableStrings.some((item) => item !== null && !isNonEmptyString(item))) return null;
  const translationPairPresent = value.translationLineId !== null || value.translationSourceIdentity !== null;
  const typesettingPairPresent = value.typesettingPageImageId !== null || value.typesettingSourceOcrId !== null;
  if (translationPairPresent && (value.translationLineId === null || value.translationSourceIdentity === null)) return null;
  if (typesettingPairPresent && (value.typesettingPageImageId === null || value.typesettingSourceOcrId === null)) return null;
  const typesettingSourceOcrBbox = value.typesettingSourceOcrBbox === undefined || value.typesettingSourceOcrBbox === null
    ? null
    : parseNormalizedBbox(value.typesettingSourceOcrBbox);
  if (value.typesettingSourceOcrBbox !== undefined && value.typesettingSourceOcrBbox !== null && !typesettingSourceOcrBbox) return null;
  return {
    translationLineId: value.translationLineId as string | null,
    translationSourceIdentity: value.translationSourceIdentity as string | null,
    typesettingPageImageId: value.typesettingPageImageId as string | null,
    typesettingSourceOcrId: value.typesettingSourceOcrId as string | null,
    typesettingSourceOcrBbox
  };
}

function parseIdentity(value: unknown): WorkspaceSessionIdentity | null {
  if (!isRecord(value) || !isNonEmptyString(value.projectId) || !isNonEmptyString(value.projectKey) || !isFiniteNumber(value.revision)) {
    return null;
  }
  if (value.recentProjectId !== null && !isNonEmptyString(value.recentProjectId)) return null;
  return {
    projectId: value.projectId,
    projectKey: value.projectKey,
    recentProjectId: value.recentProjectId as string | null,
    revision: value.revision
  };
}

export function createWorkspaceSessionSnapshot(input: {
  identity: WorkspaceSessionIdentity;
  currentPage: number;
  pageCount: number;
  viewport?: ImageViewportState;
  comparison?: WorkspaceSessionComparison;
  resultLayer?: ResultLayer;
  visibleOverlays?: readonly OverlayKind[];
  workspacePanels?: WorkspacePanelState;
  bottomPanel?: WorkspaceSessionSnapshot["bottomPanel"];
  dialogueView?: WorkspaceSessionSnapshot["dialogueView"];
  selectedLineId?: string | null;
  currentIssue?: WorkspaceSessionIssue | null;
  issueEditor?: WorkspaceSessionIssueEditor;
  drafts?: WorkspaceSessionDraftContext;
  lifecycle?: WorkspaceSessionLifecycle;
  savedAt?: string;
}): WorkspaceSessionSnapshot {
  const baseViewport = input.viewport ?? createImageViewportState();
  const comparison = input.comparison ?? { mode: "single", revealPosition: 50, opacity: 0.5 };
  const maxPage = Math.max(1, Math.floor(input.pageCount));
  const currentPage = Math.min(maxPage, Math.max(1, Math.floor(input.currentPage)));
  const overlays = [...new Set((input.visibleOverlays ?? []).filter((kind): kind is OverlayKind => OVERLAY_KINDS.includes(kind)))];
  return {
    version: WORKSPACE_SESSION_VERSION,
    lifecycle: input.lifecycle ?? "active",
    savedAt: input.savedAt ?? new Date().toISOString(),
    project: { ...input.identity },
    currentPage,
    pageCount: maxPage,
    viewport: cloneViewport(baseViewport),
    comparison: {
      mode: isOneOf(comparison.mode, COMPARISON_MODES) ? comparison.mode : "single",
      revealPosition: clampRevealPosition(comparison.revealPosition),
      opacity: clampComparisonOpacity(comparison.opacity)
    },
    resultLayer: isOneOf(input.resultLayer, RESULT_LAYERS) ? input.resultLayer : "original",
    visibleOverlays: overlays,
    workspacePanels: input.workspacePanels ? { ...input.workspacePanels } : defaultWorkspacePanels(),
    bottomPanel: input.bottomPanel ?? "dialogue",
    dialogueView: input.dialogueView ?? "queue",
    selectedLineId: input.selectedLineId ?? null,
    currentIssue: input.currentIssue ? { ...input.currentIssue } : null,
    issueEditor: input.issueEditor ? { ...input.issueEditor } : { activeEditor: null, pinned: false },
    drafts: input.drafts ? { ...defaultDrafts(), ...input.drafts } : defaultDrafts()
  };
}

/** Parse and identity-check a snapshot. Project content is never read or mutated here. */
export function validateWorkspaceSession(
  value: unknown,
  identity: WorkspaceSessionIdentity,
  pageCount: number,
  options: WorkspaceSessionRestoreOptions = {}
): WorkspaceSessionValidation {
  if (!isRecord(value) || value.version !== WORKSPACE_SESSION_VERSION || !isOneOf(value.lifecycle, ["active", "closed"] as const) || !isNonEmptyString(value.savedAt)) {
    return { valid: false, reason: "invalid-envelope" };
  }
  const project = parseIdentity(value.project);
  if (!project) return { valid: false, reason: "invalid-identity" };
  if (
    project.projectId !== identity.projectId ||
    project.projectKey !== identity.projectKey ||
    project.recentProjectId !== identity.recentProjectId ||
    project.revision !== identity.revision
  ) return { valid: false, reason: "outdated-identity" };
  if (!isFiniteNumber(value.currentPage) || value.currentPage < 1 || !isFiniteNumber(value.pageCount) || value.pageCount < 1) {
    return { valid: false, reason: "invalid-page" };
  }
  const viewport = parseViewport(value.viewport);
  if (!viewport) return { valid: false, reason: "invalid-viewport" };
  if (!isRecord(value.comparison) || !isOneOf(value.comparison.mode, COMPARISON_MODES) || !isFiniteNumber(value.comparison.revealPosition) || !isFiniteNumber(value.comparison.opacity)) {
    return { valid: false, reason: "invalid-comparison" };
  }
  const panels = parsePanels(value.workspacePanels);
  if (!panels) return { valid: false, reason: "invalid-panels" };
  if (!isOneOf(value.resultLayer, RESULT_LAYERS) || !Array.isArray(value.visibleOverlays) || value.visibleOverlays.some((kind) => !isOneOf(kind, OVERLAY_KINDS))) {
    return { valid: false, reason: "invalid-layer-or-overlays" };
  }
  if (!isOneOf(value.bottomPanel, ["dialogue", "ocr-candidates", "issues"] as const) || !isOneOf(value.dialogueView, ["queue", "full"] as const)) {
    return { valid: false, reason: "invalid-panels" };
  }
  const currentIssue = parseIssue(value.currentIssue);
  const issueEditor = parseIssueEditor(value.issueEditor);
  const drafts = parseDrafts(value.drafts);
  if (currentIssue === undefined || !issueEditor || !drafts) return { valid: false, reason: "invalid-context" };
  const maxPage = Math.max(1, Math.floor(pageCount));
  const selectedLineId = value.selectedLineId === null
    ? null
    : isNonEmptyString(value.selectedLineId)
      ? value.selectedLineId
      : undefined;
  if (selectedLineId === undefined) return { valid: false, reason: "invalid-selection" };
  const safeSelectedLineId = options.lineIds && selectedLineId && !options.lineIds.has(selectedLineId) ? null : selectedLineId;
  const safeIssue = currentIssue && options.issueLineIds && !options.issueLineIds.has(currentIssue.lineId) ? null : currentIssue;
  const safeCurrentPage = Math.min(maxPage, Math.max(1, Math.floor(value.currentPage)));
  return {
    valid: true,
    snapshot: {
      version: WORKSPACE_SESSION_VERSION,
      lifecycle: value.lifecycle,
      savedAt: value.savedAt,
      project,
      currentPage: safeCurrentPage,
      pageCount: maxPage,
      viewport,
      comparison: {
        mode: value.comparison.mode,
        revealPosition: clampRevealPosition(value.comparison.revealPosition),
        opacity: clampComparisonOpacity(value.comparison.opacity)
      },
      resultLayer: value.resultLayer,
      visibleOverlays: [...new Set(value.visibleOverlays)] as OverlayKind[],
      workspacePanels: panels,
      bottomPanel: value.bottomPanel,
      dialogueView: value.dialogueView,
      selectedLineId: safeSelectedLineId,
      currentIssue: safeIssue,
      issueEditor,
      drafts
    }
  };
}

export function loadWorkspaceSession(storage: PreferenceStorage): WorkspaceSessionSnapshot | null {
  try {
    const serialized = storage.getItem(WORKSPACE_SESSION_STORAGE_KEY);
    if (!serialized) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== WORKSPACE_SESSION_VERSION) return null;
    return parsed as WorkspaceSessionSnapshot;
  } catch {
    return null;
  }
}

/** Return only the opaque Main-owned recent token; never a filesystem path. */
export function getWorkspaceSessionRecentProjectId(snapshot: WorkspaceSessionSnapshot | null): string | null {
  const recentProjectId = snapshot && isRecord(snapshot.project)
    ? snapshot.project.recentProjectId
    : null;
  return isNonEmptyString(recentProjectId) ? recentProjectId : null;
}

export function saveWorkspaceSession(storage: PreferenceStorage, snapshot: WorkspaceSessionSnapshot): void {
  try {
    storage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Renderer-only recovery must never block editing.
  }
}

export function markWorkspaceSessionClosed(storage: PreferenceStorage): boolean {
  const current = loadWorkspaceSession(storage);
  if (!current) return false;
  saveWorkspaceSession(storage, { ...current, lifecycle: "closed", savedAt: new Date().toISOString() });
  return true;
}
