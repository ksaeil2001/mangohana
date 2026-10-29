// @vitest-environment node
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectSessionManager } from "../../src/main/projectSessions";
import { loadProjectFile, loadProjectFileWithRecovery, saveProjectFile } from "../../src/main/projectStorage";
import { applyMainProjectPatch, applyNormalizedProjectMutation, replayPendingUserMutations } from "../../src/main/projectReplay";
import { exportProjectImages } from "../../src/main/projectImageExport";
import { loadIncrementalProject, saveIncrementalProject } from "../../src/main/incrementalProjectStorage";
import { createProjectChunkTracker } from "../../src/main/projectChunkManager";
import { createSecretProtection, zeroizeProtection } from "../../src/main/projectProtection";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import { createApprovedInpaintingPageRecord } from "../../src/shared/inpainting";
import { composeProjectFromChunks, decomposeProjectToChunks } from "../../src/shared/projectChunkAdapter";
import { buildRenderReadinessReport } from "../../src/shared/renderReadiness";
import { readVerifiedCleanedAsset } from "../../src/main/cleanedAssetReview";
import type { TranslationProjectV2 } from "../../src/shared/projectTypes";

const roots: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, realpath: vi.fn(actual.realpath), open: vi.fn(actual.open) };
});
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const original = Buffer.from("isolated original image");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const timestamp = "2026-10-29T00:00:00.000Z";
const font = { identity: "fixture-font", resourceAvailable: true, metricsCalculated: true, glyphCoverageVerified: true };
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

beforeEach(() => {
  vi.mocked(fs.realpath).mockReset().mockImplementation(actualFs.realpath);
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const inside = relative(resolve(tmpdir()), resolve(root));
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || !inside.startsWith("mangohana-review-")) {
      throw new Error(`Refusing test cleanup outside isolated temporary directory: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

function projectFixture(): TranslationProjectV2 {
  const project = normalizeProject(createEmptyProject("저장된 제목", false));
  project.pageImages = [{ id: "page-1", pageNumber: 1, storedRelativePath: "assets/original.png", originalFileName: "original.png",
    sha256: hash(original), byteSize: original.length, mimeType: "image/png", copiedAt: timestamp }];
  project.processing = {
    pages: [{ pageImageId: "page-1", latestCompletedRunId: "run-1", approvedCleanedAssetId: "cleaned-1", finalStatus: "auto_approved", updatedAt: timestamp }],
    runs: [{ runId: "run-1", pageImageId: "page-1", source: "manual_local_edit", status: "completed", sourceSha256: hash(original), appVersion: "fixture", queuedAt: timestamp }],
    assets: [{ assetId: "cleaned-1", role: "cleaned", runId: "run-1", sourcePageImageId: "page-1", source: "manual_local_edit", storedRelativePath: "assets/cleaned.png",
      sha256: hash(png), byteSize: png.length, mimeType: "image/png", createdAt: timestamp,
      inpaintingQa: { qaStatus: "pass", cleanlinessScore: 1, residualRegions: [], attemptCount: 1, maxRetryAttempts: 2, evaluatedAt: timestamp } }]
  };
  return project;
}

async function diskFixture(project = projectFixture()) {
  const root = await mkdtemp(join(tmpdir(), "mangohana-review-"));
  roots.push(root);
  const directory = join(root, "project");
  const filePath = join(directory, "fixture.ctp");
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(join(directory, "assets/original.png"), original);
  await writeFile(join(directory, "assets/cleaned.png"), png);
  return { root, directory, filePath, project };
}

function reviewArgs(projectSessionId: string, expectedRevision = 0) {
  return { projectSessionId, pageImageId: "page-1", cleanedAssetId: "cleaned-1", expectedRevision };
}

function reviewed(project = projectFixture()) {
  project.processing.pages[0]!.userReviewedCleanedAssetId = "cleaned-1";
  return project;
}

describe("cleaned result user review invalidation", () => {
  it("keeps legacy files valid and rejects invalid optional review values", () => {
    expect(normalizeProject(projectFixture()).processing.pages[0]!.userReviewedCleanedAssetId).toBeUndefined();
    expect(normalizeProject(reviewed()).processing.pages[0]!.userReviewedCleanedAssetId).toBe("cleaned-1");
    for (const value of ["", 42, null]) {
      const invalid = projectFixture();
      Object.assign(invalid.processing.pages[0]!, { userReviewedCleanedAssetId: value });
      expect(() => normalizeProject(invalid)).toThrow();
    }
  });

  it("strips review from every new result, including reused asset IDs", () => {
    const project = reviewed();
    const record = createApprovedInpaintingPageRecord({ pageImage: project.pageImages[0]!, run: project.processing.runs[0]!, asset: project.processing.assets[0]! }, project.processing.pages[0]);
    expect(record.userReviewedCleanedAssetId).toBeUndefined();
    const committed = applyMainProjectPatch(project, { type: "commit_processing_run", run: project.processing.runs[0]!, assets: project.processing.assets, pageRecord: project.processing.pages[0]! });
    expect(committed.processing.pages[0]!.userReviewedCleanedAssetId).toBeUndefined();
  });

  it("does not revive review after pointer A → B → A", () => {
    let project = reviewed();
    for (const assetId of ["cleaned-2", "cleaned-1"]) {
      project = applyMainProjectPatch(project, { type: "approve_asset", pageImageId: "page-1", kind: "cleaned", assetId });
    }
    expect(project.processing.pages[0]!.userReviewedCleanedAssetId).toBeUndefined();
  });

  it.each(["sha256", "storedRelativePath"] as const)("does not revive review after same-ID source %s A → B → A or pending replay", (field) => {
    const project = reviewed();
    const page = project.pageImages[0]!;
    const replacements = [{ ...page, [field]: field === "sha256" ? "b".repeat(64) : "assets/replaced.png" }, page];
    const replayed = replayPendingUserMutations(project, replacements.map((replacement, index) => ({
      mutationId: `mutation-${index}`, acceptedRevision: index + 1, changedPaths: ["pageImages"], createdAt: timestamp,
      mutation: { type: "register_page_images" as const, pageImages: [replacement] }
    })));
    expect(replayed.processing.pages[0]!.userReviewedCleanedAssetId).toBeUndefined();
  });

  it("invalidates review on page removal before an old page is replayed", () => {
    const project = reviewed();
    const removed = applyNormalizedProjectMutation(project, { type: "remove_page_image", pageImageId: "page-1" });
    const restored = applyNormalizedProjectMutation(removed, { type: "register_page_images", pageImages: project.pageImages });
    expect(restored.processing.pages[0]?.userReviewedCleanedAssetId).toBeUndefined();
  });
});

describe("Main-only cleaned result review", () => {
  it.each([false, true])("persists only review and retains pending edits, plain/encrypted=%s", async (secret) => {
    const fixture = await diskFixture();
    fixture.project.metadata.secret = secret;
    const manager = createProjectSessionManager();
    const session = secret
      ? manager.createSecretProjectSession({ project: fixture.project, filePath: fixture.filePath, password: "isolated-test-password" })
      : manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    await manager.saveProject({ projectSessionId: session.projectSessionId });
    const legacy = await loadProjectFile({ filePath: fixture.filePath, ...(secret ? { password: "isolated-test-password" } : {}) });
    expect(legacy.project.processing.pages[0]!.userReviewedCleanedAssetId).toBeUndefined();
    await manager.applyProjectMutation({ projectSessionId: session.projectSessionId, baseRevision: 0, mutation: { type: "set_project_title", title: "미저장 제목" } });
    const result = await manager.reviewCleanedAsset(reviewArgs(session.projectSessionId, 1));
    expect(result.project.revision).toBe(2);
    expect(result.project.dirty).toBe(true);
    expect(result.project.project.metadata.title).toBe("미저장 제목");
    expect(result.project.project.processing.pages[0]!.userReviewedCleanedAssetId).toBe("cleaned-1");
    const reopened = await loadProjectFile({ filePath: fixture.filePath, ...(secret ? { password: "isolated-test-password" } : {}) });
    expect(reopened.project.metadata.title).toBe("저장된 제목");
    expect(reopened.project.processing.pages[0]!.userReviewedCleanedAssetId).toBe("cleaned-1");
    const chunks = decomposeProjectToChunks(normalizeProject(reopened.project));
    expect(composeProjectFromChunks(chunks).processing.pages[0]!.userReviewedCleanedAssetId).toBe("cleaned-1");
    await manager.saveProject({ projectSessionId: session.projectSessionId });
    expect((await loadProjectFile({ filePath: fixture.filePath, ...(secret ? { password: "isolated-test-password" } : {}) })).project.metadata.title).toBe("미저장 제목");
    await manager.closeProject({ projectSessionId: session.projectSessionId });
  });

  it.each([false, true])("persists the optional review through actual chunk storage, encrypted=%s", async (secret) => {
    const fixture = await diskFixture();
    fixture.project.metadata.secret = secret;
    fixture.project.pageImages.push({ ...fixture.project.pageImages[0]!, id: "page-2", pageNumber: 2 });
    const initial = decomposeProjectToChunks(fixture.project);
    const password = secret ? "isolated-chunk-password" : undefined;
    const protection = secret ? createSecretProtection(password!) : undefined;
    const targetDirectory = join(fixture.root, "chunks-project");
    await saveIncrementalProject({ targetDirectory, manifest: initial.manifest, dirtyChunks: initial.chunks, allPageNumbers: [1, 2], protection });
    const tracker = createProjectChunkTracker(fixture.project, initial.manifest.security);
    tracker.syncFromProject(reviewed(fixture.project), initial.manifest.security);
    expect(tracker.getDirtyPageNumbers()).toEqual([1]);
    await saveIncrementalProject({ targetDirectory, manifest: tracker.getManifest(), dirtyChunks: [tracker.getPageChunk(1)!], allPageNumbers: [1, 2], protection });
    const loaded = await loadIncrementalProject({ targetDirectory, password });
    expect((await loaded.chunkLoader(1))?.pageProcessing?.userReviewedCleanedAssetId).toBe("cleaned-1");
    expect((await loaded.chunkLoader(2))?.pageProcessing?.userReviewedCleanedAssetId).toBeUndefined();
    if (protection) zeroizeProtection(protection);
    if (loaded.protection) zeroizeProtection(loaded.protection);
  });

  it.each([[false, "candidate"], [true, "candidate"], [false, "bak"], [true, "bak"]] as const)("retains review through validated recovery, encrypted=%s, %s", async (secret, recoveryFile) => {
    const fixture = await diskFixture();
    fixture.project.metadata.secret = secret;
    const password = secret ? "isolated-recovery-password" : undefined;
    await saveProjectFile({ filePath: fixture.filePath, project: reviewed(fixture.project), password });
    await copyFile(fixture.filePath, `${fixture.filePath}.${recoveryFile}`);
    await writeFile(fixture.filePath, "invalid isolated current file");
    const recovered = await loadProjectFileWithRecovery({ filePath: fixture.filePath, password });
    expect(recovered.project.processing.pages[0]!.userReviewedCleanedAssetId).toBe("cleaned-1");
    const preservedInvalidPath = recoveryFile === "candidate" ? `${fixture.filePath}.bak` : `${fixture.filePath}.recovery-invalid`;
    expect(await readFile(preservedInvalidPath, "utf8")).toBe("invalid isolated current file");
  });

  it.each(["revision", "page", "asset", "asset-page", "asset-role", "run-id", "run-provider", "latest-run", "active-run", "run-source", "run-status", "page-qa", "asset-qa", "no-qa", "asset-size", "asset-hash", "source-hash", "missing-file", "not-saved", "other-session"])("rejects %s without changing state or writing", async (failure) => {
    const fixture = await diskFixture();
    const args = reviewArgs("unused");
    if (failure === "revision") args.expectedRevision = 1;
    if (failure === "page") args.pageImageId = "another-page";
    if (failure === "asset") args.cleanedAssetId = "another-asset";
    if (failure === "asset-page") fixture.project.processing.assets[0]!.sourcePageImageId = "another-page";
    if (failure === "asset-role") fixture.project.processing.assets[0]!.role = "translated";
    if (failure === "run-id") fixture.project.processing.assets[0]!.runId = "another-run";
    if (failure === "run-provider") fixture.project.processing.assets[0]!.source = "manual_openai";
    if (failure === "latest-run") fixture.project.processing.pages[0]!.latestCompletedRunId = "another-run";
    if (failure === "active-run") fixture.project.processing.pages[0]!.activeRunId = "another-run";
    if (failure === "run-source") fixture.project.processing.runs[0]!.sourceSha256 = "a".repeat(64);
    if (failure === "run-status") fixture.project.processing.runs[0]!.status = "running";
    if (failure === "page-qa") fixture.project.processing.pages[0]!.inpaintingQa = { ...fixture.project.processing.assets[0]!.inpaintingQa!, qaStatus: "retry" };
    if (failure === "asset-qa") fixture.project.processing.assets[0]!.inpaintingQa!.qaStatus = "manual_review";
    if (failure === "no-qa") delete fixture.project.processing.assets[0]!.inpaintingQa;
    if (failure === "asset-size") fixture.project.processing.assets[0]!.byteSize += 1;
    if (failure === "asset-hash") await writeFile(join(fixture.directory, "assets/cleaned.png"), "tampered");
    if (failure === "source-hash") await writeFile(join(fixture.directory, "assets/original.png"), "changed original");
    if (failure === "missing-file") fixture.project.processing.assets[0]!.storedRelativePath = "assets/missing.png";
    const save = vi.fn(async () => undefined);
    const manager = createProjectSessionManager({ saveProjectFile: save });
    const session = manager.createProjectSession({ project: fixture.project, filePath: failure === "not-saved" ? undefined : fixture.filePath });
    const before = manager.getProject(session.projectSessionId);
    await expect(manager.reviewCleanedAsset({ ...args, projectSessionId: failure === "other-session" ? "unknown-session" : session.projectSessionId })).rejects.toThrow();
    expect(manager.getProject(session.projectSessionId)).toEqual(before);
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["source", "cleaned"])("rejects an escaping %s resolved path even with matching bytes (mock reparse target)", async (target) => {
    const fixture = await diskFixture();
    await mkdir(join(fixture.root, "outside"));
    const fileName = target === "source" ? "original.png" : "cleaned.png";
    const outsidePath = join(fixture.root, "outside", fileName);
    await writeFile(outsidePath, target === "source" ? original : png);
    const actualRealpath = vi.mocked(fs.realpath).getMockImplementation()!;
    vi.mocked(fs.realpath).mockImplementation(async (path) => (
      String(path).endsWith(fileName) ? outsidePath : actualRealpath(path)
    ));
    const save = vi.fn(async () => undefined);
    const manager = createProjectSessionManager({ saveProjectFile: save });
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    await expect(manager.reviewCleanedAsset(reviewArgs(session.projectSessionId))).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(vi.mocked(fs.open).mock.calls.some(([path]) => String(path) === outsidePath)).toBe(false);
    vi.mocked(fs.realpath).mockReset().mockImplementation(actualRealpath);
  });

  it.each([false, true])("closes the original and cleaned read handles, cleaned hash mismatch=%s", async (tampered) => {
    const fixture = await diskFixture(reviewed());
    if (tampered) {
      const changed = Buffer.from(png);
      changed[changed.length - 1] = 1;
      await writeFile(join(fixture.directory, "assets/cleaned.png"), changed);
    }
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualFs.open(...args);
      closes.push(vi.spyOn(handle, "close"));
      return handle;
    });
    const read = readVerifiedCleanedAsset({ project: fixture.project, projectFilePath: fixture.filePath, pageImageId: "page-1" });
    if (tampered) await expect(read).rejects.toThrow("CLEANED_ASSET_INTEGRITY_MISMATCH");
    else await expect(read).resolves.toEqual(png);
    expect(closes).toHaveLength(2);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not retry a queued stale revision automatically", async () => {
    const fixture = await diskFixture();
    const save = vi.fn(async () => undefined);
    const manager = createProjectSessionManager({ saveProjectFile: save });
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    const results = await Promise.allSettled([manager.reviewCleanedAsset(reviewArgs(session.projectSessionId)), manager.reviewCleanedAsset(reviewArgs(session.projectSessionId))]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(manager.getProject(session.projectSessionId).revision).toBe(1);
    expect(manager.getProject(session.projectSessionId).dirty).toBe(false);
  });

  it("records user review without changing technical finalStatus, QA or asset pointers", async () => {
    const fixture = await diskFixture();
    fixture.project.processing.pages[0]!.finalStatus = "needs_review";
    const manager = createProjectSessionManager({ saveProjectFile: vi.fn(async () => undefined) });
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    const result = await manager.reviewCleanedAsset(reviewArgs(session.projectSessionId));
    expect(result.project.project.processing.pages[0]).toEqual({ ...fixture.project.processing.pages[0], userReviewedCleanedAssetId: "cleaned-1" });
    expect(result.project.project.processing.assets).toEqual(fixture.project.processing.assets);
  });

  it("leaves persisted and live state unchanged on atomic save failure", async () => {
    const fixture = await diskFixture();
    const save = vi.fn().mockRejectedValueOnce(new Error("isolated disk failure")).mockResolvedValueOnce(undefined);
    const manager = createProjectSessionManager({ saveProjectFile: save });
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    await manager.applyProjectMutation({ projectSessionId: session.projectSessionId, baseRevision: 0, mutation: { type: "set_project_title", title: "pending" } });
    const before = manager.getProject(session.projectSessionId);
    await expect(manager.reviewCleanedAsset(reviewArgs(session.projectSessionId, 1))).rejects.toThrow("isolated disk failure");
    expect(manager.getProject(session.projectSessionId)).toEqual(before);
    await manager.reviewCleanedAsset(reviewArgs(session.projectSessionId, 1));
    expect(save.mock.calls[1]![0].project.metadata.title).toBe("저장된 제목");
  });

  it("preserves the actual project file and pending edits if candidate validation aborts atomic review save", async () => {
    const fixture = await diskFixture();
    await saveProjectFile({ filePath: fixture.filePath, project: fixture.project });
    const bytesBefore = await readFile(fixture.filePath);
    const manager = createProjectSessionManager({ saveProjectFile: (args) => saveProjectFile({ ...args,
      transactionHooks: { afterCandidateValidated: () => { throw new Error("isolated transaction abort"); } } }) });
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    await manager.applyProjectMutation({ projectSessionId: session.projectSessionId, baseRevision: 0, mutation: { type: "set_project_title", title: "pending" } });
    const before = manager.getProject(session.projectSessionId);
    await expect(manager.reviewCleanedAsset(reviewArgs(session.projectSessionId, 1))).rejects.toThrow("isolated transaction abort");
    expect(manager.getProject(session.projectSessionId)).toEqual(before);
    expect(await readFile(fixture.filePath)).toEqual(bytesBefore);
    expect((await loadProjectFile({ filePath: fixture.filePath })).project.processing.pages[0]!.userReviewedCleanedAssetId).toBeUndefined();
  });

  it("never revives review on persisted pointer A → B → A while pending edits replay", async () => {
    const fixture = await diskFixture(reviewed());
    fixture.project.processing.assets.push({ ...fixture.project.processing.assets[0]!, assetId: "cleaned-2" });
    const save = vi.fn(async (_args: { project: TranslationProjectV2 }) => undefined);
    const manager = createProjectSessionManager({ saveProjectFile: save });
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    await manager.applyProjectMutation({ projectSessionId: session.projectSessionId, baseRevision: 0, mutation: { type: "set_project_title", title: "pending title" } });
    for (const assetId of ["cleaned-2", "cleaned-1"]) {
      await manager.commitMainProjectPatch({ projectSessionId: session.projectSessionId,
        patch: { type: "approve_asset", pageImageId: "page-1", kind: "cleaned", assetId } });
      expect(manager.getProject(session.projectSessionId).project.processing.pages[0]!.userReviewedCleanedAssetId).toBeUndefined();
    }
    expect(manager.getProject(session.projectSessionId)).toMatchObject({ dirty: true, project: { metadata: { title: "pending title" } } });
    for (const [args] of save.mock.calls) {
      expect(args.project.processing.pages[0]!.userReviewedCleanedAssetId).toBeUndefined();
      expect(args.project.metadata.title).toBe("저장된 제목");
    }
  });

  it("does not persist a review which pending source A → B → A would invalidate", async () => {
    const fixture = await diskFixture();
    const save = vi.fn(async () => undefined);
    const manager = createProjectSessionManager({ saveProjectFile: save });
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    const originalPage = fixture.project.pageImages[0]!;
    for (const page of [{ ...originalPage, sha256: "b".repeat(64) }, originalPage]) {
      await manager.registerImportedPageImages({ projectSessionId: session.projectSessionId, pageImages: [page] });
    }
    const before = manager.getProject(session.projectSessionId);
    await expect(manager.reviewCleanedAsset(reviewArgs(session.projectSessionId, 2))).rejects.toThrow("CLEANED_REVIEW_PENDING_SOURCE_CHANGE");
    expect(save).not.toHaveBeenCalled();
    expect(manager.getProject(session.projectSessionId)).toEqual(before);
  });

  it("checks owner inside the session task and again after async validation", async () => {
    const fixture = await diskFixture();
    const save = vi.fn(async () => undefined);
    const manager = createProjectSessionManager({ saveProjectFile: save });
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    const before = manager.getProject(session.projectSessionId);
    const assertOwner = vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => { throw new Error("owner disconnected"); });
    await expect(manager.reviewCleanedAsset(reviewArgs(session.projectSessionId), assertOwner)).rejects.toThrow("owner disconnected");
    expect(save).not.toHaveBeenCalled();
    expect(manager.getProject(session.projectSessionId)).toEqual(before);
  });

  it("rejects review through ordinary pending mutations", async () => {
    const manager = createProjectSessionManager({ saveProjectFile: vi.fn(async () => undefined) });
    const session = manager.createProjectSession({ project: projectFixture() });
    const before = manager.getProject(session.projectSessionId);
    await expect(manager.applyProjectMutation({ projectSessionId: session.projectSessionId, baseRevision: 0,
      mutation: { type: "review_cleaned_asset", userReviewedCleanedAssetId: "cleaned-1" } as never })).rejects.toThrow(/unsupported type/);
    expect(manager.getProject(session.projectSessionId)).toEqual(before);
  });

  it("captures export after queued edits settle and rejects a closed session", async () => {
    const manager = createProjectSessionManager();
    const fixture = await diskFixture();
    const session = manager.createProjectSession({ project: fixture.project, filePath: fixture.filePath });
    const mutation = manager.applyProjectMutation({ projectSessionId: session.projectSessionId, baseRevision: 0, mutation: { type: "set_project_title", title: "queued edit" } });
    const snapshot = await manager.captureImageExportSnapshot({ projectSessionId: session.projectSessionId });
    await mutation;
    expect(snapshot.projectRevision).toBe(1);
    expect(snapshot.project.metadata.title).toBe("queued edit");
    expect(snapshot.projectFilePath).toBe(fixture.filePath);
    await manager.closeProject({ projectSessionId: session.projectSessionId });
    await expect(manager.captureImageExportSnapshot({ projectSessionId: session.projectSessionId })).rejects.toThrow();
  });
});

describe("independent cleaned and typeset export gates", () => {
  it.each(["unreviewed", "review-other", "tampered-cleaned", "tampered-source", "stale-source", "qa-failed", "reviewed"])("validates %s independently for both cleaned outputs", async (condition) => {
    const fixture = await diskFixture(condition === "unreviewed" ? projectFixture() : reviewed());
    const page = fixture.project.pageImages[0]!;
    const asset = fixture.project.processing.assets[0]!;
    if (condition === "review-other") fixture.project.processing.pages[0]!.userReviewedCleanedAssetId = "other";
    if (condition === "tampered-cleaned") await writeFile(join(fixture.directory, asset.storedRelativePath), "tampered");
    if (condition === "tampered-source") await writeFile(join(fixture.directory, page.storedRelativePath), "tampered");
    if (condition === "stale-source") fixture.project.processing.runs[0]!.sourceSha256 = "a".repeat(64);
    if (condition === "qa-failed") asset.inpaintingQa!.qaStatus = "retry";
    const readiness = buildRenderReadinessReport({ pageImageId: page.id, revision: 0, resultRevision: 0, lines: [], font,
      approvedCleanedAssetId: asset.assetId, cleanedAssetQaStatus: "pass" });
    const result = await exportProjectImages({ project: fixture.project, projectFilePath: fixture.filePath, projectRevision: 0,
      exportRoot: join(fixture.root, "export"), typesetPages: [{ pageImageId: page.id, pngBytes: png, readiness }], trustedTypesetFontEvidence: font });
    const kinds = result.report.files.map((file) => file.kind);
    if (condition === "reviewed") expect(kinds).toEqual(["original", "cleaned", "typeset"]);
    else {
      expect(kinds).not.toContain("cleaned");
      expect(kinds).not.toContain("typeset");
      expect(result.report.failures.map((failure) => failure.kind)).toEqual(expect.arrayContaining(["cleaned", "typeset"]));
      if (condition !== "tampered-source") {
        expect(kinds).toContain("original");
        expect(result.report.status).toBe("partial");
      }
    }
  });
});
