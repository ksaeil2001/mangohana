import type {
  PipelineError,
  ProcessingQueuePageRecord,
  ProcessingQueuePageStatus,
  ProcessingQueueStage,
  ProcessingQueueState
} from "./projectTypes.js";
import type { TranslationProjectDto } from "./projectSessionTypes.js";
import type { BatchProgressState } from "./batchAutomation.js";

export type ProcessingQueueActionArgs = {
  projectSessionId: string;
  pageImageIds?: string[];
  pageImageId?: string;
  stage?: string;
  revision?: number;
  runId?: string;
  reason?: string;
  error?: { code: string; message: string; retryable: boolean; stage?: string };
} & (
  | { action: "pause" | "cancel" | "resume" | "retry"; queueId: string }
  | { action: "create" | "start" | "complete_stage" | "approve_stage" | "fail"; queueId?: never }
);

export type ProcessingQueueControlResult = {
  project: TranslationProjectDto;
  queue: ProcessingQueueState;
  control: { status: "settled" } | { status: "failed"; message: string };
};

export type ProcessingQueueActionResult = {
  project: TranslationProjectDto;
  queue?: ProcessingQueueState;
  control?: ProcessingQueueControlResult["control"];
};

export type BatchProgressEvent = {
  requestId: string;
  progress: BatchProgressState;
  projectSessionId?: string;
  queueId?: string;
};

const additionalFailureKeyPattern = /^additionalFailure(\d+)(Code|Message|Stage)$/;

const stageOrder: ProcessingQueueStage[] = [
  "ocr",
  "speaker_review",
  "translation",
  "inpainting",
  "typesetting",
  "completed"
];

export type ProcessingQueueIdentity = {
  queueId: string;
  projectSessionId: string;
  pageImageId: string;
  revision: number;
  runId?: string;
};

export function processingQueueConcurrencyToken(queue: ProcessingQueueState): string {
  return JSON.stringify(queue);
}

export function createProcessingQueue(args: {
  queueId: string;
  projectSessionId: string;
  pageImageIds: readonly string[];
  revision: number;
  now: string;
}): ProcessingQueueState {
  const pageImageIds = uniqueNonEmpty(args.pageImageIds);
  return {
    schemaVersion: 1,
    queueId: args.queueId,
    projectSessionId: args.projectSessionId,
    status: "idle",
    pageImageIds,
    pages: pageImageIds.map((pageImageId) => ({
      pageImageId,
      status: "pending",
      stage: "ocr",
      revision: args.revision,
      updatedAt: args.now
    })),
    currentPageIndex: 0,
    lastUpdatedAt: args.now
  };
}

export function startProcessingQueue(
  queue: ProcessingQueueState,
  args: { now: string; resumeExternal?: boolean }
): ProcessingQueueState {
  if (queue.status === "cancelled" || queue.status === "completed") {
    throw new Error("처리가 끝난 queue는 다시 시작할 수 없습니다.");
  }

  const current = currentQueuePage(queue);
  if (current?.requiresExternalResume && args.resumeExternal !== true) {
    throw new Error("외부 provider 작업은 사용자가 Resume을 눌러야 다시 시작할 수 있습니다.");
  }

  const next = cloneQueue(queue);
  const nextCurrent = currentQueuePage(next);
  next.status = "running";
  next.pauseReason = undefined;
  next.failureReason = undefined;
  if (nextCurrent && nextCurrent.status !== "awaiting_approval") {
    nextCurrent.status = "running";
    nextCurrent.requiresExternalResume = undefined;
  }
  next.lastUpdatedAt = args.now;
  return next;
}

export function pauseProcessingQueue(
  queue: ProcessingQueueState,
  args: { now: string; reason?: string }
): ProcessingQueueState {
  if (queue.status !== "running") return cloneQueue(queue);
  const next = cloneQueue(queue);
  const current = currentQueuePage(next);
  if (current?.status === "running" || current?.status === "pending") {
    current.status = "paused";
    current.requiresExternalResume = isExternalStage(current.stage);
    current.updatedAt = args.now;
  }
  next.status = "paused";
  next.pauseReason = args.reason?.trim() || "사용자가 작업을 일시정지했습니다.";
  next.lastUpdatedAt = args.now;
  return next;
}

export function cancelProcessingQueue(
  queue: ProcessingQueueState,
  args: { now: string; reason?: string }
): ProcessingQueueState {
  if (queue.status === "completed" || queue.status === "cancelled") return cloneQueue(queue);
  const next = cloneQueue(queue);
  const current = currentQueuePage(next);
  if (current && current.status !== "completed") {
    current.status = "cancelled";
    current.updatedAt = args.now;
  }
  next.status = "cancelled";
  next.pauseReason = args.reason?.trim() || "사용자가 작업을 취소했습니다.";
  next.lastUpdatedAt = args.now;
  return next;
}

export function completeProcessingQueueStage(
  queue: ProcessingQueueState,
  args: {
    pageImageId: string;
    stage: ProcessingQueueStage;
    revision: number;
    runId?: string;
    now: string;
  }
): ProcessingQueueState {
  const next = cloneQueue(queue);
  const page = requireCurrentPage(next, args.pageImageId);
  assertStage(page, args.stage);
  assertRevision(page, args.revision);
  page.status = "awaiting_approval";
  page.runId = args.runId;
  page.requiresExternalResume = undefined;
  page.updatedAt = args.now;
  next.currentRunId = args.runId;
  next.lastUpdatedAt = args.now;
  return next;
}

export function approveProcessingQueueStage(
  queue: ProcessingQueueState,
  args: { pageImageId: string; stage: ProcessingQueueStage; now: string }
): ProcessingQueueState {
  const next = cloneQueue(queue);
  const page = requireCurrentPage(next, args.pageImageId);
  if (page.status !== "awaiting_approval" || page.stage !== args.stage) {
    throw new Error("승인 대기 중인 queue 단계가 아닙니다.");
  }
  const stageIndex = stageOrder.indexOf(args.stage);
  const nextStage = stageOrder[stageIndex + 1];
  page.updatedAt = args.now;
  if (!nextStage || nextStage === "completed") {
    page.status = "completed";
    page.stage = "completed";
    advanceQueueCursor(next);
  } else {
    page.status = "running";
    page.stage = nextStage;
    page.requiresExternalResume = undefined;
  }
  next.lastUpdatedAt = args.now;
  return next;
}

export function failProcessingQueuePage(
  queue: ProcessingQueueState,
  args: {
    pageImageId: string;
    revision: number;
    now: string;
    error: { code: string; message: string; retryable: boolean; stage?: string };
  }
): ProcessingQueueState {
  const next = cloneQueue(queue);
  const page = requireCurrentPage(next, args.pageImageId);
  assertRevision(page, args.revision);
  page.status = "failed";
  page.error = { ...args.error };
  page.updatedAt = args.now;
  next.status = "failed";
  next.failureReason = args.error.message;
  next.lastUpdatedAt = args.now;
  return next;
}

export function retryProcessingQueuePage(
  queue: ProcessingQueueState,
  args: { pageImageId: string; revision: number; nextRevision?: number; now: string }
): ProcessingQueueState {
  const next = cloneQueue(queue);
  const page = next.pages.find((candidate) => candidate.pageImageId === args.pageImageId);
  if (!page || page.status !== "failed") throw new Error("재시도할 실패 queue 페이지가 없습니다.");
  assertRevision(page, args.revision);
  page.status = "pending";
  page.requiresExternalResume = isExternalStage(page.stage) || undefined;
  page.error = undefined;
  page.revision = args.nextRevision ?? args.revision;
  page.updatedAt = args.now;
  next.currentPageIndex = next.pageImageIds.indexOf(args.pageImageId);
  next.status = "paused";
  next.failureReason = undefined;
  next.pauseReason = "실패 페이지가 재시도 대기로 돌아갔습니다.";
  next.lastUpdatedAt = args.now;
  return next;
}

export function recoverInterruptedProcessingQueue(
  queue: ProcessingQueueState,
  args: { projectSessionId: string; now: string }
): ProcessingQueueState {
  const next = cloneQueue(queue);
  next.projectSessionId = args.projectSessionId;
  if (next.status !== "running") return next;

  const current = currentQueuePage(next);
  if (current && (current.status === "running" || current.status === "pending")) {
    current.status = "paused";
    current.requiresExternalResume = isExternalStage(current.stage) || undefined;
    current.updatedAt = args.now;
  }
  next.status = "paused";
  next.pauseReason = "이전 앱 실행이 종료되어 작업이 일시정지되었습니다.";
  next.lastUpdatedAt = args.now;
  return next;
}

/**
 * Records another failure without losing the most useful persisted explanation.
 * Provider/translation failures remain primary; stale and geometry failures are
 * retained as indexed details that survive project save/reopen.
 */
export function mergeProcessingQueuePageFailure(
  page: ProcessingQueuePageRecord,
  error: PipelineError,
  now: string
): void {
  const existing = page.error;
  if (!existing) {
    page.status = "failed";
    page.stage = processingQueueStageFromError(error, page.stage);
    page.error = structuredClone(error);
    page.updatedAt = now;
    return;
  }

  const useIncomingAsPrimary = processingQueueErrorPriority(error) > processingQueueErrorPriority(existing);
  const primary = useIncomingAsPrimary ? structuredClone(error) : structuredClone(existing);
  const secondary = useIncomingAsPrimary ? existing : error;
  const details: NonNullable<PipelineError["details"]> = {
    ...(primary.details ?? {})
  };
  const existingAdditionalFailures = readAdditionalFailures(existing);
  const incomingAdditionalFailures = readAdditionalFailures(error);
  const additionalFailures = useIncomingAsPrimary
    ? [stripAdditionalFailureDetails(existing), ...existingAdditionalFailures, ...incomingAdditionalFailures]
    : [...existingAdditionalFailures, stripAdditionalFailureDetails(secondary), ...incomingAdditionalFailures];
  const uniqueAdditionalFailures = additionalFailures.filter((candidate, index, values) =>
    values.findIndex((other) =>
      other.code === candidate.code &&
      other.message === candidate.message &&
      other.stage === candidate.stage
    ) === index && !(
      candidate.code === primary.code &&
      candidate.message === primary.message &&
      candidate.stage === primary.stage
    )
  );

  for (const key of Object.keys(details)) {
    if (additionalFailureKeyPattern.test(key) || key === "additionalFailureCount") {
      delete details[key];
    }
  }
  uniqueAdditionalFailures.forEach((failure, index) => {
    const number = index + 1;
    details[`additionalFailure${number}Code`] = failure.code;
    details[`additionalFailure${number}Message`] = failure.message;
    if (failure.stage) details[`additionalFailure${number}Stage`] = failure.stage;
  });
  if (uniqueAdditionalFailures.length > 0) {
    details.additionalFailureCount = uniqueAdditionalFailures.length;
  }

  page.status = "failed";
  page.stage = processingQueueStageFromError(primary, page.stage);
  page.error = {
    ...primary,
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
  page.updatedAt = now;
}

export function isCurrentProcessingQueueResult(
  queue: ProcessingQueueState,
  identity: ProcessingQueueIdentity
): boolean {
  const page = queue.pages.find((candidate) => candidate.pageImageId === identity.pageImageId);
  return Boolean(
    queue.queueId === identity.queueId &&
    queue.projectSessionId === identity.projectSessionId &&
    page &&
    page.revision === identity.revision &&
    (identity.runId === undefined || page.runId === identity.runId) &&
    page.status !== "cancelled" &&
    page.status !== "failed"
  );
}

export function currentQueuePage(queue: ProcessingQueueState): ProcessingQueuePageRecord | undefined {
  return queue.pages[queue.currentPageIndex];
}

function advanceQueueCursor(queue: ProcessingQueueState): void {
  const nextIndex = queue.pages.findIndex((page) => page.status !== "completed");
  if (nextIndex < 0) {
    queue.currentPageIndex = queue.pages.length;
    queue.status = "completed";
    queue.currentRunId = undefined;
    return;
  }
  queue.currentPageIndex = nextIndex;
  if (queue.status === "running") {
    queue.pages[nextIndex]!.status = "running";
  }
  queue.currentRunId = queue.pages[nextIndex]?.runId;
}

function requireCurrentPage(queue: ProcessingQueueState, pageImageId: string): ProcessingQueuePageRecord {
  const page = currentQueuePage(queue);
  if (!page || page.pageImageId !== pageImageId) {
    throw new Error("queue는 한 번에 한 페이지씩만 처리할 수 있습니다.");
  }
  return page;
}

function assertStage(page: ProcessingQueuePageRecord, stage: ProcessingQueueStage): void {
  if (page.stage !== stage) throw new Error("queue 단계가 현재 페이지 단계와 일치하지 않습니다.");
}

function assertRevision(page: ProcessingQueuePageRecord, revision: number): void {
  if (page.revision !== revision) throw new Error("queue 결과가 오래된 revision을 가리킵니다.");
}

function isExternalStage(stage: ProcessingQueueStage): boolean {
  return stage === "ocr" || stage === "translation" || stage === "inpainting";
}

function processingQueueErrorPriority(error: PipelineError): number {
  if (
    error.code === "BATCH_TRANSLATION_FAILED" ||
    (error.stage === "translation" && !error.code.includes("STALE"))
  ) {
    return 300;
  }
  if (error.code === "BATCH_TYPESETTING_SKIPPED_NO_GEOMETRY") return 200;
  if (error.code === "BATCH_STALE_CONTEXT_DISCARDED") return 100;
  return 250;
}

function processingQueueStageFromError(
  error: PipelineError,
  fallback: ProcessingQueueStage
): ProcessingQueueStage {
  return error.stage === "translation" || error.stage === "typesetting"
    ? error.stage
    : fallback;
}

function readAdditionalFailures(error: PipelineError): PipelineError[] {
  const failures = new Map<number, Partial<PipelineError>>();
  for (const [key, value] of Object.entries(error.details ?? {})) {
    const match = additionalFailureKeyPattern.exec(key);
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
      !additionalFailureKeyPattern.test(key) && key !== "additionalFailureCount"
    )
  );
  return {
    ...error,
    ...(Object.keys(details).length > 0 ? { details } : { details: undefined })
  };
}

function cloneQueue(queue: ProcessingQueueState): ProcessingQueueState {
  return structuredClone(queue);
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function isProcessingQueuePageStatus(value: unknown): value is ProcessingQueuePageStatus {
  return value === "pending" || value === "running" || value === "paused" ||
    value === "awaiting_approval" || value === "completed" || value === "failed" || value === "cancelled";
}
