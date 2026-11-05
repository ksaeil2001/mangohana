import { Button } from "./Ui.js";
import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { RecentProject } from "../recentProjects.js";
import { AppShell, useAppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";
import "../mangohana-home.css";

export type ProjectHomeScreenProps = {
  recentProjects: RecentProject[];
  apiReady: boolean;
  projectSessionReady: boolean;
  sessionRetryAvailable: boolean;
  isImportingTxt: boolean;
  statusMessage?: string;
  unavailableRecentPath?: string | null;
  onNewProject: () => void;
  onResumeWorkspace?: () => void;
  onRetryProjectSession: () => void;
  onOpenProject: () => void;
  onOpenExample?: () => void;
  onOpenRecent: (recentProjectId: string) => void;
  onRemoveRecent: (recentProjectId: string) => void;
  onImportTxt: () => void;
  onOpenSettings: () => void;
  onOpenPreparation: () => void;
  onNavigate?: (nav: NavId) => void;
  onDropImages?: (files: File[]) => void;
};

export function ProjectHomeScreen(props: ProjectHomeScreenProps) {
  const handleNavigate = (nav: NavId) => {
    if (props.onNavigate) { props.onNavigate(nav); return; }
    switch (nav) {
      case "home": break;
      case "projects": case "files": props.onOpenProject(); break;
      case "ai": props.onOpenPreparation(); break;
      case "tools": props.onNewProject(); break;
      case "dictionary": case "settings": props.onOpenSettings(); break;
    }
  };
  return (
    <AppShell
      activeNav="home"
      recentProjects={props.recentProjects}
      onNavigate={handleNavigate}
      onOpenProject={props.onOpenProject}
      onOpenRecent={props.onOpenRecent}
      onOpenSettings={props.onOpenSettings}
      onResumeWorkspace={props.onResumeWorkspace}
      onOpenPreparation={props.onOpenPreparation}
      onNewProject={props.onNewProject}
      projectOpeningDisabledReason={props.apiReady ? undefined : "앱 파일 기능을 준비하고 있습니다."}
      unavailableRecentProjectId={props.unavailableRecentPath}
    >
      <ProjectHomeContent {...props} />
    </AppShell>
  );
}

function ProjectHomeContent(props: ProjectHomeScreenProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { openGuide } = useAppShell();
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const dragCounter = useRef(0);

  useEffect(() => { headingRef.current?.focus(); }, []);
  const preventDrop = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); };

  const handleDragEnter = (event: DragEvent) => {
    preventDrop(event);
    dragCounter.current += 1;
    if (event.dataTransfer?.items && event.dataTransfer.items.length > 0) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (event: DragEvent) => {
    preventDrop(event);
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDrop = (event: DragEvent) => {
    preventDrop(event);
    dragCounter.current = 0;
    setIsDragOver(false);
    setDropError(null);
    if (!props.apiReady) return;
    const items = Array.from(event.dataTransfer?.items ?? []);
    if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      setDropError("폴더 안의 JPG, PNG, WebP 이미지 파일을 직접 끌어다 놓으세요.");
      return;
    }
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const isAllImages = files.every((file) => /\.(png|jpe?g|webp)$/i.test(file.name));
    if (isAllImages && props.onDropImages) {
      if (!props.projectSessionReady) {
        setDropError("프로젝트 세션이 준비되면 이미지 파일을 추가할 수 있습니다.");
        return;
      }
      props.onDropImages(files);
    } else if (files.length === 1 && /\.ctp$/i.test(files[0]!.name)) {
      props.onOpenProject();
    } else {
      setDropError("JPG, PNG, WebP 이미지 파일만 추가할 수 있습니다. ZIP은 먼저 압축을 푸세요.");
    }
  };

  const fileReasonId = props.apiReady ? undefined : "home-file-readiness";
  const sessionReasonId = props.projectSessionReady ? undefined : "home-session-readiness";

  return (
    <div
      className="trio-page-container mangohana-home"
      onDragEnter={handleDragEnter}
      onDragOver={preventDrop}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="mangohana-home-intro">
        <h1 ref={headingRef} tabIndex={-1} aria-label="번역 프로젝트">만화 번역 작업실</h1>
        <div className="sr-only">
          {!props.apiReady && (
            <p id="home-file-readiness">앱 파일 기능을 준비하고 있습니다.</p>
          )}
          {!props.projectSessionReady && (
            <p id="home-session-readiness">프로젝트 세션이 준비되면 새 작업을 시작할 수 있습니다.</p>
          )}
        </div>
      </header>

      {/* Readiness / Alert banner (Shown only if there is an issue) */}
      {dropError && (
        <div className="project-home-status mangohana-feedback" role="alert">
          <p>{dropError}</p>
        </div>
      )}
      {(!props.projectSessionReady || props.sessionRetryAvailable || props.statusMessage) && (
        <div
          className="project-home-status mangohana-feedback"
          role={props.unavailableRecentPath || props.sessionRetryAvailable ? "alert" : "status"}
        >
          <p>{props.statusMessage || (props.sessionRetryAvailable ? "프로젝트 세션을 준비하지 못했습니다." : "프로젝트 세션을 준비 중입니다.")}</p>
          {props.sessionRetryAvailable && (
            <Button size="compact" onClick={props.onRetryProjectSession}>프로젝트 세션 다시 시도</Button>
          )}
          {props.unavailableRecentPath && (
            <Button
              size="compact"
              aria-label={`${props.recentProjects.find((p) => p.recentProjectId === props.unavailableRecentPath)?.title ?? "최근 프로젝트"} 최근 목록에서 제거`}
              onClick={() => props.onRemoveRecent(props.unavailableRecentPath!)}
            >
              목록에서 제거
            </Button>
          )}
        </div>
      )}

      <section className="mangohana-action-hub" aria-labelledby="home-start-heading">
        <h2 id="home-start-heading">이미지로 프로젝트 시작</h2>
        <div className="mangohana-action-cards">
          <div className={`mangohana-action-card${isDragOver && props.projectSessionReady ? " is-drag-over" : ""}`}>
            <p>{isDragOver && props.projectSessionReady ? "이미지 파일을 놓으세요." : "JPG, PNG, WebP 파일을 끌어다 놓거나 새 프로젝트를 만드세요."}</p>
            <Button
              variant="primary"
              className="project-home-new mangohana-start-button"
              aria-describedby={sessionReasonId}
              disabled={!props.projectSessionReady}
              onClick={props.onNewProject}
            >
              새 번역 프로젝트
            </Button>
          </div>
          <div className="mangohana-action-card">
            <p>저장한 .ctp 파일을 엽니다.</p>
            <Button
              variant="secondary"
              className="project-home-open mangohana-start-button"
              disabled={!props.apiReady}
              aria-describedby={fileReasonId}
              onClick={props.onOpenProject}
            >
              기존 프로젝트 열기
            </Button>
          </div>
        </div>
        <details className="mangohana-home-alternatives" open>
          <summary>다른 시작 방법</summary>
          <div className="mangohana-action-row">
            <Button
              size="compact"
              disabled={!props.projectSessionReady || props.isImportingTxt}
              aria-describedby={sessionReasonId}
              onClick={props.onImportTxt}
            >
              {props.isImportingTxt ? "TXT 불러오는 중" : "TXT로 시작"}
            </Button>
            {props.onOpenExample && (
              <Button
                size="compact"
                disabled={!props.apiReady}
                aria-describedby={fileReasonId}
                onClick={props.onOpenExample}
              >
                예시 프로젝트 열기
              </Button>
            )}
          </div>
        </details>
      </section>

      <section className="mangohana-recents" aria-labelledby="home-recent-heading">
        <div className="mangohana-section-heading">
          <h2 id="home-recent-heading">최근 프로젝트</h2>
          <span className="mangohana-count">{props.recentProjects.length}개</span>
        </div>

        {props.recentProjects.length > 0 ? (
          <ul className="mangohana-home-project-list">
            {props.recentProjects.map((project, index) => {
              const unavailable = project.recentProjectId === props.unavailableRecentPath;
              const reasonId = unavailable ? `home-recent-${index}-reason` : fileReasonId;
              return (
                <li key={project.recentProjectId}>
                  <div className="mangohana-home-project-name">
                    <button
                      type="button"
                      className="mangohana-recent-title project-home-recent-open"
                      aria-label={`최근 프로젝트 ${project.title} 열기`}
                      aria-describedby={reasonId}
                      disabled={!props.apiReady || unavailable}
                      onClick={() => props.onOpenRecent(project.recentProjectId)}
                    >
                      {project.title}
                    </button>
                    {unavailable && (
                      <span id={reasonId} className="mangohana-recent-unavailable">파일을 찾을 수 없음</span>
                    )}
                  </div>
                  <time dateTime={project.openedAt}>{formatOpenedAt(project.openedAt)}</time>
                  {unavailable && (
                    <Button size="compact" onClick={() => props.onRemoveRecent(project.recentProjectId)}>
                      삭제
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="mangohana-home-empty">
            <h3>최근 프로젝트 없음</h3>
            <Button
              size="compact"
              disabled={!props.apiReady}
              aria-describedby={fileReasonId}
              aria-label="빈 상태에서 기존 .ctp 프로젝트 선택"
              onClick={props.onOpenProject}
            >
              기존 .ctp 열기
            </Button>
          </div>
        )}
      </section>

      {/* Readiness & System Status Footer */}
      <footer
        className="mangohana-home-footer"
        role="region"
        aria-label="현재 준비 상태"
      >
        <div className="mangohana-home-footer-status">
          <span
            className="mangohana-status-dot"
            data-ready={props.apiReady && props.projectSessionReady}
          />
          <span>{!props.apiReady ? "파일 기능 준비 중" : props.projectSessionReady ? "프로젝트 시작 가능" : "세션 준비 중"}</span>
        </div>
        <div className="mangohana-home-footer-actions">
          <Button size="compact" onClick={props.onOpenPreparation}>환경 준비</Button>
          <Button size="compact" onClick={props.onOpenSettings}>설정</Button>
          <Button size="compact" variant="tertiary" onClick={() => openGuide("망고하나 사용 시작하기")}>사용 안내</Button>
        </div>
      </footer>
    </div>
  );
}

function formatOpenedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "날짜 정보 없음";

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffMs >= 0) {
    if (diffMinutes < 1) return "방금 전";
    if (diffMinutes < 60) return `${diffMinutes}분 전`;
    if (diffHours < 24 && now.toDateString() === date.toDateString()) {
      return `오늘 ${date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
    }
  }

  return date.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
