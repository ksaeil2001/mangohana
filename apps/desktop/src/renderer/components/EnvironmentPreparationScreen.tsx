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
      <div className="environment-preparation-container">
        {/* Header */}
        <header className="environment-preparation-header">
          <div className="environment-preparation-header-left">
            <div className="environment-preparation-badge-row">
              <span className="environment-preparation-system-tag">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                시스템 진단 및 환경 점검
              </span>
            </div>
            <h1 ref={headingRef} tabIndex={-1}>망고하나 환경 준비</h1>
            <p className="environment-preparation-sub">로컬 OCR 엔진과 AI 모델의 실행 환경을 점검합니다.</p>
          </div>
          <div className="environment-preparation-header-actions">
            <button
              type="button"
              className="environment-preparation-back"
              onClick={onBack}
              aria-label={returnLabel}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
              <span>{returnLabel}</span>
              <kbd className="environment-esc-hint" aria-hidden="true">Esc</kbd>
            </button>
          </div>
        </header>

        {/* Error Notification Alert */}
        {errorMessage ? (
          <div className="environment-preparation-message-wrap" role="alert">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <p className="environment-preparation-message">{errorMessage}</p>
          </div>
        ) : null}

        {/* Storage Location Card */}
        <div className="environment-preparation-location-bar" aria-labelledby="environment-location-heading">
          <div className="environment-location-icon-box" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
          </div>
          <div className="environment-location-info">
            <div className="environment-location-top-row">
              <span id="environment-location-heading" className="environment-location-label">리소스 저장 위치</span>
              {snapshot?.canChangeResourceRoot ? (
                <span className="environment-location-status-badge">변경 가능</span>
              ) : null}
            </div>
            <code className="environment-location-path">{snapshot?.resourceRoot ?? "저장 위치를 확인하지 못했습니다."}</code>
            {isLoading || snapshot?.canChangeResourceRoot !== true ? (
              <span id={`${descriptionPrefix}-location-reason`} className="environment-location-hint">
                {isLoading ? "환경 작업 중에는 저장 위치를 변경할 수 없습니다." : "현재 환경 상태에서는 저장 위치를 변경할 수 없습니다."}
              </span>
            ) : null}
          </div>
          <div className="environment-location-action">
            <Button
              type="button"
              variant="secondary"
              onClick={onChooseResourceRoot}
              disabled={isLoading || snapshot?.canChangeResourceRoot !== true}
              aria-describedby={isLoading || snapshot?.canChangeResourceRoot !== true ? `${descriptionPrefix}-location-reason` : undefined}
            >
              저장 위치 변경
            </Button>
          </div>
        </div>

        {/* Components Section */}
        <section className="environment-preparation-components" aria-labelledby="environment-components-heading">
          <div className="environment-preparation-section-heading">
            <div className="environment-preparation-heading-title-group">
              <h2 id="environment-components-heading">구성요소 상태</h2>
              {snapshot ? (
                <span className="environment-components-count">
                  총 {snapshot.components.length}개 모듈 점검됨
                </span>
              ) : null}
            </div>
          </div>

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
            <div className="environment-preparation-empty">
              <div className="environment-empty-icon" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              </div>
              <p className="environment-empty-text">
                {isLoading ? "환경 상태를 확인하는 중입니다." : "준비 상태 확인 필요"}
              </p>
              <p className="environment-empty-sub">
                {isLoading ? "로컬 엔진과 모델 연결 상태를 진단하고 있습니다..." : "아래 [환경 다시 확인] 버튼을 눌러 점검을 시작하세요."}
              </p>
            </div>
          )}
        </section>

        {/* Footer Actions */}
        <footer className="environment-preparation-footer">
          <div className="environment-footer-left">
            <Button type="button" variant="secondary" onClick={onRefresh} disabled={isLoading}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: 6 }}>
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
              </svg>
              {isLoading ? "확인 중" : "환경 다시 확인"}
            </Button>
          </div>
          <div className="environment-footer-right">
            <Button type="button" variant="primary" onClick={onBack}>
              {returnLabel}
            </Button>
          </div>
        </footer>
      </div>
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
      {/* Status Mark Pill */}
      <div className="environment-component-indicator" aria-hidden="true" title={statusLabel(component.status)}>
        <span className={`environment-status-dot status-${component.status}`} />
      </div>

      <div className="environment-preparation-component-info">
        <div className="environment-preparation-component-title">
          <strong>{component.label}</strong>
          <span className="environment-preparation-capability-tag">{capabilityLabel(component.capability)}</span>
          {component.version ? <span className="environment-preparation-version-tag">v{component.version}</span> : null}
        </div>
        <div className="environment-preparation-component-desc">
          <p id={`${descriptionId}-message`}>{component.message}</p>
          {disabledReason ? <small id={`${descriptionId}-reason`}>{disabledReason}</small> : null}
        </div>
      </div>

      <div className="environment-preparation-component-actions">
        <span className={`environment-preparation-status-label status-${component.status}`}>
          {statusLabel(component.status)}
        </span>
        {component.id === "ocr" && component.status !== "ready" ? (
          <div className="environment-ocr-action-block">
            <Button
              type="button"
              variant="secondary"
              onClick={onInstallProductionOcr}
              disabled={isLoading}
              aria-describedby={`${descriptionId}-message${disabledReason ? ` ${descriptionId}-reason` : ""}${isLoading ? ` ${descriptionId}-busy` : ""}`}
            >
              Production OCR 설치/복구
            </Button>
            {isLoading ? <p id={`${descriptionId}-busy`} className="environment-busy-text">환경 작업 중에는 설치/복구를 다시 실행할 수 없습니다.</p> : null}
          </div>
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

function capabilityLabel(capability?: EnvironmentComponentState["capability"]): string {
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
