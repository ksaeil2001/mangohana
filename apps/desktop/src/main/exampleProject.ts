import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readVerifiedProjectAsset } from "./projectAssetRead.js";
import { loadProjectFile, saveProjectFile } from "./projectStorage.js";

// Only these bundled, synthetic files belong to the example. Never copy profiles or logs.
const exampleFiles = [
  "ui-sample.ctp",
  "ui-sample-assets/images/66440de7d9ed79a8133328669ac7ca8ebeaee9d985f70df8d6965af2ef02feb3.png",
  "ui-sample-assets/images/d4b34145d8f40f5066ac5585ff8db65353e31ab5e326d2f5c8c9996f28b44b34.png"
] as const;
const temporaryPrefix = "mangohana-example-";

export async function copyBundledExampleProject(args: {
  resourceDirectory: string;
  temporaryDirectory?: string;
}): Promise<{ filePath: string; removeFailedCopy: () => Promise<void> }> {
  const temporaryRoot = resolve(args.temporaryDirectory ?? tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, temporaryPrefix));
  const filePath = join(directory, exampleFiles[0]);

  // This closure can remove only the unique directory created by this call.
  async function removeFailedCopy(): Promise<void> {
    const inside = relative(temporaryRoot, directory);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) ||
        dirname(directory) !== temporaryRoot || !basename(directory).startsWith(temporaryPrefix)) {
      throw new Error("예시 임시 폴더의 안전한 정리 경로를 확인하지 못했습니다.");
    }
    await rm(directory, { recursive: true, force: true });
  }

  try {
    for (const name of exampleFiles) {
      const target = join(directory, name);
      await mkdir(dirname(target), { recursive: true });
      // readFile also supports resources inside the packaged app.asar.
      const bytes = await readFile(join(args.resourceDirectory, name));
      await writeFile(target, bytes, { flag: "wx" });
    }
    const loaded = await loadProjectFile({ filePath });
    if (loaded.encrypted || loaded.project.metadata.secret ||
        loaded.project.pageImages.length !== 2 || loaded.project.processing.assets.length ||
        loaded.project.processing.runs.length || loaded.project.processing.pages.length) {
      throw new Error("배포된 예시 프로젝트는 제공자 처리 없는 합성 데이터여야 합니다.");
    }
    for (const image of loaded.project.pageImages) {
      if (!exampleFiles.some((name) => name === image.storedRelativePath)) {
        throw new Error("예시 프로젝트가 배포된 이미지 외의 파일을 참조합니다.");
      }
      await readVerifiedProjectAsset({ projectFilePath: filePath, image, errorPrefix: "ORIGINAL_IMAGE" });
    }
    // Renderer drafts are scoped by metadata.id. Persist a fresh identity through
    // the normal atomic save/validation path, only inside this call's own copy.
    await saveProjectFile({
      filePath,
      project: {
        ...loaded.project,
        metadata: { ...loaded.project.metadata, id: randomUUID() }
      }
    });
    return { filePath, removeFailedCopy };
  } catch (error) {
    try {
      await removeFailedCopy();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "예시 프로젝트 복사 실패 후 임시 폴더 정리도 실패했습니다.");
    }
    throw error;
  }
}
