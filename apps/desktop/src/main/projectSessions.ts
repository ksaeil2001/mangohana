import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type {
  MainProjectPatch,
  PendingUserMutation,
  ProjectSessionStatus,
  RevisionJournalEntry
} from "../shared/projectChanges.js";
import type {
  ApplyProjectMutationArgs,
  ProjectChangeResult,
  ProjectSaveResult,
  ProjectSessionResult,
  ReviewCleanedAssetArgs,
  TranslationProjectDto
} from "../shared/projectSessionTypes.js";
import type { PageHydrationResult } from "../shared/projectChunkTypes.js";
import {
  computeChunkHash,
  decomposeProjectToChunks
} from "../shared/projectChunkAdapter.js";
import { computeViewportHydrationPlan } from "../shared/viewportCache.js";
import type {
  ProcessingQueueState,
  SecretProjectSecurityV1,
  TranslationProjectV2
} from "../shared/projectTypes.js";

import type { DerivedImageAsset, PageImage } from "../shared/projectTypes.js";
import { normalizeProject } from "../shared/projectValidation.js";
import { validateAndNormalizeProjectMutation } from "./projectMutations.js";
import {
  createSecretProtection,
  rekeySecretProtection,
  securityFromArtifactKey,
  zeroizeProtection,
  type SecretProjectProtection
} from "./projectProtection.js";
import { applyMainProjectPatch, mergeBatchResultsIntoPendingMutations, replayPendingUserMutations } from "./projectReplay.js";
import { evaluateRevision } from "./projectRevision.js";
import {
  computeTranslationContextFingerprint,
  computeTypesettingContextFingerprint
} from "../shared/translationContext.js";
import {
  cancelProcessingQueue,
  createProcessingQueue,
  mergeProcessingQueuePageFailure,
  pauseProcessingQueue,
  processingQueueConcurrencyToken,
  recoverInterruptedProcessingQueue,
  retryProcessingQueuePage,
  startProcessingQueue
} from "../shared/processingQueue.js";
import {
  createPendingPageImageImportManager,
  type PendingPageImageImportManager
} from "./pendingPageImageImports.js";
import {
  saveProjectFile as defaultSaveProjectFile,
  type SaveProjectFileArgs
} from "./projectStorage.js";
import { createProjectStorageCoordinator } from "./projectStorageCoordinator.js";
import { inspectApprovedCleanedAsset } from "../shared/approvedCleanedAsset.js";
import { readVerifiedCleanedAsset } from "./cleanedAssetReview.js";
import {
  prepareProjectAssetRelocation,
  type PreparedProjectAssetRelocation
} from "./projectAssetRelocation.js";
import {
  projectRelativePathIdentity,
  sameFilesystemPath
} from "./pathIdentity.js";

const MAX_REVISION_JOURNAL = 100;
const PAGE_IMAGE_PROCESSING_SAVE_REQUIRED = "새로 연결한 이미지를 먼저 저장해야 OCR/인페인팅할 수 있습니다.";

type ProjectSession = {
  sessionId: string;
  filePath?: string;
  persistedProjectSnapshot: TranslationProjectV2;
  liveProject: TranslationProjectV2;
  pendingUserMutations: PendingUserMutation[];
  revision: number;
  persistedRevision: number;
  revisionJournal: RevisionJournalEntry[];
  dirty: boolean;
  status: ProjectSessionStatus;
  protection?: SecretProjectProtection;
  security?: SecretProjectSecurityV1;
  artifactKeyPersisted: boolean;
};

type SessionManagerDependencies = {
  saveProjectFile?: (args: Omit<SaveProjectFileArgs, "project"> & { project: TranslationProjectV2 }) => Promise<void>;
  createId?: () => string;
  now?: () => string;
  pageImageImports?: PendingPageImageImportManager;
};

export function createProjectSessionManager(dependencies: SessionManagerDependencies = {}) {
  const saveProjectFile = dependencies.saveProjectFile ?? defaultSaveProjectFile;
  const createId = dependencies.createId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const pageImageImports =
    dependencies.pageImageImports ?? createPendingPageImageImportManager();
  const storageCoordinator = createProjectStorageCoordinator();
  const sessions = new Map<string, ProjectSession>();
  const queues = new Map<string, Promise<unknown>>();
  const batchLeases = new Map<string, string>();

  function createProjectSession(args: {
    project: unknown;
    filePath?: string;
    protection?: SecretProjectProtection;
    security?: SecretProjectSecurityV1;
    artifactKeyPersisted?: boolean;
  }): ProjectSessionResult {
    const project = normalizeProject(args.project);
    if (project.metadata.secret && !args.protection) {
      throw new Error("Secret project protection is required");
    }
    const sessionId = createId();
    const recoveredInterruptedQueue = project.processing.queue?.status === "running";
    if (project.processing.queue) {
      project.processing.queue = recoverInterruptedProcessingQueue(project.processing.queue, {
        projectSessionId: sessionId,
        now: now()
      });
    }
    const session: ProjectSession = {
      sessionId,
      filePath: args.filePath,
      persistedProjectSnapshot: structuredClone(project),
      liveProject: structuredClone(project),
      pendingUserMutations: [],
      revision: 0,
      persistedRevision: 0,
      revisionJournal: [],
      dirty: recoveredInterruptedQueue,
      status: "active",
      protection: args.protection,
      security:
        args.security ??
        (args.protection
          ? securityFromArtifactKey(args.protection.artifactMasterKey)
          : undefined),
      artifactKeyPersisted: args.artifactKeyPersisted ?? !project.metadata.secret
    };
    sessions.set(sessionId, session);
    pageImageImports.startSession({
      projectSessionId: sessionId,
      project,
      filePath: args.filePath
    });
    return toSessionResult(session, dto(session));
  }

  function createSecretProjectSession(args: {
    project: unknown;
    password: string;
    filePath?: string;
  }): ProjectSessionResult & { protectionBuffers: Buffer[] } {
    const protection = createSecretProtection(args.password);
    const security = securityFromArtifactKey(protection.artifactMasterKey);
    const result = createProjectSession({
      project: args.project,
      filePath: args.filePath,
      protection,
      security,
      artifactKeyPersisted: false
    });
    return {
      ...result,
      protectionBuffers: [
        protection.containerKey,
        protection.containerSalt,
        protection.artifactMasterKey,
        protection.passwordBytes
      ]
    };
  }

  async function applyProjectMutation(args: ApplyProjectMutationArgs): Promise<ProjectChangeResult> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      const normalized = validateAndNormalizeProjectMutation(session.liveProject, args.mutation, { createId });
      const revisionResult = evaluateRevision({
        baseRevision: args.baseRevision,
        currentRevision: session.revision,
        requestedPaths: normalized.changedPaths,
        revisionJournal: session.revisionJournal
      });
      if (revisionResult.status === "conflict") {
        return {
          status: "revision_conflict" as const,
          code: "REVISION_CONFLICT" as const,
          revision: session.revision,
          project: dto(session),
          conflictingPaths: revisionResult.conflictingPaths
        };
      }

      const revision = session.revision + 1;
      const entry: PendingUserMutation = {
        mutationId: createId(),
        acceptedRevision: revision,
        mutation: normalized.mutation,
        changedPaths: normalized.changedPaths,
        createdAt: now()
      };
      session.pendingUserMutations.push(entry);
      session.liveProject = replayPendingUserMutations(
        session.persistedProjectSnapshot,
        session.pendingUserMutations
      );
      session.revision = revision;
      session.dirty = true;
      appendRevision(session, "user", normalized.changedPaths);
      return {
        status: "applied" as const,
        revision,
        project: dto(session)
      };
    });
  }

  async function reviewCleanedAsset(
    args: ReviewCleanedAssetArgs,
    assertOwner: () => void = () => undefined
  ): Promise<ProjectSaveResult> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      assertOwner();
      if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision !== session.revision) {
        throw new Error("REVISION_CONFLICT");
      }
      if (!session.filePath) throw new Error("PROJECT_NOT_SAVED");
      assertPageImageReadyForProcessingInSession(session, args.pageImageId);
      const page = session.liveProject.pageImages.find((image) => image.id === args.pageImageId)!;
      const persistedPage = session.persistedProjectSnapshot.pageImages.find((image) => image.id === args.pageImageId)!;
      if (page.sha256 !== persistedPage.sha256 || page.storedRelativePath !== persistedPage.storedRelativePath ||
          page.byteSize !== persistedPage.byteSize || page.mimeType !== persistedPage.mimeType) {
        throw new Error("CLEANED_REVIEW_SOURCE_NOT_PERSISTED");
      }
      for (const project of [session.liveProject, session.persistedProjectSnapshot]) {
        const inspection = inspectApprovedCleanedAsset(project, page);
        if (inspection.status !== "valid" || inspection.asset?.assetId !== args.cleanedAssetId) {
          throw new Error("CLEANED_REVIEW_RESULT_NOT_CURRENT_OR_QA_FAILED");
        }
      }
      await readVerifiedCleanedAsset({ project: session.liveProject, projectFilePath: session.filePath,
        pageImageId: args.pageImageId, requireUserReview: false });

      const candidate = structuredClone(session.persistedProjectSnapshot);
      const record = candidate.processing.pages.find((item) => item.pageImageId === args.pageImageId)!;
      record.userReviewedCleanedAssetId = args.cleanedAssetId;
      const liveCandidate = replayPendingUserMutations(candidate, session.pendingUserMutations);
      if (liveCandidate.processing.pages.find((item) => item.pageImageId === args.pageImageId)?.userReviewedCleanedAssetId !== args.cleanedAssetId) {
        throw new Error("CLEANED_REVIEW_PENDING_SOURCE_CHANGE");
      }
      await storageCoordinator.runExclusive([session.filePath], async () => {
        assertActive(session);
        assertOwner();
        storageCoordinator.assertImportAvailable(session.filePath!, session.sessionId);
        await pageImageImports.assertFilePathAvailable(session.sessionId, session.filePath!);
        assertActive(session);
        assertOwner();
        await persistUnlocked(session, candidate, session.filePath!);
      });
      // Only publish after atomic storage succeeds. Pending edits are neither saved nor discarded.
      session.persistedProjectSnapshot = candidate;
      session.liveProject = liveCandidate;
      session.persistedRevision += 1;
      session.revision += 1;
      appendRevision(session, "main", [`processing/pages/${args.pageImageId}/userReviewedCleanedAssetId`]);
      session.dirty = session.pendingUserMutations.length > 0;
      return { projectSessionId: session.sessionId, project: dto(session) };
    });
  }

  async function commitMainProjectPatch(args: {
    projectSessionId: string;
    patch: MainProjectPatch;
  }): Promise<ProjectSaveResult> {
    return enqueue(args.projectSessionId, (session) =>
      commitMainProjectPatchInSession(session, args.patch)
    );
  }

  async function commitMainProjectPatchInSession(
    session: ProjectSession,
    patch: MainProjectPatch
  ): Promise<ProjectSaveResult> {
    assertActive(session);
    if (!session.filePath && patch.type !== "commit_batch_result" && patch.type !== "update_processing_queue") {
      throw new Error("PROJECT_NOT_SAVED");
    }

    let patchToApply = patch;
    let staleLineIds: string[] | undefined;
    let appliedDialogueUpdates: Array<{
      id: string;
      appliedTranslation: boolean;
      appliedTypesetting: boolean;
    }> | undefined;

    if (patch.type === "commit_batch_result") {
      const batchResult = validateAndFilterBatchPatch(session, patch);
      patchToApply = batchResult.filteredPatch;
      if (batchResult.staleLineIds.length > 0) {
        staleLineIds = batchResult.staleLineIds;
      }
      appliedDialogueUpdates = batchResult.appliedUpdates;
    }

    assertExpectedProcessingQueue(session, patchToApply);
    assertMainPatchSourceIsCurrent(session, patchToApply);
    const candidate = applyMainProjectPatch(session.persistedProjectSnapshot, patchToApply);
    assertMainPatchGraph(candidate, patchToApply);
    if (session.filePath) {
      await storageCoordinator.runExclusive([session.filePath], async () => {
        storageCoordinator.assertImportAvailable(
          session.filePath!,
          session.sessionId
        );
        await pageImageImports.assertFilePathAvailable(
          session.sessionId,
          session.filePath!
        );
        await persistUnlocked(session, candidate, session.filePath!);
      });
    }
    session.persistedProjectSnapshot = candidate;
    session.persistedRevision += 1;
    session.revision += 1;
    appendRevision(session, "main", changedPathsForMainPatch(patchToApply));
    // For batch results, merge updates targeting unpersisted lines into
    // pending add_dialogue_line mutations so they survive replay.
    if (patchToApply.type === "commit_batch_result" && session.pendingUserMutations.length > 0) {
      const persistedLineIds = new Set(candidate.dialogueLines.map((line) => line.id));
      const unpersistedUpdates = patchToApply.dialogueUpdates.filter(
        (update) => !persistedLineIds.has(update.id)
      );
      if (unpersistedUpdates.length > 0) {
        session.pendingUserMutations = mergeBatchResultsIntoPendingMutations(
          session.pendingUserMutations,
          unpersistedUpdates
        );
      }
    }
    try {
      session.liveProject = replayPendingUserMutations(candidate, session.pendingUserMutations);
    } catch {
      session.status = "needs_recovery";
      session.liveProject = structuredClone(candidate);
    }
    session.dirty = session.pendingUserMutations.length > 0 || !session.filePath;
    return {
      projectSessionId: session.sessionId,
      project: dto(session),
      staleLineIds,
      appliedDialogueUpdates
    };
  }

  async function acquireBatchProcessingQueue(args: {
    projectSessionId: string;
    queueId: string;
    targetPages: readonly number[] | "all";
    initialStage: "translation" | "typesetting";
    now: string;
  }): Promise<{
    project: TranslationProjectV2;
    baseRevision: number;
    queue?: ProcessingQueueState;
    saveResult?: ProjectSaveResult;
    leaseId: string;
  }> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      acquireBatchLease(args.projectSessionId, args.queueId);
      try {
        const existing = session.liveProject.processing.queue;
        if (existing && (existing.status === "running" || existing.status === "paused")) {
          throw new Error("이미 실행 중이거나 일시정지된 처리 큐가 존재합니다. 먼저 기존 작업을 취소하거나 완료해주세요.");
        }

        const project = structuredClone(session.liveProject);
        const baseRevision = session.revision;
        const targetPageSet = args.targetPages === "all" ? null : new Set(args.targetPages);
        const targetPageImages = project.pageImages
          .filter((image) => targetPageSet === null || targetPageSet.has(image.pageNumber))
          .sort((left, right) => left.pageNumber - right.pageNumber || left.id.localeCompare(right.id));
        if (targetPageImages.length === 0) {
          return { project, baseRevision, leaseId: args.queueId };
        }

        let queue = createProcessingQueue({
          queueId: args.queueId,
          projectSessionId: args.projectSessionId,
          pageImageIds: targetPageImages.map((image) => image.id),
          revision: baseRevision,
          now: args.now
        });
        queue = startProcessingQueue(queue, { now: args.now });
        queue.pages.forEach((page) => {
          page.stage = args.initialStage;
        });
        const saveResult = await commitMainProjectPatchInSession(session, {
          type: "update_processing_queue",
          queue
        });
        return { project, baseRevision, queue, saveResult, leaseId: args.queueId };
      } catch (error) {
        releaseBatchProcessingLease(args.projectSessionId, args.queueId);
        throw error;
      }
    });
  }

  async function acquireBatchProcessingQueueResume(args: {
    projectSessionId: string;
    leaseId: string;
    queueId: string;
    pageImageId: string;
    revision: number;
    mode: "retry" | "resume";
    resumeExternal: boolean;
    now: string;
  }): Promise<{
    project: TranslationProjectV2;
    baseRevision: number;
    queue: ProcessingQueueState;
    saveResult: ProjectSaveResult;
    leaseId: string;
  }> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      acquireBatchLease(args.projectSessionId, args.leaseId);
      try {
        const existing = session.liveProject.processing.queue;
        if (!existing || existing.queueId !== args.queueId) {
          throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
        }
        const page = existing.pages.find((candidate) => candidate.pageImageId === args.pageImageId);
        if (!page || page.revision !== args.revision) {
          throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
        }
        if (page.stage !== "translation" && page.stage !== "typesetting") {
          throw new Error("현재 queue 단계에 연결된 Batch executor가 없습니다.");
        }

        const project = structuredClone(session.liveProject);
        const baseRevision = session.revision;
        let queue: ProcessingQueueState;
        if (args.mode === "retry") {
          if (!page.error?.retryable) throw new Error("이 페이지 실패는 재시도할 수 없습니다.");
          queue = retryProcessingQueuePage(existing, {
            pageImageId: args.pageImageId,
            revision: args.revision,
            nextRevision: baseRevision,
            now: args.now
          });
        } else {
          if (existing.status !== "paused" || page.status !== "paused") {
            throw new Error("재개할 일시정지 queue가 없습니다.");
          }
          queue = structuredClone(existing);
          const resumedPage = queue.pages.find((candidate) => candidate.pageImageId === args.pageImageId)!;
          resumedPage.revision = baseRevision;
        }
        queue = startProcessingQueue(queue, {
          now: args.now,
          resumeExternal: args.resumeExternal
        });
        const saveResult = await commitMainProjectPatchInSession(session, {
          type: "update_processing_queue",
          queue,
          expectedQueueId: existing.queueId,
          expectedQueueToken: processingQueueConcurrencyToken(existing)
        });
        return { project, baseRevision, queue, saveResult, leaseId: args.leaseId };
      } catch (error) {
        releaseBatchProcessingLease(args.projectSessionId, args.leaseId);
        throw error;
      }
    });
  }

  async function controlBatchProcessingQueue(args: {
    projectSessionId: string;
    queueId: string;
    action: "pause" | "cancel";
    reason?: string;
    now: string;
  }): Promise<ProjectSaveResult> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      const existing = session.liveProject.processing.queue;
      if (!existing || existing.queueId !== args.queueId) {
        throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
      }
      if (existing.status === "completed" || existing.status === "cancelled" || (
        args.action === "pause" && existing.status !== "running"
      )) {
        return { projectSessionId: args.projectSessionId, project: dto(session) };
      }
      const queue = args.action === "pause"
        ? pauseProcessingQueue(existing, { now: args.now, reason: args.reason })
        : cancelProcessingQueue(existing, { now: args.now, reason: args.reason });
      return commitMainProjectPatchInSession(session, {
        type: "update_processing_queue",
        queue,
        expectedQueueId: existing.queueId,
        expectedQueueToken: processingQueueConcurrencyToken(existing)
      });
    });
  }

  function releaseBatchProcessingLease(projectSessionId: string, leaseId: string): boolean {
    if (batchLeases.get(projectSessionId) !== leaseId) return false;
    batchLeases.delete(projectSessionId);
    return true;
  }

  function acquireBatchLease(projectSessionId: string, leaseId: string): void {
    if (batchLeases.has(projectSessionId)) {
      throw new Error("이미 실행 중이거나 일시정지된 처리 큐 또는 Batch 작업이 있습니다.");
    }
    batchLeases.set(projectSessionId, leaseId);
  }

  async function registerImportedPageImages(args: {
    projectSessionId: string;
    pageImages: PageImage[];
  }): Promise<ProjectSaveResult> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      if (args.pageImages.length === 0) {
        return { projectSessionId: session.sessionId, project: dto(session) };
      }
      const revision = session.revision + 1;
      const entry: PendingUserMutation = {
        mutationId: createId(),
        acceptedRevision: revision,
        mutation: {
          type: "register_page_images",
          pageImages: structuredClone(args.pageImages)
        },
        changedPaths: args.pageImages.map((image) => `pageImages/${image.id}`),
        createdAt: now()
      };
      session.pendingUserMutations.push(entry);
      session.liveProject = replayPendingUserMutations(
        session.persistedProjectSnapshot,
        session.pendingUserMutations
      );
      session.revision = revision;
      session.dirty = true;
      appendRevision(session, "user", entry.changedPaths);
      return { projectSessionId: session.sessionId, project: dto(session) };
    });
  }

  async function preparePageImages(args: {
    projectSessionId: string;
    sourcePaths: string[];
  }) {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      if (!session.filePath) return pageImageImports.preparePageImages(args);
      return storageCoordinator.runExclusive([session.filePath], async () => {
        storageCoordinator.claimImport(session.filePath!, session.sessionId);
        try {
          const batch = await pageImageImports.preparePageImages(args);
          return batch;
        } finally {
          if (!pageImageImports.hasPendingWork(session.sessionId)) {
            storageCoordinator.releaseImport(
              session.filePath,
              session.sessionId
            );
          }
        }
      });
    });
  }

  async function linkPageImages(args: {
    projectSessionId: string;
    importBatchId: string;
    pages: Array<{ preparedImageId: string; pageNumber: number }>;
  }) {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      const link = async () => {
        if (session.filePath) {
          storageCoordinator.claimImport(
            session.filePath,
            session.sessionId
          );
        }
        try {
          const existingPendingIds = new Set(
            pageImageImports
              .getPendingPageImages(session.sessionId)
              .map((page) => page.pageImageId)
          );
          const results = await pageImageImports.linkPageImages(args);
          const linked = results.flatMap((result) =>
            result.ok &&
            !existingPendingIds.has(result.pendingPageImage.pageImageId)
              ? [result.pendingPageImage]
              : []
          );
          if (linked.length > 0) {
            session.revision += 1;
            session.dirty = true;
            appendRevision(
              session,
              "user",
              linked.map((page) => `pendingPageImages/${page.pageImageId}`)
            );
          }
          return results;
        } finally {
          if (
            session.filePath &&
            !pageImageImports.hasPendingWork(session.sessionId)
          ) {
            storageCoordinator.releaseImport(
              session.filePath,
              session.sessionId
            );
          }
        }
      };
      return session.filePath
        ? storageCoordinator.runExclusive([session.filePath], link)
        : link();
    });
  }

  async function releasePageImageImportBatch(args: {
    projectSessionId: string;
    importBatchId: string;
  }): Promise<void> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      const release = async () => {
        if (!pageImageImports.hasPendingWork(session.sessionId)) return;
        await pageImageImports.releasePageImageImportBatch(args);
        if (!pageImageImports.hasPendingWork(session.sessionId)) {
          storageCoordinator.releaseImport(
            session.filePath,
            session.sessionId
          );
        }
      };
      if (session.filePath) {
        await storageCoordinator.runExclusive([session.filePath], release);
      } else {
        await release();
      }
      session.dirty =
        session.pendingUserMutations.length > 0 ||
        pageImageImports.getPendingPageImages(session.sessionId).length > 0;
    });
  }

  function getPreparedPageImagePath(
    projectSessionId: string,
    preparedImageId: string
  ): string {
    requireSession(projectSessionId);
    return pageImageImports.getPreparedPageImagePath(
      projectSessionId,
      preparedImageId
    );
  }

  async function resumePageImageImports(
    projectSessionId: string
  ): Promise<TranslationProjectDto> {
    return enqueue(projectSessionId, async (session) => {
      if (!session.filePath) return dto(session);
      await storageCoordinator.runExclusive([session.filePath], async () => {
        storageCoordinator.claimImportForResume(
          session.filePath!,
          session.sessionId
        );
        let resumed = false;
        try {
          await pageImageImports.resumeSession({
            projectSessionId,
            project: session.persistedProjectSnapshot,
            filePath: session.filePath!
          });
          resumed = true;
        } finally {
          if (
            resumed &&
            !pageImageImports.hasPendingWork(session.sessionId)
          ) {
            storageCoordinator.releaseImport(
              session.filePath,
              session.sessionId
            );
          }
        }
      });
      session.dirty =
        session.pendingUserMutations.length > 0 ||
        pageImageImports.getPendingPageImages(projectSessionId).length > 0;
      return dto(session);
    });
  }

  async function saveProject(args: { projectSessionId: string }): Promise<ProjectSaveResult> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      if (!session.filePath) throw new Error("Project has no save path");
      const candidate = replayPendingUserMutations(
        session.persistedProjectSnapshot,
        session.pendingUserMutations
      );
      const savedCandidate = await persistUserSave(
        session,
        candidate,
        session.filePath
      );
      completeUserSave(session, savedCandidate);
      return { projectSessionId: session.sessionId, project: dto(session) };
    });
  }

  async function saveProjectAs(args: {
    projectSessionId: string;
    filePath: string;
  }): Promise<ProjectSaveResult> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      const candidate = replayPendingUserMutations(
        session.persistedProjectSnapshot,
        session.pendingUserMutations
      );
      const savedCandidate = await persistUserSave(
        session,
        candidate,
        args.filePath
      );
      session.filePath = args.filePath;
      completeUserSave(session, savedCandidate);
      return { projectSessionId: session.sessionId, project: dto(session) };
    });
  }

  async function rekeyProject(args: {
    projectSessionId: string;
    newPassword: string;
  }): Promise<ProjectSaveResult> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      if (!session.filePath || !session.protection || !session.security) {
        throw new Error("Project is not a saved secret project");
      }
      const replacement = rekeySecretProtection(session.protection, args.newPassword);
      let committed = false;
      try {
        await storageCoordinator.runExclusive([session.filePath], async () => {
          storageCoordinator.assertImportAvailable(
            session.filePath!,
            session.sessionId
          );
          await pageImageImports.assertFilePathAvailable(
            session.sessionId,
            session.filePath!
          );
          await saveProjectFile({
            filePath: session.filePath!,
            project: session.persistedProjectSnapshot,
            protection: replacement,
            security: session.security
          });
        });
        zeroizeProtection(session.protection);
        session.protection = replacement;
        session.artifactKeyPersisted = true;
        committed = true;
        return { projectSessionId: session.sessionId, project: dto(session) };
      } finally {
        if (!committed) zeroizeProtection(replacement);
      }
    });
  }

  async function persistUnlocked(
    session: ProjectSession,
    project: TranslationProjectV2,
    filePath: string,
    transactionHooks?: SaveProjectFileArgs["transactionHooks"]
  ): Promise<void> {
    await saveProjectFile({
      filePath,
      project,
      protection: session.protection,
      security: session.security,
      transactionHooks
    });
    if (session.protection) session.artifactKeyPersisted = true;
  }

  async function persistUserSave(
    session: ProjectSession,
    candidate: TranslationProjectV2,
    filePath: string
  ): Promise<TranslationProjectV2> {
    const previousFilePath = session.filePath;
    const crossDirectorySaveAs =
      previousFilePath !== undefined &&
      !sameProjectDirectory(previousFilePath, filePath);
    const lockPaths = crossDirectorySaveAs
      ? [previousFilePath!, filePath, dirname(filePath)]
      : previousFilePath
        ? [previousFilePath, filePath]
        : [filePath];
    return storageCoordinator.runExclusive(lockPaths, async () => {
      storageCoordinator.assertImportAvailable(
        filePath,
        session.sessionId
      );
      await pageImageImports.assertFilePathAvailable(
        session.sessionId,
        filePath
      );
      const hadPendingWork = pageImageImports.hasPendingWork(session.sessionId);
      const movedImport =
        hadPendingWork && previousFilePath !== filePath;
      if (hadPendingWork) {
        storageCoordinator.moveImport(
          previousFilePath,
          filePath,
          session.sessionId
        );
      }
      try {
        if (movedImport) {
          await pageImageImports.setFilePath(session.sessionId, filePath);
        }
        const pendingPages = pageImageImports.getPendingPageImages(
          session.sessionId
        );
        let savedCandidate: TranslationProjectV2;
        if (pendingPages.length === 0) {
          let relocation: PreparedProjectAssetRelocation | undefined;
          let projectPersisted = false;
          try {
            relocation = previousFilePath
              ? await prepareProjectAssetRelocation({
                  sourceProjectFilePath: previousFilePath,
                  targetProjectFilePath: filePath,
                  project: candidate
                })
              : undefined;
            await persistUnlocked(session, candidate, filePath, {
              beforeFinalRename: () => relocation?.beforeFinalRename()
            });
            projectPersisted = true;
            await relocation?.complete();
          } catch (error) {
            if (!projectPersisted && relocation) {
              await rollbackRelocationAndRethrow(relocation, error);
            }
            throw error;
          }
          savedCandidate = candidate;
        } else {
          pageImageImports.setProject(session.sessionId, candidate);
          savedCandidate = await pageImageImports.savePendingPageImages({
            projectSessionId: session.sessionId,
            persistProject: async (project, hooks) => {
              let relocation: PreparedProjectAssetRelocation | undefined;
              let projectPersisted = false;
              try {
                const relocationProject = restrictRelocationProjectToSourceCandidate(
                  project,
                  candidate
                );
                relocation = previousFilePath
                  ? await prepareProjectAssetRelocation({
                      sourceProjectFilePath: previousFilePath,
                      targetProjectFilePath: filePath,
                      project: relocationProject
                    })
                  : undefined;
                await persistUnlocked(session, project, filePath, {
                  afterCandidateValidated: hooks.afterCandidateValidated,
                  beforeFinalRename: () => relocation?.beforeFinalRename(),
                  afterProjectReplaced: hooks.afterProjectReplaced
                });
                projectPersisted = true;
                await relocation?.complete();
              } catch (error) {
                if (!projectPersisted && relocation) {
                  await rollbackRelocationAndRethrow(relocation, error);
                }
                throw error;
              }
            }
          });
        }
        if (!hadPendingWork && previousFilePath !== filePath) {
          await pageImageImports.setFilePath(session.sessionId, filePath);
        }
        if (!pageImageImports.hasPendingWork(session.sessionId)) {
          storageCoordinator.releaseImport(filePath, session.sessionId);
        }
        return savedCandidate;
      } catch (error) {
        if (movedImport) {
          await pageImageImports.setFilePath(
            session.sessionId,
            previousFilePath
          );
          if (previousFilePath) {
            storageCoordinator.moveImport(
              filePath,
              previousFilePath,
              session.sessionId
            );
          } else {
            storageCoordinator.releaseImport(filePath, session.sessionId);
          }
        }
        throw error;
      }
    });
  }

  async function closeProject(args: { projectSessionId: string }): Promise<void> {
    const previous = queues.get(args.projectSessionId) ?? Promise.resolve();
    const closing = previous.then(async () => {
      const session = sessions.get(args.projectSessionId);
      if (!session) return;
      const resumable = Boolean(
        session.filePath && pageImageImports.hasPendingWork(session.sessionId)
      );
      if (resumable) {
        storageCoordinator.markImportResumable(
          session.filePath,
          session.sessionId
        );
        pageImageImports.detachSession(session.sessionId);
      } else {
        await pageImageImports.discardSession(session.sessionId);
        storageCoordinator.releaseImport(session.filePath, session.sessionId);
      }
      session.status = "closing";
      if (session.protection) zeroizeProtection(session.protection);
      sessions.delete(session.sessionId);
      queues.delete(session.sessionId);
      batchLeases.delete(session.sessionId);
    });
    queues.set(args.projectSessionId, closing.catch(() => undefined));
    return closing;
  }

  let disposeAllPromise: Promise<void> | undefined;

  function disposeAll(): Promise<void> {
    if (disposeAllPromise) return disposeAllPromise;
    disposeAllPromise = (async () => {
      const snapshot = [...sessions.values()];
      for (const session of snapshot) {
        session.status = "closing";
        if (session.protection) zeroizeProtection(session.protection);
      }

      await Promise.allSettled(snapshot.map(async (session) => {
        const queued = queues.get(session.sessionId) ?? Promise.resolve();
        await queued.catch(() => undefined);
        if (!sessions.has(session.sessionId)) return;
        try {
          const resumable = Boolean(
            session.filePath && pageImageImports.hasPendingWork(session.sessionId)
          );
          if (resumable) {
            storageCoordinator.markImportResumable(session.filePath, session.sessionId);
            pageImageImports.detachSession(session.sessionId);
          } else {
            await pageImageImports.discardSession(session.sessionId);
            storageCoordinator.releaseImport(session.filePath, session.sessionId);
          }
        } catch {
          // Temporary cleanup failure must not mutate project files or recovery artifacts.
        }
      }));

      sessions.clear();
      queues.clear();
      batchLeases.clear();
      storageCoordinator.dispose();
    })();
    return disposeAllPromise;
  }

  function getProject(projectSessionId: string): TranslationProjectDto {
    return dto(requireSession(projectSessionId));
  }

  function captureImageExportSnapshot(
    args: { projectSessionId: string },
    assertOwner: () => void = () => undefined
  ): Promise<{ project: TranslationProjectV2; projectRevision: number; projectFilePath: string }> {
    return enqueue(args.projectSessionId, async (session) => {
      assertActive(session);
      assertOwner();
      if (!session.filePath) throw new Error("PROJECT_NOT_SAVED");
      return { project: structuredClone(session.liveProject), projectRevision: session.revision, projectFilePath: session.filePath };
    });
  }

  function getFilePath(projectSessionId: string): string | undefined {
    return requireSession(projectSessionId).filePath;
  }

  function getPageImage(projectSessionId: string, pageImageId: string): PageImage {
    const pageImage = requireSession(projectSessionId).liveProject.pageImages.find(
      (candidate) => candidate.id === pageImageId
    );
    if (!pageImage) throw new Error("Unknown page image for project session");
    return structuredClone(pageImage);
  }

  /**
   * OCR and inpainting may only read a page image that is part of the
   * persisted project snapshot. Direct session imports and opaque pending
   * replacements stay live for editing, but must be saved before a provider
   * can create a processing result for that page.
   */
  function assertPageImageReadyForProcessing(args: {
    projectSessionId: string;
    pageImageId: string;
  }): void {
    const session = requireSession(args.projectSessionId);
    assertPageImageReadyForProcessingInSession(session, args.pageImageId);
  }

  function assertPageImageReadyForProcessingInSession(
    session: ProjectSession,
    pageImageId: string
  ): void {
    const livePage = session.liveProject.pageImages.find(
      (candidate) => candidate.id === pageImageId
    );
    if (!livePage) throw new Error("Unknown page image for project session");

    const persistedPage = session.persistedProjectSnapshot.pageImages.find(
      (candidate) =>
        candidate.pageNumber === livePage.pageNumber &&
        candidate.id === livePage.id
    );
    const pendingOpaqueReplacement = pageImageImports
      .getPendingPageImages(session.sessionId)
      .some((candidate) => candidate.pageNumber === livePage.pageNumber);
    if (!persistedPage || pendingOpaqueReplacement) {
      throw new Error(PAGE_IMAGE_PROCESSING_SAVE_REQUIRED);
    }
  }

  function assertMainPatchSourceIsCurrent(
    session: ProjectSession,
    patch: MainProjectPatch
  ): void {
    if (patch.type === "commit_processing_run") {
      assertPageImageReadyForProcessingInSession(session, patch.run.pageImageId);
      const persistedPage = session.persistedProjectSnapshot.pageImages.find(
        (candidate) => candidate.id === patch.run.pageImageId
      );
      if (!persistedPage) {
        throw new Error("Processing run source page image is not persisted");
      }
      if (patch.run.sourceSha256 !== persistedPage.sha256) {
        throw new Error("Processing run source SHA-256 does not match the persisted page image");
      }
      return;
    }

    if (patch.type === "update_processing_queue") {
      for (const pageImageId of patch.queue.pageImageIds) {
        assertPageImageReadyForProcessingInSession(session, pageImageId);
      }
      return;
    }

    if (patch.type === "commit_batch_result") {
      if (patch.baseRevision !== undefined && (typeof patch.baseRevision !== "number" || !Number.isInteger(patch.baseRevision) || patch.baseRevision < 0)) {
        throw new Error("Batch baseRevision must be a non-negative integer");
      }
      if (patch.queue && session.persistedProjectSnapshot.pageImages.length > 0) {
        for (const pageImageId of patch.queue.pageImageIds) {
          if (session.persistedProjectSnapshot.pageImages.some((p) => p.id === pageImageId)) {
            assertPageImageReadyForProcessingInSession(session, pageImageId);
          }
        }
      }
      return;
    }

    assertPageImageReadyForProcessingInSession(session, patch.pageImageId);
  }

  function assertExpectedProcessingQueue(
    session: ProjectSession,
    patch: MainProjectPatch
  ): void {
    if (
      (patch.type !== "update_processing_queue" && patch.type !== "commit_batch_result") ||
      patch.expectedQueueId === undefined
    ) {
      return;
    }
    if (session.liveProject.processing.queue?.queueId !== patch.expectedQueueId) {
      throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
    }
    if (
      patch.expectedQueueToken !== undefined &&
      processingQueueConcurrencyToken(session.liveProject.processing.queue) !== patch.expectedQueueToken
    ) {
      throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
    }
  }

  function assertMainPatchGraph(
    project: TranslationProjectV2,
    patch: MainProjectPatch
  ): void {
    if (patch.type === "commit_batch_result") {
      if (patch.queue && (patch.queue.projectSessionId.length === 0 || patch.queue.queueId.length === 0)) {
        throw new Error("Processing queue identity is missing");
      }
      return;
    }

    if (patch.type === "commit_processing_run") {
      if (patch.pageRecord.pageImageId !== patch.run.pageImageId) {
        throw new Error("Processing page record does not match the run page image");
      }
      for (const asset of patch.assets) {
        if (
          asset.sourcePageImageId !== patch.run.pageImageId ||
          asset.runId !== patch.run.runId ||
          asset.source !== patch.run.source
        ) {
          throw new Error("Processing asset does not match its run and source page image");
        }
      }
      assertProcessingPageGraph(project, patch.run.pageImageId);
      return;
    }

    if (patch.type === "approve_asset") {
      const page = project.processing.pages.find(
        (candidate) => candidate.pageImageId === patch.pageImageId
      );
      if (!page) throw new Error("Approval page processing record is missing");
      const asset = project.processing.assets.find(
        (candidate) => candidate.assetId === patch.assetId
      );
      if (!asset) throw new Error("Approval asset is missing");
      if (asset.role !== patch.kind) {
        throw new Error("Approval asset role does not match the requested layer");
      }
      if (asset.sourcePageImageId !== patch.pageImageId) {
        throw new Error("Approval asset source page image does not match the page");
      }
      const run = project.processing.runs.find(
        (candidate) => candidate.runId === asset.runId
      );
      if (!run || run.pageImageId !== patch.pageImageId) {
        throw new Error("Approval asset run does not match the page");
      }
      assertProcessingPageGraph(project, patch.pageImageId);
      return;
    }

    if (patch.type === "update_processing_queue") {
      if (patch.queue.projectSessionId.length === 0 || patch.queue.queueId.length === 0) {
        throw new Error("Processing queue identity is missing");
      }
      if (patch.queue.pageImageIds.some((pageImageId) => !project.pageImages.some((page) => page.id === pageImageId))) {
        throw new Error("Processing queue references a missing page image");
      }
      return;
    }

    if (!project.pageImages.some((page) => page.id === patch.pageImageId)) {
      throw new Error("Pipeline page image is missing from the persisted project");
    }
  }

  function assertProcessingPageGraph(
    project: TranslationProjectV2,
    pageImageId: string
  ): void {
    if (!project.pageImages.some((page) => page.id === pageImageId)) {
      throw new Error("Processing page image is missing from the persisted project");
    }
    const page = project.processing.pages.find(
      (candidate) => candidate.pageImageId === pageImageId
    );
    if (!page) throw new Error("Processing page record is missing");

    const referencedRunIds = [page.activeRunId, page.latestCompletedRunId].filter(
      (runId): runId is string => typeof runId === "string"
    );
    for (const runId of referencedRunIds) {
      const run = project.processing.runs.find((candidate) => candidate.runId === runId);
      if (!run || run.pageImageId !== pageImageId) {
        throw new Error("Processing page run reference does not match the page");
      }
    }

    for (const [kind, assetId] of [
      ["cleaned", page.approvedCleanedAssetId],
      ["translated", page.approvedTranslatedAssetId]
    ] as const) {
      if (assetId === undefined) continue;
      const asset = project.processing.assets.find(
        (candidate) => candidate.assetId === assetId
      );
      if (!asset || asset.role !== kind || asset.sourcePageImageId !== pageImageId) {
        throw new Error("Processing page approval reference does not match the page");
      }
      const run = project.processing.runs.find(
        (candidate) => candidate.runId === asset.runId
      );
      if (!run || run.pageImageId !== pageImageId || run.source !== asset.source) {
        throw new Error("Processing page approval run does not match the page");
      }
    }
  }

  function getPageImageByStoredPath(
    projectSessionId: string,
    storedRelativePath: string
  ): PageImage | DerivedImageAsset {
    const project = requireSession(projectSessionId).liveProject;
    const pageImage = project.pageImages.find(
      (candidate) => candidate.storedRelativePath === storedRelativePath
    );
    if (pageImage) return structuredClone(pageImage);

    const asset = project.processing.assets.find(
      (candidate) => candidate.storedRelativePath === storedRelativePath
    );
    if (asset) return structuredClone(asset);

    throw new Error("Unknown page image for project session");
  }

  function requireSession(projectSessionId: string): ProjectSession {
    const session = sessions.get(projectSessionId);
    if (!session) throw new Error("Unknown project session");
    return session;
  }

  function dto(session: ProjectSession): TranslationProjectDto {
    return toDto(
      session,
      pageImageImports.getPendingPageImages(session.sessionId)
    );
  }

  function enqueue<T>(
    projectSessionId: string,
    operation: (session: ProjectSession) => Promise<T>
  ): Promise<T> {
    const previous = queues.get(projectSessionId) ?? Promise.resolve();
    const next = previous.then(() => operation(requireSession(projectSessionId)));
    queues.set(projectSessionId, next.catch(() => undefined));
    return next;
  }

  function completeUserSave(session: ProjectSession, candidate: TranslationProjectV2): void {
    session.persistedProjectSnapshot = structuredClone(candidate);
    session.liveProject = structuredClone(candidate);
    session.pendingUserMutations = [];
    session.persistedRevision = session.revision;
    session.dirty = false;
  }

  function hydratePage(args: {
    projectSessionId: string;
    pageNumber: number;
    prefetchRadius?: number;
  }): PageHydrationResult {
    const session = requireSession(args.projectSessionId);
    assertActive(session);

    const { manifest, chunks } = decomposeProjectToChunks(
      session.liveProject,
      session.security
    );
    const chunk = chunks.find((c) => c.pageNumber === args.pageNumber);
    if (!chunk) {
      return { ok: false, message: `Page ${args.pageNumber} not found` };
    }

    const radius = args.prefetchRadius ?? 1;
    const plan = computeViewportHydrationPlan({
      currentPageNumber: args.pageNumber,
      allPageNumbers: manifest.pageIndex.map((p) => p.pageNumber),
      currentlyHydratedPages: [args.pageNumber],
      maxCapacity: 10,
      prefetchRadius: radius
    });

    const chunkHash = computeChunkHash(chunk);
    return {
      ok: true,
      chunk: {
        ...structuredClone(chunk),
        chunkHash
      },
      prefetchedPageNumbers: plan.toHydrate
    };
  }

  function prefetchPages(args: {
    projectSessionId: string;
    pageNumber: number;
    radius?: number;
  }): number[] {
    const session = requireSession(args.projectSessionId);
    assertActive(session);
    const { manifest } = decomposeProjectToChunks(
      session.liveProject,
      session.security
    );
    const plan = computeViewportHydrationPlan({
      currentPageNumber: args.pageNumber,
      allPageNumbers: manifest.pageIndex.map((p) => p.pageNumber),
      currentlyHydratedPages: [args.pageNumber],
      maxCapacity: 10,
      prefetchRadius: args.radius ?? 1
    });
    return plan.toHydrate;
  }

  return {
    createProjectSession,
    createSecretProjectSession,
    applyProjectMutation,
    reviewCleanedAsset,
    commitMainProjectPatch,
    acquireBatchProcessingQueue,
    acquireBatchProcessingQueueResume,
    controlBatchProcessingQueue,
    releaseBatchProcessingLease,
    registerImportedPageImages,
    preparePageImages,
    linkPageImages,
    releasePageImageImportBatch,
    getPreparedPageImagePath,
    resumePageImageImports,
    saveProject,
    saveProjectAs,
    rekeyProject,
    closeProject,
    disposeAll,
    getProject,
    captureImageExportSnapshot,
    getFilePath,
    getPageImage,
    assertPageImageReadyForProcessing,
    getPageImageByStoredPath,
    hydratePage,
    prefetchPages
  };

}

export type ProjectSessionManager = ReturnType<typeof createProjectSessionManager>;

function toSessionResult(
  session: ProjectSession,
  project: TranslationProjectDto
): ProjectSessionResult {
  return {
    projectSessionId: session.sessionId,
    project,
    encrypted: session.persistedProjectSnapshot.metadata.secret
  };
}

function toDto(
  session: ProjectSession,
  pendingPageImages: TranslationProjectDto["pendingPageImages"]
): TranslationProjectDto {
  return {
    revision: session.revision,
    project: structuredClone(session.liveProject),
    pendingPageImages: structuredClone(pendingPageImages),
    dirty: session.dirty || pendingPageImages.length > 0,
    status: session.status
  };
}

function appendRevision(
  session: ProjectSession,
  owner: "user" | "main",
  changedPaths: string[]
): void {
  session.revisionJournal.push({
    revision: session.revision,
    owner,
    changedPaths,
    createdAt: new Date().toISOString()
  });
  if (session.revisionJournal.length > MAX_REVISION_JOURNAL) {
    session.revisionJournal.splice(0, session.revisionJournal.length - MAX_REVISION_JOURNAL);
  }
}

function changedPathsForMainPatch(patch: MainProjectPatch): string[] {
  if (patch.type === "commit_processing_run") {
    return [
      `processing/runs/${patch.run.runId}`,
      `processing/pages/${patch.pageRecord.pageImageId}`,
      ...patch.assets.map((asset) => `processing/assets/${asset.assetId}`)
    ];
  }
  if (patch.type === "merge_pipeline_dialogues") return [`dialogueLines/pipeline/${patch.pageImageId}`];
  if (patch.type === "update_processing_queue") return ["processing/queue"];
  if (patch.type === "commit_batch_result") {
    const paths: string[] = [];
    for (const update of patch.dialogueUpdates) {
      if (update.aiTranslation !== undefined) paths.push(`dialogueLines/${update.id}/aiTranslation`);
      if (update.typesetting !== undefined) paths.push(`dialogueLines/${update.id}/typesetting`);
      if (update.lineStatus !== undefined) paths.push(`dialogueLines/${update.id}/lineStatus`);
    }
    if (patch.queue) paths.push("processing/queue");
    return paths;
  }
  return [`processing/pages/${patch.pageImageId}/approved${patch.kind}`];
}

function assertActive(session: ProjectSession): void {
  if (session.status !== "active") throw new Error(`Project session is ${session.status}`);
}

function sameProjectDirectory(leftProjectPath: string, rightProjectPath: string): boolean {
  return sameFilesystemPath(
    dirname(leftProjectPath),
    dirname(rightProjectPath)
  );
}

async function rollbackRelocationAndRethrow(
  relocation: PreparedProjectAssetRelocation,
  originalError: unknown
): Promise<never> {
  try {
    await relocation.rollback();
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "Project save failed and asset rollback failed"
    );
  }
  throw originalError;
}

function restrictRelocationProjectToSourceCandidate(
  project: TranslationProjectV2,
  sourceCandidate: TranslationProjectV2
): TranslationProjectV2 {
  const sourceAssetKeys = new Set(
    [...sourceCandidate.pageImages, ...sourceCandidate.processing.assets].map(
      relocationAssetKey
    )
  );
  return {
    ...project,
    pageImages: project.pageImages.filter((asset) =>
      sourceAssetKeys.has(relocationAssetKey(asset))
    ),
    processing: {
      ...project.processing,
      assets: project.processing.assets.filter((asset) =>
        sourceAssetKeys.has(relocationAssetKey(asset))
      )
    }
  };
}

function relocationAssetKey(asset: {
  storedRelativePath: string;
  sha256: string;
  byteSize: number;
}): string {
  return [
    projectRelativePathIdentity(asset.storedRelativePath),
    asset.sha256.toLowerCase(),
    String(asset.byteSize)
  ].join("\u0000");
}

function validateAndFilterBatchPatch(
  session: ProjectSession,
  patch: Extract<MainProjectPatch, { type: "commit_batch_result" }>
): {
  filteredPatch: Extract<MainProjectPatch, { type: "commit_batch_result" }>;
  staleLineIds: string[];
  appliedUpdates: Array<{ id: string; appliedTranslation: boolean; appliedTypesetting: boolean }>;
} {
  const liveProject = session.liveProject;
  const validationProject = structuredClone(liveProject);
  const staleLineIds = new Set<string>();
  const staleTranslationPages = new Set<number>();
  const staleTypesettingPages = new Set<number>();
  const appliedUpdates: Array<{ id: string; appliedTranslation: boolean; appliedTypesetting: boolean }> = [];
  const filteredDialogueUpdates: typeof patch.dialogueUpdates = [];

  for (const update of patch.dialogueUpdates) {
    const validationLine = validationProject.dialogueLines.find((line) => line.id === update.id);
    if (!validationLine) {
      staleLineIds.add(update.id);
      const originalLine =
        session.persistedProjectSnapshot.dialogueLines.find((l) => l.id === update.id) ||
        session.pendingUserMutations
          .flatMap((m) => (m.mutation.type === "add_dialogue_line" ? [m.mutation.line] : []))
          .find((l) => l.id === update.id);
      if (originalLine) {
        if (update.aiTranslation !== undefined) {
          staleTranslationPages.add(originalLine.pageNumber);
        }
        if (update.typesetting !== undefined) {
          staleTypesettingPages.add(originalLine.pageNumber);
        }
      }
      appliedUpdates.push({
        id: update.id,
        appliedTranslation: false,
        appliedTypesetting: false
      });
      continue;
    }

    let appliedTranslation = false;
    let appliedTypesetting = false;
    let validAiTranslation: string | undefined = undefined;
    let validTypesetting: typeof update.typesetting = undefined;
    let lineIsStale = false;

    if (update.aiTranslation !== undefined) {
      if (update.expectedTranslationFingerprint !== undefined) {
        const currentFingerprint = computeTranslationContextFingerprint({
          dialogueLines: validationProject.dialogueLines,
          targetLineId: update.id,
          characters: validationProject.characters,
          dictionaryTerms: validationProject.dictionaryTerms,
          stylePreset: update.stylePreset ?? patch.speechStylePreset
        });
        if (currentFingerprint === update.expectedTranslationFingerprint) {
          validAiTranslation = update.aiTranslation;
          appliedTranslation = true;
          validationLine.aiTranslation = update.aiTranslation;
        } else {
          lineIsStale = true;
          staleTranslationPages.add(validationLine.pageNumber);
        }
      } else {
        validAiTranslation = update.aiTranslation;
        appliedTranslation = true;
        validationLine.aiTranslation = update.aiTranslation;
      }
    }

    if (update.typesetting !== undefined) {
      if (update.expectedTypesettingFingerprint !== undefined) {
        const currentTypesettingFingerprint = computeTypesettingContextFingerprint(validationLine);
        const translationFailedOrStale = update.aiTranslation !== undefined && !appliedTranslation;
        if (currentTypesettingFingerprint === update.expectedTypesettingFingerprint && !translationFailedOrStale) {
          validTypesetting = structuredClone(update.typesetting);
          appliedTypesetting = true;
          validationLine.typesetting = structuredClone(update.typesetting);
        } else {
          lineIsStale = true;
          staleTypesettingPages.add(validationLine.pageNumber);
        }
      } else {
        validTypesetting = structuredClone(update.typesetting);
        appliedTypesetting = true;
        validationLine.typesetting = structuredClone(update.typesetting);
      }
    }

    if (lineIsStale) {
      staleLineIds.add(update.id);
    }

    if (appliedTranslation || appliedTypesetting) {
      filteredDialogueUpdates.push({
        id: update.id,
        ...(validAiTranslation !== undefined ? { aiTranslation: validAiTranslation } : {}),
        ...(validTypesetting !== undefined ? { typesetting: validTypesetting } : {}),
        ...(update.lineStatus !== undefined ? { lineStatus: update.lineStatus } : {})
      });
    }
    appliedUpdates.push({
      id: update.id,
      appliedTranslation,
      appliedTypesetting
    });
  }

  let updatedQueue: typeof patch.queue = patch.queue ? structuredClone(patch.queue) : undefined;
  if (updatedQueue && (staleTranslationPages.size > 0 || staleTypesettingPages.size > 0)) {
    const pageImageToPageNumber = new Map<string, number>();
    for (const img of liveProject.pageImages) {
      pageImageToPageNumber.set(img.id, img.pageNumber);
    }
    for (const page of updatedQueue.pages) {
      const pageNum = pageImageToPageNumber.get(page.pageImageId);
      const hasStaleTranslation = pageNum !== undefined && staleTranslationPages.has(pageNum);
      const hasStaleTypesetting = pageNum !== undefined && staleTypesettingPages.has(pageNum);
      if (hasStaleTranslation || hasStaleTypesetting) {
        const staleStage = hasStaleTranslation ? "translation" : "typesetting";
        mergeProcessingQueuePageFailure(page, {
          code: "BATCH_STALE_CONTEXT_DISCARDED",
          message: staleStage === "translation"
            ? "실행 중 번역 문맥이 변경되어 결과가 폐기되었습니다."
            : "실행 중 식자 문맥이 변경되어 결과가 폐기되었습니다.",
          retryable: true,
          stage: staleStage,
          ...(staleStage === "translation" && patch.speechStylePreset
            ? { details: { speechStylePreset: patch.speechStylePreset } }
            : {})
        }, new Date().toISOString());
      }
    }

    const firstIncompleteIndex = updatedQueue.pages.findIndex((p) => p.status !== "completed");
    if (firstIncompleteIndex >= 0) {
      updatedQueue.status = "failed";
      updatedQueue.currentPageIndex = firstIncompleteIndex;
      updatedQueue.failureReason = updatedQueue.pages[firstIncompleteIndex]?.error?.message || "일부 페이지 처리 실패";
    } else {
      updatedQueue.status = "completed";
      updatedQueue.currentPageIndex = updatedQueue.pages.length;
      updatedQueue.failureReason = undefined;
    }
    updatedQueue.lastUpdatedAt = new Date().toISOString();
  }

  return {
    filteredPatch: {
      ...patch,
      dialogueUpdates: filteredDialogueUpdates,
      queue: updatedQueue
    },
    staleLineIds: [...staleLineIds],
    appliedUpdates
  };
}
