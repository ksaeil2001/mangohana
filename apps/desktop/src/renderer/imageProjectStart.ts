import type { ElectronProjectApi } from "./electronApi";
import type { PageImage, PreparedPageImage, TranslationProject } from "../shared/projectTypes";

type ImportPageImages = NonNullable<ElectronProjectApi["importPageImages"]>;
type ChooseSaveFile = NonNullable<ElectronProjectApi["chooseSaveFile"]>;

export type ImageProjectStartPhase =
  | "image-selection"
  | "save-selection"
  | "initial-save"
  | "image-import"
  | "final-save";

export type StartImageProjectArgs = {
  project: TranslationProject;
  chooseImageFiles: () => Promise<string[] | null>;
  chooseSaveFile: ChooseSaveFile;
  saveProject: ElectronProjectApi["saveProject"];
  importPageImages: ImportPageImages;
  onProgress: (phase: ImageProjectStartPhase) => void;
  now?: () => string;
};

export type CreateImageProjectArgs = {
  project: TranslationProject;
  preparedImages: PreparedPageImage[];
  chooseSaveFile: ChooseSaveFile;
  saveProject: ElectronProjectApi["saveProject"];
  importPageImages: ImportPageImages;
  releasePreparedPageImages: (ids: string[]) => Promise<void>;
  onProgress: (phase: ImageProjectStartPhase) => void;
  now?: () => string;
};

type PersistImageProjectArgs = CreateImageProjectArgs;

type AppliedProject = {
  filePath: string;
  project: TranslationProject;
  importedCount: number;
  failedCount: number;
  dirty: boolean;
};

export type ImageProjectStartResult =
  | { kind: "canceled"; step: "image-selection" | "save-selection" }
  | ({ kind: "success" | "partial" } & AppliedProject)
  | ({ kind: "failed"; stage: "image-selection" | "save-selection" | "initial-save"; message: string })
  | ({ kind: "failed"; stage: "image-import"; message: string } & AppliedProject)
  | ({ kind: "failed"; stage: "final-save"; message: string } & AppliedProject);

export async function startImageProject(args: StartImageProjectArgs): Promise<ImageProjectStartResult> {
  args.onProgress("image-selection");
  let sourcePaths: string[];
  try {
    sourcePaths = (await args.chooseImageFiles()) ?? [];
  } catch (error) {
    return {
      kind: "failed",
      stage: "image-selection",
      message: toMessage(error, "이미지 선택 창을 열지 못했습니다.")
    };
  }
  if (sourcePaths.length === 0) return { kind: "canceled", step: "image-selection" };

  return persistImageProject({
    project: args.project,
    preparedImages: sourcePaths.map((sourcePath, index) => ({
      id: `legacy-page-image-${index + 1}`,
      sourcePath,
      fileName: sourcePath,
      previewSrc: "",
      byteSize: 0
    })),
    chooseSaveFile: args.chooseSaveFile,
    saveProject: args.saveProject,
    importPageImages: args.importPageImages,
    releasePreparedPageImages: async () => undefined,
    onProgress: args.onProgress,
    now: args.now
  });
}

export async function createImageProject(args: CreateImageProjectArgs): Promise<ImageProjectStartResult> {
  return persistImageProject(args);
}

async function persistImageProject(args: PersistImageProjectArgs): Promise<ImageProjectStartResult> {
  args.onProgress("save-selection");
  let filePath: string | null;
  try {
    filePath = await args.chooseSaveFile({ defaultPath: `${args.project.metadata.title || "새 프로젝트"}.ctp` });
  } catch (error) {
    return {
      kind: "failed",
      stage: "save-selection",
      message: toMessage(error, "프로젝트 저장 위치를 선택하지 못했습니다.")
    };
  }
  if (!filePath) return { kind: "canceled", step: "save-selection" };

  args.onProgress("initial-save");
  try {
    await args.saveProject({ filePath, project: args.project });
  } catch (error) {
    return {
      kind: "failed",
      stage: "initial-save",
      message: toMessage(error, "프로젝트를 저장하지 못했습니다.")
    };
  }

  args.onProgress("image-import");
  let results: Awaited<ReturnType<ImportPageImages>>;
  try {
    results = await args.importPageImages({
      projectFilePath: filePath,
      files: args.preparedImages.map(({ sourcePath }, index) => {
        if (!sourcePath) throw new Error("Legacy image import requires a prepared source path");
        return { sourcePath, pageNumber: index + 1 };
      })
    });
  } catch (error) {
    return failedImport(
      filePath,
      args.project,
      args.preparedImages.length,
      toMessage(error, "이미지를 불러오지 못했습니다.")
    );
  }

  const importedImages = results.flatMap((result) =>
    result.ok && "pageImage" in result ? [result.pageImage] : []
  );
  const failedCount = results.length - importedImages.length;
  if (importedImages.length === 0) {
    const firstFailure = results.find((result) => !result.ok);
    return failedImport(
      filePath,
      args.project,
      failedCount,
      firstFailure?.message ?? "이미지를 불러오지 못했습니다."
    );
  }

  const project = withImages(args.project, importedImages, (args.now ?? (() => new Date().toISOString()))());
  args.onProgress("final-save");
  try {
    await args.saveProject({ filePath, project });
  } catch (error) {
    return {
      kind: "failed",
      stage: "final-save",
      message: toMessage(error, "가져온 이미지를 프로젝트에 저장하지 못했습니다."),
      filePath,
      project,
      importedCount: importedImages.length,
      failedCount,
      dirty: true
    };
  }

  const result = {
    kind: failedCount > 0 ? "partial" : "success",
    filePath,
    project,
    importedCount: importedImages.length,
    failedCount,
    dirty: false
  } as const;

  try {
    await args.releasePreparedPageImages(args.preparedImages.map(({ id }) => id));
  } catch {
    // Project persistence has already succeeded; preview cleanup is best-effort.
  }
  return result;
}

function withImages(project: TranslationProject, images: PageImage[], updatedAt: string): TranslationProject {
  return { ...project, pageImages: images, metadata: { ...project.metadata, updatedAt } };
}

function failedImport(
  filePath: string,
  project: TranslationProject,
  failedCount: number,
  message: string
): ImageProjectStartResult {
  return {
    kind: "failed",
    stage: "image-import",
    message,
    filePath,
    project,
    importedCount: 0,
    failedCount,
    dirty: false
  };
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
