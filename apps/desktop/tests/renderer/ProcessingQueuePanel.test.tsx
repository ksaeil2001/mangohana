import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import type {
  PageImage,
  ProcessingQueuePageRecord,
  ProcessingQueueState,
  TranslationProjectV2
} from "../../src/shared/projectTypes";
import { ProcessingQueuePanel } from "../../src/renderer/components/ProcessingQueuePanel";
import type { ProcessingQueueActionResult } from "../../src/shared/processingQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function pageImage(id: string, pageNumber: number): PageImage {
  return {
    id,
    pageNumber,
    storedRelativePath: `images/${id}.png`,
    originalFileName: `${id}.png`,
    sha256: "a".repeat(64),
    byteSize: 1,
    mimeType: "image/png",
    copiedAt: "2026-08-22T00:00:00.000Z"
  };
}

function page(
  pageImageId: string,
  status: ProcessingQueuePageRecord["status"],
  stage: ProcessingQueuePageRecord["stage"],
  revision = 1,
  overrides: Partial<ProcessingQueuePageRecord> = {}
): ProcessingQueuePageRecord {
  return {
    pageImageId,
    status,
    stage,
    revision,
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides
  };
}

function queue(
  pages: ProcessingQueuePageRecord[],
  status: ProcessingQueueState["status"],
  currentPageIndex: number
): ProcessingQueueState {
  return {
    schemaVersion: 1,
    queueId: "queue-1",
    projectSessionId: "session-1",
    status,
    pageImageIds: pages.map((item) => item.pageImageId),
    pages,
    currentPageIndex,
    lastUpdatedAt: "2026-08-22T00:00:00.000Z"
  };
}

function projectWithQueue(queueState?: ProcessingQueueState): TranslationProjectV2 {
  const project = createEmptyProject("Queue test", false);
  project.pageImages = [pageImage("page-1", 1), pageImage("page-2", 2), pageImage("page-3", 3)];
  if (queueState) project.processing.queue = queueState;
  return normalizeProject(project);
}

function sessionResult(project: TranslationProjectV2) {
  return {
    revision: 2,
    project,
    pendingPageImages: [],
    dirty: true,
    status: "active" as const
  };
}

function renderPanel(project: TranslationProjectV2) {
  const updateProcessingQueue = vi.fn().mockResolvedValue({
    project: sessionResult(project),
    queue: project.processing.queue
  });
  window.projectApi = {
    importTxtFile: vi.fn(),
    exportTranslations: vi.fn(),
    saveProject: vi.fn(),
    updateProcessingQueue
  };
  const onOpenBatchAutomation = vi.fn();
  return { updateProcessingQueue, onOpenBatchAutomation, ...render(
    <ProcessingQueuePanel
      project={project}
      projectSessionId="session-1"
      sessionGeneration={1}
      onOpenBatchAutomation={onOpenBatchAutomation}
      onResult={vi.fn().mockResolvedValue("adopted")}
      onError={vi.fn()}
    />
  ) };
}

describe("ProcessingQueuePanel", () => {
  it("distinguishes unrun pages from provider failures after a current-page resume", () => {
    const state = queue([page("page-1", "completed", "completed"), page("page-2", "pending", "translation")], "failed", 1);
    state.failureReason = "일부 페이지 처리 실패";
    const { onOpenBatchAutomation, updateProcessingQueue } = renderPanel(projectWithQueue(state));
    expect(screen.getByText(/남은 페이지 확인 필요/)).toBeVisible();
    expect(screen.getByText(/아직 실행하지 않은 페이지가 1개/)).toBeVisible();
    expect(screen.queryByText("일부 페이지 처리 실패")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "실패 번역 다시 실행" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "새 일괄 작업 설정" }));
    expect(onOpenBatchAutomation).toHaveBeenCalledOnce();
    expect(updateProcessingQueue).not.toHaveBeenCalled();
  });
  it.each(["resolve", "reject"] as const)("keeps the newer cancel pending after a late pause %s and blocks same-frame duplicates", async (outcome) => {
    const project = projectWithQueue(queue([page("page-1", "running", "translation")], "running", 0));
    const pause = deferred<ProcessingQueueActionResult>();
    const cancel = deferred<ProcessingQueueActionResult>();
    const adoption = deferred<"adopted" | "ignored">();
    const onResult = vi.fn().mockReturnValue(adoption.promise);
    const onError = vi.fn();
    const updateProcessingQueue = vi.fn().mockReturnValueOnce(pause.promise).mockReturnValueOnce(cancel.promise);
    window.projectApi = { importTxtFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(), updateProcessingQueue };
    render(<ProcessingQueuePanel project={project} projectSessionId="session-1" sessionGeneration={1} onResult={onResult} onError={onError} />);
    const response = { project: sessionResult(project), queue: project.processing.queue };
    try {
      const pauseButton = screen.getByRole("button", { name: "일시정지" });
      act(() => { pauseButton.click(); pauseButton.click(); });
      expect(updateProcessingQueue).toHaveBeenCalledOnce();
      const cancelButton = screen.getByRole("button", { name: "큐 취소" });
      act(() => { cancelButton.click(); cancelButton.click(); });
      expect(updateProcessingQueue).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (outcome === "resolve") pause.resolve(response);
        else pause.reject(new Error("늦은 일시정지 실패"));
        await pause.promise.catch(() => undefined);
      });
      expect(onResult).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "큐 취소" })).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("취소를 요청했습니다.");
      await act(async () => { cancel.resolve(response); await cancel.promise; });
      expect(onResult).toHaveBeenCalledOnce();
      expect(onResult.mock.calls[0]![2]()).toBe(true);
      expect(screen.getByRole("button", { name: "큐 취소" })).toBeDisabled();
      await act(async () => { adoption.resolve("adopted"); await adoption.promise; });
      expect(screen.getByRole("button", { name: "큐 취소" })).toBeEnabled();
    } finally {
      await act(async () => { pause.resolve(response); cancel.resolve(response); adoption.resolve("ignored"); });
    }
  });

  it.each(["resume", "retry"] as const)("allows only cancel while %s is still executing", async (action) => {
    const project = projectWithQueue(queue([page("page-1", action === "resume" ? "paused" : "failed", "translation")], action === "resume" ? "paused" : "failed", 0));
    const pending = deferred<ProcessingQueueActionResult>();
    const { updateProcessingQueue } = renderPanel(project);
    updateProcessingQueue.mockReturnValueOnce(pending.promise);
    try {
      fireEvent.click(screen.getByRole("button", { name: action === "resume" ? "Provider 재개" : "실패 번역 다시 실행" }));
      expect(screen.getByRole("button", { name: "큐 취소" })).toBeEnabled();
      expect(screen.getByRole("button", { name: action === "resume" ? "Provider 재개" : "실패 번역 다시 실행" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "큐 취소" }));
      expect(updateProcessingQueue).toHaveBeenLastCalledWith(expect.objectContaining({ action: "cancel", queueId: "queue-1" }));
    } finally {
      await act(async () => { pending.resolve({ project: sessionResult(project), queue: project.processing.queue }); });
    }
  });

  it.each(["queue", "unmount"] as const)("invalidates an adoption callback after %s changes without clearing a new request", async (change) => {
    const project = projectWithQueue(queue([page("page-1", "running", "translation")], "running", 0));
    const adoption = deferred<"adopted" | "ignored">();
    const onResult = vi.fn().mockReturnValue(adoption.promise);
    const onError = vi.fn();
    window.projectApi = { importTxtFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(), updateProcessingQueue: vi.fn().mockResolvedValue({ project: sessionResult(project), queue: project.processing.queue }) };
    const props = { projectSessionId: "session-1", sessionGeneration: 1, onResult, onError };
    const rendered = render(<ProcessingQueuePanel {...props} project={project} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
      await waitFor(() => expect(onResult).toHaveBeenCalledOnce());
      const isCurrent = onResult.mock.calls[0]![2];
      expect(isCurrent()).toBe(true);
      if (change === "unmount") rendered.unmount();
      else {
        const next = structuredClone(project);
        next.processing.queue!.queueId = "queue-new";
        rendered.rerender(<ProcessingQueuePanel {...props} project={next} />);
      }
      expect(isCurrent()).toBe(false);
      await act(async () => { adoption.reject(new Error("오래된 채택 실패")); await adoption.promise.catch(() => undefined); });
      expect(onError).not.toHaveBeenCalled();
      if (change === "queue") expect(screen.getByRole("button", { name: "일시정지" })).toBeEnabled();
    } finally {
      await act(async () => { adoption.resolve("ignored"); });
    }
  });

  it("adopts the actual control-failed DTO and reports its failure instead of declaring pause success", async () => {
    const project = projectWithQueue(queue([page("page-1", "running", "translation")], "running", 0));
    const onResult = vi.fn().mockResolvedValue("adopted");
    const onError = vi.fn();
    window.projectApi = { importTxtFile: vi.fn(), exportTranslations: vi.fn(), saveProject: vi.fn(), updateProcessingQueue: vi.fn().mockResolvedValue({ project: sessionResult(project), queue: project.processing.queue, control: { status: "failed", message: "일시정지 저장 실패" } }) };
    render(<ProcessingQueuePanel project={project} projectSessionId="session-1" sessionGeneration={1} onResult={onResult} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("일시정지 저장 실패", expect.objectContaining({ queueId: "queue-1" })));
    expect(onResult).toHaveBeenCalledOnce();
    expect(screen.getByText(/실행 중 ·/)).toBeInTheDocument();
  });

  it("opens fresh batch settings for unrun pages without starting a provider", () => {
    const project = projectWithQueue(queue([page("page-1", "failed", "translation"), page("page-2", "pending", "translation")], "failed", 0));
    const { updateProcessingQueue, onOpenBatchAutomation } = renderPanel(project);
    fireEvent.click(screen.getByRole("button", { name: "새 일괄 작업 설정" }));
    expect(onOpenBatchAutomation).toHaveBeenCalledOnce();
    expect(updateProcessingQueue).not.toHaveBeenCalled();
  });

  it("keeps cancel available while pause waits for the running work to settle", async () => {
    const project = projectWithQueue(queue([page("page-1", "running", "translation")], "running", 0));
    let settlePause!: (value: unknown) => void;
    const pause = new Promise((resolve) => { settlePause = resolve; });
    const { updateProcessingQueue } = renderPanel(project);
    updateProcessingQueue.mockReturnValueOnce(pause);

    try {
      fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
      expect(updateProcessingQueue).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "큐 취소" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "큐 취소" }));
      expect(updateProcessingQueue).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => { settlePause({ project: sessionResult(project), queue: project.processing.queue }); });
    }
  });

  it("discards a resolve and reject after the project session scope changes", async () => {
    let resolveFirst!: (value: ReturnType<typeof sessionResult> & { queue?: ProcessingQueueState }) => void;
    let rejectSecond!: (reason: unknown) => void;
    const firstPending = new Promise<ReturnType<typeof sessionResult> & { queue?: ProcessingQueueState }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPending = new Promise<ReturnType<typeof sessionResult> & { queue?: ProcessingQueueState }>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const updateProcessingQueue = vi.fn()
      .mockReturnValueOnce(firstPending)
      .mockReturnValueOnce(secondPending);
    const onResult = vi.fn().mockResolvedValue("adopted");
    const onError = vi.fn();
    window.projectApi = {
      importTxtFile: vi.fn(),
      exportTranslations: vi.fn(),
      saveProject: vi.fn(),
      updateProcessingQueue
    };
    const runningQueue = queue([
      page("page-1", "running", "translation", 4)
    ], "running", 0);
    const projectA = projectWithQueue(runningQueue);
    const projectB = projectWithQueue(runningQueue);
    const rendered = render(
      <ProcessingQueuePanel
        project={projectA}
        projectSessionId="session-a"
        sessionGeneration={1}
        onResult={onResult}
        onError={onError}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
    rendered.rerender(
      <ProcessingQueuePanel
        project={projectB}
        projectSessionId="session-b"
        sessionGeneration={2}
        onResult={onResult}
        onError={onError}
      />
    );
    resolveFirst({ ...sessionResult(projectA), queue: projectA.processing.queue });
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.queryByText("요청한 작업을 실행 중입니다.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
    rendered.rerender(
      <ProcessingQueuePanel
        project={projectA}
        projectSessionId="session-a"
        sessionGeneration={3}
        onResult={onResult}
        onError={onError}
      />
    );
    rejectSecond(new Error("오래된 큐 오류"));
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it("opens batch automation instead of creating an unstartable idle queue", () => {
    const project = projectWithQueue();
    const { updateProcessingQueue, onOpenBatchAutomation } = renderPanel(project);

    expect(screen.getByText("일괄 번역·식자 작업 상태")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "일괄 자동화 시작" }));
    expect(onOpenBatchAutomation).toHaveBeenCalledOnce();
    expect(updateProcessingQueue).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "페이지 큐 만들기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "큐 시작" })).not.toBeInTheDocument();
  });

  it("shows restored progress and offers pause and cancel while a page is running", async () => {
    const restored = projectWithQueue(queue([
      page("page-1", "completed", "completed"),
      page("page-2", "running", "translation", 4),
      page("page-3", "pending", "ocr", 4)
    ], "running", 1));
    const { updateProcessingQueue } = renderPanel(restored);

    expect(screen.getByText("실행 중 · 3페이지 · 한 번에 한 페이지")).toBeInTheDocument();
    expect(screen.getByText("p.2")).toBeInTheDocument();
    expect(screen.getByText("번역 초안")).toBeInTheDocument();
    expect(screen.getByText("처리 중")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
    await waitFor(() => expect(updateProcessingQueue).toHaveBeenCalledWith({
      projectSessionId: "session-1",
      queueId: "queue-1",
      action: "pause",
      reason: "사용자가 작업을 일시정지했습니다."
    }));
    fireEvent.click(screen.getByRole("button", { name: "큐 취소" }));

    await waitFor(() => {
      expect(updateProcessingQueue).toHaveBeenNthCalledWith(2, {
        projectSessionId: "session-1",
        queueId: "queue-1",
        action: "cancel",
        reason: "사용자가 작업을 취소했습니다."
      });
    });
  });

  it("explains external-provider resume and resumes only after explicit action", async () => {
    const restored = projectWithQueue(queue([
      page("page-1", "paused", "translation", 2, { requiresExternalResume: true })
    ], "paused", 0));
    const { updateProcessingQueue } = renderPanel(restored);

    expect(screen.getByText(/외부 Provider 작업은 비용이 발생할 수 있으므로/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Provider 재개" }));

    await waitFor(() => expect(updateProcessingQueue).toHaveBeenCalledWith({
      projectSessionId: "session-1",
      queueId: "queue-1",
      action: "resume"
    }));
  });

  it("labels a local paused typesetting executor separately from Provider resume", async () => {
    const restored = projectWithQueue(queue([
      page("page-1", "paused", "typesetting", 2)
    ], "paused", 0));
    const { updateProcessingQueue } = renderPanel(restored);

    expect(screen.queryByRole("button", { name: "Provider 재개" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "식자 재개" }));

    await waitFor(() => expect(updateProcessingQueue).toHaveBeenCalledWith({
      projectSessionId: "session-1",
      queueId: "queue-1",
      action: "resume"
    }));
  });

  it("exposes page errors and retries only batch-supported failed pages", async () => {
    const restored = projectWithQueue(queue([
      page("page-1", "awaiting_approval", "speaker_review", 3),
      page("page-2", "failed", "translation", 5, {
        error: {
          code: "PROVIDER_TIMEOUT",
          message: "외부 provider 응답 시간이 초과되었습니다.",
          retryable: true,
          stage: "translation"
        }
      })
    ], "failed", 0));
    const { updateProcessingQueue } = renderPanel(restored);

    const pageOne = within(screen.getByRole("listitem", { name: /페이지 1/ }));
    const pageTwo = within(screen.getByRole("listitem", { name: /페이지 2/ }));
    expect(pageOne.getByText("승인 대기")).toBeInTheDocument();
    expect(pageOne.queryByRole("button", { name: "화자 검토 승인" })).not.toBeInTheDocument();
    expect(pageTwo.getByText(/외부 provider 응답 시간이 초과되었습니다/)).toBeInTheDocument();

    fireEvent.click(pageTwo.getByRole("button", { name: "실패 번역 다시 실행" }));

    await waitFor(() => {
      expect(updateProcessingQueue).toHaveBeenCalledWith({
        projectSessionId: "session-1",
        queueId: "queue-1",
        action: "retry",
        pageImageId: "page-2",
        revision: 5
      });
    });
  });

  it("does not expose resume or retry for unsupported OCR and inpainting stages", () => {
    const pausedOcr = projectWithQueue(queue([
      page("page-1", "paused", "ocr", 2, { requiresExternalResume: true })
    ], "paused", 0));
    const rendered = renderPanel(pausedOcr);
    expect(screen.getByText(/연결된 일괄 실행기가 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Provider 재개" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "식자 재개" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "큐 취소" })).toBeInTheDocument();
    rendered.unmount();

    renderPanel(projectWithQueue(queue([
      page("page-1", "failed", "inpainting", 4, {
        error: {
          code: "INPAINT_FAILED",
          message: "인페인팅 실패",
          retryable: true,
          stage: "inpainting"
        }
      })
    ], "failed", 0)));
    expect(screen.queryByRole("button", { name: "실패 식자 다시 계산" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "실패 번역 다시 실행" })).not.toBeInTheDocument();
  });

  it("summarizes every failed page while keeping retry scoped to that page", async () => {
    const restored = projectWithQueue(queue([
      page("page-1", "completed", "completed"),
      page("page-2", "failed", "translation", 5, {
        error: {
          code: "PROVIDER_TIMEOUT",
          message: "페이지 2 번역 응답 시간이 초과되었습니다.",
          retryable: true,
          stage: "translation"
        }
      }),
      page("page-3", "failed", "typesetting", 7, {
        error: {
          code: "TYPESETTING_NO_GEOMETRY",
          message: "페이지 3 말풍선 위치 정보가 없습니다.",
          retryable: true,
          stage: "typesetting"
        }
      })
    ], "failed", 1));
    const { updateProcessingQueue } = renderPanel(restored);

    expect(screen.getByText(/실패 페이지 2개를 확인하고 재시도할 수 있습니다/)).toBeInTheDocument();
    expect(screen.getByText("페이지 2 번역 응답 시간이 초과되었습니다.")).toBeInTheDocument();
    expect(screen.getByText("페이지 3 말풍선 위치 정보가 없습니다.")).toBeInTheDocument();

    const pageThree = within(screen.getByRole("listitem", { name: /페이지 3/ }));
    fireEvent.click(pageThree.getByRole("button", { name: "실패 식자 다시 계산" }));

    await waitFor(() => expect(updateProcessingQueue).toHaveBeenCalledWith({
      projectSessionId: "session-1",
      queueId: "queue-1",
      action: "retry",
      pageImageId: "page-3",
      revision: 7
    }));
  });

  it("does not expose a status-only resume action for failed or idle queues", () => {
    const failed = projectWithQueue(queue([
      page("page-1", "failed", "translation", 5, {
        error: {
          code: "BATCH_TRANSLATION_FAILED",
          message: "translation failed",
          retryable: true,
          stage: "translation"
        }
      })
    ], "failed", 0));
    const rendered = renderPanel(failed);

    expect(screen.queryByRole("button", { name: "재개" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Provider 재개" })).not.toBeInTheDocument();
    rendered.unmount();

    renderPanel(projectWithQueue(queue([
      page("page-1", "pending", "ocr", 1)
    ], "idle", 0)));
    expect(screen.queryByRole("button", { name: "큐 시작" })).not.toBeInTheDocument();
    expect(screen.getByText(/실행할 수 있는 번역\/식자 작업이 아닙니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "큐 취소" })).toBeInTheDocument();
  });

  it("shows persisted secondary failures without replacing the primary Provider error", () => {
    const restored = projectWithQueue(queue([
      page("page-1", "failed", "translation", 9, {
        error: {
          code: "BATCH_TRANSLATION_FAILED",
          message: "Provider quota exceeded",
          retryable: true,
          stage: "translation",
          details: {
            additionalFailureCount: 1,
            additionalFailure1Code: "BATCH_STALE_CONTEXT_DISCARDED",
            additionalFailure1Message: "실행 중 식자 문맥이 변경되어 결과가 폐기되었습니다.",
            additionalFailure1Stage: "typesetting"
          }
        }
      })
    ], "failed", 0));

    renderPanel(restored);

    expect(screen.getByText("Provider quota exceeded")).toBeInTheDocument();
    expect(screen.getByText("추가 확인: 실행 중 식자 문맥이 변경되어 결과가 폐기되었습니다."))
      .toBeInTheDocument();
  });
});
