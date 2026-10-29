import { describe, expect, it } from "vitest";
import {
  clearTypesettingDraft,
  loadTypesettingDraft,
  saveTypesettingDraft,
  type TypesettingDraftScope
} from "../../src/renderer/typesettingDrafts";
import type { TypesettingDraft } from "../../src/renderer/typesettingGeometry";

function createMemoryStorage(initial?: Record<string, string>): Storage {
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

const scope: TypesettingDraftScope = {
  projectId: "project-1",
  pageImageId: "page-1",
  sourceOcrId: "ocr-1"
};
const draft: TypesettingDraft = {
  id: "draft-1",
  sourceOcrId: "ocr-1",
  bbox: { x: 0.2, y: 0.3, width: 0.25, height: 0.1 },
  rotationDegrees: 12,
  writingMode: "horizontal-tb"
};

describe("typesettingDrafts", () => {
  it("round-trips a renderer-only draft under project/page/OCR identity", () => {
    const storage = createMemoryStorage();
    saveTypesettingDraft(storage, scope, draft);
    expect(loadTypesettingDraft(storage, scope)).toEqual(draft);
    expect(storage.getItem("trio.typesetting-drafts.v1")).not.toContain("C:\\");
    expect(storage.getItem("trio.typesetting-drafts.v1")).not.toContain("/");
  });

  it("round-trips a vertical-rl writingMode draft properly", () => {
    const storage = createMemoryStorage();
    const verticalDraft: TypesettingDraft = {
      ...draft,
      id: "draft-v1",
      writingMode: "vertical-rl"
    };
    saveTypesettingDraft(storage, scope, verticalDraft);
    expect(loadTypesettingDraft(storage, scope)).toEqual(verticalDraft);
  });

  it("rejects corrupt, old-version, foreign, malformed and out-of-range data", () => {
    const storage = createMemoryStorage({ "trio.typesetting-drafts.v1": "not json" });
    expect(loadTypesettingDraft(storage, scope)).toBeNull();
    storage.setItem("trio.typesetting-drafts.v1", JSON.stringify({ version: 0, entries: {} }));
    expect(loadTypesettingDraft(storage, scope)).toBeNull();
    storage.setItem("trio.typesetting-drafts.v1", JSON.stringify({
      version: 1,
      entries: {
        "project-foreign|page-1|ocr-1": draft,
        "project-1|page-1|ocr-1": { ...draft, bbox: { x: 2, y: 0, width: 1, height: 1 } }
      }
    }));
    expect(loadTypesettingDraft(storage, scope)).toBeNull();
    expect(loadTypesettingDraft(storage, { ...scope, projectId: "project-foreign" })).toBeNull();
  });

  it("rejects persisted zero and sub-minimum geometry instead of restoring an invisible box", () => {
    const storage = createMemoryStorage();
    saveTypesettingDraft(storage, scope, draft);
    const serialized = storage.getItem("trio.typesetting-drafts.v1");
    if (!serialized) throw new Error("expected persisted draft envelope");
    const envelope = JSON.parse(serialized) as { entries: Record<string, { draft: TypesettingDraft }> };
    const key = "project-1|page-1|ocr-1";
    for (const size of [0, 0.019]) {
      envelope.entries[key] = {
        ...envelope.entries[key],
        draft: { ...draft, bbox: { x: 0.2, y: 0.3, width: size, height: 0.1 } }
      };
      storage.setItem("trio.typesetting-drafts.v1", JSON.stringify(envelope));
      expect(loadTypesettingDraft(storage, scope)).toBeNull();
    }
  });

  it("clears only the scoped draft and tolerates storage failures", () => {
    const storage = createMemoryStorage();
    saveTypesettingDraft(storage, scope, draft);
    saveTypesettingDraft(storage, { ...scope, sourceOcrId: "ocr-2" }, { ...draft, id: "draft-2", sourceOcrId: "ocr-2" });
    clearTypesettingDraft(storage, scope);
    expect(loadTypesettingDraft(storage, scope)).toBeNull();
    expect(loadTypesettingDraft(storage, { ...scope, sourceOcrId: "ocr-2" })).not.toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(() => saveTypesettingDraft(broken, scope, draft)).not.toThrow();
    expect(() => clearTypesettingDraft(broken, scope)).not.toThrow();
  });
});
