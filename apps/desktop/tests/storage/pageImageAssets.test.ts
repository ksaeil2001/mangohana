import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyPageImageAsset } from "../../src/main/pageImageAssets";

let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `page-image-assets-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await import("node:fs/promises").then(({ rm }) => rm(tempDir, { recursive: true, force: true }));
});

describe("copyPageImageAsset", () => {
  it("copies image bytes and returns verified metadata", async () => {
    const sourcePath = join(tempDir, "scan_001.jpg");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

    const result = await copyPageImageAsset({
      sourcePath,
      projectFilePath: join(tempDir, "Project.ctp"),
      pageNumber: 1,
      now: new Date("2026-05-29T00:00:00.000Z")
    });

    expect(result.pageImage.pageNumber).toBe(1);
    expect(result.pageImage.originalFileName).toBe("scan_001.jpg");
    expect(result.pageImage.mimeType).toBe("image/jpeg");
    expect(result.pageImage.byteSize).toBe(4);
    expect(result.pageImage.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(result.absoluteStoredPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects unsupported image extensions", async () => {
    const sourcePath = join(tempDir, "notes.txt");
    await writeFile(sourcePath, "not an image");

    await expect(
      copyPageImageAsset({
        sourcePath,
        projectFilePath: join(tempDir, "Project.ctp"),
        pageNumber: 1,
        now: new Date("2026-05-29T00:00:00.000Z")
      })
    ).rejects.toThrow(/unsupported image/i);
  });

  it("reuses one content-addressed asset for identical image bytes", async () => {
    const sourcePath = join(tempDir, "scan_001.jpg");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));

    const first = await copyPageImageAsset({
      sourcePath,
      projectFilePath: join(tempDir, "Project.ctp"),
      pageNumber: 1,
      now: new Date("2026-05-29T00:00:00.000Z")
    });
    const second = await copyPageImageAsset({
      sourcePath,
      projectFilePath: join(tempDir, "Project.ctp"),
      pageNumber: 1,
      now: new Date("2026-05-29T00:00:00.000Z")
    });

    expect(first.pageImage.storedRelativePath).toBe(
      "Project-assets/images/9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.jpg"
    );
    expect(second.pageImage.storedRelativePath).toBe(first.pageImage.storedRelativePath);
    expect(second.absoluteStoredPath).toBe(first.absoluteStoredPath);
    await expect(stat(first.absoluteStoredPath)).resolves.toBeTruthy();
  });

  it("rejects a mismatched existing file at the content-addressed path", async () => {
    const sourcePath = join(tempDir, "scan_001.jpg");
    const assetRoot = join(tempDir, "Project-assets", "images");
    const storedPath = join(
      assetRoot,
      "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.jpg"
    );
    await mkdir(assetRoot, { recursive: true });
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
    await writeFile(storedPath, Buffer.from([4, 3, 2, 1]));

    await expect(
      copyPageImageAsset({
        sourcePath,
        projectFilePath: join(tempDir, "Project.ctp"),
        pageNumber: 1,
        now: new Date("2026-05-29T00:00:00.000Z")
      })
    ).rejects.toThrow(/content-addressed asset collision/i);

    await expect(readFile(storedPath)).resolves.toEqual(Buffer.from([4, 3, 2, 1]));
  });
});
