import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchAutomationModal } from "../../src/renderer/components/BatchAutomationModal.js";
import type { TranslationProject, TranslationProjectV2 } from "../../src/shared/projectTypes.js";
import { normalizeProject } from "../../src/shared/projectValidation.js";
import type { BatchProgressEvent } from "../../src/shared/processingQueue.js";
import type { BatchAutomationModalProps } from "../../src/renderer/components/BatchAutomationModal.js";

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type BatchResult = Awaited<ReturnType<NonNullable<Window["projectApi"]["runBatchJob"]>>>;

describe("BatchAutomationModal", () => {
  const mockProject: TranslationProjectV2 = {
    schemaVersion: 2,
    metadata: { id: "p1", title: "테스트 만화", secret: false, createdAt: "", updatedAt: "" },
    settings: { defaultSourceLanguage: "ja" },
    processing: { pages: [], runs: [], assets: [] },
    pageImages: [],
    dialogueLines: [
      {
        id: "l1",
        origin: { kind: "manual" },
        order: 1,
        pageNumber: 1,
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "こんにちは",
        userTranslation: "안녕하세요",
        parseConfidence: 1,
        parseWarnings: []
      }
    ],
    characters: [],
    dictionaryTerms: []
  };

  function projectWithFailedQueue(message: string): TranslationProject {
    return {
      ...mockProject,
      pageImages: [{
        id: "page-image-2",
        pageNumber: 2,
        storedRelativePath: "images/page-002.png",
        originalFileName: "page-002.png",
        sha256: "b".repeat(64),
        byteSize: 1,
        mimeType: "image/png",
        copiedAt: "2026-08-28T00:00:00.000Z"
      }],
      processing: {
        pages: [],
        runs: [],
        assets: [],
        queue: {
          schemaVersion: 1,
          queueId: "queue-restore-1",
          projectSessionId: "session-restore-1",
          status: "failed",
          pageImageIds: ["page-image-2"],
          pages: [{
            pageImageId: "page-image-2",
            status: "failed",
            stage: "translation",
            revision: 4,
            updatedAt: "2026-08-28T00:00:00.000Z",
            error: {
              code: "PROVIDER_TIMEOUT",
              message,
              retryable: true,
              stage: "translation"
            }
          }],
          currentPageIndex: 0,
          lastUpdatedAt: "2026-08-28T00:00:00.000Z"
        }
      }
    } as unknown as TranslationProject;
  }

  it("routes a restored paused queue to its controls before allowing a new batch", () => {
    const project = normalizeProject(projectWithFailedQueue(""));
    project.processing.queue!.status = "paused";
    project.processing.queue!.pages[0]!.status = "paused";
    const runBatchJob = vi.fn();
    const openQueue = vi.fn();
    window.projectApi = { runBatchJob } as never;
    render(<BatchAutomationModal project={project} pageCount={1} isOpen onClose={vi.fn()} onOpenProcessingQueue={openQueue} onApplyBatchProject={vi.fn()} />);
    const start = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    expect(start).toBeDisabled();
    expect(screen.getByText(/작업 큐에서 재개하거나 취소한 뒤/)).toBeVisible();
    fireEvent.click(start);
    expect(runBatchJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "작업 큐에서 현재 페이지·단계 재개" }));
    expect(openQueue).toHaveBeenCalledOnce();
  });

  it("uses only matching actual queue metadata for pause and preserves cancel text over progress and late pause errors", async () => {
    const run = gate<BatchResult>();
    const pause = gate<never>();
    let listener!: (event: BatchProgressEvent) => void;
    const runBatchJob = vi.fn().mockReturnValue(run.promise);
    const updateProcessingQueue = vi.fn().mockReturnValue(pause.promise);
    const onRegisterRun = vi.fn().mockReturnValue(true);
    const onBindRunQueue = vi.fn().mockReturnValue(true);
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob, updateProcessingQueue, cancelBatchJob: vi.fn().mockResolvedValue({ canceled: true }), onBatchProgress: vi.fn((callback) => { listener = callback; return vi.fn(); }) };
    render(<BatchAutomationModal project={mockProject} projectSessionId="session-actual" sessionGeneration={4} pageCount={1} isOpen onClose={vi.fn()} onRegisterRun={onRegisterRun} onBindRunQueue={onBindRunQueue} onApplyBatchProject={onApplyBatchProject} />);
    try {
      const start = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
      act(() => { start.click(); start.click(); });
      expect(runBatchJob).toHaveBeenCalledOnce();
      expect(onRegisterRun.mock.invocationCallOrder[0]).toBeLessThan(runBatchJob.mock.invocationCallOrder[0]!);
      const requestId = runBatchJob.mock.calls[0]![0].requestId;
      expect(screen.getByRole("button", { name: "일시정지" })).toBeDisabled();
      const progress = { ...completedBatchResult(mockProject).progress, stage: "translate" as const, currentMessage: "일반 번역 진행", percent: 10 };
      act(() => {
        listener({ requestId: "old-request", projectSessionId: "session-actual", queueId: "wrong", progress });
        listener({ requestId, projectSessionId: "other-session", queueId: "wrong", progress });
        listener({ requestId, queueId: "missing-session", progress });
      });
      expect(onBindRunQueue).not.toHaveBeenCalled();
      act(() => { listener({ requestId, projectSessionId: "session-actual", queueId: "actual-not-derived", progress }); });
      expect(screen.getByRole("button", { name: "일시정지" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
      await waitFor(() => expect(updateProcessingQueue).toHaveBeenCalledWith(expect.objectContaining({ action: "pause", projectSessionId: "session-actual", queueId: "actual-not-derived" })));
      expect(screen.getByRole("button", { name: "일괄 처리 중단" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "일괄 처리 중단" }));
      await screen.findByText("취소를 요청했습니다. 진행 중인 호출과 저장 결과를 확인하고 있습니다.");
      act(() => { listener({ requestId, projectSessionId: "session-actual", queueId: "actual-not-derived", progress }); });
      await act(async () => { pause.reject(new Error("늦은 pause 오류")); await pause.promise.catch(() => undefined); });
      expect(screen.getByRole("button", { name: "취소 요청 중" })).toBeDisabled();
      expect(screen.getByText("취소를 요청했습니다. 진행 중인 호출과 저장 결과를 확인하고 있습니다.")).toBeInTheDocument();
      expect(screen.queryByText("일반 번역 진행")).not.toBeInTheDocument();
      expect(screen.queryByText(/늦은 pause 오류/)).not.toBeInTheDocument();
      expect(onApplyBatchProject).not.toHaveBeenCalled();
    } finally {
      await act(async () => { pause.reject(new Error("cleanup")); run.resolve({ ...completedBatchResult(mockProject), progress: { ...completedBatchResult(mockProject).progress, stage: "canceled" } }); });
    }
  });

  it.each(["adopted", "ignored"] as const)("awaits final adoption (%s) and ignores progress after the run response", async (decision) => {
    const adoption = gate<"adopted" | "ignored">();
    const onApplyBatchProject = vi.fn().mockReturnValue(adoption.promise);
    const onFinishRun = vi.fn();
    let listener!: (event: BatchProgressEvent) => void;
    const runBatchJob = vi.fn().mockResolvedValue(completedBatchResult(mockProject));
    (window as any).projectApi = { runBatchJob, onBatchProgress: vi.fn((callback) => { listener = callback; return vi.fn(); }) };
    render(<BatchAutomationModal project={mockProject} pageCount={1} isOpen onClose={vi.fn()} onFinishRun={onFinishRun} onApplyBatchProject={onApplyBatchProject} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
      await waitFor(() => expect(onApplyBatchProject).toHaveBeenCalledOnce());
      expect(screen.queryByRole("button", { name: "완료 및 닫기" })).not.toBeInTheDocument();
      expect(onFinishRun).not.toHaveBeenCalled();
      act(() => { listener({ requestId: runBatchJob.mock.calls[0]![0].requestId, progress: { ...completedBatchResult(mockProject).progress, currentMessage: "늦은 완료 progress" } }); });
      expect(screen.queryByText("늦은 완료 progress")).not.toBeInTheDocument();
      await act(async () => { adoption.resolve(decision); await adoption.promise; });
      if (decision === "adopted") expect(screen.getByRole("button", { name: "완료 및 닫기" })).toBeInTheDocument();
      else {
        expect(screen.getByText("최신 변경을 유지했습니다.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "완료 및 닫기" })).not.toBeInTheDocument();
      }
      expect(onFinishRun).toHaveBeenCalledOnce();
    } finally {
      await act(async () => { adoption.resolve("ignored"); });
    }
  });

  it.each(["close", "unmount", "session"] as const)("invalidates App's adoption guard on %s while adoption is pending", async (change) => {
    const adoption = gate<"adopted" | "ignored">();
    const onApplyBatchProject = vi.fn<BatchAutomationModalProps["onApplyBatchProject"]>().mockReturnValue(adoption.promise);
    (window as any).projectApi = { runBatchJob: vi.fn().mockResolvedValue(completedBatchResult(mockProject)), cancelBatchJob: vi.fn().mockResolvedValue({ canceled: false }) };
    const props = { project: mockProject, pageCount: 1, isOpen: true, onClose: vi.fn(), onApplyBatchProject };
    const rendered = render(<BatchAutomationModal {...props} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
      await waitFor(() => expect(onApplyBatchProject).toHaveBeenCalledOnce());
      const isCurrent = onApplyBatchProject.mock.calls[0]![3];
      expect(isCurrent()).toBe(true);
      if (change === "unmount") rendered.unmount();
      else rendered.rerender(<BatchAutomationModal {...props} isOpen={change !== "close"} sessionGeneration={change === "session" ? 1 : 0} />);
      expect(isCurrent()).toBe(false);
      await act(async () => { adoption.resolve("adopted"); await adoption.promise; });
      expect(screen.queryByRole("button", { name: "완료 및 닫기" })).not.toBeInTheDocument();
    } finally { await act(async () => { adoption.resolve("ignored"); }); }
  });

  it("keeps a newly registered run alive when the abandoned run finishes later", async () => {
    const oldRun = gate<BatchResult>();
    const newRun = gate<BatchResult>();
    const runBatchJob = vi.fn().mockReturnValueOnce(oldRun.promise).mockReturnValueOnce(newRun.promise);
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    const onRegisterRun = vi.fn().mockReturnValue(true);
    const onFinishRun = vi.fn();
    (window as any).projectApi = { runBatchJob, cancelBatchJob: vi.fn().mockResolvedValue({ canceled: true }) };
    const props = { project: mockProject, pageCount: 1, onClose: vi.fn(), onApplyBatchProject, onRegisterRun, onFinishRun };
    const rendered = render(<BatchAutomationModal {...props} isOpen />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
      rendered.rerender(<BatchAutomationModal {...props} isOpen={false} />);
      rendered.rerender(<BatchAutomationModal {...props} isOpen />);
      fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
      expect(onRegisterRun).toHaveBeenCalledTimes(2);
      const newScope = onRegisterRun.mock.calls[1]![0];
      await act(async () => { oldRun.resolve(completedBatchResult(mockProject)); await oldRun.promise; });
      expect(onApplyBatchProject).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "일괄 처리 중단" })).toBeEnabled();
      expect(onFinishRun).not.toHaveBeenCalledWith(newScope);
      await act(async () => { newRun.resolve(completedBatchResult(mockProject)); await newRun.promise; });
      expect(onApplyBatchProject).toHaveBeenCalledOnce();
      expect(onApplyBatchProject.mock.calls[0]![2]).toEqual(newScope);
      expect(onFinishRun).toHaveBeenLastCalledWith(newScope);
      expect(screen.getByRole("button", { name: "완료 및 닫기" })).toBeInTheDocument();
    } finally { await act(async () => { oldRun.resolve(completedBatchResult(mockProject)); newRun.resolve(completedBatchResult(mockProject)); }); }
  });

  it("binds a final DTO before metadata and keeps the run registered until its pause adoption finishes", async () => {
    const project = normalizeProject(projectWithFailedQueue(""));
    project.processing.queue!.projectSessionId = "session-actual";
    project.processing.queue!.queueId = "actual-queue";
    project.processing.queue!.status = "paused";
    project.processing.queue!.pages[0]!.status = "paused";
    const run = gate<BatchResult>();
    const pauseAdoption = gate<"adopted" | "ignored">();
    const onApplyBatchProject = vi.fn<BatchAutomationModalProps["onApplyBatchProject"]>().mockReturnValueOnce(pauseAdoption.promise).mockResolvedValue("adopted");
    const onFinishRun = vi.fn();
    const onBindRunQueue = vi.fn().mockReturnValue(true);
    let listener!: (event: BatchProgressEvent) => void;
    const runBatchJob = vi.fn().mockReturnValue(run.promise);
    const dto = { project, revision: 2, pendingPageImages: [], dirty: true, status: "active" as const };
    (window as any).projectApi = { runBatchJob, updateProcessingQueue: vi.fn().mockResolvedValue({ project: dto, queue: project.processing.queue, control: { status: "settled" } }), onBatchProgress: vi.fn((callback) => { listener = callback; return vi.fn(); }) };
    render(<BatchAutomationModal project={mockProject} projectSessionId="session-actual" pageCount={1} isOpen onClose={vi.fn()} onApplyBatchProject={onApplyBatchProject} onBindRunQueue={onBindRunQueue} onFinishRun={onFinishRun} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
      const requestId = runBatchJob.mock.calls[0]![0].requestId;
      act(() => { listener({ requestId, projectSessionId: "session-actual", queueId: "actual-queue", progress: { ...completedBatchResult(mockProject).progress, stage: "translate" } }); });
      fireEvent.click(screen.getByRole("button", { name: "일시정지" }));
      await waitFor(() => expect(onApplyBatchProject).toHaveBeenCalledOnce());
      await act(async () => { run.resolve({ ...completedBatchResult(project), progress: { ...completedBatchResult(project).progress, stage: "partial" }, sessionChange: { status: "applied", revision: 3, project: { ...dto, revision: 3 } } }); await run.promise; });
      await waitFor(() => expect(onApplyBatchProject).toHaveBeenCalledTimes(2));
      expect(onFinishRun).not.toHaveBeenCalled();
      expect(onApplyBatchProject.mock.calls[0]![3]()).toBe(true);
      await act(async () => { pauseAdoption.resolve("ignored"); await pauseAdoption.promise; });
      expect(onFinishRun).toHaveBeenCalledOnce();
      expect(onBindRunQueue).toHaveBeenCalledWith(expect.objectContaining({ requestId }), "actual-queue", expect.any(Function));
    } finally {
      await act(async () => { pauseAdoption.resolve("ignored"); run.resolve(completedBatchResult(project)); });
    }
  });

  it.each([
    { arrival: "before", refusal: "binding" }, { arrival: "after", refusal: "binding" },
    { arrival: "before", refusal: "adoption" }, { arrival: "after", refusal: "adoption" }
  ] as const)("shows saved pause with props $arrival the final $refusal refusal", async ({ arrival, refusal }) => {
    const pausedProject = normalizeProject(projectWithFailedQueue(""));
    pausedProject.processing.queue!.queueId = "actual-queue";
    pausedProject.processing.queue!.projectSessionId = "session-actual";
    pausedProject.processing.queue!.status = "paused";
    pausedProject.processing.queue!.pages[0]!.status = "paused";
    const run = gate<BatchResult>();
    const onApplyBatchProject = vi.fn<BatchAutomationModalProps["onApplyBatchProject"]>().mockResolvedValue("ignored");
    const onBindRunQueue = vi.fn().mockReturnValueOnce(true).mockReturnValue(refusal !== "binding");
    let listener!: (event: BatchProgressEvent) => void;
    const runBatchJob = vi.fn().mockReturnValue(run.promise);
    (window as any).projectApi = { runBatchJob, onBatchProgress: vi.fn((callback) => { listener = callback; return vi.fn(); }) };
    const props = { projectSessionId: "session-actual", pageCount: 1, isOpen: true, onClose: vi.fn(), onApplyBatchProject, onBindRunQueue };
    const view = render(<BatchAutomationModal {...props} project={mockProject} />);
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    const requestId = runBatchJob.mock.calls[0]![0].requestId;
    act(() => { listener({ requestId, projectSessionId: "session-actual", queueId: "actual-queue", progress: { ...completedBatchResult(mockProject).progress, stage: "translate" } }); });
    if (arrival === "before") view.rerender(<BatchAutomationModal {...props} project={pausedProject} />);
    await act(async () => { run.resolve({ ...completedBatchResult(pausedProject), progress: { ...completedBatchResult(pausedProject).progress, stage: "partial" }, sessionChange: { status: "applied", revision: 3, project: { project: pausedProject, revision: 3, pendingPageImages: [], dirty: true, status: "active" } } }); await run.promise; });
    if (arrival === "after") view.rerender(<BatchAutomationModal {...props} project={pausedProject} />);
    expect(await screen.findByRole("button", { name: "일시정지 확인 및 닫기" })).toBeInTheDocument();
    expect(screen.getByText("일시정지됨")).toBeInTheDocument();
    expect(onApplyBatchProject).toHaveBeenCalledTimes(refusal === "binding" ? 0 : 1);
    expect(screen.queryByRole("button", { name: "⚡ 일괄 처리 시작" })).not.toBeInTheDocument();
    if (refusal === "binding" || arrival === "after") {
      const otherQueueProject = { ...pausedProject, processing: { ...pausedProject.processing, queue: { ...pausedProject.processing.queue!, queueId: "another-queue" } } };
      view.rerender(<BatchAutomationModal {...props} project={otherQueueProject} />);
      expect(screen.getByText("최신 변경을 유지했습니다.")).toBeInTheDocument();
      expect(screen.queryByText("일시정지됨")).not.toBeInTheDocument();
    }
  });

  it("renders when isOpen is true and shows step checkboxes", () => {
    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={5}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    expect(screen.getByRole("heading", { name: "전 페이지 일괄 자동화" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /전 페이지 일괄 자동화/ })).toHaveClass("stitch-dialog--batch");
    expect(screen.getByLabelText("말풍선 OCR (작업대 개별)")).toBeInTheDocument();
    expect(screen.getByLabelText("AI 문맥 번역")).toBeInTheDocument();
    expect(screen.getByLabelText("배경 인페인팅 (작업대 개별)")).toBeInTheDocument();
    expect(screen.getByLabelText("지능형 자동 식자")).toBeInTheDocument();
    expect(screen.getByText("OCR 대사 확인 · AI 번역은 검토용 제안")).toBeInTheDocument();
    expect(screen.getByText("사용자가 확정한 번역에만 적용")).toBeInTheDocument();
  });

  it("does not start batch processing when translation and typesetting are both off", async () => {
    const runBatchJob = vi.fn();
    (window as any).projectApi = { runBatchJob };
    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    fireEvent.click(screen.getByLabelText("AI 문맥 번역"));
    fireEvent.click(screen.getByLabelText("지능형 자동 식자"));
    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    expect(startBtn).toBeDisabled();
    expect(screen.getByText(/번역 또는 식자 중 적어도 하나/)).toBeInTheDocument();
    fireEvent.click(startBtn);
    expect(runBatchJob).not.toHaveBeenCalled();
  });

  it("starts a translation-only batch when typesetting is turned off", async () => {
    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "completed",
        currentPageIndex: 0,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 완료",
        pageStatuses: {},
        errors: [],
        isCanceled: false
      },
      updatedProject: mockProject
    });
    (window as any).projectApi = { runBatchJob };
    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    fireEvent.click(screen.getByLabelText("지능형 자동 식자"));
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    await waitFor(() => expect(runBatchJob).toHaveBeenCalledOnce());
    expect(runBatchJob.mock.calls[0]?.[0]?.config).toMatchObject({
      runTranslate: true,
      runTypeset: false
    });
  });

  it("starts a typesetting-only batch when translation is turned off", async () => {
    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "completed",
        currentPageIndex: 0,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 완료",
        pageStatuses: {},
        errors: [],
        isCanceled: false
      },
      updatedProject: mockProject
    });
    (window as any).projectApi = { runBatchJob };
    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    fireEvent.click(screen.getByLabelText("AI 문맥 번역"));
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    await waitFor(() => expect(runBatchJob).toHaveBeenCalledOnce());
    expect(runBatchJob.mock.calls[0]?.[0]?.config).toMatchObject({
      runTranslate: false,
      runTypeset: true
    });
  });

  it("keeps OCR and inpainting labeled as per-page workbench actions", () => {
    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={5}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    expect(screen.getByLabelText("말풍선 OCR (작업대 개별)")).toBeDisabled();
    expect(screen.getByLabelText("배경 인페인팅 (작업대 개별)")).toBeDisabled();
    expect(screen.getByText("OCR·인페인팅은 페이지별 실행")).toBeInTheDocument();
  });

  it("starts batch processing and applies updated project upon completion", async () => {
    const handleApply = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = {
      runBatchJob: vi.fn().mockResolvedValue({
        progress: {
          stage: "completed",
          currentPageIndex: 0,
          totalPages: 1,
          percent: 100,
          currentMessage: "일괄 자동화 완료",
          pageStatuses: {},
          errors: [],
          isCanceled: false
        },
        updatedProject: mockProject
      })
    };
    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={handleApply}
      />
    );

    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    fireEvent.click(startBtn);

    expect(await screen.findByText(/일괄 자동화 완료|완료되었습니다/)).toBeInTheDocument();
    expect(handleApply).toHaveBeenCalled();
  });

  it("closes on Escape key press when not running", () => {
    const handleClose = vi.fn();
    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={handleClose}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleClose).toHaveBeenCalled();
  });

  it("does not run a renderer Provider fallback when the Main Batch API is unavailable", async () => {
    const executeTranslation = vi.fn();
    (window as any).projectApi = { executeTranslation };

    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));

    expect(await screen.findByText("이 환경에서는 Main Batch 실행 기능을 사용할 수 없습니다."))
      .toBeInTheDocument();
    expect(executeTranslation).not.toHaveBeenCalled();
  });

  it("safely handles toggling isOpen from false to true without violating hook rules", () => {
    const { rerender } = render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={false}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("executes translation when runTranslate is enabled", async () => {
    const untranslatedProject: TranslationProject = {
      ...mockProject,
      dialogueLines: [
        {
          id: "l_untrans",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "おはようございます",
          userTranslation: undefined,
          aiTranslation: undefined,
          polygon: [
            { x: 0.1, y: 0.1 },
            { x: 0.5, y: 0.1 },
            { x: 0.5, y: 0.3 },
            { x: 0.1, y: 0.3 }
          ],
          parseConfidence: 1,
          parseWarnings: []
        }
      ]
    };

    const mainUpdatedProject = {
      ...untranslatedProject,
      dialogueLines: [{
        ...untranslatedProject.dialogueLines[0]!,
        aiTranslation: "좋은 아침입니다"
      }]
    };
    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "completed",
        currentPageIndex: 0,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 완료: 1개 대사 번역 완료",
        pageStatuses: {},
        errors: [],
        isCanceled: false
      },
      updatedProject: mainUpdatedProject
    });
    (window as any).projectApi = { runBatchJob };

    const handleApply = vi.fn().mockResolvedValue("adopted");
    render(
      <BatchAutomationModal
        project={untranslatedProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={handleApply}
      />
    );

    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    fireEvent.click(startBtn);

    expect(await screen.findByText(/일괄 자동화 완료|완료되었습니다/)).toBeInTheDocument();
    expect(runBatchJob).toHaveBeenCalled();
    expect(handleApply).toHaveBeenCalledOnce();
    const appliedProject = handleApply.mock.calls[0]?.[0] as TranslationProject;
    expect(appliedProject.dialogueLines[0]).toMatchObject({
      aiTranslation: "좋은 아침입니다",
      userTranslation: undefined
    });
    expect(appliedProject.dialogueLines[0]?.lineStatus).toBeUndefined();
    expect(appliedProject.dialogueLines[0]?.typesetting).toBeUndefined();
    expect(screen.queryByText(/식자 정렬 완료/)).not.toBeInTheDocument();
  });

  it("reports partial success status and message when some lines fail to translate", async () => {
    const partialProject: TranslationProject = {
      ...mockProject,
      dialogueLines: [
        {
          id: "l_ok",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          userTranslation: undefined,
          aiTranslation: undefined,
          parseConfidence: 1,
          parseWarnings: []
        },
        {
          id: "l_fail",
          order: 2,
          pageNumber: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "さようなら",
          userTranslation: undefined,
          aiTranslation: undefined,
          parseConfidence: 1,
          parseWarnings: []
        }
      ]
    };

    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "partial",
        currentPageIndex: 0,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 부분 완료: 1개 성공, 1개 실패",
        pageStatuses: {},
        errors: [{ pageNumber: 1, message: "Translation API rate limit" }],
        isCanceled: false
      },
      updatedProject: {
        ...partialProject,
        dialogueLines: [
          { ...partialProject.dialogueLines[0]!, aiTranslation: "안녕하세요" },
          partialProject.dialogueLines[1]!
        ]
      }
    });
    (window as any).projectApi = { runBatchJob };

    const handleApply = vi.fn().mockResolvedValue("adopted");
    render(
      <BatchAutomationModal
        project={partialProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={handleApply}
      />
    );

    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    fireEvent.click(startBtn);

    expect(await screen.findByText(/일괄 자동화 부분 완료: 1개 성공, 1개 실패/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "부분 반영 및 닫기" })).toBeInTheDocument();
    expect(handleApply).toHaveBeenCalled();
  });

  it("reports failed status when all lines fail to translate", async () => {
    const failedProject: TranslationProject = {
      ...mockProject,
      dialogueLines: [
        {
          id: "l_fail_only",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          userTranslation: undefined,
          aiTranslation: undefined,
          parseConfidence: 1,
          parseWarnings: []
        }
      ]
    };

    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "failed",
        currentPageIndex: 0,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 실패: 전체 1개 대사 번역 실패",
        pageStatuses: {},
        errors: [{ pageNumber: 1, message: "Server offline" }],
        isCanceled: false
      },
      updatedProject: failedProject
    });
    (window as any).projectApi = { runBatchJob };

    const handleApply = vi.fn().mockResolvedValue("adopted");
    render(
      <BatchAutomationModal
        project={failedProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={handleApply}
      />
    );

    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    fireEvent.click(startBtn);

    expect(await screen.findByText(/일괄 자동화 실패: 전체 1개 대사 번역 실패/)).toBeInTheDocument();
    expect(handleApply).toHaveBeenCalledWith(
      failedProject,
      undefined,
      expect.objectContaining({ projectSessionId: null, sessionGeneration: 0 }),
      expect.any(Function)
    );
  });

  it("handles a missing Main Batch API gracefully", async () => {
    const untranslatedProject: TranslationProject = {
      ...mockProject,
      dialogueLines: [
        {
          id: "l_missing_api",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          userTranslation: undefined,
          aiTranslation: undefined,
          parseConfidence: 1,
          parseWarnings: []
        }
      ]
    };

    delete (window as unknown as { projectApi?: { executeTranslation?: unknown } }).projectApi;

    const handleApply = vi.fn().mockResolvedValue("adopted");
    render(
      <BatchAutomationModal
        project={untranslatedProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={handleApply}
      />
    );

    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    fireEvent.click(startBtn);

    expect(await screen.findByText("이 환경에서는 Main Batch 실행 기능을 사용할 수 없습니다."))
      .toBeInTheDocument();
    expect(handleApply).not.toHaveBeenCalled();
  });

  it("delegates execution to window.projectApi.runBatchJob when available", async () => {
    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "completed",
        percent: 100,
        currentMessage: "일괄 자동화 완료: 1개 대사 번역 완료",
        pageStatuses: {},
        isCanceled: false
      },
      updatedProject: {
        ...mockProject,
        dialogueLines: [
          {
            ...mockProject.dialogueLines[0],
            aiTranslation: "메인에서 번역됨"
          }
        ]
      }
    });

    (window as any).projectApi = {
      runBatchJob
    };

    const handleApply = vi.fn().mockResolvedValue("adopted");
    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={handleApply}
      />
    );

    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    fireEvent.click(startBtn);

    expect(await screen.findByText(/일괄 자동화 완료/)).toBeInTheDocument();
    expect(runBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        project: mockProject,
        pageCount: 1,
        requestId: expect.stringMatching(/^batch-job-/)
      })
    );
    expect(handleApply).toHaveBeenCalledWith(
      expect.objectContaining({
        dialogueLines: expect.arrayContaining([
          expect.objectContaining({ aiTranslation: "메인에서 번역됨" })
        ])
      }),
      undefined,
      expect.objectContaining({ projectSessionId: null, sessionGeneration: 0 }),
      expect.any(Function)
    );
  });

  it("omits project in runBatchJob and passes sessionChange to onApplyBatchProject when projectSessionId is provided", async () => {
    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "completed",
        percent: 100,
        currentMessage: "일괄 자동화 완료: 메인 세션 반영",
        errors: [],
        pageStatuses: {}
      },
      updatedProject: mockProject,
      sessionChange: {
        status: "applied",
        revision: 2,
        project: { revision: 2, project: normalizeProject(mockProject), pendingPageImages: [], dirty: true, status: "active" }
      }
    });

    (window as any).projectApi = {
      runBatchJob
    };

    const handleApply = vi.fn().mockResolvedValue("adopted");
    render(
      <BatchAutomationModal
        project={mockProject}
        projectSessionId="session-123"
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={handleApply}
      />
    );

    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    fireEvent.click(startBtn);

    expect(await screen.findByText(/일괄 자동화 완료/)).toBeInTheDocument();
    expect(runBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        project: undefined,
        projectSessionId: "session-123",
        pageCount: 1,
        requestId: expect.stringMatching(/^batch-job-/)
      })
    );
    expect(handleApply).toHaveBeenCalledWith(
      mockProject,
      expect.objectContaining({ status: "applied", revision: 2 }),
      expect.objectContaining({ projectSessionId: "session-123", sessionGeneration: 0 }),
      expect.any(Function)
    );
  });

  it("shows page-scoped Main progress errors after a partial batch result", async () => {
    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "partial",
        currentPageIndex: 2,
        totalPages: 3,
        percent: 100,
        currentMessage: "일괄 자동화 부분 완료: 2개 적용, 1개 번역 실패",
        pageStatuses: {
          1: { pageNumber: 1, ocrDone: false, translatedCount: 1, inpaintingDone: false, typesettingDone: true },
          2: { pageNumber: 2, ocrDone: false, translatedCount: 0, inpaintingDone: false, typesettingDone: false, error: "Provider 오류" },
          3: { pageNumber: 3, ocrDone: false, translatedCount: 1, inpaintingDone: false, typesettingDone: true }
        },
        errors: [{ pageNumber: 2, message: "페이지 2 번역 Provider 응답 시간이 초과되었습니다." }],
        isCanceled: false
      },
      updatedProject: mockProject
    });
    (window as any).projectApi = { runBatchJob };

    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={3}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    // Act: let Main return a partial result.
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));

    // Assert: the compact page/error pair is visible instead of only the aggregate message.
    const errorSummary = await screen.findByRole("alert", { name: "일괄 처리 오류 요약" });
    expect(within(errorSummary).getByText("페이지 2 번역 Provider 응답 시간이 초과되었습니다.")).toBeInTheDocument();
    expect(within(errorSummary).getByText("p.2")).toBeInTheDocument();
  });

  it("shows page errors restored from the saved processing queue", () => {
    const queuedProject = projectWithFailedQueue("저장된 큐: 페이지 2 번역을 다시 시도할 수 있습니다.");

    render(
      <BatchAutomationModal
        project={queuedProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    expect(screen.getByText("저장된 큐: 페이지 2 번역을 다시 시도할 수 있습니다.")).toBeInTheDocument();
  });

  it("offers a direct action to inspect failed pages in the processing queue", async () => {
    const queuedProject = projectWithFailedQueue("페이지 2 번역 실패");
    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "partial",
        currentPageIndex: 1,
        totalPages: 2,
        percent: 100,
        currentMessage: "일괄 자동화 부분 완료: 1개 적용, 1개 실패",
        pageStatuses: {},
        errors: [{ pageNumber: 2, message: "페이지 2 번역 실패" }],
        isCanceled: false
      },
      updatedProject: queuedProject
    });
    const onOpenProcessingQueue = vi.fn();
    (window as any).projectApi = { runBatchJob };

    render(
      <BatchAutomationModal
        project={queuedProject}
        pageCount={2}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
        onOpenProcessingQueue={onOpenProcessingQueue}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    await screen.findByRole("alert", { name: "일괄 처리 오류 요약" });

    fireEvent.click(screen.getByRole("button", { name: "실패 페이지를 작업 큐에서 확인" }));
    expect(onOpenProcessingQueue).toHaveBeenCalledOnce();
  });

  it("applies a failed Main result so its persisted queue remains available for retry", async () => {
    const failedProject = projectWithFailedQueue("페이지 2 전체 번역 실패");
    const runBatchJob = vi.fn().mockResolvedValue({
      progress: {
        stage: "failed",
        currentPageIndex: 0,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 실패: 전체 번역 실패",
        pageStatuses: {},
        errors: [{ pageNumber: 2, message: "페이지 2 전체 번역 실패" }],
        isCanceled: false
      },
      updatedProject: failedProject
    });
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob };

    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={onApplyBatchProject}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));

    await screen.findByText("페이지 2 전체 번역 실패");
    expect(onApplyBatchProject).toHaveBeenCalledWith(
      failedProject,
      undefined,
      expect.objectContaining({ projectSessionId: null, sessionGeneration: 0 }),
      expect.any(Function)
    );
  });

  it("calls window.projectApi.cancelBatchJob when canceled during runBatchJob", async () => {
    let resolveRun!: (result: unknown) => void;
    const runBatchJob = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveRun = resolve;
    }));
    const cancelBatchJob = vi.fn().mockImplementation(async () => {
      resolveRun({
        progress: {
          stage: "canceled",
          currentPageIndex: 0,
          totalPages: 1,
          percent: 35,
          currentMessage: "실제 Batch 작업은 취소됐지만 취소 상태를 프로젝트에 저장하지 못했습니다.",
          pageStatuses: {},
          errors: [{ message: "저장된 작업 큐가 계속 실행 중으로 보일 수 있습니다." }],
          isCanceled: true
        },
        updatedProject: mockProject
      });
      return { canceled: true };
    });

    (window as any).projectApi = {
      runBatchJob,
      cancelBatchJob
    };

    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={vi.fn().mockResolvedValue("adopted")}
      />
    );

    const startBtn = screen.getByRole("button", { name: "⚡ 일괄 처리 시작" });
    fireEvent.click(startBtn);

    const cancelBtn = await screen.findByRole("button", { name: "일괄 처리 중단" });
    fireEvent.click(cancelBtn);

    expect(cancelBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^batch-job-/)
      })
    );
    expect(await screen.findByText(/취소 상태를 프로젝트에 저장하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/저장된 작업 큐가 계속 실행 중/)).toBeInTheDocument();
  });

  it("leaves cancel-requested state when cancelBatchJob rejects and then shows the runBatchJob error", async () => {
    let resolveRun!: (result: unknown) => void;
    let rejectRun!: (error: unknown) => void;
    const runBatchJob = vi.fn().mockImplementation(() => new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    }));
    const cancelBatchJob = vi.fn().mockRejectedValue(new Error("batch cancel IPC failed"));
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob, cancelBatchJob };

    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={onApplyBatchProject}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    fireEvent.click(await screen.findByRole("button", { name: "일괄 처리 중단" }));

    expect(await screen.findByText("취소 접수를 확인하지 못했습니다. 실행 결과를 기다립니다.")).toBeInTheDocument();
    expect(cancelBatchJob).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "취소 요청 중" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "일괄 처리 중단" })).toBeEnabled();

    rejectRun(new Error("Provider 작업이 계속 실패한 뒤 종료되었습니다."));
    expect(await screen.findByText(/Provider 작업이 계속 실패한 뒤 종료되었습니다/)).toBeInTheDocument();
    expect(onApplyBatchProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "취소 요청 중" })).not.toBeInTheDocument();
  });

  it("leaves cancel-requested state when cancelBatchJob returns canceled: false and then shows the completed run", async () => {
    let resolveRun!: (result: unknown) => void;
    const runBatchJob = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveRun = resolve;
    }));
    const cancelBatchJob = vi.fn().mockResolvedValue({ canceled: false });
    const completedProject = {
      ...mockProject,
      dialogueLines: [{ ...mockProject.dialogueLines[0], aiTranslation: "취소 실패 후 완료된 번역" }]
    };
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob, cancelBatchJob };

    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={onApplyBatchProject}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    fireEvent.click(await screen.findByRole("button", { name: "일괄 처리 중단" }));

    expect(await screen.findByText(
      "이미 종료됐거나 최종 저장이 진행 중입니다. 실제 결과를 확인하고 있습니다."
    )).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "취소 요청 중" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "일괄 처리 중단" })).toBeEnabled();

    resolveRun({
      progress: {
        stage: "completed",
        currentPageIndex: 1,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 완료: 1개 대사 번역 완료",
        pageStatuses: {},
        errors: [],
        isCanceled: false
      },
      updatedProject: completedProject
    });

    expect(await screen.findByText("일괄 자동화 완료: 1개 대사 번역 완료")).toBeInTheDocument();
    expect(onApplyBatchProject).toHaveBeenCalledWith(
      completedProject,
      undefined,
      expect.objectContaining({ projectSessionId: null, sessionGeneration: 0 }),
      expect.any(Function)
    );
    expect(screen.queryByRole("button", { name: "취소 요청 중" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "완료 및 닫기" })).toBeInTheDocument();
  });

  it("does not hide a partial runBatchJob result after the user requested cancel", async () => {
    let resolveRun!: (result: unknown) => void;
    const runBatchJob = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveRun = resolve;
    }));
    const cancelBatchJob = vi.fn().mockResolvedValue({ canceled: false });
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob, cancelBatchJob };

    render(
      <BatchAutomationModal
        project={mockProject}
        pageCount={2}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={onApplyBatchProject}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    fireEvent.click(await screen.findByRole("button", { name: "일괄 처리 중단" }));
    await screen.findByText(
      "이미 종료됐거나 최종 저장이 진행 중입니다. 실제 결과를 확인하고 있습니다."
    );

    resolveRun({
      progress: {
        stage: "partial",
        currentPageIndex: 1,
        totalPages: 2,
        percent: 100,
        currentMessage: "일괄 자동화 부분 완료: 1개 적용, 1개 실패",
        pageStatuses: {},
        errors: [{ pageNumber: 2, message: "페이지 2 번역 실패" }],
        isCanceled: false
      },
      updatedProject: mockProject
    });

    expect(await screen.findByText("일괄 자동화 부분 완료: 1개 적용, 1개 실패")).toBeInTheDocument();
    expect(screen.getByText("페이지 2 번역 실패")).toBeInTheDocument();
    expect(onApplyBatchProject).toHaveBeenCalledWith(
      mockProject,
      undefined,
      expect.objectContaining({ projectSessionId: null, sessionGeneration: 0 }),
      expect.any(Function)
    );
    expect(screen.getByRole("button", { name: "부분 반영 및 닫기" })).toBeInTheDocument();
  });

  function createDeferredBatchRun() {
    let resolveRun!: (value: unknown) => void;
    const runBatchJob = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        })
    );
    return {
      runBatchJob,
      resolveRun: (value: unknown) => resolveRun(value)
    };
  }

  function completedBatchResult(updatedProject: TranslationProject, title = "Stale completed A") {
    const dtoProject = normalizeProject(updatedProject);
    return {
      progress: {
        stage: "completed" as const,
        currentPageIndex: 1,
        totalPages: 1,
        percent: 100,
        currentMessage: "일괄 자동화 완료: 늦은 결과",
        pageStatuses: {},
        errors: [],
        isCanceled: false
      },
      updatedProject: {
        ...updatedProject,
        metadata: { ...updatedProject.metadata, title }
      },
      sessionChange: {
        status: "applied" as const,
        revision: 99,
        project: {
          revision: 99,
          project: { ...dtoProject, metadata: { ...dtoProject.metadata, title } },
          dirty: true,
          pendingPageImages: [],
          status: "active" as const
        }
      }
    };
  }

  it("does not apply a completed run after isOpen is forced closed", async () => {
    const { runBatchJob, resolveRun } = createDeferredBatchRun();
    const cancelBatchJob = vi.fn().mockResolvedValue({ canceled: true });
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob, cancelBatchJob };

    const props = {
      project: mockProject,
      projectSessionId: "session-a",
      sessionGeneration: 1,
      pageCount: 1,
      onClose: vi.fn(),
      onApplyBatchProject
    };
    const { rerender } = render(<BatchAutomationModal {...props} isOpen={true} />);

    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    expect(await screen.findByRole("button", { name: "일괄 처리 중단" })).toBeInTheDocument();

    rerender(<BatchAutomationModal {...props} isOpen={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(cancelBatchJob).toHaveBeenCalledTimes(1));
    expect(cancelBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: expect.stringMatching(/^batch-job-/) })
    );

    await act(async () => {
      resolveRun(completedBatchResult(mockProject));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onApplyBatchProject).not.toHaveBeenCalled();
  });

  it("does not apply a previous session result after projectSessionId and sessionGeneration change", async () => {
    const { runBatchJob, resolveRun } = createDeferredBatchRun();
    const cancelBatchJob = vi.fn().mockResolvedValue({ canceled: true });
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob, cancelBatchJob };
    const projectB = { ...mockProject, metadata: { ...mockProject.metadata, id: "p-b", title: "Project B" } };

    const { rerender } = render(
      <BatchAutomationModal
        project={mockProject}
        projectSessionId="session-a"
        sessionGeneration={1}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={onApplyBatchProject}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    expect(await screen.findByRole("button", { name: "일괄 처리 중단" })).toBeInTheDocument();

    rerender(
      <BatchAutomationModal
        project={projectB}
        projectSessionId="session-b"
        sessionGeneration={2}
        pageCount={1}
        isOpen={true}
        onClose={vi.fn()}
        onApplyBatchProject={onApplyBatchProject}
      />
    );

    await waitFor(() => expect(cancelBatchJob).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveRun(completedBatchResult(mockProject));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onApplyBatchProject).not.toHaveBeenCalled();
  });

  it("still ignores a stale run when forced close cancel IPC rejects", async () => {
    const { runBatchJob, resolveRun } = createDeferredBatchRun();
    const cancelBatchJob = vi.fn().mockRejectedValue(new Error("batch cancel IPC failed"));
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob, cancelBatchJob };

    const props = {
      project: mockProject,
      projectSessionId: "session-a",
      sessionGeneration: 1,
      pageCount: 1,
      onClose: vi.fn(),
      onApplyBatchProject
    };
    const { rerender } = render(<BatchAutomationModal {...props} isOpen={true} />);
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    await screen.findByRole("button", { name: "일괄 처리 중단" });

    rerender(<BatchAutomationModal {...props} isOpen={false} />);
    await waitFor(() => expect(cancelBatchJob).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveRun(completedBatchResult(mockProject));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onApplyBatchProject).not.toHaveBeenCalled();
  });

  it("still ignores a stale run when forced close cancel returns canceled: false", async () => {
    const { runBatchJob, resolveRun } = createDeferredBatchRun();
    const cancelBatchJob = vi.fn().mockResolvedValue({ canceled: false });
    const onApplyBatchProject = vi.fn().mockResolvedValue("adopted");
    (window as any).projectApi = { runBatchJob, cancelBatchJob };

    const props = {
      project: mockProject,
      projectSessionId: "session-a",
      sessionGeneration: 1,
      pageCount: 1,
      onClose: vi.fn(),
      onApplyBatchProject
    };
    const { rerender } = render(<BatchAutomationModal {...props} isOpen={true} />);
    fireEvent.click(screen.getByRole("button", { name: "⚡ 일괄 처리 시작" }));
    await screen.findByRole("button", { name: "일괄 처리 중단" });

    rerender(<BatchAutomationModal {...props} isOpen={false} />);
    await waitFor(() => expect(cancelBatchJob).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveRun(completedBatchResult(mockProject));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onApplyBatchProject).not.toHaveBeenCalled();
  });
});
