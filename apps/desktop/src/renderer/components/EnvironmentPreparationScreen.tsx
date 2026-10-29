import { Button } from "./Ui.js";
import { useEffect, useId, useRef } from "react";
import type {
  EnvironmentComponentState,
  EnvironmentPreparationSnapshot
} from "../../shared/environmentPreparation.js";
import type { PreparationReturnScreen } from "../entryFlow.js";

export type EnvironmentPreparationScreenProps = {
  snapshot: EnvironmentPreparationSnapshot | null;
  returnTarget: PreparationReturnScreen;
  isLoading: boolean;
  errorMessage?: string;
  onRefresh: () => void;
  onChooseResourceRoot: () => void;
  onInstallProductionOcr: () => void;
  onBack: () => void;
};

export function EnvironmentPreparationScreen({
  snapshot,
  returnTarget,
  isLoading,
  errorMessage,
  onRefresh,
  onChooseResourceRoot,
  onInstallProductionOcr,
  onBack
}: EnvironmentPreparationScreenProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const descriptionPrefix = useId();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    headingRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented) {
        e.preventDefault();
        onBackRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const returnLabel =
    returnTarget === "workspace"
      ? "작업대로 돌아가기"
      : returnTarget === "home"
        ? "프로젝트 홈으로"
        : "이전 화면으로";

  return (
    <main className="environment-preparation-screen stitch-flow stitch-flow--environment" aria-busy={isLoading}>
      <header className="environment-preparation-header">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>망고하나 환경 준비</h1>
        </div>
        <button type="button" className="environment-preparation-back" onClick={onBack}>
          {returnLabel}
        </button>
      </header>

      {errorMessage ? (
        <p className="environment-preparation-message" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className="stitch-environment-layout">
      <div className="stitch-environment-diagnostics">
      <section className="environment-preparation-overview" aria-label="환경 준비 요약">
        <div>
          <span className="environment-preparation-label">작업대 진입</span>
          <strong>{snapshot === null ? "준비 상태 확인 필요" : snapshot.canOpenWorkbench ? "이미지 열람 가능" : "준비 필요"}</strong>
          <p>이미지 열람은 모델 설치와 별개입니다.</p>
        </div>
        <div className="environment-preparation-progress">
          <span className="environment-preparation-label">전체 진행</span>
          {snapshot?.overallProgress === null || snapshot === null ? (
            <strong>{isLoading ? "상태 확인 중" : snapshot === null ? "준비 상태를 확인하지 못했습니다." : "구성요소별 상태 확인"}</strong>
          ) : (
            <>
              <progress max={100} value={snapshot.overallProgress} />
              <strong>{Math.round(snapshot.overallProgress)}%</strong>
            </>
          )}
        </div>
      </section>

      <section className="environment-preparation-components" aria-labelledby="environment-components-heading">
        <div className="environment-preparation-section-heading">
          <div>
            <h2 id="environment-components-heading">구성요소 상태</h2>
            <p>준비된 다른 기능은 계속 사용할 수 있습니다.</p>
          </div>
        </div>
        <div className="stitch-environment-columns" aria-hidden="true"><span>구성요소 / 목적</span><span>진단 및 사용 조건</span><span>상태 / 다음 행동</span></div>
        {snapshot ? (
          <ul className="environment-preparation-component-list">
            {snapshot.components.map((component) => (
              <EnvironmentComponentRow
                key={component.id}
                component={component}
                onInstallProductionOcr={onInstallProductionOcr}
                isLoading={isLoading}
              />
            ))}
          </ul>
        ) : (
          <p className="environment-preparation-empty">{isLoading ? "환경 상태를 확인하는 중입니다." : "환경 상태를 확인하지 못했습니다. 환경 다시 확인을 눌러 재시도하세요."}</p>
        )}
      </section>
      </div>
      <aside className="environment-preparation-location" aria-labelledby="environment-location-heading">
        <div>
          <span className="stitch-flow-kicker">로컬 리소스</span>
          <h2 id="environment-location-heading">리소스 저장 위치</h2>
          <code>{snapshot?.resourceRoot ?? "저장 위치를 확인하지 못했습니다."}</code>
          {isLoading || snapshot?.canChangeResourceRoot !== true ? (
            <p id={`${descriptionPrefix}-location-reason`}>
              {isLoading ? "환경 작업 중에는 저장 위치를 변경할 수 없습니다." : "현재 환경 상태에서는 저장 위치를 변경할 수 없습니다."}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={onChooseResourceRoot}
          disabled={isLoading || snapshot?.canChangeResourceRoot !== true}
          aria-describedby={isLoading || snapshot?.canChangeResourceRoot !== true ? `${descriptionPrefix}-location-reason` : undefined}
        >
          저장 위치 변경
        </Button>
      </aside>
      </div>

      <footer className="environment-preparation-footer">
        <Button type="button" variant="secondary" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? "확인 중" : "환경 다시 확인"}
        </Button>
        <Button type="button" variant="primary" onClick={onBack}>
          {returnLabel}
        </Button>
      </footer>
    </main>
  );
}

function EnvironmentComponentRow({
  component,
  onInstallProductionOcr,
  isLoading
}: {
  component: EnvironmentComponentState;
  onInstallProductionOcr: () => void;
  isLoading: boolean;
}) {
  const descriptionId = useId();
  const disabledReason = component.disabledReason?.trim() === component.message.trim()
    ? undefined
    : component.disabledReason;
  return (
    <li className="environment-preparation-component-row" aria-label={`${component.label} 구성요소`} data-status={component.status}>
      <span className="environment-preparation-status-mark" aria-hidden="true" />
      <div className="environment-preparation-component-main">
        <div className="environment-preparation-component-title">
          <strong>{component.label}</strong>
          <div className="environment-preparation-component-meta">
            <span>{component.version ?? "—"}</span>
            <span>{capabilityLabel(component.capability)}</span>
          </div>
        </div>
      </div>
      <div className="stitch-environment-reason">
        <p id={`${descriptionId}-message`}>{component.message}</p>
        {disabledReason ? <small id={`${descriptionId}-reason`}>{disabledReason}</small> : null}
      </div>
      <div className="environment-preparation-component-state">
        <span className="environment-preparation-status-label">{statusLabel(component.status)}</span>
        {component.id === "ocr" && component.status !== "ready" ? (
          <>
          <Button
            type="button"
            variant="secondary"
            onClick={onInstallProductionOcr}
            disabled={isLoading}
            aria-describedby={`${descriptionId}-message${disabledReason ? ` ${descriptionId}-reason` : ""}${isLoading ? ` ${descriptionId}-busy` : ""}`}
          >
            Production OCR 설치/복구
          </Button>
          {isLoading ? <p id={`${descriptionId}-busy`}>환경 작업 중에는 설치/복구를 다시 실행할 수 없습니다.</p> : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

function statusLabel(status: EnvironmentComponentState["status"]): string {
  switch (status) {
    case "checking":
      return "확인 중";
    case "queued":
      return "설치 대기";
    case "downloading":
      return "설치 중";
    case "paused":
      return "일시정지";
    case "verifying":
      return "검증 중";
    case "installing":
      return "등록 중";
    case "ready":
      return "준비됨";
    case "update-available":
      return "업데이트 가능";
    case "repairable":
      return "복구 필요";
    case "blocked":
      return "사용할 수 없음";
  }
}

function capabilityLabel(capability: EnvironmentComponentState["capability"]): string {
  switch (capability) {
    case "image-viewing":
      return "이미지 열람";
    case "ocr":
      return "OCR";
    case "translation":
      return "번역";
    case "inpainting":
      return "인페인팅";
    default:
      return "공통 환경";
  }
}
