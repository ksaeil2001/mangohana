import { describe, expect, it } from "vitest";
import { validateAndNormalizeProjectMutation } from "../../src/main/projectMutations";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";

describe("project mutation normalization", () => {
  it("assigns Main-owned dialogue identity, order, defaults, and changed paths", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));
    const result = validateAndNormalizeProjectMutation(
      project,
      {
        type: "add_dialogue_line",
        input: {
          pageNumber: 2,
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          dialogueType: "speech"
        }
      },
      { createId: () => "line-main-1" }
    );

    expect(result).toEqual({
      mutation: {
        type: "add_dialogue_line",
        line: {
          id: "line-main-1",
          order: 1,
          pageNumber: 2,
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          dialogueType: "speech",
          lineStatus: "untranslated",
          parseConfidence: 1,
          parseWarnings: [],
          origin: { kind: "manual" }
        }
      },
      changedPaths: ["dialogueLines/line-main-1"]
    });
  });

  it("rejects Renderer attempts to write Main-owned dialogue fields", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));

    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "add_dialogue_line",
        input: {
          pageNumber: 1,
          sourceLanguage: "en",
          sourceText: "source",
          dialogueType: "speech",
          origin: { kind: "pipeline" }
        }
      })
    ).toThrow(/unsupported field/i);

    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "update_dialogue_line",
        lineId: "line-1",
        patch: { aiTranslation: "forbidden" }
      })
    ).toThrow(/unsupported field/i);
  });

  it("validates settings, characters, dictionary terms, and explicit patch values", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));

    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "update_project_settings",
        patch: { allowExternalAi: "yes" }
      })
    ).toThrow(/boolean/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "update_project_settings",
        patch: { translationMode: "turbo" }
      })
    ).toThrow(/unsupported/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_character",
        character: { id: "character-1" }
      })
    ).toThrow(/character\.name/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_character",
        character: { id: "character-1", name: "A", aliases: [1] }
      })
    ).toThrow(/string array/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_dictionary_term",
        term: { id: "term-1", source: "A", target: "B", extra: true }
      })
    ).toThrow(/unsupported field/i);
  });

  it("accepts dictionary term category from the shared contract and rejects invalid values", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));
    const result = validateAndNormalizeProjectMutation(project, {
      type: "upsert_dictionary_term",
      term: {
        id: "term-skill",
        source: "月華一閃",
        target: "월화일섬",
        category: "skill"
      }
    });

    expect(result.mutation).toEqual({
      type: "upsert_dictionary_term",
      term: {
        id: "term-skill",
        source: "月華一閃",
        target: "월화일섬",
        category: "skill"
      }
    });
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_dictionary_term",
        term: {
          id: "term-1",
          source: "A",
          target: "B",
          category: "weapon"
        }
      })
    ).toThrow(/term\.category/i);
  });

  it("accepts dictionary term condition and priority from the shared contract", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));
    const result = validateAndNormalizeProjectMutation(project, {
      type: "upsert_dictionary_term",
      term: {
        id: "term-conditional",
        source: "先輩",
        target: "선배님",
        note: "후배 전용 호칭",
        priority: 20,
        condition: {
          speaker: "후배A",
          dialogueType: "speech",
          targetContext: "존칭"
        }
      }
    });

    expect(result).toEqual({
      mutation: {
        type: "upsert_dictionary_term",
        term: {
          id: "term-conditional",
          source: "先輩",
          target: "선배님",
          note: "후배 전용 호칭",
          priority: 20,
          condition: {
            speaker: "후배A",
            dialogueType: "speech",
            targetContext: "존칭"
          }
        }
      },
      changedPaths: ["dictionaryTerms/term-conditional"]
    });
  });

  it("rejects invalid dictionary term condition or priority", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));

    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_dictionary_term",
        term: {
          id: "term-1",
          source: "A",
          target: "B",
          condition: { speaker: 1 }
        }
      })
    ).toThrow(/term\.condition\.speaker/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_dictionary_term",
        term: {
          id: "term-1",
          source: "A",
          target: "B",
          condition: { dialogueType: "yell" }
        }
      })
    ).toThrow(/term\.condition\.dialogueType/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_dictionary_term",
        term: {
          id: "term-1",
          source: "A",
          target: "B",
          condition: { targetContext: true }
        }
      })
    ).toThrow(/term\.condition\.targetContext/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_dictionary_term",
        term: {
          id: "term-1",
          source: "A",
          target: "B",
          condition: { extra: "nope" }
        }
      })
    ).toThrow(/unsupported field/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_dictionary_term",
        term: {
          id: "term-1",
          source: "A",
          target: "B",
          priority: "high"
        }
      })
    ).toThrow(/term\.priority/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "upsert_dictionary_term",
        term: {
          id: "term-1",
          source: "A",
          target: "B",
          priority: Number.NaN
        }
      })
    ).toThrow(/term\.priority/i);
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "update_dialogue_line",
        lineId: "line-1",
        patch: { notes: undefined }
      })
    ).toThrow(/notes must be a string/i);
  });

  it("normalizes and validates update_dialogue_typesetting mutation", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));
    const result = validateAndNormalizeProjectMutation(project, {
      type: "update_dialogue_typesetting",
      lineId: "line-1",
      typesetting: {
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        writingMode: "horizontal-tb",
        shape: "ellipse",
        fontFamily: "Pretendard",
        fontSizeRatio: 0.15,
        color: "#000000",
        strokeColor: "#ffffff",
        strokeWidth: 2,
        align: "center",
        lineHeight: 1.2
      }
    });

    expect(result).toEqual({
      mutation: {
        type: "update_dialogue_typesetting",
        lineId: "line-1",
        typesetting: {
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          writingMode: "horizontal-tb",
          shape: "ellipse",
          fontFamily: "Pretendard",
          fontSizeRatio: 0.15,
          color: "#000000",
          strokeColor: "#ffffff",
          strokeWidth: 2,
          align: "center",
          lineHeight: 1.2
        }
      },
      changedPaths: ["dialogueLines/line-1/typesetting"]
    });
  });

  it("accepts typesetting in dialogue line patch", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));
    const result = validateAndNormalizeProjectMutation(project, {
      type: "update_dialogue_line",
      lineId: "line-1",
      patch: {
        userTranslation: "안녕",
        typesetting: {
          bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.5 },
          writingMode: "vertical-rl"
        }
      }
    });

    expect(result.mutation).toEqual({
      type: "update_dialogue_line",
      lineId: "line-1",
      patch: {
        userTranslation: "안녕",
        typesetting: {
          bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.5 },
          writingMode: "vertical-rl"
        }
      }
    });
    expect(result.changedPaths).toContain("dialogueLines/line-1/userTranslation");
    expect(result.changedPaths).toContain("dialogueLines/line-1/typesetting");
  });

  it("keeps typesetting geometry on add_dialogue_line", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));
    const typesetting = {
      bbox: { x: 0.2, y: 0.3, width: 0.25, height: 0.1 },
      writingMode: "vertical-rl" as const,
      rotationDegrees: 9,
      shape: "ellipse" as const
    };
    const result = validateAndNormalizeProjectMutation(
      project,
      {
        type: "add_dialogue_line",
        input: {
          pageNumber: 1,
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          dialogueType: "speech",
          typesetting
        }
      },
      { createId: () => "line-typeset-1" }
    );

    expect(result.mutation).toMatchObject({
      type: "add_dialogue_line",
      line: {
        id: "line-typeset-1",
        typesetting
      }
    });
  });

  it("accepts a pageNumber user patch and records a field-level changed path", () => {
    const project = normalizeProject(createEmptyProject("Mutations", false));
    const result = validateAndNormalizeProjectMutation(project, {
      type: "update_dialogue_line",
      lineId: "line-1",
      patch: { pageNumber: 2 }
    });

    expect(result).toEqual({
      mutation: {
        type: "update_dialogue_line",
        lineId: "line-1",
        patch: { pageNumber: 2 }
      },
      changedPaths: ["dialogueLines/line-1/pageNumber"]
    });
  });

  it.each([
    { pageNumber: 0, label: "zero" },
    { pageNumber: -1, label: "negative" },
    { pageNumber: 1.5, label: "non-integer" },
    { pageNumber: "2", label: "string" },
    { pageNumber: Number.NaN, label: "NaN" }
  ])("rejects a $label pageNumber patch", ({ pageNumber }) => {
    const project = normalizeProject(createEmptyProject("Mutations", false));
    expect(() =>
      validateAndNormalizeProjectMutation(project, {
        type: "update_dialogue_line",
        lineId: "line-1",
        patch: { pageNumber }
      })
    ).toThrow(/pageNumber must be a positive integer/i);
  });
});
