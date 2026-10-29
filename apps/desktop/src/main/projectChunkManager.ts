import type {
  ChunkedProjectSnapshot,
  PageChunk,
  ProjectManifest
} from "../shared/projectChunkTypes.js";
import {
  composeProjectFromChunks,
  computeChunkHash,
  decomposeProjectToChunks
} from "../shared/projectChunkAdapter.js";
import type { SecretProjectSecurityV1, TranslationProjectV2 } from "../shared/projectTypes.js";

export type ProjectChunkTracker = {
  getManifest: () => ProjectManifest;
  getPageChunk: (pageNumber: number) => PageChunk | undefined;
  getAllChunks: () => PageChunk[];
  getDirtyPageNumbers: () => number[];
  isManifestDirty: () => boolean;
  isDirty: () => boolean;
  markClean: () => void;
  updateManifest: (updater: (manifest: ProjectManifest) => void) => void;
  updatePageChunk: (pageNumber: number, updater: (chunk: PageChunk) => void) => void;
  syncFromProject: (
    project: TranslationProjectV2,
    security?: SecretProjectSecurityV1
  ) => { dirtyPageNumbers: number[]; manifestDirty: boolean };
  toProject: () => TranslationProjectV2;
  toSnapshot: () => ChunkedProjectSnapshot;
};

export function createProjectChunkTracker(
  initialProject: TranslationProjectV2,
  initialSecurity?: SecretProjectSecurityV1
): ProjectChunkTracker {
  let { manifest, chunks } = decomposeProjectToChunks(initialProject, initialSecurity);
  const chunkMap = new Map<number, PageChunk>();
  const chunkHashes = new Map<number, string>();

  for (const chunk of chunks) {
    chunkMap.set(chunk.pageNumber, chunk);
    chunkHashes.set(chunk.pageNumber, computeChunkHash(chunk));
  }

  let dirtyManifest = false;
  const dirtyChunks = new Set<number>();

  function getManifest(): ProjectManifest {
    return structuredClone(manifest);
  }

  function getPageChunk(pageNumber: number): PageChunk | undefined {
    const chunk = chunkMap.get(pageNumber);
    return chunk ? structuredClone(chunk) : undefined;
  }

  function getAllChunks(): PageChunk[] {
    return [...chunkMap.values()].map((c) => structuredClone(c));
  }

  function getDirtyPageNumbers(): number[] {
    return [...dirtyChunks].sort((a, b) => a - b);
  }

  function isManifestDirty(): boolean {
    return dirtyManifest;
  }

  function isDirty(): boolean {
    return dirtyManifest || dirtyChunks.size > 0;
  }

  function markClean(): void {
    dirtyManifest = false;
    dirtyChunks.clear();
    for (const chunk of chunkMap.values()) {
      chunkHashes.set(chunk.pageNumber, computeChunkHash(chunk));
    }
  }

  function updateManifest(updater: (manifest: ProjectManifest) => void): void {
    updater(manifest);
    dirtyManifest = true;
  }

  function updatePageChunk(pageNumber: number, updater: (chunk: PageChunk) => void): void {
    const existing = chunkMap.get(pageNumber);
    if (!existing) {
      throw new Error(`Page chunk ${pageNumber} not found`);
    }
    updater(existing);
    const newHash = computeChunkHash(existing);
    if (newHash !== chunkHashes.get(pageNumber)) {
      dirtyChunks.add(pageNumber);
    }
    // Update summary in manifest index
    const indexEntry = manifest.pageIndex.find((p) => p.pageNumber === pageNumber);
    if (indexEntry) {
      indexEntry.dialogueCount = existing.dialogueLines.length;
      indexEntry.chunkHash = newHash;
      indexEntry.hasTypesetting = existing.dialogueLines.some((l) => l.typesetting !== undefined);
      dirtyManifest = true;
    }
  }

  function syncFromProject(
    project: TranslationProjectV2,
    security?: SecretProjectSecurityV1
  ): { dirtyPageNumbers: number[]; manifestDirty: boolean } {
    const decomposed = decomposeProjectToChunks(project, security);
    const previousManifestHash = JSON.stringify(manifest);
    const newManifestHash = JSON.stringify(decomposed.manifest);

    if (previousManifestHash !== newManifestHash) {
      manifest = decomposed.manifest;
      dirtyManifest = true;
    }

    const nextChunkMap = new Map<number, PageChunk>();
    for (const nextChunk of decomposed.chunks) {
      nextChunkMap.set(nextChunk.pageNumber, nextChunk);
      const nextHash = computeChunkHash(nextChunk);
      const prevHash = chunkHashes.get(nextChunk.pageNumber);
      if (prevHash !== nextHash) {
        dirtyChunks.add(nextChunk.pageNumber);
      }
    }

    // Check for removed page numbers
    for (const oldPageNum of chunkMap.keys()) {
      if (!nextChunkMap.has(oldPageNum)) {
        dirtyChunks.add(oldPageNum);
        dirtyManifest = true;
      }
    }

    chunkMap.clear();
    for (const [pageNum, chunk] of nextChunkMap) {
      chunkMap.set(pageNum, chunk);
    }

    return {
      dirtyPageNumbers: getDirtyPageNumbers(),
      manifestDirty: dirtyManifest
    };
  }

  function toProject(): TranslationProjectV2 {
    return composeProjectFromChunks({
      manifest: structuredClone(manifest),
      chunks: getAllChunks()
    });
  }

  function toSnapshot(): ChunkedProjectSnapshot {
    return {
      manifest: structuredClone(manifest),
      chunks: getAllChunks()
    };
  }

  return {
    getManifest,
    getPageChunk,
    getAllChunks,
    getDirtyPageNumbers,
    isManifestDirty,
    isDirty,
    markClean,
    updateManifest,
    updatePageChunk,
    syncFromProject,
    toProject,
    toSnapshot
  };
}
