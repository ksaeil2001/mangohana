import { RuntimeStatusControl } from "./RuntimeStatusControl";
import { useState, useRef, useEffect } from "react";
import type { GuidedStage } from "../guidedWorkflow";
import type { AutoUpdateState } from "../../shared/autoUpdateStatus";
import mangohanaIcons from "../brand/mangohana-icons.svg?no-inline";
import mangohanaMark from "../brand/mangohana-mark.svg";

export interface WorkbenchTopBarProps {
  environmentSnapshot?: any;
  environmentLoading?: boolean;
  currentIssue?: any;
  title: string;
  currentFilePath?: string | null;
  saveLabel: string;
  isDirty: boolean;
  unappliedDraftCount: number;
  statusMessage?: string;
  currentPage: number;
  pageCount: number;
  currentStage: GuidedStage;
  nextActionLabel: string;
  nextActionDisabled?: boolean;
  onNextAction: () => void;
  onBatchAuto: () => void;
  batchAutoDisabled?: boolean;
  onGoHome: () => void;
  onSelectPage: (page: number) => void;
  onSave: () => void;
  onSaveAs: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onExportTxt: () => void;
  onExportImages: () => void;
  exportImagesBusy?: boolean;
  onOpenPreparation: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  autoUpdateState: AutoUpdateState;
  onCheckUpdate: () => void;
  finalReading: boolean;
  onToggleFinalReading: () => void;
  issueCount: number;
  onOpenIssues: () => void;
  sessionNeedsRecovery?: boolean;
  recoveryMessage?: string;
  onRecoverSession?: () => void;
}

const STAGES: Array<{ key: GuidedStage; label: string }> = [
  { key: "ocr", label: "인식" },
  { key: "speaker", label: "화자" },
  { key: "translation", label: "번역" },
  { key: "complete", label: "식자" },
];

export function WorkbenchTopBar(props: WorkbenchTopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const currentStageIndex = STAGES.findIndex((s) => s.key === props.currentStage);

  return (
    <header className="app-top-bar inkline-command-bar mangohana-workbench-top" role="banner" aria-label="앱 상단 바">
      <p className="sr-only" role="status" aria-label="작업 상태" aria-atomic="true">
        {props.statusMessage}
      </p>
      <p className="top-file-path sr-only">{props.currentFilePath ?? "선택된 프로젝트 파일이 없습니다."}</p>

      {/* 1. Left: Home button, Title & Save Status */}
      <div className="top-section-left">
        <button
          type="button"
          className="mangohana-top-home-button"
          onClick={props.onGoHome}
          aria-label="홈으로 돌아가기"
          title="작업실 홈으로 돌아가기"
        >
          <svg className="mangohana-icon" aria-hidden="true">
            <use href={`${mangohanaIcons}#arrow-left`} />
          </svg>
        </button>

        {props.currentIssue ? (
          <span
            className="sr-only"
            data-testid="current-issue"
            data-issue-id={props.currentIssue.lineId}
            data-issue-kind={props.currentIssue.kind}
            aria-label={`현재 문제 확인 ${props.currentIssue.line.order}`}
          >
            {props.currentIssue.line.sourceText}
          </span>
        ) : null}
        <div className="app-top-brand">
          <img className="mangohana-workspace-mark" src={mangohanaMark} alt="" aria-hidden="true" />
          <h1>망고하나</h1>
          <span className="sr-only" aria-hidden="true">대사 편집기</span>
          <span className="workspace-product-type" title={props.title}>{props.title}</span>
          <button
            type="button"
            className={props.isDirty ? "top-save-state dirty" : "top-save-state"}
            data-status-tone={props.saveLabel === "저장됨" ? "success" : props.saveLabel === "새 프로젝트" ? "neutral" : "warning"}
            onClick={props.onSave}
            title={props.isDirty ? "변경사항 저장 (Ctrl+S)" : "저장됨"}
          >
            <span className="save-dot" aria-hidden="true" />
            <span className="top-save-state">{props.saveLabel}</span>
          </button>
          {props.unappliedDraftCount > 0 && (
            <span
              className="top-save-state dirty"
              title="OCR, 배경 마스크 또는 글자 배치 초안은 적용하기 전까지 프로젝트 저장에 포함되지 않습니다."
            >
              미적용 {props.unappliedDraftCount}
            </span>
          )}
        </div>
      </div>

      {/* 2. Center: Page Navigation & 5-Stage Stepper */}
      <div className="top-section-center">
        <div className="mangohana-page-navigator" aria-label="헤더 페이지 이동">
          <button
            type="button"
            className="nav-arrow"
            onClick={() => props.onSelectPage(props.currentPage - 1)}
            disabled={props.currentPage <= 1}
            aria-label="헤더 이전 페이지"
          >
            ‹
          </button>
          <span className="nav-page-display">
            <strong>{props.currentPage}</strong> / {props.pageCount}
          </span>
          <button
            type="button"
            className="nav-arrow"
            onClick={() => props.onSelectPage(props.currentPage + 1)}
            disabled={props.currentPage >= props.pageCount}
            aria-label="헤더 다음 페이지"
          >
            ›
          </button>
        </div>

        <div className="mangohana-pipeline-stepper" aria-label="작업 파이프라인 단계">
          {STAGES.map((s, idx) => {
            const isCompleted = currentStageIndex > idx;
            const isCurrent = currentStageIndex === idx;
            return (
              <span
                key={s.key}
                className={`step-chip ${isCompleted ? "completed" : isCurrent ? "current" : "upcoming"}`}
              >
                {isCompleted ? "✓ " : isCurrent ? "● " : ""}{s.label}
              </span>
            );
          })}
        </div>
      </div>

      {/* 3. Right: Primary CTA, Batch Auto & Tools Popover */}
      <div className="top-section-right" role="group" aria-label="작업 실행">
        <details className="top-utility-menu">
          <summary aria-label="작업 도구와 상태 열기" title="작업 도구와 상태">도구</summary>
          <div className="top-utility-menu-content">
            <RuntimeStatusControl
              snapshot={props.environmentSnapshot}
              isLoading={props.environmentLoading}
              onOpenPreparation={props.onOpenPreparation}
            />
            <button
              type="button"
              onClick={props.onGoHome}
              title="작업실 홈으로 돌아가기"
            >
              작업실 홈
            </button>
            <button
              type="button"
              className="theme-toggle"
              aria-label={props.theme === "light" ? "다크 테마로 전환" : "라이트 테마로 전환"}
              title={props.theme === "light" ? "다크 테마로 전환" : "라이트 테마로 전환"}
              onClick={props.onToggleTheme}
            >
              {props.theme === "light" ? "다크 테마" : "라이트 테마"}
            </button>
          </div>
        </details>
        {/* Compact Batch Auto button */}
        <button
          type="button"
          className="top-batch-primary-action secondary-batch-btn"
          aria-label="일괄 자동화"
          title="전체 페이지 번역·식자 일괄 실행"
          onClick={props.onBatchAuto}
          disabled={props.batchAutoDisabled}
        >
          ⚡ 자동
        </button>

        {/* Primary Next Step CTA Button */}
        <button
          type="button"
          className="top-next-action-btn"
          onClick={props.onNextAction}
          disabled={props.nextActionDisabled}
          aria-label={props.nextActionLabel}
        >
          {props.nextActionLabel}
        </button>

        {/* Popover Menu Trigger */}
        <div className="top-menu-container" ref={menuRef}>
          <button
            type="button"
            className="top-menu-trigger"
            aria-label="추가 메뉴"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            title="프로젝트 및 환경 도구"
          >
            ☰
          </button>

          {menuOpen && (
            <div className="top-popover-menu" role="menu">
              <div className="menu-group">
                <span className="menu-group-label">프로젝트</span>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onSave(); }}>
                  저장 (Ctrl+S)
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onSaveAs(); }}>
                  다른 이름으로 저장...
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onNewProject(); }}>
                  새 프로젝트 (Ctrl+N)
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onOpenProject(); }}>
                  프로젝트 열기... (Ctrl+O)
                </button>
              </div>

              <div className="menu-divider" />

              <div className="menu-group">
                <span className="menu-group-label">내보내기</span>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); props.onExportImages(); }}
                  disabled={props.exportImagesBusy}
                >
                  {props.exportImagesBusy ? "이미지 내보내는 중..." : "완성 이미지 내보내기 (ZIP)"}
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onExportTxt(); }}>
                  번역 대사 TXT 내보내기
                </button>
              </div>

              <div className="menu-divider" />

              <div className="menu-group">
                <span className="menu-group-label">보기 및 도구</span>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); props.onToggleFinalReading(); }}
                >
                  {props.finalReading ? "대사 편집으로 복귀" : "최종 읽기 모드로 보기"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); props.onOpenIssues(); }}
                >
                  확인 필요 대사 ({props.issueCount}개)
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onOpenPreparation(); }}>
                  AI 및 OCR 환경 점검
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onCheckUpdate(); }}>
                  앱 업데이트 확인
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onToggleTheme(); }}>
                  {props.theme === "light" ? "다크 테마로 전환" : "라이트 테마로 전환"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Accessible test hooks */}
      <div className="top-file-actions sr-only" role="group" aria-label="파일 작업">
        <button type="button" onClick={props.onOpenProject}>열기</button>
        <button type="button" onClick={props.onSave} disabled={props.sessionNeedsRecovery}>저장</button>
        <button type="button" aria-label="새로 만들기" onClick={props.onNewProject}>새 프로젝트</button>
        <button type="button" aria-label="다른 이름 저장" onClick={props.onSaveAs} disabled={props.sessionNeedsRecovery}>다른 이름</button>
        <button type="button" aria-label="TXT 내보내기" onClick={props.onExportTxt} disabled={props.sessionNeedsRecovery}>내보내기</button>
        <button type="button" aria-label="전체 프로젝트 이미지 내보내기" title="전체 페이지 완성 이미지 내보내기 (ZIP, original 보존)" onClick={props.onExportImages} disabled={props.sessionNeedsRecovery || props.exportImagesBusy}>이미지 내보내기</button>
        <button type="button" aria-label={props.finalReading ? "대사 편집으로 돌아가기" : "전체 페이지 최종 읽기"} onClick={props.onToggleFinalReading}>{props.finalReading ? "대사 편집으로 돌아가기" : "최종 읽기"}</button>
        <button type="button" aria-label="확인 필요 대사 목록 열기" onClick={props.onOpenIssues}>확인 필요 {props.issueCount}</button>
      </div>

      {props.sessionNeedsRecovery && (
        <div className="processing-queue-notice" role="alert">
          <p>{props.recoveryMessage || "프로젝트 세션 복구가 필요합니다."}</p>
          {props.onRecoverSession && (
            <button type="button" onClick={props.onRecoverSession}>
              세션 복구하기
            </button>
          )}
        </div>
      )}
    </header>
  );
}
