import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadIncrementalProject,
  saveIncrementalProject
} from "../../src/main/incrementalProjectStorage.js";
import type { PageChunk, ProjectManifest } from "../../src/shared/projectChunkTypes.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "incremental-storage-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createMockManifest(pageCount: number, secret = false): ProjectManifest {
  return {
    schemaVersion: 2,
    metadata: {
      id: "inc-proj",
      title: "Incremental Project",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      secret
    },
    characters: [],
    dictionaryTerms: [],
    pageImages: Array.from({ length: pageCount }, (_, i) => ({
      id: `img-${i + 1}`,
      pageNumber: i + 1,
      storedRelativePath: `images/${i + 1}.png`,
      originalFileName: `${i + 1}.png`,
      sha256: `sha-${i + 1}`,
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
        sourceText: text ?? `Source Text Page ${pageNumber}`,
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    ],
    runs: [],
    assets: []
  };
}

describe("incrementalProjectStorage", () => {
  it("saves all chunks on initial creation and selectively saves only dirty chunks on subsequent updates", async () => {
    const manifest = createMockManifest(3);
    const chunks = [createMockChunk(1), createMockChunk(2), createMockChunk(3)];

    // 1. Initial save
    await saveIncrementalProject({
      targetDirectory: tempDir,
      manifest,
      dirtyChunks: chunks,
      allPageNumbers: [1, 2, 3]
    });

    const page1Path = join(tempDir, "chunks", "page_1.chunk");
    const page2Path = join(tempDir, "chunks", "page_2.chunk");
    const stat1Before = await stat(page1Path);

    // Wait 10ms to ensure mtime difference if rewritten
    await new Promise((r) => setTimeout(r, 20));

    // 2. Modify only page 2 and save selectively
    const updatedChunk2 = createMockChunk(2, "Updated Page 2 Text");
    manifest.metadata.updatedAt = "2026-08-21T12:00:00.000Z";

    await saveIncrementalProject({
      targetDirectory: tempDir,
      manifest,
      dirtyChunks: [updatedChunk2], // ONLY Page 2 is written
      allPageNumbers: [1, 2, 3]
    });

    const stat1After = await stat(page1Path);
    // Page 1 was not modified or rewritten
    expect(stat1After.mtimeMs).toBe(stat1Before.mtimeMs);

    // 3. Verify loaded data
    const loaded = await loadIncrementalProject({ targetDirectory: tempDir });
    expect(loaded.manifest.metadata.updatedAt).toBe("2026-08-21T12:00:00.000Z");

    const loadedChunk1 = await loaded.chunkLoader(1);
    expect(loadedChunk1?.dialogueLines[0]?.sourceText).toBe("Source Text Page 1");

    const loadedChunk2 = await loaded.chunkLoader(2);
    expect(loadedChunk2?.dialogueLines[0]?.sourceText).toBe("Updated Page 2 Text");
  });

  it("handles secret project encryption and decryption", async () => {
    const manifest = createMockManifest(2, true);
    const chunks = [createMockChunk(1), createMockChunk(2)];

    await saveIncrementalProject({
      targetDirectory: tempDir,
      manifest,
      dirtyChunks: chunks,
      allPageNumbers: [1, 2],
      password: "SuperSecretPassword123!"
    });

    // Loading with wrong password should fail
    await expect(
      loadIncrementalProject({
        targetDirectory: tempDir,
        password: "WrongPassword"
      })
    ).rejects.toThrow();

    // Loading with correct password should succeed
    const loaded = await loadIncrementalProject({
      targetDirectory: tempDir,
      password: "SuperSecretPassword123!"
    });

    expect(loaded.encrypted).toBe(true);
    expect(loaded.manifest.metadata.title).toBe("Incremental Project");

    const chunk1 = await loaded.chunkLoader(1);
    expect(chunk1?.pageNumber).toBe(1);
  });

  it("removes deleted page chunk files from disk during save", async () => {
    const manifest = createMockManifest(3);
    const chunks = [createMockChunk(1), createMockChunk(2), createMockChunk(3)];

    await saveIncrementalProject({
      targetDirectory: tempDir,
      manifest,
      dirtyChunks: chunks,
      allPageNumbers: [1, 2, 3]
    });

    const page3Path = join(tempDir, "chunks", "page_3.chunk");
    expect(await stat(page3Path)).toBeDefined();

    // Delete page 3
    manifest.pageIndex = manifest.pageIndex.filter((p) => p.pageNumber !== 3);
    await saveIncrementalProject({
      targetDirectory: tempDir,
      manifest,
      dirtyChunks: [],
      allPageNumbers: [1, 2]
    });

    await expect(stat(page3Path)).rejects.toThrow();
  });
});
