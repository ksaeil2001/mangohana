import { describe, expect, it } from "vitest";
import {
  clearTranslationDraft,
  loadTranslationDraft,
  saveTranslationDraft,
  type TranslationDraftScope
} from "../../src/renderer/translationDrafts";

function createStorage(initial?: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

const scope: TranslationDraftScope = {
  projectId: "project-1",
  projectRevision: 7,
  lineId: "line-1",
  sourceIdentity: "source-fingerprint-1"
};

describe("translation drafts", () => {
  it("round-trips an immediately persisted project/line/source-scoped draft", () => {
    const storage = createStorage();
    saveTranslationDraft(storage, scope, "임시 번역");
    expect(loadTranslationDraft(storage, scope)).toEqual("임시 번역");
    expect(storage.getItem("trio.translation-drafts.v1")).not.toContain("C:\\");
  });

  it("rejects corrupt, foreign, stale, empty, and confirmed-line drafts", () => {
    const storage = createStorage({ "trio.translation-drafts.v1": "not-json" });
    expect(loadTranslationDraft(storage, scope)).toBeNull();
    storage.setItem("trio.translation-drafts.v1", JSON.stringify({
      version: 1,
      entries: {
        "project-foreign|line-1": { projectId: "project-foreign", projectRevision: 7, lineId: "line-1", sourceIdentity: scope.sourceIdentity, text: "foreign" },
        "project-1|line-1": { projectId: "project-1", projectRevision: 6, lineId: "line-1", sourceIdentity: scope.sourceIdentity, text: "stale" }
      }
    }));
    expect(loadTranslationDraft(storage, scope)).toBeNull();
    saveTranslationDraft(storage, scope, "valid");
    expect(loadTranslationDraft(storage, { ...scope, sourceIdentity: "different" })).toBeNull();
    expect(loadTranslationDraft(storage, { ...scope, lineStatus: "complete" })).toBeNull();
  });

  it("clears only one line and tolerates storage failures", () => {
    const storage = createStorage();
    saveTranslationDraft(storage, scope, "one");
    saveTranslationDraft(storage, { ...scope, lineId: "line-2" }, "two");
    clearTranslationDraft(storage, scope);
    expect(loadTranslationDraft(storage, scope)).toBeNull();
    expect(loadTranslationDraft(storage, { ...scope, lineId: "line-2" })).toBe("two");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(() => saveTranslationDraft(broken, scope, "safe")).not.toThrow();
    expect(() => clearTranslationDraft(broken, scope)).not.toThrow();
  });
});
