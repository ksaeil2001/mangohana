import { Button, PageHeader } from "./Ui.js";
import { useEffect, useState } from "react";
import type { RecentProject } from "../recentProjects.js";
import { AppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";
import type { GeminiApiKeyStatus } from "../../shared/geminiApiKey.js";
import type { ProviderSettings } from "../../shared/providerSettings.js";

export type AiDashboardPageProps = {
  recentProjects: RecentProject[];
  apiReady: boolean;
  recentProjectsError?: string | null;
  onRetryRecentProjects?: () => void;
  onNewProject: () => void;
  onResumeWorkspace?: () => void;
  onOpenProject: () => void;
  onOpenRecent: (recentProjectId: string) => void;
  onRemoveRecent: (recentProjectId: string) => void;
  onOpenSettings: () => void;
  onOpenPreparation: () => void;
  onNavigate: (nav: NavId) => void;
};

type QueryState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string }
  | { status: "unavailable" };

export function AiDashboardPage(props: AiDashboardPageProps) {
  const [targetProject, setTargetProject] = useState<string>(() => props.recentProjects?.[0]?.recentProjectId || "");
  const [apiKeyState, setApiKeyState] = useState<QueryState<GeminiApiKeyStatus>>({ status: "loading" });
  const [providerState, setProviderState] = useState<QueryState<ProviderSettings>>({ status: "loading" });
  const [statusReloadAttempt, setStatusReloadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const api = window.projectApi;
    if (typeof api?.getGeminiApiKeyStatus !== "function") {
      setApiKeyState({ status: "unavailable" });
    } else {
      setApiKeyState({ status: "loading" });
      api.getGeminiApiKeyStatus()
        .then((status) => {
          if (active) setApiKeyState({ status: "ready", value: status });
        })
        .catch((error: unknown) => {
          if (active) {
            setApiKeyState({
              status: "error",
              message: error instanceof Error ? error.message : "Gemini API 키 상태를 확인하지 못했습니다."
            });
          }
        });
    }
    if (typeof api?.getProviderSettings !== "function") {
      setProviderState({ status: "unavailable" });
    } else {
      setProviderState({ status: "loading" });
      api.getProviderSettings()
        .then((settings) => {
          if (active) setProviderState({ status: "ready", value: settings });
        })
        .catch((error: unknown) => {
          if (active) {
            setProviderState({
              status: "error",
              message: error instanceof Error ? error.message : "Provider 설정을 확인하지 못했습니다."
            });
          }
        });
    }
    return () => {
      active = false;
    };
  }, [statusReloadAttempt]);

  useEffect(() => {
    const items = props.recentProjects ?? [];
    setTargetProject((current) => {
      if (current && items.some((item) => item.recentProjectId === current)) {
        return current;
      }
      return items[0]?.recentProjectId ?? "";
    });
  }, [props.recentProjects]);

  const hasRecent = props.recentProjects && props.recentProjects.length > 0;

  return (
    <AppShell activeNav="ai" recentProjects={props.recentProjects} onNavigate={props.onNavigate}
      onOpenProject={props.onOpenProject} onOpenRecent={props.onOpenRecent} onOpenSettings={props.onOpenSettings} onResumeWorkspace={props.onResumeWorkspace}
      onOpenPreparation={props.onOpenPreparation} onNewProject={props.onNewProject}>
      <div className="trio-page-container stitch-ai">
        <PageHeader title="AI 번역 대시보드" description={null}>
          <Button onClick={props.onOpenPreparation} aria-label="AI 엔진 점검">AI 엔진 점검</Button>
          <Button onClick={props.onOpenSettings}>AI 설정</Button>
        </PageHeader>
        <div className="stitch-ai-layout">
          <section className="stitch-panel stitch-ai-preparation" aria-labelledby="ai-preparation-heading">
            <h2 id="ai-preparation-heading">번역 엔진과 키 설정</h2>
            <p className="stitch-note">저장된 설정 · 연결과 번역은 별도 확인</p>
            <div className="stitch-ai-status-row">
              <h3>클라우드 Gemini API</h3>
              <strong className="trio-status-text" data-status-tone={geminiStatusTone(apiKeyState)}>{geminiStatusLabel(apiKeyState)}</strong>
              <p>{geminiStatusDetail(apiKeyState)}</p>
              {apiKeyState.status === "error" && <Button size="compact" onClick={() => setStatusReloadAttempt((attempt) => attempt + 1)} aria-label="Gemini API 상태 다시 확인">다시 시도</Button>}
            </div>
            <div className="stitch-ai-status-row">
              <h3>로컬 AI 엔진</h3>
              <strong>{localAiStatusLabel(providerState)}</strong>
              <p>{localAiStatusDetail(providerState)}</p>
              {providerState.status === "ready" && <span className="stitch-note">저장된 모델과 주소 · 연결 및 기능 실행은 미검증</span>}
              {providerState.status === "error" && <Button size="compact" onClick={() => setStatusReloadAttempt((attempt) => attempt + 1)} aria-label="Provider 설정 다시 확인">다시 시도</Button>}
            </div>
            <div className="stitch-ai-status-row">
              <h3>기본 번역 엔진</h3>
              <strong className="trio-status-text" data-status-tone={providerState.status === "error" ? "error" : "neutral"}>{translationEngineStatusLabel(providerState)}</strong>
              <p>{translationEngineStatusDetail(providerState)}</p>
            </div>
            <p className="stitch-note stitch-ai-review-note">AI 결과는 검토 후 적용</p>
          </section>
          <section className="stitch-panel stitch-ai-target" aria-labelledby="ai-target-heading">
            <h2 id="ai-target-heading">프로젝트 열기 &amp; 작업대 이동</h2>
            <div className="stitch-register-caption"><span className="stitch-note">등록된 프로젝트</span><span>{props.recentProjects.length}개</span></div>
            {props.recentProjectsError && <div className="stitch-inline-feedback" role="alert"><p>{props.recentProjectsError}</p>
              {props.onRetryRecentProjects && <Button onClick={props.onRetryRecentProjects} aria-label="최근 프로젝트 다시 불러오기">다시 시도</Button>}
            </div>}
            <div className="trio-launcher-form-group">
              <label htmlFor="ai-target-project">대상 프로젝트</label>
              <select id="ai-target-project" className="trio-select-control" aria-label="대상 프로젝트" value={targetProject} onChange={(event) => setTargetProject(event.target.value)}>
                {hasRecent ? props.recentProjects.map((project) => <option key={project.recentProjectId} value={project.recentProjectId}>{project.title}</option>) : <option value="">최근 작업한 프로젝트가 없습니다</option>}
              </select>
            </div>
            <p className="stitch-note">프로젝트를 열고 페이지 선택</p>
            <Button variant="primary" className="stitch-ai-launch" disabled={!props.apiReady} onClick={() => {
              if (props.recentProjects.some((project) => project.recentProjectId === targetProject)) props.onOpenRecent(targetProject);
              else props.onOpenProject();
            }}>{hasRecent ? "선택 프로젝트 작업대로 이동" : "기존 프로젝트 파일 열기"}</Button>
            {!hasRecent && <div className="stitch-ai-no-project"><Button disabled={!props.apiReady} onClick={props.onNewProject} aria-label="새 프로젝트 만들기">새 프로젝트 만들기</Button></div>}
            {hasRecent && <div className="stitch-ai-history">
              <h3>최근 작업 프로젝트</h3>
              <div className="trio-projects-table-wrap" tabIndex={0} role="region" aria-label="최근 작업 프로젝트 목록">
                <table className="trio-projects-table"><thead><tr><th>프로젝트</th><th>마지막 열기</th><th>작업</th></tr></thead><tbody>
                  {props.recentProjects.map((project) => <tr key={project.recentProjectId} className="trio-table-row">
                    <td className="trio-table-title-cell"><strong>{project.title}</strong></td>
                    <td>{formatOpenedAt(project.openedAt)}</td>
                    <td><button type="button" className="trio-table-action-btn" disabled={!props.apiReady} aria-label={`${project.title} 프로젝트 열기`} onClick={() => props.onOpenRecent(project.recentProjectId)}>열기</button></td>
                  </tr>)}
                </tbody></table>
              </div>
            </div>}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function formatOpenedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "날짜 정보 없음" : date.toLocaleDateString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function geminiStatusLabel(state: QueryState<GeminiApiKeyStatus>): string {
  if (state.status === "loading") return "확인 중";
  if (state.status === "error") return "확인 실패";
  if (state.status === "unavailable") return "확인할 수 없음";
  if (state.value.requiresReentry) return "키 재입력 필요";
  return state.value.configured ? "API 키 설정됨" : "키 미설정";
}

function geminiStatusDetail(state: QueryState<GeminiApiKeyStatus>): string {
  if (state.status === "loading") return "저장된 API 키 상태를 확인하는 중입니다.";
  if (state.status === "error") return state.message;
  if (state.status === "unavailable") return "이 화면에서 API 키 상태를 조회할 수 없습니다.";
  if (state.value.requiresReentry) return "저장된 키를 복원하지 못했습니다. 설정에서 다시 입력하세요.";
  return state.value.configured ? "키 설정 확인 · 연결 및 기능 실행은 미검증" : "설정에서 API 키 등록 필요";
}

function geminiStatusTone(state: QueryState<GeminiApiKeyStatus>): string {
  if (state.status === "error") return "error";
  if (state.status === "loading") return "busy";
  if (state.status === "ready" && state.value.requiresReentry) return "warning";
  return "neutral";
}

function localAiStatusLabel(state: QueryState<ProviderSettings>): string {
  if (state.status === "loading") return "확인 중";
  if (state.status === "error") return "확인 실패";
  if (state.status === "unavailable") return "확인할 수 없음";
  return state.value.localAiModel;
}

function localAiStatusDetail(state: QueryState<ProviderSettings>): string {
  if (state.status === "loading") return "저장된 로컬 AI 설정을 확인하는 중입니다.";
  if (state.status === "error") return state.message;
  if (state.status === "unavailable") return "이 화면에서 Provider 설정을 조회할 수 없습니다.";
  return state.value.localAiEndpoint;
}

function translationEngineStatusLabel(state: QueryState<ProviderSettings>): string {
  if (state.status === "loading") return "확인 중";
  if (state.status === "error") return "확인 실패";
  if (state.status === "unavailable") return "확인할 수 없음";
  return translationEngineLabel(state.value);
}

function translationEngineStatusDetail(state: QueryState<ProviderSettings>): string {
  if (state.status === "loading") return "저장된 번역 엔진을 확인하는 중입니다.";
  if (state.status === "error") return state.message;
  if (state.status === "unavailable") return "이 화면에서 Provider 설정을 조회할 수 없습니다.";
  return "설정에서 전환 가능";
}

function translationEngineLabel(settings: ProviderSettings): string {
  if (settings.translationEngine !== "local_ai") return "Gemini 클라우드";
  switch (settings.localAiRuntime) {
    case "lmstudio":
      return "로컬 AI (LM Studio)";
    case "vllm":
      return "로컬 AI (vLLM)";
    case "custom":
      return "로컬 AI (사용자 지정)";
    default:
      return "로컬 AI (Ollama)";
  }
}
