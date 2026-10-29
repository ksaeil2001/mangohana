import { beforeEach, describe, expect, it } from "vitest";
import {
  RECENT_PROJECTS_STORAGE_KEY,
  addRecentProject,
  loadRecentProjects,
  removeRecentProject
} from "../../src/renderer/recentProjects";

describe("recent projects", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps only opaque recent IDs and never stores absolute paths", () => {
    const storage = window.localStorage;
    const openedAt = "2026-07-17T00:00:00.000Z";

    for (let index = 0; index < 9; index += 1) {
      addRecentProject(storage, {
        recentProjectId: `recent-${index}`,
        title: `Book ${index}`,
        openedAt
      });
    }
    addRecentProject(storage, {
      recentProjectId: "recent-4",
      title: "Book Four Again",
      openedAt: "2026-07-17T01:00:00.000Z"
    });

    const projects = loadRecentProjects(storage);
    expect(projects).toHaveLength(8);
    expect(projects[0]).toEqual({
      recentProjectId: "recent-4",
      title: "Book Four Again",
      openedAt: "2026-07-17T01:00:00.000Z"
    });
    expect(projects.filter((project) => project.recentProjectId === "recent-4")).toHaveLength(1);
    expect(projects.some((project) => project.title === "Book 0")).toBe(false);
    expect(storage.getItem(RECENT_PROJECTS_STORAGE_KEY)).not.toContain("C:\\\\");
  });

  it("removes a recent opaque ID", () => {
    const storage = window.localStorage;
    addRecentProject(storage, {
      recentProjectId: "recent-book",
      title: "Book",
      openedAt: "2026-07-17T00:00:00.000Z"
    });

    expect(removeRecentProject(storage, "recent-book")).toEqual([]);
    expect(loadRecentProjects(storage)).toEqual([]);
  });

  it("tolerates corrupt and unavailable storage without logging project paths", () => {
    window.localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, "not-json");
    expect(loadRecentProjects(window.localStorage)).toEqual([]);

    const unavailableStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      }
    };
    const project = {
      recentProjectId: "recent-secret",
      title: "Secret",
      openedAt: "2026-07-17T00:00:00.000Z"
    };

    expect(loadRecentProjects(unavailableStorage)).toEqual([]);
    expect(addRecentProject(unavailableStorage, project)).toEqual([project]);
    expect(removeRecentProject(unavailableStorage, project.recentProjectId)).toEqual([]);
  });
});
