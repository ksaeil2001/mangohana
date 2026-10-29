import { describe, expect, it } from "vitest";
import { extractGlossaryFromCorpus } from "../../src/main/glossaryExtraction.js";
import type { DialogueLine } from "../../src/shared/projectTypes.js";

describe("glossaryExtraction", () => {
  it("returns empty result when dialogueLines are empty", async () => {
    const result = await extractGlossaryFromCorpus({ dialogueLines: [] });
    expect(result.terms).toEqual([]);
    expect(result.characters).toEqual([]);
    expect(result.corpusStats.totalDialogueLines).toBe(0);
  });

  it("extracts speaker characters and bracketed terms via rule-based fallback", async () => {
    const sampleLines: DialogueLine[] = [
      {
        id: "l1",
        order: 1,
        pageNumber: 1,
        speaker: "세실",
        sourceText: "くらえ！『月華一閃』！",
        dialogueType: "speech",
        sourceLanguage: "ja",
        parseConfidence: 0.95,
        parseWarnings: []
      },
      {
        id: "l2",
        order: 2,
        pageNumber: 1,
        speaker: "세실",
        sourceText: "これでおしまいじゃのう。",
        dialogueType: "speech",
        sourceLanguage: "ja",
        parseConfidence: 0.9,
        parseWarnings: []
      },
      {
        id: "l3",
        order: 3,
        pageNumber: 2,
        speaker: "야토",
        sourceText: "『月華一閃』を防ぐとは…",
        dialogueType: "speech",
        sourceLanguage: "ja",
        parseConfidence: 0.95,
        parseWarnings: []
      },
      {
        id: "l4",
        order: 4,
        pageNumber: 2,
        speaker: "세실",
        sourceText: "まだまだじゃのう！",
        dialogueType: "speech",
        sourceLanguage: "ja",
        parseConfidence: 0.9,
        parseWarnings: []
      }
    ];

    const result = await extractGlossaryFromCorpus({ dialogueLines: sampleLines });

    // Should extract character '세실' who appeared 3 times
    const cecilChar = result.characters.find((c) => c.nameJa === "세실" || c.nameKo === "세실");
    expect(cecilChar).toBeDefined();

    // Should extract bracketed term '月華一閃'
    const skillTerm = result.terms.find((t) => t.source === "月華一閃");
    expect(skillTerm).toBeDefined();
    expect(skillTerm!.occurrenceCount).toBe(2);

    // Should extract tone pattern '〜じゃのう'
    const toneTerm = result.terms.find((t) => t.source === "〜じゃのう");
    expect(toneTerm).toBeDefined();
    expect(toneTerm!.category).toBe("tone");

    expect(result.corpusStats.totalDialogueLines).toBe(4);
  });
});
