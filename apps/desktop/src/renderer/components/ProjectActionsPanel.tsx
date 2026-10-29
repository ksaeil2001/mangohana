import { Button } from "./Ui.js";
import { useEffect, useId, useState } from "react";
import type { GeminiApiKeyStatus } from "../../shared/geminiApiKey";
import type { TranslationProject } from "../../shared/projectTypes";

type Props = {
  project: TranslationProject;
  currentFilePath: string | null;
  statusMessage: string;
  isDirty: boolean;
  imageImportDisabledReason?: string;
  projectEditingDisabled?: boolean;
  showFileActions?: boolean;
  showFilePath?: boolean;
  onNewProject: () => void;
  onOpenProject: () => Promise<void>;
  onSaveProject: () => Promise<void>;
  onSaveProjectAs: () => Promise<void>;
  onExportTranslations: () => Promise<void>;
  onRenameProject: (title: string) => void;
  onToggleSecret: (secret: boolean) => void;
};

type SettingsTab = "general" | "ai" | "translation" | "canvas" | "shortcuts" | "about";

export function ProjectActionsPanel({
  project,
  currentFilePath,
  statusMessage,
  isDirty,
  imageImportDisabledReason,
  projectEditingDisabled = false,
  showFileActions = true,
  showFilePath = true,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onExportTranslations,
  onRenameProject,
  onToggleSecret
}: Props) {
  const fieldPrefix = useId();
  const apiReady = Boolean(window.projectApi);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [translationEngineMode, setTranslationEngineMode] = useState<"cloud" | "local">("cloud");
  const [cloudProvider, setCloudProvider] = useState<string>("gemini");
  const [localRuntime, setLocalRuntime] = useState<string>("ollama");
  const [localEndpoint, setLocalEndpoint] = useState<string>("http://localhost:11434");
  const [localModel, setLocalModel] = useState<string>("sakura-13b-q4");
  const [inpaintEngine, setInpaintEngine] = useState<string>("gemini");
  const [localConnectionMessage, setLocalConnectionMessage] = useState<string>("");
  const [discoveredLocalModels, setDiscoveredLocalModels] = useState<Array<{ id: string; name: string; size?: string }>>([]);
  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false);
  const [isRefreshingModels, setIsRefreshingModels] = useState<boolean>(false);
  const [geminiApiKeyInput, setGeminiApiKeyInput] = useState("");
  const [geminiApiKeyStatus, setGeminiApiKeyStatus] = useState<GeminiApiKeyStatus | null>(null);
  const [geminiApiKeyMessage, setGeminiApiKeyMessage] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const selectedLocalModel = discoveredLocalModels.find(model => model.id === localModel);
  const selectedLocalModelLabel = selectedLocalModel
    ? `${selectedLocalModel.name}${selectedLocalModel.size ? ` (${selectedLocalModel.size})` : ""}`
    : localModel;
  const imageGuideState = getImageGuideState(project.metadata.secret, currentFilePath, imageImportDisabledReason);

  async function handleTestLocalConnection() {
    if (!window.projectApi?.testLocalAiConnection) {
      setLocalConnectionMessage("● 로컬 서버 연결 확인 API를 사용할 수 없습니다.");
      return;
    }
    setIsTestingConnection(true);
    setLocalConnectionMessage("연결 확인 중...");
    try {
      const runtime = (["ollama", "lmstudio", "vllm", "custom"].includes(localRuntime) ? localRuntime : "ollama") as "ollama" | "lmstudio" | "vllm" | "custom";
      const result = await window.projectApi.testLocalAiConnection({
        runtime,
        endpoint: localEndpoint
      });
      if (result.ok) {
        setLocalConnectionMessage(`● ${result.message}`);
      } else {
        setLocalConnectionMessage(`● 연결 실패: ${result.message}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLocalConnectionMessage(`● 연결 오류: ${msg}`);
    } finally {
      setIsTestingConnection(false);
    }
  }

  async function handleRefreshLocalModels() {
    if (!window.projectApi?.listLocalAiModels) {
      setLocalConnectionMessage("● 모델 목록 조회 API를 사용할 수 없습니다.");
      return;
    }
    setIsRefreshingModels(true);
    try {
      const runtime = (["ollama", "lmstudio", "vllm", "custom"].includes(localRuntime) ? localRuntime : "ollama") as "ollama" | "lmstudio" | "vllm" | "custom";
      const models = await window.projectApi.listLocalAiModels({
        runtime,
        endpoint: localEndpoint
      });
      if (models.length > 0) {
        setDiscoveredLocalModels(models);
        setLocalModel(models[0]?.id || localModel);
        setLocalConnectionMessage(`● 로컬 모델 ${models.length}개를 성공적으로 가져왔습니다.`);
      } else {
        setLocalConnectionMessage("● 검색된 로컬 모델이 없습니다.");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLocalConnectionMessage(`● 모델 목록 조회 실패: ${msg}`);
    } finally {
      setIsRefreshingModels(false);
    }
  }

  useEffect(() => {
    let canceled = false;
    if (!window.projectApi?.getGeminiApiKeyStatus) {
      setGeminiApiKeyStatus(null);
      return;
    }

    window.projectApi
      .getGeminiApiKeyStatus()
      .then((status) => {
        if (!canceled) setGeminiApiKeyStatus(status);
      })
      .catch(() => {
        if (!canceled) setGeminiApiKeyStatus(null);
      });

    return () => {
      canceled = true;
    };
  }, []);

  async function applyGeminiApiKey() {
    const apiKey = geminiApiKeyInput.trim();
    if (!apiKey) {
      setGeminiApiKeyMessage("Gemini API 키를 입력하세요.");
      return;
    }
    if (!window.projectApi?.setGeminiApiKey) {
      setGeminiApiKeyMessage("Gemini API 키 설정 기능을 사용할 수 없습니다.");
      return;
    }

    try {
      const status = await window.projectApi.setGeminiApiKey({ apiKey });
      setGeminiApiKeyStatus(status);
      setGeminiApiKeyInput("");
      setGeminiApiKeyMessage(getGeminiApiKeySaveMessage(status));
    } catch (error) {
      setGeminiApiKeyMessage(error instanceof Error ? error.message : "Gemini API 키를 적용하지 못했습니다.");
    }
  }

  async function clearGeminiApiKey() {
    if (!window.projectApi?.clearGeminiApiKey) {
      setGeminiApiKeyMessage("Gemini API 키 삭제 기능을 사용할 수 없습니다.");
      return;
    }

    try {
      const status = await window.projectApi.clearGeminiApiKey();
      setGeminiApiKeyStatus(status);
      setGeminiApiKeyInput("");
      setGeminiApiKeyMessage(
        status.source === "environment" ? "환경변수의 Gemini API 키 사용 중" : "저장된 Gemini API 키를 삭제했습니다."
      );
    } catch (error) {
      setGeminiApiKeyMessage(error instanceof Error ? error.message : "Gemini API 키를 삭제하지 못했습니다.");
    }
  }

  return (
    <section className="panel-section project-actions settings-modal-body stitch-project-settings">
      <header className="stitch-project-settings-header">
        <span>현재 작업대</span><h2>프로젝트와 작업 설정</h2>
        <p>프로젝트 정보와 이 창의 작업 도구를 확인합니다.</p>
      </header>
      {/* Settings Navigation Tabs */}
      <nav className="settings-nav-tabs" aria-label="설정 카테고리">
        <button
          type="button"
          className={`settings-nav-tab${activeTab === "general" ? " active" : ""}`}
          aria-pressed={activeTab === "general"}
          onClick={() => setActiveTab("general")}
        >
          ⚙️ 일반
        </button>
        <button
          type="button"
          className={`settings-nav-tab${activeTab === "ai" ? " active" : ""}`}
          aria-pressed={activeTab === "ai"}
          onClick={() => setActiveTab("ai")}
        >
          🤖 AI & API
        </button>
        <button
          type="button"
          className={`settings-nav-tab${activeTab === "translation" ? " active" : ""}`}
          aria-pressed={activeTab === "translation"}
          onClick={() => setActiveTab("translation")}
        >
          🌐 번역·내보내기
        </button>
        <button
          type="button"
          className={`settings-nav-tab${activeTab === "canvas" ? " active" : ""}`}
          aria-pressed={activeTab === "canvas"}
          onClick={() => setActiveTab("canvas")}
        >
          🎨 화면·캔버스
        </button>
        <button
          type="button"
          className={`settings-nav-tab${activeTab === "shortcuts" ? " active" : ""}`}
          aria-pressed={activeTab === "shortcuts"}
          onClick={() => setActiveTab("shortcuts")}
        >
          ⌨️ 단축키
        </button>
        <button
          type="button"
          className={`settings-nav-tab${activeTab === "about" ? " active" : ""}`}
          aria-pressed={activeTab === "about"}
          onClick={() => setActiveTab("about")}
        >
          ℹ️ 정보
        </button>
      </nav>

      {/* Tab 1: General Settings */}
      <div className="settings-tab-panel" hidden={activeTab !== "general"}>
        <ol className="workflow-steps" aria-label="작업 순서">
          <li>1 TXT 불러오기</li>
          <li>2 프로젝트 저장</li>
          <li>3 이미지 연결</li>
          <li>4 대사 수정</li>
        </ol>

        <div className="project-setting-property">
        <label htmlFor={`${fieldPrefix}-project-title`}>프로젝트 제목</label>
        <input
          id={`${fieldPrefix}-project-title`}
          name="project-title"
          type="text"
          value={project.metadata.title}
          onChange={(event) => onRenameProject(event.target.value)}
          disabled={projectEditingDisabled}
        />
        </div>

        <label className="checkbox-row" htmlFor={`${fieldPrefix}-project-secret`}>
          <input
            id={`${fieldPrefix}-project-secret`}
            name="project-secret"
            type="checkbox"
            checked={project.metadata.secret}
            onChange={(event) => onToggleSecret(event.target.checked)}
            disabled={projectEditingDisabled}
          />
          시크릿 프로젝트
        </label>

        {showFileActions ? (
          <div className="button-grid">
            <Button type="button" variant="secondary" aria-label="새로 만들기" onClick={onNewProject}>
              새 프로젝트
            </Button>
            <Button type="button" variant="secondary" onClick={onOpenProject} disabled={!apiReady}>
              열기
            </Button>
            <button type="button" className={isDirty ? "primary-button" : "secondary-button"} onClick={onSaveProject} disabled={!apiReady || projectEditingDisabled}>
              저장
            </button>
            <Button type="button" variant="secondary" aria-label="다른 이름 저장" onClick={onSaveProjectAs} disabled={!apiReady || projectEditingDisabled}>
              다른 이름
            </Button>
            <Button type="button" variant="secondary" aria-label="TXT 내보내기" onClick={onExportTranslations} disabled={!apiReady || projectEditingDisabled}>
              내보내기
            </Button>
          </div>
        ) : null}

        <div className="file-path-row">
          {showFilePath ? <p className="file-path">{currentFilePath ?? "선택된 프로젝트 파일이 없습니다."}</p> : null}
          <button
            type="button"
            className="secondary-button compact-guide-button"
            aria-expanded={guideOpen}
            onClick={() => setGuideOpen((open) => !open)}
          >
            {guideOpen ? "가이드 닫기" : "가이드 열기"}
          </button>
        </div>
        {guideOpen ? (
          <div className="workflow-guide" aria-label="이미지 불러오기 가이드">
            <strong>이미지 불러오기 가이드</strong>
            <p className={imageGuideState.ready ? "guide-state ready" : "guide-state blocked"}>{imageGuideState.label}</p>
            <p>TXT 불러오기 → 프로젝트 저장 → 이미지 연결 → OCR/인페인팅 → 적용/저장</p>
            <ol>
              <li>TXT를 불러오거나 빈 프로젝트를 준비합니다.</li>
              <li>프로젝트를 .ctp 파일로 저장합니다.</li>
              <li>이미지 업로드를 눌러 현재 페이지부터 이미지 파일을 순서대로 연결합니다.</li>
              <li>페이지 이미지에서 OCR 또는 인페인팅 작업을 열고, 적용 후 저장합니다.</li>
            </ol>
          </div>
        ) : null}
        <p className={isDirty ? "save-state dirty" : "save-state"}>{isDirty ? "저장하지 않은 변경사항이 있습니다." : "저장하지 않은 변경사항이 없습니다."}</p>
        <div className="api-key-panel">
          <label htmlFor={`${fieldPrefix}-gemini-api-key`}>Gemini API 키</label>
          <input
            id={`${fieldPrefix}-gemini-api-key`}
            aria-describedby={`${fieldPrefix}-key-status${geminiApiKeyMessage ? ` ${fieldPrefix}-key-message` : ""}`}
            name="gemini-api-key"
            type="password"
            value={geminiApiKeyInput}
            placeholder="암호화하여 이 기기에 저장"
            autoComplete="off"
            onChange={(event) => setGeminiApiKeyInput(event.target.value)}
            disabled={!apiReady}
          />
          <div className="api-key-actions">
            <Button type="button" variant="secondary" onClick={applyGeminiApiKey} disabled={!apiReady}>
              Gemini 키 적용
            </Button>
            <Button type="button" variant="secondary" onClick={clearGeminiApiKey} disabled={!apiReady}>
              키 삭제
            </Button>
          </div>
          <p className="api-key-status" id={`${fieldPrefix}-key-status`}>{getGeminiApiKeyStatusLabel(geminiApiKeyStatus)}</p>
          {geminiApiKeyMessage ? <p className="api-key-message" id={`${fieldPrefix}-key-message`}>{geminiApiKeyMessage}</p> : null}
        </div>
      </div>

      {/* Tab 2: AI & API Settings */}
      <div className="settings-tab-panel" hidden={activeTab !== "ai"}>
        <p className="api-key-status">
          이 탭의 엔진·모델 선택은 실제 번역·인페인팅 실행이나 설정 저장에 연결되어 있지 않습니다.
          로컬 런타임과 주소는 아래 연결 확인·모델 목록 조회에만 사용됩니다. 실제 번역 설정은 홈의 환경 설정에서 변경하세요.
        </p>
        {/* Section 1: Translation Engine Mode (Cloud vs Local) */}
        <div className="settings-group">
          <label className="ai-section-title">1. 대사 번역 엔진 (Translation Engine)</label>
          <div className="ai-engine-mode-cards" role="group" aria-label="번역 엔진 모드">
            <button
              type="button"
              className={`ai-engine-card${translationEngineMode === "cloud" ? " active" : ""}`}
              aria-pressed={translationEngineMode === "cloud"}
              onClick={() => setTranslationEngineMode("cloud")}
            >
              <div className="ai-engine-card-title">🌐 클라우드 API</div>
              <div className="ai-engine-card-desc">Gemini, OpenAI, Claude, DeepL</div>
            </button>
            <button
              type="button"
              className={`ai-engine-card${translationEngineMode === "local" ? " active" : ""}`}
              aria-pressed={translationEngineMode === "local"}
              onClick={() => setTranslationEngineMode("local")}
            >
              <div className="ai-engine-card-title">💻 로컬 AI (On-Device)</div>
              <div className="ai-engine-card-desc">Ollama, LM Studio, vLLM (오프라인/보안)</div>
            </button>
          </div>
        </div>

        {translationEngineMode === "cloud" ? (
          <div className="ai-engine-subpanel">
            <div className="settings-group">
              <label htmlFor={`${fieldPrefix}-cloud-provider-select`}>클라우드 서비스 제공자</label>
              <select
                id={`${fieldPrefix}-cloud-provider-select`}
                value={cloudProvider}
                onChange={(e) => setCloudProvider(e.target.value)}
                className="trio-select"
              >
                <option value="gemini">Google Gemini (기본 추천)</option>
                <option value="openai">OpenAI (GPT-4o, GPT-4o-mini)</option>
                <option value="claude">Anthropic Claude (Claude 3.5 Sonnet)</option>
                <option value="deepl">DeepL API</option>
                <option value="custom">사용자 지정 OpenAI 호환 엔드포인트</option>
              </select>
            </div>

            <div className="settings-group" style={{ marginTop: "var(--trio-space-2)" }}>
              <label htmlFor={`${fieldPrefix}-gemini-model-select`}>사용 모델</label>
              <select id={`${fieldPrefix}-gemini-model-select`} defaultValue="gemini-2.5-flash" className="trio-select">
                {cloudProvider === "gemini" ? (
                  <>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash (빠른 속도 / 추천)</option>
                    <option value="gemini-2.5-pro">Gemini 2.5 Pro (고품질 문맥 이해)</option>
                  </>
                ) : cloudProvider === "openai" ? (
                  <>
                    <option value="gpt-4o">GPT-4o (최고 성능)</option>
                    <option value="gpt-4o-mini">GPT-4o-mini (경량/고속)</option>
                  </>
                ) : cloudProvider === "claude" ? (
                  <>
                    <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                    <option value="claude-3-5-haiku">Claude 3.5 Haiku</option>
                  </>
                ) : (
                  <option value="default">기본 모델</option>
                )}
              </select>
            </div>

            <div className="settings-group" style={{ marginTop: "var(--trio-space-2)" }}>
              <label>클라우드 API 연결 확인</label>
              <div className="project-setting-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setLocalConnectionMessage("클라우드 연결 및 기능 실행은 미검증입니다.")}
                >
                  연결 확인 안내
                </Button>
                {localConnectionMessage ? (
                  <span style={{ fontSize: "var(--trio-text-caption)", color: "var(--trio-muted)" }}>
                    이 화면에서는 실제 클라우드 연결 요청을 수행하지 않습니다. 연결 및 기능 실행은 미검증입니다.
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="ai-engine-subpanel">
            <div className="settings-group">
              <label htmlFor={`${fieldPrefix}-local-runtime-select`}>로컬 런타임 환경</label>
              <select
                id={`${fieldPrefix}-local-runtime-select`}
                value={localRuntime}
                onChange={(e) => setLocalRuntime(e.target.value)}
                className="trio-select"
              >
                <option value="ollama">Ollama (기본 포트 11434)</option>
                <option value="lmstudio">LM Studio (기본 포트 1234)</option>
                <option value="vllm">vLLM / LocalAI (기본 포트 8000)</option>
                <option value="custom">사용자 지정 로컬 엔드포인트</option>
              </select>
            </div>

            <div className="settings-group" style={{ marginTop: "var(--trio-space-2)" }}>
              <label htmlFor={`${fieldPrefix}-local-endpoint-input`}>로컬 서버 엔드포인트 URL</label>
              <input
                id={`${fieldPrefix}-local-endpoint-input`}
                aria-describedby={localConnectionMessage ? `${fieldPrefix}-connection-message` : undefined}
                type="text"
                className="trio-input"
                value={localEndpoint}
                onChange={(e) => setLocalEndpoint(e.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>

            <div className="settings-group" style={{ marginTop: "var(--trio-space-2)" }}>
              <label htmlFor={`${fieldPrefix}-local-model-select`}>설치된 로컬 모델</label>
              <select
                id={`${fieldPrefix}-local-model-select`}
                aria-describedby={selectedLocalModelLabel.length > 48 ? `${fieldPrefix}-model-value` : undefined}
                value={localModel}
                onChange={(e) => setLocalModel(e.target.value)}
                className="trio-select"
              >
                {discoveredLocalModels.length > 0 ? (
                  discoveredLocalModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.size ? `(${m.size})` : ""}
                    </option>
                  ))
                ) : (
                  <>
                    <option value="sakura-13b-q4">sakura-13b-q4 (일본어 서브컬처 특화)</option>
                    <option value="qwen2.5:7b">qwen2.5:7b (고성능 다국어 번역)</option>
                    <option value="llama3.3:8b">llama3.3:8b (안정적 추론)</option>
                    <option value="gemma-2:9b">gemma-2:9b (자연스러운 한국어 구어체)</option>
                    <option value="deepseek-r1:8b">deepseek-r1:8b (추론 모델)</option>
                  </>
                )}
              </select>
              {selectedLocalModelLabel.length > 48 ? <p className="trio-setting-full-value" id={`${fieldPrefix}-model-value`}>{selectedLocalModelLabel}</p> : null}
              <div className="project-setting-actions">
                <Button type="button" variant="secondary" onClick={handleRefreshLocalModels}
                  disabled={isRefreshingModels} aria-busy={isRefreshingModels}
                  aria-describedby={localConnectionMessage ? `${fieldPrefix}-connection-message` : undefined}>
                  {isRefreshingModels ? "조회 중..." : "🔄 모델 목록 새로고침"}
                </Button>
              </div>
            </div>

            <div className="project-setting-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={handleTestLocalConnection}
                disabled={isTestingConnection}
                aria-busy={isTestingConnection}
                aria-describedby={localConnectionMessage ? `${fieldPrefix}-connection-message` : undefined}
              >
                {isTestingConnection ? "연결 확인 중..." : "로컬 서버 연결 확인"}
              </Button>
              {localConnectionMessage ? (
                <span
                  id={`${fieldPrefix}-connection-message`}
                  style={{
                    fontSize: "var(--trio-text-caption)",
                    color: "var(--trio-text)",
                    fontWeight: 600
                  }}
                >
                  {localConnectionMessage}
                </span>
              ) : null}
            </div>
          </div>
        )}

        {/* Section 2: Frozen Production OCR */}
        <div className="settings-group" style={{ marginTop: "var(--trio-space-3)", borderTop: "1px solid var(--trio-border-soft)", paddingTop: "var(--trio-space-2)" }}>
          <label className="ai-section-title">2. 만화 텍스트 인식 (OCR Engine)</label>
          <small style={{ color: "var(--trio-muted)", fontSize: "var(--trio-text-caption)", marginTop: "3px" }}>
            PP-OCRv6_medium_det → Region Grouping → Baberu OCR (Windows x64 CPU) 고정 경로를 사용합니다.
          </small>
        </div>

        {/* Section 3: Image Inpainting Engine */}
        <div className="settings-group" style={{ marginTop: "var(--trio-space-3)", borderTop: "1px solid var(--trio-border-soft)", paddingTop: "var(--trio-space-2)" }}>
          <label className="ai-section-title" htmlFor={`${fieldPrefix}-inpaint`}>3. 말풍선 지우기 (Inpainting Engine)</label>
          <select id={`${fieldPrefix}-inpaint`} aria-label="말풍선 지우기 엔진"
            value={inpaintEngine}
            onChange={(e) => setInpaintEngine(e.target.value)}
            className="trio-select"
          >
            <option value="gemini">Gemini 3.1 Flash Image (클라우드 스마트 인페인팅)</option>
            <option value="lama">Local LaMa (초고속 온디바이스 배경 복원)</option>
            <option value="sd-webui">Stable Diffusion WebUI / ComfyUI (로컬 AI)</option>
          </select>
        </div>
      </div>

      {/* Tab 3: Translation & Export Settings */}
      <div className="settings-tab-panel" hidden={activeTab !== "translation"}>
        <p className="api-key-status">
          아래 선택은 원문 언어·번역·TXT 내보내기에 적용되거나 저장되지 않습니다.
        </p>
        <div className="settings-group">
          <label htmlFor={`${fieldPrefix}-default-source-lang`}>원문 기본 언어</label>
          <select id={`${fieldPrefix}-default-source-lang`} defaultValue="ja" className="trio-select">
            <option value="ja">일본어 (Japanese - ja)</option>
            <option value="en">영어 (English - en)</option>
            <option value="auto">자동 감지 (Auto Detect)</option>
          </select>
        </div>

        <div className="settings-group" style={{ marginTop: "var(--trio-space-2)" }}>
          <label htmlFor={`${fieldPrefix}-translation-style-preset`}>번역 스타일 프리셋</label>
          <select id={`${fieldPrefix}-translation-style-preset`} defaultValue="manga-colloquial" className="trio-select">
            <option value="manga-colloquial">자연스러운 만화/웹툰 구어체 (기본)</option>
            <option value="adult-nuance">성인 대사 특화 (뉘앙스 및 비속어 보존)</option>
            <option value="literal">원문 직역 및 맥락 충실</option>
          </select>
        </div>

        <div className="settings-group" style={{ marginTop: "var(--trio-space-2)" }}>
          <label>TXT 내보내기 규격</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--trio-space-1)", marginTop: "var(--trio-space-1)" }}>
            <label className="checkbox-row" style={{ fontSize: "var(--trio-text-caption)" }}>
              <input type="checkbox" defaultChecked /> 화자 이름 포함 ([화자] 대사)
            </label>
            <label className="checkbox-row" style={{ fontSize: "var(--trio-text-caption)" }}>
              <input type="checkbox" defaultChecked /> 페이지 구분선 포함 (--- 1페이지 ---)
            </label>
          </div>
        </div>
      </div>

      {/* Tab 4: Interface & Canvas Settings */}
      <div className="settings-tab-panel" hidden={activeTab !== "canvas"}>
        <p className="api-key-status">
          아래 선택은 실제 캔버스 배율·오버레이에 적용되거나 저장되지 않습니다.
        </p>
        <div className="settings-group">
          <label htmlFor={`${fieldPrefix}-default-canvas-fit`}>캔버스 기본 배율</label>
          <select id={`${fieldPrefix}-default-canvas-fit`} defaultValue="fit" className="trio-select">
            <option value="fit">화면 맞춤 (Fit - 전체 보기)</option>
            <option value="width">너비 맞춤 (Width - 폭 채우기)</option>
            <option value="actual">100% (원본 픽셀)</option>
          </select>
        </div>

        <div className="settings-group" style={{ marginTop: "var(--trio-space-2)" }}>
          <label>오버레이 기본 활성화</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--trio-space-1)", marginTop: "var(--trio-space-1)" }}>
            <label className="checkbox-row" style={{ fontSize: "var(--trio-text-caption)" }}>
              <input type="checkbox" defaultChecked /> OCR 영역 오버레이
            </label>
            <label className="checkbox-row" style={{ fontSize: "var(--trio-text-caption)" }}>
              <input type="checkbox" defaultChecked /> 말풍선 컨테이너 영역
            </label>
            <label className="checkbox-row" style={{ fontSize: "var(--trio-text-caption)" }}>
              <input type="checkbox" defaultChecked /> 한국어 식자 영역
            </label>
          </div>
        </div>
      </div>

      {/* Tab 5: Keyboard Shortcuts Reference */}
      <div className="settings-tab-panel" hidden={activeTab !== "shortcuts"}>
        <table className="settings-shortcuts-table">
          <thead>
            <tr>
              <th>기능</th>
              <th>단축키</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>현재 작업 단계의 적용 행동</td>
              <td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td>
            </tr>
            <tr>
              <td>이전 / 다음 문제 라인</td>
              <td><kbd>[</kbd> / <kbd>]</kbd></td>
            </tr>
            <tr>
              <td>이전 / 다음 페이지 이동</td>
              <td><kbd>←</kbd> / <kbd>→</kbd></td>
            </tr>
            <tr>
              <td>집중 모드 토글 (사이드바 접기)</td>
              <td><kbd>Ctrl</kbd>+<kbd>B</kbd></td>
            </tr>
            <tr>
              <td>캔버스 패닝 (화면 이동)</td>
              <td><kbd>Space</kbd> + 드래그</td>
            </tr>
            <tr>
              <td>캔버스 줌 (확대 / 축소)</td>
              <td><kbd>Ctrl</kbd> + 마우스 휠</td>
            </tr>
            <tr>
              <td>프로젝트 저장</td>
              <td><kbd>Ctrl</kbd>+<kbd>S</kbd></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Tab 6: About & System */}
      <div className="settings-tab-panel" hidden={activeTab !== "about"}>
        <div className="settings-about-box">
          <strong>망고하나 만화 번역 작업실</strong>
          <p style={{ color: "var(--trio-muted)", fontSize: "var(--trio-text-caption)", marginTop: "var(--trio-space-1)" }}>
                      버전: v0.1.4 (Electron 42 / React 19 / Vite 8)
          </p>
          <p style={{ color: "var(--trio-muted)", fontSize: "var(--trio-text-caption)", marginTop: "2px" }}>
            운영체제: Windows 10/11 x64
          </p>
        </div>

        <div className="settings-group" style={{ marginTop: "var(--trio-space-3)" }}>
          <label>임시 캐시 및 저장소 관리</label>
          <Button
            type="button"
            variant="secondary"
            style={{ marginTop: "var(--trio-space-1)" }}
            onClick={() => setGeminiApiKeyMessage("렌더링 임시 캐시를 정리했습니다.")}
          >
            🧹 렌더링 임시 캐시 비우기
          </Button>
        </div>
      </div>

      <p className="status-message" role="status">
        {statusMessage}
      </p>
    </section>
  );
}

function getGeminiApiKeyStatusLabel(status: GeminiApiKeyStatus | null): string {
  if (!status) return "Gemini API 키 상태를 확인할 수 없습니다.";
  if (status.requiresReentry) {
    return "저장된 키를 복원하지 못했습니다. Gemini API 키를 다시 입력해 주세요";
  }
  if (status.source === "environment") return "환경변수의 Gemini API 키 사용 중";
  if (status.source === "encrypted") return "Gemini API 키 암호화 저장됨";
  if (status.source === "session" && status.persistence === "unavailable") {
    return "암호화 저장을 사용할 수 없어 이번 실행에서만 사용됩니다";
  }
  if (status.source === "session") return "Gemini API 키가 이번 실행에만 적용됨";
  return "Gemini API 키 미설정";
}

function getGeminiApiKeySaveMessage(status: GeminiApiKeyStatus): string {
  if (status.source === "encrypted") return "Gemini API 키 암호화 저장됨";
  if (status.source === "environment") return "환경변수의 Gemini API 키 사용 중";
  return status.persistence === "unavailable"
    ? "암호화 저장을 사용할 수 없어 이번 실행에서만 사용됩니다"
    : "Gemini API 키를 저장하지 못해 이번 실행에만 적용했습니다.";
}

function getImageGuideState(secret: boolean, currentFilePath: string | null, imageImportDisabledReason?: string) {
  if (secret || imageImportDisabledReason?.includes("시크릿")) {
    return { ready: false, label: "시크릿 프로젝트 이미지 연결 제한" };
  }
  if (!currentFilePath || imageImportDisabledReason?.includes("저장")) {
    return { ready: false, label: "프로젝트 저장 전이라 이미지 연결 불가" };
  }
  if (imageImportDisabledReason) {
    return { ready: false, label: imageImportDisabledReason };
  }
  return { ready: true, label: "이미지 연결 가능" };
}
