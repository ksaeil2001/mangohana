import { describe, expect, it } from "vitest";
import { formatTranslationTxt } from "../../src/shared/exportTranslations";
import { createEmptyProject } from "../../src/shared/projectValidation";

describe("formatTranslationTxt", () => {
  it("exports final dialogue text while preferring user edits over drafts", () => {
    const project = createEmptyProject("Export Demo", false);
    project.dialogueLines.push(
      {
        id: "line-user",
        order: 2,
        pageNumber: 1,
        speaker: "Mika",
        position: "Panel 3",
        dialogueType: "speech",
        sourceLanguage: "en",
        sourceText: "Source one",
        referenceTranslation: "Reference one",
        aiTranslation: "AI one",
        userTranslation: "User one",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      },
      {
        id: "line-ai",
        order: 1,
        pageNumber: 1,
        dialogueType: "thought",
        sourceLanguage: "ja",
        sourceText: "Source two",
        aiTranslation: "AI two",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      },
      {
        id: "line-source",
        order: 3,
        pageNumber: 1,
        speaker: "Ren",
        dialogueType: "narration",
        sourceLanguage: "en",
        sourceText: "Source three",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    );

    expect(formatTranslationTxt(project)).toBe(
      [
        "# Export Demo",
        "",
        "001\t\tthought\tAI two",
        "002\tMika\tPanel 3\tUser one",
        "003\tRen\tnarration\tSource three",
        ""
      ].join("\n")
    );
  });

  it("sorts by page number first and sanitizes line breaks in dialogue text", () => {
    const project = createEmptyProject("MultiPage Export", false);
    project.dialogueLines.push(
      {
        id: "page2-line1",
        order: 1,
        pageNumber: 2,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "2페이지 1번 대사",
        userTranslation: "2페이지\n번역문",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      },
      {
        id: "page1-line2",
        order: 2,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "1페이지 2번 대사",
        userTranslation: "1페이지 2번",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      },
      {
        id: "page1-line1",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "1페이지 1번 대사",
        userTranslation: "1페이지 1번",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    );

    const txt = formatTranslationTxt(project);
    expect(txt).toBe(
      [
        "# MultiPage Export",
        "",
        "001\t\tspeech\t1페이지 1번",
        "002\t\tspeech\t1페이지 2번",
        "001\t\tspeech\t2페이지 번역문",
        ""
      ].join("\n")
    );
  });
});
