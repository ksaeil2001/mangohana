import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse, relative, resolve } from "node:path";
import { inspectApprovedCleanedAsset, type ApprovedCleanedAssetInspection } from "../shared/approvedCleanedAsset.js";
import {
  buildRenderReadinessReport,
  type RenderReadinessEvidence,
  type RenderReadinessReport
} from "../shared/renderReadiness.js";
import type { PageImage, TranslationProjectV2 } from "../shared/projectTypes.js";
import { readVerifiedCleanedAsset } from "./cleanedAssetReview.js";
import { readVerifiedProjectAsset } from "./projectAssetRead.js";

export type TypesetExportPage = {
  pageImageId: string;
  pngBytes: Buffer;
  readiness: RenderReadinessReport;
};

export type ProjectImageExportArgs = {
  project: TranslationProjectV2;
  projectRevision: number;
  projectFilePath: string;
  exportRoot: string;
  typesetPages?: readonly TypesetExportPage[];
  /**
   * Evidence established by Main after validating the installed font resource.
   * Renderer evidence is never sufficient on its own because it can only report
   * browser-side canvas observations.
   */
  trustedTypesetFontEvidence?: RenderReadinessEvidence["font"];
  includeZip?: boolean;
  now?: Date;
  fileOps?: ProjectImageExportFileOps;
};

export type ProjectImageExportFileOps = {
  rename: typeof rename;
  rm: typeof rm;
};

export type InstalledTypesetFontResourceVerifier = (
  identity: string
) => Promise<boolean>;

export async function resolveTrustedTypesetFontEvidence(
  rendererEvidence: readonly RenderReadinessEvidence["font"][],
  verifyInstalledFontResource: InstalledTypesetFontResourceVerifier
): Promise<RenderReadinessEvidence["font"] | undefined> {
  const evidence = rendererEvidence[0];
  if (!evidence) return undefined;
  if (rendererEvidence.some((candidate) => !sameFontEvidence(candidate, evidence))) {
    return undefined;
  }
  if (
    !evidence.resourceAvailable ||
    !evidence.metricsCalculated ||
    !evidence.glyphCoverageVerified
  ) {
    return undefined;
  }
  if (!await verifyInstalledFontResource(evidence.identity)) return undefined;
  return Object.freeze({ ...evidence });
}

export type ProjectImageExportFile = {
  outputPath: string;
  kind: "original" | "cleaned" | "typeset";
  pageImageId: string;
  sourceSha256: string;
  outputSha256: string;
  byteSize: number;
};

export type ProjectImageExportFailure = {
  pageImageId?: string;
  kind: "original" | "cleaned" | "typeset";
  code: string;
  message: string;
};

export type ProjectImageExportReport = {
  schemaVersion: 1;
  status: "completed" | "partial" | "failed";
  projectId: string;
  exportedAt: string;
  files: ProjectImageExportFile[];
  failures: ProjectImageExportFailure[];
};

export type ProjectImageExportManifest = {
  schemaVersion: 1;
  projectId: string;
  projectRevision: number;
  exportedAt: string;
  sourcePageCount: number;
  files: ProjectImageExportFile[];
};

export type ProjectImageExportResult = {
  exportRoot: string;
  zipPath?: string;
  report: ProjectImageExportReport;
  manifest: ProjectImageExportManifest;
};

export async function exportProjectImages(args: ProjectImageExportArgs): Promise<ProjectImageExportResult> {
  const targetRoot = validateExportRoot(args.exportRoot, args.projectFilePath);
  const zipPath = args.includeZip ? `${targetRoot}.zip` : undefined;
  if (await exists(targetRoot)) throw new Error("EXPORT_ROOT_EXISTS");
  if (zipPath && await exists(zipPath)) throw new Error("EXPORT_ZIP_EXISTS");

  const timestamp = (args.now ?? new Date()).toISOString();
  const stageRoot = join(dirname(targetRoot), `.${basename(targetRoot)}.partial-${randomUUID()}`);
  const outputFiles: ProjectImageExportFile[] = [];
  const failures: ProjectImageExportFailure[] = [];
  const typesetByPage = new Map((args.typesetPages ?? []).map((page) => [page.pageImageId, page]));
  const pageImages = [...args.project.pageImages].sort((left, right) => left.pageNumber - right.pageNumber);

  const fileOps: ProjectImageExportFileOps = {
    rename: args.fileOps?.rename ?? rename,
    rm: args.fileOps?.rm ?? rm
  };
  let stagedZipPath: string | undefined;
  let publishedTargetRoot = false;
  let publishedZipPath: string | undefined;
  try {
    await mkdir(join(stageRoot, "original"), { recursive: true });
    await mkdir(join(stageRoot, "cleaned"), { recursive: true });
    await mkdir(join(stageRoot, "typeset"), { recursive: true });

    for (const pageImage of pageImages) {
      await exportOriginalPage({
        pageImage,
        projectFilePath: args.projectFilePath,
        stageRoot,
        outputFiles,
        failures
      });
      await exportCleanedPage({
        pageImage,
        project: args.project,
        projectFilePath: args.projectFilePath,
        stageRoot,
        outputFiles,
        failures
      });
      await exportTypesetPage({
        pageImage,
        page: typesetByPage.get(pageImage.id),
        project: args.project,
        projectFilePath: args.projectFilePath,
        projectRevision: args.projectRevision,
        trustedTypesetFontEvidence: args.trustedTypesetFontEvidence,
        stageRoot,
        outputFiles,
        failures
      });
    }

    const status = failures.length === 0
      ? "completed"
      : outputFiles.length > 0
        ? "partial"
        : "failed";
    const report: ProjectImageExportReport = {
      schemaVersion: 1,
      status,
      projectId: args.project.metadata.id,
      exportedAt: timestamp,
      files: outputFiles,
      failures
    };
    const manifest: ProjectImageExportManifest = {
      schemaVersion: 1,
      projectId: args.project.metadata.id,
      projectRevision: args.projectRevision,
      exportedAt: timestamp,
      sourcePageCount: pageImages.length,
      files: outputFiles
    };
    await writeFile(join(stageRoot, "report.json"), JSON.stringify(report, null, 2), "utf8");
    await writeFile(join(stageRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    if (zipPath) {
      stagedZipPath = join(dirname(targetRoot), `.${basename(targetRoot)}.zip.partial-${randomUUID()}`);
      const zipEntries = await collectZipEntries(stageRoot);
      await writeFile(stagedZipPath, createStoredZip(zipEntries));
    }

    if (await exists(targetRoot)) throw new Error("EXPORT_ROOT_EXISTS");
    if (zipPath && await exists(zipPath)) throw new Error("EXPORT_ZIP_EXISTS");
    await fileOps.rename(stageRoot, targetRoot);
    publishedTargetRoot = true;
    if (zipPath && stagedZipPath) {
      if (await exists(zipPath)) throw new Error("EXPORT_ZIP_EXISTS");
      await fileOps.rename(stagedZipPath, zipPath);
      publishedZipPath = zipPath;
    }
    return {
      exportRoot: targetRoot,
      ...(zipPath ? { zipPath } : {}),
      report,
      manifest
    };
  } catch (error) {
    if (publishedZipPath) {
      await fileOps.rm(publishedZipPath, { force: true }).catch(() => undefined);
    }
    if (publishedTargetRoot) {
      await fileOps.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await fileOps.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    if (stagedZipPath) await fileOps.rm(stagedZipPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function exportOriginalPage(args: {
  pageImage: PageImage;
  projectFilePath: string;
  stageRoot: string;
  outputFiles: ProjectImageExportFile[];
  failures: ProjectImageExportFailure[];
}): Promise<void> {
  const outputPath = join(args.stageRoot, "original", outputFileName(args.pageImage, "original"));
  try {
    const sourceBytes = await readVerifiedProjectAsset({
      projectFilePath: args.projectFilePath,
      image: args.pageImage,
      errorPrefix: "ORIGINAL_IMAGE"
    });
    const sourceSha256 = sha256(sourceBytes);
    await writeFile(outputPath, sourceBytes);
    args.outputFiles.push(toExportFile({
      outputPath: relative(args.stageRoot, outputPath),
      kind: "original",
      pageImageId: args.pageImage.id,
      sourceSha256,
      bytes: sourceBytes
    }));
  } catch (error) {
    args.failures.push({
      pageImageId: args.pageImage.id,
      kind: "original",
      code: "ORIGINAL_COPY_FAILED",
      message: error instanceof Error ? error.message : "원본 이미지 복사에 실패했습니다."
    });
  }
}

async function exportCleanedPage(args: {
  pageImage: PageImage;
  project: TranslationProjectV2;
  projectFilePath: string;
  stageRoot: string;
  outputFiles: ProjectImageExportFile[];
  failures: ProjectImageExportFailure[];
}): Promise<void> {
  const inspection = inspectApprovedCleanedAsset(args.project, args.pageImage);
  if (inspection.status === "missing" && !inspection.required) return;
  if (inspection.status === "missing") {
    args.failures.push({ pageImageId: args.pageImage.id, kind: "cleaned", code: "CLEANED_ASSET_NOT_APPROVED", message: "승인된 cleaned asset이 없습니다." });
    return;
  }
  if (inspection.status === "invalid_reference") {
    args.failures.push({ pageImageId: args.pageImage.id, kind: "cleaned", code: "CLEANED_ASSET_INVALID_REFERENCE", message: "승인된 cleaned asset이 현재 페이지의 유효한 processing graph에 연결되지 않았습니다." });
    return;
  }
  if (inspection.status === "qa_failed" || !inspection.asset) {
    args.failures.push({ pageImageId: args.pageImage.id, kind: "cleaned", code: "CLEANED_ASSET_QA_NOT_PASS", message: "cleaned asset이 승인되지 않았거나 인페인팅 QA가 PASS가 아닙니다." });
    return;
  }
  try {
    const bytes = await readVerifiedCleanedAsset({ project: args.project, projectFilePath: args.projectFilePath, pageImageId: args.pageImage.id });
    const sourceSha256 = sha256(bytes);
    const outputPath = join(args.stageRoot, "cleaned", outputFileName(args.pageImage, "cleaned"));
    await writeFile(outputPath, bytes);
    args.outputFiles.push(toExportFile({
      outputPath: relative(args.stageRoot, outputPath),
      kind: "cleaned",
      pageImageId: args.pageImage.id,
      sourceSha256,
      bytes
    }));
  } catch (error) {
    const notReviewed = error instanceof Error && error.message === "CLEANED_ASSET_NOT_USER_REVIEWED";
    args.failures.push({ pageImageId: args.pageImage.id, kind: "cleaned", code: notReviewed ? "CLEANED_ASSET_NOT_USER_REVIEWED" : "CLEANED_COPY_FAILED", message: notReviewed ? "현재 배경 정리 결과를 사용자가 확인해야 합니다." : error instanceof Error ? error.message : "cleaned asset 복사에 실패했습니다." });
  }
}

async function exportTypesetPage(args: {
  pageImage: PageImage;
  page: TypesetExportPage | undefined;
  project: TranslationProjectV2;
  projectFilePath: string;
  projectRevision: number;
  trustedTypesetFontEvidence: RenderReadinessEvidence["font"] | undefined;
  stageRoot: string;
  outputFiles: ProjectImageExportFile[];
  failures: ProjectImageExportFailure[];
}): Promise<void> {
  if (!args.page) {
    args.failures.push({ pageImageId: args.pageImage.id, kind: "typeset", code: "TYPESET_RENDER_NOT_PROVIDED", message: "render-ready 식자 결과가 제공되지 않았습니다." });
    return;
  }
  const readinessValidation = validateTypesetReadiness({
    pageImage: args.pageImage,
    page: args.page,
    project: args.project,
    projectRevision: args.projectRevision,
    trustedTypesetFontEvidence: args.trustedTypesetFontEvidence
  });
  if (!readinessValidation.valid) {
    args.failures.push({ pageImageId: args.pageImage.id, kind: "typeset", code: "TYPESET_NOT_RENDER_READY", message: readinessValidation.message });
    return;
  }
  if (readinessValidation.inspection.required) {
    try {
      await readVerifiedCleanedAsset({ project: args.project, projectFilePath: args.projectFilePath, pageImageId: args.pageImage.id });
    } catch (error) {
      args.failures.push({ pageImageId: args.pageImage.id, kind: "typeset", code: "TYPESET_CLEANED_ASSET_INVALID",
        message: error instanceof Error && error.message === "CLEANED_ASSET_NOT_USER_REVIEWED"
          ? "식자에 사용한 현재 배경 정리 결과를 사용자가 확인해야 합니다."
          : error instanceof Error ? error.message : "식자 배경 정리 자산 검증에 실패했습니다." });
      return;
    }
  }
  if (!isPng(args.page.pngBytes)) {
    args.failures.push({ pageImageId: args.pageImage.id, kind: "typeset", code: "TYPESET_INVALID_IMAGE", message: "typeset 결과가 PNG가 아닙니다." });
    return;
  }
  const outputPath = join(args.stageRoot, "typeset", outputFileName(args.pageImage, "typeset", ".png"));
  await writeFile(outputPath, args.page.pngBytes);
  args.outputFiles.push(toExportFile({
    outputPath: relative(args.stageRoot, outputPath),
    kind: "typeset",
    pageImageId: args.pageImage.id,
    sourceSha256: readinessValidation.inspection.status === "valid" && readinessValidation.inspection.asset
      ? readinessValidation.inspection.asset.sha256
      : args.pageImage.sha256,
    bytes: args.page.pngBytes
  }));
}

function validateTypesetReadiness(args: {
  pageImage: PageImage;
  page: TypesetExportPage;
  project: TranslationProjectV2;
  projectRevision: number;
  trustedTypesetFontEvidence: RenderReadinessEvidence["font"] | undefined;
}): { valid: boolean; message: string; inspection: ApprovedCleanedAssetInspection } {
  const readiness = args.page.readiness;
  if (!isRenderReadinessReportShape(readiness)) {
    return {
      valid: false,
      message: "typeset readiness report의 evidence 또는 필드가 유효하지 않습니다.",
      inspection: inspectApprovedCleanedAsset(args.project, args.pageImage)
    };
  }

  const lines = args.project.dialogueLines.filter((line) => line.pageNumber === args.pageImage.pageNumber);
  const inspection = inspectApprovedCleanedAsset(args.project, args.pageImage);
  const reportApprovedCleanedAssetId = inspection.status === "valid" || inspection.status === "qa_failed"
    ? inspection.approvedCleanedAssetId
    : undefined;
  const expected = buildRenderReadinessReport({
    pageImageId: args.pageImage.id,
    revision: args.projectRevision,
    resultRevision: readiness.revision,
    lines,
    approvedCleanedAssetId: reportApprovedCleanedAssetId,
    cleanedAssetQaStatus: inspection.qaStatus,
    cleanedAssetRequired: inspection.required,
    safeAreaProvisionalLineIds: readiness.evidence.safeAreaProvisionalLineIds,
    missingGlyphLineIds: readiness.evidence.missingGlyphLineIds,
    overflowLineIds: readiness.evidence.overflowLineIds,
    font: readiness.evidence.font
  });

  const mismatches: string[] = [];
  const currentLineIds = new Set(lines.map((line) => line.id));
  if (!hasOnlyKnownLineIds(readiness.evidence.safeAreaProvisionalLineIds, currentLineIds) ||
      !hasOnlyKnownLineIds(readiness.evidence.missingGlyphLineIds, currentLineIds) ||
      !hasOnlyKnownLineIds(readiness.evidence.overflowLineIds, currentLineIds)) {
    mismatches.push("evidence line identity");
  }
  if (readiness.pageImageId !== expected.pageImageId) mismatches.push("page identity");
  if (readiness.revision !== expected.revision) mismatches.push("revision");
  if (!sameStringArray(readiness.lineIds, expected.lineIds)) mismatches.push("line identity");
  if (readiness.sourceFingerprint !== expected.sourceFingerprint) mismatches.push("source fingerprint");
  if (readiness.userTranslationFingerprint !== expected.userTranslationFingerprint) mismatches.push("user translation fingerprint");
  if (readiness.typesettingGeometryFingerprint !== expected.typesettingGeometryFingerprint) mismatches.push("typesetting fingerprint");
  if (readiness.fontIdentity !== expected.fontIdentity) mismatches.push("font identity");
  if (!sameEvidence(readiness.evidence, expected.evidence)) mismatches.push("evidence");
  if (!sameBlockers(readiness.blockers, expected.blockers)) mismatches.push("blockers");
  if (!sameStringArray(readiness.warnings, expected.warnings)) mismatches.push("warnings");
  if (readiness.approvedCleanedAssetId !== expected.approvedCleanedAssetId) mismatches.push("approved cleaned asset");
  if (readiness.ready !== expected.ready) mismatches.push("ready state");
  if (!args.trustedTypesetFontEvidence) {
    mismatches.push("Main font resource evidence");
  } else if (!sameFontEvidence(readiness.evidence.font, args.trustedTypesetFontEvidence)) {
    mismatches.push("Main font resource evidence");
  } else if (
    !args.trustedTypesetFontEvidence.resourceAvailable ||
    !args.trustedTypesetFontEvidence.metricsCalculated ||
    !args.trustedTypesetFontEvidence.glyphCoverageVerified
  ) {
    mismatches.push("verified font resource readiness");
  }

  if (mismatches.length > 0 || !readiness.ready || !expected.ready) {
    const reason = mismatches.length > 0
      ? `현재 프로젝트와 일치하지 않는 ${mismatches.join(", ")}입니다.`
      : inspection.required && inspection.status !== "valid"
        ? `현재 페이지의 cleaned asset 상태(${inspection.status})가 승인되지 않았습니다.`
        : "render-ready gate를 통과하지 못한 식자 결과입니다.";
    return { valid: false, message: reason, inspection };
  }

  return { valid: true, message: "", inspection };
}

function isRenderReadinessReportShape(value: unknown): value is RenderReadinessReport {
  if (!isRecord(value) || typeof value.ready !== "boolean") return false;
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) return false;
  if (!isNonEmptyString(value.pageImageId)) return false;
  if (!isStringArray(value.lineIds) || !hasUniqueValues(value.lineIds)) return false;
  if (!isNonEmptyString(value.sourceFingerprint) ||
      !isNonEmptyString(value.userTranslationFingerprint) ||
      !isNonEmptyString(value.typesettingGeometryFingerprint) ||
      !isNonEmptyString(value.fontIdentity)) return false;
  if (!Array.isArray(value.blockers) || !value.blockers.every(isRenderReadinessBlocker)) return false;
  if (!isStringArray(value.warnings)) return false;
  if (!isRenderReadinessEvidence(value.evidence)) return false;
  return value.approvedCleanedAssetId === undefined || isNonEmptyString(value.approvedCleanedAssetId);
}

function isRenderReadinessEvidence(value: unknown): value is RenderReadinessEvidence {
  if (!isRecord(value) || !isRecord(value.font)) return false;
  const font = value.font;
  return isNonEmptyString(font.identity) &&
    typeof font.resourceAvailable === "boolean" &&
    typeof font.metricsCalculated === "boolean" &&
    typeof font.glyphCoverageVerified === "boolean" &&
    isStringArray(value.safeAreaProvisionalLineIds) &&
    isStringArray(value.missingGlyphLineIds) &&
    isStringArray(value.overflowLineIds) &&
    hasUniqueValues(value.safeAreaProvisionalLineIds) &&
    hasUniqueValues(value.missingGlyphLineIds) &&
    hasUniqueValues(value.overflowLineIds);
}

function isRenderReadinessBlocker(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.code) || !isNonEmptyString(value.message)) return false;
  return value.lineId === undefined || isNonEmptyString(value.lineId);
}

function sameEvidence(left: RenderReadinessEvidence, right: RenderReadinessEvidence): boolean {
  return sameFontEvidence(left.font, right.font) &&
    sameStringArray(left.safeAreaProvisionalLineIds, right.safeAreaProvisionalLineIds) &&
    sameStringArray(left.missingGlyphLineIds, right.missingGlyphLineIds) &&
    sameStringArray(left.overflowLineIds, right.overflowLineIds);
}

function sameFontEvidence(
  left: RenderReadinessEvidence["font"],
  right: RenderReadinessEvidence["font"]
): boolean {
  return left.identity === right.identity &&
    left.resourceAvailable === right.resourceAvailable &&
    left.metricsCalculated === right.metricsCalculated &&
    left.glyphCoverageVerified === right.glyphCoverageVerified;
}

function sameBlockers(left: RenderReadinessReport["blockers"], right: RenderReadinessReport["blockers"]): boolean {
  return left.length === right.length && left.every((blocker, index) => {
    const expected = right[index];
    return expected !== undefined &&
      blocker.code === expected.code &&
      blocker.message === expected.message &&
      blocker.lineId === expected.lineId;
  });
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hasOnlyKnownLineIds(values: readonly string[], knownLineIds: ReadonlySet<string>): boolean {
  return values.every((value) => knownLineIds.has(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateExportRoot(exportRoot: string, projectFilePath: string): string {
  if (!exportRoot) throw new Error("EXPORT_ROOT_INVALID");
  const target = resolve(exportRoot);
  const projectDir = resolve(dirname(projectFilePath));
  const assetDir = resolve(projectDir, `${parse(projectFilePath).name}-assets`);
  const targetRelativeToAssets = relative(assetDir, target);
  if (target === projectDir) throw new Error("EXPORT_ROOT_MUST_NOT_BE_PROJECT_FOLDER");
  if (target === assetDir || (!targetRelativeToAssets.startsWith("..") && !targetRelativeToAssets.startsWith("../"))) {
    throw new Error("EXPORT_ROOT_MUST_NOT_BE_PROJECT_ASSETS");
  }
  return target;
}

function outputFileName(pageImage: PageImage, kind: "original" | "cleaned" | "typeset", forcedExtension?: string): string {
  const extension = forcedExtension ?? (kind === "cleaned" ? ".png" : extname(pageImage.originalFileName).toLowerCase() || ".bin");
  const stem = sanitizeFileName(pageImage.originalFileName.replace(new RegExp(`${escapeRegExp(extname(pageImage.originalFileName))}$`, "i"), ""));
  return `${String(pageImage.pageNumber).padStart(3, "0")}-${stem || "page"}-${kind}${extension}`;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 160);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toExportFile(args: {
  outputPath: string;
  kind: "original" | "cleaned" | "typeset";
  pageImageId: string;
  sourceSha256: string;
  bytes: Buffer;
}): ProjectImageExportFile {
  return {
    outputPath: args.outputPath.replaceAll("\\", "/"),
    kind: args.kind,
    pageImageId: args.pageImageId,
    sourceSha256: args.sourceSha256,
    outputSha256: sha256(args.bytes),
    byteSize: args.bytes.byteLength
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

async function collectZipEntries(root: string): Promise<Array<{ name: string; data: Buffer }>> {
  const entries: Array<{ name: string; data: Buffer }> = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else entries.push({ name: relative(root, absolute).replaceAll("\\", "/"), data: await readFile(absolute) });
    }
  }
  await walk(root);
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function createStoredZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    const local = Buffer.concat([header, name, entry.data]);
    localParts.push(local);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, name]));
    offset += local.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
