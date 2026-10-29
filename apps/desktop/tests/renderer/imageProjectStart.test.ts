import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../src/shared/projectValidation";
import type { PageImage, PreparedPageImage } from "../../src/shared/projectTypes";
import { createImageProject, startImageProject } from "../../src/renderer/imageProjectStart";

const image: PageImage = {
  id: "page-image-1",
  pageNumber: 1,
  storedRelativePath: "Book-assets/images/page-001.jpg",
  originalFileName: "page-001.jpg",
  sha256: "a".repeat(64),
  byteSize: 4,
  mimeType: "image/jpeg",
  copiedAt: "2026-07-13T00:00:00.000Z"
};

const preparedImages: PreparedPageImage[] = [
  {
    id: "prepared-image-1",
    sourcePath: "C:\\images\\01.jpg",
    fileName: "01.jpg",
    previewSrc: "translation-image://asset/prepared-image-1",
    byteSize: 4
  },
  {
    id: "prepared-image-2",
    sourcePath: "C:\\images\\02.png",
    fileName: "02.png",
    previewSrc: "translation-image://asset/prepared-image-2",
    byteSize: 8
  }
];

function setup() {
  return {
    project: createEmptyProject("새 프로젝트", false),
    chooseImageFiles: vi.fn().mockResolvedValue(["C:\\images\\page-001.jpg"]),
    chooseSaveFile: vi.fn().mockResolvedValue("C:\\projects\\Book.ctp"),
    saveProject: vi.fn().mockResolvedValue(undefined),
    importPageImages: vi.fn().mockResolvedValue([{ ok: true as const, pageImage: image }]),
    onProgress: vi.fn(),
    now: () => "2026-07-13T00:00:00.000Z"
  };
}

describe("startImageProject", () => {
  it("stops before choosing a save path when image selection is canceled", async () => {
    const args = setup();
    args.chooseImageFiles.mockResolvedValue(null);

    await expect(startImageProject(args)).resolves.toEqual({ kind: "canceled", step: "image-selection" });
    expect(args.chooseSaveFile).not.toHaveBeenCalled();
    expect(args.saveProject).not.toHaveBeenCalled();
    expect(args.importPageImages).not.toHaveBeenCalled();
  });

  it("saves, imports ordered pages, and saves the completed project", async () => {
    const args = setup();
    args.chooseImageFiles.mockResolvedValue(["C:\\images\\01.jpg", "C:\\images\\02.png"]);
    args.importPageImages.mockResolvedValue([
      { ok: true, pageImage: image },
      { ok: false, sourcePath: "C:\\images\\02.png", message: "bad image" }
    ]);

    const result = await startImageProject(args);

    expect(args.importPageImages).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Book.ctp",
      files: [
        { sourcePath: "C:\\images\\01.jpg", pageNumber: 1 },
        { sourcePath: "C:\\images\\02.png", pageNumber: 2 }
      ]
    });
    expect(args.saveProject).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "partial", importedCount: 1, failedCount: 1 });
  });

  it("reports image chooser failure without mutating storage", async () => {
    const args = setup();
    args.chooseImageFiles.mockRejectedValueOnce(new Error("chooser failed"));
    await expect(startImageProject(args)).resolves.toEqual({
      kind: "failed",
      stage: "image-selection",
      message: "chooser failed"
    });
    expect(args.chooseSaveFile).not.toHaveBeenCalled();
    expect(args.saveProject).not.toHaveBeenCalled();
  });

  it("reports save chooser failure before writing the project", async () => {
    const args = setup();
    args.chooseSaveFile.mockRejectedValueOnce(new Error("save chooser failed"));
    await expect(startImageProject(args)).resolves.toEqual({
      kind: "failed",
      stage: "save-selection",
      message: "save chooser failed"
    });
    expect(args.saveProject).not.toHaveBeenCalled();
    expect(args.importPageImages).not.toHaveBeenCalled();
  });

  it("stops before saving when save selection is canceled", async () => {
    const args = setup();
    args.chooseSaveFile.mockResolvedValue(null);
    await expect(startImageProject(args)).resolves.toEqual({ kind: "canceled", step: "save-selection" });
    expect(args.saveProject).not.toHaveBeenCalled();
    expect(args.importPageImages).not.toHaveBeenCalled();
  });

  it("does not import when the initial save fails", async () => {
    const args = setup();
    args.saveProject.mockRejectedValueOnce(new Error("save failed"));
    await expect(startImageProject(args)).resolves.toEqual({
      kind: "failed",
      stage: "initial-save",
      message: "save failed"
    });
    expect(args.importPageImages).not.toHaveBeenCalled();
  });

  it("returns the saved empty project when import rejects", async () => {
    const args = setup();
    args.importPageImages.mockRejectedValueOnce(new Error("import failed"));
    await expect(startImageProject(args)).resolves.toMatchObject({
      kind: "failed",
      stage: "image-import",
      filePath: "C:\\projects\\Book.ctp",
      importedCount: 0,
      failedCount: 1,
      dirty: false,
      message: "import failed"
    });
    expect(args.saveProject).toHaveBeenCalledOnce();
  });

  it("distinguishes all returned imports failing from cancellation", async () => {
    const args = setup();
    args.importPageImages.mockResolvedValue([
      { ok: false, sourcePath: "C:\\images\\page-001.jpg", message: "bad image" }
    ]);
    await expect(startImageProject(args)).resolves.toMatchObject({
      kind: "failed",
      stage: "image-import",
      importedCount: 0,
      failedCount: 1,
      message: "bad image"
    });
  });

  it("returns success after saving all imported images", async () => {
    const args = setup();
    await expect(startImageProject(args)).resolves.toMatchObject({
      kind: "success",
      importedCount: 1,
      failedCount: 0,
      dirty: false,
      project: { pageImages: [image] }
    });
    expect(args.saveProject).toHaveBeenCalledTimes(2);
  });

  it("does not add a translation mode to legacy projects", async () => {
    const args = setup();

    await startImageProject(args);

    expect(args.saveProject).toHaveBeenNthCalledWith(1, {
      filePath: "C:\\projects\\Book.ctp",
      project: expect.objectContaining({ settings: { defaultSourceLanguage: "unknown" } })
    });
    expect(args.saveProject).toHaveBeenNthCalledWith(2, {
      filePath: "C:\\projects\\Book.ctp",
      project: expect.objectContaining({ settings: { defaultSourceLanguage: "unknown" } })
    });
  });

  it("returns imported images as dirty when the final save fails", async () => {
    const args = setup();
    args.saveProject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("final save failed"));
    await expect(startImageProject(args)).resolves.toMatchObject({
      kind: "failed",
      stage: "final-save",
      importedCount: 1,
      failedCount: 0,
      dirty: true,
      message: "final save failed",
      project: { pageImages: [image] }
    });
  });
});

describe("createImageProject", () => {
  function createSetup() {
    const args = setup();
    return {
      ...args,
      preparedImages,
      releasePreparedPageImages: vi.fn().mockResolvedValue(undefined)
    };
  }

  it("imports prepared images in thumbnail order without opening an image picker", async () => {
    const args = createSetup();
    const imagePicker = vi.fn();
    args.importPageImages.mockResolvedValue([
      { ok: true, pageImage: image },
      { ok: false, sourcePath: "C:\\images\\02.png", message: "bad image" }
    ]);

    const argsWithImagePicker = { ...args, chooseImageFiles: imagePicker };
    const result = await createImageProject(argsWithImagePicker);

    expect(imagePicker).not.toHaveBeenCalled();
    expect(args.importPageImages).toHaveBeenCalledWith({
      projectFilePath: "C:\\projects\\Book.ctp",
      files: [
        { sourcePath: "C:\\images\\01.jpg", pageNumber: 1 },
        { sourcePath: "C:\\images\\02.png", pageNumber: 2 }
      ]
    });
    expect(args.saveProject).toHaveBeenNthCalledWith(1, {
      filePath: "C:\\projects\\Book.ctp",
      project: expect.objectContaining({ settings: { defaultSourceLanguage: "unknown" } })
    });
    expect(args.saveProject).toHaveBeenNthCalledWith(2, {
      filePath: "C:\\projects\\Book.ctp",
      project: expect.objectContaining({ settings: { defaultSourceLanguage: "unknown" } })
    });
    expect(args.saveProject.mock.calls[0][0].project.settings).not.toHaveProperty("translationMode");
    expect(result).toMatchObject({ kind: "partial", importedCount: 1, failedCount: 1 });
    expect(args.releasePreparedPageImages).toHaveBeenCalledWith(["prepared-image-1", "prepared-image-2"]);
  });

  it("keeps prepared previews when save selection is canceled", async () => {
    const args = createSetup();
    args.chooseSaveFile.mockResolvedValue(null);

    await expect(createImageProject(args)).resolves.toEqual({ kind: "canceled", step: "save-selection" });
    expect(args.saveProject).not.toHaveBeenCalled();
    expect(args.importPageImages).not.toHaveBeenCalled();
    expect(args.releasePreparedPageImages).not.toHaveBeenCalled();
  });

  it("does not import or release previews when the initial save fails", async () => {
    const args = createSetup();
    args.saveProject.mockRejectedValueOnce(new Error("save failed"));

    await expect(createImageProject(args)).resolves.toEqual({
      kind: "failed",
      stage: "initial-save",
      message: "save failed"
    });
    expect(args.importPageImages).not.toHaveBeenCalled();
    expect(args.releasePreparedPageImages).not.toHaveBeenCalled();
  });

  it("keeps prepared previews when the final save fails", async () => {
    const args = createSetup();
    args.saveProject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("final save failed"));

    await expect(createImageProject(args)).resolves.toMatchObject({
      kind: "failed",
      stage: "final-save",
      dirty: true,
      message: "final save failed"
    });
    expect(args.releasePreparedPageImages).not.toHaveBeenCalled();
  });

  it("releases every prepared preview after a fully successful project creation", async () => {
    const args = createSetup();
    args.importPageImages.mockResolvedValue([
      { ok: true, pageImage: image },
      { ok: true, pageImage: { ...image, id: "page-image-2", pageNumber: 2 } }
    ]);

    await expect(createImageProject(args)).resolves.toMatchObject({
      kind: "success",
      importedCount: 2,
      failedCount: 0,
      dirty: false
    });
    expect(args.releasePreparedPageImages).toHaveBeenCalledWith(["prepared-image-1", "prepared-image-2"]);
  });

  it("keeps the successful project result when preview cleanup fails", async () => {
    const args = createSetup();
    args.importPageImages.mockResolvedValue([
      { ok: true, pageImage: image },
      { ok: true, pageImage: { ...image, id: "page-image-2", pageNumber: 2 } }
    ]);
    args.releasePreparedPageImages.mockRejectedValueOnce(new Error("preview cleanup failed"));

    await expect(createImageProject(args)).resolves.toMatchObject({
      kind: "success",
      importedCount: 2,
      failedCount: 0,
      dirty: false
    });
    expect(args.saveProject).toHaveBeenCalledTimes(2);
    expect(args.releasePreparedPageImages).toHaveBeenCalledWith(["prepared-image-1", "prepared-image-2"]);
  });
});
