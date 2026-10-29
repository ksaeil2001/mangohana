import { Button, PageHeader } from "./Ui.js";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../useFocusTrap.js";
import type { RecentProject } from "../recentProjects.js";
import { AppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";

export type ToolsPageProps = {
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

const PROJECT_TOOLS = [
  { id: "export", title: "프로젝트 대사 TXT 내보내기", condition: "작업대에서 TXT 내보내기", next: "프로젝트 작업대 열기", step: "프로젝트를 열고 작업대에서 TXT 내보내기를 선택하세요." },
  { id: "archive", title: "프로젝트 보관 (.ctp)", condition: ".ctp 파일과 자산 폴더를 함께 보관", next: "프로젝트 파일 열기", step: "프로젝트를 열어 저장 상태를 확인하세요. 파일과 연결된 자산 폴더는 함께 보관하세요." }
] as const;
type ProjectTool = typeof PROJECT_TOOLS[number];
const PENDING_TOOLS = ["이미지 이어붙이기 (웹툰 스크롤)", "일괄 크롭 & 리사이즈", "대사 텍스트 포맷 변환기", "캐시 및 임시 파일 관리"];

export function ToolsPage(props: ToolsPageProps) {
  const [activeTool, setActiveTool] = useState<ProjectTool | null>(null);
  const [targetProject, setTargetProject] = useState("all");
  const cardRef = useRef<HTMLDivElement>(null);
  const invokerRef = useRef<HTMLButtonElement | null>(null);
  useFocusTrap(cardRef, activeTool !== null);
  const closeTool = () => { setActiveTool(null); invokerRef.current?.focus(); };
  useEffect(() => {
    if (!activeTool) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setActiveTool(null); invokerRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTool]);

  return <AppShell activeNav="tools" recentProjects={props.recentProjects} onNavigate={props.onNavigate}
    onOpenProject={props.onOpenProject} onOpenRecent={props.onOpenRecent} onOpenSettings={props.onOpenSettings} onResumeWorkspace={props.onResumeWorkspace}
    onOpenPreparation={props.onOpenPreparation} onNewProject={props.onNewProject}>
    <div className="trio-page-container stitch-tools">
      <PageHeader title="편집 도구" description={null} />
      <section className="stitch-tools-available" aria-labelledby="tools-available-heading">
        <div className="stitch-section-heading"><h2 id="tools-available-heading">프로젝트에서 이어서 작업</h2></div>
        {PROJECT_TOOLS.map((tool, index) => <article key={tool.id} className="stitch-panel stitch-tool-row">
          <span className="stitch-record-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <div className="stitch-tool-purpose"><h3>{tool.title}</h3></div>
          <div className="stitch-tool-next"><p>{tool.condition}</p>
            <Button variant="primary" disabled={!props.apiReady} onClick={(event) => {
              invokerRef.current = event.currentTarget; setTargetProject("all"); setActiveTool(tool);
            }}>{tool.next}</Button>
          </div>
        </article>)}
      </section>
      <section className="stitch-panel stitch-tools-pending" aria-labelledby="tools-pending-heading">
        <div><span className="stitch-eyebrow">독립 도구</span><h2 id="tools-pending-heading">준비 중</h2></div>
        <ul>{PENDING_TOOLS.map((title) => <li key={title}><span>{title}</span><span className="stitch-status">준비 중</span></li>)}</ul>
      </section>
      {activeTool && <div className="trio-modal-backdrop" onClick={closeTool}>
        <div ref={cardRef} tabIndex={-1} className="trio-modal-card stitch-dialog stitch-tool-dialog" role="dialog" aria-modal="true" aria-label={activeTool.title} onClick={(event) => event.stopPropagation()}>
          <div className="trio-modal-header"><div><span className="stitch-eyebrow">프로젝트 선택</span><h3>{activeTool.title}</h3></div><button type="button" className="trio-modal-close" aria-label="닫기" onClick={closeTool}>✕</button></div>
          <div className="trio-modal-body">
            <p>{activeTool.step}</p>
            <div className="trio-launcher-form-group"><label htmlFor="tool-target-project">작업 대상 선택</label>
              <select id="tool-target-project" className="trio-select-control" aria-label="작업 대상 선택" value={targetProject} onChange={(event) => setTargetProject(event.target.value)}>
                <option value="all">파일을 직접 선택</option>
                {props.recentProjects.map((project) => <option key={project.recentProjectId} value={project.recentProjectId}>{project.title}</option>)}
              </select>
            </div>
          </div>
          <div className="trio-modal-footer"><Button onClick={closeTool}>취소</Button><Button variant="primary" disabled={!props.apiReady} onClick={() => {
            closeTool();
            if (props.recentProjects.some((project) => project.recentProjectId === targetProject)) props.onOpenRecent(targetProject);
            else props.onOpenProject();
          }}>프로젝트 열기</Button></div>
        </div>
      </div>}
    </div>
  </AppShell>;
}
