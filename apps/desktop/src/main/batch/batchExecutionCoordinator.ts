import { randomUUID } from "node:crypto";
import {
  type BatchPipelineConfig,
  type BatchPipelineStage,
  type BatchProgressState,
  calculateBatchPercent,
  createInitialBatchProgress,
  generateBatchTypesetting,
  validateBatchPipelineConfig
} from "../../shared/batchAutomation.js";
import type { BatchDialogueUpdate } from "../../shared/projectChanges.js";
import type { DialogueLine, PipelineError, ProcessingQueueState, TranslationProject, TranslationProjectV2 } from "../../shared/projectTypes.js";
import { normalizeProject } from "../../shared/projectValidation.js";
import {
  cancelProcessingQueue,
  createProcessingQueue,
  mergeProcessingQueuePageFailure,
  pauseProcessingQueue as pauseProcessingQueueState,
  processingQueueConcurrencyToken,
  startProcessingQueue,
  type ProcessingQueueControlResult
} from "../../shared/processingQueue.js";
import {
  buildTranslationContextPayload,
  computeTranslationContextFingerprint,
  computeTypesettingContextFingerprint,
  mangaSpeechStylePresets,
  type MangaSpeechStylePreset
} from "../../shared/translationContext.js";
import type { TranslationEngineRegistry, TranslateExecutionOptions } from "../translation/translationEngineRegistry.js";
import type { ProviderSettingsStore } from "../providerSettingsStore.js";
import type { ProjectSessionManager } from "../projectSessions.js";
import type { ProjectChangeResult, ProjectSaveResult } from "../../shared/projectSessionTypes.js";

export type RunBatchJobOptions = {
  project?: TranslationProject | TranslationProjectV2;
  projectSessionId?: string;
  config: BatchPipelineConfig;
  pageCount?: number;
  requestId: string;
  onProgress?: (progress: BatchProgressState, identity?: { projectSessionId: string; queueId: string }) => void;
  queueResume?: {
    queueId: string;
    pageImageId: string;
    revision: number;
    stage: "translation" | "typesetting";
    mode: "retry" | "resume";
    resumeExternal: boolean;
    previousError?: PipelineError;
  };
};

export type RunBatchJobResult = {
  progress: BatchProgressState;
  updatedProject: TranslationProjectV2;
  sessionChange?: ProjectChangeResult;
};

export type BatchExecutionCoordinator = {
  runBatchJob: (options: RunBatchJobOptions) => Promise<RunBatchJobResult>;
  cancelBatchJob: (requestId: string) => boolean;
  cancelBatchJobAndWait: (requestId: string) => Promise<boolean>;
  controlProcessingQueue: (args: {
    projectSessionId: string;
    queueId: string;
    action: "pause" | "cancel";
    reason?: string;
  }) => Promise<ProcessingQueueControlResult>;
  cancelSessionExecutions: (projectSessionId: string) => Promise<boolean>;
  retryProcessingQueuePage: (args: {
    projectSessionId: string;
    queueId: string;
    pageImageId: string;
    revision: number;
  }) => Promise<RunBatchJobResult>;
  resumeProcessingQueue: (args: {
    projectSessionId: string;
    queueId: string;
  }) => Promise<RunBatchJobResult>;
};

type ActiveBatchExecution = {
  requestId: string;
  projectSessionId?: string;
  queueId?: string;
  acquiredLeaseId?: string;
  controller: AbortController;
  pauseRequested: boolean;
  phase: "executing" | "final_commit" | "outcome_fixed";
  pauseReason?: string;
  cancelReason?: string;
  pauseError?: unknown;
  cancelError?: unknown;
  executionError?: unknown;
  settled: Promise<void>;
  resolveSettled: () => void;
  cleanupError?: unknown;
};

class BatchCheckpointCommitError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Batch checkpoint commit failed.");
    this.name = "BatchCheckpointCommitError";
    this.cause = cause;
  }
}

export function createBatchExecutionCoordinator(deps: {
  translationEngineRegistry: TranslationEngineRegistry;
  providerSettingsStore: ProviderSettingsStore;
  projectSessionManager?: ProjectSessionManager;
}): BatchExecutionCoordinator {
  const activeExecutions = new Map<string, ActiveBatchExecution>();

  function sessionExecution(projectSessionId: string): ActiveBatchExecution | undefined {
    for (const execution of activeExecutions.values()) {
      if (execution.projectSessionId === projectSessionId) return execution;
    }
    return undefined;
  }

  function abortExecution(execution: ActiveBatchExecution): boolean {
    if (execution.phase !== "executing") return false;
    execution.pauseRequested = false;
    execution.controller.abort();
    return true;
  }

  async function waitForExecution(execution: ActiveBatchExecution): Promise<boolean> {
    await execution.settled;
    if ("cleanupError" in execution) throw execution.cleanupError;
    return true;
  }

  function cancelBatchJob(requestId: string): boolean {
    const execution = activeExecutions.get(requestId);
    if (!execution) return false;
    return abortExecution(execution);
  }

  async function cancelBatchJobAndWait(requestId: string): Promise<boolean> {
    const execution = activeExecutions.get(requestId);
    if (!execution) return false;
    abortExecution(execution);
    return waitForExecution(execution);
  }

  async function controlProcessingQueue(args: {
    projectSessionId: string;
    queueId: string;
    action: "pause" | "cancel";
    reason?: string;
  }): Promise<ProcessingQueueControlResult> {
    const manager = deps.projectSessionManager;
    if (!manager) throw new Error("Batch queue control requires a project session manager.");
    const readCurrent = () => {
      const project = manager.getProject(args.projectSessionId);
      const queue = project.project.processing.queue;
      if (!queue || queue.queueId !== args.queueId) throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
      return { project, queue };
    };
    const current = readCurrent();
    const execution = sessionExecution(args.projectSessionId);
    // Enqueue non-executing control before the first await so close drains it too.
    if (!execution || execution.queueId !== args.queueId || (
      execution.phase === "outcome_fixed" && current.queue.status === "paused" && args.action === "cancel"
    )) {
      try {
        await manager.controlBatchProcessingQueue({ ...args, now: new Date().toISOString() });
        return { ...readCurrent(), control: { status: "settled" } };
      } catch (error) {
        return { ...readCurrent(), control: { status: "failed", message: errorMessage(error) } };
      }
    }
    if (args.action === "cancel") {
      if (abortExecution(execution)) execution.cancelReason = args.reason;
    } else if (execution.phase === "executing" && !execution.controller.signal.aborted) {
      execution.pauseRequested = true;
      execution.pauseReason = args.reason;
    }
    await execution.settled;
    const errors: unknown[] = [];
    for (const key of ["executionError", "cleanupError", "cancelError", ...(args.action === "pause" ? ["pauseError"] as const : [])] as const) {
      if (key in execution) errors.push(execution[key]);
    }
    return {
      ...readCurrent(),
      control: errors.length
        ? { status: "failed", message: [...new Set(errors.map(errorMessage))].join(" / ") }
        : { status: "settled" }
    };
  }

  async function cancelSessionExecutions(projectSessionId: string): Promise<boolean> {
    const execution = sessionExecution(projectSessionId);
    if (!execution) return false;
    abortExecution(execution);
    return waitForExecution(execution);
  }

  async function retryQueuePage(args: {
    projectSessionId: string;
    queueId: string;
    pageImageId: string;
    revision: number;
  }): Promise<RunBatchJobResult> {
    if (!deps.projectSessionManager) throw new Error("Main ProjectSessionManager가 필요합니다.");
    const current = deps.projectSessionManager.getProject(args.projectSessionId);
    const queue = current.project.processing.queue;
    const page = queue?.pages.find((candidate) => candidate.pageImageId === args.pageImageId);
    if (!queue || queue.queueId !== args.queueId || !page || page.revision !== args.revision || page.status !== "failed") {
      throw new Error("재시도할 실패 queue 페이지가 없습니다.");
    }
    const stage = page.error?.stage === "typesetting" || page.stage === "typesetting"
      ? "typesetting"
      : "translation";
    const pageNumber = current.project.pageImages.find((image) => image.id === page.pageImageId)?.pageNumber;
    if (pageNumber === undefined) throw new Error("queue 페이지 이미지를 찾을 수 없습니다.");
    const overwriteExisting = stage === "translation";
    return runBatchJob({
      projectSessionId: args.projectSessionId,
      requestId: `queue-retry-${randomUUID()}`,
      config: createQueueExecutionConfig(pageNumber, stage, overwriteExisting, page.error?.details?.speechStylePreset),
      queueResume: {
        queueId: args.queueId,
        pageImageId: args.pageImageId,
        revision: args.revision,
        stage,
        mode: "retry",
        resumeExternal: stage === "translation",
        previousError: structuredClone(page.error)
      }
    });
  }

  async function resumeQueue(args: {
    projectSessionId: string;
    queueId: string;
  }): Promise<RunBatchJobResult> {
    if (!deps.projectSessionManager) throw new Error("Main ProjectSessionManager가 필요합니다.");
    const current = deps.projectSessionManager.getProject(args.projectSessionId);
    const queue = current.project.processing.queue;
    const page = queue?.pages[queue.currentPageIndex];
    if (!queue || queue.queueId !== args.queueId || queue.status !== "paused" || !page || page.status !== "paused") {
      throw new Error("재개할 일시정지 queue가 없습니다.");
    }
    if (page.stage !== "translation" && page.stage !== "typesetting") {
      throw new Error("현재 queue 단계에 연결된 Batch executor가 없습니다.");
    }
    const pageNumber = current.project.pageImages.find((image) => image.id === page.pageImageId)?.pageNumber;
    if (pageNumber === undefined) throw new Error("queue 페이지 이미지를 찾을 수 없습니다.");
    return runBatchJob({
      projectSessionId: args.projectSessionId,
      requestId: `queue-resume-${randomUUID()}`,
      config: createQueueExecutionConfig(pageNumber, page.stage, false),
      queueResume: {
        queueId: args.queueId,
        pageImageId: page.pageImageId,
        revision: page.revision,
        stage: page.stage,
        mode: "resume",
        resumeExternal: page.stage === "translation"
      }
    });
  }

  async function runBatchJob(options: RunBatchJobOptions): Promise<RunBatchJobResult> {
    const validatedConfig = validateBatchPipelineConfig(options.config);
    if (activeExecutions.has(options.requestId)) {
      throw new Error("이미 실행 중인 Batch requestId입니다.");
    }
    if (options.projectSessionId && sessionExecution(options.projectSessionId)) {
      throw new Error("이미 실행 중이거나 일시정지된 처리 큐 또는 Batch 작업이 있습니다.");
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const execution: ActiveBatchExecution = {
      requestId: options.requestId,
      projectSessionId: options.projectSessionId,
      queueId: options.projectSessionId ? options.queueResume?.queueId ?? `batch-queue-${options.requestId}` : undefined,
      controller: new AbortController(),
      pauseRequested: false,
      phase: "executing",
      settled,
      resolveSettled
    };
    activeExecutions.set(options.requestId, execution);

    let executionFailed = false;
    let executionError: unknown;
    try {
      // Await the returned cancellation commit as well as provider/checkpoint work.
      return await executeBatchJob(options, validatedConfig, execution);
    } catch (error) {
      execution.executionError = error;
      executionFailed = true;
      executionError = error;
      throw error;
    } finally {
      try {
        if (execution.projectSessionId && execution.acquiredLeaseId && deps.projectSessionManager) {
          const released = deps.projectSessionManager.releaseBatchProcessingLease(
            execution.projectSessionId, execution.acquiredLeaseId
          );
          if (!released) throw new Error("Batch 실행의 처리 lease를 해제하지 못했습니다.");
        }
      } catch (cleanupError) {
        execution.cleanupError = cleanupError;
        if (executionFailed) {
          throw new AggregateError([executionError, cleanupError], "Batch 실행과 실행 정리에 모두 실패했습니다.");
        }
        throw cleanupError;
      } finally {
        execution.phase = "outcome_fixed";
        if (activeExecutions.get(options.requestId) === execution) activeExecutions.delete(options.requestId);
        execution.resolveSettled();
      }
    }
  }

  async function executeBatchJob(
    options: RunBatchJobOptions,
    validatedConfig: BatchPipelineConfig,
    activeExecution: ActiveBatchExecution
  ): Promise<RunBatchJobResult> {
    const controller = activeExecution.controller;
    let targetProject: TranslationProjectV2;
    let baseRevision = 0;
    let queue: ProcessingQueueState | undefined;
    const now = new Date().toISOString();
    if (options.projectSessionId && deps.projectSessionManager) {
      const acquired = options.queueResume
        ? await deps.projectSessionManager.acquireBatchProcessingQueueResume({
            projectSessionId: options.projectSessionId,
            leaseId: `batch-lease-${options.requestId}`,
            queueId: options.queueResume.queueId,
            pageImageId: options.queueResume.pageImageId,
            revision: options.queueResume.revision,
            mode: options.queueResume.mode,
            resumeExternal: options.queueResume.resumeExternal,
            now
          })
        : await deps.projectSessionManager.acquireBatchProcessingQueue({
            projectSessionId: options.projectSessionId,
            queueId: `batch-queue-${options.requestId}`,
            targetPages: validatedConfig.targetPages,
            initialStage: validatedConfig.runTranslate ? "translation" : "typesetting",
            now
          });
      activeExecution.acquiredLeaseId = acquired.leaseId;
      targetProject = acquired.project;
      baseRevision = acquired.baseRevision;
      queue = acquired.queue;
      activeExecution.queueId = queue?.queueId;
    } else if (options.project) {
      const raw = options.project as Record<string, unknown>;
      const normalizedInput = {
        ...raw,
        dialogueLines: Array.isArray(raw.dialogueLines)
          ? raw.dialogueLines.map((line) =>
              isRecord(line) && !line.origin
                ? { ...line, origin: { kind: "manual" as const } }
                : line
            )
          : []
      };
      targetProject = normalizeProject(normalizedInput);
    } else {
      throw new Error("Batch job requires a valid project or projectSessionId");
    }

    // Capture initial lines and typesetting fingerprints for atomic stale detection.
    // Translation fingerprints are captured from the exact payload used per request.
    const initialLineMap = new Map<string, DialogueLine>();
    const translationPayloadFingerprints = new Map<string, string>();
    const initialTypesettingFingerprints = new Map<string, string>();

    for (const line of targetProject.dialogueLines) {
      initialLineMap.set(line.id, structuredClone(line));
      initialTypesettingFingerprints.set(
        line.id,
        computeTypesettingContextFingerprint(line)
      );
    }

    // Track which lines are modified by translation vs typesetting
    const translationChangedLineIds = new Set<string>();
    const typesettingChangedLineIds = new Set<string>();
    const checkpointAppliedTranslationLineIds = new Set<string>();
    const checkpointAppliedTypesettingLineIds = new Set<string>();
    const checkpointStaleTranslationLineIds = new Set<string>();
    const checkpointStaleTypesettingLineIds = new Set<string>();
    const checkpointStaleTranslationPages = new Set<number>();
    const checkpointStaleTypesettingPages = new Set<number>();

    // Track per-page failure and stale sets
    const translationFailedPages = new Set<number>();
    const typesettingFailedPages = new Set<number>();
    const stalePages = new Set<number>();

    const pageCount = options.pageCount ?? targetProject.pageImages?.length ?? 1;
    let progress: BatchProgressState = createInitialBatchProgress(pageCount, validatedConfig);

    const notifyProgress = (next: BatchProgressState) => {
      progress = next;
      options.onProgress?.(next, options.projectSessionId && queue
        ? { projectSessionId: options.projectSessionId, queueId: queue.queueId }
        : undefined);
    };

    const targetPageSet = validatedConfig.targetPages === "all" ? null : new Set(validatedConfig.targetPages);
    const targetPageNumbers =
      validatedConfig.targetPages === "all"
        ? Object.keys(progress.pageStatuses).map(Number).sort((a, b) => a - b)
        : [...validatedConfig.targetPages].sort((a, b) => a - b);

    // Initialize ProcessingQueue if page images exist
    const targetPageImages = (targetProject.pageImages ?? [])
      .filter((img) => targetPageSet === null || targetPageSet.has(img.pageNumber))
      .sort((a, b) => a.pageNumber - b.pageNumber);
    const queuePageIndexByPageNumber = new Map(
      targetPageImages.map((image, index) => [
        image.pageNumber,
        queue ? queue.pageImageIds.indexOf(image.id) : index
      ])
    );

    if (targetPageImages.length > 0 && !queue) {
      queue = createProcessingQueue({
        queueId: `batch-queue-${options.requestId}`,
        projectSessionId: options.projectSessionId ?? "batch-fallback",
        pageImageIds: targetPageImages.map((img) => img.id),
        revision: baseRevision,
        now
      });
      queue = startProcessingQueue(queue, { now });
      queue.pages.forEach((page) => {
        page.stage = validatedConfig.runTranslate ? "translation" : "typesetting";
      });
    }

    // Publish the acquired identity before starting any execution stage.
    notifyProgress({ ...progress, currentMessage: "일괄 작업을 준비했습니다." });

    let lastSyncedPageIndex = -1;
    let lastSyncedStage = "";
    const queueSyncWarnings = new Set<string>();

    async function persistQueueProgress(
      updatedQueue: ProcessingQueueState,
      syncKey: string
    ): Promise<void> {
      const expectedQueue = queue;
      if (!options.projectSessionId || !deps.projectSessionManager || !expectedQueue) {
        queue = updatedQueue;
        return;
      }
      try {
        await deps.projectSessionManager.commitMainProjectPatch({
          projectSessionId: options.projectSessionId,
          patch: {
            type: "update_processing_queue",
            queue: updatedQueue,
            expectedQueueId: expectedQueue.queueId,
            expectedQueueToken: processingQueueConcurrencyToken(expectedQueue)
          }
        });
        queue = updatedQueue;
      } catch (error) {
        const liveQueue = deps.projectSessionManager.getProject(options.projectSessionId).project.processing.queue;
        if (liveQueue?.queueId === expectedQueue.queueId && liveQueue.status !== "running") {
          queue = liveQueue;
          if (liveQueue.status === "paused" && !controller.signal.aborted) activeExecution.pauseRequested = true;
          if (liveQueue.status === "cancelled") controller.abort();
          throw new BatchQueueControlChangedError(liveQueue.status);
        }
        if (error instanceof Error && error.message === "BATCH_PROCESSING_QUEUE_CHANGED") {
          controller.abort();
          throw new BatchQueueControlChangedError("changed");
        }
        if (!queueSyncWarnings.has(syncKey)) {
          queueSyncWarnings.add(syncKey);
          const message = `작업 큐 진행 상태를 저장하지 못했습니다. 완료된 Provider 작업은 다시 실행하지 않습니다: ${error instanceof Error ? error.message : String(error)}`;
          progress.errors.push({ message });
          notifyProgress(structuredClone(progress));
        }
        throw error;
      }
    }

    async function syncQueueProgress(
      pageIndex: number,
      stage: "translation" | "typesetting"
    ) {
      if (!queue) return;
      if (lastSyncedPageIndex === pageIndex && lastSyncedStage === stage) return;
      const syncNow = new Date().toISOString();
      const updatedQueue = transitionBatchQueueToRunning({
        queue,
        pageIndex,
        stage,
        now: syncNow
      });
      try {
        await persistQueueProgress(updatedQueue, `${stage}:${pageIndex}:running`);
        lastSyncedPageIndex = pageIndex;
        lastSyncedStage = stage;
      } catch (error) {
        if (error instanceof BatchQueueControlChangedError) throw error;
        // The next line/page transition retries the newest queue snapshot without
        // repeating completed provider work.
      }
    }

    async function syncQueuePageOutcome(
      pageIndex: number,
      stage: "translation" | "typesetting"
    ): Promise<void> {
      if (!queue) return;
      const pageImageId = queue.pages[pageIndex]?.pageImageId;
      const pageNumber = targetProject.pageImages.find((image) => image.id === pageImageId)?.pageNumber;
      if (pageNumber === undefined) return;
      const updatedQueue = transitionBatchQueuePageOutcome({
        queue,
        pageIndex,
        stage,
        pageNumber,
        runTypeset: validatedConfig.runTypeset,
        translationFailed: translationFailedPages.has(pageNumber),
        typesettingFailed: typesettingFailedPages.has(pageNumber),
        staleTranslation: checkpointStaleTranslationPages.has(pageNumber),
        staleTypesetting: checkpointStaleTypesettingPages.has(pageNumber),
        pageError: progress.errors.find((error) => error.pageNumber === pageNumber)?.message,
        speechStylePreset: validatedConfig.speechStylePreset,
        overwriteExisting: validatedConfig.overwriteExisting,
        now: new Date().toISOString()
      });
      try {
        await persistQueueProgress(updatedQueue, `${stage}:${pageIndex}:outcome`);
      } catch (error) {
        if (error instanceof BatchQueueControlChangedError) throw error;
        // Final atomic result commit gets another chance to persist this outcome.
      }
    }

    async function commitDialogueCheckpoint(
      dialogueUpdates: BatchDialogueUpdate[]
    ): Promise<void> {
      if (dialogueUpdates.length === 0 || !options.projectSessionId || !deps.projectSessionManager) {
        return;
      }

      let saveResult: ProjectSaveResult;
      try {
        saveResult = await deps.projectSessionManager.commitMainProjectPatch({
          projectSessionId: options.projectSessionId,
          patch: {
            type: "commit_batch_result",
            speechStylePreset: validatedConfig.speechStylePreset,
            dialogueUpdates
          }
        });
      } catch (error) {
        throw new BatchCheckpointCommitError(error);
      }

      targetProject = saveResult.project.project;
      const appliedByLineId = new Map(
        (saveResult.appliedDialogueUpdates ?? []).map((update) => [update.id, update])
      );
      for (const update of dialogueUpdates) {
        const initialLine = initialLineMap.get(update.id);
        const pageNumber = initialLine?.pageNumber;
        const applied = appliedByLineId.get(update.id);
        if (update.aiTranslation !== undefined) {
          if (applied?.appliedTranslation) {
            checkpointAppliedTranslationLineIds.add(update.id);
          } else {
            checkpointStaleTranslationLineIds.add(update.id);
            if (pageNumber !== undefined) {
              stalePages.add(pageNumber);
              checkpointStaleTranslationPages.add(pageNumber);
              translationFailedPages.add(pageNumber);
              recordCheckpointStaleError(pageNumber, "translation");
            }
          }
        }
        if (update.typesetting !== undefined) {
          if (applied?.appliedTypesetting) {
            checkpointAppliedTypesettingLineIds.add(update.id);
          } else {
            checkpointStaleTypesettingLineIds.add(update.id);
            if (pageNumber !== undefined) {
              stalePages.add(pageNumber);
              checkpointStaleTypesettingPages.add(pageNumber);
              typesettingFailedPages.add(pageNumber);
              recordCheckpointStaleError(pageNumber, "typesetting");
            }
          }
        }
      }
    }

    function recordCheckpointStaleError(
      pageNumber: number,
      stage: "translation" | "typesetting"
    ): void {
      const message = stage === "translation"
        ? "실행 중 번역 문맥이 변경되어 결과가 폐기되었습니다."
        : "실행 중 식자 문맥이 변경되어 결과가 폐기되었습니다.";
      if (!progress.errors.some((error) => error.pageNumber === pageNumber && error.message === message)) {
        progress.errors.push({ pageNumber, message });
      }
      if (progress.pageStatuses[pageNumber] && !progress.pageStatuses[pageNumber].error) {
        progress.pageStatuses[pageNumber].error = message;
      }
    }

    async function finishCancelled(): Promise<RunBatchJobResult> {
      const canceledProgress: BatchProgressState = {
        ...progress,
        stage: "canceled",
        isCanceled: true,
        currentMessage: "일괄 처리가 취소되었습니다."
      };
      const result = await commitCancelledResult(options, queue, canceledProgress, targetProject, activeExecution);
      activeExecution.phase = "outcome_fixed";
      notifyProgress(result.progress);
      return result;
    }

    try {
      let translatedCount = 0;
      let failedCount = 0;
      let skippedNoGeometryCount = 0;
      let executionPaused = false;

      // 1. AI Translation
      if (validatedConfig.runTranslate && targetProject.dialogueLines.length > 0) {
        const plannedLineIds = targetProject.dialogueLines.map((line) => line.id);
        const totalLines = plannedLineIds.length;
        const currentSettings = deps.providerSettingsStore.getSettings();

        const endpoint = currentSettings.localAiEndpoint || "http://localhost:11434";
        const model = currentSettings.localAiModel || "qwen2.5:7b-instruct";
        const runtime = currentSettings.localAiRuntime || "ollama";
        const engineType = currentSettings.translationEngine || "gemini";
        const geminiModel = currentSettings.geminiModel || "gemini-2.5-flash";

        let newLines = [...targetProject.dialogueLines];
        let activeTranslationQueuePageIndex = -1;

        for (let i = 0; i < plannedLineIds.length; i++) {
          if (controller.signal.aborted) return finishCancelled();

          const lineIndex = newLines.findIndex((candidate) => candidate.id === plannedLineIds[i]);
          if (lineIndex < 0) continue;
          const line = newLines[lineIndex]!;
          if (targetPageSet && !targetPageSet.has(line.pageNumber)) {
            continue;
          }
          if (!validatedConfig.overwriteExisting && (line.userTranslation?.trim() || line.aiTranslation?.trim())) {
            continue;
          }
          if (!line.sourceText?.trim()) continue;
          if (activeExecution.pauseRequested) {
            executionPaused = true;
            break;
          }

          const currentTargetPageIndex = targetPageNumbers.indexOf(line.pageNumber);
          if (currentTargetPageIndex >= 0) {
            const currentQueuePageIndex = queuePageIndexByPageNumber.get(line.pageNumber);
            if (
              activeTranslationQueuePageIndex >= 0 &&
              currentQueuePageIndex !== undefined &&
              activeTranslationQueuePageIndex !== currentQueuePageIndex
            ) {
              await syncQueuePageOutcome(activeTranslationQueuePageIndex, "translation");
            }
            if (currentQueuePageIndex !== undefined) {
              activeTranslationQueuePageIndex = currentQueuePageIndex;
              await syncQueueProgress(currentQueuePageIndex, "translation");
            }
            progress.currentPageIndex = currentTargetPageIndex;
          }

          notifyProgress({
            ...progress,
            stage: "translate",
            percent: calculateBatchPercent("translate", Math.floor((i / totalLines) * pageCount), pageCount),
            currentMessage: `AI 문맥 번역 중 (대사 ${i + 1}/${totalLines}, ${line.pageNumber}페이지)...`
          });

          if (activeExecution.pauseRequested) {
            executionPaused = true;
            break;
          }
          if (controller.signal.aborted) return finishCancelled();

          try {
            const payloadArgs = {
              dialogueLines: newLines,
              targetLineId: line.id,
              characters: targetProject.characters,
              dictionaryTerms: targetProject.dictionaryTerms,
              stylePreset: validatedConfig.speechStylePreset
            };
            const payload = buildTranslationContextPayload(payloadArgs);
            translationPayloadFingerprints.set(
              line.id,
              computeTranslationContextFingerprint(payloadArgs)
            );

            const translateOptions: TranslateExecutionOptions = {
              engineType,
              localAiEndpoint: endpoint,
              localAiModel: model,
              localAiRuntime: runtime,
              geminiModel,
              signal: controller.signal
            };

            const result = await deps.translationEngineRegistry.executeTranslation(payload, translateOptions);

            if (controller.signal.aborted) return finishCancelled();

            if (result.translatedText?.trim()) {
              const translatedText = result.translatedText.trim();
              newLines[lineIndex] = {
                ...line,
                aiTranslation: translatedText
              };
              translationChangedLineIds.add(line.id);
              await commitDialogueCheckpoint([{
                id: line.id,
                aiTranslation: translatedText,
                expectedTranslationFingerprint: translationPayloadFingerprints.get(line.id),
                stylePreset: validatedConfig.speechStylePreset
              }]);
              if (options.projectSessionId && deps.projectSessionManager) {
                if (checkpointAppliedTranslationLineIds.has(line.id)) {
                  newLines = [...targetProject.dialogueLines];
                }
              } else {
                checkpointAppliedTranslationLineIds.add(line.id);
              }
              if (checkpointAppliedTranslationLineIds.has(line.id)) {
                translatedCount++;
                if (progress.pageStatuses[line.pageNumber]) {
                  progress.pageStatuses[line.pageNumber].translatedCount += 1;
                }
              }
            } else {
              failedCount++;
              translationFailedPages.add(line.pageNumber);
              const failMsg = `대사 #${line.order} 번역 결과가 비어 있습니다.`;
              progress.errors.push({ pageNumber: line.pageNumber, message: failMsg });
              if (progress.pageStatuses[line.pageNumber]) {
                progress.pageStatuses[line.pageNumber].error = failMsg;
              }
            }
          } catch (err) {
            if (err instanceof BatchCheckpointCommitError) throw err;
            if (controller.signal.aborted) return finishCancelled();
            failedCount++;
            translationFailedPages.add(line.pageNumber);
            const failMsg = `대사 #${line.order} 번역 실패: ${err instanceof Error ? err.message : String(err)}`;
            progress.errors.push({ pageNumber: line.pageNumber, message: failMsg });
            if (progress.pageStatuses[line.pageNumber]) {
              progress.pageStatuses[line.pageNumber].error = failMsg;
            }
          }
        }
        if (activeTranslationQueuePageIndex >= 0 && !executionPaused) {
          await syncQueuePageOutcome(activeTranslationQueuePageIndex, "translation");
        }

        if (!(options.projectSessionId && deps.projectSessionManager)) {
          targetProject = {
            ...targetProject,
            dialogueLines: newLines,
            metadata: {
              ...targetProject.metadata,
              updatedAt: new Date().toISOString()
            }
          };
        }
      }

      if (controller.signal.aborted) return finishCancelled();

      // 2. Typesetting
      if (validatedConfig.runTypeset && !executionPaused) {
        notifyProgress({
          ...progress,
          stage: "typeset",
          percent: calculateBatchPercent("typeset", 0, pageCount),
          currentMessage: "말풍선 형태별 자동 식자 및 폰트 피팅 계산 중..."
        });

        for (let tpi = 0; tpi < targetPageNumbers.length; tpi++) {
          if (activeExecution.pauseRequested) {
            executionPaused = true;
            break;
          }
          if (controller.signal.aborted) return finishCancelled();
          const pageNum = targetPageNumbers[tpi]!;
          const queuePageIndex = queuePageIndexByPageNumber.get(pageNum);
          if (queuePageIndex !== undefined) {
            await syncQueueProgress(queuePageIndex, "typesetting");
          }
          if (activeExecution.pauseRequested) {
            executionPaused = true;
            break;
          }
          if (controller.signal.aborted) return finishCancelled();
          progress.currentPageIndex = tpi;
          notifyProgress({
            ...progress,
            stage: "typeset",
            percent: calculateBatchPercent("typeset", tpi, pageCount),
            currentMessage: `말풍선 형태별 자동 식자 및 폰트 피팅 계산 중 (${pageNum}페이지)...`
          });

          if (controller.signal.aborted) return finishCancelled();

          const pageLines = targetProject.dialogueLines.filter((line) => line.pageNumber === pageNum);
          for (const line of pageLines) {
            const text = line.userTranslation?.trim() ?? "";
            if (!text) continue;
            const hasBbox = Boolean(
              line.typesetting?.bbox &&
              line.typesetting.bbox.width > 0 &&
              line.typesetting.bbox.height > 0
            );
            const hasPolygon = Boolean(line.polygon && line.polygon.length >= 3);
            if (!hasBbox && !hasPolygon) {
              skippedNoGeometryCount += 1;
              typesettingFailedPages.add(pageNum);
              progress.errors.push({
                pageNumber: pageNum,
                message: `대사 #${line.order}: 말풍선 위치 정보 없음 (식자 건너뜀)`
              });
            }
          }

          const typesetUpdatedMap = new Map(
            generateBatchTypesetting(pageLines).map((line) => [line.id, line])
          );
          const typesettingUpdates: BatchDialogueUpdate[] = [];
          let targetCount = 0;
          let successCount = 0;
          targetProject = {
            ...targetProject,
            dialogueLines: targetProject.dialogueLines.map((line) => {
              if (line.pageNumber !== pageNum) return line;
              const text = line.userTranslation?.trim() ?? "";
              if (text) targetCount += 1;
              const updated = typesetUpdatedMap.get(line.id);
              if (!updated || updated === line || !updated.typesetting) return line;
              if (text) successCount += 1;
              typesettingChangedLineIds.add(line.id);
              const typesetting = structuredClone(updated.typesetting);
              typesettingUpdates.push({
                id: line.id,
                typesetting,
                expectedTypesettingFingerprint: initialTypesettingFingerprints.get(line.id),
                stylePreset: validatedConfig.speechStylePreset
              });
              return { ...line, typesetting };
            }),
            metadata: {
              ...targetProject.metadata,
              updatedAt: new Date().toISOString()
            }
          };

          if (progress.pageStatuses[pageNum]) {
            const isDone = targetCount === 0 || (successCount === targetCount && targetCount > 0);
            progress.pageStatuses[pageNum].typesettingDone = isDone;
            if (!isDone && targetCount > 0) {
              typesettingFailedPages.add(pageNum);
            }
          }
          if (typesettingUpdates.length > 0) {
            await commitDialogueCheckpoint(typesettingUpdates);
            if (!(options.projectSessionId && deps.projectSessionManager)) {
              for (const update of typesettingUpdates) {
                checkpointAppliedTypesettingLineIds.add(update.id);
              }
            }
          }
          if (queuePageIndex !== undefined) {
            await syncQueuePageOutcome(queuePageIndex, "typesetting");
          }
        }
      }

      async function settlePauseRequest(): Promise<void> {
        if (!executionPaused || !queue) return;
        if (!options.projectSessionId || !deps.projectSessionManager) {
          queue = pauseProcessingQueueState(queue, {
            now: new Date().toISOString()
          });
          return;
        }

        const liveQueue = deps.projectSessionManager.getProject(options.projectSessionId).project.processing.queue;
        if (!liveQueue || liveQueue.queueId !== queue.queueId) {
          throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
        }
        if (liveQueue.status === "paused") {
          queue = liveQueue;
          return;
        }
        if (liveQueue.status !== "running") {
          throw new Error("BATCH_PROCESSING_QUEUE_CHANGED");
        }
        queue = liveQueue;
        const stoppedQueue = pauseProcessingQueueState(liveQueue, {
          now: new Date().toISOString(), reason: activeExecution.pauseReason
        });
        const failedPageNumbers = new Set([...translationFailedPages, ...typesettingFailedPages, ...stalePages]);
        if (failedPageNumbers.size > 0) {
          for (const page of stoppedQueue.pages) {
            const pageNumber = targetProject.pageImages.find((image) => image.id === page.pageImageId)?.pageNumber;
            if (pageNumber === undefined || !failedPageNumbers.has(pageNumber)) continue;
            const failureNow = new Date().toISOString();
            if (translationFailedPages.has(pageNumber)) {
              mergeProcessingQueuePageFailure(page, {
                code: checkpointStaleTranslationPages.has(pageNumber) ? "BATCH_STALE_CONTEXT_DISCARDED" : "BATCH_TRANSLATION_FAILED",
                message: progress.errors.find((error) => error.pageNumber === pageNumber)?.message ?? "대사 번역 처리 중 오류가 발생했습니다.",
                retryable: true,
                stage: "translation",
                details: {
                  speechStylePreset: validatedConfig.speechStylePreset,
                  overwriteExisting: validatedConfig.overwriteExisting
                }
              }, failureNow);
            }
            if (typesettingFailedPages.has(pageNumber)) {
              mergeProcessingQueuePageFailure(page, {
                code: checkpointStaleTypesettingPages.has(pageNumber) ? "BATCH_STALE_CONTEXT_DISCARDED" : "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY",
                message: progress.errors.find((error) => error.pageNumber === pageNumber && error.message.includes("식자"))?.message ?? "말풍선 위치 정보가 없어 식자를 완료하지 못했습니다.",
                retryable: true,
                stage: "typesetting"
              }, failureNow);
            }
            page.requiresExternalResume = undefined;
          }
        }
        const retryPage = options.queueResume?.mode === "retry"
          ? stoppedQueue.pages.find((page) => page.pageImageId === options.queueResume?.pageImageId)
          : undefined;
        if (retryPage && retryPage.status !== "completed" && options.queueResume?.previousError) {
          // An interrupted retry has not resolved the old page failure yet.
          mergeProcessingQueuePageFailure(retryPage, options.queueResume.previousError, new Date().toISOString());
          retryPage.requiresExternalResume = undefined;
        }
        if (stoppedQueue.pages.some((page) => page.status === "failed")) {
          stoppedQueue.status = "failed";
          stoppedQueue.pauseReason = undefined;
          stoppedQueue.currentPageIndex = stoppedQueue.pages.findIndex((page) => page.status === "failed");
          stoppedQueue.failureReason = stoppedQueue.pages[stoppedQueue.currentPageIndex]?.error?.message;
        }
        try {
          await persistQueueProgress(stoppedQueue, "pause:settled");
        } catch (error) {
          activeExecution.pauseError = error;
          // A failed pause metadata save must not discard an already accepted cancel.
          if (!controller.signal.aborted) throw error;
          progress.errors.push({ message: `일시정지 상태를 저장하지 못했습니다: ${errorMessage(error)}` });
        }
      }

      if (controller.signal.aborted) return finishCancelled();
      await settlePauseRequest();
      if (controller.signal.aborted) return finishCancelled();

      if (executionPaused) {
        // Checkpoints already own all accepted data. Do not commit again after stopping.
        activeExecution.phase = "outcome_fixed";
        const current = options.projectSessionId && deps.projectSessionManager
          ? deps.projectSessionManager.getProject(options.projectSessionId)
          : undefined;
        if (current) targetProject = current.project;
        const failed = queue?.status === "failed";
        const applied = checkpointAppliedTranslationLineIds.size + checkpointAppliedTypesettingLineIds.size;
        notifyProgress({
          ...progress,
          stage: failed && applied === 0 ? "failed" : "partial",
          currentMessage: failed
            ? "일괄 작업에 해결되지 않은 실패가 있어 중단했습니다. 작업 큐에서 실패 페이지를 확인해 주세요."
            : "일괄 작업이 일시정지되었습니다. 완료된 결과는 보존했습니다."
        });
        return {
          progress,
          updatedProject: targetProject,
          sessionChange: current ? { status: "applied", revision: current.revision, project: current } : undefined
        };
      }

      // 3. Stale Detection & Atomic Commit to ProjectSession
      let sessionChange: ProjectChangeResult | undefined;
      const allChangedLineIds = new Set([...translationChangedLineIds, ...typesettingChangedLineIds]);
      const appliedTranslationLineIds = new Set(checkpointAppliedTranslationLineIds);
      const appliedTypesettingLineIds = new Set(checkpointAppliedTypesettingLineIds);
      const staleTranslationLineIds = new Set(checkpointStaleTranslationLineIds);
      const staleTypesettingLineIds = new Set(checkpointStaleTypesettingLineIds);
      const retryStageFailed = isRetryStageFailedForPage({
        targetProject,
        resume: options.queueResume,
        translationFailedPages,
        typesettingFailedPages
      });

      if (options.projectSessionId && deps.projectSessionManager) {
        const dialogueUpdates: BatchDialogueUpdate[] = [];
        for (const line of targetProject.dialogueLines) {
          if (!allChangedLineIds.has(line.id)) continue;
          const includeTranslation = translationChangedLineIds.has(line.id) &&
            !checkpointAppliedTranslationLineIds.has(line.id) &&
            !checkpointStaleTranslationLineIds.has(line.id);
          const includeTypesetting = typesettingChangedLineIds.has(line.id) &&
            !checkpointAppliedTypesettingLineIds.has(line.id) &&
            !checkpointStaleTypesettingLineIds.has(line.id);
          if (!includeTranslation && !includeTypesetting) continue;
          dialogueUpdates.push({
            id: line.id,
            ...(includeTranslation ? { aiTranslation: line.aiTranslation } : {}),
            ...(includeTypesetting ? { typesetting: line.typesetting } : {}),
            expectedTranslationFingerprint: includeTranslation
              ? translationPayloadFingerprints.get(line.id)
              : undefined,
            expectedTypesettingFingerprint: includeTypesetting
              ? initialTypesettingFingerprints.get(line.id)
              : undefined,
            stylePreset: validatedConfig.speechStylePreset
          });
        }

        const expectedQueueToken = queue ? processingQueueConcurrencyToken(queue) : undefined;
        if (queue && "schemaVersion" in targetProject && targetProject.schemaVersion === 2) {
          queue = finalizeQueueState({
            queue,
            targetProject,
            progress,
            translationFailedPages,
            typesettingFailedPages,
            stalePages,
            staleTranslationPages: checkpointStaleTranslationPages,
            staleTypesettingPages: checkpointStaleTypesettingPages,
            speechStylePreset: validatedConfig.speechStylePreset,
            overwriteExisting: validatedConfig.overwriteExisting,
            targetPageNumbers: new Set(targetPageNumbers)
          });
          mergeRetryFailureHistory(queue, options.queueResume, new Date().toISOString(), retryStageFailed);
        }

        // This call is the final-save fence, including manager enqueue/disk waits.
        if (controller.signal.aborted) return finishCancelled();
        activeExecution.phase = "final_commit";
        const saveResult = await deps.projectSessionManager.commitMainProjectPatch({
          projectSessionId: options.projectSessionId,
          patch: {
            type: "commit_batch_result",
            baseRevision,
            speechStylePreset: validatedConfig.speechStylePreset,
            dialogueUpdates,
            queue,
            expectedQueueId: queue?.queueId,
            expectedQueueToken
          }
        });

        activeExecution.phase = "outcome_fixed";
        sessionChange = {
          status: "applied",
          revision: saveResult.project.revision,
          project: saveResult.project
        };
        targetProject = saveResult.project.project;

        const appliedByLineId = new Map(
          (saveResult.appliedDialogueUpdates ?? []).map((update) => [update.id, update])
        );
        for (const lineId of translationChangedLineIds) {
          if (checkpointAppliedTranslationLineIds.has(lineId) || checkpointStaleTranslationLineIds.has(lineId)) continue;
          if (appliedByLineId.get(lineId)?.appliedTranslation) {
            appliedTranslationLineIds.add(lineId);
          } else {
            staleTranslationLineIds.add(lineId);
          }
        }
        for (const lineId of typesettingChangedLineIds) {
          if (checkpointAppliedTypesettingLineIds.has(lineId) || checkpointStaleTypesettingLineIds.has(lineId)) continue;
          if (appliedByLineId.get(lineId)?.appliedTypesetting) {
            appliedTypesettingLineIds.add(lineId);
          } else {
            staleTypesettingLineIds.add(lineId);
          }
        }

        const staleResultLineIds = new Set([
          ...staleTranslationLineIds,
          ...staleTypesettingLineIds
        ]);
        for (const staleId of staleResultLineIds) {
          const originalLine = initialLineMap.get(staleId);
          if (originalLine) stalePages.add(originalLine.pageNumber);
        }
        if (staleResultLineIds.size > 0) {
          const staleParts: string[] = [];
          if (staleTranslationLineIds.size > 0) {
            staleParts.push(`${staleTranslationLineIds.size}개 번역`);
          }
          if (staleTypesettingLineIds.size > 0) {
            staleParts.push(`${staleTypesettingLineIds.size}개 식자`);
          }
          progress.errors.push({
            pageNumber: 0,
            message: `${staleParts.join(", ")} 결과가 Batch 실행 중 변경되어 폐기되었습니다.`
          });
        }
      } else {
        if (controller.signal.aborted) return finishCancelled();
        activeExecution.phase = "outcome_fixed";
        for (const lineId of translationChangedLineIds) {
          appliedTranslationLineIds.add(lineId);
        }
        for (const lineId of typesettingChangedLineIds) {
          appliedTypesettingLineIds.add(lineId);
        }
        // Standalone project mode without session manager
        if (queue && "schemaVersion" in targetProject && targetProject.schemaVersion === 2) {
          queue = finalizeQueueState({
            queue,
            targetProject,
            progress,
            translationFailedPages,
            typesettingFailedPages,
            stalePages,
            staleTranslationPages: checkpointStaleTranslationPages,
            staleTypesettingPages: checkpointStaleTypesettingPages,
            speechStylePreset: validatedConfig.speechStylePreset,
            overwriteExisting: validatedConfig.overwriteExisting,
            targetPageNumbers: new Set(targetPageNumbers)
          });
          mergeRetryFailureHistory(queue, options.queueResume, new Date().toISOString(), retryStageFailed);
          targetProject = {
            ...targetProject,
            processing: {
              ...targetProject.processing,
              queue
            }
          };
        }
      }

      // 4. Final Stage & Message Calculation (accurate and consistent counts)
      const translatedAppliedCount = appliedTranslationLineIds.size;
      const typesetAppliedCount = appliedTypesettingLineIds.size;
      const staleTranslationCount = staleTranslationLineIds.size;
      const staleTypesettingCount = staleTypesettingLineIds.size;
      const staleResultLineIds = new Set([
        ...staleTranslationLineIds,
        ...staleTypesettingLineIds
      ]);
      const appliedTranslationsPerPage = new Map<number, number>();
      const staleTranslationPages = new Set<number>();
      const staleTypesettingPages = new Set<number>();
      for (const lineId of appliedTranslationLineIds) {
        const pageNumber = initialLineMap.get(lineId)?.pageNumber;
        if (pageNumber !== undefined) {
          appliedTranslationsPerPage.set(
            pageNumber,
            (appliedTranslationsPerPage.get(pageNumber) ?? 0) + 1
          );
        }
      }
      for (const lineId of staleTranslationLineIds) {
        const pageNumber = initialLineMap.get(lineId)?.pageNumber;
        if (pageNumber !== undefined) staleTranslationPages.add(pageNumber);
      }
      for (const lineId of staleTypesettingLineIds) {
        const pageNumber = initialLineMap.get(lineId)?.pageNumber;
        if (pageNumber !== undefined) staleTypesettingPages.add(pageNumber);
      }

      for (const pageNumber of targetPageNumbers) {
        const pageStatus = progress.pageStatuses[pageNumber];
        if (!pageStatus) continue;
        pageStatus.translatedCount = appliedTranslationsPerPage.get(pageNumber) ?? 0;

        const hasStaleTranslation = staleTranslationPages.has(pageNumber);
        const hasStaleTypesetting = staleTypesettingPages.has(pageNumber);
        if (hasStaleTypesetting) {
          pageStatus.typesettingDone = false;
        }
        if (hasStaleTranslation && !pageStatus.error) {
          pageStatus.error = "실행 중 번역 문맥이 변경되어 결과가 폐기되었습니다.";
        } else if (hasStaleTypesetting && !pageStatus.error) {
          pageStatus.error = "실행 중 식자 문맥이 변경되어 결과가 폐기되었습니다.";
        }
      }

      const totalApplied = new Set([
        ...appliedTranslationLineIds,
        ...appliedTypesettingLineIds
      ]).size;

      let finalStage: BatchPipelineStage = "completed";
      let finishMsg = "";

      const hasAnyIssue = failedCount > 0 || staleResultLineIds.size > 0 || skippedNoGeometryCount > 0;

      if (hasAnyIssue) {
        if (totalApplied > 0) {
          finalStage = "partial";
          const parts: string[] = [];
          if (translatedAppliedCount > 0) parts.push(`${translatedAppliedCount}개 번역 적용`);
          if (typesetAppliedCount > 0) parts.push(`${typesetAppliedCount}개 식자 적용`);
          if (staleTranslationCount > 0) parts.push(`${staleTranslationCount}개 번역 실행 중 변경으로 폐기`);
          if (staleTypesettingCount > 0) parts.push(`${staleTypesettingCount}개 식자 실행 중 변경으로 폐기`);
          if (failedCount > 0) parts.push(`${failedCount}개 번역 실패`);
          if (skippedNoGeometryCount > 0) parts.push(`위치 정보 없는 ${skippedNoGeometryCount}개 식자 건너뜀`);
          finishMsg = `일괄 자동화 부분 완료: ${parts.join(", ")}`;
        } else if (failedCount > 0 || staleResultLineIds.size > 0) {
          finalStage = "failed";
          const parts: string[] = [];
          if (failedCount > 0) parts.push(`${failedCount}개 번역 실패`);
          if (staleTranslationCount > 0) parts.push(`${staleTranslationCount}개 번역 실행 중 변경으로 폐기`);
          if (staleTypesettingCount > 0) parts.push(`${staleTypesettingCount}개 식자 실행 중 변경으로 폐기`);
          finishMsg = `일괄 자동화 실패: 전체 ${parts.join(", ")}`;
        } else {
          finalStage = "partial";
          finishMsg = `일괄 자동화 부분 완료: 위치 정보 없는 ${skippedNoGeometryCount}개 식자 건너뜀`;
        }
      } else {
        finalStage = "completed";
        if (validatedConfig.runTranslate && translatedAppliedCount > 0) {
          finishMsg = `일괄 자동화 완료: ${translatedAppliedCount}개 대사 번역 완료${validatedConfig.runTypeset && typesetAppliedCount > 0 ? ", 식자 정렬 완료" : ""}`;
        } else if (validatedConfig.runTypeset && typesetAppliedCount > 0) {
          finishMsg = "일괄 식자 정렬이 완료되었습니다.";
        } else {
          finishMsg = "처리할 대사가 없습니다.";
        }
      }

      notifyProgress({
        ...progress,
        stage: finalStage,
        percent: 100,
        currentMessage: finishMsg
      });

      return { progress, updatedProject: targetProject, sessionChange };
    } catch (error) {
      if (
        error instanceof BatchQueueControlChangedError &&
        options.projectSessionId &&
        deps.projectSessionManager
      ) {
        const current = deps.projectSessionManager.getProject(options.projectSessionId);
        const liveQueue = current.project.processing.queue;
        if (liveQueue?.status === "cancelled") {
          notifyProgress({
            ...progress,
            stage: "canceled",
            isCanceled: true,
            currentMessage: "일괄 처리가 취소되었습니다."
          });
          return { progress, updatedProject: current.project };
        }
        if (liveQueue?.status === "paused") {
          notifyProgress({
            ...progress,
            stage: "partial",
            currentMessage: "일괄 작업이 일시정지되었습니다."
          });
          return { progress, updatedProject: current.project };
        }
      }
      throw error;
    }
  }

  async function commitCancelledResult(
    options: RunBatchJobOptions,
    queue: ProcessingQueueState | undefined,
    progress: BatchProgressState,
    targetProject: TranslationProjectV2,
    execution: ActiveBatchExecution
  ): Promise<RunBatchJobResult> {
    let sessionChange: ProjectChangeResult | undefined;
    if (queue && options.projectSessionId && deps.projectSessionManager) {
      try {
        const current = deps.projectSessionManager.getProject(options.projectSessionId);
        const liveQueue = current.project.processing.queue;
        if (liveQueue?.queueId === queue.queueId) {
          targetProject = current.project;
          if (liveQueue.status === "cancelled") {
            return {
              progress, updatedProject: targetProject,
              sessionChange: { status: "applied", revision: current.revision, project: current }
            };
          }
          queue = cancelProcessingQueue(liveQueue, {
            now: new Date().toISOString(),
            reason: execution.cancelReason ?? "일괄 처리가 취소되었습니다."
          });
        }
        const expectedQueueToken = liveQueue?.queueId === queue.queueId
          ? processingQueueConcurrencyToken(liveQueue)
          : undefined;
        const saveResult = await deps.projectSessionManager.commitMainProjectPatch({
          projectSessionId: options.projectSessionId,
          patch: {
            type: "update_processing_queue",
            queue,
            expectedQueueId: queue.queueId,
            expectedQueueToken
          }
        });
        sessionChange = {
          status: "applied",
          revision: saveResult.project.revision,
          project: saveResult.project
        };
        targetProject = saveResult.project.project;
      } catch (error) {
        execution.cancelError = error;
        const warning = `실제 Batch 작업은 취소됐지만 취소 상태를 프로젝트에 저장하지 못했습니다. 저장된 작업 큐가 계속 실행 중으로 보일 수 있습니다: ${error instanceof Error ? error.message : String(error)}`;
        progress = {
          ...progress,
          currentMessage: warning,
          errors: [...progress.errors, { message: warning }]
        };
      }
    }
    return { progress, updatedProject: targetProject, sessionChange };
  }

  return {
    runBatchJob,
    cancelBatchJob,
    cancelBatchJobAndWait,
    controlProcessingQueue,
    cancelSessionExecutions,
    retryProcessingQueuePage: retryQueuePage,
    resumeProcessingQueue: resumeQueue
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class BatchQueueControlChangedError extends Error {
  constructor(status: string) {
    super(`BATCH_PROCESSING_QUEUE_CONTROL_CHANGED:${status}`);
    this.name = "BatchQueueControlChangedError";
  }
}

function createQueueExecutionConfig(
  pageNumber: number,
  stage: "translation" | "typesetting",
  overwriteExisting: boolean,
  speechStylePreset: unknown = "informal"
): BatchPipelineConfig {
  const stylePreset = typeof speechStylePreset === "string" &&
    (mangaSpeechStylePresets as readonly string[]).includes(speechStylePreset)
      ? speechStylePreset as MangaSpeechStylePreset
      : "informal";
  return {
    targetPages: [pageNumber],
    runOcr: false,
    runGlossary: false,
    runTranslate: stage === "translation",
    runInpaint: false,
    runTypeset: stage === "typesetting",
    speechStylePreset: stylePreset,
    overwriteExisting
  };
}

function transitionBatchQueueToRunning(args: {
  queue: ProcessingQueueState;
  pageIndex: number;
  stage: "translation" | "typesetting";
  now: string;
}): ProcessingQueueState {
  const updatedQueue = structuredClone(args.queue);
  const safeIndex = Math.max(0, Math.min(args.pageIndex, updatedQueue.pages.length - 1));
  const page = updatedQueue.pages[safeIndex];
  if (!page) return updatedQueue;
  updatedQueue.status = "running";
  updatedQueue.currentPageIndex = safeIndex;
  updatedQueue.failureReason = undefined;
  page.status = "running";
  page.stage = args.stage;
  page.updatedAt = args.now;
  updatedQueue.lastUpdatedAt = args.now;
  return updatedQueue;
}

function transitionBatchQueuePageOutcome(args: {
  queue: ProcessingQueueState;
  pageIndex: number;
  stage: "translation" | "typesetting";
  pageNumber: number;
  runTypeset: boolean;
  translationFailed: boolean;
  typesettingFailed: boolean;
  staleTranslation: boolean;
  staleTypesetting: boolean;
  pageError?: string;
  speechStylePreset: MangaSpeechStylePreset;
  overwriteExisting: boolean;
  now: string;
}): ProcessingQueueState {
  const updatedQueue = structuredClone(args.queue);
  const page = updatedQueue.pages[args.pageIndex];
  if (!page) return updatedQueue;

  if (args.stage === "translation") {
    if (args.translationFailed) {
      mergeProcessingQueuePageFailure(page, {
        code: args.staleTranslation ? "BATCH_STALE_CONTEXT_DISCARDED" : "BATCH_TRANSLATION_FAILED",
        message: args.pageError || `페이지 ${args.pageNumber} 대사 번역 처리 중 오류가 발생했습니다.`,
        retryable: true,
        stage: "translation",
        ...(!args.staleTranslation ? {
          details: {
            speechStylePreset: args.speechStylePreset,
            overwriteExisting: args.overwriteExisting
          }
        } : {})
      }, args.now);
    } else if (args.runTypeset) {
      page.status = "pending";
      page.stage = "typesetting";
      page.updatedAt = args.now;
    } else {
      page.status = "completed";
      page.stage = "completed";
      page.error = undefined;
      page.updatedAt = args.now;
    }
  } else if (args.typesettingFailed) {
    mergeProcessingQueuePageFailure(page, {
      code: args.staleTypesetting ? "BATCH_STALE_CONTEXT_DISCARDED" : "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY",
      message: args.pageError || `페이지 ${args.pageNumber} 말풍선 위치 정보가 없어 식자를 완료하지 못했습니다.`,
      retryable: true,
      stage: "typesetting"
    }, args.now);
  } else if (page.error) {
    page.status = "failed";
    page.stage = page.error.stage === "translation" ? "translation" : "typesetting";
    page.updatedAt = args.now;
  } else {
    page.status = "completed";
    page.stage = "completed";
    page.updatedAt = args.now;
  }

  updatedQueue.status = "running";
  updatedQueue.currentPageIndex = args.pageIndex;
  updatedQueue.lastUpdatedAt = args.now;
  return updatedQueue;
}

function finalizeQueueState(args: {
  queue: ProcessingQueueState;
  targetProject: TranslationProjectV2;
  progress: BatchProgressState;
  translationFailedPages: Set<number>;
  typesettingFailedPages: Set<number>;
  stalePages: Set<number>;
  staleTranslationPages: Set<number>;
  staleTypesettingPages: Set<number>;
  speechStylePreset: MangaSpeechStylePreset;
  overwriteExisting: boolean;
  targetPageNumbers: Set<number>;
}): ProcessingQueueState {
  const updatedQueue = structuredClone(args.queue);
  const endNow = new Date().toISOString();

  const pageErrors = new Map<number, string[]>();
  for (const err of args.progress.errors) {
    if (err.pageNumber !== undefined && err.pageNumber > 0) {
      const errors = pageErrors.get(err.pageNumber) ?? [];
      errors.push(err.message);
      pageErrors.set(err.pageNumber, errors);
    }
  }

  const pageImageToPageNumber = new Map<string, number>();
  for (const img of args.targetProject.pageImages ?? []) {
    pageImageToPageNumber.set(img.id, img.pageNumber);
  }

  for (const page of updatedQueue.pages) {
    const pageNum = pageImageToPageNumber.get(page.pageImageId);
    if (pageNum === undefined || !args.targetPageNumbers.has(pageNum)) continue;
    const errors = pageNum !== undefined ? pageErrors.get(pageNum) ?? [] : [];
    const translationError = errors.find((message) => message.includes("번역"));
    const typesettingError = errors.find((message) =>
      message.includes("식자") || message.includes("말풍선 위치")
    );
    const isTransFailed = pageNum !== undefined && args.translationFailedPages.has(pageNum);
    const isTypesetFailed = pageNum !== undefined && args.typesettingFailedPages.has(pageNum);
    const hasStaleTranslation = pageNum !== undefined && args.staleTranslationPages.has(pageNum);
    const hasStaleTypesetting = pageNum !== undefined && args.staleTypesettingPages.has(pageNum);
    const hasUndifferentiatedStale = pageNum !== undefined &&
      args.stalePages.has(pageNum) &&
      !hasStaleTranslation &&
      !hasStaleTypesetting;

    page.error = undefined;
    if (isTransFailed && !hasStaleTranslation) {
      mergeProcessingQueuePageFailure(page, {
        code: "BATCH_TRANSLATION_FAILED",
        message: translationError || "대사 번역 처리 중 오류가 발생했습니다.",
        retryable: true,
        stage: "translation",
        details: {
          speechStylePreset: args.speechStylePreset,
          overwriteExisting: args.overwriteExisting
        }
      }, endNow);
    }
    if (isTypesetFailed && !hasStaleTypesetting) {
      mergeProcessingQueuePageFailure(page, {
        code: "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY",
        message: typesettingError || "말풍선 위치 정보가 없어 식자를 완료하지 못했습니다.",
        retryable: true,
        stage: "typesetting"
      }, endNow);
    }
    if (hasStaleTranslation || hasUndifferentiatedStale) {
      mergeProcessingQueuePageFailure(page, {
        code: "BATCH_STALE_CONTEXT_DISCARDED",
        message: "실행 중 원문 또는 문맥이 변경되어 결과가 폐기되었습니다.",
        retryable: true,
        stage: "translation",
        details: {
          speechStylePreset: args.speechStylePreset,
          overwriteExisting: true
        }
      }, endNow);
    }
    if (hasStaleTypesetting) {
      mergeProcessingQueuePageFailure(page, {
        code: "BATCH_STALE_CONTEXT_DISCARDED",
        message: typesettingError || "실행 중 식자 문맥이 변경되어 결과가 폐기되었습니다.",
        retryable: true,
        stage: "typesetting"
      }, endNow);
    }
    if (!page.error) {
      page.status = "completed";
      page.stage = "completed";
      page.updatedAt = endNow;
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
  updatedQueue.lastUpdatedAt = endNow;

  return updatedQueue;
}

function mergeRetryFailureHistory(
  queue: ProcessingQueueState,
  resume: RunBatchJobOptions["queueResume"],
  now: string,
  retryStageFailed: boolean
): void {
  if (resume?.mode !== "retry" || !resume.previousError) return;
  const page = queue.pages.find((candidate) => candidate.pageImageId === resume.pageImageId);
  if (!page) return;

  if (retryStageFailed && page.status === "failed" && page.error) {
    mergeProcessingQueuePageFailure(page, resume.previousError, now);
    return;
  }

  const priorFailures = [
    stripAdditionalFailureDetails(resume.previousError),
    ...readAdditionalFailureDetails(resume.previousError)
  ];
  const unresolved = priorFailures
    .map((failure, index) => ({ failure, index }))
    .filter(({ failure }) => retryFailureStage(failure) !== resume.stage);
  if (unresolved.length === 0) return;

  const active = unresolved[0]!;
  const history = unresolved
    .slice(1)
    .map(({ failure }) => failure);
  const activeError = withFailureHistory(active.failure, history);
  page.status = "failed";
  page.stage = activeError.stage === "translation" || activeError.stage === "typesetting"
    ? activeError.stage
    : page.stage;
  page.error = activeError;
  page.updatedAt = now;

  const firstIncompleteIndex = queue.pages.findIndex((candidate) => candidate.status !== "completed");
  if (firstIncompleteIndex >= 0) {
    queue.status = "failed";
    queue.currentPageIndex = firstIncompleteIndex;
    queue.failureReason = queue.pages[firstIncompleteIndex]?.error?.message || "일부 페이지 처리 실패";
  }
  queue.lastUpdatedAt = now;
}

function isRetryStageFailedForPage(args: {
  targetProject: TranslationProjectV2;
  resume: RunBatchJobOptions["queueResume"];
  translationFailedPages: Set<number>;
  typesettingFailedPages: Set<number>;
}): boolean {
  if (args.resume?.mode !== "retry") return false;
  const pageNumber = args.targetProject.pageImages.find(
    (image) => image.id === args.resume?.pageImageId
  )?.pageNumber;
  if (pageNumber === undefined) return false;
  return args.resume.stage === "translation"
    ? args.translationFailedPages.has(pageNumber)
    : args.typesettingFailedPages.has(pageNumber);
}

function retryFailureStage(error: PipelineError): "translation" | "typesetting" | undefined {
  if (error.stage === "translation" || error.stage === "typesetting") return error.stage;
  if (error.code.includes("TYPESETTING")) return "typesetting";
  if (error.code.includes("TRANSLATION") || error.code.includes("STALE")) return "translation";
  return undefined;
}

function readAdditionalFailureDetails(error: PipelineError): PipelineError[] {
  const failures = new Map<number, Partial<PipelineError>>();
  for (const [key, value] of Object.entries(error.details ?? {})) {
    const match = /^additionalFailure(\d+)(Code|Message|Stage)$/.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    const field = match[2];
    const failure = failures.get(index) ?? {};
    if (field === "Code" && typeof value === "string") failure.code = value;
    if (field === "Message" && typeof value === "string") failure.message = value;
    if (field === "Stage" && typeof value === "string") failure.stage = value;
    failures.set(index, failure);
  }
  return [...failures.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, failure]) =>
      typeof failure.code === "string" && typeof failure.message === "string"
        ? [{
            code: failure.code,
            message: failure.message,
            retryable: true,
            ...(typeof failure.stage === "string" ? { stage: failure.stage } : {})
          }]
        : []
    );
}

function stripAdditionalFailureDetails(error: PipelineError): PipelineError {
  const details = Object.fromEntries(
    Object.entries(error.details ?? {}).filter(([key]) =>
      !/^additionalFailure(\d+)(Code|Message|Stage)$/.test(key) && key !== "additionalFailureCount"
    )
  );
  return {
    ...error,
    ...(Object.keys(details).length > 0 ? { details } : { details: undefined })
  };
}

function withFailureHistory(primary: PipelineError, history: PipelineError[]): PipelineError {
  const details: NonNullable<PipelineError["details"]> = {
    ...(stripAdditionalFailureDetails(primary).details ?? {})
  };
  const uniqueHistory = history.filter((failure, index, values) =>
    values.findIndex((other) =>
      other.code === failure.code &&
      other.message === failure.message &&
      other.stage === failure.stage
    ) === index && !(
      failure.code === primary.code &&
      failure.message === primary.message &&
      failure.stage === primary.stage
    )
  );
  uniqueHistory.forEach((failure, index) => {
    const number = index + 1;
    details[`additionalFailure${number}Code`] = failure.code;
    details[`additionalFailure${number}Message`] = failure.message;
    if (failure.stage) details[`additionalFailure${number}Stage`] = failure.stage;
  });
  if (uniqueHistory.length > 0) details.additionalFailureCount = uniqueHistory.length;
  return {
    ...primary,
    ...(Object.keys(details).length > 0 ? { details } : { details: undefined })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
