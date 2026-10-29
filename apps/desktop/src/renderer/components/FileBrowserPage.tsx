import { Button, PageHeader } from "./Ui.js";
import { useState } from "react";
import type { RecentProject } from "../recentProjects.js";
import { AppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";

export type FileBrowserPageProps = {
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

export function FileBrowserPage(props: FileBrowserPageProps) {
  const [projectFilter, setProjectFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filteredFiles = props.recentProjects.filter((project) =>
    (projectFilter === "all" || project.recentProjectId === projectFilter) &&
    `${project.title}.ctp`.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );
  const activeFile = filteredFiles.find((file) => file.recentProjectId === selectedId) ?? filteredFiles[0] ?? null;
  const openFile = (project: RecentProject) => { if (props.apiReady) props.onOpenRecent(project.recentProjectId); };

  return <AppShell activeNav="files" recentProjects={props.recentProjects} onNavigate={props.onNavigate}
    onOpenProject={props.onOpenProject} onOpenRecent={props.onOpenRecent} onOpenSettings={props.onOpenSettings} onResumeWorkspace={props.onResumeWorkspace}
    onOpenPreparation={props.onOpenPreparation} onNewProject={props.onNewProject}>
    <div className="trio-page-container trio-management-files stitch-files">
      <PageHeader title="프로젝트 파일 탐색기" description="최근 프로젝트 제목 기준">
        <Button variant="primary" disabled={!props.apiReady} onClick={props.onOpenProject} aria-label="외부 프로젝트 파일 불러오기">프로젝트 열기</Button>
      </PageHeader>
      <div className="stitch-files-layout">
        <section className="stitch-panel stitch-file-register" aria-label="파일 목록">
          <div className="stitch-register-caption"><span className="stitch-eyebrow">최근 프로젝트 파일</span><span className="stitch-note">{filteredFiles.length}개 항목</span></div>
          <div className="stitch-file-filters">
            <div className="trio-search-box-inline">
              <input type="search" placeholder="최근 프로젝트 제목 검색…" aria-label="파일명 검색" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            </div>
            <label className="stitch-field"><span>최근 제목 필터</span><select aria-label="최근 제목 필터" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value="all">모든 최근 프로젝트</option>
              {props.recentProjects.map((project) => <option key={project.recentProjectId} value={project.recentProjectId}>{project.title}</option>)}
            </select></label>
          </div>
          <div className="stitch-file-list">
            {!filteredFiles.length ? <div className="stitch-empty-state">
              <p>{props.recentProjects.length ? "조건에 맞는 파일이 없습니다." : "최근 프로젝트 파일이 없습니다."}</p>
              {(searchQuery || projectFilter !== "all") && <Button onClick={() => { setSearchQuery(""); setProjectFilter("all"); }}>필터 초기화</Button>}
            </div> : filteredFiles.map((project) => <div key={project.recentProjectId}
              className={`trio-fb-file-card stitch-file-row ${activeFile?.recentProjectId === project.recentProjectId ? "selected" : ""}`}
              tabIndex={0} role="button" aria-pressed={activeFile?.recentProjectId === project.recentProjectId}
              aria-label={`파일: ${project.title}.ctp, 프로젝트 파일, ${formatOpenedAt(project.openedAt)}`}
              onClick={() => setSelectedId(project.recentProjectId)} onDoubleClick={() => openFile(project)} onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); setSelectedId(project.recentProjectId); openFile(project); }
                else if (event.key === " ") { event.preventDefault(); setSelectedId(project.recentProjectId); }
              }}>
              <span className="stitch-project-filemark" aria-hidden="true">.ctp</span>
              <div className="trio-fb-file-meta"><strong className="trio-fb-filename">{project.title}.ctp</strong>
                <span className="stitch-note">마지막 열기: {formatOpenedAt(project.openedAt)}</span></div>
              <span className="stitch-file-selection" aria-hidden="true">{activeFile?.recentProjectId === project.recentProjectId ? "선택됨" : "선택"}</span>
            </div>)}
          </div>
        </section>
        <aside className="stitch-panel stitch-file-detail" aria-label="파일 세부 정보">
          <span className="stitch-eyebrow">선택 상세</span><h2>파일 세부 정보</h2>
          {activeFile ? <>
            <div className="stitch-file-detail-title"><span className="stitch-project-filemark" aria-hidden="true">.ctp</span><h3>{activeFile.title}</h3></div>
            <div className="trio-fb-detail-fields">
              <div><span>표시 이름</span><strong>{activeFile.title}.ctp</strong></div>
              <div><span>파일 형식</span><strong>.ctp 프로젝트</strong></div>
              <div><span>마지막 열기</span><strong>{formatOpenedAt(activeFile.openedAt)}</strong></div>
            </div>
            <Button variant="primary" disabled={!props.apiReady} onClick={() => openFile(activeFile)}>프로젝트에서 열기</Button>
          </> : <p className="stitch-note">프로젝트를 선택하세요.</p>}
        </aside>
      </div>
    </div>
  </AppShell>;
}

function formatOpenedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "날짜 정보 없음" : date.toLocaleDateString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
