import { describe, expect, it } from "vitest";
import {
  createInitialIssueEditorState,
  getIssueEditorMismatch,
  issueEditorReducer,
  loadIssueEditorPreference,
  saveIssueEditorPreference,
  type IssueEditorState
} from "../../src/renderer/issueEditorState";

describe("issue editor state", () => {
  it("syncs the active editor only after a confirmed issue", () => {
    const initial = createInitialIssueEditorState();
    const next = issueEditorReducer(initial, { type: "issue-confirmed", requiredEditor: "ocr" });
    expect(next).toEqual({ activeEditor: "ocr", pinned: false, requiredEditor: "ocr" });
  });

  it("keeps a pinned editor while exposing a required editor mismatch", () => {
    const pinned = issueEditorReducer(
      { activeEditor: "translation", pinned: true, requiredEditor: "translation" },
      { type: "issue-confirmed", requiredEditor: "speaker" }
    );
    expect(pinned.activeEditor).toBe("translation");
    expect(getIssueEditorMismatch(pinned)).toEqual({ activeEditor: "translation", requiredEditor: "speaker" });
  });

  it("unpins and immediately synchronizes to the current issue", () => {
    const pinned: IssueEditorState = { activeEditor: "ocr", pinned: true, requiredEditor: "translation" };
    expect(issueEditorReducer(pinned, { type: "set-pinned", pinned: false })).toEqual({
      activeEditor: "translation",
      pinned: false,
      requiredEditor: "translation"
    });
  });

  it("switches to the required editor only through an explicit action", () => {
    const pinned: IssueEditorState = { activeEditor: "ocr", pinned: true, requiredEditor: "speaker" };
    expect(issueEditorReducer(pinned, { type: "switch-to-required" })).toEqual({
      activeEditor: "speaker",
      pinned: true,
      requiredEditor: "speaker"
    });
  });

  it("preserves the exact state when navigation fails", () => {
    const before: IssueEditorState = { activeEditor: "speaker", pinned: true, requiredEditor: "translation" };
    const after = issueEditorReducer(before, { type: "navigation-failed" });
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });

  it("normalizes a pinned preference without an active editor", () => {
    const hydrated = issueEditorReducer(createInitialIssueEditorState(), {
      type: "hydrate",
      activeEditor: null,
      pinned: true
    });
    expect(hydrated).toEqual({ activeEditor: null, pinned: false, requiredEditor: null });

    const recovered = issueEditorReducer(hydrated, {
      type: "issue-confirmed",
      requiredEditor: "speaker"
    });
    expect(recovered).toEqual({ activeEditor: "speaker", pinned: false, requiredEditor: "speaker" });
  });
});

describe("issue editor preference", () => {
  it("round trips a project-scoped pin and editor", () => {
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); }
    } as unknown as Storage;
    saveIssueEditorPreference(fakeStorage, "project-a", { activeEditor: "speaker", pinned: true });
    expect(loadIssueEditorPreference(fakeStorage, "project-a")).toEqual({ activeEditor: "speaker", pinned: true });
    expect(loadIssueEditorPreference(fakeStorage, "project-b")).toBeNull();
  });

  it("rejects corrupt, foreign, and invalid editor preference data", () => {
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); }
    } as unknown as Storage;
    storage.set("trio.issue-editor-preferences.v1", "not-json");
    expect(loadIssueEditorPreference(fakeStorage, "project-a")).toBeNull();
    storage.set("trio.issue-editor-preferences.v1", JSON.stringify({ version: 1, entries: { "project-a": { activeEditor: "bad", pinned: true } } }));
    expect(loadIssueEditorPreference(fakeStorage, "project-a")).toBeNull();
    storage.set("trio.issue-editor-preferences.v1", JSON.stringify({ version: 1, entries: { "project-other": { activeEditor: "ocr", pinned: true } } }));
    expect(loadIssueEditorPreference(fakeStorage, "project-a")).toBeNull();
  });

  it("normalizes a persisted null active editor even when pin is true", () => {
    const storage = new Map<string, string>([
      ["trio.issue-editor-preferences.v1", JSON.stringify({ version: 1, entries: { "project-a": { activeEditor: null, pinned: true } } })]
    ]);
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); }
    } as unknown as Storage;
    expect(loadIssueEditorPreference(fakeStorage, "project-a")).toEqual({ activeEditor: null, pinned: false });
    saveIssueEditorPreference(fakeStorage, "project-a", { activeEditor: null, pinned: true });
    expect(JSON.parse(storage.get("trio.issue-editor-preferences.v1") ?? "{}").entries["project-a"]).toEqual({ activeEditor: null, pinned: false });
  });
});
