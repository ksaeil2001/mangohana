import { describe, expect, it } from "vitest";
import type { PreparedPageImage } from "../../src/shared/projectTypes";
import {
  canConfirmProjectSetup,
  initialProjectSetupState,
  projectSetupReducer
} from "../../src/renderer/projectSetupState";

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

describe("project setup state", () => {
  it("starts in precise mode with no prepared images", () => {
    expect(initialProjectSetupState).toEqual({
      files: [],
      mode: "precise",
      duplicateCount: 0,
      isPreparing: false,
      creationCheckpoint: "draft"
    });
  });

  it("naturally sorts picker files when starting an empty draft", () => {
    const state = projectSetupReducer(initialProjectSetupState, {
      type: "picker-files-added",
      files: [
        preparedPageImage({ id: "ten", sourcePath: "C:\\images\\page-10.png", fileName: "page-10.png" }),
        preparedPageImage({ id: "two", sourcePath: "C:\\images\\page-2.png", fileName: "page-2.png" }),
        preparedPageImage({ id: "one", sourcePath: "C:\\images\\page-1.png", fileName: "page-1.png" })
      ]
    });

    expect(state.files.map((file) => file.id)).toEqual(["one", "two", "ten"]);
  });

  it("preserves appended drop order until automatic sorting is requested", () => {
    const first = preparedPageImage({ id: "two", sourcePath: "C:\\images\\page-2.png", fileName: "page-2.png" });
    const dropped = [
      preparedPageImage({ id: "ten", sourcePath: "C:\\images\\page-10.png", fileName: "page-10.png" }),
      preparedPageImage({ id: "one", sourcePath: "C:\\images\\page-1.png", fileName: "page-1.png" })
    ];
    const appended = projectSetupReducer(
      { ...initialProjectSetupState, files: [first] },
      { type: "dropped-files-added", files: dropped }
    );

    expect(appended.files.map((file) => file.id)).toEqual(["two", "ten", "one"]);

    const sorted = projectSetupReducer(appended, { type: "auto-sorted" });
    expect(sorted.files.map((file) => file.id)).toEqual(["one", "two", "ten"]);
  });

  it("moves a page to a stable destination without mutating the previous order", () => {
    const files = [
      preparedPageImage({ id: "one" }),
      preparedPageImage({ id: "two" }),
      preparedPageImage({ id: "three" })
    ];
    const before = { ...initialProjectSetupState, files };

    const movedLeft = projectSetupReducer(before, { type: "file-moved", id: "three", destinationIndex: 1 });
    const movedRight = projectSetupReducer(movedLeft, { type: "file-moved", id: "one", destinationIndex: 2 });

    expect(movedLeft.files.map((file) => file.id)).toEqual(["one", "three", "two"]);
    expect(movedRight.files.map((file) => file.id)).toEqual(["three", "two", "one"]);
    expect(before.files.map((file) => file.id)).toEqual(["one", "two", "three"]);
  });

  it("removes one page while preserving the remaining order", () => {
    const files = ["one", "two", "three"].map((id) => preparedPageImage({ id }));
    const state = projectSetupReducer(
      { ...initialProjectSetupState, files },
      { type: "file-removed", id: "two" }
    );

    expect(state.files.map((file) => file.id)).toEqual(["one", "three"]);
    expect(files.map((file) => file.id)).toEqual(["one", "two", "three"]);
  });

  it("counts duplicate ids across additions and dismisses the warning", () => {
    const first = preparedPageImage({ id: "same", sourcePath: "C:\\images\\page-1.png" });
    const duplicate = preparedPageImage({ id: "same", sourcePath: "C:\\images\\page-copy.png" });
    const duplicatePath = preparedPageImage({ id: "other", sourcePath: "c:\\IMAGES\\PAGE-1.PNG" });
    const state = projectSetupReducer(
      { ...initialProjectSetupState, files: [first] },
      { type: "picker-files-added", files: [duplicate, duplicatePath] }
    );

    expect(state.files).toEqual([first]);
    expect(state.duplicateCount).toBe(2);
    expect(projectSetupReducer(state, { type: "duplicates-dismissed" }).duplicateCount).toBe(0);
  });

  it("disables confirmation with no images or while preparation is busy", () => {
    const withImage = { ...initialProjectSetupState, files: [preparedPageImage()] };

    expect(canConfirmProjectSetup(initialProjectSetupState)).toBe(false);
    expect(canConfirmProjectSetup(withImage)).toBe(true);
    expect(canConfirmProjectSetup({ ...withImage, isPreparing: true })).toBe(false);
  });
});
