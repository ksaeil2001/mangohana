import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, parse, relative } from "node:path";
import type { PageImage } from "../shared/projectTypes.js";

type CopyPageImageArgs = {
  sourcePath: string;
  projectFilePath: string;
  pageNumber: number;
  now?: Date;
};

const mimeTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);
const normalizedExtensions = new Map([
  [".jpg", ".jpg"],
  [".jpeg", ".jpg"],
  [".png", ".png"],
  [".webp", ".webp"]
]);

export async function copyPageImageAsset(args: CopyPageImageArgs): Promise<{
  pageImage: PageImage;
  absoluteStoredPath: string;
}> {
  if (!Number.isInteger(args.pageNumber) || args.pageNumber < 1) {
    throw new Error("Invalid image page number");
  }

  const extension = extname(args.sourcePath).toLowerCase();
  const mimeType = mimeTypes.get(extension);
  if (!mimeType) throw new Error("Unsupported image file extension");

  const project = parse(args.projectFilePath);
  const assetRoot = join(project.dir, `${project.name}-assets`, "images");
  await mkdir(assetRoot, { recursive: true });

  const sourceHash = await sha256File(args.sourcePath);
  const normalizedExtension = normalizedExtensions.get(extension)!;
  const absoluteStoredPath = join(assetRoot, `${sourceHash}${normalizedExtension}`);
  let created = false;
  try {
    await copyFile(args.sourcePath, absoluteStoredPath, constants.COPYFILE_EXCL);
    created = true;
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
  }

  try {
    const [sourceStat, copiedStat, copiedHash] = await Promise.all([
      stat(args.sourcePath),
      stat(absoluteStoredPath),
      sha256File(absoluteStoredPath)
    ]);
    if (sourceStat.size !== copiedStat.size || sourceHash !== copiedHash) {
      if (created) await rm(absoluteStoredPath, { force: true });
      throw new Error("Content-addressed asset collision");
    }

    const storedRelativePath = relative(dirname(args.projectFilePath), absoluteStoredPath).replaceAll("\\", "/");

    return {
      absoluteStoredPath,
      pageImage: {
        id: randomUUID(),
        pageNumber: args.pageNumber,
        storedRelativePath,
        originalFileName: basename(args.sourcePath),
        sha256: copiedHash,
        byteSize: copiedStat.size,
        mimeType,
        copiedAt: (args.now ?? new Date()).toISOString()
      }
    };
  } catch (error) {
    if (created) {
      try {
        await rm(absoluteStoredPath, { force: true });
      } catch {
        // best effort cleanup
      }
    }
    throw error;
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
