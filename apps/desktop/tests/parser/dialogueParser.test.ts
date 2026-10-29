import { describe, expect, it } from "vitest";
import { parseDialogueText } from "../../src/main/dialogueParser";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";

describe("parseDialogueText", () => {
  it("parses speaker labels and reference translations", () => {
    const result = parseDialogueText(`
Akira: Don't look away.
KR: 눈 돌리지 마.

Mika - I said wait.
reference: 기다리라고 했잖아.
`);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      order: 1,
      speaker: "Akira",
      sourceText: "Don't look away.",
      referenceTranslation: "눈 돌리지 마.",
      dialogueType: "speech"
    });
    expect(result[1].speaker).toBe("Mika");
    expect(result[1].referenceTranslation).toBe("기다리라고 했잖아.");
  });

  it("marks thought and position hints with warnings when ambiguous", () => {
    const result = parseDialogueText(`
[thought] (top left)
Maybe this is a bad idea.

unlabeled continuation
still the same line
`);

    expect(result[0].dialogueType).toBe("thought");
    expect(result[0].position).toBe("top left");
    expect(result[1].parseWarnings).toContain("No speaker detected");
    expect(result.map((line) => line.sourceText).join(" ")).toContain("unlabeled continuation");
  });

  it("preserves ambiguous speaker-like punctuation as source text", () => {
    const result = parseDialogueText(`
Wait - what are you doing?

No: stop.
`);

    expect(result).toHaveLength(2);
    expect(result[0].speaker).toBeUndefined();
    expect(result[0].sourceText).toBe("Wait - what are you doing?");
    expect(result[0].parseWarnings).toContain("Ambiguous speaker prefix preserved");
    expect(result[1].speaker).toBeUndefined();
    expect(result[1].sourceText).toBe("No: stop.");
    expect(result[1].parseWarnings).toContain("Ambiguous speaker prefix preserved");
  });

  it("preserves unknown marker-only lines in source text", () => {
    const result = parseDialogueText(`
[sfx]
Door creaks.

[unclear]
Muffled words.
`);

    expect(result[0].sourceText).toBe("[sfx] Door creaks.");
    expect(result[0].parseWarnings).toContain("Unknown marker preserved");
    expect(result[1].sourceText).toBe("[unclear] Muffled words.");
    expect(result[1].parseWarnings).toContain("Unknown marker preserved");
  });

  it("assigns page numbers from English page markers", () => {
    const result = parseDialogueText(`
--- page 1 ---
Mika: First page line

[page 2]
Ren: Second page line
`);

    expect(result).toHaveLength(2);
    expect(result[0]?.pageNumber).toBe(1);
    expect(result[0]?.sourceText).toBe("First page line");
    expect(result[1]?.pageNumber).toBe(2);
    expect(result[1]?.sourceText).toBe("Second page line");
  });

  it("applies page markers after dialogue content to following blocks", () => {
    const result = parseDialogueText(`
Mika: Last line on page 1
[page 2]

Ren: First line on page 2
`);

    expect(result).toHaveLength(2);
    expect(result[0]?.speaker).toBe("Mika");
    expect(result[0]?.pageNumber).toBe(1);
    expect(result[0]?.sourceText).toBe("Last line on page 1");
    expect(result[1]?.speaker).toBe("Ren");
    expect(result[1]?.pageNumber).toBe(2);
    expect(result[1]?.sourceText).toBe("First line on page 2");
  });

  it("assigns page numbers from Korean page markers", () => {
    const result = parseDialogueText(`
페이지 3
Mika: Third page line

4페이지
Ren: Fourth page line
`);

    expect(result[0]?.pageNumber).toBe(3);
    expect(result[1]?.pageNumber).toBe(4);
  });

  it("defaults imported lines to page 1 without markers", () => {
    const result = parseDialogueText("Mika: Only page line");

    expect(result[0]?.pageNumber).toBe(1);
  });

  it("generates ids and confidence from parse warnings", () => {
    const result = parseDialogueText(`
Akira: Don't move.

No: stop.
`);

    expect(result[0].id).toEqual(expect.any(String));
    expect(result[0].id.length).toBeGreaterThan(0);
    expect(result[0].parseConfidence).toBe(1);
    expect(result[1].id).toEqual(expect.any(String));
    expect(result[1].parseConfidence).toBe(0.6);
  });

  it("produces dialogue lines compatible with project normalization", () => {
    const project = createEmptyProject("Parsed import", true);
    const { processing: _processing, ...legacyProject } = project;
    const parsedLines = parseDialogueText(`
Akira: Don't look away.
KR: 눈 돌리지 마.

[sfx]
Door creaks.
`);

    const parsedProject = {
      ...legacyProject,
      schemaVersion: 1,
      dialogueLines: parsedLines
    };

    expect(normalizeProject(parsedProject).dialogueLines).toEqual(
      parsedLines.map((line) => ({
        ...line,
        origin: { kind: "manual" }
      }))
    );
  });
});
