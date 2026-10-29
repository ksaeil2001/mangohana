import { describe, expect, it } from "vitest";
import type { DialogueLine } from "../../src/shared/projectTypes";
import {
  ISSUE_NAVIGATION_RULES,
  classifyIssueKind,
  getIssueLineItems,
  getIssueReasons,
  prepareIssueNavigation,
  commitOrRollbackIssueNavigation,
  type IssueNavigationState
} from "../../src/renderer/issueNavigation";

function line(overrides: Partial<DialogueLine> = {}): DialogueLine {
  return {
    id: "line-1",
    order: 1,
    pageNumber: 1,
    speaker: "Mika",
    dialogueType: "speech",
    sourceLanguage: "en",
    sourceText: "Hello",
    lineStatus: "untranslated",
    parseConfidence: 0.98,
    parseWarnings: [],
    ...overrides
  };
}

describe("issue navigation mapping", () => {
  it("keeps an explicit data-table priority for every issue kind", () => {
    expect(ISSUE_NAVIGATION_RULES.map((rule) => rule.kind)).toEqual([
      "ocr",
      "speaker",
      "translation",
      "review"
    ]);
  });

  it("maps OCR confidence and parse warnings to the OCR editor and overlays", () => {
    const target = prepareIssueNavigation(line({
      parseConfidence: 0.5,
      parseWarnings: ["low resolution"]
    }));
    expect(target?.kind).toBe("ocr");
    expect(target?.editor).toBe("ocr");
    expect(target?.requiredOverlays).toEqual(["ocr", "balloon", "issue"]);
    expect(getIssueReasons(line({ parseConfidence: 0.5, parseWarnings: ["low resolution"] }))).toEqual([
      "low resolution",
      "OCR confidence is low",
      "사용자 수정문 없음"
    ]);
  });

  it("maps missing and unknown speakers to the speaker editor", () => {
    expect(classifyIssueKind(line({ speaker: "" }))).toBe("speaker");
    expect(classifyIssueKind(line({ speaker: "unknown" }))).toBe("speaker");
    expect(prepareIssueNavigation(line({ speaker: "" }))?.requiredOverlays).toEqual([
      "balloon",
      "issue"
    ]);
  });

  it("maps missing user translation to translation editor", () => {
    const target = prepareIssueNavigation(line({ lineStatus: "draft", userTranslation: "" }));
    expect(target?.kind).toBe("translation");
    expect(target?.editor).toBe("translation");
    expect(target?.requiredOverlays).toEqual(["safe-area", "typeset", "issue"]);
  });

  it("keeps a saved translation draft in review until explicit confirmation", () => {
    const candidate = line({ userTranslation: "고친 번역", lineStatus: "draft" });
    expect(getIssueLineItems([candidate])).toHaveLength(1);
    expect(prepareIssueNavigation(candidate)?.editor).toBe("translation");
    expect(getIssueReasons(candidate)).toEqual(["번역 검수 미확정"]);
    expect(getIssueLineItems([{ ...candidate, lineStatus: "complete" }])).toHaveLength(0);
  });

  it("treats a whitespace-only user translation as missing in both mapping and reasons", () => {
    const candidate = line({ lineStatus: "draft", userTranslation: "   " });
    expect(classifyIssueKind(candidate)).toBe("translation");
    expect(getIssueReasons(candidate)).toContain("사용자 수정문 없음");
  });

  it("uses review fallback and preserves all reasons for a multi-reason line", () => {
    const target = prepareIssueNavigation(line({
      lineStatus: "review",
      userTranslation: "done"
    }));
    expect(target?.kind).toBe("review");
    expect(target?.editor).toBe("translation");
    expect(target?.requiredOverlays).toEqual(["issue"]);
    expect(target?.reasons).toContain("검토필요");
    expect(getIssueLineItems([target!.line])).toHaveLength(1);
  });

  it("rejects an invalid target without changing state", () => {
    expect(prepareIssueNavigation(line({ id: "" }))).toBeNull();
    expect(prepareIssueNavigation(line({ pageNumber: 0 }))).toBeNull();
  });
});

describe("issue navigation transaction", () => {
  const previous: IssueNavigationState = {
    currentIssueId: "old",
    currentPage: 1,
    selectedLineId: "old-line",
    editor: "speaker",
    visibleOverlayKinds: ["ocr"],
    viewport: {
      viewMode: "actual",
      zoom: 1.8,
      pan: { x: 30, y: 40 },
      layers: { original: true, ocr: true, sourceText: false, translation: false, final: false }
    }
  };

  it("commits all navigation fields atomically and preserves user overlay visibility", () => {
    const target = prepareIssueNavigation(line({ id: "next", pageNumber: 2, speaker: "" }))!;
    const next = commitOrRollbackIssueNavigation(previous, target, { ok: true });
    expect(next).toMatchObject({
      currentIssueId: "next",
      currentPage: 2,
      selectedLineId: "next",
      editor: "speaker",
      visibleOverlayKinds: ["ocr", "balloon", "issue"]
    });
  });

  it("rolls every field back when page render fails", () => {
    const target = prepareIssueNavigation(line({ id: "next", pageNumber: 2 }))!;
    const next = commitOrRollbackIssueNavigation(previous, target, { ok: false });
    expect(next).toEqual(previous);
  });

  it("ignores stale transaction results", () => {
    const target = prepareIssueNavigation(line({ id: "next" }))!;
    const next = commitOrRollbackIssueNavigation(previous, target, {
      ok: true,
      transactionId: "new",
      expectedTransactionId: "old"
    });
    expect(next).toEqual(previous);
  });
});
