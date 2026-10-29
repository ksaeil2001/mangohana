import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SESSION_STORAGE_KEY,
  createWorkspaceSessionSnapshot,
  getWorkspaceSessionRecentProjectId,
  loadWorkspaceSession,
  markWorkspaceSessionClosed,
  saveWorkspaceSession,
  validateWorkspaceSession,
  type WorkspaceSessionIdentity
} from "../../src/renderer/workspaceSession";
import { createImageViewportState } from "../../src/renderer/imageViewport";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    values
  };
}

const identity: WorkspaceSessionIdentity = {
  projectId: "project-a",
  projectKey: "session:abc",
  recentProjectId: "recent-a",
  revision: 3
};

function snapshot(overrides: Partial<Parameters<typeof createWorkspaceSessionSnapshot>[0]> = {}) {
  return createWorkspaceSessionSnapshot({
    identity,
    currentPage: 2,
    pageCount: 4,
    viewport: {
      ...createImageViewportState(),
      viewMode: "actual",
      zoom: 2,
      pan: { x: 13, y: 29 },
      layers: { ...createImageViewportState().layers, ocr: false }
    },
    comparison: { mode: "reveal", revealPosition: 68, opacity: 0.4 },
    resultLayer: "translated",
    visibleOverlays: ["ocr", "issue"],
    workspacePanels: {
      pagesOpen: false,
      inspectorOpen: true,
      resultsOpen: false,
      focusMode: true,
      inspectorWidth: 444
    },
    bottomPanel: "issues",
    dialogueView: "full",
    selectedLineId: "line-2",
    currentIssue: { lineId: "line-2", kind: "translation", editor: "translation" },
    issueEditor: { activeEditor: "translation", pinned: true },
    ...overrides
  });
}

describe("workspaceSession", () => {
  it("round trips a versioned snapshot without storing transient hold state", () => {
    const storage = createStorage();
    const saved = snapshot();
    saveWorkspaceSession(storage, saved);

    expect(storage.values.has(WORKSPACE_SESSION_STORAGE_KEY)).toBe(true);
    const loaded = loadWorkspaceSession(storage);
    expect(loaded).toEqual(saved);
    expect(loaded?.comparison).not.toHaveProperty("holdingOriginal");
  });

  it("accepts an active snapshot and a normally closed snapshot for the same identity", () => {
    const active = snapshot();
    expect(validateWorkspaceSession(active, identity, 4)).toMatchObject({ valid: true, snapshot: active });

    const storage = createStorage();
    saveWorkspaceSession(storage, active);
    expect(markWorkspaceSessionClosed(storage)).toBe(true);
    const closed = loadWorkspaceSession(storage);
    expect(closed?.lifecycle).toBe("closed");
    expect(validateWorkspaceSession(closed, identity, 4)).toMatchObject({ valid: true });
  });

  it("rejects corrupt, wrong-version, foreign and outdated snapshots", () => {
    const malformed = [
      null,
      { version: 99 },
      { ...snapshot(), project: { ...identity, revision: 2 } },
      { ...snapshot(), project: { ...identity, projectId: "foreign" } },
      { ...snapshot(), project: { ...identity, projectKey: "other-session" } },
      { ...snapshot(), project: { ...identity, recentProjectId: "other-recent" } },
      { ...snapshot(), currentPage: 0 },
      { ...snapshot(), viewport: { ...snapshot().viewport, zoom: Number.NaN } },
      { ...snapshot(), comparison: { mode: "unknown", revealPosition: 50, opacity: 0.5 } }
    ];

    for (const candidate of malformed) {
      expect(validateWorkspaceSession(candidate, identity, 4).valid).toBe(false);
    }
  });

  it("clamps safe numeric values but rejects non-finite values", () => {
    const source = snapshot({
      currentPage: 99,
      viewport: { ...snapshot().viewport, zoom: 99, pan: { x: -10, y: 200 } },
      comparison: { mode: "opacity", revealPosition: 200, opacity: -2 },
      workspacePanels: { ...snapshot().workspacePanels, inspectorWidth: 999 }
    });
    const validation = validateWorkspaceSession(source, identity, 4);
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.snapshot.currentPage).toBe(4);
      expect(validation.snapshot.viewport.zoom).toBe(4);
      expect(validation.snapshot.viewport.pan).toEqual({ x: 0, y: 200 });
      expect(validation.snapshot.comparison.revealPosition).toBe(100);
      expect(validation.snapshot.comparison.opacity).toBe(0);
      expect(validation.snapshot.workspacePanels.inspectorWidth).toBe(520);
    }
  });

  it("does not restore a selected line or issue that is missing from the project", () => {
    const candidate = snapshot();
    const validation = validateWorkspaceSession(candidate, identity, 4, {
      lineIds: new Set(["other-line"]),
      issueLineIds: new Set(["other-line"])
    });
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.snapshot.selectedLineId).toBeNull();
      expect(validation.snapshot.currentIssue).toBeNull();
    }
  });

  it("treats a corrupt versioned envelope without a project as having no recent project", () => {
    const storage = createStorage({
      [WORKSPACE_SESSION_STORAGE_KEY]: JSON.stringify({ version: 1 })
    });
    const loaded = loadWorkspaceSession(storage);
    expect(() => getWorkspaceSessionRecentProjectId(loaded)).not.toThrow();
    expect(getWorkspaceSessionRecentProjectId(loaded)).toBeNull();
  });
});
