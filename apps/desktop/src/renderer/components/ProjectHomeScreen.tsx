import { Button } from "./Ui.js";
import { useEffect, useRef } from "react";
import type { DragEvent } from "react";
import type { RecentProject } from "../recentProjects.js";
import { AppShell, useAppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";
import mangohanaIcons from "../brand/mangohana-icons.svg?no-inline";
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
  return <AppShell activeNav="home" recentProjects={props.recentProjects} onNavigate={handleNavigate}
    onOpenProject={props.onOpenProject} onOpenRecent={props.onOpenRecent} onOpenSettings={props.onOpenSettings} onResumeWorkspace={props.onResumeWorkspace}
    onOpenPreparation={props.onOpenPreparation} onNewProject={props.onNewProject}
    projectOpeningDisabledReason={props.apiReady ? undefined : "앱 파일 기능을 준비하고 있습니다."} unavailableRecentProjectId={props.unavailableRecentPath}>
    <ProjectHomeContent {...props} />
  </AppShell>;
}

function ProjectHomeContent(props: ProjectHomeScreenProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { openGuide } = useAppShell();
  useEffect(() => { headingRef.current?.focus(); }, []);
  const preventDrop = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); };
  const fileReasonId = props.apiReady ? undefined : "home-file-readiness";
  const sessionReasonId = props.projectSessionReady ? undefined : "home-session-readiness";
  return <div className="trio-page-container mangohana-home" onDragOver={preventDrop} onDrop={(event) => {
    preventDrop(event);
    if (props.apiReady) props.onOpenProject();
  }}>
    <header className="mangohana-home-intro">
      <h1 ref={headingRef} tabIndex={-1} aria-label="번역 프로젝트">만화 번역 작업실</h1>
    </header>
    <div className="mangohana-entry-grid">
        <section className="mangohana-entry mangohana-entry--new" aria-labelledby="home-start-heading">
          <svg className="mangohana-entry-icon" aria-hidden="true"><use href={`${mangohanaIcons}#image`} /></svg>
          <h2 id="home-start-heading">이미지로 프로젝트 시작</h2>
          <p>이미지 선택 · 페이지 순서 정리</p>
          <Button variant="primary" className="project-home-new mangohana-start-button" aria-label="새 번역 프로젝트" aria-describedby={sessionReasonId}
            disabled={!props.projectSessionReady} onClick={props.onNewProject}>
            <svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#plus`} /></svg>
            새 번역 프로젝트
          </Button>
          {!props.projectSessionReady && <p id={sessionReasonId} className="mangohana-note">프로젝트 세션이 준비되면 새 작업을 시작할 수 있습니다.</p>}
            <details className="mangohana-txt-disclosure">
              <summary>다른 시작 방법</summary>
              <p className="mangohana-note">대사 TXT 파일을 가져와 프로젝트를 시작합니다.</p>
              <Button disabled={!props.projectSessionReady || props.isImportingTxt} onClick={props.onImportTxt} aria-describedby={props.isImportingTxt ? "home-txt-progress" : sessionReasonId}
                aria-label={props.isImportingTxt ? "TXT 불러오는 중" : "TXT로 시작"}>
                {props.isImportingTxt ? "TXT 불러오는 중" : "TXT 불러오기"}
              </Button>
              {props.isImportingTxt && <p id="home-txt-progress" className="mangohana-note" role="status">TXT 파일을 불러오고 있습니다. 잠시 기다려 주세요.</p>}
            </details>
        </section>
        <section className="mangohana-entry mangohana-entry--open" aria-labelledby="home-open-heading">
          <svg className="mangohana-entry-icon" aria-hidden="true"><use href={`${mangohanaIcons}#folder`} /></svg>
          <h2 id="home-open-heading">작업하던 곳에서 다시</h2>
          <p>.ctp 프로젝트 불러오기</p>
          <Button className="project-home-open mangohana-start-button" disabled={!props.apiReady} aria-describedby={fileReasonId} onClick={props.onOpenProject}>
            기존 프로젝트 열기<svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#arrow-right`} /></svg>
          </Button>
          <div className="mangohana-example-start">
            <Button size="compact" disabled={!props.apiReady || !props.onOpenExample} onClick={props.onOpenExample} aria-describedby="home-example-description">예시 프로젝트 열기</Button>
            <p id="home-example-description" className="mangohana-note">합성 예시 · 임시 복사본 · AI 결과 아님</p>
          </div>
          {!props.apiReady && <p id={fileReasonId} className="mangohana-note">앱 파일 기능을 준비하고 있습니다.</p>}
        </section>
    </div>
    <div className="mangohana-home-lower">
      <section className="mangohana-recents" aria-labelledby="home-recent-heading">
        <div className="mangohana-section-heading"><div><span className="mangohana-eyebrow">계속하기</span><h2 id="home-recent-heading">최근 프로젝트</h2></div>
          <span className="mangohana-count">{props.recentProjects.length}개</span></div>
        {props.recentProjects.length ? <ul className="mangohana-recent-list">
          {props.recentProjects.map((project, index) => {
            const unavailable = project.recentProjectId === props.unavailableRecentPath;
            const reasonId = unavailable ? `home-recent-${index}-reason` : fileReasonId;
            return <li key={project.recentProjectId}>
            <span className="mangohana-project-mark" aria-hidden="true"><svg className="mangohana-icon"><use href={`${mangohanaIcons}#book`} /></svg></span>
            <div><button type="button" className="mangohana-recent-title project-home-recent-open" aria-label={`최근 프로젝트 ${project.title} 열기`} aria-describedby={reasonId}
              disabled={!props.apiReady || unavailable} onClick={() => props.onOpenRecent(project.recentProjectId)}>{project.title}</button>
              <span className="mangohana-note">마지막 열기: {formatOpenedAt(project.openedAt)}</span>
              {unavailable && <span id={reasonId} className="mangohana-recent-unavailable">열 수 없음 · 파일 위치를 확인하거나 최근 목록에서 제거하세요.</span>}</div>
            <Button size="compact" disabled={!props.apiReady || unavailable} aria-describedby={reasonId} onClick={() => props.onOpenRecent(project.recentProjectId)}
              aria-label={index === 0 ? `최근 프로젝트 ${project.title} 이어하기` : `${project.title} 프로젝트 열기`}>이어하기<svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#arrow-right`} /></svg></Button>
          </li>; })}
        </ul> : <div className="mangohana-empty-state">
          <svg className="mangohana-entry-icon" aria-hidden="true"><use href={`${mangohanaIcons}#book`} /></svg>
          <h3>최근 프로젝트 없음</h3>
          <Button disabled={!props.apiReady} aria-describedby={fileReasonId} aria-label="빈 상태에서 기존 .ctp 프로젝트 선택" onClick={props.onOpenProject}>기존 .ctp 열기</Button>
        </div>}
      </section>
        <section className="mangohana-readiness" aria-label="현재 준비 상태">
          <div className="mangohana-section-heading"><h2>현재 준비 상태</h2><span className="mangohana-status" data-status-tone={props.projectSessionReady && props.apiReady ? "neutral" : "warning"}>
            {props.projectSessionReady && props.apiReady ? "프로젝트 시작 가능" : "준비 확인 필요"}
          </span></div>
          <dl className="mangohana-readiness-list">
            <div><dt>앱 파일 기능</dt><dd>{props.apiReady ? "사용 가능" : "준비 중"}</dd></div>
            <div><dt>프로젝트 세션</dt><dd>{props.projectSessionReady ? "준비됨" : props.sessionRetryAvailable ? "준비 실패" : "준비 중"}</dd></div>
          </dl>
          {props.statusMessage && <div className="project-home-status mangohana-feedback" role={props.unavailableRecentPath || props.sessionRetryAvailable ? "alert" : "status"}>
            <p>{props.statusMessage}</p>
            {props.unavailableRecentPath && <Button size="compact" aria-label={`${props.recentProjects.find((project) => project.recentProjectId === props.unavailableRecentPath)?.title ?? "최근 프로젝트"} 최근 목록에서 제거`}
              onClick={() => props.onRemoveRecent(props.unavailableRecentPath!)}>목록에서 제거</Button>}
          </div>}
          {props.sessionRetryAvailable && <Button onClick={props.onRetryProjectSession}>프로젝트 세션 다시 시도</Button>}
          <p className="mangohana-note">AI 준비 상태는 환경 준비에서 확인</p>
          <div className="mangohana-action-row">
            <Button onClick={props.onOpenPreparation}>환경 준비</Button>
            <Button onClick={props.onOpenSettings}>설정</Button>
            <Button variant="tertiary" onClick={() => openGuide("망고하나 사용 시작하기")}>사용 안내</Button>
          </div>
        </section>
    </div>
  </div>;
}

function formatOpenedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "날짜 정보 없음" : date.toLocaleDateString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
