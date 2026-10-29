import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes";
import { prepareProjectAssetRelocation } from "../../src/main/projectAssetRelocation";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("project asset relocation", () => {
  it("copies and promotes page and processing assets, then cleans staging", async () => {
    const root = await createWorkspace();
    const sourceProjectFilePath = join(root, "source", "Book.ctp");
    const targetProjectFilePath = join(root, "target", "Book-copy.ctp");
    const originalBytes = Buffer.from("original-image");
    const resultBytes = Buffer.from("processed-image");
    const originalRelativePath = "Book-assets/images/original.png";
    const resultRelativePath = "Book-assets/results/cleaned.png";
    await writeAsset(root, "source", originalRelativePath, originalBytes);
    await writeAsset(root, "source", resultRelativePath, resultBytes);

    const prepared = await prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([
        pageImage(originalRelativePath, originalBytes),
        derivedAsset(resultRelativePath, resultBytes)
      ])
    });

    await expect(stat(join(root, "target", originalRelativePath))).rejects.toThrow();
    await prepared.beforeFinalRename();
    expect(await readFile(join(root, "target", originalRelativePath))).toEqual(originalBytes);
    expect(await readFile(join(root, "target", resultRelativePath))).toEqual(resultBytes);
    await prepared.complete();
    await expect(stat(join(root, "target", ".trio-save-as-staging"))).rejects.toThrow();
  });

  it("is a no-op when only the project filename changes", async () => {
    const root = await createWorkspace();
    const projectDir = join(root, "project");
    const sourceProjectFilePath = join(projectDir, "Book.ctp");
    const targetProjectFilePath = join(projectDir, "Renamed.ctp");
    const bytes = Buffer.from("same-directory");
    const relativePath = "Book-assets/images/page.png";
    await writeAsset(root, "project", relativePath, bytes);

    const prepared = await prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([pageImage(relativePath, bytes)])
    });
    await prepared.beforeFinalRename();
    await prepared.complete();

    expect(await readFile(join(projectDir, relativePath))).toEqual(bytes);
  });

  it("rejects duplicate metadata conflicts and unsafe paths", async () => {
    const root = await createWorkspace();
    const sourceProjectFilePath = join(root, "source", "Book.ctp");
    const targetProjectFilePath = join(root, "target", "Book.ctp");
    const bytes = Buffer.from("duplicate");
    const relativePath = "Book-assets/images/page.png";
    await writeAsset(root, "source", relativePath, bytes);

    await expect(prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([
        pageImage(relativePath, bytes),
        derivedAsset(relativePath, Buffer.from("different"))
      ])
    })).rejects.toThrow(/metadata|conflict/i);

    await expect(prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([pageImage("../outside.png", bytes)])
    })).rejects.toThrow(/relative|path|escape/i);

    await expect(prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([pageImage(join(root, "source", relativePath), bytes)])
    })).rejects.toThrow(/relative|path/i);
  });

  it("rejects source metadata mismatches before creating a target copy", async () => {
    const root = await createWorkspace();
    const sourceProjectFilePath = join(root, "source", "Book.ctp");
    const targetProjectFilePath = join(root, "target", "Book.ctp");
    const actualBytes = Buffer.from("actual");
    const relativePath = "Book-assets/images/page.png";
    await writeAsset(root, "source", relativePath, actualBytes);

    await expect(prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([{
        ...pageImage(relativePath, actualBytes),
        byteSize: actualBytes.length + 1
      }])
    })).rejects.toThrow(/size|hash|content|mismatch/i);
    await expect(stat(join(root, "target", relativePath))).rejects.toThrow();
  });

  it("reuses identical target files and rejects different target collisions", async () => {
    const root = await createWorkspace();
    const sourceProjectFilePath = join(root, "source", "Book.ctp");
    const targetProjectFilePath = join(root, "target", "Book.ctp");
    const bytes = Buffer.from("same-content");
    const relativePath = "Book-assets/images/page.png";
    await writeAsset(root, "source", relativePath, bytes);
    await writeAsset(root, "target", relativePath, bytes);

    const prepared = await prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([pageImage(relativePath, bytes)])
    });
    await prepared.beforeFinalRename();
    await prepared.complete();
    expect(await readFile(join(root, "target", relativePath))).toEqual(bytes);

    await writeAsset(root, "target", relativePath, Buffer.from("different-target"));
    await expect(prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([pageImage(relativePath, bytes)])
    })).rejects.toThrow(/collision|different|existing/i);
  });

  it("still verifies the source before reusing an identical target file", async () => {
    const root = await createWorkspace();
    const sourceProjectFilePath = join(root, "source", "Book.ctp");
    const targetProjectFilePath = join(root, "target", "Book.ctp");
    const expectedBytes = Buffer.from("expected-source");
    const relativePath = "Book-assets/images/page.png";
    await writeAsset(root, "source", relativePath, expectedBytes);
    await writeAsset(root, "target", relativePath, expectedBytes);
    await writeFile(join(root, "source", relativePath), Buffer.from("modified-source"));

    await expect(prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([pageImage(relativePath, expectedBytes)])
    })).rejects.toThrow(/source|content|mismatch/i);
  });

  it("rollback removes only files promoted by this relocation", async () => {
    const root = await createWorkspace();
    const sourceProjectFilePath = join(root, "source", "Book.ctp");
    const targetProjectFilePath = join(root, "target", "Book.ctp");
    const newBytes = Buffer.from("new");
    const reusedBytes = Buffer.from("reused");
    const newRelativePath = "Book-assets/images/new.png";
    const reusedRelativePath = "Book-assets/images/reused.png";
    await writeAsset(root, "source", newRelativePath, newBytes);
    await writeAsset(root, "source", reusedRelativePath, reusedBytes);
    await writeAsset(root, "target", reusedRelativePath, reusedBytes);

    const prepared = await prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([
        pageImage(newRelativePath, newBytes),
        pageImage(reusedRelativePath, reusedBytes)
      ])
    });
    await prepared.beforeFinalRename();
    await prepared.rollback();

    await expect(stat(join(root, "target", newRelativePath))).rejects.toThrow();
    expect(await readFile(join(root, "target", reusedRelativePath))).toEqual(reusedBytes);
  });

  it("rejects rollback when a promoted target was changed and keeps that target", async () => {
    const root = await createWorkspace();
    const sourceProjectFilePath = join(root, "source", "Book.ctp");
    const targetProjectFilePath = join(root, "target", "Book.ctp");
    const bytes = Buffer.from("promoted");
    const secondBytes = Buffer.from("second-promoted");
    const relativePath = "Book-assets/images/page.png";
    const secondRelativePath = "Book-assets/images/second.png";
    await writeAsset(root, "source", relativePath, bytes);
    await writeAsset(root, "source", secondRelativePath, secondBytes);

    const prepared = await prepareProjectAssetRelocation({
      sourceProjectFilePath,
      targetProjectFilePath,
      project: projectWithAssets([
        pageImage(relativePath, bytes),
        pageImage(secondRelativePath, secondBytes)
      ])
    });
    await prepared.beforeFinalRename();
    const changedBytes = Buffer.from("changed-after-promotion");
    await writeFile(join(root, "target", relativePath), changedBytes);

    await expect(prepared.rollback()).rejects.toThrow(/rollback|asset|mismatch/i);
    expect(await readFile(join(root, "target", relativePath))).toEqual(changedBytes);
    await expect(stat(join(root, "target", secondRelativePath))).rejects.toThrow();
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-asset-relocation-"));
  temporaryDirectories.push(root);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "source"), { recursive: true });
  await mkdir(join(root, "target"), { recursive: true });
  await mkdir(join(root, "project"), { recursive: true });
  return root;
}

async function writeAsset(root: string, projectDirectory: string, relativePath: string, bytes: Buffer): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const absolutePath = join(root, projectDirectory, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, bytes);
}

function projectWithAssets(assets: Array<ReturnType<typeof pageImage> | ReturnType<typeof derivedAsset>>): TranslationProjectV2 {
  return {
    schemaVersion: 2,
    metadata: {
      id: "project-1",
      title: "Book",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      secret: false
    },
    characters: [],
    dictionaryTerms: [],
    dialogueLines: [],
    pageImages: assets.filter((asset): asset is ReturnType<typeof pageImage> => "pageNumber" in asset),
    settings: { defaultSourceLanguage: "ja" },
    processing: {
      pages: [],
      runs: [],
      assets: assets.filter((asset): asset is ReturnType<typeof derivedAsset> => "assetId" in asset)
    }
  };
}

function pageImage(storedRelativePath: string, bytes: Buffer) {
  return {
    id: `page-${storedRelativePath}`,
    pageNumber: 1,
    storedRelativePath,
    originalFileName: "page.png",
    sha256: sha256(bytes),
    byteSize: bytes.length,
    mimeType: "image/png",
    copiedAt: "2026-01-01T00:00:00.000Z"
  } as const;
}

function derivedAsset(storedRelativePath: string, bytes: Buffer) {
  return {
    assetId: `asset-${storedRelativePath}`,
    source: "manual_openai" as const,
    sourcePageImageId: "page-1",
    runId: "run-1",
    role: "cleaned" as const,
    storedRelativePath,
    sha256: sha256(bytes),
    byteSize: bytes.length,
    mimeType: "image/png" as const,
    createdAt: "2026-01-01T00:00:00.000Z"
  } as const;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
