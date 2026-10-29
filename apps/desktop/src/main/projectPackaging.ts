import { composeProjectFromChunks, decomposeProjectToChunks } from "../shared/projectChunkAdapter.js";
import type { PageChunk } from "../shared/projectChunkTypes.js";
import {
  loadIncrementalProject,
  saveIncrementalProject
} from "./incrementalProjectStorage.js";
import type { SecretProjectProtection } from "./projectProtection.js";
import { loadProjectFile, saveProjectFile } from "./projectStorage.js";

export type ExportChunkedToMonolithicArgs = {
  chunkedDirectory: string;
  targetCtpFilePath: string;
  password?: string;
  protection?: SecretProjectProtection;
};

export type ImportMonolithicToChunkedArgs = {
  sourceCtpFilePath: string;
  targetChunkedDirectory: string;
  password?: string;
  protection?: SecretProjectProtection;
};

/**
 * Converts a chunked project directory into a single-file .ctp project.
 */
export async function exportChunkedToMonolithicCtp(
  args: ExportChunkedToMonolithicArgs
): Promise<void> {
  const loaded = await loadIncrementalProject({
    targetDirectory: args.chunkedDirectory,
    password: args.password,
    protection: args.protection
  });

  const availablePages = await loaded.listAvailablePageNumbers();
  const chunks: PageChunk[] = [];
  for (const pageNumber of availablePages) {
    const chunk = await loaded.chunkLoader(pageNumber);
    if (chunk) chunks.push(chunk);
  }

  const composedProject = composeProjectFromChunks({
    manifest: loaded.manifest,
    chunks
  });

  await saveProjectFile({
    filePath: args.targetCtpFilePath,
    project: composedProject,
    password: args.password,
    protection: loaded.protection ?? args.protection,
    security: loaded.manifest.security
  });
}

/**
 * Unpacks a single-file .ctp project into an incremental chunked project directory.
 */
export async function importMonolithicToChunked(
  args: ImportMonolithicToChunkedArgs
): Promise<void> {
  const loaded = await loadProjectFile({
    filePath: args.sourceCtpFilePath,
    password: args.password,
    protection: args.protection
  });

  const { manifest, chunks } = decomposeProjectToChunks(loaded.project, loaded.security);
  const allPageNumbers = manifest.pageIndex.map((p) => p.pageNumber);

  await saveIncrementalProject({
    targetDirectory: args.targetChunkedDirectory,
    manifest,
    dirtyChunks: chunks,
    allPageNumbers,
    password: args.password,
    protection: loaded.protection ?? args.protection
  });
}

export type ExportSqliteToMonolithicArgs = {
  sqliteFilePath: string;
  targetCtpFilePath: string;
  password?: string;
  protection?: SecretProjectProtection;
};

export type ImportMonolithicToSqliteArgs = {
  sourceCtpFilePath: string;
  targetSqliteFilePath: string;
  password?: string;
  protection?: SecretProjectProtection;
};

/**
 * Converts an SQLite .ctp-db database project into a standard single-file .ctp project.
 */
export async function exportSqliteToMonolithicCtp(
  args: ExportSqliteToMonolithicArgs
): Promise<void> {
  const { createSqliteProjectStore } = await import("./sqliteProjectStore.js");
  const store = createSqliteProjectStore({
    filePath: args.sqliteFilePath,
    password: args.password,
    protection: args.protection
  });

  try {
    const manifest = store.getManifest();
    const pageNumbers = store.listPageNumbers();
    const chunks: PageChunk[] = [];
    for (const pageNum of pageNumbers) {
      const chunk = store.loadChunk(pageNum);
      if (chunk) chunks.push(chunk);
    }

    const composedProject = composeProjectFromChunks({
      manifest,
      chunks
    });

    await saveProjectFile({
      filePath: args.targetCtpFilePath,
      project: composedProject,
      password: args.password,
      protection: args.protection,
      security: manifest.security
    });
  } finally {
    store.close();
  }
}
/**
 * Imports a standard single-file .ctp project into an SQLite .ctp-db database.
 */
export async function importMonolithicToSqlite(
  args: ImportMonolithicToSqliteArgs
): Promise<void> {
  const loaded = await loadProjectFile({
    filePath: args.sourceCtpFilePath,
    password: args.password,
    protection: args.protection
  });

  const { createSqliteProjectStore } = await import("./sqliteProjectStore.js");
  const store = createSqliteProjectStore({
    filePath: args.targetSqliteFilePath,
    password: args.password,
    protection: loaded.protection ?? args.protection
  });

  try {
    const { manifest, chunks } = decomposeProjectToChunks(loaded.project, loaded.security);
    const allPageNumbers = manifest.pageIndex.map((p) => p.pageNumber);
    store.saveIncremental(manifest, chunks, allPageNumbers);
  } finally {
    store.close();
  }
}
