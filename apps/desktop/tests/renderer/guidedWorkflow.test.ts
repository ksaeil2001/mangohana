import { describe, expect, it } from "vitest";
import type { DialogueLine, LineStatus } from "../../src/shared/projectTypes";
import {
  getGuidedStage,
  getNextActionableLineId,
  getQueueWindow
} from "../../src/renderer/guidedWorkflow";

function dialogueLine(id: string, order: number, lineStatus: LineStatus = "untranslated", pageNumber = 1): DialogueLine {
  return {
    id,
    order,
    pageNumber,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: `source-${id}`,
    lineStatus,
    parseConfidence: 0.95,
    parseWarnings: []
  };
}

describe("guided workflow", () => {
  it("derives OCR, speaker, translation, and complete stages", () => {
    expect(getGuidedStage({ hasReview: true, reviewStage: "ocr", hasSelectedLine: false })).toBe("ocr");
    expect(getGuidedStage({ hasReview: true, reviewStage: "speaker", hasSelectedLine: true })).toBe("speaker");
    expect(getGuidedStage({ hasReview: false, reviewStage: "ocr", hasSelectedLine: true })).toBe("translation");
    expect(getGuidedStage({ hasReview: false, reviewStage: "ocr", hasSelectedLine: false })).toBe("complete");
  });

  it("selects the next incomplete line on the same page and wraps once", () => {
    const lines = [
      dialogueLine("a", 1, "untranslated"),
      dialogueLine("b", 2, "complete"),
      dialogueLine("c", 3, "review")
    ];

    expect(getNextActionableLineId(lines, "a", 1)).toBe("c");
    expect(getNextActionableLineId(lines, "c", 1)).toBe("a");
  });

  it("does not select lines from another page", () => {
    const lines = [dialogueLine("page-1", 1, "complete", 1), dialogueLine("page-2", 2, "review", 2)];
    expect(getNextActionableLineId(lines, "page-1", 1)).toBeNull();
  });

  it("returns a centered five-line window when possible", () => {
    const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((order) => dialogueLine(String(order), order));
    expect(getQueueWindow(lines, "1").map((line) => line.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(getQueueWindow(lines, "5").map((line) => line.id)).toEqual(["3", "4", "5", "6", "7"]);
    expect(getQueueWindow(lines, "10").map((line) => line.id)).toEqual(["6", "7", "8", "9", "10"]);
  });

  it("returns fewer than five lines unchanged", () => {
    const lines = [1, 2, 3, 4].map((order) => dialogueLine(String(order), order));
    expect(getQueueWindow(lines, "3")).toEqual(lines);
  });

  it("returns the first five lines when the selection is absent", () => {
    const lines = [1, 2, 3, 4, 5, 6].map((order) => dialogueLine(String(order), order));
    expect(getQueueWindow(lines, null).map((line) => line.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("sorts a copy by line order before returning a contiguous window", () => {
    const lines = [
      dialogueLine("seven", 7),
      dialogueLine("two", 2),
      dialogueLine("five-first", 5),
      dialogueLine("one", 1),
      dialogueLine("six", 6),
      dialogueLine("three", 3),
      dialogueLine("five-second", 5),
      dialogueLine("four", 4)
    ];
    const originalIds = lines.map((line) => line.id);

    expect(getQueueWindow(lines, "five-first").map((line) => line.id)).toEqual([
      "three",
      "four",
      "five-first",
      "five-second",
      "six"
    ]);
    expect(lines.map((line) => line.id)).toEqual(originalIds);
  });

  it("does not leak lines outside page-filtered input", () => {
    const lines = [
      dialogueLine("page-1-a", 1, "untranslated", 1),
      dialogueLine("page-1-b", 2, "untranslated", 1),
      dialogueLine("page-2", 3, "untranslated", 2)
    ];
    const pageLines = lines.filter((line) => line.pageNumber === 1);

    expect(getQueueWindow(pageLines, "page-2").map((line) => line.id)).toEqual(["page-1-a", "page-1-b"]);
  });
});
