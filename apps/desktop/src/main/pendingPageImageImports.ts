import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from "node:path";
import type {
  PageImageImportResult,
  PendingPageImageImportJournalV1,
  PendingPageImageDto,
  PreparedPageImageBatchDto,
  PreparedPageImageDto,
  SaveTransactionJournalV1,
  SaveTransactionStage
} from "../shared/projectSessionTypes.js";
import type { PageImage, TranslationProjectV2 } from "../shared/projectTypes.js";
import { normalizeProject } from "../shared/projectValidation.js";
import { replaceProjectPageImages } from "../shared/pageImageReplacement.js";
import { copyPageImageAsset } from "./pageImageAssets.js";
import {
  filesystemPathIdentity,
  type PathSemantics
} from "./pathIdentity.js";
import { renameWithRetry } from "./projectSaveTransaction.js";

type PreparedPageImageEntry = PreparedPageImageDto & {
  sourcePath: string;
  temporaryFilePath: string;
};

type PendingPageImageLink = PendingPageImageDto;

type ImportSession = {
  project: TranslationProjectV2;
  filePath?: string;
  temporaryOwnerSessionId: string;
  preparedPageImages: PreparedPageImageEntry[];
  pendingPageImageLinks: PendingPageImageLink[];
  createdAt: string;
};

type PendingPageImageImportDependencies = {
  temporaryRoot?: string;
  createId?: () => string;
  now?: () => string;
  pathSemantics?: PathSemantics;
};

const mimeTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);
const saveTransactionStages = new Set<SaveTransactionStage>([
  "preparing",
  "assets_staged",
  "candidate_validated",
  "project_replaced",
  "committed"
]);
const journalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createPendingPageImageImportManager(
  dependencies: PendingPageImageImportDependencies = {}
) {
  const temporaryRoot =
    dependencies.temporaryRoot ?? join(tmpdir(), "trio-pending-page-imports");
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const sessions = new Map<string, ImportSession>();

  function startSession(args: {
    projectSessionId: string;
    project: unknown;
    filePath?: string;
  }): void {
    sessions.set(args.projectSessionId, {
      project: normalizeProject(args.project),
      filePath: args.filePath,
      temporaryOwnerSessionId: args.projectSessionId,
      preparedPageImages: [],
      pendingPageImageLinks: [],
      createdAt: now()
    });
  }

  async function resumeSession(args: {
    projectSessionId: string;
    project: unknown;
    filePath: string;
  }): Promise<void> {
    startSession(args);
    const resumedProject = requireSession(args.projectSessionId).project;
    let journal: PendingPageImageImportJournalV1;
    try {
      journal = JSON.parse(
        await readFile(importJournalPath(args.filePath), "utf8")
      ) as PendingPageImageImportJournalV1;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (
      journal.schemaVersion !== 1 ||
      journal.targetProjectPath !== args.filePath ||
      !Array.isArray(journal.preparedPageImages) ||
      !Array.isArray(journal.pendingPageImageLinks)
    ) {
      throw new Error("Invalid pending page image import journal");
    }
    validateImportJournal(journal, temporaryRoot);

    const session = requireSession(args.projectSessionId);
    session.temporaryOwnerSessionId = journal.projectSessionId;
    const saveJournal = await readSaveTransactionJournal(args.filePath);
    const promotedAssetsMatchProject = saveJournal?.promotedAssets.every((asset) =>
      resumedProject.pageImages.some(
        (pageImage) =>
          pageImage.storedRelativePath === asset.finalRelativePath &&
          pageImage.sha256 === asset.sha256 &&
          pageImage.byteSize === asset.byteSize
      )
    ) ?? false;
    const saveFinishedOnDisk =
      !!saveJournal &&
      promotedAssetsMatchProject &&
      (saveJournal.stage === "project_replaced" ||
        saveJournal.stage === "committed" ||
        (saveJournal.stage === "candidate_validated" &&
          saveJournal.promotedAssets.length > 0));
    if (saveFinishedOnDisk && saveJournal) {
      const promotedTemporaryPaths = new Set(
        saveJournal.promotedAssets.map((asset) => asset.sourceTemporaryPath)
      );
      const savedPreparedEntries = journal.preparedPageImages.filter(
        (prepared) => promotedTemporaryPaths.has(prepared.temporaryFilePath)
      );
      journal.preparedPageImages = journal.preparedPageImages.filter(
        (prepared) => !promotedTemporaryPaths.has(prepared.temporaryFilePath)
      );
      const remainingPreparedKeys = new Set(
        journal.preparedPageImages.map(
          (prepared) => `${prepared.importBatchId}\u0000${prepared.preparedImageId}`
        )
      );
      journal.pendingPageImageLinks = journal.pendingPageImageLinks.filter(
        (link) => remainingPreparedKeys.has(
          `${link.importBatchId}\u0000${link.preparedImageId}`
        )
      );
      if (
        journal.preparedPageImages.length === 0 &&
        journal.pendingPageImageLinks.length === 0
      ) {
        await rm(importJournalPath(args.filePath), { force: true });
      } else {
        journal.updatedAt = now();
        await writeJsonAtomically(importJournalPath(args.filePath), journal);
      }
      await rm(saveTransactionJournalPath(args.filePath), { force: true });
      await removePreparedTemporaryFiles(
        temporaryRoot,
        savedPreparedEntries
      );
      await removeSaveTransactionStaging(args.filePath, saveJournal.transactionId);
      if (journal.preparedPageImages.length === 0) return;
    }

    const preparedEntries: PreparedPageImageEntry[] = [];
    for (const prepared of journal.preparedPageImages) {
      const temporaryStat = await stat(prepared.temporaryFilePath);
      if (
        !temporaryStat.isFile() ||
        temporaryStat.size !== prepared.byteSize
      ) {
        throw new Error("Pending page image recovery failed");
      }
      preparedEntries.push({
        ...structuredClone(prepared),
        sourcePath: ""
      });
    }
    session.preparedPageImages = preparedEntries;
    session.pendingPageImageLinks = structuredClone(
      journal.pendingPageImageLinks
    );
    session.createdAt = journal.createdAt;
    await clearInterruptedSaveStaging(args.filePath);
    await writeImportJournal(session);
  }

  async function preparePageImages(args: {
    projectSessionId: string;
    sourcePaths: string[];
  }): Promise<PreparedPageImageBatchDto> {
    const session = requireSession(args.projectSessionId);
    const importBatchId = createId();
    const images: PreparedPageImageDto[] = [];
    const previousPreparedCount = session.preparedPageImages.length;

    try {
      for (const absoluteSourcePath of deduplicatePageImageSourcePaths(
        args.sourcePaths.map((sourcePath) => resolve(sourcePath)),
        dependencies.pathSemantics
      )) {
        const extension = extname(absoluteSourcePath).toLowerCase();
        const mimeType = mimeTypes.get(extension);
        if (!mimeType) throw new Error("Unsupported image file extension");
        const sourceStat = await stat(absoluteSourcePath);
        if (!sourceStat.isFile()) throw new Error("Page image path must reference a file");

        const preparedImageId = createId();
        const previewToken = createId();
        const temporaryFilePath = join(
          temporaryRoot,
          session.temporaryOwnerSessionId,
          importBatchId,
          `${preparedImageId}${extension}`
        );
        await mkdir(join(temporaryRoot, session.temporaryOwnerSessionId, importBatchId), {
          recursive: true
        });
        await copyFile(absoluteSourcePath, temporaryFilePath);

        const dto: PreparedPageImageDto = {
          preparedImageId,
          importBatchId,
          originalFileName: basename(absoluteSourcePath),
          byteSize: sourceStat.size,
          mimeType,
          previewToken
        };
        session.preparedPageImages.push({
          ...dto,
          sourcePath: absoluteSourcePath,
          temporaryFilePath
        });
        images.push(dto);
      }

      if (
        session.preparedPageImages.length > 0 ||
        session.pendingPageImageLinks.length > 0
      ) {
        await writeImportJournal(session);
      } else if (session.filePath) {
        await removeImportJournalIfOwned(
          session.filePath,
          session.temporaryOwnerSessionId
        );
      }
      return { importBatchId, images };
    } catch (error) {
      session.preparedPageImages.splice(previousPreparedCount);
      await rm(join(temporaryRoot, session.temporaryOwnerSessionId, importBatchId), {
        recursive: true,
        force: true
      });
      throw error;
    }
  }

  async function linkPageImages(args: {
    projectSessionId: string;
    importBatchId: string;
    pages: Array<{ preparedImageId: string; pageNumber: number }>;
  }): Promise<PageImageImportResult[]> {
    const session = requireSession(args.projectSessionId);
    const previousLinks = structuredClone(session.pendingPageImageLinks);
    const previousPrepared = structuredClone(session.preparedPageImages);
    const results: PageImageImportResult[] = [];

    for (const page of args.pages) {
      const prepared = session.preparedPageImages.find(
        (entry) =>
          entry.importBatchId === args.importBatchId &&
          entry.preparedImageId === page.preparedImageId
      );
      if (!prepared) {
        results.push({
          ok: false,
          preparedImageId: page.preparedImageId,
          message: "Prepared page image is not available"
        });
        continue;
      }
      if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1) {
        results.push({
          ok: false,
          preparedImageId: page.preparedImageId,
          message: "Invalid image page number"
        });
        continue;
      }

      const existing = session.pendingPageImageLinks.find(
        (link) =>
          link.importBatchId === args.importBatchId &&
          link.preparedImageId === page.preparedImageId &&
          link.pageNumber === page.pageNumber
      );
      if (existing) {
        results.push({ ok: true, pendingPageImage: structuredClone(existing) });
        continue;
      }

      const pendingPageImage: PendingPageImageLink = {
        importBatchId: prepared.importBatchId,
        preparedImageId: prepared.preparedImageId,
        pageImageId: createId(),
        pageNumber: page.pageNumber,
        originalFileName: prepared.originalFileName,
        byteSize: prepared.byteSize,
        mimeType: prepared.mimeType,
        previewToken: prepared.previewToken
      };
      session.pendingPageImageLinks = session.pendingPageImageLinks.filter(
        (link) => link.pageNumber !== page.pageNumber
      );
      session.pendingPageImageLinks.push(pendingPageImage);
      results.push({
        ok: true,
        pendingPageImage: structuredClone(pendingPageImage)
      });
    }

    const supersededPreparedKeys = new Set(
      [
        ...previousLinks,
        ...results.flatMap((result) => result.ok ? [result.pendingPageImage] : [])
      ]
        .filter((previous) =>
          !session.pendingPageImageLinks.some((current) =>
            current.importBatchId === previous.importBatchId &&
            current.preparedImageId === previous.preparedImageId
          )
        )
        .map((previous) => `${previous.importBatchId}\0${previous.preparedImageId}`)
    );
    const supersededPreparedEntries = session.preparedPageImages.filter((prepared) =>
      supersededPreparedKeys.has(`${prepared.importBatchId}\0${prepared.preparedImageId}`)
    );
    session.preparedPageImages = session.preparedPageImages.filter((prepared) =>
      !supersededPreparedKeys.has(`${prepared.importBatchId}\0${prepared.preparedImageId}`)
    );

    try {
      if (
        session.preparedPageImages.length > 0 ||
        session.pendingPageImageLinks.length > 0
      ) {
        await writeImportJournal(session);
      } else if (session.filePath) {
        await removeImportJournalIfOwned(
          session.filePath,
          session.temporaryOwnerSessionId
        );
      }
    } catch (error) {
      session.pendingPageImageLinks = previousLinks;
      session.preparedPageImages = previousPrepared;
      throw error;
    }
    await removePreparedTemporaryFiles(temporaryRoot, supersededPreparedEntries).catch(() => {
      // The journal is authoritative. Failed temporary cleanup may leak bytes,
      // but it must not restore a superseded page identity.
    });
    return results;
  }

  async function savePendingPageImages(args: {
    projectSessionId: string;
    persistProject: (
      candidate: TranslationProjectV2,
      hooks: {
        afterCandidateValidated: () => Promise<void>;
        afterProjectReplaced: () => Promise<void>;
      }
    ) => Promise<void>;
  }): Promise<TranslationProjectV2> {
    const session = requireSession(args.projectSessionId);
    if (!session.filePath) throw new Error("Project has no save path");
    if (session.pendingPageImageLinks.length === 0) {
      await args.persistProject(structuredClone(session.project), {
        afterCandidateValidated: async () => undefined,
        afterProjectReplaced: async () => undefined
      });
      return structuredClone(session.project);
    }

    await clearInterruptedSaveStaging(session.filePath);
    const transactionId = createId();
    const projectPath = session.filePath;
    const projectName = parse(projectPath).name;
    const stagingRoot = join(
      dirname(projectPath),
      `${projectName}-assets`,
      ".save-staging",
      transactionId
    );
    const journal: SaveTransactionJournalV1 = {
      schemaVersion: 1,
      transactionId,
      projectSessionId: args.projectSessionId,
      targetProjectPath: projectPath,
      candidateProjectPath: `${projectPath}.candidate`,
      ...(await pathExists(projectPath)
        ? { backupProjectPath: `${projectPath}.bak` }
        : {}),
      stage: "preparing",
      promotedAssets: [],
      createdAt: now(),
      updatedAt: now()
    };
    await writeSaveTransactionJournal(journal);

    const pendingLinksByPageNumber = new Map<number, PendingPageImageLink>();
    for (const link of session.pendingPageImageLinks) {
      pendingLinksByPageNumber.set(link.pageNumber, link);
    }
    const pendingLinks = [...pendingLinksByPageNumber.values()];
    const promotedPageImages: PageImage[] = [];
    for (const link of pendingLinks) {
      const prepared = session.preparedPageImages.find(
        (entry) =>
          entry.importBatchId === link.importBatchId &&
          entry.preparedImageId === link.preparedImageId
      );
      if (!prepared) throw new Error("Pending page image source is not available");
      const extension = extname(prepared.temporaryFilePath).toLowerCase();
      const stagedPath = join(stagingRoot, `${prepared.preparedImageId}${extension}`);
      await mkdir(stagingRoot, { recursive: true });
      await copyFile(prepared.temporaryFilePath, stagedPath);
      const promoted = await copyPageImageAsset({
        sourcePath: stagedPath,
        projectFilePath: projectPath,
        pageNumber: link.pageNumber,
        now: new Date(now())
      });
      const pageImage: PageImage = {
        ...promoted.pageImage,
        id: link.pageImageId,
        originalFileName: prepared.originalFileName
      };
      promotedPageImages.push(pageImage);
      journal.promotedAssets.push({
        sourceTemporaryPath: prepared.temporaryFilePath,
        finalRelativePath: pageImage.storedRelativePath,
        sha256: pageImage.sha256,
        byteSize: pageImage.byteSize
      });
      journal.updatedAt = now();
      await writeSaveTransactionJournal(journal);
    }
    await setSaveTransactionStage(journal, "assets_staged");

    const candidate = replaceProjectPageImages(session.project, promotedPageImages);
    await args.persistProject(candidate, {
      afterCandidateValidated: () =>
        setSaveTransactionStage(journal, "candidate_validated"),
      afterProjectReplaced: () =>
        setSaveTransactionStage(journal, "project_replaced")
    });
    if (journal.stage !== "project_replaced") {
      await setSaveTransactionStage(journal, "project_replaced");
    }

    session.project = structuredClone(candidate);
    const savedPreparedIds = new Set(
      pendingLinks.map((link) => link.preparedImageId)
    );
    const savedPreparedEntries = session.preparedPageImages.filter(
      (prepared) => savedPreparedIds.has(prepared.preparedImageId)
    );
    session.preparedPageImages = session.preparedPageImages.filter(
      (prepared) => !savedPreparedIds.has(prepared.preparedImageId)
    );
    session.pendingPageImageLinks = [];
    await setSaveTransactionStage(journal, "committed");
    await rm(saveTransactionJournalPath(projectPath), { force: true });
    if (session.preparedPageImages.length === 0) {
      await rm(importJournalPath(projectPath), { force: true });
    } else {
      await writeImportJournal(session);
    }
    await removePreparedTemporaryFiles(temporaryRoot, savedPreparedEntries);
    await rm(stagingRoot, { recursive: true, force: true });
    return structuredClone(candidate);
  }

  async function releasePageImageImportBatch(args: {
    projectSessionId: string;
    importBatchId: string;
  }): Promise<void> {
    const session = requireSession(args.projectSessionId);
    const preparedForBatch = session.preparedPageImages.filter(
      (prepared) => prepared.importBatchId === args.importBatchId
    );
    const temporaryPaths = new Set(
      preparedForBatch.map((prepared) => prepared.temporaryFilePath)
    );
    if (session.filePath) {
      const saveJournal = await readSaveTransactionJournal(session.filePath);
      if (saveJournal) {
        for (const asset of saveJournal.promotedAssets) {
          if (!temporaryPaths.has(asset.sourceTemporaryPath)) continue;
          if (
            session.project.pageImages.some(
              (pageImage) =>
                pageImage.storedRelativePath === asset.finalRelativePath
            )
          ) {
            continue;
          }
          const absoluteAssetPath = resolveProjectRelativePath(
            session.filePath,
            asset.finalRelativePath
          );
          if (!(await pathExists(absoluteAssetPath))) continue;
          const [assetStat, assetHash] = await Promise.all([
            stat(absoluteAssetPath),
            sha256File(absoluteAssetPath)
          ]);
          if (
            assetStat.size !== asset.byteSize ||
            assetHash !== asset.sha256
          ) {
            throw new Error("Unreferenced page asset does not match its journal");
          }
          await rm(absoluteAssetPath);
        }
        await removeSaveTransactionStaging(
          session.filePath,
          saveJournal.transactionId
        );
        await rm(saveTransactionJournalPath(session.filePath), {
          force: true
        });
      }
    }

    session.preparedPageImages = session.preparedPageImages.filter(
      (prepared) => prepared.importBatchId !== args.importBatchId
    );
    session.pendingPageImageLinks = session.pendingPageImageLinks.filter(
      (link) => link.importBatchId !== args.importBatchId
    );
    if (session.filePath) {
      if (
        session.preparedPageImages.length === 0 &&
        session.pendingPageImageLinks.length === 0
      ) {
        await rm(importJournalPath(session.filePath), { force: true });
      } else {
        await writeImportJournal(session);
      }
    }
    await removePreparedTemporaryFiles(temporaryRoot, preparedForBatch);
  }

  async function writeImportJournal(
    session: ImportSession,
    expectedPreviousOwner?: string
  ): Promise<void> {
    if (!session.filePath) return;
    await assertImportJournalWritable(
      session.filePath,
      session.temporaryOwnerSessionId,
      expectedPreviousOwner
    );
    const journal: PendingPageImageImportJournalV1 = {
      schemaVersion: 1,
      projectSessionId: session.temporaryOwnerSessionId,
      targetProjectPath: session.filePath,
      preparedPageImages: session.preparedPageImages.map(
        ({ sourcePath: _sourcePath, ...prepared }) => structuredClone(prepared)
      ),
      pendingPageImageLinks: structuredClone(session.pendingPageImageLinks),
      createdAt: session.createdAt,
      updatedAt: now()
    };
    await writeJsonAtomically(importJournalPath(session.filePath), journal);
  }

  function getPreparedPageImagePath(
    projectSessionId: string,
    preparedImageId: string
  ): string {
    const prepared = requireSession(projectSessionId).preparedPageImages.find(
      (entry) => entry.preparedImageId === preparedImageId
    );
    if (!prepared) throw new Error("Prepared page image is not available");
    return prepared.temporaryFilePath;
  }

  function getPendingPageImages(projectSessionId: string): PendingPageImageDto[] {
    return structuredClone(requireSession(projectSessionId).pendingPageImageLinks);
  }

  function hasPendingWork(projectSessionId: string): boolean {
    const session = requireSession(projectSessionId);
    return (
      session.preparedPageImages.length > 0 ||
      session.pendingPageImageLinks.length > 0
    );
  }

  async function assertFilePathAvailable(
    projectSessionId: string,
    filePath: string
  ): Promise<void> {
    await assertImportJournalWritable(
      filePath,
      requireSession(projectSessionId).temporaryOwnerSessionId
    );
  }

  function getProject(projectSessionId: string): TranslationProjectV2 {
    return structuredClone(requireSession(projectSessionId).project);
  }

  function setProject(
    projectSessionId: string,
    project: TranslationProjectV2
  ): void {
    requireSession(projectSessionId).project = structuredClone(project);
  }

  async function setFilePath(
    projectSessionId: string,
    filePath: string | undefined
  ): Promise<void> {
    const session = requireSession(projectSessionId);
    const previousFilePath = session.filePath;
    session.filePath = filePath;
    try {
      if (
        session.preparedPageImages.length > 0 ||
        session.pendingPageImageLinks.length > 0
      ) {
        await writeImportJournal(session);
      }
    } catch (error) {
      session.filePath = previousFilePath;
      throw error;
    }
    if (previousFilePath && previousFilePath !== filePath) {
      await removeImportJournalIfOwned(
        previousFilePath,
        session.temporaryOwnerSessionId
      );
    }
  }

  function detachSession(projectSessionId: string): void {
    sessions.delete(projectSessionId);
  }

  async function discardSession(projectSessionId: string): Promise<void> {
    const session = requireSession(projectSessionId);
    if (session.filePath) {
      await removeImportJournalIfOwned(
        session.filePath,
        session.temporaryOwnerSessionId
      );
    }
    await rm(join(temporaryRoot, session.temporaryOwnerSessionId), {
      recursive: true,
      force: true
    });
    sessions.delete(projectSessionId);
  }

  function requireSession(projectSessionId: string): ImportSession {
    const session = sessions.get(projectSessionId);
    if (!session) throw new Error("Unknown page image import session");
    return session;
  }

  return {
    startSession,
    resumeSession,
    preparePageImages,
    linkPageImages,
    savePendingPageImages,
    releasePageImageImportBatch,
    getPreparedPageImagePath,
    getPendingPageImages,
    hasPendingWork,
    assertFilePathAvailable,
    getProject,
    setProject,
    setFilePath,
    detachSession,
    discardSession
  };
}

export function deduplicatePageImageSourcePaths(
  sourcePaths: string[],
  pathSemantics?: PathSemantics
): string[] {
  const seenPaths = new Set<string>();
  return sourcePaths.filter((sourcePath) => {
    const pathKey = filesystemPathIdentity(sourcePath, pathSemantics);
    if (seenPaths.has(pathKey)) return false;
    seenPaths.add(pathKey);
    return true;
  });
}

export type PendingPageImageImportManager = ReturnType<
  typeof createPendingPageImageImportManager
>;

export function importJournalPath(projectFilePath: string): string {
  return `${projectFilePath}.import-journal.json`;
}

export function saveTransactionJournalPath(projectFilePath: string): string {
  return `${projectFilePath}.save-journal.json`;
}

async function removeImportJournalIfOwned(
  projectFilePath: string,
  projectSessionId: string
): Promise<void> {
  let journal: PendingPageImageImportJournalV1;
  try {
    journal = JSON.parse(
      await readFile(importJournalPath(projectFilePath), "utf8")
    ) as PendingPageImageImportJournalV1;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (journal.projectSessionId === projectSessionId) {
    await rm(importJournalPath(projectFilePath), { force: true });
  }
}

async function assertImportJournalWritable(
  projectFilePath: string,
  projectSessionId: string,
  expectedPreviousOwner?: string
): Promise<void> {
  let journal: PendingPageImageImportJournalV1;
  try {
    journal = JSON.parse(
      await readFile(importJournalPath(projectFilePath), "utf8")
    ) as PendingPageImageImportJournalV1;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    journal.projectSessionId !== projectSessionId &&
    journal.projectSessionId !== expectedPreviousOwner
  ) {
    throw new Error("PROJECT_IMPORT_BUSY");
  }
}

async function writeSaveTransactionJournal(
  journal: SaveTransactionJournalV1
): Promise<void> {
  await writeJsonAtomically(
    saveTransactionJournalPath(journal.targetProjectPath),
    journal
  );
}

async function clearInterruptedSaveStaging(
  projectFilePath: string
): Promise<void> {
  const journal = await readSaveTransactionJournal(projectFilePath);
  if (!journal) return;
  await removeSaveTransactionStaging(projectFilePath, journal.transactionId);
  await rm(saveTransactionJournalPath(projectFilePath), { force: true });
}

async function readSaveTransactionJournal(
  projectFilePath: string
): Promise<SaveTransactionJournalV1 | undefined> {
  let journal: SaveTransactionJournalV1;
  try {
    journal = JSON.parse(
      await readFile(saveTransactionJournalPath(projectFilePath), "utf8")
    ) as SaveTransactionJournalV1;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    journal.schemaVersion !== 1 ||
    journal.targetProjectPath !== projectFilePath ||
    !isSafeJournalId(journal.transactionId) ||
    journal.candidateProjectPath !== `${projectFilePath}.candidate` ||
    (journal.backupProjectPath !== undefined &&
      journal.backupProjectPath !== `${projectFilePath}.bak`) ||
    !saveTransactionStages.has(journal.stage) ||
    !Array.isArray(journal.promotedAssets)
  ) {
    throw new Error("Invalid page image save transaction journal");
  }
  for (const asset of journal.promotedAssets) {
    if (
      typeof asset.sourceTemporaryPath !== "string" ||
      typeof asset.finalRelativePath !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize < 0
    ) {
      throw new Error("Invalid page image save transaction journal asset");
    }
    resolveProjectRelativePath(projectFilePath, asset.finalRelativePath);
  }
  return journal;
}

function validateImportJournal(
  journal: PendingPageImageImportJournalV1,
  temporaryRoot: string
): void {
  if (!isSafeJournalId(journal.projectSessionId)) {
    throw new Error("Invalid pending page image import journal session");
  }
  const preparedKeys = new Set<string>();
  for (const prepared of journal.preparedPageImages) {
    if (
      !isSafeJournalId(prepared.importBatchId) ||
      !isSafeJournalId(prepared.preparedImageId) ||
      !isSafeJournalId(prepared.previewToken) ||
      typeof prepared.originalFileName !== "string" ||
      !Number.isSafeInteger(prepared.byteSize) ||
      prepared.byteSize < 0 ||
      !mimeTypes.has(extname(prepared.temporaryFilePath).toLowerCase()) ||
      mimeTypes.get(extname(prepared.temporaryFilePath).toLowerCase()) !==
        prepared.mimeType
    ) {
      throw new Error("Invalid pending page image import journal entry");
    }
    const batchRoot = join(
      temporaryRoot,
      journal.projectSessionId,
      prepared.importBatchId
    );
    assertPathInsideDirectory(batchRoot, prepared.temporaryFilePath);
    if (parse(prepared.temporaryFilePath).name !== prepared.preparedImageId) {
      throw new Error("Invalid pending page image temporary file name");
    }
    preparedKeys.add(
      `${prepared.importBatchId}\0${prepared.preparedImageId}`
    );
  }
  for (const link of journal.pendingPageImageLinks) {
    if (
      !isSafeJournalId(link.importBatchId) ||
      !isSafeJournalId(link.preparedImageId) ||
      !isSafeJournalId(link.pageImageId) ||
      !isSafeJournalId(link.previewToken) ||
      !Number.isSafeInteger(link.pageNumber) ||
      link.pageNumber < 1 ||
      !preparedKeys.has(`${link.importBatchId}\0${link.preparedImageId}`)
    ) {
      throw new Error("Invalid pending page image import journal link");
    }
  }
}

function isSafeJournalId(value: unknown): value is string {
  return typeof value === "string" && journalIdPattern.test(value);
}

function assertPathInsideDirectory(directoryPath: string, candidatePath: string): void {
  const resolvedDirectory = resolve(directoryPath);
  const resolvedCandidate = resolve(candidatePath);
  const candidateRelativePath = relative(resolvedDirectory, resolvedCandidate);
  if (
    candidateRelativePath === "" ||
    candidateRelativePath === ".." ||
    candidateRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelativePath)
  ) {
    throw new Error("Pending page image temporary path is outside its managed directory");
  }
}

async function removePreparedTemporaryFiles(
  temporaryRoot: string,
  preparedEntries: readonly { temporaryFilePath: string }[]
): Promise<void> {
  for (const prepared of preparedEntries) {
    assertPathInsideDirectory(temporaryRoot, prepared.temporaryFilePath);
  }
  const batchDirectories = new Set<string>();
  for (const prepared of preparedEntries) {
    await rm(prepared.temporaryFilePath, { force: true });
    batchDirectories.add(dirname(prepared.temporaryFilePath));
  }

  const ownerDirectories = new Set<string>();
  for (const batchDirectory of batchDirectories) {
    await removeDirectoryIfEmpty(batchDirectory);
    ownerDirectories.add(dirname(batchDirectory));
  }
  for (const ownerDirectory of ownerDirectories) {
    await removeDirectoryIfEmpty(ownerDirectory);
  }
}

async function removeDirectoryIfEmpty(directoryPath: string): Promise<void> {
  try {
    await rmdir(directoryPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" ||
        error.code === "ENOTEMPTY" ||
        error.code === "EEXIST")
    ) {
      return;
    }
    throw error;
  }
}

async function removeSaveTransactionStaging(
  projectFilePath: string,
  transactionId: string
): Promise<void> {
  const project = parse(projectFilePath);
  await rm(
    join(
      project.dir,
      `${project.name}-assets`,
      ".save-staging",
      transactionId
    ),
    { recursive: true, force: true }
  );
}

async function setSaveTransactionStage(
  journal: SaveTransactionJournalV1,
  stage: SaveTransactionStage
): Promise<void> {
  journal.stage = stage;
  journal.updatedAt = new Date().toISOString();
  await writeSaveTransactionJournal(journal);
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  try {
    await renameWithRetry(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function resolveProjectRelativePath(
  projectFilePath: string,
  storedRelativePath: string
): string {
  const projectDirectory = resolve(dirname(projectFilePath));
  const absolutePath = resolve(projectDirectory, storedRelativePath);
  const relativePath = relative(projectDirectory, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Invalid page asset path in save transaction journal");
  }
  return absolutePath;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
