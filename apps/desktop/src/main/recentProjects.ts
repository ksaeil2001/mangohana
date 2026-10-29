import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  absoluteParentDirectory,
  filesystemPathIdentity,
  type PathSemantics
} from "./pathIdentity.js";

export type RecentProjectDto = {
  recentProjectId: string;
  title: string;
  openedAt: string;
};

type RecentProjectEntry = RecentProjectDto & {
  filePath: string;
};

export function createRecentProjectRegistry(options: {
  createId?: () => string;
  now?: () => string;
  maxEntries?: number;
  storageFilePath?: string;
  pathSemantics?: PathSemantics;
} = {}) {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const maxEntries = options.maxEntries ?? 8;
  let entries: RecentProjectEntry[] = loadEntries(options.storageFilePath).slice(0, maxEntries);

  function persist(): void {
    if (!options.storageFilePath) return;
    try {
      mkdirSync(dirname(options.storageFilePath), { recursive: true });
      writeFileSync(options.storageFilePath, JSON.stringify(entries), "utf8");
    } catch {
      // Recent history persistence is optional and must not invalidate an opened session.
    }
  }

  function remember(filePath: string, title: string): RecentProjectDto {
    const normalizedPath = filesystemPathIdentity(filePath, options.pathSemantics);
    const existing = entries.find(
      (entry) =>
        filesystemPathIdentity(entry.filePath, options.pathSemantics) ===
        normalizedPath
    );
    const entry: RecentProjectEntry = {
      recentProjectId: existing?.recentProjectId ?? createId(),
      filePath,
      title: title.trim() || "제목 없는 프로젝트",
      openedAt: now()
    };
    entries = [
      entry,
      ...entries.filter((candidate) => candidate.recentProjectId !== entry.recentProjectId)
    ].slice(0, maxEntries);
    persist();
    return toDto(entry);
  }

  function list(): RecentProjectDto[] {
    return entries.map(toDto);
  }

  function getLastProjectDirectory(): string | null {
    const latestEntry = entries[0];
    if (!latestEntry) return null;
    return absoluteParentDirectory(latestEntry.filePath, options.pathSemantics);
  }

  function resolve(recentProjectId: string): string {
    const entry = entries.find((candidate) => candidate.recentProjectId === recentProjectId);
    if (!entry) throw new Error("Unknown recent project");
    return entry.filePath;
  }

  function remove(recentProjectId: string): RecentProjectDto[] {
    entries = entries.filter((candidate) => candidate.recentProjectId !== recentProjectId);
    persist();
    return list();
  }

  return { remember, list, getLastProjectDirectory, resolve, remove };
}

export type RecentProjectRegistry = ReturnType<typeof createRecentProjectRegistry>;

function toDto(entry: RecentProjectEntry): RecentProjectDto {
  return {
    recentProjectId: entry.recentProjectId,
    title: entry.title,
    openedAt: entry.openedAt
  };
}

function loadEntries(storageFilePath: string | undefined): RecentProjectEntry[] {
  if (!storageFilePath) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(storageFilePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentProjectEntry);
  } catch {
    return [];
  }
}

function isRecentProjectEntry(value: unknown): value is RecentProjectEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RecentProjectEntry>;
  return (
    typeof entry.recentProjectId === "string" &&
    entry.recentProjectId.length > 0 &&
    typeof entry.filePath === "string" &&
    entry.filePath.length > 0 &&
    typeof entry.title === "string" &&
    typeof entry.openedAt === "string"
  );
}
