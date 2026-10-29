export type IssueEditor = "ocr" | "speaker" | "translation";

export type IssueEditorState = {
  activeEditor: IssueEditor | null;
  pinned: boolean;
  requiredEditor: IssueEditor | null;
};

export type IssueEditorEvent =
  | { type: "hydrate"; activeEditor?: IssueEditor | null; pinned?: boolean }
  | { type: "issue-confirmed"; requiredEditor: IssueEditor | null }
  | { type: "toggle-pin" }
  | { type: "set-pinned"; pinned: boolean }
  | { type: "unpin-sync" }
  | { type: "switch-to-required" }
  | { type: "navigation-failed" };

export const ISSUE_EDITOR_PREFERENCE_KEY = "trio.issue-editor-preferences.v1";
const ISSUE_EDITOR_PREFERENCE_VERSION = 1;

export function createInitialIssueEditorState(): IssueEditorState {
  return { activeEditor: null, pinned: false, requiredEditor: null };
}

export function issueEditorReducer(
  state: IssueEditorState,
  event: IssueEditorEvent
): IssueEditorState {
  if (event.type === "hydrate") {
    const activeEditor = isIssueEditor(event.activeEditor) ? event.activeEditor : null;
    return {
      activeEditor,
      pinned: event.pinned === true && activeEditor !== null,
      requiredEditor: state.requiredEditor
    };
  }

  if (event.type === "issue-confirmed") {
    const canPreservePin = state.pinned && state.activeEditor !== null;
    return {
      activeEditor: canPreservePin
        ? state.activeEditor
        : event.requiredEditor,
      pinned: canPreservePin,
      requiredEditor: event.requiredEditor
    };
  }

  if (event.type === "toggle-pin") {
    const pinned = !state.pinned && state.activeEditor !== null;
    return {
      activeEditor: pinned ? state.activeEditor : state.requiredEditor,
      pinned,
      requiredEditor: state.requiredEditor
    };
  }

  if (event.type === "set-pinned") {
    const pinned = event.pinned && state.activeEditor !== null;
    return {
      activeEditor: pinned ? state.activeEditor : state.requiredEditor,
      pinned,
      requiredEditor: state.requiredEditor
    };
  }

  if (event.type === "unpin-sync") {
    return {
      activeEditor: state.requiredEditor,
      pinned: false,
      requiredEditor: state.requiredEditor
    };
  }

  if (event.type === "switch-to-required") {
    return {
      activeEditor: state.requiredEditor,
      pinned: state.pinned,
      requiredEditor: state.requiredEditor
    };
  }

  // A failed navigation must not alter the editor or pin context. Return a
  // fresh object so consumers can safely use identity to observe a handled
  // transaction without mutating the prior snapshot.
  return { ...state };
}

export function getIssueEditorMismatch(
  state: IssueEditorState
): { activeEditor: IssueEditor; requiredEditor: IssueEditor } | null {
  if (
    !state.pinned ||
    !state.activeEditor ||
    !state.requiredEditor ||
    state.activeEditor === state.requiredEditor
  ) {
    return null;
  }
  return { activeEditor: state.activeEditor, requiredEditor: state.requiredEditor };
}

type IssueEditorPreference = {
  activeEditor: IssueEditor | null;
  pinned: boolean;
};

type IssueEditorPreferenceEnvelope = {
  version: number;
  entries: Record<string, IssueEditorPreference>;
};

export function loadIssueEditorPreference(
  storage: Pick<Storage, "getItem">,
  projectKey: string
): IssueEditorPreference | null {
  if (!isSafeProjectKey(projectKey)) return null;
  try {
    const raw = storage.getItem(ISSUE_EDITOR_PREFERENCE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPreferenceEnvelope(parsed)) return null;
    const entry = parsed.entries[projectKey];
    if (!isPreference(entry)) return null;
    return normalizePreference(entry);
  } catch {
    return null;
  }
}

export function saveIssueEditorPreference(
  storage: Pick<Storage, "getItem" | "setItem">,
  projectKey: string,
  preference: IssueEditorPreference
): void {
  if (!isSafeProjectKey(projectKey) || !isPreference(preference)) return;
  try {
    let envelope: IssueEditorPreferenceEnvelope = {
      version: ISSUE_EDITOR_PREFERENCE_VERSION,
      entries: {}
    };
    const raw = storage.getItem(ISSUE_EDITOR_PREFERENCE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isPreferenceEnvelope(parsed)) envelope = parsed;
    }
    envelope.entries[projectKey] = normalizePreference(preference);
    storage.setItem(ISSUE_EDITOR_PREFERENCE_KEY, JSON.stringify(envelope));
  } catch {
    // Renderer preferences are best effort and must never block editing.
  }
}

function isIssueEditor(value: unknown): value is IssueEditor {
  return value === "ocr" || value === "speaker" || value === "translation";
}

function isSafeProjectKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function isPreference(value: unknown): value is IssueEditorPreference {
  return Boolean(
    value &&
    typeof value === "object" &&
    "pinned" in value &&
    typeof (value as { pinned?: unknown }).pinned === "boolean" &&
    ("activeEditor" in value ? ((value as { activeEditor?: unknown }).activeEditor === null || isIssueEditor((value as { activeEditor?: unknown }).activeEditor)) : false)
  );
}

function normalizePreference(preference: IssueEditorPreference): IssueEditorPreference {
  return {
    activeEditor: preference.activeEditor,
    pinned: preference.pinned && preference.activeEditor !== null
  };
}

function isPreferenceEnvelope(value: unknown): value is IssueEditorPreferenceEnvelope {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { version?: unknown }).version === ISSUE_EDITOR_PREFERENCE_VERSION &&
    (value as { entries?: unknown }).entries &&
    typeof (value as { entries?: unknown }).entries === "object"
  );
}

export type { IssueEditorPreference };
