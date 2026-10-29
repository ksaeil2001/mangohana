import { describe, expect, it } from "vitest";
import { createProjectSessionManager } from "../../src/main/projectSessions";
import { createProcessingQueue, pauseProcessingQueue, startProcessingQueue } from "../../src/shared/processingQueue";
import { createEmptyProject } from "../../src/shared/projectValidation";

describe("project session processing queue persistence", () => {
  it("stores queue state through the existing Main patch and preserves paused state", async () => {
    const writes: unknown[] = [];
    const manager = createProjectSessionManager({
      saveProjectFile: async ({ project }) => {
        writes.push(structuredClone(project));
      }
    });
    const project = createEmptyProject("Queue session", false);
    project.pageImages = [{
      id: "page-1",
      pageNumber: 1,
      storedRelativePath: "queue-assets/images/page-001.png",
      originalFileName: "page-001.png",
      sha256: "a".repeat(64),
      byteSize: 10,
      mimeType: "image/png",
      copiedAt: "2026-08-22T00:00:00.000Z"
    }];
    const created = manager.createProjectSession({ project, filePath: "C:\\projects\\queue.ctp" });
    let queue = createProcessingQueue({
      queueId: "queue-1",
      projectSessionId: created.projectSessionId,
      pageImageIds: ["page-1"],
      revision: created.project.revision + 1,
      now: "2026-08-22T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-22T00:01:00.000Z" });
    queue = pauseProcessingQueue(queue, { now: "2026-08-22T00:02:00.000Z", reason: "test pause" });

    const result = await manager.commitMainProjectPatch({
      projectSessionId: created.projectSessionId,
      patch: { type: "update_processing_queue", queue }
    });

    expect(result.project.project.processing.queue).toMatchObject({
      queueId: "queue-1",
      status: "paused",
      pages: [{ pageImageId: "page-1", status: "paused", requiresExternalResume: true }]
    });
    expect(writes).toHaveLength(1);
  });

  it("recovers a persisted running translation queue as paused on a new app session", () => {
    const project = createEmptyProject("Restart recovery", false);
    project.pageImages = [{
      id: "page-1",
      pageNumber: 1,
      storedRelativePath: "queue-assets/images/page-001.png",
      originalFileName: "page-001.png",
      sha256: "a".repeat(64),
      byteSize: 10,
      mimeType: "image/png",
      copiedAt: "2026-08-22T00:00:00.000Z"
    }];
    let queue = createProcessingQueue({
      queueId: "persisted-running",
      projectSessionId: "previous-process-session",
      pageImageIds: ["page-1"],
      revision: 8,
      now: "2026-08-29T00:00:00.000Z"
    });
    queue = startProcessingQueue(queue, { now: "2026-08-29T00:00:01.000Z" });
    queue.pages[0]!.stage = "translation";
    project.processing.queue = queue;

    const manager = createProjectSessionManager({
      createId: () => "current-process-session",
      now: () => "2026-08-29T00:02:00.000Z"
    });
    const created = manager.createProjectSession({ project });

    expect(created.project.project.processing.queue).toMatchObject({
      queueId: "persisted-running",
      projectSessionId: "current-process-session",
      status: "paused",
      currentPageIndex: 0,
      pages: [{ status: "paused", stage: "translation", requiresExternalResume: true }]
    });
    expect(created.project.dirty).toBe(true);
  });
});
