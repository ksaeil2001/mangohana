export type RecentProject = {
  recentProjectId: string;
  title: string;
  openedAt: string;
};

type RecentProjectStorage = Pick<Storage, "getItem" | "setItem">;

export const RECENT_PROJECTS_STORAGE_KEY = "translation-editor:recent-projects:v1";
const MAX_RECENT_PROJECTS = 8;

export function loadRecentProjects(storage: RecentProjectStorage): RecentProject[] {
  try {
    const serialized = storage.getItem(RECENT_PROJECTS_STORAGE_KEY);
    if (!serialized) return [];
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentProject).slice(0, MAX_RECENT_PROJECTS);
  } catch {
    return [];
  }
}

export function addRecentProject(storage: RecentProjectStorage, project: RecentProject): RecentProject[] {
  const nextProjects = [
    project,
    ...loadRecentProjects(storage).filter(
      (candidate) => candidate.recentProjectId !== project.recentProjectId
    )
  ].slice(0, MAX_RECENT_PROJECTS);
  saveRecentProjects(storage, nextProjects);
  return nextProjects;
}

export function removeRecentProject(storage: RecentProjectStorage, recentProjectId: string): RecentProject[] {
  const nextProjects = loadRecentProjects(storage).filter(
    (candidate) => candidate.recentProjectId !== recentProjectId
  );
  saveRecentProjects(storage, nextProjects);
  return nextProjects;
}

function saveRecentProjects(storage: RecentProjectStorage, projects: RecentProject[]) {
  try {
    storage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Recent history is optional renderer-local state.
  }
}

function isRecentProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecentProject>;
  return (
    typeof candidate.recentProjectId === "string" &&
    candidate.recentProjectId.length > 0 &&
    typeof candidate.title === "string" &&
    typeof candidate.openedAt === "string"
  );
}
