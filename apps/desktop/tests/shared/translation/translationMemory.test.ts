import { describe, expect, it } from "vitest";
import type { DialogueLine } from "../../../src/shared/projectTypes";
import { createTranslationMemory } from "../../../src/shared/translation/translationMemory";

const mockLines: DialogueLine[] = [
  {
    id: "line-1",
    order: 1,
    pageNumber: 1,
    speaker: "루피",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "海賊王に俺はなる！",
    userTranslation: "해적왕이 내가 될 거야!",
    parseConfidence: 0.95,
    parseWarnings: []
  },
  {
    id: "line-2",
    order: 2,
    pageNumber: 1,
    speaker: "조로",
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "くそっ、間に合わないか…",
    userTranslation: "젠장, 늦은 건가…",
    parseConfidence: 0.9,
    parseWarnings: []
  }
];

describe("translationMemory", () => {
  it("indexes confirmed dialogue lines and finds exact match instantly", () => {
    const tm = createTranslationMemory(mockLines);
    const exact = tm.findExact("海賊王に俺はなる！");

    expect(exact).toBeDefined();
    expect(exact?.targetTranslation).toBe("해적왕이 내가 될 거야!");
  });

  it("finds fuzzy matches for similar expressions", () => {
    const tm = createTranslationMemory(mockLines);
    const fuzzy = tm.findFuzzy("くそっ、間に合わない！", { minSimilarity: 0.7 });

    expect(fuzzy.length).toBeGreaterThan(0);
    expect(fuzzy[0]?.entry.targetTranslation).toBe("젠장, 늦은 건가…");
    expect(fuzzy[0]?.similarity).toBeGreaterThan(0.7);
  });

  it("excludes current line from fuzzy match candidates", () => {
    const tm = createTranslationMemory(mockLines);
    const fuzzy = tm.findFuzzy("海賊王に俺はなる！", { excludeLineId: "line-1" });

    expect(fuzzy.find((f) => f.entry.id === "line-1")).toBeUndefined();
  });
});
