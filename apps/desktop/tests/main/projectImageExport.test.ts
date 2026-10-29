// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile, rm, symlink } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectImageExportFileOps } from "../../src/main/projectImageExport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportProjectImages } from "../../src/main/projectImageExport";
import * as projectImageExportModule from "../../src/main/projectImageExport";
import { buildRenderReadinessReport } from "../../src/shared/renderReadiness";
import { createEmptyProject, normalizeEditableProject } from "../../src/shared/projectValidation";
import type { DialogueLine, PageImage } from "../../src/shared/projectTypes";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), realpath: vi.fn(actual.realpath), open: vi.fn(actual.open) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
beforeEach(() => {
  vi.mocked(fs.readFile).mockReset().mockImplementation(actualFs.readFile);
  vi.mocked(fs.realpath).mockReset().mockImplementation(actualFs.realpath);
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open);
});

type ResolveTrustedTypesetFontEvidence = (
  evidence: readonly {
    identity: string;
    resourceAvailable: boolean;
    metricsCalculated: boolean;
    glyphCoverageVerified: boolean;
  }[],
  verifyInstalledFontResource: (identity: string) => Promise<boolean>
) => Promise<{
  identity: string;
  resourceAvailable: boolean;
  metricsCalculated: boolean;
  glyphCoverageVerified: boolean;
} | undefined>;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createLine(): DialogueLine & { origin: { kind: "manual" } } {
  return {
    id: "line-1",
    order: 1,
    pageNumber: 1,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: "原文",
    userTranslation: "번역",
    parseConfidence: 1,
    parseWarnings: [],
    typesetting: { bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 }, writingMode: "horizontal-tb" },
    origin: { kind: "manual" }
  };
}

function createPageImage(id = "page-1", pageNumber = 1, bytes = Buffer.from("original")): PageImage {
  return {
    id,
    pageNumber,
    storedRelativePath: `sample-assets/images/page-${String(pageNumber).padStart(3, "0")}.jpg`,
    originalFileName: `page-${String(pageNumber).padStart(3, "0")}.jpg`,
    sha256: sha256(bytes),
    byteSize: bytes.byteLength,
    mimeType: "image/jpeg",
    copiedAt: "2026-08-22T00:00:00.000Z"
  };
}

async function createExportFixture(prefix: string): Promise<{
  root: string;
  projectPath: string;
  project: ReturnType<typeof normalizeEditableProject>;
  pageImage: PageImage;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectPath = join(root, "sample.ctp");
  const project = normalizeEditableProject(createEmptyProject("Export fixture", false));
  const pageImage = createPageImage();
  project.dialogueLines = [createLine()];
  project.pageImages = [pageImage];
  await mkdir(join(root, "sample-assets", "images"), { recursive: true });
  await writeFile(join(root, pageImage.storedRelativePath), Buffer.from("original"));
  await writeFile(projectPath, "placeholder", "utf8");
  return { root, projectPath, project, pageImage };
}

function createReadiness(
  project: ReturnType<typeof createEmptyProject>,
  pageImage: PageImage,
  revision: number,
  overrides: Partial<Parameters<typeof buildRenderReadinessReport>[0]> = {}
) {
  return buildRenderReadinessReport({
    pageImageId: pageImage.id,
    revision,
    resultRevision: revision,
    lines: project.dialogueLines.filter((line) => line.pageNumber === pageImage.pageNumber),
    font: {
      identity: "Pretendard@test",
      resourceAvailable: true,
      metricsCalculated: true,
      glyphCoverageVerified: true
    },
    ...overrides
  });
}

describe("project image export", () => {
  it.each(["size", "hash", "traversal", "resolved-outside"])("rejects an invalid original (%s) and continues with the next page", async (failure) => {
    const fixture = await createExportFixture("trio-export-original-boundary-");
    try {
      const goodPage = createPageImage("page-2", 2);
      fixture.project.pageImages.push(goodPage);
      await writeFile(join(fixture.root, goodPage.storedRelativePath), "original");
      if (failure === "size") fixture.pageImage.byteSize += 1;
      if (failure === "hash") fixture.pageImage.sha256 = "a".repeat(64);
      if (failure === "traversal") fixture.pageImage.storedRelativePath = "../outside.jpg";
      if (failure === "resolved-outside") {
        vi.mocked(fs.realpath).mockImplementation(async (path) => (
          String(path).endsWith("page-001.jpg") ? join(fixture.root, "..", "outside.jpg") : actualFs.realpath(path)
        ));
      }
      const result = await exportProjectImages({ project: fixture.project, projectRevision: 0,
        projectFilePath: fixture.projectPath, exportRoot: join(fixture.root, "exported") });
      expect(result.report.status).toBe("partial");
      expect(result.report.files.filter((file) => file.kind === "original").map((file) => file.pageImageId)).toEqual(["page-2"]);
      expect(result.report.failures).toContainEqual(expect.objectContaining({ pageImageId: "page-1", kind: "original", code: "ORIGINAL_COPY_FAILED" }));
      expect(await readFile(join(fixture.root, "exported", "original", "002-page-002-original.jpg"), "utf8")).toBe("original");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("exports exactly the validated original bytes if the source changes immediately after reading", async () => {
    const fixture = await createExportFixture("trio-export-original-reread-");
    try {
      const sourcePath = join(fixture.root, fixture.pageImage.storedRelativePath);
      const mutateSource = async () => writeFile(sourcePath, "replaced source bytes");
      vi.mocked(fs.readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
        const bytes = await actualFs.readFile(...args);
        if (String(args[0]).endsWith("page-001.jpg")) await mutateSource();
        return bytes;
      });
      vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await actualFs.open(...args);
        if (String(args[0]).endsWith("page-001.jpg")) {
          const read = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs: Parameters<typeof handle.readFile>) => {
            const bytes = await read(...readArgs);
            await mutateSource();
            return bytes;
          });
        }
        return handle;
      });
      const result = await exportProjectImages({ project: fixture.project, projectRevision: 0,
        projectFilePath: fixture.projectPath, exportRoot: join(fixture.root, "exported") });
      expect(await actualFs.readFile(sourcePath, "utf8")).toBe("replaced source bytes");
      const exported = await readFile(join(fixture.root, "exported", "original", "001-page-001-original.jpg"));
      expect(exported).toEqual(Buffer.from("original"));
      expect(result.report.files.find((file) => file.kind === "original")).toMatchObject({
        sourceSha256: sha256(exported), outputSha256: sha256(exported), byteSize: exported.length
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an original behind an actual external directory junction even with matching hash and size", async (context) => {
    const fixture = await createExportFixture("trio-export-original-junction-");
    try {
      const outside = await mkdtemp(join(fixture.root, "outside-"));
      const projectDir = join(fixture.root, "project");
      await mkdir(projectDir);
      await writeFile(join(outside, "page.jpg"), "original");
      try {
        await symlink(outside, join(projectDir, "linked"), process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        context.skip("EPERM: the environment does not permit a real directory junction/symlink fixture");
      }
      fixture.pageImage.storedRelativePath = "linked/page.jpg";
      const result = await exportProjectImages({ project: fixture.project, projectRevision: 0,
        projectFilePath: join(projectDir, "fixture.ctp"), exportRoot: join(fixture.root, "exported") });
      expect(result.report.files).toEqual([]);
      expect(result.report.failures).toContainEqual(expect.objectContaining({ kind: "original", code: "ORIGINAL_COPY_FAILED" }));
      expect(await readdir(join(fixture.root, "exported", "original"))).toEqual([]);
      expect(await readFile(join(outside, "page.jpg"), "utf8")).toBe("original");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("promotes matching renderer font evidence only after Main verifies the installed font identity", async () => {
    const resolveTrustedTypesetFontEvidence = (
      projectImageExportModule as typeof projectImageExportModule & {
        resolveTrustedTypesetFontEvidence: ResolveTrustedTypesetFontEvidence;
      }
    ).resolveTrustedTypesetFontEvidence;
    const evidence = {
      identity: "Pretendard Std Variable@1.3.9",
      resourceAvailable: true,
      metricsCalculated: true,
      glyphCoverageVerified: true
    } as const;
    const verifyInstalledFontResource = vi.fn(async (identity: string) => (
      identity === "Pretendard Std Variable@1.3.9"
    ));

    await expect(resolveTrustedTypesetFontEvidence(
      [evidence],
      verifyInstalledFontResource
    )).resolves.toEqual(evidence);
  });

  it("refuses mixed renderer font identities before consulting the Main verifier", async () => {
    const resolveTrustedTypesetFontEvidence = (
      projectImageExportModule as typeof projectImageExportModule & {
        resolveTrustedTypesetFontEvidence: ResolveTrustedTypesetFontEvidence;
      }
    ).resolveTrustedTypesetFontEvidence;
    const verifyInstalledFontResource = vi.fn(async () => true);

    await expect(resolveTrustedTypesetFontEvidence([
      {
        identity: "Pretendard Std Variable@1.3.9",
        resourceAvailable: true,
        metricsCalculated: true,
        glyphCoverageVerified: true
      },
      {
        identity: "Unexpected Font@1.0.0",
        resourceAvailable: true,
        metricsCalculated: true,
        glyphCoverageVerified: true
      }
    ], verifyInstalledFontResource)).resolves.toBeUndefined();
    expect(verifyInstalledFontResource).not.toHaveBeenCalled();
  });

  it("separates original, approved cleaned and render-ready typeset outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "trio-export-"));
    const projectPath = join(root, "sample.ctp");
    const project = createEmptyProject("Export", false);
    project.dialogueLines = [createLine()];
    project.pageImages = [{
      id: "page-1",
      pageNumber: 1,
      storedRelativePath: "sample-assets/images/page-001.jpg",
      originalFileName: "page-001.jpg",
      sha256: sha256(Buffer.from("original")),
      byteSize: Buffer.byteLength("original"),
      mimeType: "image/jpeg",
      copiedAt: "2026-08-22T00:00:00.000Z"
    }];
    project.processing.pages = [{
      pageImageId: "page-1",
      approvedCleanedAssetId: "cleaned-1",
      userReviewedCleanedAssetId: "cleaned-1",
      latestCompletedRunId: "run-1",
      finalStatus: "auto_approved",
      updatedAt: "2026-08-22T00:00:00.000Z",
      inpaintingQa: {
        qaStatus: "pass",
        cleanlinessScore: 1,
        residualRegions: [],
        attemptCount: 1,
        maxRetryAttempts: 2,
        evaluatedAt: "2026-08-22T00:00:00.000Z"
      }
    }];
    project.processing.runs = [{
      runId: "run-1",
      pageImageId: "page-1",
      source: "manual_local_edit",
      status: "completed",
      sourceSha256: sha256(Buffer.from("original")),
      appVersion: "test",
      queuedAt: "2026-08-22T00:00:00.000Z",
      startedAt: "2026-08-22T00:00:00.000Z",
      completedAt: "2026-08-22T00:00:00.000Z"
    }];
    project.processing.assets = [{
      assetId: "cleaned-1",
      source: "manual_local_edit",
      sourcePageImageId: "page-1",
      runId: "run-1",
      role: "cleaned",
      storedRelativePath: "sample-assets/images/cleaned-001.png",
      sha256: sha256(Buffer.from("cleaned")),
      byteSize: Buffer.byteLength("cleaned"),
      mimeType: "image/png",
      createdAt: "2026-08-22T00:00:00.000Z"
    }];
    await mkdir(join(root, "sample-assets", "images"), { recursive: true });
    await writeFile(join(root, "sample-assets", "images", "page-001.jpg"), Buffer.from("original"));
    await writeFile(join(root, "sample-assets", "images", "cleaned-001.png"), Buffer.from("cleaned"));
    await writeFile(projectPath, "placeholder", "utf8");
    const persistedProject = normalizeEditableProject(project);

    const readiness = buildRenderReadinessReport({
      pageImageId: "page-1",
      revision: 2,
      resultRevision: 2,
      lines: persistedProject.dialogueLines,
      approvedCleanedAssetId: "cleaned-1",
      cleanedAssetQaStatus: "pass",
      font: { identity: "Pretendard@test", resourceAvailable: true, metricsCalculated: true, glyphCoverageVerified: true }
    });
    const outputRoot = join(root, "exported");
    const result = await exportProjectImages({
      project: persistedProject,
      projectRevision: 2,
      projectFilePath: projectPath,
      exportRoot: outputRoot,
      trustedTypesetFontEvidence: readiness.evidence.font,
      typesetPages: [{ pageImageId: "page-1", pngBytes: png, readiness }],
      includeZip: true,
      now: new Date("2026-08-22T00:00:00.000Z")
    });

    expect(result.report.status).toBe("completed");
    expect(readiness.evidence.font.glyphCoverageVerified).toBe(true);
    expect(result.report.files.map((file) => file.kind)).toEqual(["original", "cleaned", "typeset"]);
    expect(result.manifest.files.find((file) => file.kind === "typeset")?.sourceSha256).toBe(sha256(Buffer.from("cleaned")));
    expect(await stat(join(outputRoot, "original", "001-page-001-original.jpg"))).toBeDefined();
    expect(await stat(join(outputRoot, "cleaned", "001-page-001-cleaned.png"))).toBeDefined();
    expect(await stat(join(outputRoot, "typeset", "001-page-001-typeset.png"))).toBeDefined();
    expect(result.zipPath).toBeDefined();
    expect((await readFile(result.zipPath!)).readUInt32LE(0)).toBe(0x04034b50);
    await rm(root, { recursive: true, force: true });
  });

  it("does not invent a cleaned failure when cleanup was never requested, but reports AI-only typeset output", async () => {
    const root = await mkdtemp(join(tmpdir(), "trio-export-blocked-"));
    const projectPath = join(root, "sample.ctp");
    const project = createEmptyProject("Export blocked", false);
    project.dialogueLines = [{ ...createLine(), userTranslation: undefined, aiTranslation: "AI" }];
    project.pageImages = [{
      id: "page-1",
      pageNumber: 1,
      storedRelativePath: "sample-assets/images/page-001.jpg",
      originalFileName: "page-001.jpg",
      sha256: sha256(Buffer.from("original")),
      byteSize: Buffer.byteLength("original"),
      mimeType: "image/jpeg",
      copiedAt: "2026-08-22T00:00:00.000Z"
    }];
    await mkdir(join(root, "sample-assets", "images"), { recursive: true });
    await writeFile(join(root, "sample-assets", "images", "page-001.jpg"), Buffer.from("original"));
    await writeFile(projectPath, "placeholder", "utf8");
    const persistedProject = normalizeEditableProject(project);

    const readiness = buildRenderReadinessReport({
      pageImageId: "page-1",
      revision: 1,
      resultRevision: 1,
      lines: persistedProject.dialogueLines,
      font: { identity: "Pretendard@test", resourceAvailable: true, metricsCalculated: true, glyphCoverageVerified: true }
    });
    const result = await exportProjectImages({
      project: persistedProject,
      projectRevision: 1,
      projectFilePath: projectPath,
      exportRoot: join(root, "exported"),
      typesetPages: [{ pageImageId: "page-1", pngBytes: png, readiness }]
    });

    expect(result.report.status).toBe("partial");
    expect(result.report.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
      "TYPESET_NOT_RENDER_READY"
    ]));
    expect(result.report.failures.some((failure) => failure.code === "CLEANED_ASSET_NOT_APPROVED")).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a stale typeset readiness report even when its own report was ready", async () => {
    const fixture = await createExportFixture("trio-export-stale-");
    try {
      const project = normalizeEditableProject(fixture.project);
      const readiness = createReadiness(fixture.project, fixture.pageImage, 1);
      const result = await exportProjectImages({
        project,
        projectRevision: 2,
        projectFilePath: fixture.projectPath,
        exportRoot: join(fixture.root, "exported"),
        typesetPages: [{ pageImageId: fixture.pageImage.id, pngBytes: png, readiness }]
      });

      expect(result.report.files.map((file) => file.kind)).toEqual(["original"]);
      expect(result.report.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "typeset", code: "TYPESET_NOT_RENDER_READY" })
      ]));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a typeset readiness report whose user translation fingerprint is stale", async () => {
    const fixture = await createExportFixture("trio-export-fingerprint-");
    try {
      const project = normalizeEditableProject(fixture.project);
      const readiness = createReadiness(fixture.project, fixture.pageImage, 1);
      readiness.userTranslationFingerprint = "tampered";
      const result = await exportProjectImages({
        project,
        projectRevision: 1,
        projectFilePath: fixture.projectPath,
        exportRoot: join(fixture.root, "exported"),
        typesetPages: [{ pageImageId: fixture.pageImage.id, pngBytes: png, readiness }]
      });

      expect(result.report.files.map((file) => file.kind)).toEqual(["original"]);
      expect(result.report.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "typeset",
          code: "TYPESET_NOT_RENDER_READY",
          message: expect.stringContaining("user translation fingerprint")
        })
      ]));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not accept renderer-positive font evidence without Main verification", async () => {
    const fixture = await createExportFixture("trio-export-untrusted-font-");
    try {
      const project = normalizeEditableProject(fixture.project);
      const readiness = createReadiness(fixture.project, fixture.pageImage, 1);
      const result = await exportProjectImages({
        project,
        projectRevision: 1,
        projectFilePath: fixture.projectPath,
        exportRoot: join(fixture.root, "exported"),
        typesetPages: [{ pageImageId: fixture.pageImage.id, pngBytes: png, readiness }]
      });

      expect(result.report.files.map((file) => file.kind)).toEqual(["original"]);
      expect(result.report.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "typeset",
          code: "TYPESET_NOT_RENDER_READY",
          message: expect.stringContaining("Main font resource evidence")
        })
      ]));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("never exports a cleaned asset or accepts typeset approval when cleaned QA is not PASS", async () => {
    const fixture = await createExportFixture("trio-export-qa-");
    try {
      const cleanedBytes = Buffer.from("cleaned");
      fixture.project.processing.pages = [{
        pageImageId: fixture.pageImage.id,
        approvedCleanedAssetId: "cleaned-1",
        latestCompletedRunId: "run-1",
        finalStatus: "needs_review",
        updatedAt: "2026-08-22T00:00:00.000Z",
        inpaintingQa: {
          qaStatus: "retry",
          cleanlinessScore: 0.5,
          residualRegions: [],
          attemptCount: 1,
          maxRetryAttempts: 2,
          evaluatedAt: "2026-08-22T00:00:00.000Z"
        }
      }];
      fixture.project.processing.runs = [{
        runId: "run-1",
        pageImageId: fixture.pageImage.id,
        source: "manual_local_edit",
        status: "completed",
        sourceSha256: fixture.pageImage.sha256,
        appVersion: "test",
        queuedAt: "2026-08-22T00:00:00.000Z"
      }];
      fixture.project.processing.assets = [{
        assetId: "cleaned-1",
        source: "manual_local_edit",
        sourcePageImageId: fixture.pageImage.id,
        runId: "run-1",
        role: "cleaned",
        storedRelativePath: "sample-assets/images/cleaned-001.png",
        sha256: sha256(cleanedBytes),
        byteSize: cleanedBytes.byteLength,
        mimeType: "image/png",
        createdAt: "2026-08-22T00:00:00.000Z"
      }];
      await writeFile(join(fixture.root, "sample-assets", "images", "cleaned-001.png"), cleanedBytes);
      const project = normalizeEditableProject(fixture.project);
      const readiness = createReadiness(fixture.project, fixture.pageImage, 1, {
        approvedCleanedAssetId: "cleaned-1",
        cleanedAssetQaStatus: "retry",
        cleanedAssetRequired: true
      });
      const result = await exportProjectImages({
        project,
        projectRevision: 1,
        projectFilePath: fixture.projectPath,
        exportRoot: join(fixture.root, "exported"),
        typesetPages: [{ pageImageId: fixture.pageImage.id, pngBytes: png, readiness }]
      });

      expect(result.report.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
        "CLEANED_ASSET_QA_NOT_PASS",
        "TYPESET_NOT_RENDER_READY"
      ]));
      expect(result.report.files.map((file) => file.kind)).toEqual(["original"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports a wrong-page cleaned asset reference and never uses it for typeset approval", async () => {
    const fixture = await createExportFixture("trio-export-wrong-page-");
    try {
      fixture.project.processing.pages = [{
        pageImageId: fixture.pageImage.id,
        approvedCleanedAssetId: "cleaned-1",
        latestCompletedRunId: "run-1",
        finalStatus: "auto_approved",
        updatedAt: "2026-08-22T00:00:00.000Z",
        inpaintingQa: {
          qaStatus: "pass",
          cleanlinessScore: 1,
          residualRegions: [],
          attemptCount: 1,
          maxRetryAttempts: 2,
          evaluatedAt: "2026-08-22T00:00:00.000Z"
        }
      }];
      fixture.project.processing.runs = [{
        runId: "run-1",
        pageImageId: "page-2",
        source: "manual_local_edit",
        status: "completed",
        sourceSha256: fixture.pageImage.sha256,
        appVersion: "test",
        queuedAt: "2026-08-22T00:00:00.000Z"
      }];
      fixture.project.processing.assets = [{
        assetId: "cleaned-1",
        source: "manual_local_edit",
        sourcePageImageId: "page-2",
        runId: "run-1",
        role: "cleaned",
        storedRelativePath: "sample-assets/images/cleaned-001.png",
        sha256: sha256(Buffer.from("cleaned")),
        byteSize: Buffer.byteLength("cleaned"),
        mimeType: "image/png",
        createdAt: "2026-08-22T00:00:00.000Z"
      }];
      await writeFile(join(fixture.root, "sample-assets", "images", "cleaned-001.png"), Buffer.from("cleaned"));
      const project = normalizeEditableProject(fixture.project);
      const readiness = createReadiness(fixture.project, fixture.pageImage, 1, {
        cleanedAssetRequired: true
      });
      const result = await exportProjectImages({
        project,
        projectRevision: 1,
        projectFilePath: fixture.projectPath,
        exportRoot: join(fixture.root, "exported"),
        typesetPages: [{ pageImageId: fixture.pageImage.id, pngBytes: png, readiness }]
      });

      expect(result.report.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
        "CLEANED_ASSET_INVALID_REFERENCE",
        "TYPESET_NOT_RENDER_READY"
      ]));
      expect(result.report.files.map((file) => file.kind)).toEqual(["original"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an approved cleaned asset from a run other than the page latest completed run", async () => {
    const fixture = await createExportFixture("trio-export-wrong-run-");
    try {
      fixture.project.processing.pages = [{
        pageImageId: fixture.pageImage.id,
        latestCompletedRunId: "run-current",
        approvedCleanedAssetId: "cleaned-1",
        finalStatus: "auto_approved",
        updatedAt: "2026-08-22T00:00:00.000Z",
        inpaintingQa: {
          qaStatus: "pass",
          cleanlinessScore: 1,
          residualRegions: [],
          attemptCount: 1,
          maxRetryAttempts: 2,
          evaluatedAt: "2026-08-22T00:00:00.000Z"
        }
      }];
      fixture.project.processing.runs = [
        {
          runId: "run-current",
          pageImageId: fixture.pageImage.id,
          source: "manual_local_edit",
          status: "completed",
          sourceSha256: fixture.pageImage.sha256,
          appVersion: "test",
          queuedAt: "2026-08-22T00:00:00.000Z"
        },
        {
          runId: "run-old",
          pageImageId: fixture.pageImage.id,
          source: "manual_local_edit",
          status: "completed",
          sourceSha256: fixture.pageImage.sha256,
          appVersion: "test",
          queuedAt: "2026-08-21T00:00:00.000Z"
        }
      ];
      fixture.project.processing.assets = [{
        assetId: "cleaned-1",
        source: "manual_local_edit",
        sourcePageImageId: fixture.pageImage.id,
        runId: "run-old",
        role: "cleaned",
        storedRelativePath: "sample-assets/images/cleaned-001.png",
        sha256: sha256(Buffer.from("cleaned")),
        byteSize: Buffer.byteLength("cleaned"),
        mimeType: "image/png",
        createdAt: "2026-08-21T00:00:00.000Z"
      }];
      await writeFile(join(fixture.root, "sample-assets", "images", "cleaned-001.png"), Buffer.from("cleaned"));
      const project = normalizeEditableProject(fixture.project);
      const readiness = createReadiness(fixture.project, fixture.pageImage, 1, {
        cleanedAssetRequired: true
      });
      const result = await exportProjectImages({
        project,
        projectRevision: 1,
        projectFilePath: fixture.projectPath,
        exportRoot: join(fixture.root, "exported"),
        typesetPages: [{ pageImageId: fixture.pageImage.id, pngBytes: png, readiness }]
      });

      expect(result.report.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
        "CLEANED_ASSET_INVALID_REFERENCE",
        "TYPESET_NOT_RENDER_READY"
      ]));
      expect(result.report.files.map((file) => file.kind)).toEqual(["original"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an approved cleaned asset when the page latest completed run is not completed", async () => {
    const fixture = await createExportFixture("trio-export-incomplete-run-");
    try {
      fixture.project.processing.pages = [{
        pageImageId: fixture.pageImage.id,
        latestCompletedRunId: "run-1",
        approvedCleanedAssetId: "cleaned-1",
        finalStatus: "auto_approved",
        updatedAt: "2026-08-22T00:00:00.000Z",
        inpaintingQa: {
          qaStatus: "pass",
          cleanlinessScore: 1,
          residualRegions: [],
          attemptCount: 1,
          maxRetryAttempts: 2,
          evaluatedAt: "2026-08-22T00:00:00.000Z"
        }
      }];
      fixture.project.processing.runs = [{
        runId: "run-1",
        pageImageId: fixture.pageImage.id,
        source: "manual_local_edit",
        status: "running",
        sourceSha256: fixture.pageImage.sha256,
        appVersion: "test",
        queuedAt: "2026-08-22T00:00:00.000Z",
        startedAt: "2026-08-22T00:00:00.000Z"
      }];
      fixture.project.processing.assets = [{
        assetId: "cleaned-1",
        source: "manual_local_edit",
        sourcePageImageId: fixture.pageImage.id,
        runId: "run-1",
        role: "cleaned",
        storedRelativePath: "sample-assets/images/cleaned-001.png",
        sha256: sha256(Buffer.from("cleaned")),
        byteSize: Buffer.byteLength("cleaned"),
        mimeType: "image/png",
        createdAt: "2026-08-22T00:00:00.000Z"
      }];
      await writeFile(join(fixture.root, "sample-assets", "images", "cleaned-001.png"), Buffer.from("cleaned"));
      const project = normalizeEditableProject(fixture.project);
      const readiness = createReadiness(fixture.project, fixture.pageImage, 1, {
        cleanedAssetRequired: true
      });
      const result = await exportProjectImages({
        project,
        projectRevision: 1,
        projectFilePath: fixture.projectPath,
        exportRoot: join(fixture.root, "exported"),
        typesetPages: [{ pageImageId: fixture.pageImage.id, pngBytes: png, readiness }]
      });

      expect(result.report.failures.map((failure) => failure.code)).toEqual(expect.arrayContaining([
        "CLEANED_ASSET_INVALID_REFERENCE",
        "TYPESET_NOT_RENDER_READY"
      ]));
      expect(result.report.files.map((file) => file.kind)).toEqual(["original"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps original and remaining typeset exports when one page has no typeset render", async () => {
    const root = await mkdtemp(join(tmpdir(), "trio-export-partial-typeset-"));
    const projectPath = join(root, "sample.ctp");
    const project = createEmptyProject("Partial typeset export", false);
    const page1Bytes = Buffer.from("original-1");
    const page2Bytes = Buffer.from("original-2");
    const page3Bytes = Buffer.from("original-3");
    const page1 = createPageImage("page-1", 1, page1Bytes);
    const page2 = createPageImage("page-2", 2, page2Bytes);
    const page3 = createPageImage("page-3", 3, page3Bytes);
    project.pageImages = [page1, page2, page3];
    project.dialogueLines = [
      { ...createLine(), id: "line-1", pageNumber: 1, order: 1 },
      { ...createLine(), id: "line-2", pageNumber: 2, order: 2 },
      { ...createLine(), id: "line-3", pageNumber: 3, order: 3 }
    ];
    await mkdir(join(root, "sample-assets", "images"), { recursive: true });
    await writeFile(join(root, page1.storedRelativePath), page1Bytes);
    await writeFile(join(root, page2.storedRelativePath), page2Bytes);
    await writeFile(join(root, page3.storedRelativePath), page3Bytes);
    await writeFile(projectPath, "placeholder", "utf8");
    const persistedProject = normalizeEditableProject(project);
    const readiness1 = createReadiness(persistedProject, page1, 1);
    const readiness3 = createReadiness(persistedProject, page3, 1);

    try {
      const result = await exportProjectImages({
        project: persistedProject,
        projectRevision: 1,
        projectFilePath: projectPath,
        exportRoot: join(root, "exported"),
        trustedTypesetFontEvidence: readiness1.evidence.font,
        typesetPages: [
          { pageImageId: page1.id, pngBytes: png, readiness: readiness1 },
          { pageImageId: page3.id, pngBytes: png, readiness: readiness3 }
        ]
      });

      expect(result.report.status).toBe("partial");
      expect(result.report.files.filter((file) => file.kind === "original").map((file) => file.pageImageId)).toEqual([
        "page-1",
        "page-2",
        "page-3"
      ]);
      expect(result.report.files.filter((file) => file.kind === "typeset").map((file) => file.pageImageId)).toEqual([
        "page-1",
        "page-3"
      ]);
      expect(result.report.failures).toEqual([
        expect.objectContaining({
          pageImageId: "page-2",
          kind: "typeset",
          code: "TYPESET_RENDER_NOT_PROVIDED"
        })
      ]);
      expect(await stat(join(root, "exported", "original", "002-page-002-original.jpg"))).toBeDefined();
      expect(await stat(join(root, "exported", "typeset", "001-page-001-typeset.png"))).toBeDefined();
      expect(await stat(join(root, "exported", "typeset", "003-page-003-typeset.png"))).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a final directory or zip when directory publish fails", async () => {
    const fixture = await createExportFixture("trio-export-dir-publish-fail-");
    const exportRoot = join(fixture.root, "exported");
    const zipPath = `${exportRoot}.zip`;
    try {
      await expect(exportProjectImages({
        ...minimalExportArgs(fixture, exportRoot, true),
        fileOps: failingRenameFileOps(() => true)
      })).rejects.toThrow("DIR_PUBLISH_FAILED");

      expect(await pathExists(exportRoot)).toBe(false);
      expect(await pathExists(zipPath)).toBe(false);
      expect(await listPartialArtifacts(fixture.root)).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back the final directory when zip publish fails so the same target can be retried", async () => {
    const fixture = await createExportFixture("trio-export-zip-publish-fail-");
    const exportRoot = join(fixture.root, "exported");
    const zipPath = `${exportRoot}.zip`;
    try {
      await expect(exportProjectImages({
        ...minimalExportArgs(fixture, exportRoot, true),
        fileOps: failingRenameFileOps((destination) => String(destination).endsWith(".zip"))
      })).rejects.toThrow("ZIP_PUBLISH_FAILED");

      expect(await pathExists(exportRoot)).toBe(false);
      expect(await pathExists(zipPath)).toBe(false);
      expect(await listPartialArtifacts(fixture.root)).toEqual([]);

      const result = await exportProjectImages(minimalExportArgs(fixture, exportRoot, true));
      expect(result.exportRoot).toBe(exportRoot);
      expect(result.zipPath).toBe(zipPath);
      expect(await pathExists(exportRoot)).toBe(true);
      expect(await pathExists(zipPath)).toBe(true);
      expect((await readFile(zipPath)).readUInt32LE(0)).toBe(0x04034b50);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not delete a zip that this run did not publish when rolling back the directory", async () => {
    const fixture = await createExportFixture("trio-export-foreign-zip-");
    const exportRoot = join(fixture.root, "exported");
    const zipPath = `${exportRoot}.zip`;
    try {
      await expect(exportProjectImages({
        ...minimalExportArgs(fixture, exportRoot, true),
        fileOps: {
          rename: async (source, destination) => {
            const result = await rename(source, destination);
            if (!String(destination).endsWith(".zip")) {
              await writeFile(zipPath, "keep-zip", "utf8");
            }
            return result;
          },
          rm
        }
      })).rejects.toThrow("EXPORT_ZIP_EXISTS");

      expect(await pathExists(exportRoot)).toBe(false);
      expect(await readFile(zipPath, "utf8")).toBe("keep-zip");
      expect(await listPartialArtifacts(fixture.root)).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not delete a pre-existing export directory or zip", async () => {
    const fixture = await createExportFixture("trio-export-preexisting-");
    const exportRoot = join(fixture.root, "exported");
    const zipPath = `${exportRoot}.zip`;
    try {
      await mkdir(exportRoot);
      await writeFile(join(exportRoot, "keep.txt"), "keep-dir", "utf8");
      await expect(exportProjectImages(minimalExportArgs(fixture, exportRoot, true)))
        .rejects.toThrow("EXPORT_ROOT_EXISTS");
      expect(await readFile(join(exportRoot, "keep.txt"), "utf8")).toBe("keep-dir");
      expect(await pathExists(zipPath)).toBe(false);

      await rm(exportRoot, { recursive: true, force: true });
      await writeFile(zipPath, "keep-zip", "utf8");
      await expect(exportProjectImages(minimalExportArgs(fixture, exportRoot, true)))
        .rejects.toThrow("EXPORT_ZIP_EXISTS");
      expect(await readFile(zipPath, "utf8")).toBe("keep-zip");
      expect(await pathExists(exportRoot)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not confuse a logical partial report with a filesystem publish failure", async () => {
    const fixture = await createExportFixture("trio-export-logical-partial-");
    const exportRoot = join(fixture.root, "exported");
    const zipPath = `${exportRoot}.zip`;
    try {
      const result = await exportProjectImages(minimalExportArgs(fixture, exportRoot, true));
      expect(result.report.status).toBe("partial");
      expect(result.report.failures.map((failure) => failure.code)).toEqual([
        "TYPESET_RENDER_NOT_PROVIDED"
      ]);
      expect(result.zipPath).toBe(zipPath);
      expect(await pathExists(join(exportRoot, "original", "001-page-001-original.jpg"))).toBe(true);
      expect(await pathExists(zipPath)).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("exports a folder only when includeZip is false", async () => {
    const fixture = await createExportFixture("trio-export-folder-only-");
    const exportRoot = join(fixture.root, "exported");
    try {
      const result = await exportProjectImages(minimalExportArgs(fixture, exportRoot, false));
      expect(result.zipPath).toBeUndefined();
      expect(await pathExists(exportRoot)).toBe(true);
      expect(await pathExists(`${exportRoot}.zip`)).toBe(false);
      expect(await pathExists(join(exportRoot, "report.json"))).toBe(true);
      expect(await pathExists(join(exportRoot, "manifest.json"))).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function minimalExportArgs(
  fixture: Awaited<ReturnType<typeof createExportFixture>>,
  exportRoot: string,
  includeZip: boolean
) {
  return {
    project: normalizeEditableProject(fixture.project),
    projectRevision: 1,
    projectFilePath: fixture.projectPath,
    exportRoot,
    includeZip
  };
}

function failingRenameFileOps(shouldFail: (destination: string) => boolean): ProjectImageExportFileOps {
  return {
    rename: async (source, destination) => {
      if (shouldFail(String(destination))) {
        throw new Error(String(destination).endsWith(".zip") ? "ZIP_PUBLISH_FAILED" : "DIR_PUBLISH_FAILED");
      }
      return rename(source, destination);
    },
    rm
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listPartialArtifacts(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes(".partial-"));
}
