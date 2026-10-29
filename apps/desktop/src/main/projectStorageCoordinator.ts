import {
  filesystemPathIdentity,
  type PathSemantics
} from "./pathIdentity.js";

export function createProjectStorageCoordinator(options: {
  pathSemantics?: PathSemantics;
} = {}) {
  const operationTails = new Map<string, Promise<unknown>>();
  const importOwners = new Map<
    string,
    { projectSessionId: string; resumable: boolean }
  >();

  async function runExclusive<T>(
    filePaths: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const keys = normalizedUniqueKeys(filePaths, options.pathSemantics);
    if (keys.length === 0) return operation();

    const previous = Promise.all(
      keys.map((key) => operationTails.get(key)?.catch(() => undefined))
    );
    const next = previous.then(operation);
    const tracked = next.catch(() => undefined);
    for (const key of keys) operationTails.set(key, tracked);
    try {
      return await next;
    } finally {
      for (const key of keys) {
        if (operationTails.get(key) === tracked) operationTails.delete(key);
      }
    }
  }

  function claimImport(filePath: string, projectSessionId: string): void {
    assertImportAvailable(filePath, projectSessionId);
    const key = normalizeProjectStorageKey(filePath, options.pathSemantics);
    importOwners.set(key, { projectSessionId, resumable: false });
  }

  function assertImportAvailable(
    filePath: string,
    projectSessionId: string
  ): void {
    const key = normalizeProjectStorageKey(filePath, options.pathSemantics);
    const owner = importOwners.get(key);
    if (owner && owner.projectSessionId !== projectSessionId) {
      throw new Error("PROJECT_IMPORT_BUSY");
    }
  }

  function claimImportForResume(
    filePath: string,
    projectSessionId: string
  ): void {
    const key = normalizeProjectStorageKey(filePath, options.pathSemantics);
    const owner = importOwners.get(key);
    if (
      owner &&
      owner.projectSessionId !== projectSessionId &&
      !owner.resumable
    ) {
      throw new Error("PROJECT_IMPORT_BUSY");
    }
    importOwners.set(key, { projectSessionId, resumable: false });
  }

  function moveImport(
    previousFilePath: string | undefined,
    nextFilePath: string,
    projectSessionId: string
  ): void {
    const nextKey = normalizeProjectStorageKey(nextFilePath, options.pathSemantics);
    const nextOwner = importOwners.get(nextKey);
    if (nextOwner && nextOwner.projectSessionId !== projectSessionId) {
      throw new Error("PROJECT_IMPORT_BUSY");
    }
    importOwners.set(nextKey, { projectSessionId, resumable: false });
    if (previousFilePath) {
      const previousKey = normalizeProjectStorageKey(
        previousFilePath,
        options.pathSemantics
      );
      if (
        previousKey !== nextKey &&
        importOwners.get(previousKey)?.projectSessionId === projectSessionId
      ) {
        importOwners.delete(previousKey);
      }
    }
  }

  function markImportResumable(
    filePath: string | undefined,
    projectSessionId: string
  ): void {
    if (!filePath) return;
    const key = normalizeProjectStorageKey(filePath, options.pathSemantics);
    if (importOwners.get(key)?.projectSessionId === projectSessionId) {
      importOwners.set(key, { projectSessionId, resumable: true });
    }
  }

  function releaseImport(
    filePath: string | undefined,
    projectSessionId: string
  ): void {
    if (!filePath) return;
    const key = normalizeProjectStorageKey(filePath, options.pathSemantics);
    if (importOwners.get(key)?.projectSessionId === projectSessionId) {
      importOwners.delete(key);
    }
  }

  function dispose(): void {
    operationTails.clear();
    importOwners.clear();
  }

  return {
    runExclusive,
    assertImportAvailable,
    claimImport,
    claimImportForResume,
    moveImport,
    markImportResumable,
    releaseImport,
    dispose
  };
}

export type ProjectStorageCoordinator = ReturnType<
  typeof createProjectStorageCoordinator
>;

export function normalizeProjectStorageKey(
  filePath: string,
  semantics?: PathSemantics
): string {
  return filesystemPathIdentity(filePath, semantics);
}

function normalizedUniqueKeys(
  filePaths: readonly string[],
  semantics?: PathSemantics
): string[] {
  return [
    ...new Set(
      filePaths
        .filter((filePath) => filePath.length > 0)
        .map((filePath) => normalizeProjectStorageKey(filePath, semantics))
    )
  ].sort();
}
