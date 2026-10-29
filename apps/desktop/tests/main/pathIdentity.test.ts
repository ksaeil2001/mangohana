import { describe, expect, it } from "vitest";
import {
  absoluteParentDirectory,
  filesystemPathIdentity,
  projectRelativePathIdentity,
  sameFilesystemPath
} from "../../src/main/pathIdentity";
import { areProjectDirectoriesSame } from "../../src/main/projectAssetRelocation";
import { deduplicatePageImageSourcePaths } from "../../src/main/pendingPageImageImports";
import { createProjectStorageCoordinator } from "../../src/main/projectStorageCoordinator";

describe("Main filesystem path identity", () => {
  it("treats Windows case and separator variants as the same path", () => {
    expect(
      sameFilesystemPath(
        "C:\\Projects\\Book\\Page.png",
        "c:/projects/book/page.PNG",
        "win32"
      )
    ).toBe(true);
    expect(
      filesystemPathIdentity("C:/Projects/Book.ctp", "win32")
    ).toBe(filesystemPathIdentity("c:\\projects\\BOOK.ctp", "win32"));
    const coordinator = createProjectStorageCoordinator({ pathSemantics: "win32" });
    coordinator.claimImport("C:\\Projects\\Book.ctp", "session-1");
    expect(() => coordinator.assertImportAvailable(
      "c:/projects/BOOK.ctp",
      "session-2"
    )).toThrow(/PROJECT_IMPORT_BUSY/);
  });

  it("keeps case-distinct POSIX paths and project assets separate", () => {
    expect(sameFilesystemPath("/tmp/Book", "/tmp/book", "posix")).toBe(false);
    expect(projectRelativePathIdentity("Book-assets/Page.png", "posix")).not.toBe(
      projectRelativePathIdentity("Book-assets/page.png", "posix")
    );
    expect(
      deduplicatePageImageSourcePaths(
        ["/tmp/Page.png", "/tmp/page.png"],
        "posix"
      )
    ).toEqual(["/tmp/Page.png", "/tmp/page.png"]);
    expect(
      deduplicatePageImageSourcePaths(
        ["C:\\tmp\\Page.png", "c:/TMP/page.PNG"],
        "win32"
      )
    ).toEqual(["C:\\tmp\\Page.png"]);
    const coordinator = createProjectStorageCoordinator({ pathSemantics: "posix" });
    coordinator.claimImport("/tmp/Book.ctp", "session-1");
    expect(() => coordinator.assertImportAvailable(
      "/tmp/book.ctp",
      "session-2"
    )).not.toThrow();
  });

  it("requires relocation for case-only POSIX directory changes", () => {
    expect(
      areProjectDirectoriesSame(
        "/tmp/Book/Book.ctp",
        "/tmp/book/Book-copy.ctp",
        "posix"
      )
    ).toBe(false);
    expect(
      areProjectDirectoriesSame(
        "C:\\Projects\\Book\\Book.ctp",
        "c:\\projects\\book\\Book-copy.ctp",
        "win32"
      )
    ).toBe(true);
  });

  it("uses the selected platform semantics for recent-project parent directories", () => {
    expect(absoluteParentDirectory("/home/user/Book.ctp", "posix")).toBe(
      "/home/user"
    );
    expect(
      absoluteParentDirectory("C:\\projects\\manga\\Book.ctp", "win32")
    ).toBe("C:\\projects\\manga");
    expect(absoluteParentDirectory("relative/Book.ctp", "posix")).toBeNull();
  });
});
