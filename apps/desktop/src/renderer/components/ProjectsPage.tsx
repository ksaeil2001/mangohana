import { Button, PageHeader } from "./Ui.js";
import { useState } from "react";
import type { RecentProject } from "../recentProjects.js";
import { AppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";

export type ProjectsPageProps = {
  recentProjects: RecentProject[];
  apiReady: boolean;
  onNewProject: () => void;
  onResumeWorkspace?: () => void;
  onOpenProject: () => void;
  onOpenRecent: (recentProjectId: string) => void;
  onRemoveRecent: (recentProjectId: string) => void;
  onOpenSettings: () => void;
  onOpenPreparation: () => void;
  onNavigate: (nav: NavId) => void;
};

interface DisplayProject {
  id: string;
  title: string;
  updatedAt: string;
}

export function ProjectsPage(props: ProjectsPageProps) {
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [searchWord, setSearchWord] = useState<string>("");
  const [sortBy, setSortBy] = useState<"recent" | "name">("recent");

  const projectItems: DisplayProject[] = props.recentProjects.map((rp) => {
    let formattedDate = "최근";
    if (rp.openedAt) {
      try {
        const d = new Date(rp.openedAt);
        if (!isNaN(d.getTime())) {
          formattedDate = d.toLocaleDateString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        }
      } catch {
        // Fallback to default
      }
    }
    return {
      id: rp.recentProjectId,
      title: rp.title,
      updatedAt: formattedDate
    };
  });

  const filteredProjects = projectItems.filter((item) => {
    if (searchWord.trim() && !item.title.toLowerCase().includes(searchWord.trim().toLowerCase())) {
      return false;
    }
    return true;
  }).sort((a, b) => {
    if (sortBy === "name") return a.title.localeCompare(b.title);
    return 0; // Default: recent order
  });

  const totalCount = projectItems.length;

  return (
    <AppShell
      activeNav="projects"
      recentProjects={props.recentProjects}
      onNavigate={props.onNavigate}
      onOpenProject={props.onOpenProject}
      onOpenRecent={props.onOpenRecent}
      onOpenSettings={props.onOpenSettings} onResumeWorkspace={props.onResumeWorkspace}
      onOpenPreparation={props.onOpenPreparation}
      onNewProject={props.onNewProject}
    >
      <div className="trio-page-container trio-management-projects stitch-projects">
        {/* Page Header */}
        <PageHeader title={<>프로젝트 관리</>} description={<>최근에 연 프로젝트</>}>
            <Button
              type="button"
              variant="secondary"
              onClick={props.onOpenProject}
              disabled={!props.apiReady}
              aria-label="기존 프로젝트 파일 열기"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>파일 열기</span>
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={props.onNewProject}
              disabled={!props.apiReady}
              aria-label="새 프로젝트 만들기"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>새 프로젝트</span>
            </Button>
          </PageHeader>

        <section className="stitch-panel stitch-project-register" aria-label="프로젝트 목록">
        <div className="stitch-register-caption"><span className="stitch-eyebrow">최근 작업 기록</span><span className="stitch-note">{filteredProjects.length} / {totalCount}개 프로젝트</span></div>
        <div className="trio-toolbar-row">
          <div className="trio-search-box-inline">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              placeholder="프로젝트 제목 검색..."
              value={searchWord}
              onChange={(e) => setSearchWord(e.target.value)}
              aria-label="프로젝트 검색"
            />
          </div>

          <div className="trio-toolbar-right">
            <select
              className="trio-sort-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "recent" | "name")}
              aria-label="정렬 기준"
            >
              <option value="recent">최근 작업순</option>
              <option value="name">이름순</option>
            </select>

            <div className="trio-view-mode-toggle">
              <button
                type="button"
                className={`trio-view-btn ${viewMode === "grid" ? "active" : ""}`}
                onClick={() => setViewMode("grid")}
                title="그리드 뷰"
                aria-label="그리드 뷰"
                aria-pressed={viewMode === "grid"}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="3" y="3" width="7" height="7"></rect>
                  <rect x="14" y="3" width="7" height="7"></rect>
                  <rect x="14" y="14" width="7" height="7"></rect>
                  <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
              </button>
              <button
                type="button"
                className={`trio-view-btn ${viewMode === "list" ? "active" : ""}`}
                onClick={() => setViewMode("list")}
                title="리스트 뷰"
                aria-label="리스트 뷰"
                aria-pressed={viewMode === "list"}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <line x1="8" y1="6" x2="21" y2="6"></line>
                  <line x1="8" y1="12" x2="21" y2="12"></line>
                  <line x1="8" y1="18" x2="21" y2="18"></line>
                  <line x1="3" y1="6" x2="3.01" y2="6"></line>
                  <line x1="3" y1="12" x2="3.01" y2="12"></line>
                  <line x1="3" y1="18" x2="3.01" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Content Area: Grid or List */}
        {filteredProjects.length === 0 ? (
          <div className="trio-empty-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            <p>{searchWord.trim() ? "검색 조건에 맞는 프로젝트가 없습니다." : "최근 작업한 프로젝트가 없습니다."}</p>
            {searchWord.trim() ? (
              <Button type="button" variant="secondary" onClick={() => setSearchWord("")}>
                검색 초기화
              </Button>
            ) : (
              <div style={{ display: "flex", gap: "var(--trio-space-2)", marginTop: "var(--trio-space-2)" }}>
                <Button type="button" variant="primary" onClick={props.onNewProject}>
                  새 프로젝트 만들기
                </Button>
                <Button type="button" variant="secondary" onClick={props.onOpenProject}>
                  기존 .ctp 열기
                </Button>
              </div>
            )}
          </div>
        ) : viewMode === "grid" ? (
          <div className="trio-projects-grid">
            {filteredProjects.map((item) => (
              <article
                key={item.id}
                className="trio-project-card-full"
              >
                <div className="stitch-project-filemark" aria-hidden="true">.ctp</div>
                <div className="trio-card-full-body">
                  <h2
                    className="trio-card-full-title"
                    title={item.title}
                  >
                    <button
                      type="button"
                      className="trio-card-title-button"
                      disabled={!props.apiReady}
                      onClick={() => props.onOpenRecent(item.id)}
                    >
                      {item.title}
                    </button>
                  </h2>
                  <div className="trio-card-full-footer">
                    <span className="trio-card-time-text">마지막 열기: {item.updatedAt}</span>
                    <button
                      type="button"
                      className="trio-card-open-btn"
                      aria-label={`${item.title} 프로젝트 열기`}
                      disabled={!props.apiReady}
                      onClick={() => props.onOpenRecent(item.id)}
                    >
                      열기
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="trio-projects-table-wrap" tabIndex={0} role="region" aria-label="최근 프로젝트 목록 표">
            <table className="trio-projects-table" aria-label="최근 프로젝트">
              <colgroup>
                <col />
                <col className="trio-project-time-column" />
                <col className="trio-record-action-column" />
              </colgroup>
              <thead>
                <tr>
                  <th>프로젝트명</th>
                  <th>마지막 열기</th>
                  <th>작업</th>
                </tr>
              </thead>
              <tbody>
                {filteredProjects.map((item) => (
                  <tr
                    key={item.id}
                    className="trio-table-row"
                  >
                    <td className="trio-table-title-cell">
                      <button type="button" className="stitch-record-title" disabled={!props.apiReady} onClick={() => props.onOpenRecent(item.id)}>{item.title}</button>
                    </td>
                    <td>{item.updatedAt}</td>
                    <td>
                      <button
                        type="button"
                        className="trio-table-action-btn"
                        aria-label={`${item.title} 프로젝트 열기`}
                        disabled={!props.apiReady}
                        onClick={() => props.onOpenRecent(item.id)}
                      >
                        열기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </section>
      </div>
    </AppShell>
  );
}
