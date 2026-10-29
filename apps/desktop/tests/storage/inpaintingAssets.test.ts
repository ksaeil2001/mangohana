import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createManualInpaintingAdapterResult,
  resolveStoredPageImagePath,
  writeInpaintedPageImageAsset,
  writeInpaintingMaskAsset
} from "../../src/main/inpaintingAssets";

describe("inpaintingAssets", () => {
  let tempDir: string;
  let projectFilePath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `inpainting-assets-${randomUUID()}`);
    projectFilePath = join(tempDir, "Book.ctp");
    await mkdir(join(tempDir, "Book-assets", "images"), { recursive: true });
    await writeFile(projectFilePath, "{}", "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves stored image paths inside the project directory", () => {
    const resolved = resolveStoredPageImagePath({
      projectFilePath,
      storedRelativePath: "Book-assets/images/page-001.png"
    });

    expect(resolved).toBe(join(tempDir, "Book-assets", "images", "page-001.png"));
  });

  it("rejects stored image paths outside the project directory", () => {
    expect(() =>
      resolveStoredPageImagePath({
        projectFilePath,
        storedRelativePath: "../outside.png"
      })
    ).toThrow(/inside the project folder/i);
  });

  it("writes inpainted image bytes as a new png asset without overwriting originals", async () => {
    const originalPath = join(tempDir, "Book-assets", "images", "page-001.png");
    await writeFile(originalPath, Buffer.from([1, 2, 3, 4]));

    const result = await writeInpaintedPageImageAsset({
      projectFilePath,
      sourcePageImage: {
        id: "page-image-original",
        pageNumber: 1,
        storedRelativePath: "Book-assets/images/page-001.png",
        originalFileName: "scan.png",
        sha256: "a".repeat(64),
        byteSize: 4,
        mimeType: "image/png",
        copiedAt: "2026-06-30T00:00:00.000Z"
      },
      imageBytes: Buffer.from([9, 8, 7, 6]),
      now: new Date("2026-06-30T01:02:03.000Z")
    });

    expect(result.pageImage.pageNumber).toBe(1);
    expect(result.pageImage.mimeType).toBe("image/png");
    expect(result.pageImage.originalFileName).toBe("scan-inpaint-001.png");
    expect(result.pageImage.storedRelativePath).toBe("Book-assets/images/page-001-inpaint-001.png");
    expect(result.pageImage.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.pageImage.byteSize).toBe(4);
    expect(result.pageImage.copiedAt).toBe("2026-06-30T01:02:03.000Z");
    expect(await readFile(result.absoluteStoredPath)).toEqual(Buffer.from([9, 8, 7, 6]));
    expect(await readFile(originalPath)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("uses the next inpaint suffix when the first generated asset already exists", async () => {
    await writeFile(join(tempDir, "Book-assets", "images", "page-001-inpaint-001.png"), Buffer.from([1]));

    const result = await writeInpaintedPageImageAsset({
      projectFilePath,
      sourcePageImage: {
        id: "page-image-original",
        pageNumber: 1,
        storedRelativePath: "Book-assets/images/page-001.png",
        originalFileName: "scan.png",
        sha256: "a".repeat(64),
        byteSize: 4,
        mimeType: "image/png",
        copiedAt: "2026-06-30T00:00:00.000Z"
      },
      imageBytes: Buffer.from([9, 8, 7, 6]),
      now: new Date("2026-06-30T01:02:03.000Z")
    });

    expect(result.pageImage.originalFileName).toBe("scan-inpaint-002.png");
    expect(result.pageImage.storedRelativePath).toBe("Book-assets/images/page-001-inpaint-002.png");
    expect(await readFile(result.absoluteStoredPath)).toEqual(Buffer.from([9, 8, 7, 6]));
  });

  it("rejects invalid source page numbers", async () => {
    await expect(
      writeInpaintedPageImageAsset({
        projectFilePath,
        sourcePageImage: {
          id: "page-image-original",
          pageNumber: 0,
          storedRelativePath: "Book-assets/images/page-000.png",
          originalFileName: "scan.png",
          sha256: "a".repeat(64),
          byteSize: 4,
          mimeType: "image/png",
          copiedAt: "2026-06-30T00:00:00.000Z"
        },
        imageBytes: Buffer.from([9, 8, 7, 6]),
        now: new Date("2026-06-30T01:02:03.000Z")
      })
    ).rejects.toThrow(/page number/i);
  });

  it("adapts a manual inpainting result to the PR 1-B run and asset boundary", () => {
    const sourcePageImage = {
      id: "page-image-original",
      pageNumber: 1,
      storedRelativePath: "Book-assets/images/source.png",
      originalFileName: "source.png",
      sha256: "a".repeat(64),
      byteSize: 4,
      mimeType: "image/png",
      copiedAt: "2026-06-30T00:00:00.000Z"
    };
    const pageImage = {
      ...sourcePageImage,
      id: "page-image-inpainted",
      storedRelativePath: "Book-assets/images/inpainted.png",
      sha256: "b".repeat(64),
      byteSize: 8,
      copiedAt: "2026-06-30T01:02:03.000Z"
    };

    const result = createManualInpaintingAdapterResult({
      sourcePageImage,
      pageImage,
      provider: "gemini",
      runId: "manual-run-1",
      appVersion: "1.0.0",
      now: new Date("2026-06-30T01:02:03.000Z")
    });

    expect(result.pageImage).toBe(pageImage);
    expect(result.run).toEqual({
      runId: "manual-run-1",
      pageImageId: "page-image-original",
      source: "manual_gemini",
      status: "completed",
      sourceSha256: "a".repeat(64),
      appVersion: "1.0.0",
      queuedAt: "2026-06-30T01:02:03.000Z",
      startedAt: "2026-06-30T01:02:03.000Z",
      completedAt: "2026-06-30T01:02:03.000Z"
    });
    expect(result.asset).toEqual({
      assetId: "page-image-inpainted",
      source: "manual_gemini",
      sourcePageImageId: "page-image-original",
      runId: "manual-run-1",
      role: "cleaned",
      storedRelativePath: "Book-assets/images/inpainted.png",
      sha256: "b".repeat(64),
      byteSize: 8,
      mimeType: "image/png",
      createdAt: "2026-06-30T01:02:03.000Z"
    });
  });

  it("writes inpainting mask bytes as an independent asset (DedubbleBot principle)", async () => {
    const maskBytes = Buffer.from([255, 255, 0, 0]);
    const sourcePageImage = {
      id: "page-image-original",
      pageNumber: 1,
      storedRelativePath: "Book-assets/images/page-001.png",
      originalFileName: "scan.png",
      sha256: "a".repeat(64),
      byteSize: 4,
      mimeType: "image/png" as const,
      copiedAt: "2026-06-30T00:00:00.000Z"
    };

    const maskResult = await writeInpaintingMaskAsset({
      projectFilePath,
      sourcePageImage,
      maskBytes,
      now: new Date("2026-06-30T01:02:03.000Z")
    });

    expect(maskResult.maskAsset.role).toBe("mask");
    expect(maskResult.maskAsset.sourcePageImageId).toBe("page-image-original");
    expect(maskResult.maskAsset.storedRelativePath).toBe("Book-assets/images/page-001-mask-001.png");
    expect(maskResult.maskAsset.byteSize).toBe(4);
    expect(maskResult.maskAsset.mimeType).toBe("image/png");
    expect(await readFile(maskResult.absoluteStoredPath)).toEqual(maskBytes);

    // Second mask write on same page should get -mask-002
    const secondMaskResult = await writeInpaintingMaskAsset({
      projectFilePath,
      sourcePageImage,
      maskBytes: Buffer.from([128, 128]),
      now: new Date("2026-06-30T01:05:00.000Z")
    });
    expect(secondMaskResult.maskAsset.storedRelativePath).toBe("Book-assets/images/page-001-mask-002.png");
  });

  it("attaches maskAsset to inpainting result and links maskAssetId", () => {
    const sourcePageImage = {
      id: "page-image-original",
      pageNumber: 1,
      storedRelativePath: "Book-assets/images/source.png",
      originalFileName: "source.png",
      sha256: "a".repeat(64),
      byteSize: 4,
      mimeType: "image/png" as const,
      copiedAt: "2026-06-30T00:00:00.000Z"
    };
    const pageImage = {
      ...sourcePageImage,
      id: "page-image-inpainted",
      storedRelativePath: "Book-assets/images/inpainted.png",
      sha256: "b".repeat(64),
      byteSize: 8,
      copiedAt: "2026-06-30T01:02:03.000Z"
    };
    const maskAsset = {
      assetId: "mask-asset-1",
      source: "manual_local_edit" as const,
      sourcePageImageId: "page-image-original",
      runId: "manual-run-1",
      role: "mask" as const,
      storedRelativePath: "Book-assets/images/page-001-mask-001.png",
      sha256: "c".repeat(64),
      byteSize: 4,
      mimeType: "image/png" as const,
      createdAt: "2026-06-30T01:02:03.000Z"
    };

    const result = createManualInpaintingAdapterResult({
      sourcePageImage,
      pageImage,
      provider: "local-lama",
      runId: "manual-run-1",
      appVersion: "1.0.0",
      now: new Date("2026-06-30T01:02:03.000Z"),
      maskAsset
    });

    expect(result.maskAsset).toBe(maskAsset);
    expect(result.asset.maskAssetId).toBe("mask-asset-1");
  });
});
