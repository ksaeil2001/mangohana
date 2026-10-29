import { Button } from "./Ui.js";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RecentProject } from "../recentProjects.js";
import { useFocusTrap } from "../useFocusTrap.js";
import mangohanaMark from "../brand/mangohana-mark.svg";
// SVG fragment references need a same-origin file URL, including in the built app.
import mangohanaIcons from "../brand/mangohana-icons.svg?no-inline";
import "../mangohana-home.css";

export type NavId = "home" | "projects" | "files" | "ai" | "tools" | "dictionary" | "settings";
export interface AppShellContextValue { openGuide: (title: string) => void }
export const AppShellContext = createContext<AppShellContextValue>({ openGuide: () => {} });
export function useAppShell() { return useContext(AppShellContext); }
export type GuideModalOpener = (title: string) => void;

export type AppShellProps = {
  activeNav: NavId;
  recentProjects: RecentProject[];
  children: ReactNode;
  onNavigate: (nav: NavId) => void;
  onOpenProject: () => void;
  onOpenRecent: (recentProjectId: string) => void;
  onOpenSettings: () => void;
  onOpenPreparation: () => void;
  onNewProject: () => void;
  onResumeWorkspace?: () => void;
  backwardCompatSlot?: ReactNode;
  projectOpeningDisabledReason?: string;
  unavailableRecentProjectId?: string | null;
};

const NAV_ITEMS: { id: NavId; label: string; title: string; icon: string }[] = [
  { id: "home", label: "홈", title: "작업 시작", icon: "M3 10 12 3l9 7v10H3ZM9 20v-7h6v7" },
  { id: "projects", label: "프로젝트", title: "프로젝트 관리", icon: "M3 5h7l2 3h9v12H3Z" },
  { id: "files", label: "파일", title: "프로젝트 파일", icon: "M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6" },
  { id: "ai", label: "AI 번역", title: "AI 작업 준비", icon: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" },
  { id: "tools", label: "편집 도구", title: "도구와 내보내기", icon: "m14 4 6 6M4 20l10-10M15 3l6 6-4 4-6-6ZM3 17l4 4" },
  { id: "dictionary", label: "용어 사전", title: "용어와 캐릭터", icon: "M4 4h7v16H4ZM13 4h7v16h-7M7 8h1M16 8h1M7 12h1M16 12h1" },
  { id: "settings", label: "설정", title: "환경 설정", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" }
];

const MAIN_ARIA_LABELS: Record<NavId, string> = {
  home: "홈 대시보드", projects: "프로젝트 관리", files: "파일 탐색기", ai: "AI 번역 대시보드",
  tools: "도구 및 유틸리티", dictionary: "용어 사전 및 캐릭터 관리", settings: "환경 설정"
};

export function AppShell(props: AppShellProps) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [activeGuide, setActiveGuide] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const guideInvokerRef = useRef<HTMLElement | null>(null);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const openingDisabledReasonId = useId();
  const guideOpen = activeGuide !== null;
  useFocusTrap(modalRef, guideOpen);

  const closeGuide = () => {
    setActiveGuide(null);
    guideInvokerRef.current?.focus();
  };

  useEffect(() => {
    if (!guideOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveGuide(null);
        guideInvokerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [guideOpen]);

  const openGuide = (title: string) => {
    guideInvokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveGuide(title);
  };
  const navigate = (nav: NavId) => {
    if (navigationOpen && navigationRef.current?.contains(document.activeElement)) navigationToggleRef.current?.focus();
    setNavigationOpen(false);
    props.onNavigate(nav);
  };

  return (
    <AppShellContext.Provider value={{ openGuide }}>
      <div className="trio-home-root-container stitch-suite mangohana-shell" data-stitch-screen={props.activeNav} data-navigation-open={navigationOpen}>
        <a className="trio-skip-link" href="#trio-main-content">본문으로 건너뛰기</a>
        <header className="trio-home-global-header project-home-header stitch-suite-header" aria-label="앱 헤더">
          <div className="stitch-suite-location">
            <button ref={navigationToggleRef} type="button" className="trio-mobile-nav-toggle icon-button" aria-label="메인 메뉴"
              aria-expanded={navigationOpen} aria-controls="trio-main-navigation" onClick={() => setNavigationOpen((open) => !open)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <button type="button" className="mangohana-brand" aria-label="망고하나 홈으로 이동" onClick={() => navigate("home")}>
              <img src={mangohanaMark} width="32" height="32" alt="" />
              <span>망고하나</span>
            </button>
            <span className="mangohana-location"><span aria-hidden="true">/</span><strong>{NAV_ITEMS.find((item) => item.id === props.activeNav)?.title}</strong></span>
          </div>
          <div className="stitch-suite-header-actions">
            <label className="stitch-project-switcher">
              <span>최근 프로젝트</span>
              <select aria-label="최근 프로젝트 전환" value="" disabled={Boolean(props.projectOpeningDisabledReason)}
                aria-describedby={props.projectOpeningDisabledReason ? openingDisabledReasonId : undefined} onChange={(event) => {
                if (event.target.value && !props.projectOpeningDisabledReason && event.target.value !== props.unavailableRecentProjectId) {
                  setNavigationOpen(false);
                  props.onOpenRecent(event.target.value);
                }
              }}>
                <option value="">{props.recentProjects.length ? "프로젝트를 선택하세요" : "최근 프로젝트 없음"}</option>
                {props.recentProjects.map((project) => <option key={project.recentProjectId} value={project.recentProjectId} disabled={project.recentProjectId === props.unavailableRecentProjectId}>{project.title}</option>)}
              </select>
            </label>
            {props.projectOpeningDisabledReason && <span id={openingDisabledReasonId} className="mangohana-visually-hidden">{props.projectOpeningDisabledReason}</span>}
            <button type="button" className="trio-header-projects-link" aria-label="프로젝트 목록으로 이동" onClick={() => navigate("projects")}>
              프로젝트 목록
            </button>
            {props.onResumeWorkspace && <Button onClick={props.onResumeWorkspace}>작업대로 돌아가기</Button>}
            {props.backwardCompatSlot}
          </div>
        </header>
        <div className="trio-home-body-layout">
          <aside ref={navigationRef} id="trio-main-navigation" className="trio-home-sidebar stitch-suite-rail" aria-label="메인 사이드바" onKeyDown={(event) => {
            if (event.key === "Escape" && navigationOpen) {
              setNavigationOpen(false);
              navigationToggleRef.current?.focus();
            }
          }}>
            <span className="mangohana-rail-label">나의 작업실</span>
            <nav className="trio-sidebar-nav-section" aria-label="메뉴">
              <ul className="trio-nav-list">
                {NAV_ITEMS.map((item) => <li key={item.id}>
                  <button type="button" className={`trio-nav-item ${props.activeNav === item.id ? "active" : ""}`}
                    aria-current={props.activeNav === item.id ? "page" : undefined} onClick={() => navigate(item.id)}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.icon} /></svg>
                    <span>{item.label}</span>
                  </button>
                </li>)}
              </ul>
            </nav>
            <div className="mangohana-rail-support">
              <button type="button" className="mangohana-support-link" onClick={props.onOpenPreparation}>
                <svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#preparation`} /></svg>환경 준비
              </button>
              <button type="button" className="mangohana-support-link" onClick={() => openGuide("도움말")}>
                <svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#help`} /></svg>도움말
              </button>
            </div>
          </aside>
          <main id="trio-main-content" tabIndex={-1} className="trio-home-main-scroll" aria-label={MAIN_ARIA_LABELS[props.activeNav]}>
            {props.children}
            <footer className="trio-home-footer">
              <span className="trio-footer-copy">망고하나 · 한 장씩, 자연스러운 이야기로</span>
              <div className="trio-footer-links">
                <button type="button" className="trio-footer-link" onClick={() => openGuide("문의하기")}>문의하기</button>
                <button type="button" className="trio-footer-link" onClick={() => openGuide("개인정보 처리방침")}>개인정보 처리방침</button>
              </div>
            </footer>
          </main>
        </div>
        {guideOpen && <div className="trio-modal-backdrop" onClick={closeGuide}>
          <div ref={modalRef} tabIndex={-1} className="trio-modal-card stitch-dialog" role="dialog" aria-modal="true" aria-label={activeGuide} onClick={(event) => event.stopPropagation()}>
            <div className="trio-modal-header">
              <div><span className="stitch-eyebrow">안내</span><h3>{activeGuide}</h3></div>
              <button type="button" className="trio-modal-close" aria-label="안내창 닫기" onClick={closeGuide}>
                <svg className="mangohana-icon" aria-hidden="true"><use href={`${mangohanaIcons}#close`} /></svg>
              </button>
            </div>
            <div className="trio-modal-body">{renderGuideBody(activeGuide)}</div>
            <div className="trio-modal-footer"><Button variant="primary" onClick={closeGuide}>확인</Button></div>
          </div>
        </div>}
      </div>
    </AppShellContext.Provider>
  );
}

function renderGuideBody(title: string | null) {
  if (title === "개인정보 처리방침") return <div className="trio-guide-dialog-body">
    <p><strong>개인정보 처리방침 및 데이터 보안 원칙</strong></p>
    <p>원본 이미지와 프로젝트는 로컬에서 관리합니다. 외부 AI를 요청하면 해당 작업에 필요한 대사나 이미지 영역이 설정한 제공자로 전송됩니다.</p>
    <p>API 키와 암호를 프로젝트에 포함하지 않습니다. 비밀 키는 운영체제 보안 저장소 또는 실행 세션에서 관리합니다.</p>
  </div>;
  if (title === "문의하기") return <div className="trio-guide-dialog-body"><p>오류나 개선 의견은 프로젝트의 GitHub 이슈 트래커에 남길 수 있습니다.</p><p>제보에는 비밀 키와 민감한 프로젝트 내용을 포함하지 마세요.</p></div>;
  return <div className="trio-guide-dialog-body">
    <p><strong>1. 페이지 가져오기</strong><br />새 번역 프로젝트에서 만화 이미지를 선택하거나 저장한 .ctp 프로젝트를 엽니다.</p>
    <p><strong>2. 인식과 번역 검토</strong><br />작업대에서 문자 인식과 번역을 요청하고 제안을 확인합니다. 필요한 엔진은 환경 준비와 설정에서 확인하세요.</p>
    <p><strong>3. 이미지와 식자 편집</strong><br />원문 제거 결과와 그림 보존을 검토하고 번역문 배치를 조정합니다.</p>
    <p><strong>4. 저장과 내보내기</strong><br />프로젝트를 저장하고 작업대의 내보내기로 결과를 보관합니다.</p>
  </div>;
}
