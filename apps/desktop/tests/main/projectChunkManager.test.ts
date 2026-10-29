import { describe, expect, it } from "vitest";
import { createProjectChunkTracker } from "../../src/main/projectChunkManager.js";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes.js";

function createMockProject(): TranslationProjectV2 {
  return {
    schemaVersion: 2,
    metadata: {
      id: "mock-proj",
      title: "Mock Project",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T12:00:00.000Z",
      secret: false
    },
    characters: [],
    dictionaryTerms: [],
    pageImages: [
      {
        id: "img-1",
        pageNumber: 1,
        storedRelativePath: "p1.png",
        originalFileName: "01.png",
        sha256: "h1",
        byteSize: 1000,
        mimeType: "image/png",
        copiedAt: "2026-08-21T00:00:00.000Z"
      },
      {
        id: "img-2",
        pageNumber: 2,
        storedRelativePath: "p2.png",
        originalFileName: "02.png",
        sha256: "h2",
        byteSize: 2000,
        mimeType: "image/png",
        copiedAt: "2026-08-21T00:00:00.000Z"
      }
    ],
    settings: { defaultSourceLanguage: "ja" },
    dialogueLines: [
      {
        id: "d1",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "Hello Page 1",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      },
      {
        id: "d2",
        order: 2,
        pageNumber: 2,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "Hello Page 2",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    ],
    processing: { pages: [], runs: [], assets: [] }
  };
}

describe("projectChunkManager", () => {
  it("initializes in clean state and allows reading manifest and chunks", () => {
    const project = createMockProject();
    const tracker = createProjectChunkTracker(project);

    expect(tracker.isDirty()).toBe(false);
    expect(tracker.isManifestDirty()).toBe(false);
    expect(tracker.getDirtyPageNumbers()).toHaveLength(0);

    const manifest = tracker.getManifest();
    expect(manifest.metadata.title).toBe("Mock Project");
    expect(manifest.pageIndex).toHaveLength(2);

    const chunk1 = tracker.getPageChunk(1);
    expect(chunk1?.dialogueLines).toHaveLength(1);
    expect(chunk1?.dialogueLines[0]?.sourceText).toBe("Hello Page 1");
  });

  it("marks only the updated page chunk dirty on updatePageChunk", () => {
    const project = createMockProject();
    const tracker = createProjectChunkTracker(project);

    tracker.updatePageChunk(1, (chunk) => {
      chunk.dialogueLines[0]!.userTranslation = "페이지 1 안녕";
    });

    expect(tracker.isDirty()).toBe(true);
    expect(tracker.getDirtyPageNumbers()).toEqual([1]);
    expect(tracker.isManifestDirty()).toBe(true); // Index was updated for page 1

    tracker.markClean();
    expect(tracker.isDirty()).toBe(false);
    expect(tracker.getDirtyPageNumbers()).toEqual([]);
  });

  it("marks manifest dirty on updateManifest without dirtying page chunks", () => {
    const project = createMockProject();
    const tracker = createProjectChunkTracker(project);

    tracker.updateManifest((manifest) => {
      manifest.metadata.title = "Updated Project Title";
    });

    expect(tracker.isDirty()).toBe(true);
    expect(tracker.isManifestDirty()).toBe(true);
    expect(tracker.getDirtyPageNumbers()).toEqual([]);
  });

  it("accurately detects modified chunks during syncFromProject", () => {
    const project = createMockProject();
    const tracker = createProjectChunkTracker(project);

    // Modify only page 2 in the project
    const modifiedProject = structuredClone(project);
    modifiedProject.dialogueLines[1]!.userTranslation = "새로운 번역";

    const syncResult = tracker.syncFromProject(modifiedProject);

    expect(syncResult.dirtyPageNumbers).toEqual([2]);
    expect(tracker.getDirtyPageNumbers()).toEqual([2]);

    const recomposed = tracker.toProject();
    expect(recomposed.dialogueLines[1]!.userTranslation).toBe("새로운 번역");
  });
});
