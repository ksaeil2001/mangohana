import { Button, PageHeader, SettingsRow, Feedback, handleTabKeys } from "./Ui.js";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { GeminiApiKeyStatus } from "../../shared/geminiApiKey.js";
import type { ProviderSettings } from "../../shared/providerSettings.js";
import type { RecentProject } from "../recentProjects.js";
import { AppShell } from "./AppShell.js";
import type { NavId } from "./AppShell.js";
import { useFocusTrap } from "../useFocusTrap.js";
import mangohanaMark from "../brand/mangohana-mark.svg";

export type SettingsPageProps = {
  recentProjects: RecentProject[];
  apiReady: boolean;
  providerSettings?: import("../../shared/providerSettings.js").ProviderSettings;
  uiTheme: "light" | "dark";
  uiThemeResolved?: boolean;
  onUiThemeChange: (theme: "light" | "dark") => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onOpenRecent: (recentProjectId: string) => void;
  onRemoveRecent: (recentProjectId: string) => void;
  onOpenSettings: () => void;
  onOpenPreparation: () => void;
  onNavigate: (nav: NavId) => void;
  onResumeWorkspace?: () => void;
};

type SettingTab = "general" | "ai" | "storage" | "typesetting" | "shortcuts" | "about";

type GeminiKeyQueryState =
  | { status: "loading" }
  | { status: "ready"; value: GeminiApiKeyStatus }
  | { status: "error"; message: string }
  | { status: "unavailable" };

export function SettingsPage(props: SettingsPageProps) {
  const fieldPrefix = useId();
  const [activeTab, setActiveTab] = useState<SettingTab>("general");
  const [geminiApiKey, setGeminiApiKey] = useState<string>("");
  const [geminiKeyQuery, setGeminiKeyQuery] = useState<GeminiKeyQueryState>(() =>
    typeof window.projectApi?.getGeminiApiKeyStatus === "function" ? { status: "loading" } : { status: "unavailable" }
  );
  const geminiApiKeyStatus = geminiKeyQuery.status === "ready" ? geminiKeyQuery.value : null;
  const [apiKeyFeedbackMessage, setApiKeyFeedbackMessage] = useState<string>("");
  const geminiApiKeyRef = useRef(geminiApiKey);
  geminiApiKeyRef.current = geminiApiKey;
  const geminiKeyMutationSeqRef = useRef(0);
  const [geminiKeyMutating, setGeminiKeyMutating] = useState(false);
  const [geminiKeyMutationKind, setGeminiKeyMutationKind] = useState<"idle" | "save" | "clear">("idle");
  const [translationEngine, setTranslationEngine] = useState<"gemini" | "local_ai">(() => {
    return props.providerSettings?.translationEngine || "gemini";
  });
  const [geminiModel, setGeminiModel] = useState<string>(
    () => props.providerSettings?.geminiModel || "gemini-2.5-flash"
  );
  const [translationStyle, setTranslationStyle] = useState<string>(
    () => props.providerSettings?.translationStyle || "natural"
  );
  const [localAiRuntime, setLocalAiRuntime] = useState<"ollama" | "lmstudio" | "vllm" | "custom">(
    () => props.providerSettings?.localAiRuntime || "ollama"
  );
  const [localAiEndpoint, setLocalAiEndpoint] = useState<string>(
    () => props.providerSettings?.localAiEndpoint || "http://localhost:11434"
  );
  const [localAiModel, setLocalAiModel] = useState<string>(
    () => props.providerSettings?.localAiModel || "qwen2.5:7b-instruct"
  );
  const [installedLocalModels, setInstalledLocalModels] = useState<string[]>([]);
  const [localAiTesting, setLocalAiTesting] = useState(false);
  const [localAiTestResult, setLocalAiTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number; version?: string } | null>(null);
  const [defaultStoragePath, setDefaultStoragePath] = useState<string>(() =>
    props.providerSettings?.defaultStoragePath || ""
  );
  const [savedToast, setSavedToast] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string>("✓ 설정이 저장되었습니다.");
  const savedToastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [startScreen, setStartScreen] = useState<"home" | "projects">(
    () => props.providerSettings?.startScreen === "projects" ? "projects" : "home"
  );
  const localAiRuntimeRef = useRef(localAiRuntime);
  const localAiEndpointRef = useRef(localAiEndpoint);
  const localAiTestSeqRef = useRef(0);
  const touchedSettingsRef = useRef(new Set<string>());
  const themeResolutionRef = useRef({ resolved: props.uiThemeResolved !== false, onChange: props.onUiThemeChange });
  themeResolutionRef.current = { resolved: props.uiThemeResolved !== false, onChange: props.onUiThemeChange };
  const settingsLoadGenRef = useRef(0);
  const hydratedSettingsRef = useRef(Boolean(props.providerSettings));
  const [settingsLoadState, setSettingsLoadState] = useState<"loading" | "ready" | "error">(() =>
    props.providerSettings || typeof window.projectApi?.getProviderSettings !== "function"
      ? "ready"
      : "loading"
  );
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const draft = { theme: props.uiTheme, geminiModel, translationEngine, translationStyle, localAiRuntime, localAiEndpoint, localAiModel, startScreen, defaultStoragePath };
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedSettingsRef = useRef(draft);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const leaveDialogRef = useRef<HTMLDivElement>(null);
  const leaveFocusRef = useRef<HTMLElement | null>(null);
  useFocusTrap(leaveDialogRef, leaveOpen);
  const sameSettings = (a: typeof draft, b: typeof draft) =>
    (Object.keys(a) as (keyof typeof draft)[]).every((key) => a[key] === b[key]);
  const requestLeave = (navigate: () => void) => {
    if (pendingLeaveRef.current) return;
    if (!savingRef.current && !geminiKeyMutating && !geminiApiKeyRef.current.trim() && sameSettings(draftRef.current, savedSettingsRef.current)) {
      navigate();
      return;
    }
    pendingLeaveRef.current = navigate;
    leaveFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeaveError(null);
    setLeaveOpen(true);
  };
  const continueEditing = () => {
    pendingLeaveRef.current = null;
    setLeaveOpen(false);
    setLeaveError(null);
  };
  useEffect(() => {
    if (leaveOpen || !leaveFocusRef.current) return;
    // Restore only after React removes inert from the editing surface.
    if (leaveFocusRef.current.isConnected) leaveFocusRef.current.focus();
    leaveFocusRef.current = null;
  }, [leaveOpen]);
  localAiRuntimeRef.current = localAiRuntime;
  localAiEndpointRef.current = localAiEndpoint;

  const markSettingTouched = (field: string) => {
    touchedSettingsRef.current.add(field);
  };

  useEffect(() => {
    if (!touchedSettingsRef.current.has("theme")) savedSettingsRef.current.theme = props.uiTheme;
  }, [props.uiTheme]);

  const applyLoadedSettings = useCallback((settings: Partial<ProviderSettings>) => {
    const baseline = { ...savedSettingsRef.current };
    const touched = touchedSettingsRef.current;
    if (!themeResolutionRef.current.resolved && !touched.has("theme") &&
      (settings.theme === "light" || settings.theme === "dark")) {
      baseline.theme = settings.theme;
      themeResolutionRef.current.onChange(settings.theme);
    }
    for (const key of Object.keys(baseline) as (keyof typeof baseline)[]) {
      if (key !== "theme" && settings[key] !== undefined) Object.assign(baseline, { [key]: settings[key] });
    }
    baseline.startScreen = settings.startScreen === "projects" ? "projects" : "home";
    if (baseline.defaultStoragePath === "기본 문서 폴더 (Trio Projects)") baseline.defaultStoragePath = "";
    savedSettingsRef.current = baseline;
    if (!touched.has("translationEngine") && settings.translationEngine) {
      setTranslationEngine(settings.translationEngine);
    }
    if (!touched.has("geminiModel") && settings.geminiModel) {
      setGeminiModel(settings.geminiModel);
    }
    if (!touched.has("translationStyle") && settings.translationStyle) {
      setTranslationStyle(settings.translationStyle);
    }
    if (!touched.has("localAiRuntime") && settings.localAiRuntime) {
      setLocalAiRuntime(settings.localAiRuntime);
    }
    if (!touched.has("localAiEndpoint") && settings.localAiEndpoint) {
      setLocalAiEndpoint(settings.localAiEndpoint);
    }
    if (!touched.has("localAiModel") && settings.localAiModel) {
      setLocalAiModel(settings.localAiModel);
    }
    if (!touched.has("startScreen") && settings.startScreen !== undefined) {
      setStartScreen(settings.startScreen === "projects" ? "projects" : "home");
    }
    if (!touched.has("defaultStoragePath") && settings.defaultStoragePath !== undefined) {
      setDefaultStoragePath(
        settings.defaultStoragePath === "기본 문서 폴더 (Trio Projects)"
          ? ""
          : settings.defaultStoragePath
      );
    }
  }, []);

  const loadProviderSettings = useCallback(async () => {
    const api = window.projectApi?.getProviderSettings;
    if (!api) {
      setSettingsLoadState("ready");
      setSettingsLoadError(null);
      return;
    }
    const generation = ++settingsLoadGenRef.current;
    setSettingsLoadState(hydratedSettingsRef.current ? "ready" : "loading");
    setSettingsLoadError(null);
    try {
      const settings = await api();
      if (settingsLoadGenRef.current !== generation) return;
      if (settings) applyLoadedSettings(settings);
      hydratedSettingsRef.current = true;
      setSettingsLoadState("ready");
      setSettingsLoadError(null);
    } catch (err) {
      if (settingsLoadGenRef.current !== generation) return;
      const message = err instanceof Error ? err.message : "설정을 불러오지 못했습니다.";
      setSettingsLoadError(message);
      if (hydratedSettingsRef.current) {
        setSettingsLoadState("ready");
        return;
      }
      setSettingsLoadState("error");
    }
  }, [applyLoadedSettings]);
  const loadProviderSettingsRef = useRef(loadProviderSettings);
  loadProviderSettingsRef.current = loadProviderSettings;

  useEffect(() => {
    return () => {
      if (savedToastTimeoutRef.current) clearTimeout(savedToastTimeoutRef.current);
    };
  }, []);

  const triggerSavedToast = (message = "✓ 설정이 저장되었습니다.") => {
    setToastMessage(message);
    setSavedToast(true);
    if (savedToastTimeoutRef.current) clearTimeout(savedToastTimeoutRef.current);
    savedToastTimeoutRef.current = setTimeout(() => {
      setSavedToast(false);
      savedToastTimeoutRef.current = null;
    }, 2500);
  };

  useEffect(() => {
    let active = true;
    if (window.projectApi?.getGeminiApiKeyStatus) {
      window.projectApi.getGeminiApiKeyStatus().then((status) => {
        if (active) setGeminiKeyQuery({ status: "ready", value: status });
      }).catch((error) => {
        if (active) {
          setGeminiKeyQuery({
            status: "error",
            message: error instanceof Error ? error.message : "API 키 상태를 확인하지 못했습니다."
          });
        }
      });
    } else {
      setGeminiKeyQuery({ status: "unavailable" });
    }
    void loadProviderSettingsRef.current();
    return () => {
      active = false;
      settingsLoadGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let active = true;
    localAiTestSeqRef.current += 1;
    setLocalAiTestResult(null);
    setLocalAiTesting(false);
    setInstalledLocalModels([]);
    if (window.projectApi?.listLocalAiModels) {
      window.projectApi
        .listLocalAiModels({ runtime: localAiRuntime, endpoint: localAiEndpoint })
        .then((models) => {
          if (active) {
            if (Array.isArray(models) && models.length > 0) {
              setInstalledLocalModels(models.map((m) => m.name || m.id));
            } else {
              setInstalledLocalModels([]);
            }
          }
        })
        .catch(() => {
          if (active) setInstalledLocalModels([]);
        });
    } else {
      setInstalledLocalModels([]);
    }
    return () => {
      active = false;
    };
  }, [localAiRuntime, localAiEndpoint]);

  const handleTestLocalAi = async () => {
    if (!window.projectApi?.testLocalAiConnection) return;
    if (localAiTesting) return;
    const startedRuntime = localAiRuntime;
    const startedEndpoint = localAiEndpoint;
    const seq = ++localAiTestSeqRef.current;
    const isCurrentLocalAiTest = () =>
      localAiTestSeqRef.current === seq &&
      localAiRuntimeRef.current === startedRuntime &&
      localAiEndpointRef.current === startedEndpoint;

    setLocalAiTesting(true);
    setLocalAiTestResult(null);
    setInstalledLocalModels([]);
    try {
      const result = await window.projectApi.testLocalAiConnection({
        runtime: startedRuntime,
        endpoint: startedEndpoint
      });
      if (!isCurrentLocalAiTest()) return;
      setLocalAiTestResult(result);
      if (result.ok && window.projectApi?.listLocalAiModels) {
        const models = await window.projectApi.listLocalAiModels({
          runtime: startedRuntime,
          endpoint: startedEndpoint
        });
        if (!isCurrentLocalAiTest()) return;
        if (Array.isArray(models) && models.length > 0) {
          setInstalledLocalModels(models.map((m) => m.name || m.id));
        } else {
          setInstalledLocalModels([]);
        }
      } else {
        setInstalledLocalModels([]);
      }
    } catch (err) {
      if (!isCurrentLocalAiTest()) return;
      setInstalledLocalModels([]);
      setLocalAiTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "로컬 서버 테스트에 실패했습니다."
      });
    } finally {
      if (localAiTestSeqRef.current === seq) {
        setLocalAiTesting(false);
      }
    }
  };

  const saveProviderSettings = async () => {
    if (settingsLoadState !== "ready" || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    // Invalidate a load started before this explicitly submitted save.
    settingsLoadGenRef.current += 1;
    const submitted = { ...draftRef.current };
    const themeWasTouched = touchedSettingsRef.current.has("theme");
    const { theme, ...otherSettings } = submitted;
    let providerSaveError: string | null = null;

    if (window.projectApi?.updateProviderSettings) {
      try {
        // Preserve Main's existing theme, including "system", unless it was edited here.
        if (themeWasTouched) props.onUiThemeChange(theme);
        await window.projectApi.updateProviderSettings(themeWasTouched ? submitted : otherSettings);
        // The successful boundary acknowledges this submitted snapshot, never a newer draft.
        savedSettingsRef.current = submitted;
      } catch (err) {
        providerSaveError = err instanceof Error ? err.message : "설정 저장 실패";
      }
    } else {
      providerSaveError = "설정 저장 연결을 사용할 수 없습니다. 다시 연결한 뒤 저장하세요.";
    }
    savingRef.current = false;
    setSaving(false);

    if (providerSaveError) {
      triggerSavedToast(`⚠️ ${providerSaveError}`);
      setLeaveError(`${providerSaveError} 입력값은 유지됩니다. 다시 저장하거나 계속 편집하세요.`);
      return false;
    }

    // Purge legacy provider keys from localStorage so Main store is the single source of truth
    localStorage.removeItem("trio_translation_engine");
    localStorage.removeItem("trio_gemini_model");
    localStorage.removeItem("trio_ocr_provider");
    localStorage.removeItem("trio_ai_model");
    localStorage.removeItem("trio_translation_style");
    localStorage.removeItem("trio_local_ai_runtime");
    localStorage.removeItem("trio_local_ai_endpoint");
    localStorage.removeItem("trio_local_ai_model");
    localStorage.removeItem("trio_ocr_endpoint");
    return true;
  };

  const saveAndLeave = async () => {
    if (savingRef.current || geminiKeyMutating || geminiApiKeyRef.current.trim()) return;
    const navigate = pendingLeaveRef.current;
    setLeaveError(null);
    if (!await saveProviderSettings() || pendingLeaveRef.current !== navigate) return;
    if (!sameSettings(draftRef.current, savedSettingsRef.current)) {
      setLeaveError("저장 중 새로 변경한 설정이 있습니다. 입력값을 확인하고 다시 저장하세요.");
      return;
    }
    pendingLeaveRef.current = null;
    setLeaveOpen(false);
    navigate?.();
  };

  const handleSave = async () => {
    if (!await saveProviderSettings()) return;
    const savedMessage = () => sameSettings(draftRef.current, savedSettingsRef.current)
      ? "✓ 설정이 저장되었습니다."
      : "요청한 설정은 저장되었습니다. 이후 변경한 설정은 아직 저장되지 않았습니다.";

    const submittedKey = geminiApiKey.trim();
    if (submittedKey && window.projectApi?.setGeminiApiKey) {
      const mutationSeq = ++geminiKeyMutationSeqRef.current;
      setGeminiKeyMutating(true);
      setGeminiKeyMutationKind("save");
      try {
        const nextStatus = await window.projectApi.setGeminiApiKey({ apiKey: submittedKey });
        if (geminiKeyMutationSeqRef.current !== mutationSeq) return;
        setGeminiKeyQuery({ status: "ready", value: nextStatus });
        if (geminiApiKeyRef.current.trim() === submittedKey) {
          setGeminiApiKey("");
        }
        setApiKeyFeedbackMessage(messageForGeminiKeyStatus(nextStatus));
        triggerSavedToast(savedMessage());
      } catch (err) {
        if (geminiKeyMutationSeqRef.current !== mutationSeq) return;
        const apiKeySaveError = err instanceof Error ? err.message : "API 키 저장에 실패했습니다.";
        setApiKeyFeedbackMessage(apiKeySaveError);
        triggerSavedToast("⚠️ 설정은 저장되었으나 API 키 등록에 실패했습니다.");
      } finally {
        if (geminiKeyMutationSeqRef.current === mutationSeq) {
          setGeminiKeyMutating(false);
          setGeminiKeyMutationKind("idle");
        }
      }
      return;
    }

    triggerSavedToast(savedMessage());
  };


  const handleClearApiKey = async () => {
    if (!window.projectApi?.clearGeminiApiKey) return;
    const mutationSeq = ++geminiKeyMutationSeqRef.current;
    setGeminiKeyMutating(true);
    setGeminiKeyMutationKind("clear");
    try {
      const nextStatus = await window.projectApi.clearGeminiApiKey();
      if (geminiKeyMutationSeqRef.current !== mutationSeq) return;
      setGeminiKeyQuery({ status: "ready", value: nextStatus });
      if (!nextStatus.configured && !nextStatus.requiresReentry) {
        setApiKeyFeedbackMessage("저장된 API 키가 삭제되었습니다.");
      } else {
        setApiKeyFeedbackMessage(messageForGeminiKeyStatus(nextStatus));
      }
    } catch (err) {
      if (geminiKeyMutationSeqRef.current !== mutationSeq) return;
      setApiKeyFeedbackMessage(err instanceof Error ? err.message : "API 키 삭제에 실패했습니다.");
    } finally {
      if (geminiKeyMutationSeqRef.current === mutationSeq) {
        setGeminiKeyMutating(false);
        setGeminiKeyMutationKind("idle");
      }
    }
  };

  return (
    <AppShell
      activeNav="settings"
      recentProjects={props.recentProjects}
      onNavigate={(nav) => nav === "settings" ? props.onNavigate(nav) : requestLeave(() => props.onNavigate(nav))}
      onOpenProject={() => requestLeave(props.onOpenProject)}
      onOpenRecent={(id) => requestLeave(() => props.onOpenRecent(id))}
      onOpenSettings={props.onOpenSettings}
      onOpenPreparation={() => requestLeave(props.onOpenPreparation)}
      onNewProject={() => requestLeave(props.onNewProject)}
      onResumeWorkspace={props.onResumeWorkspace ? () => requestLeave(props.onResumeWorkspace!) : undefined}
    >
      <div className="trio-page-container stitch-settings" inert={leaveOpen}>
        {/* Page Header */}
        <PageHeader title={<>환경 설정</>} description={null} />

        {/* Settings Layout: Left Vertical Tabs + Right Content Panel */}
        <div className="trio-settings-layout">
          {/* Left Vertical Tab List */}
          <nav className="trio-settings-tabs-nav" aria-label="설정 분류" role="tablist" aria-orientation="vertical" onKeyDown={handleTabKeys}>
            <button
              type="button"
              role="tab"
              id="tab-general"
              aria-controls="panel-general"
              aria-selected={activeTab === "general"}
              tabIndex={activeTab === "general" ? 0 : -1}
              className={`trio-settings-tab-btn ${activeTab === "general" ? "active" : ""}`}
              onClick={() => setActiveTab("general")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              <span>일반 설정</span>
            </button>

            <button
              type="button"
              role="tab"
              id="tab-ai"
              aria-controls="panel-ai"
              aria-selected={activeTab === "ai"}
              tabIndex={activeTab === "ai" ? 0 : -1}
              className={`trio-settings-tab-btn ${activeTab === "ai" ? "active" : ""}`}
              onClick={() => setActiveTab("ai")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"></path>
              </svg>
              <span>AI 번역 엔진</span>
            </button>

            <button
              type="button"
              role="tab"
              id="tab-typesetting"
              aria-controls="panel-typesetting"
              aria-selected={activeTab === "typesetting"}
              tabIndex={activeTab === "typesetting" ? 0 : -1}
              className={`trio-settings-tab-btn ${activeTab === "typesetting" ? "active" : ""}`}
              onClick={() => setActiveTab("typesetting")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="4 7 4 4 20 4 20 7"></polyline>
                <line x1="9" y1="20" x2="15" y2="20"></line>
                <line x1="12" y1="4" x2="12" y2="20"></line>
              </svg>
              <span>식자 오버레이</span>
            </button>

            <button
              type="button"
              role="tab"
              id="tab-storage"
              aria-controls="panel-storage"
              aria-selected={activeTab === "storage"}
              tabIndex={activeTab === "storage" ? 0 : -1}
              className={`trio-settings-tab-btn ${activeTab === "storage" ? "active" : ""}`}
              onClick={() => setActiveTab("storage")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>저장소 및 백업</span>
            </button>

            <button
              type="button"
              role="tab"
              id="tab-shortcuts"
              aria-controls="panel-shortcuts"
              aria-selected={activeTab === "shortcuts"}
              tabIndex={activeTab === "shortcuts" ? 0 : -1}
              className={`trio-settings-tab-btn ${activeTab === "shortcuts" ? "active" : ""}`}
              onClick={() => setActiveTab("shortcuts")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="4" width="20" height="16" rx="2"></rect>
                <line x1="6" y1="8" x2="6.01" y2="8"></line>
                <line x1="10" y1="8" x2="10.01" y2="8"></line>
                <line x1="14" y1="8" x2="14.01" y2="8"></line>
                <line x1="18" y1="8" x2="18.01" y2="8"></line>
                <line x1="8" y1="16" x2="16" y2="16"></line>
              </svg>
              <span>키보드 단축키</span>
            </button>

            <button
              type="button"
              role="tab"
              id="tab-about"
              aria-controls="panel-about"
              aria-selected={activeTab === "about"}
              tabIndex={activeTab === "about" ? 0 : -1}
              className={`trio-settings-tab-btn ${activeTab === "about" ? "active" : ""}`}
              onClick={() => setActiveTab("about")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              <span>앱 정보</span>
            </button>
          </nav>

          {/* Right Tab Content Panel */}
          <div className="trio-settings-content-panel">
            {activeTab === "general" && (
              <div role="tabpanel" tabIndex={0} id="panel-general" aria-labelledby="tab-general" className="trio-settings-section">
                <h2 className="trio-settings-section-title">일반 환경 설정</h2>
                <SettingsRow title={<>테마 모드</>} description={null} >
                  <div className="trio-segmented-control" role="group" aria-label="테마 모드">
                    <button
                      type="button"
                      className={props.uiTheme === "light" ? "active" : ""}
                      aria-pressed={props.uiTheme === "light"}
                      onClick={() => {
                        markSettingTouched("theme");
                        props.onUiThemeChange("light");
                      }}
                    >
                      라이트
                    </button>
                    <button
                      type="button"
                      className={props.uiTheme === "dark" ? "active" : ""}
                      aria-pressed={props.uiTheme === "dark"}
                      onClick={() => {
                        markSettingTouched("theme");
                        props.onUiThemeChange("dark");
                      }}
                    >
                      다크
                    </button>
                  </div>
                </SettingsRow>


                <SettingsRow title={<>기본 언어</>} description={null} >
                  <span className="trio-badge muted">현재 미지원</span>
                </SettingsRow>

                <SettingsRow controlId={`${fieldPrefix}-start`} title={<>시작 화면</>} description={<>앱 실행 시 표시할 화면</>} >
                  <select
                    id={`${fieldPrefix}-start`}
                    aria-describedby={`${fieldPrefix}-start-description`}
                    className="trio-select-control"
                    aria-label="시작 화면"
                    value={startScreen}
                    onChange={(e) => {
                      markSettingTouched("startScreen");
                      setStartScreen(e.target.value === "projects" ? "projects" : "home");
                    }}
                  >
                    <option value="home">홈 대시보드</option>
                    <option value="projects">프로젝트 목록</option>
                  </select>
                </SettingsRow>
              </div>
            )}

            {activeTab === "ai" && (
              <div role="tabpanel" tabIndex={0} id="panel-ai" aria-labelledby="tab-ai" className="trio-settings-section">
                <h2 className="trio-settings-section-title">AI 번역 및 OCR 엔진</h2>
                <p className="stitch-settings-intro">서버 연결 확인은 번역 성공을 보장하지 않습니다.</p>

                <div className="trio-setting-item vertical">
                  <div className="trio-setting-info">
                    <div className="trio-setting-heading">
                      <label htmlFor={`${fieldPrefix}-key`}>Gemini API 키</label>
                      <span className={`trio-badge ${geminiKeyBadgeTone(geminiKeyQuery)}`}>
                        {geminiKeyBadgeLabel(geminiKeyQuery)}
                      </span>
                    </div>
                    <p id={`${fieldPrefix}-key-description`}>
                      Gemini 번역·인페인팅용 키입니다. OCR은 로컬에서 실행되며 이 키를 사용하지 않습니다.{" "}
                      {geminiKeyStatusDetail(geminiKeyQuery)}
                    </p>
                  </div>
                  <div className="trio-input-with-action">
                    <input
                      id={`${fieldPrefix}-key`}
                      aria-describedby={`${fieldPrefix}-key-description${apiKeyFeedbackMessage ? ` ${fieldPrefix}-key-feedback` : ""}`}
                      type="password"
                      className="trio-text-input"
                      aria-label="Gemini API 키"
                      value={geminiApiKey}
                      onChange={(e) => setGeminiApiKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                          e.preventDefault();
                          void handleSave();
                        }
                      }}
                      placeholder={geminiApiKeyStatus?.configured ? "새 API 키로 변경하려면 입력하세요..." : "API 키를 입력하세요..."}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => requestLeave(props.onOpenPreparation)}
                    >
                      환경 준비 확인
                    </Button>
                    {geminiApiKeyStatus?.configured && (
                      <Button
                        type="button"
                          variant="destructive"
                          onClick={handleClearApiKey}
                      >
                        키 삭제
                      </Button>
                    )}
                  </div>
                  {geminiKeyMutating ? (
                    <p role="status" style={{ margin: "var(--trio-space-1) 0 0", fontSize: "var(--trio-text-caption)", color: "var(--ink-muted)" }}>
                      {geminiKeyMutationKind === "clear"
                        ? "API 키를 삭제하는 중입니다. 입력 중인 내용은 유지됩니다."
                        : "API 키를 저장하는 중입니다. 입력 중인 내용은 유지됩니다."}
                    </p>
                  ) : null}
                  {apiKeyFeedbackMessage && (
                    <p id={`${fieldPrefix}-key-feedback`} style={{ margin: "var(--trio-space-1) 0 0", fontSize: "var(--trio-text-caption)", color: "var(--trio-accent)", fontWeight: 600 }}>
                      {apiKeyFeedbackMessage}
                    </p>
                  )}
                </div>

                <SettingsRow controlId={`${fieldPrefix}-engine`} title={<>AI 번역 엔진 선택</>} description={<>만화 대사 번역에 사용할 AI 엔진입니다.</>} >
                  <select
                    id={`${fieldPrefix}-engine`}
                    aria-describedby={`${fieldPrefix}-engine-description`}
                    className="trio-select-control"
                    aria-label="AI 번역 엔진 선택"
                    value={translationEngine}
                    onChange={(e) => {
                      const val = e.target.value;
                      markSettingTouched("translationEngine");
                      setTranslationEngine(val === "local_ai" || val === "local-ollama" ? "local_ai" : "gemini");
                    }}
                  >
                    <option value="gemini">Google Gemini (권장 · 클라우드)</option>
                    <option value="local_ai">로컬 온디바이스 AI (Ollama / CUDA 가속)</option>
                    <option value="local-ollama" style={{ display: "none" }}>로컬 AI (호환용)</option>
                  </select>
                </SettingsRow>

                {translationEngine === "gemini" && (
                  <SettingsRow controlId={`${fieldPrefix}-gemini-model`} title={<>Gemini 모델 선택</>} description={<>번역 속도와 문맥 이해 품질 중 우선할 모델을 선택합니다.</>} >
                    <select
                      id={`${fieldPrefix}-gemini-model`}
                      aria-describedby={`${fieldPrefix}-gemini-model-description`}
                      className="trio-select-control"
                      aria-label="Gemini 모델 선택"
                      value={geminiModel}
                      onChange={(e) => {
                        markSettingTouched("geminiModel");
                        setGeminiModel(e.target.value);
                      }}
                    >
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash (권장 · 빠름)</option>
                      <option value="gemini-2.5-pro">Gemini 2.5 Pro (고품질 문맥 이해)</option>
                    </select>
                  </SettingsRow>
                )}

                <SettingsRow title={<>Production OCR</>} description={<>고정된 로컬 OCR 엔진</>} >
                  <details><summary>엔진 상세</summary><p>PP-OCRv6_medium_det → Region Grouping → Baberu OCR (Windows x64 CPU)</p></details>
                  <Button type="button" variant="secondary" onClick={() => requestLeave(props.onOpenPreparation)}>
                    Production OCR 환경 준비
                  </Button>
                </SettingsRow>

                <SettingsRow controlId={`${fieldPrefix}-style`} title={<>번역 스타일 프리셋</>} description={<>만화 장르에 어울리는 어투와 문체를 지정합니다.</>} >
                  <select
                    id={`${fieldPrefix}-style`}
                    aria-describedby={`${fieldPrefix}-style-description`}
                    className="trio-select-control"
                    aria-label="번역 스타일 프리셋"
                    value={translationStyle}
                    onChange={(e) => {
                      markSettingTouched("translationStyle");
                      setTranslationStyle(e.target.value);
                    }}
                  >
                    <option value="natural">자연스러운 한국어 웹툰 어투</option>
                    <option value="literal">원문 충실 (직역 위주)</option>
                    <option value="action">액션/판타지 박진감 어투</option>
                    <option value="romance">로맨스 부드러운 구어체</option>
                  </select>
                </SettingsRow>

                {/* Local AI & Hardware Acceleration Section (CarrotMangaTranslator Architecture) */}
                <div className="trio-settings-local-engine" style={{ marginTop: "var(--trio-space-2)" }}>
                <SettingsRow title={<>로컬 번역 엔진</>} description={<>선택한 서버에서 번역합니다.</>} className="vertical">

                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--trio-space-2)", marginTop: "var(--trio-space-2)" }}>
                    <div className="trio-settings-form-grid">
                      <div>
                        <label htmlFor={`${fieldPrefix}-runtime`} style={{ fontSize: "var(--trio-text-caption)", fontWeight: 600, display: "block", marginBottom: "var(--trio-space-1)" }}>
                          로컬 엔진 런타임
                        </label>
                        <select
                          id={`${fieldPrefix}-runtime`}
                          className="trio-select-control"
                          aria-label="로컬 엔진 런타임"
                          value={localAiRuntime}
                          onChange={(e) => {
                            markSettingTouched("localAiRuntime");
                            setLocalAiRuntime(e.target.value as "ollama" | "lmstudio" | "vllm" | "custom");
                          }}
                        >
                          <option value="ollama">Ollama (NVIDIA CUDA 자동 감지)</option>
                          <option value="lmstudio">LM Studio (OpenAI 호환)</option>
                          <option value="vllm">vLLM / llama.cpp Server</option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${fieldPrefix}-endpoint`} style={{ fontSize: "var(--trio-text-caption)", fontWeight: 600, display: "block", marginBottom: "var(--trio-space-1)" }}>
                          로컬 서버 주소
                        </label>
                        <input
                          id={`${fieldPrefix}-endpoint`}
                          aria-describedby={localAiTestResult ? `${fieldPrefix}-connection-result` : undefined}
                          type="text"
                          className="trio-text-input"
                          aria-label="로컬 서버 주소"
                          value={localAiEndpoint}
                          onChange={(e) => {
                            markSettingTouched("localAiEndpoint");
                            setLocalAiEndpoint(e.target.value);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                              e.preventDefault();
                              handleTestLocalAi();
                            }
                          }}
                          placeholder="http://localhost:11434"
                        />
                      </div>
                    </div>


                    <div>
                      <label htmlFor={`${fieldPrefix}-local-model`} style={{ fontSize: "var(--trio-text-caption)", fontWeight: 600, display: "block", marginBottom: "var(--trio-space-1)" }}>
                        로컬 AI 모델
                      </label>
                      <select
                        id={`${fieldPrefix}-local-model`}
                        aria-describedby={`${fieldPrefix}-model-help${installedLocalModels.includes(localAiModel) && localAiModel.length > 48 ? ` ${fieldPrefix}-model-value` : ""}`}
                        className="trio-select-control"
                        aria-label="로컬 AI 모델"
                        value={localAiModel}
                        onChange={(e) => {
                          markSettingTouched("localAiModel");
                          setLocalAiModel(e.target.value);
                        }}
                      >
                        {installedLocalModels.length > 0 ? (
                          installedLocalModels.map((m) => (
                            <option key={m} value={m}>
                              {m} (설치됨)
                            </option>
                          ))
                        ) : (
                          <option value="" disabled>
                            설치된 로컬 모델이 없습니다 (서버 연결 및 모델 설치 필요)
                          </option>
                        )}
                      </select>
                      {installedLocalModels.includes(localAiModel) && localAiModel.length > 48 ? <p className="trio-setting-full-value" id={`${fieldPrefix}-model-value`}>{localAiModel}</p> : null}
                      <p id={`${fieldPrefix}-model-help`} style={{ fontSize: "var(--trio-text-caption)", color: "var(--ink-muted)", margin: "var(--trio-space-1) 0 0" }}>
                        💡 권장 모델: 터미널에서 <code>ollama pull qwen2.5:7b-instruct</code> 또는 <code>ollama pull llama3.2:3b</code> 설치 후 서버 연결을 테스트하세요.
                      </p>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "var(--trio-space-2)", marginTop: "var(--trio-space-1)" }}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="compact"
                        disabled={localAiTesting}
                        aria-busy={localAiTesting}
                        aria-describedby={localAiTestResult ? `${fieldPrefix}-connection-result` : undefined}
                        onClick={handleTestLocalAi}
                      >
                        {localAiTesting ? "🔄 연결 및 모델 확인 중..." : "🔌 로컬 서버 연결 및 모델 확인"}
                      </Button>
                    </div>

                    {localAiTestResult && (
                      <Feedback id={`${fieldPrefix}-connection-result`} tone={localAiTestResult.ok ? "success" : "error"}>
                        {localAiTestResult.ok ? "✅ " : "❌ "}
                        {localAiTestResult.message}
                        {localAiTestResult.version ? ` (버전: ${localAiTestResult.version})` : ""}
                      </Feedback>
                    )}

                    <details className="trio-settings-note">
                      <summary>하드웨어 가속 안내</summary>
                      <span>가속 지원 여부는 서버와 하드웨어 설정에 따라 다릅니다.</span>
                    </details>
                  </div>
                </SettingsRow>
                </div>
              </div>
            )}



            {activeTab === "typesetting" && (
              <div role="tabpanel" tabIndex={0} id="panel-typesetting" aria-labelledby="tab-typesetting" className="trio-settings-section">
                <h2 className="trio-settings-section-title">식자 오버레이 기본 스타일</h2>
                <p className="stitch-settings-intro">스타일은 작업대에서 페이지별로 설정합니다.</p>

                <SettingsRow title={<>기본 폰트</>} description={null} >
                  <span className="trio-badge muted">현재 미지원</span>
                </SettingsRow>

                <SettingsRow title={<>기본 글자 크기</>} description={null} >
                  <span className="trio-badge muted">현재 미지원</span>
                </SettingsRow>

                <SettingsRow title={<>스마트 자동 줄바꿈</>} description={null} >
                  <span className="trio-badge muted">현재 미지원</span>
                </SettingsRow>
              </div>
            )}

            {activeTab === "storage" && (
              <div role="tabpanel" tabIndex={0} id="panel-storage" aria-labelledby="tab-storage" className="trio-settings-section">
                <h2 className="trio-settings-section-title">저장소 및 백업</h2>
                <SettingsRow controlId={`${fieldPrefix}-storage`} title={<>프로젝트 저장 기본 경로</>} description={<>새 프로젝트의 기본 저장 위치</>} className="vertical" >
                  <div className="trio-input-with-action">
                    <input
                      id={`${fieldPrefix}-storage`}
                      aria-describedby={`${fieldPrefix}-storage-description`}
                      type="text"
                      className="trio-text-input"
                      aria-label="프로젝트 저장 기본 경로"
                      value={defaultStoragePath}
                      onChange={(e) => {
                        markSettingTouched("defaultStoragePath");
                        setDefaultStoragePath(e.target.value);
                      }}
                      placeholder="기본 저장 경로를 입력하세요"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        markSettingTouched("defaultStoragePath");
                        setDefaultStoragePath("");
                      }}
                    >
                      기본값으로 초기화
                    </Button>
                  </div>
                </SettingsRow>

                <SettingsRow title={<>자동 백업 주기</>} description={<>프로젝트 저장·복구는 사용 가능</>} >
                  <span className="trio-badge muted">현재 미지원</span>
                </SettingsRow>

                <SettingsRow tone="danger" title={<>임시 화면 데이터</>} description={<>현재 창의 임시 표시 데이터만 정리합니다. 프로젝트는 유지됩니다.</>} >
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      try {
                        sessionStorage.clear();
                      } catch {}
                      triggerSavedToast("✓ 임시 세션 데이터가 정리되었습니다.");
                    }}
                  >
                    임시 UI 데이터 정리
                  </Button>
                </SettingsRow>
              </div>
            )}

            {activeTab === "shortcuts" && (
              <div role="tabpanel" tabIndex={0} id="panel-shortcuts" aria-labelledby="tab-shortcuts" className="trio-settings-section">
                <h2 className="trio-settings-section-title">키보드 단축키 안내</h2>
                <p className="stitch-settings-intro">작업대의 입력 영역과 현재 도구에 따라 단축키가 동작합니다.</p>
                <div className="trio-shortcuts-table-wrap">
                  <table className="trio-shortcuts-table">
                    <thead>
                      <tr>
                        <th>기능</th>
                        <th>단축키 (Windows)</th>
                        <th>단축키 (macOS)</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>새 프로젝트 만들기</td>
                        <td><kbd>Ctrl</kbd> + <kbd>N</kbd></td>
                        <td><kbd>⌘</kbd> + <kbd>N</kbd></td>
                      </tr>
                      <tr>
                        <td>프로젝트 열기</td>
                        <td><kbd>Ctrl</kbd> + <kbd>O</kbd></td>
                        <td><kbd>⌘</kbd> + <kbd>O</kbd></td>
                      </tr>
                      <tr>
                        <td>프로젝트 저장 (.ctp)</td>
                        <td><kbd>Ctrl</kbd> + <kbd>S</kbd></td>
                        <td><kbd>⌘</kbd> + <kbd>S</kbd></td>
                      </tr>
                      <tr>
                        <td>AI 문맥 번역 실행</td>
                        <td><kbd>Alt</kbd> + <kbd>T</kbd></td>
                        <td><kbd>⌥</kbd> + <kbd>T</kbd></td>
                      </tr>
                      <tr>
                        <td>이전 / 다음 대사 이동</td>
                        <td><kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>Alt</kbd> + <kbd>↓</kbd></td>
                        <td><kbd>⌥</kbd> + <kbd>↑</kbd> / <kbd>⌥</kbd> + <kbd>↓</kbd></td>
                      </tr>
                      <tr>
                        <td>대사 상태 빠른 변경</td>
                        <td><kbd>Alt</kbd> + <kbd>1</kbd>(초안) / <kbd>2</kbd>(완료) / <kbd>3</kbd>(검토)</td>
                        <td><kbd>⌥</kbd> + <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd></td>
                      </tr>
                      <tr>
                        <td>이미지 뷰포트 줌 확대 / 축소 / 맞춤</td>
                        <td><kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> (더블클릭 토글)</td>
                        <td><kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> (더블클릭 토글)</td>
                      </tr>
                      <tr>
                        <td>식자 말풍선 형태 전환</td>
                        <td><kbd>1</kbd> (⬭), <kbd>2</kbd> (▭), <kbd>3</kbd> (☁), <kbd>4</kbd> (🗯)</td>
                        <td><kbd>1</kbd> (⬭), <kbd>2</kbd> (▭), <kbd>3</kbd> (☁), <kbd>4</kbd> (🗯)</td>
                      </tr>
                      <tr>
                        <td>인페인팅 브러시 / 지우개 / 크기</td>
                        <td><kbd>B</kbd>(브러시) / <kbd>E</kbd>(지우개) / <kbd>[</kbd>, <kbd>]</kbd>(크기) / 휠</td>
                        <td><kbd>B</kbd> / <kbd>E</kbd> / <kbd>[</kbd>, <kbd>]</kbd> / 휠</td>
                      </tr>
                      <tr>
                        <td>식자 상자 위치 이동</td>
                        <td><kbd>방향키</kbd> (<kbd>Shift</kbd>로 가속)</td>
                        <td><kbd>방향키</kbd> (<kbd>Shift</kbd>로 가속)</td>
                      </tr>

                      <tr>
                        <td>이전 / 다음 페이지</td>
                        <td><kbd>←</kbd> / <kbd>→</kbd></td>
                        <td><kbd>←</kbd> / <kbd>→</kbd></td>
                      </tr>
                      <tr>
                        <td>이전 / 다음 문제 라인</td>
                        <td><kbd>[</kbd> / <kbd>]</kbd></td>
                        <td><kbd>[</kbd> / <kbd>]</kbd></td>
                      </tr>
                      <tr>
                        <td>사이드바 패널 토글</td>
                        <td><kbd>Ctrl</kbd> + <kbd>B</kbd></td>
                        <td><kbd>⌘</kbd> + <kbd>B</kbd></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}


            {activeTab === "about" && (
              <div role="tabpanel" tabIndex={0} id="panel-about" aria-labelledby="tab-about" className="trio-settings-section">
                <h2 className="trio-settings-section-title">망고하나 앱 정보</h2>
                <div className="trio-about-box">
                  <div className="trio-about-logo-wrap">
                    <div className="trio-brand-icon" style={{ width: "36px", height: "36px" }}>
                      <img src={mangohanaMark} width="36" height="36" alt="" />
                    </div>
                    <div>
                      <strong className="trio-about-app-name">망고하나 만화 번역 작업실</strong>
                      <span className="trio-about-version">버전 0.1.4</span>
                    </div>
                  </div>
                  <div className="trio-about-meta-grid">
                    <div>
                      <span>라이선스</span>
                      <strong>앱 내 라이선스 확인 미지원</strong>
                    </div>
                  </div>
                  <div className="trio-about-actions">
                    <Button type="button" variant="secondary" onClick={() => requestLeave(props.onOpenPreparation)}>
                      환경 점검 실행
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        <footer className="stitch-settings-save-footer" aria-label="설정 저장 영역">
          <div className="stitch-settings-save-status">
            {savedToast ? <span className="trio-toast-saved" role="status">{toastMessage}</span> : null}
            {settingsLoadState === "loading" ? <span role="status">설정을 불러오는 중입니다.</span> : null}
            {saving ? <span role="status">설정을 저장하는 중입니다.</span> : null}
            {settingsLoadState === "error" ? (
              <div role="alert">
                <span>{settingsLoadError ?? "설정을 불러오지 못했습니다."}</span>
                <Button type="button" variant="secondary" onClick={() => void loadProviderSettings()} aria-label="설정 다시 불러오기">다시 시도</Button>
              </div>
            ) : null}
          </div>
          <Button type="button" variant="primary" onClick={handleSave} aria-label="설정 저장" disabled={settingsLoadState !== "ready" || saving}>
            변경 사항 저장
          </Button>
        </footer>
      </div>
      {leaveOpen ? (
        <div className="trio-modal-backdrop stitch-dialog-backdrop" onClick={continueEditing}>
          <div ref={leaveDialogRef} className="trio-modal-card stitch-dialog stitch-dialog--settings-leave" role="dialog" aria-modal="true" tabIndex={-1}
            aria-label="저장하지 않은 설정" aria-describedby={`${fieldPrefix}-leave-description`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); continueEditing(); } }}>
            <div className="trio-modal-header"><div><p className="stitch-dialog-kicker">환경 설정 / 이동 확인</p><h3>저장하지 않은 설정</h3></div></div>
            <div className="trio-modal-body">
              <p id={`${fieldPrefix}-leave-description`}>이동하기 전에 변경한 설정을 저장하거나 버릴지 선택하세요.</p>
              {geminiApiKey.trim() || geminiKeyMutating ? <p>API 키는 별도로 적용됩니다. 계속 편집에서 키 적용을 마치거나, 입력 중인 키를 비운 뒤 이동하세요. 변경을 버리면 입력 중인 키만 폐기되며 이미 적용한 키는 유지됩니다.</p> : null}
              {leaveError ? <p role="alert">{leaveError}</p> : null}
              {saving ? <p role="status">설정을 저장하는 중입니다.</p> : null}
            </div>
            <div className="trio-modal-footer">
              <Button type="button" variant="secondary" onClick={continueEditing}>계속 편집</Button>
              <Button type="button" variant="secondary" disabled={saving || geminiKeyMutating} onClick={() => {
                const navigate = pendingLeaveRef.current;
                pendingLeaveRef.current = null;
                props.onUiThemeChange(savedSettingsRef.current.theme);
                setLeaveOpen(false);
                navigate?.();
              }}>변경을 버리고 이동</Button>
              <Button type="button" variant="primary" disabled={saving || geminiKeyMutating || Boolean(geminiApiKey.trim()) || settingsLoadState !== "ready"}
                onClick={() => void saveAndLeave()}>저장하고 이동</Button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

function messageForGeminiKeyStatus(status: GeminiApiKeyStatus): string {
  if (status.requiresReentry) {
    return "저장된 Gemini API 키를 복원하지 못했습니다. 다시 입력해 주세요.";
  }
  if (status.source === "environment") {
    return "Gemini API 키는 환경 변수에서 제공되고 있습니다.";
  }
  if (status.persistence === "encrypted" && status.source === "encrypted") {
    return "Gemini API 키가 안전하게 저장되었습니다. 앱을 다시 실행해도 유지됩니다.";
  }
  if (status.persistence === "session-only") {
    return "Gemini API 키는 현재 실행에서만 사용할 수 있습니다. 앱을 다시 실행하면 다시 입력해야 합니다.";
  }
  if (status.persistence === "unavailable") {
    return "이 환경에서는 영구 암호화 저장을 사용할 수 없습니다. 현재 실행에서만 키를 사용할 수 있습니다.";
  }
  return "Gemini API 키 상태를 갱신했습니다.";
}

function geminiKeyBadgeLabel(state: GeminiKeyQueryState): string {
  if (state.status === "loading") return "○ 확인 중";
  if (state.status === "error") return "○ 확인 실패";
  if (state.status === "unavailable") return "○ 확인할 수 없음";
  if (state.value.requiresReentry) return "○ 재입력 필요";
  return state.value.configured ? "● 키 설정됨" : "○ 미설정";
}

function geminiKeyBadgeTone(state: GeminiKeyQueryState): string {
  if (state.status === "error") return "danger";
  if (state.status === "ready" && state.value.requiresReentry) return "warning";
  return "muted";
}

function geminiKeyStatusDetail(state: GeminiKeyQueryState): string {
  if (state.status === "loading") return " 저장된 API 키 상태를 확인하는 중입니다.";
  if (state.status === "error") return ` ${state.message}`;
  if (state.status === "unavailable") return " 이 화면에서 API 키 상태를 조회할 수 없습니다.";
  if (state.value.requiresReentry) return " 저장된 키를 복원하지 못했습니다. 다시 입력해 주세요.";
  if (state.value.source === "environment") return " (환경 변수에서 불러옴)";
  if (state.value.persistence === "encrypted" && state.value.source === "encrypted") return " (안전 저장소에 보관 중)";
  if (state.value.persistence === "session-only") {
    return " 현재 실행에서만 사용할 수 있으며, 앱을 다시 실행하면 다시 입력해야 합니다.";
  }
  if (state.value.configured && state.value.persistence === "unavailable") {
    return " 이 환경에서는 영구 암호화 저장을 사용할 수 없습니다.";
  }
  return "";
}
