import { useEffect, useRef, useState } from "react";
import type { ProcessingQueueActionArgs, ProcessingQueueActionResult } from "../../shared/processingQueue";
import type {
  ProcessingQueuePageRecord,
  ProcessingQueueStage,
  ProcessingQueueState,
  TranslationProjectV2
} from "../../shared/projectTypes";

export type ProcessingQueueRequestScope = {
  projectSessionId: string;
  sessionGeneration: number;
  requestSequence: number;
  queueId: string;
};

type ProcessingQueuePanelProps = {
  project: Pick<TranslationProjectV2, "pageImages" | "processing">;
  projectSessionId: string | null;
  sessionGeneration: number;
  disabled?: boolean;
  onOpenBatchAutomation?: () => void;
  onResult: (result: ProcessingQueueActionResult, scope: ProcessingQueueRequestScope, isCurrent: () => boolean) => Promise<"adopted" | "ignored">;
  onError: (message: string, scope: ProcessingQueueRequestScope) => void;
};

function isBatchSupportedStage(stage: ProcessingQueueStage): boolean {
  return stage === "translation" || stage === "typesetting";
}

const stageLabels: Record<ProcessingQueueStage, string> = {
  ocr: "OCR 후보",
  speaker_review: "화자 검토",
  translation: "번역 초안",
  inpainting: "인페인팅",
  typesetting: "식자",
  completed: "완료"
};

const statusLabels: Record<ProcessingQueuePageRecord["status"], string> = {
  pending: "대기",
  running: "처리 중",
  paused: "일시정지",
  awaiting_approval: "승인 대기",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨"
};

const queueStatusLabels: Record<ProcessingQueueState["status"], string> = {
  idle: "대기",
  running: "실행 중",
  paused: "일시정지",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨"
};

export function ProcessingQueuePanel({
  project,
  projectSessionId,
  sessionGeneration,
  disabled = false,
  onOpenBatchAutomation,
  onResult,
  onError
}: ProcessingQueuePanelProps) {
  const [pendingAction, setPendingAction] = useState<"pause" | "cancel" | "resume" | "retry" | null>(null);
  const pendingActionRef = useRef<typeof pendingAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const queue = project.processing.queue;
  const queueId = queue?.queueId;
  const currentScopeRef = useRef({ projectSessionId, sessionGeneration, queueId });
  const previousScopeRef = useRef({ projectSessionId, sessionGeneration, queueId });
  if (
    previousScopeRef.current.projectSessionId !== projectSessionId ||
    previousScopeRef.current.sessionGeneration !== sessionGeneration ||
    previousScopeRef.current.queueId !== queueId
  ) {
    requestSequenceRef.current += 1;
    pendingActionRef.current = null;
    previousScopeRef.current = { projectSessionId, sessionGeneration, queueId };
  }
  currentScopeRef.current = { projectSessionId, sessionGeneration, queueId };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);
  useEffect(() => {
    setPendingAction(null);
    setNotice(null);
  }, [projectSessionId, sessionGeneration, queueId]);
  const busy = pendingAction !== null;
  const current = queue?.pages[queue.currentPageIndex];
  const currentPage = current
    ? project.pageImages.find((page) => page.id === current.pageImageId)
    : undefined;

  async function invoke(
    action: NonNullable<typeof pendingAction>,
    extra: Pick<ProcessingQueueActionArgs, "reason" | "pageImageId" | "revision"> = {}
  ) {
    const api = window.projectApi?.updateProcessingQueue;
    if (!queueId || (pendingActionRef.current && (action !== "cancel" || pendingActionRef.current === "cancel"))) return;
    if (disabled) {
      onError("세션 복구가 끝날 때까지 작업 큐를 변경할 수 없습니다.", {
        projectSessionId: projectSessionId ?? "",
        sessionGeneration,
        requestSequence: requestSequenceRef.current,
        queueId
      });
      return;
    }
    if (!api || !projectSessionId) {
      if (projectSessionId) {
        onError("저장된 프로젝트 세션에서만 작업 큐를 사용할 수 있습니다.", {
          projectSessionId,
          sessionGeneration,
          requestSequence: requestSequenceRef.current,
          queueId
        });
      }
      return;
    }
    const scope: ProcessingQueueRequestScope = {
      projectSessionId,
      sessionGeneration,
      requestSequence: requestSequenceRef.current + 1,
      queueId
    };
    requestSequenceRef.current = scope.requestSequence;
    const isCurrentScope = () =>
      mountedRef.current && requestSequenceRef.current === scope.requestSequence &&
      currentScopeRef.current.projectSessionId === scope.projectSessionId &&
      currentScopeRef.current.sessionGeneration === scope.sessionGeneration &&
      currentScopeRef.current.queueId === scope.queueId;
    pendingActionRef.current = action;
    setPendingAction(action);
    setNotice(null);
    try {
      const result = await api({
        projectSessionId,
        queueId,
        action,
        ...extra
      });
      if (!isCurrentScope()) return;
      if (result.queue?.queueId !== queueId || result.project.project.processing.queue?.queueId !== queueId) {
        onError("요청한 큐와 응답의 큐가 다릅니다. 마지막으로 확인한 상태를 유지합니다.", scope);
        return;
      }
      const adoption = await onResult(result, scope, isCurrentScope);
      if (!isCurrentScope()) return;
      if (result.control?.status === "failed") onError(result.control.message, scope);
      else if (adoption === "ignored") setNotice("최신 변경을 유지했습니다.");
    } catch (error) {
      if (isCurrentScope()) {
        onError(`${error instanceof Error ? error.message : "작업 큐를 갱신하지 못했습니다."} 마지막으로 확인한 큐 상태입니다.`, scope);
      }
    } finally {
      if (isCurrentScope()) {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    }
  }

  if (!queue) {
    return (
      <section className="processing-queue-panel" aria-label="페이지 작업 큐">
        <div className="processing-queue-empty">
          <div>
            <strong>일괄 번역·식자 작업 상태</strong>
            <p>진행·일시정지·재개·재시도 확인 · AI 결과는 승인 전 제안</p>
          </div>
          <button
            type="button"
            disabled={busy || disabled || !projectSessionId || project.pageImages.length === 0 || !onOpenBatchAutomation}
            onClick={() => onOpenBatchAutomation?.()}
          >
            {project.pageImages.length === 0 ? "페이지를 먼저 추가하세요" : "일괄 자동화 시작"}
          </button>
        </div>
      </section>
    );
  }

  const canResume = queue.status === "paused" && Boolean(current && isBatchSupportedStage(current.stage));
  const canCancel = queue.status === "running" || queue.status === "paused" || queue.status === "idle" || pendingAction === "resume" || pendingAction === "retry";
  const canCreateAgain = queue.status === "completed" || queue.status === "cancelled";
  const unsupportedPaused = queue.status === "paused" && current && !isBatchSupportedStage(current.stage);
  const unsupportedIdle = queue.status === "idle" && current && !isBatchSupportedStage(current.stage);
  const failedPageCount = queue.pages.filter((page) => page.status === "failed").length;
  const hasUnrunPages = queue.status === "failed" && queue.pages.some((page) => page.status === "pending");
  const unrunPageCount = queue.pages.filter((page) => page.status === "pending").length;
  const pendingOnlyOutcome = hasUnrunPages && failedPageCount === 0 && queue.failureReason === "일부 페이지 처리 실패";

  return (
    <section className="processing-queue-panel" aria-label="페이지 작업 큐">
      <div className="processing-queue-header">
        <div>
          <strong>페이지 작업 큐</strong>
          <span>{pendingOnlyOutcome ? "남은 페이지 확인 필요" : queueStatusLabels[queue.status]} · {queue.pages.length}페이지 · 한 번에 한 페이지</span>
        </div>
        <div className="processing-queue-actions">
          {queue.status === "running" ? (
            <button type="button" disabled={busy || disabled} onClick={() => void invoke("pause", { reason: "사용자가 작업을 일시정지했습니다." })}>
              일시정지
            </button>
          ) : null}
          {canResume ? (
            <button type="button" disabled={busy || disabled} onClick={() => void invoke("resume")}>
              {current?.stage === "translation" ? "Provider 재개" : "식자 재개"}
            </button>
          ) : null}
          {canCancel ? (
            <button type="button" disabled={pendingAction === "cancel" || disabled} onClick={() => void invoke("cancel", { reason: "사용자가 작업을 취소했습니다." })}>
              큐 취소
            </button>
          ) : null}
          {canCreateAgain ? (
            <button
              type="button"
              disabled={busy || disabled || !onOpenBatchAutomation}
              onClick={() => onOpenBatchAutomation?.()}
            >
              일괄 자동화 시작
            </button>
          ) : null}
          {hasUnrunPages ? (
            <button type="button" disabled={busy || disabled || !onOpenBatchAutomation} onClick={() => onOpenBatchAutomation?.()}>
              새 일괄 작업 설정
            </button>
          ) : null}
        </div>
      </div>
      {busy ? (
        <p className="processing-queue-notice" role="status">{pendingAction === "pause"
          ? "현재 작업 결과를 정리한 뒤 일시정지합니다. 기다리는 중에도 취소할 수 있습니다."
          : pendingAction === "cancel"
            ? "취소를 요청했습니다. 진행 중인 호출과 저장 결과를 확인하고 있습니다."
            : "재개/재시도 중입니다. 기다리는 중에도 취소할 수 있습니다."}</p>
      ) : null}
      {notice ? <p className="processing-queue-notice" role="status">{notice}</p> : null}
      {current?.stage === "translation" && queue.status === "paused" ? (
        <p className="processing-queue-notice" role="note">
          앱 재시작 또는 일시정지 뒤 외부 Provider 작업은 비용이 발생할 수 있으므로, 사용자가 Provider 재개를 눌러야 다시 호출됩니다.
        </p>
      ) : null}
      {unsupportedPaused ? (
        <p className="processing-queue-notice" role="note">
          이 단계에는 연결된 일괄 실행기가 없습니다. 번역 또는 식자 작업만 재개할 수 있습니다.
        </p>
      ) : null}
      {unsupportedIdle ? (
        <p className="processing-queue-notice" role="note">
          실행할 수 있는 번역/식자 작업이 아닙니다. 이 큐를 취소한 뒤 일괄 자동화에서 시작하세요.
        </p>
      ) : null}
      {queue.pauseReason || queue.failureReason ? (
        <p className="processing-queue-reason" role="status">{pendingOnlyOutcome ? `아직 실행하지 않은 페이지가 ${unrunPageCount}개 있습니다. 새 일괄 작업 설정에서 다음 작업을 시작하세요.` : queue.failureReason ?? queue.pauseReason}</p>
      ) : null}
      {failedPageCount > 0 ? (
        <p className="processing-queue-notice" role="note">
          실패 페이지 {failedPageCount}개를 확인하고 재시도할 수 있습니다. 번역 재시도는 해당 페이지 전체를 다시 실행할 수 있습니다.
        </p>
      ) : null}
      <ol className="processing-queue-pages" aria-label="페이지별 작업 상태">
        {queue.pages.map((page) => {
          const image = project.pageImages.find((candidate) => candidate.id === page.pageImageId);
          return (
            <li
              key={page.pageImageId}
              data-status={page.status}
              aria-label={`페이지 ${image?.pageNumber ?? page.pageImageId}`}
              aria-current={page.pageImageId === current?.pageImageId ? "true" : undefined}
            >
              <span className="processing-queue-page-number">{image ? `p.${image.pageNumber}` : page.pageImageId}</span>
              <span className="processing-queue-page-stage">{stageLabels[page.stage]}</span>
              <span className="processing-queue-page-status">{statusLabels[page.status]}</span>
              {page.error ? (
                <span className="processing-queue-page-error">
                  {page.error.message}
                  {processingQueueAdditionalFailureMessages(page.error).map((message) => (
                    <span key={message}>추가 확인: {message}</span>
                  ))}
                </span>
              ) : null}
              {page.status === "failed" && isBatchSupportedStage(page.stage) ? (
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void invoke("retry", {
                    pageImageId: page.pageImageId,
                    revision: page.revision
                  })}
                >
                  {page.stage === "translation" ? "실패 번역 다시 실행" : "실패 식자 다시 계산"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {currentPage ? <p className="processing-queue-current">현재 페이지: {currentPage.pageNumber} · {stageLabels[current?.stage ?? "ocr"]}</p> : null}
    </section>
  );
}

function processingQueueAdditionalFailureMessages(
  error: NonNullable<ProcessingQueuePageRecord["error"]>
): string[] {
  return Object.entries(error.details ?? {})
    .flatMap(([key, value]) =>
      /^additionalFailure\d+Message$/.test(key) && typeof value === "string"
        ? [[Number(key.match(/\d+/)?.[0] ?? 0), value] as const]
        : []
    )
    .sort(([left], [right]) => left - right)
    .map(([, message]) => message);
}
