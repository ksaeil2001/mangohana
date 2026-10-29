import { describe, expect, it } from "vitest";
import { createProjectSessionManager } from "../../src/main/projectSessions.js";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes.js";

function createMockProject(): TranslationProjectV2 {
  return {
    schemaVersion: 2,
    metadata: {
      id: "ipc-mock-proj",
      title: "IPC Mock Project",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      secret: false
    },
    characters: [],
    dictionaryTerms: [],
    pageImages: [
      {
        id: "img-1",
        pageNumber: 1,
        storedRelativePath: "images/p1.png",
        originalFileName: "01.png",
        sha256: "a".repeat(64),
        byteSize: 1000,
        mimeType: "image/png",
        copiedAt: "2026-08-21T00:00:00.000Z"
      },
      {
        id: "img-2",
        pageNumber: 2,
        storedRelativePath: "images/p2.png",
        originalFileName: "02.png",
        sha256: "b".repeat(64),
        byteSize: 2000,
        mimeType: "image/png",
        copiedAt: "2026-08-21T00:00:00.000Z"
      },
      {
        id: "img-3",
        pageNumber: 3,
        storedRelativePath: "images/p3.png",
        originalFileName: "03.png",
        sha256: "c".repeat(64),
        byteSize: 3000,
        mimeType: "image/png",
        copiedAt: "2026-08-21T00:00:00.000Z"
      }
    ],
    settings: { defaultSourceLanguage: "ja" },
    dialogueLines: [
      {
        id: "line-1",
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "Page 1 dialogue",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      },
      {
        id: "line-2",
        order: 2,
        pageNumber: 2,
        dialogueType: "thought",
        sourceLanguage: "ja",
        sourceText: "Page 2 thought",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      },
      {
        id: "line-3",
        order: 3,
        pageNumber: 3,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "Page 3 dialogue",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    ],
    processing: { pages: [], runs: [], assets: [] }
  };
}

describe("lazySessionIpc - Session Hydration & Prefetching", () => {
  it("hydrates requested page on demand and returns valid chunk and prefetch targets", () => {
    const sessionManager = createProjectSessionManager();
    const sessionResult = sessionManager.createProjectSession({
      project: createMockProject()
    });

    const hydrationResult = sessionManager.hydratePage({
      projectSessionId: sessionResult.projectSessionId,
      pageNumber: 1,
      prefetchRadius: 1
    });

    expect(hydrationResult.ok).toBe(true);
    if (hydrationResult.ok) {
      expect(hydrationResult.chunk.pageNumber).toBe(1);
      expect(hydrationResult.chunk.dialogueLines[0]?.sourceText).toBe("Page 1 dialogue");
      expect(hydrationResult.chunk.chunkHash).toBeDefined();
      expect(hydrationResult.prefetchedPageNumbers).toContain(2);
    }
  });

  it("calculates prefetch neighbors around current viewport page", () => {
    const sessionManager = createProjectSessionManager();
    const sessionResult = sessionManager.createProjectSession({
      project: createMockProject()
    });

    const prefetched = sessionManager.prefetchPages({
      projectSessionId: sessionResult.projectSessionId,
      pageNumber: 2,
      radius: 1
    });

    expect(prefetched).toContain(3);
    expect(prefetched).toContain(1);
  });

  it("returns ok: false when requesting an invalid non-existent page number", () => {
    const sessionManager = createProjectSessionManager();
    const sessionResult = sessionManager.createProjectSession({
      project: createMockProject()
    });

    const result = sessionManager.hydratePage({
      projectSessionId: sessionResult.projectSessionId,
      pageNumber: 99
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("99");
    }
  });
});
