import { Button } from "./Ui.js";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../useFocusTrap.js";
import {
  type BatchPipelineConfig,
  type BatchProgressState,
  createInitialBatchProgress,
  getDefaultBatchConfig
} from "../../shared/batchAutomation.js";
import { acknowledgeCancelIpc } from "../../shared/cancelAcknowledgment.js";
import type { ProjectChangeResult } from "../../shared/projectSessionTypes.js";
import type {
  PageImage,
  ProcessingQueueState,
  TranslationProject,
  TranslationProjectV2
} from "../../shared/projectTypes.js";
import {
  type MangaSpeechStylePreset,
  mangaSpeechStylePresetLabels,
  mangaSpeechStylePresets
} from "../../shared/translationContext.js";

export type BatchRunScope = {
  projectSessionId: string | null;
  sessionGeneration: number;
  projectId: string;
  requestId: string;
  initialQueueId: string | null;
};

export type BatchAutomationModalProps = {
  project: TranslationProject | TranslationProjectV2;
  projectSessionId?: string | null;
  sessionGeneration?: number;
  pageCount: number;
  isOpen: boolean;
  onClose: () => void;
  onOpenProcessingQueue?: () => void;
  onRegisterRun?: (scope: BatchRunScope, isCurrent: () => boolean) => boolean;
  onBindRunQueue?: (scope: BatchRunScope, queueId: string, isCurrent: () => boolean) => boolean;
  onFinishRun?: (scope: BatchRunScope) => void;
  onApplyBatchProject: (
    updatedProject: TranslationProject,
    sessionChange: ProjectChangeResult | undefined,
    scope: BatchRunScope,
    isCurrent: () => boolean
  ) => Promise<"adopted" | "ignored">;
};

export function BatchAutomationModal({
  project,
  projectSessionId,
  sessionGeneration = 0,
  pageCount,
  isOpen,
  onClose,
  onOpenProcessingQueue,
  onRegisterRun,
  onBindRunQueue,
  onFinishRun,
  onApplyBatchProject
}: BatchAutomationModalProps) {
  const [config, setConfig] = useState<BatchPipelineConfig>(getDefaultBatchConfig);
  const [progress, setProgress] = useState<BatchProgressState>(() =>
    createInitialBatchProgress(pageCount, getDefaultBatchConfig())
  );
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);
  const [isCancelRequested, setIsCancelRequested] = useState(false);
  const cancelInFlightRef = useRef(false);
  const runGenerationRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const startedScopeRef = useRef<BatchRunScope | null>(null);
  const mountedRef = useRef(true);
  const currentIdentity = { projectSessionId: projectSessionId ?? null, sessionGeneration, projectId: project.metadata.id, isOpen, queue: "processing" in project ? project.processing.queue : undefined };
  const currentIdentityRef = useRef(currentIdentity);
  currentIdentityRef.current = currentIdentity;
  const actualQueueIdRef = useRef<string | null>(null);
  const [actualQueueId, setActualQueueId] = useState<string | null>(null);
  const [isPausePending, setIsPausePending] = useState(false);
  const controlSequenceRef = useRef(0);
  const pausePromiseRef = useRef<Promise<void> | null>(null);
  const finalResponseReceivedRef = useRef(false);
  const cancelMessageRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (invoker?.isConnected) invoker.focus(); };
  }, [isOpen]);
  useFocusTrap(cardRef, isOpen);

  useEffect(() => {
    if (isOpen) {
      cardRef.current?.focus();
    }
  }, [isOpen]);

  function abandonActiveBatchRun() {
    const requestId = activeRequestIdRef.current;
    if (!isRunningRef.current && requestId === null) return;
    runGenerationRef.current += 1;
    const scope = startedScopeRef.current;
    startedScopeRef.current = null;
    if (scope) onFinishRun?.(scope);
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    controlSequenceRef.current += 1;
    actualQueueIdRef.current = null;
    activeRequestIdRef.current = null;
    isRunningRef.current = false;
    cancelInFlightRef.current = false;
    setIsRunning(false);
    setIsCancelRequested(false);
    setIsPausePending(false);
    setActualQueueId(null);
    if (requestId && window.projectApi?.cancelBatchJob) {
      void acknowledgeCancelIpc(() => window.projectApi.cancelBatchJob!({ requestId }));
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runGenerationRef.current += 1;
      controlSequenceRef.current += 1;
      unsubscribeRef.current?.();
      const scope = startedScopeRef.current;
      if (scope) onFinishRun?.(scope);
      const requestId = activeRequestIdRef.current;
      startedScopeRef.current = null;
      activeRequestIdRef.current = null;
      if (requestId && isRunningRef.current && window.projectApi?.cancelBatchJob) {
        void acknowledgeCancelIpc(() => window.projectApi.cancelBatchJob!({ requestId }));
      }
    };
  }, []);

  useEffect(() => {
    if (isOpen) return;
    abandonActiveBatchRun();
    setIsRunning(false);
    setIsCancelRequested(false);
    setProgress(createInitialBatchProgress(pageCount, config));
  }, [isOpen, pageCount]);

  useEffect(() => {
    const started = startedScopeRef.current;
    if (!started) return;
    if (
      started.projectSessionId === (projectSessionId ?? null) &&
      started.sessionGeneration === sessionGeneration &&
      started.projectId === project.metadata.id
    ) {
      return;
    }
    abandonActiveBatchRun();
    setProgress(createInitialBatchProgress(pageCount, config));
  }, [projectSessionId, sessionGeneration, project.metadata.id, pageCount]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isRunning && !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isRunning, onClose]);

  if (!isOpen) return null;

  const processingQueue = "processing" in project ? project.processing.queue : undefined;
  const errorSummaries = summarizeBatchErrors({
    progressErrors: progress.errors ?? [],
    queue: isRunning ? undefined : processingQueue,
    pageImages: project.pageImages
  });
  const failedQueuePageCount = processingQueue?.pages.filter((page) => page.status === "failed").length ?? 0;
  const isPaused = processingQueue?.status === "paused";
  const hasUnfinishedQueue = Boolean(processingQueue && ["idle", "running", "paused"].includes(processingQueue.status));
  const canOpenProcessingQueue = Boolean(onOpenProcessingQueue && (failedQueuePageCount > 0 || hasUnfinishedQueue));
  // A duplicate final response can be ignored before React receives the adopted
  // pause snapshot. Derive its presentation from the same run's saved queue.
  const displayedProgress: BatchProgressState = !isRunning && !isCancelRequested && !cancelMessageRef.current &&
    isPaused && processingQueue?.queueId === actualQueueId &&
    progress.stage === "error" && progress.currentMessage === "최신 변경을 유지했습니다."
    ? { ...progress, stage: "partial", currentMessage: "일시정지됨" }
    : progress;

  const hasRunnableStage = config.runTranslate || config.runTypeset;

  async function handleStartBatch() {
    if (isRunningRef.current || hasUnfinishedQueue || (!config.runTranslate && !config.runTypeset)) return;
    const runGeneration = ++runGenerationRef.current;
    const requestId = `batch-job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const startedScope: BatchRunScope = {
      projectSessionId: projectSessionId ?? null,
      sessionGeneration,
      projectId: project.metadata.id,
      requestId,
      initialQueueId: processingQueue?.queueId ?? null
    };
    startedScopeRef.current = startedScope;
    activeRequestIdRef.current = requestId;
    const isCurrent = () => {
      const current = currentIdentityRef.current;
      return mountedRef.current && current.isOpen && runGenerationRef.current === runGeneration &&
        activeRequestIdRef.current === requestId && startedScopeRef.current === startedScope &&
        current.projectSessionId === startedScope.projectSessionId && current.sessionGeneration === startedScope.sessionGeneration &&
        current.projectId === startedScope.projectId;
    };
    if (onRegisterRun?.(startedScope, isCurrent) === false) {
      startedScopeRef.current = null;
      activeRequestIdRef.current = null;
      return;
    }
    setIsRunning(true);
    isRunningRef.current = true;
    cancelInFlightRef.current = false;
    setIsCancelRequested(false);
    setIsPausePending(false);
    actualQueueIdRef.current = null;
    setActualQueueId(null);
    finalResponseReceivedRef.current = false;
    cancelMessageRef.current = null;
    pausePromiseRef.current = null;
    controlSequenceRef.current += 1;
    const initial = createInitialBatchProgress(pageCount, config);
    setProgress(initial);

    const runBatchJob = window.projectApi?.runBatchJob;
    if (!runBatchJob) {
      startedScopeRef.current = null;
      activeRequestIdRef.current = null;
      onFinishRun?.(startedScope);
      setProgress({
        ...initial,
        stage: "error",
        currentMessage: "이 환경에서는 Main Batch 실행 기능을 사용할 수 없습니다."
      });
      isRunningRef.current = false;
      setIsRunning(false);
      return;
    }

    const bindQueue = (queueId: string) => {
      if (!isCurrent() || (actualQueueIdRef.current !== null && actualQueueIdRef.current !== queueId)) return false;
      if (onBindRunQueue?.(startedScope, queueId, isCurrent) === false) return false;
      actualQueueIdRef.current = queueId;
      setActualQueueId(queueId);
      return true;
    };

    let unsubscribe: (() => void) | undefined;
    if (window.projectApi.onBatchProgress) {
      unsubscribe = window.projectApi.onBatchProgress((data) => {
        if (data.requestId !== requestId || !isCurrent() || finalResponseReceivedRef.current) return;
        if (data.projectSessionId !== undefined && data.projectSessionId !== startedScope.projectSessionId) return;
        if (data.queueId !== undefined && (data.projectSessionId !== startedScope.projectSessionId || !bindQueue(data.queueId))) return;
        if (["completed", "partial", "failed", "canceled", "error"].includes(data.progress.stage)) return;
        setProgress((previous) => ({ ...data.progress, currentMessage: cancelMessageRef.current ?? (pausePromiseRef.current ? previous.currentMessage : data.progress.currentMessage) }));
      });
      unsubscribeRef.current = unsubscribe;
    }

    try {
      const result = await runBatchJob({
        project: projectSessionId ? undefined : project,
        projectSessionId: projectSessionId ?? undefined,
        config,
        pageCount,
        requestId
      });
      if (!isCurrent()) return;
      finalResponseReceivedRef.current = true;
      const resultQueue = result.sessionChange?.project.project.processing.queue;
      if (resultQueue && !bindQueue(resultQueue.queueId)) {
        setProgress((previous) => ({ ...previous, stage: "error", currentMessage: "최신 변경을 유지했습니다." }));
        return;
      }
      if (
        result.progress.stage === "completed" ||
        result.progress.stage === "partial" ||
        result.progress.stage === "failed" ||
        (result.progress.stage === "canceled" && Boolean(result.sessionChange))
      ) {
        const adoption = await onApplyBatchProject(result.updatedProject, result.sessionChange, startedScope, isCurrent);
        if (!isCurrent()) return;
        if (adoption !== "adopted") {
          const currentQueue = currentIdentityRef.current.queue;
          const pausedAlreadyAdopted = currentQueue?.queueId === actualQueueIdRef.current && currentQueue?.status === "paused";
          setProgress((previous) => ({ ...previous, stage: pausedAlreadyAdopted ? "partial" : "error", currentMessage: pausedAlreadyAdopted ? "일시정지됨" : "최신 변경을 유지했습니다." }));
          return;
        }
      }
      if (!isCurrent()) return;
      setProgress(resultQueue?.status === "paused" ? { ...result.progress, currentMessage: "일시정지됨" } : result.progress);
    } catch (err) {
      if (!isCurrent()) return;
      finalResponseReceivedRef.current = true;
      setProgress((prev) => ({
        ...prev,
        stage: "error",
        currentMessage: `일괄 처리 중 오류: ${err instanceof Error ? err.message : String(err)}`
      }));
    } finally {
      unsubscribe?.();
      // A control can still be draining App mutations after the run response arrives.
      // Keep this run registered until that adoption also settles.
      await (startedScopeRef.current === startedScope ? pausePromiseRef.current : null);
      if (isCurrent()) {
        onFinishRun?.(startedScope);
        unsubscribeRef.current = undefined;
        startedScopeRef.current = null;
        activeRequestIdRef.current = null;
        isRunningRef.current = false;
        cancelInFlightRef.current = false;
        setIsRunning(false);
        setIsCancelRequested(false);
        setIsPausePending(false);
      }
    }
  }

  function handlePause() {
    const scope = startedScopeRef.current;
    const queueId = actualQueueIdRef.current;
    const api = window.projectApi?.updateProcessingQueue;
    if (!scope?.projectSessionId || !queueId || !api || pausePromiseRef.current || cancelMessageRef.current || finalResponseReceivedRef.current) return;
    const generation = runGenerationRef.current;
    const sequence = ++controlSequenceRef.current;
    const isCurrent = () => mountedRef.current && currentIdentityRef.current.isOpen &&
      runGenerationRef.current === generation && startedScopeRef.current === scope &&
      currentIdentityRef.current.projectSessionId === scope.projectSessionId && currentIdentityRef.current.sessionGeneration === scope.sessionGeneration &&
      currentIdentityRef.current.projectId === scope.projectId && controlSequenceRef.current === sequence;
    setIsPausePending(true);
    setProgress((previous) => ({ ...previous, currentMessage: "현재 작업 결과를 정리한 뒤 일시정지합니다. 기다리는 중에도 취소할 수 있습니다." }));
    const operation = Promise.resolve().then(async () => {
      try {
        if (!isCurrent()) return;
        const result = await api({ projectSessionId: scope.projectSessionId!, queueId, action: "pause", reason: "사용자가 작업을 일시정지했습니다." });
        if (!isCurrent()) return;
        if (result.queue?.queueId !== queueId || result.project.project.processing.queue?.queueId !== queueId) throw new Error("요청한 큐와 응답의 큐가 다릅니다.");
        const adopted = await onApplyBatchProject(result.project.project, { status: "applied", revision: result.project.revision, project: result.project }, scope, isCurrent);
        if (!isCurrent()) return;
        if (result.control?.status === "failed") {
          const message = result.control.message;
          setProgress((previous) => ({ ...previous, currentMessage: message }));
        } else if (adopted === "adopted" && result.queue.status === "paused") {
          setProgress((previous) => ({ ...previous, stage: finalResponseReceivedRef.current ? "partial" : previous.stage, currentMessage: "일시정지됨" }));
        } else if (adopted === "ignored" && !finalResponseReceivedRef.current) {
          setProgress((previous) => ({ ...previous, currentMessage: "최신 변경을 유지했습니다." }));
        }
      } catch (error) {
        if (isCurrent()) setProgress((previous) => ({ ...previous, currentMessage: `${error instanceof Error ? error.message : "일시정지를 확인하지 못했습니다."} 마지막으로 확인한 큐 상태입니다.` }));
      } finally {
        if (pausePromiseRef.current === operation) pausePromiseRef.current = null;
        if (isCurrent()) setIsPausePending(false);
      }
    });
    pausePromiseRef.current = operation;
  }

  async function handleCancel() {
    if (cancelInFlightRef.current) return;
    const requestId = activeRequestIdRef.current;
    const runGeneration = runGenerationRef.current;
    const scope = startedScopeRef.current;
    if (!requestId || !scope || !isRunningRef.current) return;
    cancelInFlightRef.current = true;
    controlSequenceRef.current += 1;
    setIsCancelRequested(true);
    cancelMessageRef.current = "취소 요청을 처리 중입니다.";
    setProgress((prev) => ({
      ...prev,
      currentMessage: "취소 요청을 처리 중입니다."
    }));

    const ack = await acknowledgeCancelIpc(
      window.projectApi?.cancelBatchJob
        ? () => window.projectApi.cancelBatchJob!({ requestId })
        : undefined
    );
    if (!mountedRef.current || !currentIdentityRef.current.isOpen || runGenerationRef.current !== runGeneration || activeRequestIdRef.current !== requestId ||
      currentIdentityRef.current.projectSessionId !== scope.projectSessionId || currentIdentityRef.current.sessionGeneration !== scope.sessionGeneration ||
      currentIdentityRef.current.projectId !== scope.projectId) {
      return;
    }
    if (finalResponseReceivedRef.current) return;
    if (ack.kind !== "confirmed") {
      cancelInFlightRef.current = false;
      setIsCancelRequested(false);
    }
    const message = ack.kind === "confirmed"
      ? "취소를 요청했습니다. 진행 중인 호출과 저장 결과를 확인하고 있습니다."
      : ack.kind === "not_found_or_already_finished"
        ? "이미 종료됐거나 최종 저장이 진행 중입니다. 실제 결과를 확인하고 있습니다."
        : "취소 접수를 확인하지 못했습니다. 실행 결과를 기다립니다.";
    cancelMessageRef.current = message;
    setProgress((previous) => ({ ...previous, currentMessage: message }));
  }

  return (
    <div className="trio-modal-backdrop stitch-dialog-backdrop" onClick={isRunning ? undefined : onClose}>
      <div
        ref={cardRef}
        tabIndex={-1}
        className="trio-modal-card stitch-dialog stitch-dialog--batch"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="trio-modal-header">
          <div><p className="stitch-dialog-kicker">번역 작업 / 일괄 처리</p><h3 id="batch-modal-title">전 페이지 일괄 자동화</h3></div>
          {!isRunning && (
            <button type="button" className="trio-modal-close" aria-label="닫기" onClick={onClose}>
              ✕
            </button>
          )}
        </div>

        <div className="trio-modal-body">
          {!isRunning && displayedProgress.stage === "idle" && hasUnfinishedQueue ? <p role="status" className="stitch-batch-condition">진행 중이거나 일시정지된 작업이 있습니다. 작업 큐에서 재개하거나 취소한 뒤 새 일괄 작업을 시작하세요.</p> : null}
          <ol className="stitch-batch-steps" aria-label="일괄 처리 단계">
            <li aria-current={!isRunning && displayedProgress.stage === "idle" ? "step" : undefined}>01 실행 설정</li>
            <li aria-current={isRunning ? "step" : undefined}>02 진행 확인</li>
            <li aria-current={!isRunning && displayedProgress.stage !== "idle" ? "step" : undefined}>03 결과 검수</li>
          </ol>
          <div className="stitch-batch-plan">
            <section className="stitch-batch-scope" aria-labelledby="batch-scope-heading">
              <span className="stitch-dialog-kicker">실행 범위</span>
              <h4 id="batch-scope-heading">전체 {pageCount}개 페이지</h4>
              <dl>
                <div><dt>번역 준비</dt><dd>OCR 대사 확인 · AI 번역은 검토용 제안</dd></div>
                <div><dt>식자 준비</dt><dd>사용자가 확정한 번역에만 적용</dd></div>
                <div><dt>페이지별 작업</dt><dd>OCR·인페인팅은 페이지별 실행</dd></div>
              </dl>
              <p>덮어쓰기 꺼짐: 기존 번역은 건너뜀 · 확정 번역은 식자 재계산 가능</p>
            </section>
            <section className="stitch-batch-config" aria-labelledby="batch-config-heading">
              <h4 id="batch-config-heading">실행할 작업</h4>
              <fieldset disabled={isRunning}>
                <legend>단계 설정</legend>
                <label className="checkbox-row"><input type="checkbox" checked={false} disabled />말풍선 OCR (작업대 개별)</label>
                <label className="checkbox-row"><input type="checkbox" checked={config.runTranslate} onChange={(event) => setConfig((previous) => ({ ...previous, runTranslate: event.target.checked }))} />AI 문맥 번역</label>
                <label className="checkbox-row"><input type="checkbox" checked={false} disabled />배경 인페인팅 (작업대 개별)</label>
                <label className="checkbox-row"><input type="checkbox" checked={config.runTypeset} onChange={(event) => setConfig((previous) => ({ ...previous, runTypeset: event.target.checked }))} />지능형 자동 식자</label>
                <label className="stitch-batch-preset" htmlFor="batch-speech-preset">번역 말투 프리셋
                  <select id="batch-speech-preset" className="trio-select" value={config.speechStylePreset} onChange={(event) => setConfig((previous) => ({ ...previous, speechStylePreset: event.target.value as MangaSpeechStylePreset }))}>
                    {mangaSpeechStylePresets.map((preset) => <option key={preset} value={preset}>{mangaSpeechStylePresetLabels[preset]}</option>)}
                  </select>
                </label>
              </fieldset>
              {!hasRunnableStage ? <p role="status" className="stitch-batch-condition">번역 또는 식자 중 적어도 하나를 선택해야 일괄 처리를 시작할 수 있습니다.</p> : null}
            </section>
          </div>

          {/* Progress Indicator */}
          {(isRunning || displayedProgress.stage !== "idle") && (
            <section className="stitch-batch-progress" aria-label={isRunning ? "실행 진행" : "실행 결과"} data-stage={displayedProgress.stage}>
              <h4>{isRunning ? "실행 진행" : isPaused ? "일시정지 결과" : "실행 결과"}</h4>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--trio-text-caption)", marginBottom: "var(--trio-space-1)" }}>
                <span role="status">{displayedProgress.currentMessage}</span>
                <strong>{displayedProgress.percent}%</strong>
              </div>
              <div
                role="progressbar"
                aria-valuenow={displayedProgress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="일괄 처리 진행률"
                style={{ width: "100%", height: "8px", background: "var(--trio-border-soft)", borderRadius: "var(--trio-radius-sm)", overflow: "hidden" }}
              >
                <div
                  style={{
                    width: `${displayedProgress.percent}%`,
                    height: "100%",
                    background:
                      displayedProgress.stage === "error" || displayedProgress.stage === "failed"
                        ? "var(--trio-error)"
                        : displayedProgress.stage === "partial"
                          ? "var(--trio-warning)"
                          : "var(--trio-accent)",
                    transition: "width 0.3s ease"
                  }}
                />
              </div>
              {!isRunning ? <p className="stitch-batch-next">{displayedProgress.stage === "completed" ? "결과 검수 필요 · AI 제안은 미확정" : isPaused ? "작업 큐에서 현재 페이지·단계 확인 후 재개" : "작업 큐에서 결과·오류·실패·취소 상태 확인"}</p> : <p className="stitch-batch-next">중단·일시정지는 처리와 저장 결과 확인 후 확정</p>}
            </section>
          )}

          {errorSummaries.length > 0 ? (
            <section
              aria-label="일괄 처리 오류 요약"
              role="alert"
              style={{
                marginTop: "var(--trio-space-3)",
                padding: "var(--trio-space-2) var(--trio-space-3)",
                border: "1px solid var(--trio-warning)",
                borderRadius: "var(--trio-radius-sm)",
                background: "var(--trio-warning-soft)"
              }}
            >
              <strong style={{ display: "block", fontSize: "var(--trio-text-caption)" }}>
                확인이 필요한 오류 {errorSummaries.length}건
              </strong>
              <ul style={{ margin: "var(--trio-space-1) 0 0", paddingLeft: "var(--trio-space-4)", fontSize: "var(--trio-text-caption)", lineHeight: 1.5 }}>
                {errorSummaries.map((summary) => (
                  <li key={summary.key}>
                    <strong>{summary.label}</strong>
                    {summary.messages.map((message) => (
                      <span key={message} style={{ display: "block", marginLeft: "var(--trio-space-2)" }}>{message}</span>
                    ))}
                    {summary.additionalCount > 0 ? ` (외 ${summary.additionalCount}건)` : ""}
                  </li>
                ))}
              </ul>
              {failedQueuePageCount > 0 ? (
                <p style={{ margin: "var(--trio-space-1) 0 0", fontSize: "var(--trio-text-caption)" }}>
                  저장된 작업 큐에 실패 페이지 {failedQueuePageCount}개가 있습니다. 오류를 확인한 뒤 페이지별로 재시도할 수 있습니다.
                </p>
              ) : null}
            </section>
          ) : null}
        </div>

        <div className="trio-modal-footer">
          {isRunning ? (
            <>
              {projectSessionId ? (
                <>
                  <Button type="button" variant="secondary" disabled={!actualQueueId || isPausePending || isCancelRequested || finalResponseReceivedRef.current || !window.projectApi?.updateProcessingQueue} onClick={handlePause}>
                    일시정지
                  </Button>
                  {!actualQueueId ? <span role="status">작업 큐를 준비 중입니다. 실제 큐를 확인한 뒤 일시정지할 수 있습니다.</span> : null}
                </>
              ) : null}
              <Button type="button" variant="secondary" disabled={isCancelRequested} onClick={() => void handleCancel()}>
                {isCancelRequested ? "취소 요청 중" : "일괄 처리 중단"}
              </Button>
            </>
          ) : displayedProgress.stage === "completed" || displayedProgress.stage === "partial" ? (
            <>
              {canOpenProcessingQueue ? (
                <Button type="button" variant="primary" onClick={onOpenProcessingQueue}>
                  {isPaused ? "작업 큐에서 현재 페이지·단계 재개" : hasUnfinishedQueue ? "작업 큐에서 현재 진행 확인" : "실패 페이지를 작업 큐에서 확인"}
                </Button>
              ) : null}
              <button type="button" className={canOpenProcessingQueue ? "secondary-button" : "primary-button"} onClick={onClose}>
                {isPaused ? "일시정지 확인 및 닫기" : displayedProgress.stage === "partial" ? "부분 반영 및 닫기" : "완료 및 닫기"}
              </button>
            </>
          ) : (
            <>
              {canOpenProcessingQueue ? (
                <Button type="button" variant="primary" onClick={onOpenProcessingQueue}>
                  {isPaused ? "작업 큐에서 현재 페이지·단계 재개" : hasUnfinishedQueue ? "작업 큐에서 현재 진행 확인" : "실패 페이지를 작업 큐에서 확인"}
                </Button>
              ) : null}
              <Button type="button" variant="secondary" onClick={onClose}>
                취소
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleStartBatch}
                disabled={!hasRunnableStage || hasUnfinishedQueue}
                title={hasUnfinishedQueue ? "기존 작업을 작업 큐에서 재개하거나 취소하세요" : hasRunnableStage ? undefined : "번역 또는 식자 중 적어도 하나를 선택하세요"}
              >
                ⚡ 일괄 처리 시작
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type BatchErrorSummary = {
  key: string;
  label: string;
  messages: string[];
  additionalCount: number;
};

function summarizeBatchErrors(args: {
  progressErrors: ReadonlyArray<{ pageNumber?: number; message: string }>;
  queue?: ProcessingQueueState;
  pageImages: readonly PageImage[];
}): BatchErrorSummary[] {
  const messagesByPage = new Map<number | undefined, string[]>();
  const pageNumbersByImageId = new Map(args.pageImages.map((page) => [page.id, page.pageNumber]));

  const addError = (pageNumber: number | undefined, message: string) => {
    const normalizedPageNumber = pageNumber !== undefined && pageNumber > 0 ? pageNumber : undefined;
    const normalizedMessage = message.trim();
    if (!normalizedMessage) return;
    const messages = messagesByPage.get(normalizedPageNumber) ?? [];
    if (!messages.includes(normalizedMessage)) messages.push(normalizedMessage);
    messagesByPage.set(normalizedPageNumber, messages);
  };

  for (const page of args.queue?.pages ?? []) {
    if (page.status === "failed" && page.error) {
      addError(pageNumbersByImageId.get(page.pageImageId), page.error.message);
      for (const [key, value] of Object.entries(page.error.details ?? {})) {
        if (/^additionalFailure\d+Message$/.test(key) && typeof value === "string") {
          addError(pageNumbersByImageId.get(page.pageImageId), value);
        }
      }
    }
  }
  for (const error of args.progressErrors) {
    addError(error.pageNumber, error.message);
  }

  return [...messagesByPage.entries()]
    .sort(([left], [right]) => {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left - right;
    })
    .map(([pageNumber, messages]) => ({
      key: pageNumber === undefined ? "general" : `page-${pageNumber}`,
      label: pageNumber === undefined ? "전체" : `p.${pageNumber}`,
      messages: messages.slice(0, 2),
      additionalCount: Math.max(0, messages.length - 2)
    }));
}
