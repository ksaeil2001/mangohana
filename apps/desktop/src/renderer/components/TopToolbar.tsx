import type { ReactNode } from "react";
import type { AutoUpdateState } from "../../shared/autoUpdateStatus";
import { isEnvironmentComponentUsable, type EnvironmentPreparationSnapshot } from "../../shared/environmentPreparation";

export interface TopToolbarProps {
  /* --- Page navigation --- */
  currentPage: number;
  pageCount: number;
  showPageControls: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;

  /* --- Save state --- */
  saveLabel: string;
  isDirty: boolean;

  /* --- File actions --- */
  showFileActions: boolean;
  showSave: boolean;
  showSaveAs: boolean;
  showExport: boolean;
  apiReady: boolean;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onExportTranslations: () => void;
  onExportRenderedImage?: () => void;
  onOpenBatchAutomation?: () => void;

  /* --- Settings --- */
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsPanel: ReactNode;

  /* --- Utilities --- */
  environmentSnapshot: EnvironmentPreparationSnapshot | null;
  environmentLoading: boolean;
  onOpenPreparation: () => void;
  autoUpdateState: AutoUpdateState;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onOpenRelease: () => void;
  uiTheme: "light" | "dark";
  onToggleTheme: () => void;

  /* --- Status message & issue (sr-only) --- */
  statusMessage: string;
  currentIssue: { lineId: string; kind: string; line: { order: number; sourceText: string } } | null;

  /* --- Workflow stage labels --- */
  workflowStages: ReactNode;

  /* --- Focus mode --- */
  focusMode: boolean;
  onToggleFocusMode: () => void;
  showWorkspaceChrome: boolean;

  /* --- Precision notice --- */
  showPrecisionNotice: boolean;
}

export function TopToolbar({
  currentPage,
  pageCount,
  showPageControls,
  onPreviousPage,
  onNextPage,
  saveLabel,
  isDirty,
  showFileActions,
  showSave,
  showSaveAs,
  showExport,
  apiReady,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onExportTranslations,
  onExportRenderedImage,
  onOpenBatchAutomation,
  settingsOpen,
  onToggleSettings,
  settingsPanel,
  environmentSnapshot,
  environmentLoading,
  onOpenPreparation,
  autoUpdateState,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenRelease,
  uiTheme,
  onToggleTheme,
  statusMessage,
  currentIssue,
  workflowStages,
  focusMode,
  onToggleFocusMode,
  showWorkspaceChrome,
  showPrecisionNotice
}: TopToolbarProps) {
  return (
    <header className="trio-top-toolbar" role="banner" aria-label="상단 툴바">
      {/* Screen-reader only status announcements */}
      <p className="sr-only" role="status" aria-label="작업 상태" aria-atomic="true">
        {statusMessage}
      </p>
      {currentIssue ? (
        <span
          className="sr-only"
          data-testid="current-issue"
          data-issue-id={currentIssue.lineId}
          data-issue-kind={currentIssue.kind}
          aria-label={`현재 문제 라인 ${currentIssue.line.order}`}
        >
          {currentIssue.line.sourceText}
        </span>
      ) : null}

      {/* Left section: Page navigation */}
      <div className="trio-toolbar-left">
        {showPageControls ? (
          <div className="trio-toolbar-page-nav" aria-label="페이지 이동">
            <button
              type="button"
              className="trio-toolbar-btn"
              onClick={onPreviousPage}
              disabled={currentPage <= 1}
              aria-label="이전 페이지"
              title="이전 페이지"
            >
              ←
            </button>
            <span className="trio-toolbar-page-indicator" aria-label="현재 페이지">
              {currentPage} / {pageCount}
            </span>
            <button
              type="button"
              className="trio-toolbar-btn"
              onClick={onNextPage}
              disabled={currentPage >= pageCount}
              aria-label="다음 페이지"
              title="다음 페이지"
            >
              →
            </button>
          </div>
        ) : null}
        <span className={isDirty ? "trio-toolbar-save-state dirty" : "trio-toolbar-save-state"}>
          {saveLabel}
        </span>
      </div>

      {/* Center section: Workflow stages */}
      <div className="trio-toolbar-center">
        {workflowStages}
      </div>

      {/* Right section: File actions + utilities */}
      <div className="trio-toolbar-right">
        {showFileActions ? (
          <div className="trio-toolbar-file-actions" role="group" aria-label="파일 작업">
            <button type="button" className="trio-toolbar-btn" aria-label="새로 만들기" onClick={onNewProject}>
              새 프로젝트
            </button>
            <button
              type="button"
              className="trio-toolbar-btn"
              onClick={onOpenProject}
              disabled={!apiReady}
            >
              열기
            </button>
            {showSave ? (
              <button type="button" className="trio-toolbar-btn" onClick={onSaveProject}>
                저장
              </button>
            ) : null}
            {showSaveAs ? (
              <button type="button" className="trio-toolbar-btn" aria-label="다른 이름 저장" onClick={onSaveProjectAs}>
                다른 이름
              </button>
            ) : null}
            {showExport ? (
              <button type="button" className="trio-toolbar-btn" aria-label="TXT 내보내기" onClick={onExportTranslations}>
                내보내기
              </button>
            ) : null}
            {showExport && onExportRenderedImage ? (
              <button
                type="button"
                className="trio-toolbar-btn"
                aria-label="전체 프로젝트 이미지 내보내기"
                title="전체 페이지의 original·cleaned·typeset 결과를 폴더와 ZIP으로 내보냅니다"
                onClick={onExportRenderedImage}
              >
                이미지 내보내기
              </button>
            ) : null}
            {onOpenBatchAutomation ? (
              <button
                type="button"
                className="trio-toolbar-btn"
                aria-label="일괄 자동화"
                title="전체 페이지 번역·식자 일괄 실행"
                onClick={onOpenBatchAutomation}
              >
                ⚡ 일괄 자동화
              </button>
            ) : null}
          </div>
        ) : null}

        <details className="trio-toolbar-utility-menu">
          <summary aria-label="작업 도구와 상태 열기" title="작업 도구와 상태">도구</summary>
          <div className="trio-toolbar-utility-content">
            <RuntimeStatusInline
              snapshot={environmentSnapshot}
              isLoading={environmentLoading}
              onOpenPreparation={onOpenPreparation}
            />
            <AutoUpdateInline
              state={autoUpdateState}
              onCheck={onCheckUpdate}
              onDownload={onDownloadUpdate}
              onInstall={onInstallUpdate}
              onOpenRelease={onOpenRelease}
              isDirty={isDirty}
            />
            <button
              type="button"
              className="trio-toolbar-btn"
              aria-label={uiTheme === "light" ? "다크 테마로 전환" : "라이트 테마로 전환"}
              title={uiTheme === "light" ? "다크 테마로 전환" : "라이트 테마로 전환"}
              onClick={onToggleTheme}
            >
              {uiTheme === "light" ? "다크 테마" : "라이트 테마"}
            </button>
          </div>
        </details>

        <button
          type="button"
          className="trio-toolbar-btn"
          aria-label="설정"
          aria-expanded={settingsOpen}
          aria-controls="workspace-project-settings"
          title={settingsOpen ? "설정 닫기" : "설정 열기"}
          onClick={onToggleSettings}
        >
          설정
        </button>

        {showWorkspaceChrome ? (
          <button
            type="button"
            className="trio-toolbar-btn trio-toolbar-focus-toggle"
            aria-pressed={focusMode}
            aria-label={focusMode ? "집중 모드 끄기" : "집중 모드 켜기"}
            title={focusMode ? "집중 모드 끄기 (Ctrl+B)" : "집중 모드 켜기 (Ctrl+B)"}
            onClick={onToggleFocusMode}
          >
            {focusMode ? "해제" : "집중"}
          </button>
        ) : null}
      </div>

      {/* Settings panel dropdown */}
      {settingsOpen ? (
        <section
          id="workspace-project-settings"
          className="trio-toolbar-settings-panel"
          role="region"
          aria-label="프로젝트 설정"
        >
          {settingsPanel}
        </section>
      ) : null}

      {/* Precision notice */}
      {showPrecisionNotice ? (
        <p className="trio-toolbar-precision-notice" role="status" aria-label="정밀 편집 안내" data-testid="workspace-precision-notice">
          창이 작아 정밀 편집을 잠시 비활성화했습니다. 이미지 열람, 페이지 이동, OCR, 수동 번역, 저장은 계속 사용할 수 있습니다.
        </p>
      ) : null}
    </header>
  );
}

/* --- Inline sub-components for the utility menu --- */

function RuntimeStatusInline({
  snapshot,
  isLoading,
  onOpenPreparation
}: {
  snapshot: EnvironmentPreparationSnapshot | null;
  isLoading: boolean;
  onOpenPreparation: () => void;
}) {
  if (!snapshot) return null;
  const components = Array.isArray(snapshot.components) ? snapshot.components : [];
  const hasIssue = components.some((c) => !isEnvironmentComponentUsable(c));
  const label = hasIssue ? "환경 문제 있음" : "환경 준비됨";
  return (
    <button
      type="button"
      className="trio-toolbar-btn trio-toolbar-runtime"
      data-status={hasIssue ? "warning" : "ready"}
      aria-label={label}
      aria-busy={isLoading}
      title={label}
      onClick={onOpenPreparation}
    >
      <span className="trio-toolbar-status-dot" aria-hidden="true" />
      <span>{hasIssue ? "환경 문제" : "환경 준비"}</span>
    </button>
  );
}

function AutoUpdateInline({
  state,
  onCheck,
  onDownload,
  onInstall,
  onOpenRelease,
  isDirty
}: {
  state: AutoUpdateState;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onOpenRelease: () => void;
  isDirty: boolean;
}) {
  const status = state.status;
  if (status === "idle" || status === "up-to-date") {
    return (
      <button type="button" className="trio-toolbar-btn" onClick={onCheck} aria-label="업데이트 확인">
        업데이트 확인
      </button>
    );
  }
  if (status === "available") {
    return (
      <div className="trio-toolbar-update-group">
        <button type="button" className="trio-toolbar-btn" onClick={onDownload}>다운로드</button>
        <button type="button" className="trio-toolbar-btn" onClick={onOpenRelease}>릴리스 보기</button>
      </div>
    );
  }
  if (status === "downloading") {
    return (
      <span className="trio-toolbar-update-progress" aria-label={`업데이트 다운로드 ${Math.round(state.progress ?? 0)}%`}>
        다운로드 {Math.round(state.progress ?? 0)}%
      </span>
    );
  }
  if (status === "ready-to-install") {
    return (
      <div className="trio-toolbar-update-group">
        <button
          type="button"
          className="trio-toolbar-btn"
          onClick={onInstall}
          disabled={isDirty}
          title={isDirty ? "저장 후 재시작하세요" : "재시작하여 설치"}
        >
          {isDirty ? "저장 후 재시작" : "재시작하여 설치"}
        </button>
        <button type="button" className="trio-toolbar-btn" onClick={onOpenRelease}>릴리스 보기</button>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="trio-toolbar-update-group">
        <span className="trio-toolbar-update-error">업데이트 오류</span>
        <button type="button" className="trio-toolbar-btn" onClick={onCheck}>다시 시도</button>
      </div>
    );
  }
  return null;
}
