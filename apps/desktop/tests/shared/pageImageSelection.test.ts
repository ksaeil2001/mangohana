import { describe, expect, it } from "vitest";
import type { PreparedPageImage } from "../../src/shared/projectTypes";
import { dedupePageFiles, movePageFile, naturalSortPageFiles } from "../../src/shared/pageImageSelection";

function preparedPageImage(overrides: Partial<PreparedPageImage> = {}): PreparedPageImage {
  return {
    id: "page-1",
    sourcePath: "C:\\images\\page-1.png",
    fileName: "page-1.png",
    previewSrc: "preview:page-1",
    byteSize: 100,
    ...overrides
  };
}

describe("page image selection", () => {
  it("sorts page files by natural numeric file name order without mutating input", () => {
    const files = [
      preparedPageImage({ id: "ten", fileName: "page-10.png" }),
      preparedPageImage({ id: "two", fileName: "page-2.png" }),
      preparedPageImage({ id: "one", fileName: "page-1.png" })
    ];

    const sorted = naturalSortPageFiles(files);

    expect(sorted.map((file) => file.id)).toEqual(["one", "two", "ten"]);
    expect(sorted).not.toBe(files);
    expect(files.map((file) => file.id)).toEqual(["ten", "two", "one"]);
  });

  it("deduplicates Windows paths case-insensitively and keeps the first occurrence", () => {
    const first = preparedPageImage({ id: "first", sourcePath: "C:\\Images\\Page-1.PNG" });
    const duplicate = preparedPageImage({ id: "duplicate", sourcePath: "c:\\images\\page-1.png" });
    const unique = preparedPageImage({ id: "unique", sourcePath: "C:\\Images\\Page-2.png" });
    const files = [first, duplicate, unique];

    const result = dedupePageFiles(files);

    expect(result.files).toEqual([first, unique]);
    expect(result.duplicateIds).toEqual(["duplicate"]);
    expect(files).toEqual([first, duplicate, unique]);
  });

  it("deduplicates opaque prepared images without requiring renderer-visible source paths", () => {
    const first = preparedPageImage({
      id: "opaque-first",
      sourcePath: undefined,
      importBatchId: "batch-1",
      preparedImageId: "prepared-1"
    });
    const duplicate = preparedPageImage({
      id: "opaque-duplicate",
      sourcePath: undefined,
      importBatchId: "batch-1",
      preparedImageId: "prepared-1"
    });
    const unique = preparedPageImage({
      id: "opaque-unique",
      sourcePath: undefined,
      importBatchId: "batch-1",
      preparedImageId: "prepared-2"
    });

    expect(dedupePageFiles([first, duplicate, unique])).toEqual({
      files: [first, unique],
      duplicateIds: ["opaque-duplicate"]
    });
  });

  it("moves an item by id to a bounded destination without mutating input", () => {
    const files = [
      preparedPageImage({ id: "one" }),
      preparedPageImage({ id: "two" }),
      preparedPageImage({ id: "three" })
    ];

    expect(movePageFile(files, "one", 99).map((file) => file.id)).toEqual(["two", "three", "one"]);
    expect(movePageFile(files, "three", -4).map((file) => file.id)).toEqual(["three", "one", "two"]);
    expect(movePageFile(files, "missing", 1).map((file) => file.id)).toEqual(["one", "two", "three"]);
    expect(movePageFile(files, "missing", 1)).not.toBe(files);
    expect(files.map((file) => file.id)).toEqual(["one", "two", "three"]);
  });
});
