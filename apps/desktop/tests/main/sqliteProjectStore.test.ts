import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportSqliteToMonolithicCtp,
  importMonolithicToSqlite
} from "../../src/main/projectPackaging.js";
import { loadProjectFile, saveProjectFile } from "../../src/main/projectStorage.js";
import { createSqliteProjectStore } from "../../src/main/sqliteProjectStore.js";
import type { PageChunk, ProjectManifest } from "../../src/shared/projectChunkTypes.js";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sqlite-storage-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createMockManifest(pageCount: number, secret = false): ProjectManifest {
  return {
    schemaVersion: 2,
    metadata: {
      id: "sqlite-proj",
      title: "SQLite Project",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      secret
    },
    characters: [{ id: "c1", name: "Bob", aliases: [] }],
    dictionaryTerms: [{ id: "t1", source: "A", target: "B" }],
    pageImages: Array.from({ length: pageCount }, (_, i) => ({
      id: `img-${i + 1}`,
      pageNumber: i + 1,
      storedRelativePath: `images/${i + 1}.png`,
      originalFileName: `${i + 1}.png`,
      sha256: "c".repeat(64),
      byteSize: 1000,
      mimeType: "image/png",
      copiedAt: "2026-08-21T00:00:00.000Z"
    })),
    settings: { defaultSourceLanguage: "ja" },
    pageIndex: Array.from({ length: pageCount }, (_, i) => ({
      pageNumber: i + 1,
      pageImageId: `img-${i + 1}`,
      dialogueCount: 1,
      status: "untranslated",
      hasInpainting: false,
      hasTypesetting: false,
      updatedAt: "2026-08-21T00:00:00.000Z",
      chunkHash: `hash-${i + 1}`
    }))
  };
}

function createMockChunk(pageNumber: number, text?: string): PageChunk {
  return {
    pageNumber,
    pageImageId: `img-${pageNumber}`,
    dialogueLines: [
      {
        id: `line-${pageNumber}`,
        order: 1,
        pageNumber,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: text ?? `Original Page ${pageNumber} Text`,
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    ],
    runs: [],
    assets: []
  };
}

describe("sqliteProjectStore", () => {
  it("initializes SQLite WAL database, saves incrementally, and loads chunks on demand", () => {
    const dbPath = join(tempDir, "project.ctp-db");
    const store = createSqliteProjectStore({ filePath: dbPath });

    const manifest = createMockManifest(3);
    const chunks = [createMockChunk(1), createMockChunk(2), createMockChunk(3)];

    // 1. Initial save
    store.saveIncremental(manifest, chunks, [1, 2, 3]);

    const loadedManifest = store.getManifest();
    expect(loadedManifest.metadata.title).toBe("SQLite Project");
    expect(loadedManifest.pageIndex).toHaveLength(3);

    const chunk1 = store.loadChunk(1);
    expect(chunk1?.dialogueLines[0]?.sourceText).toBe("Original Page 1 Text");

    // 2. Incremental update (Page 2 only)
    const updatedChunk2 = createMockChunk(2, "Incremental Update for Page 2");
    manifest.metadata.updatedAt = "2026-08-21T15:00:00.000Z";

    store.saveIncremental(manifest, [updatedChunk2], [1, 2, 3]);

    const reloadedManifest = store.getManifest();
    expect(reloadedManifest.metadata.updatedAt).toBe("2026-08-21T15:00:00.000Z");

    const reloadedChunk1 = store.loadChunk(1);
    expect(reloadedChunk1?.dialogueLines[0]?.sourceText).toBe("Original Page 1 Text");

    const reloadedChunk2 = store.loadChunk(2);
    expect(reloadedChunk2?.dialogueLines[0]?.sourceText).toBe("Incremental Update for Page 2");

    store.close();
  });

  it("records mutation journals for audit and batch recovery", () => {
    const dbPath = join(tempDir, "journal.ctp-db");
    const store = createSqliteProjectStore({ filePath: dbPath });

    store.recordJournal({
      projectSessionId: "session-1",
      pageNumber: 1,
      mutationType: "add_dialogue_line",
      payload: { id: "line-new", text: "New Line" }
    });

    store.recordJournal({
      projectSessionId: "session-1",
      pageNumber: 2,
      mutationType: "update_dialogue_line",
      payload: { lineId: "line-2", patch: { userTranslation: "번역" } }
    });

    const entries = store.getJournalEntries("session-1");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.mutationType).toBe("add_dialogue_line");
    expect(entries[1]?.mutationType).toBe("update_dialogue_line");

    store.close();
  });

  it("encrypts secret projects and handles password authentication", () => {
    const dbPath = join(tempDir, "secret.ctp-db");
    const password = "SqlitePassword123!";

    const store = createSqliteProjectStore({
      filePath: dbPath,
      password
    });

    const manifest = createMockManifest(2, true);
    const chunks = [createMockChunk(1), createMockChunk(2)];

    store.saveIncremental(manifest, chunks, [1, 2]);
    store.close();

    // Opening with wrong password should fail when reading
    const wrongStore = createSqliteProjectStore({
      filePath: dbPath,
      password: "WrongPassword"
    });
    expect(() => wrongStore.getManifest()).toThrow();
    wrongStore.close();

    // Opening with correct password should succeed
    const correctStore = createSqliteProjectStore({
      filePath: dbPath,
      password
    });
    expect(correctStore.getManifest().metadata.title).toBe("SQLite Project");
    const chunk1 = correctStore.loadChunk(1);
    expect(chunk1?.pageNumber).toBe(1);
    correctStore.close();
  });

  it("converts between monolithic .ctp and SQLite .ctp-db losslessly", async () => {
    const originalCtp = join(tempDir, "original.ctp");
    const dbPath = join(tempDir, "converted.ctp-db");
    const exportedCtp = join(tempDir, "reexported.ctp");

    const sampleProject: TranslationProjectV2 = {
      schemaVersion: 2,
      metadata: {
        id: "roundtrip-proj",
        title: "Roundtrip Project",
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
        secret: false
      },
      characters: [{ id: "c1", name: "Alice", aliases: [] }],
      dictionaryTerms: [{ id: "t1", source: "A", target: "B" }],
      pageImages: [
        {
          id: "img-1",
          pageNumber: 1,
          storedRelativePath: "images/p1.png",
          originalFileName: "01.png",
          sha256: "d".repeat(64),
          byteSize: 1000,
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
          sourceText: "Hello SQLite",
          parseConfidence: 1,
          parseWarnings: [],
          origin: { kind: "manual" }
        }
      ],
      processing: { pages: [], runs: [], assets: [] }
    };

    await saveProjectFile({ filePath: originalCtp, project: sampleProject });

    // 1. Import .ctp -> SQLite .ctp-db
    await importMonolithicToSqlite({
      sourceCtpFilePath: originalCtp,
      targetSqliteFilePath: dbPath
    });

    // 2. Export SQLite .ctp-db -> .ctp
    await exportSqliteToMonolithicCtp({
      sqliteFilePath: dbPath,
      targetCtpFilePath: exportedCtp
    });

    // 3. Verify exact equality
    const loaded = await loadProjectFile({ filePath: exportedCtp });
    expect(loaded.project).toEqual(sampleProject);
  });
});
