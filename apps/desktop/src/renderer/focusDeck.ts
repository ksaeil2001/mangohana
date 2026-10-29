export type WorkspacePanelState = {
  pagesOpen: boolean;
  inspectorOpen: boolean;
  resultsOpen: boolean;
  focusMode: boolean;
  inspectorWidth: number;
};

// Kept for the standalone legacy component while the workspace no longer renders it.
export type DrawerDestination = "pages" | "context" | "settings";

export interface FocusDeckPreferences extends WorkspacePanelState {
  zoom: number;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const MIN_EDITOR_WIDTH = 320;
export const MAX_EDITOR_WIDTH = 520;
export const DEFAULT_INSPECTOR_WIDTH = 320;

export const clampEditorWidth = (value: number) =>
  Math.min(MAX_EDITOR_WIDTH, Math.max(MIN_EDITOR_WIDTH, Number.isFinite(value) ? value : DEFAULT_INSPECTOR_WIDTH));

export const getFocusDeckPreferenceKey = (projectKey: string) => `focus-deck:${projectKey || "unsaved"}`;

export const hasFocusDeckPreferences = (storage: PreferenceStorage, projectKey: string): boolean => {
  try {
    return storage.getItem(getFocusDeckPreferenceKey(projectKey)) !== null;
  } catch {
    return false;
  }
};

export const DEFAULT_WORKSPACE_PANELS: WorkspacePanelState = {
  pagesOpen: false,
  inspectorOpen: false,
  resultsOpen: false,
  focusMode: false,
  inspectorWidth: DEFAULT_INSPECTOR_WIDTH
};

const DEFAULT_PREFERENCES: FocusDeckPreferences = {
  ...DEFAULT_WORKSPACE_PANELS,
  zoom: 1
};

const booleanOr = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;

export const loadFocusDeckPreferences = (
  storage: PreferenceStorage,
  projectKey: string
): FocusDeckPreferences => {
  try {
    const stored = storage.getItem(getFocusDeckPreferenceKey(projectKey));
    if (stored === null) return { ...DEFAULT_PREFERENCES };

    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_PREFERENCES };

    const preferences = parsed as Record<string, unknown>;
    const storedWidth = typeof preferences.inspectorWidth === "number"
      ? preferences.inspectorWidth
      : preferences.editorWidth;
    const inspectorWidth = typeof storedWidth === "number"
      ? clampEditorWidth(storedWidth)
      : DEFAULT_INSPECTOR_WIDTH;
    const zoom = typeof preferences.zoom === "number" && Number.isFinite(preferences.zoom) && preferences.zoom > 0
      ? preferences.zoom
      : 1;

    return {
      pagesOpen: booleanOr(preferences.pagesOpen, DEFAULT_WORKSPACE_PANELS.pagesOpen),
      inspectorOpen: booleanOr(preferences.inspectorOpen, DEFAULT_WORKSPACE_PANELS.inspectorOpen),
      resultsOpen: booleanOr(preferences.resultsOpen, DEFAULT_WORKSPACE_PANELS.resultsOpen),
      focusMode: booleanOr(preferences.focusMode, DEFAULT_WORKSPACE_PANELS.focusMode),
      inspectorWidth,
      zoom
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
};

export const saveFocusDeckPreferences = (
  storage: PreferenceStorage,
  projectKey: string,
  preferences: FocusDeckPreferences
): void => {
  try {
    storage.setItem(getFocusDeckPreferenceKey(projectKey), JSON.stringify(preferences));
  } catch {
    // UI preferences must never block editing.
  }
};
