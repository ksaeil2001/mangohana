import { useId, useState } from "react";
import type { RecentProject } from "../recentProjects.js";
import { AppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";
import { Button, Feedback, PageHeader } from "./Ui.js";
import "../mangohana-projects.css";

export type ProjectsPageProps = {
  recentProjects: RecentProject[];
  apiReady: boolean;
  statusMessage?: string;
  unavailableRecentPath?: string | null;
  onNewProject: () => void;
  onResumeWorkspace?: () => void;
  onOpenProject: () => void;
  onOpenRecent: (recentProjectId: string) => void;
  onRemoveRecent: (recentProjectId: string) => void;
  onOpenSettings: () => void;
  onOpenPreparation: () => void;
  onNavigate: (nav: NavId) => void;
};

const openedAtFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

export function ProjectsPage(props: ProjectsPageProps) {
  const [searchWord, setSearchWord] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "name">("recent");
  const listId = useId();
  const fileReasonId = props.apiReady ? undefined : `${listId}-file-readiness`;
  const query = searchWord.trim().toLocaleLowerCase();
  const filteredProjects = props.recentProjects.filter((project) => project.title.toLocaleLowerCase().includes(query));
  if (sortBy === "name") filteredProjects.sort((a, b) => a.title.localeCompare(b.title, "ko"));

  return (
    <AppShell
      activeNav="projects"
      recentProjects={props.recentProjects}
      onNavigate={props.onNavigate}
      onOpenProject={props.onOpenProject}
      onOpenRecent={props.onOpenRecent}
      onOpenSettings={props.onOpenSettings}
      onResumeWorkspace={props.onResumeWorkspace}
      onOpenPreparation={props.onOpenPreparation}
      onNewProject={props.onNewProject}
      projectOpeningDisabledReason={props.apiReady ? undefined : "앱 파일 기능을 준비하고 있습니다."}
      unavailableRecentProjectId={props.unavailableRecentPath}
    >
      <div className="trio-page-container mangohana-projects">
        <PageHeader title="프로젝트 관리" description={null}>
          <Button
            variant="secondary"
            onClick={props.onOpenProject}
            disabled={!props.apiReady}
            aria-label="기존 프로젝트 파일 열기"
            aria-describedby={fileReasonId}
          >
            파일 열기
          </Button>
          <Button variant="primary" onClick={props.onNewProject} aria-label="새 프로젝트 만들기">
            새 프로젝트
          </Button>
        </PageHeader>

        {!props.apiReady && <p id={fileReasonId} className="mangohana-projects-note">앱 파일 기능을 준비하고 있습니다.</p>}
        {props.statusMessage && <Feedback tone={props.unavailableRecentPath ? "error" : "neutral"}>{props.statusMessage}</Feedback>}

        <section className="mangohana-projects-register" aria-label="프로젝트 목록">
          <div className="mangohana-projects-toolbar">
            <div className="mangohana-projects-title">
              <h2>최근 프로젝트</h2>
              <span role="status">{query ? `${filteredProjects.length} / ${props.recentProjects.length}개` : `${props.recentProjects.length}개`}</span>
            </div>
            {props.recentProjects.length > 0 && (
              <div className="mangohana-projects-filter">
                <input
                  type="search"
                  placeholder="프로젝트 제목 검색"
                  aria-label="프로젝트 검색"
                  value={searchWord}
                  onChange={(event) => setSearchWord(event.target.value)}
                />
                <select
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value === "name" ? "name" : "recent")}
                  aria-label="정렬 기준"
                >
                  <option value="recent">최근에 연 순서</option>
                  <option value="name">이름순</option>
                </select>
              </div>
            )}
          </div>

          {filteredProjects.length === 0 ? (
            <div className="mangohana-projects-empty">
              <p>{query ? "검색 조건에 맞는 프로젝트가 없습니다." : "최근 작업한 프로젝트가 없습니다."}</p>
              {query && <Button size="compact" variant="secondary" onClick={() => setSearchWord("")}>검색 초기화</Button>}
            </div>
          ) : (
            <table className="mangohana-projects-table" aria-label="최근 프로젝트">
              <thead>
                <tr>
                  <th scope="col">프로젝트명</th>
                  <th scope="col">마지막 열기</th>
                </tr>
              </thead>
              <tbody>
                {filteredProjects.map((project, index) => {
                  const unavailable = project.recentProjectId === props.unavailableRecentPath;
                  const reasonId = `${listId}-unavailable-${index}`;
                  const openedAt = new Date(project.openedAt);
                  return (
                    <tr key={project.recentProjectId}>
                      <td>
                        <div className="mangohana-projects-name">
                          <button
                            type="button"
                            className="mangohana-projects-open"
                            disabled={!props.apiReady || unavailable}
                            aria-describedby={unavailable ? reasonId : fileReasonId}
                            onClick={() => props.onOpenRecent(project.recentProjectId)}
                          >
                            {project.title}
                          </button>
                          {unavailable && (
                            <>
                              <span id={reasonId} className="mangohana-projects-note">파일을 찾을 수 없음</span>
                              <Button
                                size="compact"
                                variant="secondary"
                                aria-label={`${project.title} 최근 목록에서 제거`}
                                onClick={() => props.onRemoveRecent(project.recentProjectId)}
                              >
                                목록에서 제거
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        {Number.isNaN(openedAt.getTime()) ? "—" : (
                          <time dateTime={project.openedAt}>{openedAtFormat.format(openedAt)}</time>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </AppShell>
  );
}
