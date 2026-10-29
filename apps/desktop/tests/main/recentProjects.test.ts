import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecentProjectRegistry } from "../../src/main/recentProjects";

describe("Main recent project registry", () => {
  it("returns the last successful project directory without exposing its file path", () => {
    const registry = createRecentProjectRegistry({
      createId: () => "recent-directory-1",
      now: () => "2026-07-27T00:00:00.000Z",
      pathSemantics: "win32"
    });

    expect(registry.getLastProjectDirectory()).toBeNull();

    registry.remember("C:\\projects\\manga\\Book.ctp", "Book");

    expect(registry.getLastProjectDirectory()).toBe("C:\\projects\\manga");
  });

  it("tracks the directory of the most recently remembered project across reloads", () => {
    const storageFilePath = join(mkdtempSync(join(tmpdir(), "recent-project-directories-")), "recent.json");
    const first = createRecentProjectRegistry({
      storageFilePath,
      createId: (() => {
        let id = 0;
        return () => `recent-directory-${++id}`;
      })(),
      now: (() => {
        let timestamp = 0;
        return () => `2026-07-27T00:0${timestamp++}:00.000Z`;
      })(),
      pathSemantics: "win32"
    });

    first.remember("C:\\projects\\first\\First.ctp", "First");
    first.remember("C:\\projects\\second\\Second.ctp", "Second");

    expect(first.getLastProjectDirectory()).toBe("C:\\projects\\second");
    expect(createRecentProjectRegistry({ storageFilePath, pathSemantics: "win32" }).getLastProjectDirectory()).toBe(
      "C:\\projects\\second"
    );
  });

  it("ignores a malformed relative path when choosing the last project directory", () => {
    const registry = createRecentProjectRegistry({
      createId: () => "recent-relative-1",
      now: () => "2026-07-27T00:00:00.000Z",
      pathSemantics: "win32"
    });

    registry.remember("relative\\Book.ctp", "Book");

    expect(registry.getLastProjectDirectory()).toBeNull();
  });

  it("returns opaque IDs to the Renderer while retaining absolute paths only in Main", () => {
    const registry = createRecentProjectRegistry({
      createId: () => "recent-opaque-1",
      now: () => "2026-07-27T00:00:00.000Z",
      pathSemantics: "win32"
    });

    const recent = registry.remember("C:\\private\\Book.ctp", "Book");

    expect(recent).toEqual({
      recentProjectId: "recent-opaque-1",
      title: "Book",
      openedAt: "2026-07-27T00:00:00.000Z"
    });
    expect(JSON.stringify(registry.list())).not.toContain("C:\\\\private");
    expect(registry.resolve("recent-opaque-1")).toBe("C:\\private\\Book.ctp");
  });

  it("persists Main-owned paths across registry instances without exposing them in DTOs", () => {
    const storageFilePath = join(mkdtempSync(join(tmpdir(), "recent-projects-")), "recent.json");
    const first = createRecentProjectRegistry({
      storageFilePath,
      createId: () => "recent-persisted",
      now: () => "2026-07-27T00:00:00.000Z",
      pathSemantics: "win32"
    });
    first.remember("C:\\private\\Persisted.ctp", "Persisted");

    const restored = createRecentProjectRegistry({
      storageFilePath,
      pathSemantics: "win32"
    });

    expect(restored.list()).toEqual([{
      recentProjectId: "recent-persisted",
      title: "Persisted",
      openedAt: "2026-07-27T00:00:00.000Z"
    }]);
    expect(restored.resolve("recent-persisted")).toBe("C:\\private\\Persisted.ctp");
    expect(restored.remove("recent-persisted")).toEqual([]);
    expect(
      createRecentProjectRegistry({ storageFilePath, pathSemantics: "win32" }).list()
    ).toEqual([]);
  });

  it("keeps case-distinct POSIX projects separate and returns their native directory", () => {
    const registry = createRecentProjectRegistry({
      createId: (() => {
        let id = 0;
        return () => `recent-posix-${++id}`;
      })(),
      now: () => "2026-07-27T00:00:00.000Z",
      pathSemantics: "posix"
    });

    const upper = registry.remember("/home/user/Book/Book.ctp", "Upper");
    const lower = registry.remember("/home/user/book/Book.ctp", "Lower");

    expect(lower.recentProjectId).not.toBe(upper.recentProjectId);
    expect(registry.list()).toHaveLength(2);
    expect(registry.getLastProjectDirectory()).toBe("/home/user/book");
  });
});
