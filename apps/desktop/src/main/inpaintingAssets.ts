import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { PageImage } from "../shared/projectTypes.js";
import type {
  DerivedImageAsset,
  ProcessingRunRecord
} from "../shared/projectTypes.js";
import type { InpaintPageImageResult, InpaintingProvider } from "../shared/inpainting.js";
import type { InpaintingQaResult } from "../shared/inpaintingQa.js";

type ResolveStoredPageImagePathArgs = {
  projectFilePath: string;
  storedRelativePath: string;
};

type WriteInpaintedPageImageAssetArgs = {
  projectFilePath: string;
  sourcePageImage: PageImage;
  imageBytes: Buffer;
  now?: Date;
};

type CreateManualInpaintingAdapterResultArgs = {
  sourcePageImage: PageImage;
  pageImage: PageImage;
  provider: InpaintingProvider;
  runId?: string;
  appVersion: string;
  now?: Date;
  inpaintingQa?: InpaintingQaResult;
  maskAsset?: DerivedImageAsset;
};

export function createManualInpaintingAdapterResult(
  args: CreateManualInpaintingAdapterResultArgs
): InpaintPageImageResult {
  const runId = args.runId ?? randomUUID();
  const timestamp = (args.now ?? new Date()).toISOString();
  const source =
    args.provider === "gemini"
      ? "manual_gemini"
      : args.provider === "openai"
        ? "manual_openai"
        : "manual_local_edit";
  const run: ProcessingRunRecord = {
    runId,
    pageImageId: args.sourcePageImage.id,
    source,
    status: "completed",
    sourceSha256: args.sourcePageImage.sha256,
    appVersion: args.appVersion,
    queuedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp
  };
  const asset: DerivedImageAsset = {
    assetId: args.pageImage.id,
    source,
    sourcePageImageId: args.sourcePageImage.id,
    runId,
    role: "cleaned",
    storedRelativePath: args.pageImage.storedRelativePath,
    sha256: args.pageImage.sha256,
    byteSize: args.pageImage.byteSize,
    mimeType: "image/png",
    createdAt: timestamp,
    ...(args.maskAsset ? { maskAssetId: args.maskAsset.assetId } : {}),
    ...(args.inpaintingQa ? { inpaintingQa: args.inpaintingQa } : {})
  };

  return {
    pageImage: args.pageImage,
    run,
    asset,
    ...(args.maskAsset ? { maskAsset: args.maskAsset } : {})
  };
}

export function resolveStoredPageImagePath(args: ResolveStoredPageImagePathArgs): string {
  const projectDir = dirname(args.projectFilePath);
  const resolvedProjectDir = resolve(projectDir);
  const resolvedStoredPath = resolve(resolvedProjectDir, args.storedRelativePath);
  const projectRelativePath = relative(resolvedProjectDir, resolvedStoredPath);

  if (
    projectRelativePath === "" ||
    projectRelativePath === ".." ||
    projectRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(projectRelativePath)
  ) {
    throw new Error("Stored page image path must be inside the project folder");
  }

  return resolvedStoredPath;
}

export async function writeInpaintedPageImageAsset(
  args: WriteInpaintedPageImageAssetArgs
): Promise<{ pageImage: PageImage; absoluteStoredPath: string }> {
  if (!Number.isInteger(args.sourcePageImage.pageNumber) || args.sourcePageImage.pageNumber < 1) {
    throw new Error("Invalid image page number");
  }

  const project = parse(args.projectFilePath);
  const assetRoot = join(project.dir, `${project.name}-assets`, "images");
  await mkdir(assetRoot, { recursive: true });

  const storedAsset = await writeFirstFreeInpaintAsset(assetRoot, args.sourcePageImage.pageNumber, args.imageBytes);
  const storedRelativePath = relative(dirname(args.projectFilePath), storedAsset.absoluteStoredPath).replaceAll("\\", "/");
  const inpaintedOriginalFileName = inpaintedFileName(args.sourcePageImage.originalFileName, storedAsset.attempt);

  return {
    absoluteStoredPath: storedAsset.absoluteStoredPath,
    pageImage: {
      id: randomUUID(),
      pageNumber: args.sourcePageImage.pageNumber,
      storedRelativePath,
      originalFileName: inpaintedOriginalFileName,
      sha256: sha256Bytes(args.imageBytes),
      byteSize: args.imageBytes.byteLength,
      mimeType: "image/png",
      copiedAt: (args.now ?? new Date()).toISOString()
    }
  };
}

async function writeFirstFreeInpaintAsset(assetRoot: string, pageNumber: number, imageBytes: Buffer) {
  const pageName = `page-${String(pageNumber).padStart(3, "0")}`;
  let attempt = 1;

  while (true) {
    const candidate = join(assetRoot, `${pageName}-inpaint-${String(attempt).padStart(3, "0")}.png`);
    try {
      await writeFile(candidate, imageBytes, { flag: "wx" });
      return { absoluteStoredPath: candidate, attempt };
    } catch (error) {
      if (isFileExistsError(error)) {
        attempt += 1;
        continue;
      }

      throw error;
    }
  }
}

export type WriteInpaintingMaskAssetArgs = {
  projectFilePath: string;
  sourcePageImage: PageImage;
  maskBytes: Buffer;
  now?: Date;
  runId?: string;
  source?: "automatic_pipeline" | "manual_openai" | "manual_gemini" | "manual_local_edit";
};

export async function writeInpaintingMaskAsset(
  args: WriteInpaintingMaskAssetArgs
): Promise<{ maskAsset: DerivedImageAsset; absoluteStoredPath: string }> {
  if (!Number.isInteger(args.sourcePageImage.pageNumber) || args.sourcePageImage.pageNumber < 1) {
    throw new Error("Invalid image page number");
  }

  const project = parse(args.projectFilePath);
  const assetRoot = join(project.dir, `${project.name}-assets`, "images");
  await mkdir(assetRoot, { recursive: true });

  const storedAsset = await writeFirstFreeMaskAsset(assetRoot, args.sourcePageImage.pageNumber, args.maskBytes);
  const storedRelativePath = relative(dirname(args.projectFilePath), storedAsset.absoluteStoredPath).replaceAll("\\", "/");
  const timestamp = (args.now ?? new Date()).toISOString();

  const maskAsset: DerivedImageAsset = {
    assetId: randomUUID(),
    source: args.source ?? "manual_local_edit",
    sourcePageImageId: args.sourcePageImage.id,
    runId: args.runId ?? randomUUID(),
    role: "mask",
    storedRelativePath,
    sha256: sha256Bytes(args.maskBytes),
    byteSize: args.maskBytes.byteLength,
    mimeType: "image/png",
    createdAt: timestamp
  };

  return { maskAsset, absoluteStoredPath: storedAsset.absoluteStoredPath };
}

async function writeFirstFreeMaskAsset(assetRoot: string, pageNumber: number, maskBytes: Buffer) {
  const pageName = `page-${String(pageNumber).padStart(3, "0")}`;
  let attempt = 1;

  while (true) {
    const candidate = join(assetRoot, `${pageName}-mask-${String(attempt).padStart(3, "0")}.png`);
    try {
      await writeFile(candidate, maskBytes, { flag: "wx" });
      return { absoluteStoredPath: candidate, attempt };
    } catch (error) {
      if (isFileExistsError(error)) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}

function inpaintedFileName(originalFileName: string, attempt: number): string {
  const original = parse(basename(originalFileName));
  return `${original.name}-inpaint-${String(attempt).padStart(3, "0")}.png`;
}

function sha256Bytes(imageBytes: Buffer): string {
  return createHash("sha256").update(imageBytes).digest("hex");
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
