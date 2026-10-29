import { describe, expect, it } from "vitest";
import {
  approveProcessingQueueStage,
  cancelProcessingQueue,
  completeProcessingQueueStage,
  createProcessingQueue,
  failProcessingQueuePage,
  isCurrentProcessingQueueResult,
  pauseProcessingQueue,
  processingQueueConcurrencyToken,
  recoverInterruptedProcessingQueue,
  retryProcessingQueuePage,
  startProcessingQueue
} from "../../src/shared/processingQueue";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";

describe("processing queue", () => {
  it.each(["completed", "cancelled"] as const)("preserves a %s queue when cancel arrives late", (status) => {
    const queue = createProcessingQueue({
      queueId: "terminal-queue", projectSessionId: "session-1", pageImageIds: ["page-1"],
      revision: 4, now: "2026-10-18T00:00:00.000Z"
    });
    queue.status = status;
    queue.pages[0]!.status = status;
    const before = structuredClone(queue);
    expect(cancelProcessingQueue(queue, { now: "2026-10-18T01:00:00.000Z", reason: "late cancel" })).toEqual(before);
    expect(queue).toEqual(before);
  });

  it("processes pages sequentially and stops at every approval gate", () => {
    let queue = createProcessingQueue({
      queueId: "queue-1",
      projectSessionId: "session-1",
      pageImageIds: ["page-1", "page-2"],
      revision: 4,
      now: "2026-08-22T00:00:00.000Z"
    });

    queue = startProcessingQueue(queue, { now: "2026-08-22T00:01:00.000Z" });
    expect(queue.status).toBe("running");
    expect(queue.pages[0]).toMatchObject({ pageImageId: "page-1", status: "running", stage: "ocr" });

    queue = completeProcessingQueueStage(queue, {
      pageImageId: "page-1",
      stage: "ocr",
      revision: 4,
      runId: "run-1",
      now: "2026-08-22T00:02:00.000Z"
    });
    expect(queue.pages[0]?.status).toBe("awaiting_approval");

    queue = approveProcessingQueueStage(queue, {
      pageImageId: "page-1",
      stage: "ocr",
      now: "2026-08-22T00:03:00.000Z"
    });
    expect(queue.pages[0]).toMatchObject({ status: "running", stage: "speaker_review" });

    for (const stage of ["speaker_review", "translation", "inpainting", "typesetting"] as const) {
      queue = completeProcessingQueueStage(queue, {
        pageImageId: "page-1",
        stage,
        revision: 4,
        runId: "run-1",
        now: `2026-08-22T00:${String(10 + stage.length).padStart(2, "0")}:00.000Z`
      });
      queue = approveProcessingQueueStage(queue, {
        pageImageId: "page-1",
        stage,
        now: "2026-08-22T00:20:00.000Z"
      });
    }

    expect(queue.pages[0]?.status).toBe("completed");
    expect(queue.pages[1]).toMatchObject({ status: "running", stage: "ocr" });
    expect(queue.status).toBe("running");
  });

  it("requires explicit Resume after pausing an external provider stage", () => {
    let queue = createProcessingQueue({
      queueId: "queue-2",
      projectSessionId: "session-2",
      pageImageIds: ["page-1"],
      revision: 1,
      now: "2026-08-22T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-22T00:01:00.000Z" });
    queue = pauseProcessingQueue(queue, { now: "2026-08-22T00:02:00.000Z" });

    expect(queue.status).toBe("paused");
    expect(queue.pages[0]).toMatchObject({ status: "paused", requiresExternalResume: true });
    expect(() => startProcessingQueue(queue, { now: "2026-08-22T00:03:00.000Z" })).toThrow(/Resume/);

    queue = startProcessingQueue(queue, { now: "2026-08-22T00:04:00.000Z", resumeExternal: true });
    expect(queue).toMatchObject({ status: "running", pages: [{ status: "running", requiresExternalResume: undefined }] });
  });

  it("does not accept stale results and retries only the failed page", () => {
    let queue = createProcessingQueue({
      queueId: "queue-3",
      projectSessionId: "session-3",
      pageImageIds: ["page-1"],
      revision: 7,
      now: "2026-08-22T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-22T00:01:00.000Z" });
    queue = failProcessingQueuePage(queue, {
      pageImageId: "page-1",
      revision: 7,
      now: "2026-08-22T00:02:00.000Z",
      error: { code: "PROVIDER_TIMEOUT", message: "timeout", retryable: true, stage: "ocr" }
    });

    expect(isCurrentProcessingQueueResult(queue, {
      queueId: "queue-3",
      projectSessionId: "session-3",
      pageImageId: "page-1",
      revision: 7
    })).toBe(false);

    queue = retryProcessingQueuePage(queue, {
      pageImageId: "page-1",
      revision: 7,
      nextRevision: 8,
      now: "2026-08-22T00:03:00.000Z"
    });
    expect(queue).toMatchObject({
      status: "paused",
      pages: [{ status: "pending", stage: "ocr", revision: 8 }]
    });
    queue = startProcessingQueue(queue, { now: "2026-08-22T00:04:00.000Z", resumeExternal: true });
    expect(isCurrentProcessingQueueResult(queue, {
      queueId: "queue-3",
      projectSessionId: "session-3",
      pageImageId: "page-1",
      revision: 8
    })).toBe(true);
  });

  it("rejects a retry request carrying a stale page revision", () => {
    let queue = createProcessingQueue({
      queueId: "queue-retry-revision",
      projectSessionId: "session-1",
      pageImageIds: ["page-1"],
      revision: 4,
      now: "2026-08-29T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-29T00:00:01.000Z" });
    queue = failProcessingQueuePage(queue, {
      pageImageId: "page-1",
      revision: 4,
      now: "2026-08-29T00:00:02.000Z",
      error: { code: "BATCH_TRANSLATION_FAILED", message: "failed", retryable: true, stage: "translation" }
    });

    expect(() => retryProcessingQueuePage(queue, {
      pageImageId: "page-1",
      revision: 3,
      nextRevision: 5,
      now: "2026-08-29T00:00:03.000Z"
    })).toThrow(/revision/);
  });

  it("recovers an interrupted external queue as paused without changing its page or stage", () => {
    let queue = createProcessingQueue({
      queueId: "queue-recovery",
      projectSessionId: "old-session",
      pageImageIds: ["page-1", "page-2"],
      revision: 7,
      now: "2026-08-29T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-29T00:00:01.000Z" });
    queue.currentPageIndex = 1;
    queue.pages[0]!.status = "completed";
    queue.pages[0]!.stage = "completed";
    queue.pages[1]!.status = "running";
    queue.pages[1]!.stage = "translation";

    const recovered = recoverInterruptedProcessingQueue(queue, {
      projectSessionId: "new-session",
      now: "2026-08-29T00:01:00.000Z"
    });

    expect(recovered).toMatchObject({
      projectSessionId: "new-session",
      status: "paused",
      currentPageIndex: 1,
      pages: [
        { status: "completed", stage: "completed" },
        { status: "paused", stage: "translation", requiresExternalResume: true }
      ]
    });
    expect(processingQueueConcurrencyToken(recovered)).not.toBe(processingQueueConcurrencyToken(queue));
  });

  it("recovers interrupted local typesetting as paused without an external resume flag", () => {
    let queue = createProcessingQueue({
      queueId: "queue-local-recovery",
      projectSessionId: "old-session",
      pageImageIds: ["page-1"],
      revision: 2,
      now: "2026-08-29T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-29T00:00:01.000Z" });
    queue.pages[0]!.stage = "typesetting";

    const recovered = recoverInterruptedProcessingQueue(queue, {
      projectSessionId: "new-session",
      now: "2026-08-29T00:01:00.000Z"
    });

    expect(recovered.pages[0]).toMatchObject({ status: "paused", stage: "typesetting" });
    expect(recovered.pages[0]?.requiresExternalResume).toBeUndefined();
  });

  it("keeps queue state optional for old projects and validates persisted queue shape", () => {
    const project = createEmptyProject("Queue migration", false);
    const normalized = normalizeProject(project);
    expect(normalized.processing.queue).toBeUndefined();

    const withQueue = {
      ...project,
      processing: {
        ...project.processing,
        queue: createProcessingQueue({
          queueId: "queue-4",
          projectSessionId: "session-4",
          pageImageIds: [],
          revision: 0,
          now: "2026-08-22T00:00:00.000Z"
        })
      }
    };
    expect(normalizeProject(withQueue).processing.queue?.queueId).toBe("queue-4");
    expect(() => normalizeProject({
      ...withQueue,
      processing: { ...withQueue.processing, queue: { ...withQueue.processing.queue, currentPageIndex: -1 } }
    })).toThrow(/malformed processing state/);
  });
});
