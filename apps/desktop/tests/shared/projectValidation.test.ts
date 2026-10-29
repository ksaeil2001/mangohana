import { describe, expect, it } from "vitest";
import {
  createEmptyProject,
  normalizeEditableProject,
  normalizeProject
} from "../../src/shared/projectValidation";

describe("project validation", () => {
  it("persists valid field-level OCR ownership and rejects unknown ownership fields", () => {
    const project = normalizeProject(createEmptyProject("OCR ownership", false));
    project.dialogueLines = [{
      id: "ocr-line",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "原文",
      parseConfidence: 0.9,
      parseWarnings: [],
      ocrEditStatus: "user_modified",
      ocrUserOwnedFields: ["source_text", "geometry"],
      ocrGroupId: "group-1",
      origin: { kind: "manual" }
    }];

    expect(normalizeProject(project).dialogueLines[0]).toMatchObject({
      ocrEditStatus: "user_modified",
      ocrUserOwnedFields: ["source_text", "geometry"],
      ocrGroupId: "group-1"
    });
    expect(() => normalizeProject({
      ...project,
      dialogueLines: [{
        ...project.dialogueLines[0],
        ocrUserOwnedFields: ["source_text", "translation"]
      }]
    })).toThrow(/malformed dialogue line/i);
  });
  it("creates an empty editable project", () => {
    const project = createEmptyProject("Sample", false);

    expect(project.schemaVersion).toBe(2);
    expect(project.metadata.id).toEqual(expect.any(String));
    expect(project.metadata.id.length).toBeGreaterThan(0);
    expect(project.metadata.title).toBe("Sample");
    expect(project.metadata.createdAt).toEqual(expect.any(String));
    expect(project.metadata.updatedAt).toBe(project.metadata.createdAt);
    expect(project.metadata.secret).toBe(false);
    expect(project.characters).toEqual([]);
    expect(project.dictionaryTerms).toEqual([]);
    expect(project.dialogueLines).toEqual([]);
    expect(project.pageImages).toEqual([]);
    expect(project.settings.defaultSourceLanguage).toBe("unknown");
    expect(project.processing).toEqual({ pages: [], runs: [], assets: [] });
  });

  it("migrates a valid v1 project to a new v2 snapshot without mutating the input", () => {
    const project = {
      schemaVersion: 1,
      metadata: {
        id: "project-1",
        title: "Sample",
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z",
        secret: true
      },
      characters: [
        {
          id: "character-1",
          name: "Narrator",
          aliases: ["N"]
        }
      ],
      dictionaryTerms: [
        {
          id: "term-1",
          source: "先輩",
          target: "senpai"
        }
      ],
      dialogueLines: [
        {
          id: "line-1",
          order: 0,
          dialogueType: "speech",
          lineStatus: "review",
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          parseConfidence: 0.95,
          parseWarnings: []
        }
      ],
      settings: {
        defaultSourceLanguage: "ja"
      }
    };

    const normalized = normalizeProject(project);

    expect(normalized).not.toBe(project);
    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.dialogueLines[0]).toEqual({
      ...project.dialogueLines[0],
      pageNumber: 1,
      origin: { kind: "manual" }
    });
    expect(normalized.processing).toEqual({ pages: [], runs: [], assets: [] });
    expect(project).not.toHaveProperty("processing");
  });

  it("opens an old project whose dictionary terms have no category", () => {
    const project = createEmptyProject("Legacy glossary", false);
    project.dictionaryTerms = [{
      id: "term-1",
      source: "先輩",
      target: "선배"
    }];

    const normalized = normalizeProject(project);
    expect(normalized.dictionaryTerms[0]).toEqual({
      id: "term-1",
      source: "先輩",
      target: "선배"
    });
    expect(normalized.dictionaryTerms[0]).not.toHaveProperty("category");
  });

  it("accepts a dictionary term category from the shared contract", () => {
    const project = createEmptyProject("Categorized", false);
    project.dictionaryTerms = [{
      id: "term-1",
      source: "月華一閃",
      target: "월화일섬",
      category: "skill"
    }];

    expect(normalizeProject(project).dictionaryTerms[0]?.category).toBe("skill");
  });

  it("keeps an old project without translationMode semantically unchanged", () => {
    const project = createEmptyProject("Legacy settings", false);

    const normalized = normalizeProject(project);
    expect(normalized.settings).not.toHaveProperty("translationMode");
  });

  it.each(["fast", "precise"] as const)("accepts the %s translation mode", (translationMode) => {
    const project = createEmptyProject("Mode", false);
    project.settings.translationMode = translationMode;

    expect(normalizeProject(project).settings.translationMode).toBe(translationMode);
  });

  it("rejects an invalid translation mode", () => {
    const project = createEmptyProject("Invalid mode", false);
    const invalidProject = {
      ...project,
      settings: {
        defaultSourceLanguage: project.settings.defaultSourceLanguage,
        translationMode: "balanced"
      }
    };

    expect(() => normalizeProject(invalidProject)).toThrow(/Invalid project: missing settings/);
  });

  it("rejects malformed project data", () => {
    expect(() => normalizeProject({ schemaVersion: 1, dialogueLines: "bad" })).toThrow(
      /Invalid project/
    );
  });

  it("rejects unsupported schema versions", () => {
    expect(() => normalizeProject({ schemaVersion: 3 })).toThrow(
      /Invalid project: unsupported schema version/
    );
  });

  it("rejects missing metadata", () => {
    expect(() =>
      normalizeProject({
        schemaVersion: 1,
        characters: [],
        dictionaryTerms: [],
        dialogueLines: [],
        settings: { defaultSourceLanguage: "unknown" }
      })
    ).toThrow(/Invalid project: missing metadata/);
  });

  it("rejects missing settings", () => {
    expect(() =>
      normalizeProject({
        schemaVersion: 1,
        metadata: {
          id: "project-1",
          title: "Sample",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
          secret: false
        },
        characters: [],
        dictionaryTerms: [],
        dialogueLines: []
      })
    ).toThrow(/Invalid project: missing settings/);
  });

  it("rejects malformed nested items", () => {
    expect(() =>
      normalizeProject({
        schemaVersion: 1,
        metadata: {
          id: "project-1",
          title: "Sample",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
          secret: false
        },
        characters: [{ id: "character-1", name: "Narrator", aliases: "N" }],
        dictionaryTerms: [],
        dialogueLines: [],
        settings: { defaultSourceLanguage: "unknown" }
      })
    ).toThrow(/Invalid project: malformed character/);
  });

  it("rejects invalid dialogue line statuses", () => {
    const project = createEmptyProject("Status", false);
    project.dialogueLines.push({
      id: "line-status",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Source",
      parseConfidence: 1,
      parseWarnings: [],
      origin: { kind: "manual" }
    });

    expect(normalizeProject(project)).toEqual(project);
    expect(() =>
      normalizeProject({
        ...project,
        dialogueLines: [{ ...project.dialogueLines[0], lineStatus: "done-ish" }]
      })
    ).toThrow(/malformed dialogue line/);
  });

  it("defaults legacy dialogue lines to page 1", () => {
    const project = createEmptyProject("Legacy", false);
    const legacyProject = {
      ...project,
      schemaVersion: 1,
      dialogueLines: [
        {
          id: "line-legacy-page",
          order: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          parseConfidence: 0.95,
          parseWarnings: []
        }
      ],
      processing: undefined
    };

    expect(normalizeProject(legacyProject).dialogueLines[0]?.pageNumber).toBe(1);
  });

  it("adds manual origin only for editable save input while keeping persisted v2 validation strict", () => {
    const editable = createEmptyProject("Editable", false);
    editable.dialogueLines.push({
      id: "editable-line",
      order: 1,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "en",
      sourceText: "Editable",
      parseConfidence: 1,
      parseWarnings: []
    });

    expect(() => normalizeProject(editable)).toThrow(/malformed dialogue line/);
    expect(normalizeEditableProject(editable).dialogueLines[0]?.origin).toEqual({
      kind: "manual"
    });
    expect(editable.dialogueLines[0]).not.toHaveProperty("origin");
  });

  it("validates page image metadata", () => {
    const project = createEmptyProject("Images", false);
    const normalized = normalizeProject({
      ...project,
      pageImages: [
        {
          id: "page-image-1",
          pageNumber: 1,
          storedRelativePath: "Images-assets/images/page-001.jpg",
          originalFileName: "scan_001.jpg",
          sha256: "a".repeat(64),
          byteSize: 1234,
          mimeType: "image/jpeg",
          copiedAt: "2026-05-29T00:00:00.000Z"
        }
      ]
    });

    expect(normalized.pageImages[0]?.pageNumber).toBe(1);
    expect(normalized.pageImages[0]?.storedRelativePath).toBe("Images-assets/images/page-001.jpg");
  });

  it("rejects malformed page image metadata", () => {
    const project = createEmptyProject("Bad Images", false);

    expect(() =>
      normalizeProject({
        ...project,
        pageImages: [
          {
            id: "bad-page-image",
            pageNumber: 0,
            storedRelativePath: "Images-assets/images/page-001.jpg",
            originalFileName: "scan_001.jpg",
            sha256: "not-a-hash",
            byteSize: -1,
            mimeType: "image/jpeg",
            copiedAt: "2026-05-29T00:00:00.000Z"
          }
        ]
      })
    ).toThrow(/page image/);
  });

  it("rejects duplicate page numbers", () => {
    const project = createEmptyProject("Invariant", false);
    const image = {
      id: "page-1",
      pageNumber: 1,
      storedRelativePath: "Invariant-assets/images/page-1.png",
      originalFileName: "page-1.png",
      sha256: "a".repeat(64),
      byteSize: 4,
      mimeType: "image/png",
      copiedAt: "2026-09-01T00:00:00.000Z"
    };

    expect(() => normalizeProject({
      ...project,
      pageImages: [image, { ...image, id: "page-2" }]
    })).toThrow(/duplicate page image page number/);
    expect(() => normalizeProject({
      ...project,
      pageImages: [image, { ...image, pageNumber: 2 }]
    })).toThrow(/duplicate page image id/);
  });

  it("validates and preserves dialogue typesetting metadata", () => {
    const project = createEmptyProject("Typesetting", false);
    const normalized = normalizeProject({
      ...project,
      dialogueLines: [
        {
          id: "line-1",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          parseConfidence: 1,
          parseWarnings: [],
          origin: { kind: "manual" },
          typesetting: {
            bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            writingMode: "horizontal-tb",
            rotationDegrees: 5,
            shape: "ellipse",
            fontFamily: "Pretendard",
            fontSizeRatio: 0.12,
            color: "#000000",
            strokeColor: "#ffffff",
            strokeWidth: 2,
            align: "center",
            lineHeight: 1.3
          }
        }
      ]
    });

    expect(normalized.dialogueLines[0]?.typesetting).toEqual({
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      writingMode: "horizontal-tb",
      rotationDegrees: 5,
      shape: "ellipse",
      fontFamily: "Pretendard",
      fontSizeRatio: 0.12,
      color: "#000000",
      strokeColor: "#ffffff",
      strokeWidth: 2,
      align: "center",
      lineHeight: 1.3
    });
  });

  it("rejects malformed dialogue typesetting metadata", () => {
    const project = createEmptyProject("Bad Typesetting", false);

    expect(() =>
      normalizeProject({
        ...project,
        dialogueLines: [
          {
            id: "line-1",
            order: 1,
            pageNumber: 1,
            dialogueType: "speech",
            sourceLanguage: "ja",
            sourceText: "こんにちは",
            parseConfidence: 1,
            parseWarnings: [],
            origin: { kind: "manual" },
            typesetting: {
              bbox: { x: 0.1, y: 0.2, width: -0.3, height: 0.4 },
              writingMode: "invalid-mode"
            }
          }
        ]
      })
    ).toThrow(/malformed dialogue line/);
  });
});
