import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportChunkedToMonolithicCtp,
  importMonolithicToChunked
} from "../../src/main/projectPackaging.js";
import { loadProjectFile, saveProjectFile } from "../../src/main/projectStorage.js";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "packaging-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createSampleProject(secret = false): TranslationProjectV2 {
  return {
    schemaVersion: 2,
    metadata: {
      id: "pkg-sample",
      title: "Packaging Sample",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      secret
    },
    characters: [{ id: "c1", name: "Alice", aliases: [] }],
    dictionaryTerms: [{ id: "t1", source: "A", target: "B" }],
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
        sourceText: "Page 1 dialogue",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      },
      {
        id: "d2",
        order: 2,
        pageNumber: 2,
        dialogueType: "thought",
        sourceLanguage: "ja",
        sourceText: "Page 2 thought",
        parseConfidence: 1,
        parseWarnings: [],
        origin: { kind: "manual" }
      }
    ],
    processing: { pages: [], runs: [], assets: [] }
  };
}

describe("projectPackaging", () => {
  it("converts between monolithic .ctp and chunked directory losslessly", async () => {
    const originalCtpPath = join(tempDir, "original.ctp");
    const chunkedDir = join(tempDir, "chunked_package");
    const exportedCtpPath = join(tempDir, "exported.ctp");

    const sampleProject = createSampleProject(false);
    await saveProjectFile({ filePath: originalCtpPath, project: sampleProject });

    // 1. Unpack .ctp -> chunked directory
    await importMonolithicToChunked({
      sourceCtpFilePath: originalCtpPath,
      targetChunkedDirectory: chunkedDir
    });

    // 2. Export chunked directory -> .ctp
    await exportChunkedToMonolithicCtp({
      chunkedDirectory: chunkedDir,
      targetCtpFilePath: exportedCtpPath
    });

    // 3. Load exported .ctp and verify exact equality
    const loadedExported = await loadProjectFile({ filePath: exportedCtpPath });
    expect(loadedExported.project).toEqual(sampleProject);
  });

  it("handles secret encrypted packaging", async () => {
    const secretCtpPath = join(tempDir, "secret.ctp");
    const chunkedDir = join(tempDir, "secret_chunked");
    const exportedSecretCtpPath = join(tempDir, "secret_exported.ctp");
    const password = "PackagingPassword123!";

    const sampleProject = createSampleProject(true);
    await saveProjectFile({
      filePath: secretCtpPath,
      project: sampleProject,
      password
    });

    // 1. Unpack secret .ctp -> encrypted chunked directory
    await importMonolithicToChunked({
      sourceCtpFilePath: secretCtpPath,
      targetChunkedDirectory: chunkedDir,
      password
    });

    // 2. Export encrypted chunked directory -> secret .ctp
    await exportChunkedToMonolithicCtp({
      chunkedDirectory: chunkedDir,
      targetCtpFilePath: exportedSecretCtpPath,
      password
    });

    // 3. Load exported secret .ctp
    const loadedExported = await loadProjectFile({
      filePath: exportedSecretCtpPath,
      password
    });

    expect(loadedExported.encrypted).toBe(true);
    expect(loadedExported.project.metadata.title).toBe("Packaging Sample");
    expect(loadedExported.project.dialogueLines).toHaveLength(2);
  });
});
