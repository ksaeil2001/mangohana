import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SettingsPage } from "../../src/renderer/components/SettingsPage";
import type { SettingsPageProps } from "../../src/renderer/components/SettingsPage";
import { DEFAULT_PROVIDER_SETTINGS } from "../../src/shared/providerSettings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("SettingsPage", () => {
  beforeEach(() => {
    if (window.projectApi && "getProviderSettings" in window.projectApi) {
      delete (window.projectApi as { getProviderSettings?: unknown }).getProviderSettings;
    }
  });

  const dummyProps = {
    recentProjects: [],
    apiReady: true,
    uiTheme: "light" as const,
    onUiThemeChange: vi.fn(),
    onNewProject: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenPreparation: vi.fn(),
    onNavigate: vi.fn()
  };

  function ThemeSettings(props: Partial<SettingsPageProps>) {
    const [theme, setTheme] = useState<"light" | "dark">("dark");
    return <SettingsPage {...dummyProps} {...props} uiTheme={theme} onUiThemeChange={(next) => {
      props.onUiThemeChange?.(next);
      setTheme(next);
    }} />;
  }

  it("hydrates settings without changing or saving the current App theme or creating a dirty draft", async () => {
    const onUiThemeChange = vi.fn();
    const onNavigate = vi.fn();
    const updateProviderSettings = vi.fn();
    window.projectApi = {
      getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS), updateProviderSettings
    } as unknown as typeof window.projectApi;
    render(<ThemeSettings onUiThemeChange={onUiThemeChange} onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());

    expect(screen.getByRole("button", { name: "다크" })).toHaveAttribute("aria-pressed", "true");
    expect(onUiThemeChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("home");
    expect(screen.queryByRole("dialog", { name: "저장하지 않은 설정" })).not.toBeInTheDocument();
    expect(updateProviderSettings).not.toHaveBeenCalled();
  });

  it("retains the entry theme as the discard baseline after a delayed load and cancel", async () => {
    const pending = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const onNavigate = vi.fn();
    const updateProviderSettings = vi.fn();
    window.projectApi = {
      getProviderSettings: vi.fn().mockReturnValue(pending.promise), updateProviderSettings
    } as unknown as typeof window.projectApi;
    render(<ThemeSettings onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "라이트" }));
    await act(async () => { pending.resolve(DEFAULT_PROVIDER_SETTINGS); });

    expect(screen.getByRole("button", { name: "라이트" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    const dialog = screen.getByRole("dialog", { name: "저장하지 않은 설정" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "라이트" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    fireEvent.click(screen.getByRole("button", { name: "변경을 버리고 이동" }));
    expect(screen.getByRole("button", { name: "다크" })).toHaveAttribute("aria-pressed", "true");
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("home");
    expect(updateProviderSettings).not.toHaveBeenCalled();
  });

  it("keeps theme edits on save failure and restores the entry theme only on explicit discard", async () => {
    const updateProviderSettings = vi.fn().mockRejectedValue(new Error("테마 저장 테스트 실패"));
    window.projectApi = {
      getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS), updateProviderSettings
    } as unknown as typeof window.projectApi;
    render(<ThemeSettings />);
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "라이트" }));
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await screen.findByText(/테마 저장 테스트 실패/);
    expect(screen.getByRole("button", { name: "라이트" })).toHaveAttribute("aria-pressed", "true");
    expect(updateProviderSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ theme: "light" }));
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    fireEvent.click(screen.getByRole("button", { name: "변경을 버리고 이동" }));
    expect(screen.getByRole("button", { name: "다크" })).toHaveAttribute("aria-pressed", "true");
    expect(updateProviderSettings).toHaveBeenCalledTimes(1);
  });

  it("acknowledges only the submitted theme when a save completes after a newer choice", async () => {
    const pendingSave = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const updateProviderSettings = vi.fn().mockReturnValue(pendingSave.promise);
    window.projectApi = { updateProviderSettings } as unknown as typeof window.projectApi;
    const onNavigate = vi.fn();
    render(<ThemeSettings providerSettings={DEFAULT_PROVIDER_SETTINGS} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "라이트" }));
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    fireEvent.click(screen.getByRole("button", { name: "다크" }));
    await act(async () => { pendingSave.resolve(DEFAULT_PROVIDER_SETTINGS); });

    expect(screen.getByRole("button", { name: "다크" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText(/이후 변경한 설정은 아직 저장되지 않았습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "변경을 버리고 이동" }));
    expect(screen.getByRole("button", { name: "라이트" })).toHaveAttribute("aria-pressed", "true");
    expect(updateProviderSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ theme: "light" }));
  });

  it("keeps the current theme through a failed load and a successful retry", async () => {
    const getProviderSettings = vi.fn()
      .mockRejectedValueOnce(new Error("테마 조회 테스트 실패"))
      .mockResolvedValueOnce(DEFAULT_PROVIDER_SETTINGS);
    const onUiThemeChange = vi.fn();
    const updateProviderSettings = vi.fn();
    window.projectApi = { getProviderSettings, updateProviderSettings } as unknown as typeof window.projectApi;
    render(<ThemeSettings onUiThemeChange={onUiThemeChange} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "설정 다시 불러오기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "다크" })).toHaveAttribute("aria-pressed", "true");
    expect(onUiThemeChange).not.toHaveBeenCalled();
    expect(updateProviderSettings).not.toHaveBeenCalled();
  });

  it("describes the Gemini key without attributing local Production OCR to it", () => {
    render(<SettingsPage {...dummyProps} />);
    fireEvent.click(screen.getByRole("tab", { name: "AI 번역 엔진" }));
    expect(screen.getByLabelText("Gemini API 키", { exact: true })).toHaveAccessibleDescription(
      expect.stringContaining("OCR은 로컬에서 실행되며 이 키를 사용하지 않습니다.")
    );
  });

  it("keeps one save action in the footer across all six sections and does not submit composing Enter", () => {
    const updateProviderSettings = vi.fn();
    const testLocalAiConnection = vi.fn();
    window.projectApi = { updateProviderSettings, testLocalAiConnection } as unknown as typeof window.projectApi;
    render(<SettingsPage {...dummyProps} providerSettings={DEFAULT_PROVIDER_SETTINGS} />);
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    const footer = screen.getByRole("contentinfo", { name: "설정 저장 영역" });
    expect(within(footer).getByRole("button", { name: "설정 저장" })).toBeEnabled();
    fireEvent.click(screen.getByRole("tab", { name: "AI 번역 엔진" }));
    expect(within(footer).getByRole("button", { name: "설정 저장" })).toBeEnabled();
    fireEvent.keyDown(screen.getByLabelText("Gemini API 키", { exact: true }), { key: "Enter", isComposing: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "로컬 서버 주소" }), { key: "Enter", keyCode: 229 });
    expect(updateProviderSettings).not.toHaveBeenCalled();
    expect(testLocalAiConnection).not.toHaveBeenCalled();
  });

  it("connects visible property labels and descriptions to their fields", () => {
    render(<SettingsPage {...dummyProps} />);
    const start = screen.getByRole("combobox", { name: "시작 화면" }) as HTMLSelectElement;
    expect(start.labels?.[0]).toHaveTextContent("시작 화면");
    expect(start).toHaveAccessibleDescription("앱 실행 시 표시할 화면");
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    const endpoint = screen.getByRole("textbox", { name: "로컬 서버 주소" }) as HTMLInputElement;
    expect(endpoint.labels?.[0]).toHaveTextContent("로컬 서버 주소");
    fireEvent.change(endpoint, { target: { value: "http://localhost:11434/sim-draft" } });
    fireEvent.click(screen.getByRole("tab", { name: /일반 설정/ }));
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    expect(screen.getByRole("textbox", { name: "로컬 서버 주소" })).toHaveValue("http://localhost:11434/sim-draft");
  });

  it("protects unsaved settings on navigation and keeps editing on Escape", async () => {
    window.projectApi = { getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS) } as unknown as typeof window.projectApi;
    const onNavigate = vi.fn();
    render(<SettingsPage {...dummyProps} onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "projects" } });
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(onNavigate).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "저장하지 않은 설정" });
    expect(screen.getByRole("button", { name: "계속 편집" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "저장하지 않은 설정" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "시작 화면" })).toHaveValue("projects");
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    fireEvent.click(screen.getByRole("button", { name: "변경을 버리고 이동" }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("home");
  });

  it("guards the open workspace return callback and preserves its invocation until settings are saved", async () => {
    const onResumeWorkspace = vi.fn();
    const updateProviderSettings = vi.fn().mockImplementation(async (settings) => settings);
    window.projectApi = { updateProviderSettings } as unknown as typeof window.projectApi;
    render(<SettingsPage {...dummyProps} providerSettings={DEFAULT_PROVIDER_SETTINGS} onResumeWorkspace={onResumeWorkspace} />);
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "projects" } });
    const resume = screen.getByRole("button", { name: "작업대로 돌아가기" });
    resume.focus();
    fireEvent.click(resume);
    expect(onResumeWorkspace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "계속 편집" }));
    expect(resume).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "시작 화면" })).toHaveValue("projects");
    fireEvent.click(resume);
    fireEvent.click(screen.getByRole("button", { name: "저장하고 이동" }));
    await waitFor(() => expect(onResumeWorkspace).toHaveBeenCalledOnce());
    expect(updateProviderSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ startScreen: "projects" }));
  });

  it("saves once before leaving, preserves newer edits, and keeps the first destination", async () => {
    const pending = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const updateProviderSettings = vi.fn().mockReturnValue(pending.promise);
    window.projectApi = { getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS), updateProviderSettings } as unknown as typeof window.projectApi;
    const onNavigate = vi.fn();
    render(<SettingsPage {...dummyProps} onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "projects" } });
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    fireEvent.click(screen.getByRole("button", { name: "프로젝트" }));
    fireEvent.click(screen.getByRole("button", { name: "저장하고 이동" }));
    fireEvent.click(screen.getByRole("button", { name: "저장하고 이동" }));
    expect(updateProviderSettings).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    // An update arriving while the modal is open must not be marked saved by the older response.
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "home" } });
    await act(async () => { pending.resolve({ ...DEFAULT_PROVIDER_SETTINGS, startScreen: "projects", defaultStoragePath: "" }); });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("새로 변경한 설정");
    updateProviderSettings.mockImplementation(async (value) => value);
    fireEvent.click(screen.getByRole("button", { name: "저장하고 이동" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledExactlyOnceWith("home"));
  });

  it("retains drafts after save failure and allows explicit discard without saving", async () => {
    const updateProviderSettings = vi.fn().mockRejectedValue(new Error("SIM save failed"));
    window.projectApi = { getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS), updateProviderSettings } as unknown as typeof window.projectApi;
    const onOpenPreparation = vi.fn();
    render(<SettingsPage {...dummyProps} onOpenPreparation={onOpenPreparation} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.click(screen.getByRole("tab", { name: "AI 번역 엔진" }));
    fireEvent.change(screen.getByRole("textbox", { name: "로컬 서버 주소" }), { target: { value: "http://localhost:11434/draft" } });
    screen.getByRole("button", { name: "환경 준비 확인" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "환경 준비 확인" }));
    fireEvent.click(screen.getByRole("button", { name: "저장하고 이동" }));
    await screen.findByRole("alert");
    expect(onOpenPreparation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "계속 편집" }));
    expect(screen.getByRole("textbox", { name: "로컬 서버 주소" })).toHaveValue("http://localhost:11434/draft");
    expect(screen.getByRole("button", { name: "환경 준비 확인" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "환경 준비 확인" }));
    fireEvent.click(screen.getByRole("button", { name: "변경을 버리고 이동" }));
    expect(onOpenPreparation).toHaveBeenCalledTimes(1);
    expect(updateProviderSettings).toHaveBeenCalledTimes(1);
  });

  it("does not prompt for model query results or reverted settings and separates unapplied keys", async () => {
    const setGeminiApiKey = vi.fn();
    window.projectApi = { getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS), listLocalAiModels: vi.fn().mockResolvedValue([{ id: "query", name: "query" }]), setGeminiApiKey } as unknown as typeof window.projectApi;
    const onNavigate = vi.fn();
    render(<SettingsPage {...dummyProps} onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "projects" } });
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "home" } });
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "AI 번역 엔진" }));
    fireEvent.change(screen.getByLabelText("Gemini API 키", { exact: true }), { target: { value: "fake-key" } });
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(screen.getByRole("button", { name: "저장하고 이동" })).toBeDisabled();
    expect(setGeminiApiKey).not.toHaveBeenCalled();
  });

  it("renders settings header and general tab by default", () => {
    render(<SettingsPage {...dummyProps} />);

    expect(screen.getByRole("heading", { name: "환경 설정" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "설정 분류" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /일반 설정/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("일반 환경 설정")).toBeInTheDocument();
    expect(screen.getByText("테마 모드")).toBeInTheDocument();
  });

  it("moves through settings with arrow keys and exposes one tab stop", () => {
    render(<SettingsPage {...dummyProps} />);
    const general = screen.getByRole("tab", { name: "일반 설정" });
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowRight" });
    const ai = screen.getByRole("tab", { name: "AI 번역 엔진" });
    expect(ai).toHaveFocus();
    expect(ai).toHaveAttribute("aria-selected", "true");
    expect(general).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", ai.id);
    fireEvent.keyDown(ai, { key: "End" });
    expect(screen.getByRole("tab", { name: "앱 정보" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "앱 정보" }), { key: "ArrowRight" });
    expect(general).toHaveFocus();
  });

  it("applies theme through the App runtime consumer and exposes only implemented start screens", () => {
    const onUiThemeChange = vi.fn();
    render(<SettingsPage {...dummyProps} onUiThemeChange={onUiThemeChange} />);

    fireEvent.click(screen.getByRole("button", { name: "다크" }));
    expect(onUiThemeChange).toHaveBeenCalledWith("dark");
    expect(screen.queryByRole("button", { name: "시스템 연동" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "시작 화면" })).not.toHaveTextContent("마지막 작업 프로젝트");
  });

  it("shows unsupported preferences as informational text and excludes them from save payload", async () => {
    const updateProviderSettings = vi.fn().mockResolvedValue({});
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      updateProviderSettings
    } as unknown as typeof window.projectApi;
    render(<SettingsPage {...dummyProps} />);

    expect(screen.queryByRole("combobox", { name: "기본 언어" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /식자 오버레이/ }));
    expect(screen.queryByRole("combobox", { name: "기본 폰트" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /저장소 및 백업/ }));
    expect(screen.queryByRole("combobox", { name: "자동 백업 주기" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));

    await screen.findByText(/설정이 저장되었습니다/);
    const payload = updateProviderSettings.mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("appLanguage");
    expect(payload).not.toHaveProperty("autoBackupInterval");
    expect(payload).not.toHaveProperty("defaultFont");
    expect(payload).not.toHaveProperty("defaultFontSize");
    expect(payload).not.toHaveProperty("smartWrap");
  });

  it("switches to AI 번역 엔진 tab", () => {
    render(<SettingsPage {...dummyProps} />);

    const aiTab = screen.getByRole("tab", { name: /AI 번역 엔진/ });
    expect(aiTab).toHaveAttribute("aria-selected", "false");
    fireEvent.click(aiTab);

    expect(aiTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("AI 번역 및 OCR 엔진")).toBeInTheDocument();
    expect(screen.getByText("Gemini API 키")).toBeInTheDocument();
  });

  it("shows save feedback toast and updates provider settings in Main when clicking save button", async () => {
    const updateProviderSettings = vi.fn().mockResolvedValue({});
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      updateProviderSettings
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const saveBtn = screen.getByRole("button", { name: "설정 저장" });
    fireEvent.click(saveBtn);

    expect(await screen.findByText(/설정이 저장되었습니다/)).toBeInTheDocument();
    expect(updateProviderSettings).toHaveBeenCalledWith(
      expect.objectContaining({ translationEngine: "gemini" })
    );
    expect(localStorage.getItem("trio_translation_engine")).toBeNull();
  });

  it("handles Gemini API key status and interaction", async () => {
    const getGeminiApiKeyStatus = vi.fn().mockResolvedValue({ configured: true, source: "encrypted", persistence: "encrypted", requiresReentry: false });
    const setGeminiApiKey = vi.fn().mockResolvedValue({ configured: true, source: "encrypted", persistence: "encrypted", requiresReentry: false });
    const clearGeminiApiKey = vi.fn().mockResolvedValue({ configured: false, source: "none", persistence: "unavailable", requiresReentry: false });

    window.projectApi = {
      ...((window.projectApi as object) || {}),
      getGeminiApiKeyStatus,
      setGeminiApiKey,
      clearGeminiApiKey
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const aiTab = screen.getByRole("tab", { name: /AI 번역 엔진/ });
    fireEvent.click(aiTab);

    expect(await screen.findByText("● 키 설정됨")).toBeInTheDocument();

    const clearBtn = screen.getByRole("button", { name: "키 삭제" });
    fireEvent.click(clearBtn);

    expect(clearGeminiApiKey).toHaveBeenCalled();
  });

  it("tests local AI connection and renders result", async () => {
    const testLocalAiConnection = vi.fn().mockResolvedValue({
      ok: true,
      message: "Ollama 서버에 성공적으로 연결되었습니다. (12ms)",
      latencyMs: 12,
      version: "0.5.4"
    });

    window.projectApi = {
      ...((window.projectApi as object) || {}),
      testLocalAiConnection
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const aiTab = screen.getByRole("tab", { name: /AI 번역 엔진/ });
    fireEvent.click(aiTab);

    const testBtn = screen.getByRole("button", { name: /로컬 서버 연결 및 모델 확인/ });
    expect(testBtn).toBeInTheDocument();
    fireEvent.click(testBtn);

    expect(await screen.findByText(/Ollama 서버에 성공적으로 연결되었습니다/)).toBeInTheDocument();
    expect(testLocalAiConnection).toHaveBeenCalled();
  });

  it("does not apply a stale Local AI connection result after the endpoint changes", async () => {
    const pendingConnection = deferred<{ ok: boolean; message: string; latencyMs?: number; version?: string }>();
    const testLocalAiConnection = vi.fn().mockReturnValue(pendingConnection.promise);
    const listLocalAiModels = vi.fn().mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === "http://127.0.0.1:1234") {
        return [{ id: "model-b", name: "model-b" }];
      }
      return [{ id: "model-a", name: "model-a" }];
    });
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      testLocalAiConnection,
      listLocalAiModels
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));

    fireEvent.click(screen.getByRole("button", { name: /로컬 서버 연결 및 모델 확인/ }));
    await waitFor(() => expect(testLocalAiConnection).toHaveBeenCalledWith({
      runtime: "ollama",
      endpoint: "http://localhost:11434"
    }));

    fireEvent.change(screen.getByRole("textbox", { name: "로컬 서버 주소" }), {
      target: { value: "http://127.0.0.1:1234" }
    });
    expect(await screen.findByRole("option", { name: "model-b (설치됨)" })).toBeInTheDocument();

    await act(async () => {
      pendingConnection.resolve({
        ok: true,
        message: "서버 A에 성공적으로 연결되었습니다. (12ms)",
        latencyMs: 12,
        version: "0.5.4"
      });
      await pendingConnection.promise;
    });

    expect(screen.queryByText(/서버 A에 성공적으로 연결되었습니다/)).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "model-a (설치됨)" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "model-b (설치됨)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /로컬 서버 연결 및 모델 확인/ })).toBeEnabled();
  });

  it("does not apply a stale Local AI failure after the runtime changes", async () => {
    const pendingConnection = deferred<{ ok: boolean; message: string }>();
    const testLocalAiConnection = vi.fn().mockReturnValue(pendingConnection.promise);
    const listLocalAiModels = vi.fn().mockResolvedValue([]);
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      testLocalAiConnection,
      listLocalAiModels
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    fireEvent.click(screen.getByRole("button", { name: /로컬 서버 연결 및 모델 확인/ }));
    await waitFor(() => expect(testLocalAiConnection).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole("combobox", { name: "로컬 엔진 런타임" }), {
      target: { value: "lmstudio" }
    });

    await act(async () => {
      pendingConnection.reject(new Error("서버 A 연결에 실패했습니다."));
      await pendingConnection.promise.catch(() => undefined);
    });

    expect(screen.queryByText(/서버 A 연결에 실패했습니다/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /로컬 서버 연결 및 모델 확인/ })).toBeEnabled();
  });

  it("does not let a stale connection model list overwrite discovery for a newer endpoint", async () => {
    const pendingModels = deferred<Array<{ id: string; name: string }>>();
    const testLocalAiConnection = vi.fn().mockResolvedValue({
      ok: true,
      message: "서버 A에 성공적으로 연결되었습니다.",
      latencyMs: 8
    });
    let endpointAListCalls = 0;
    const listLocalAiModels = vi.fn().mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === "http://127.0.0.1:1234") {
        return [{ id: "model-b", name: "model-b" }];
      }
      endpointAListCalls += 1;
      if (endpointAListCalls === 1) return [];
      return pendingModels.promise;
    });
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      testLocalAiConnection,
      listLocalAiModels
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    expect(await screen.findByText("설치된 로컬 모델이 없습니다 (서버 연결 및 모델 설치 필요)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /로컬 서버 연결 및 모델 확인/ }));
    expect(await screen.findByText(/서버 A에 성공적으로 연결되었습니다/)).toBeInTheDocument();
    await waitFor(() => expect(endpointAListCalls).toBeGreaterThanOrEqual(2));

    fireEvent.change(screen.getByRole("textbox", { name: "로컬 서버 주소" }), {
      target: { value: "http://127.0.0.1:1234" }
    });
    expect(await screen.findByRole("option", { name: "model-b (설치됨)" })).toBeInTheDocument();
    expect(screen.queryByText(/서버 A에 성공적으로 연결되었습니다/)).not.toBeInTheDocument();

    await act(async () => {
      pendingModels.resolve([{ id: "model-a", name: "model-a" }]);
      await pendingModels.promise;
    });

    expect(screen.queryByRole("option", { name: "model-a (설치됨)" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "model-b (설치됨)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /로컬 서버 연결 및 모델 확인/ }));
    await waitFor(() => expect(testLocalAiConnection).toHaveBeenCalledWith({
      runtime: "ollama",
      endpoint: "http://127.0.0.1:1234"
    }));
    expect(await screen.findByRole("option", { name: "model-b (설치됨)" })).toBeInTheDocument();
  });

  it("displays placeholder when no local models are installed and updates on model list response", async () => {
    const listLocalAiModels = vi.fn().mockResolvedValue([]);
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      listLocalAiModels
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const aiTab = screen.getByRole("tab", { name: /AI 번역 엔진/ });
    fireEvent.click(aiTab);

    // Verify disabled placeholder is shown when 0 models are returned
    expect(
      await screen.findByText("설치된 로컬 모델이 없습니다 (서버 연결 및 모델 설치 필요)")
    ).toBeInTheDocument();

    // Verify fake option text is not present as actual option
    expect(screen.queryByText("Qwen 2.5 7B Instruct (6~8GB VRAM 권장 · 만화/일한)")).not.toBeInTheDocument();
  });

  it("configures translation separately while Production OCR has no selector", () => {
    const updateProviderSettings = vi.fn().mockResolvedValue({});
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      updateProviderSettings
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const aiTab = screen.getByRole("tab", { name: /AI 번역 엔진/ });
    fireEvent.click(aiTab);

    const translationSelect = screen.getByRole("combobox", { name: "AI 번역 엔진 선택" });

    expect(translationSelect).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "말풍선 OCR 엔진 선택" })).not.toBeInTheDocument();
    expect(screen.getByText(/PP-OCRv6_medium_det.*Baberu/)).toBeInTheDocument();

    fireEvent.change(translationSelect, { target: { value: "local-ollama" } });

    const saveBtn = screen.getByRole("button", { name: "설정 저장" });
    fireEvent.click(saveBtn);

    expect(updateProviderSettings).toHaveBeenCalledWith(expect.objectContaining({
      translationEngine: "local_ai"
    }));
    expect(updateProviderSettings.mock.calls[0]![0]).not.toHaveProperty("ocrEngine");
    expect(localStorage.getItem("trio_translation_engine")).toBeNull();
    expect(localStorage.getItem("trio_ocr_provider")).toBeNull();
  });

  it("shows warning toast when Gemini API key save fails", async () => {
    const setGeminiApiKey = vi.fn().mockRejectedValue(new Error("API 키 권한 오류"));
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      setGeminiApiKey
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const aiTab = screen.getByRole("tab", { name: /AI 번역 엔진/ });
    fireEvent.click(aiTab);

    const apiKeyInput = screen.getByPlaceholderText("API 키를 입력하세요...");
    fireEvent.change(apiKeyInput, { target: { value: "invalid-key" } });

    const saveBtn = screen.getByRole("button", { name: "설정 저장" });
    fireEvent.click(saveBtn);

    expect(await screen.findByText(/API 키 권한 오류/)).toBeInTheDocument();
    expect(await screen.findByText(/설정은 저장되었으나 API 키 등록에 실패했습니다/)).toBeInTheDocument();
    expect(screen.queryByText("✓ 설정이 저장되었습니다.")).not.toBeInTheDocument();
  });

  it("restores local_ai translation engine on reload and does not overwrite with Gemini upon save", async () => {
    const updateProviderSettings = vi.fn().mockResolvedValue({});
    const getProviderSettings = vi.fn().mockResolvedValue({
      translationEngine: "local_ai",
      geminiModel: "gemini-2.5-flash",
      localAiModel: "qwen2.5:7b-instruct",
      ocrEngine: "gemini"
    });

    window.projectApi = {
      ...((window.projectApi as object) || {}),
      getProviderSettings,
      updateProviderSettings
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const aiTab = screen.getByRole("tab", { name: /AI 번역 엔진/ });
    fireEvent.click(aiTab);

    const translationSelect = await screen.findByRole("combobox", { name: "AI 번역 엔진 선택" });
    expect((translationSelect as HTMLSelectElement).value).toBe("local_ai");

    // Gemini model select should not be visible when local_ai is active
    expect(screen.queryByRole("combobox", { name: "Gemini 모델 선택" })).not.toBeInTheDocument();

    const saveBtn = screen.getByRole("button", { name: "설정 저장" });
    fireEvent.click(saveBtn);

    expect(updateProviderSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        translationEngine: "local_ai",
        geminiModel: "gemini-2.5-flash",
        localAiModel: "qwen2.5:7b-instruct"
      })
    );
  });

  it("shows warning toast when updateProviderSettings rejects", async () => {
    const updateProviderSettings = vi.fn().mockRejectedValue(new Error("Provider 설정 저장 실패: EACCES"));
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      updateProviderSettings
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const saveBtn = screen.getByRole("button", { name: "설정 저장" });
    fireEvent.click(saveBtn);

    expect(await screen.findByText(/⚠️ Provider 설정 저장 실패: EACCES/)).toBeInTheDocument();
    expect(screen.queryByText("✓ 설정이 저장되었습니다.")).not.toBeInTheDocument();
  });

  it("allows selecting Gemini 2.5 Pro when translation engine is Gemini", async () => {
    const updateProviderSettings = vi.fn().mockResolvedValue({});
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      updateProviderSettings
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);

    const aiTab = screen.getByRole("tab", { name: /AI 번역 엔진/ });
    fireEvent.click(aiTab);

    const translationSelect = screen.getByRole("combobox", { name: "AI 번역 엔진 선택" });
    fireEvent.change(translationSelect, { target: { value: "gemini" } });

    const geminiModelSelect = screen.getByRole("combobox", { name: "Gemini 모델 선택" });
    fireEvent.change(geminiModelSelect, { target: { value: "gemini-2.5-pro" } });

    const saveBtn = screen.getByRole("button", { name: "설정 저장" });
    fireEvent.click(saveBtn);

    expect(updateProviderSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        translationEngine: "gemini",
        geminiModel: "gemini-2.5-pro"
      })
    );
  });

  it("does not let a late getProviderSettings response overwrite user edits", async () => {
    const pendingSettings = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const getProviderSettings = vi.fn().mockReturnValue(pendingSettings.promise);
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      getProviderSettings
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    expect(screen.getByText("설정을 불러오는 중입니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "AI 번역 엔진 선택" }), {
      target: { value: "local_ai" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "로컬 서버 주소" }), {
      target: { value: "http://127.0.0.1:9999" }
    });

    await act(async () => {
      pendingSettings.resolve({
        ...DEFAULT_PROVIDER_SETTINGS,
        translationEngine: "gemini",
        localAiEndpoint: "http://localhost:11434"
      });
      await pendingSettings.promise;
    });

    expect(screen.getByRole("combobox", { name: "AI 번역 엔진 선택" })).toHaveValue("local_ai");
    expect(screen.getByRole("textbox", { name: "로컬 서버 주소" })).toHaveValue("http://127.0.0.1:9999");
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled();
  });

  it("shows a load error and does not save defaults when getProviderSettings rejects", async () => {
    const getProviderSettings = vi.fn().mockRejectedValue(new Error("설정 저장소를 읽지 못했습니다."));
    const updateProviderSettings = vi.fn().mockResolvedValue({});
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      getProviderSettings,
      updateProviderSettings
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("설정 저장소를 읽지 못했습니다.");
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    expect(updateProviderSettings).not.toHaveBeenCalled();
  });

  it("restores save after a successful retry", async () => {
    const getProviderSettings = vi.fn()
      .mockRejectedValueOnce(new Error("일시적인 설정 조회 실패"))
      .mockResolvedValueOnce({
        ...DEFAULT_PROVIDER_SETTINGS,
        translationEngine: "local_ai",
        localAiEndpoint: "http://127.0.0.1:1234"
      });
    const updateProviderSettings = vi.fn().mockResolvedValue({});
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      getProviderSettings,
      updateProviderSettings
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("일시적인 설정 조회 실패");

    fireEvent.click(screen.getByRole("button", { name: "설정 다시 불러오기" }));
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "AI 번역 엔진 선택" })).toHaveValue("local_ai");
    });
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        translationEngine: "local_ai",
        localAiEndpoint: "http://127.0.0.1:1234"
      })
    ));
  });

  it("uses providerSettings props as the ready initial state without flashing defaults", async () => {
    const updateProviderSettings = vi.fn().mockResolvedValue({});
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      updateProviderSettings
    } as unknown as typeof window.projectApi;

    render(
      <SettingsPage
        {...dummyProps}
        providerSettings={{
          ...DEFAULT_PROVIDER_SETTINGS,
          translationEngine: "local_ai",
          localAiEndpoint: "http://127.0.0.1:1234",
          startScreen: "projects"
        }}
      />
    );

    expect(screen.queryByText("설정을 불러오는 중입니다.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    expect(screen.getByRole("combobox", { name: "AI 번역 엔진 선택" })).toHaveValue("local_ai");
    expect(screen.getByRole("textbox", { name: "로컬 서버 주소" })).toHaveValue("http://127.0.0.1:1234");

    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        translationEngine: "local_ai",
        localAiEndpoint: "http://127.0.0.1:1234",
        startScreen: "projects"
      })
    ));
  });

  async function saveGeminiKey(status: {
    configured: boolean;
    source: "none" | "environment" | "encrypted" | "session";
    persistence: "encrypted" | "session-only" | "unavailable";
    requiresReentry: boolean;
  }) {
    const setGeminiApiKey = vi.fn().mockResolvedValue(status);
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      setGeminiApiKey
    } as unknown as typeof window.projectApi;
    render(<SettingsPage {...dummyProps} />);
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    fireEvent.change(screen.getByPlaceholderText("API 키를 입력하세요..."), {
      target: { value: "test-gemini-key" }
    });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalled());
  }

  it("shows durable save success when Gemini key persistence is encrypted", async () => {
    await saveGeminiKey({
      configured: true,
      source: "encrypted",
      persistence: "encrypted",
      requiresReentry: false
    });
    expect(screen.getByText(/안전하게 저장되었습니다/)).toBeInTheDocument();
    expect(screen.getByText(/앱을 다시 실행해도 유지됩니다/)).toBeInTheDocument();
  });

  it("warns that a session-only Gemini key must be re-entered after restart", async () => {
    await saveGeminiKey({
      configured: true,
      source: "session",
      persistence: "session-only",
      requiresReentry: false
    });
    expect(screen.getByText(/현재 실행에서만 사용할 수 있습니다/)).toBeInTheDocument();
    expect(screen.queryByText("Gemini API 키가 안전하게 저장되었습니다.")).not.toBeInTheDocument();
  });

  it("does not treat unavailable persistence as durable encrypted storage", async () => {
    await saveGeminiKey({
      configured: true,
      source: "session",
      persistence: "unavailable",
      requiresReentry: false
    });
    expect(screen.getAllByText(/영구 암호화 저장을 사용할 수 없습니다/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/안전하게 저장되었습니다/)).not.toBeInTheDocument();
  });

  it("distinguishes a Gemini key that requires re-entry", async () => {
    const getGeminiApiKeyStatus = vi.fn().mockResolvedValue({
      configured: false,
      source: "none",
      persistence: "unavailable",
      requiresReentry: true
    });
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      getGeminiApiKeyStatus
    } as unknown as typeof window.projectApi;
    render(<SettingsPage {...dummyProps} />);
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    expect(await screen.findByText("○ 재입력 필요")).toBeInTheDocument();
    expect(screen.getByText(/다시 입력해 주세요/)).toBeInTheDocument();
  });

  it("does not treat a rejected Gemini key status lookup as unset", async () => {
    const getGeminiApiKeyStatus = vi.fn().mockRejectedValue(new Error("status lookup failed"));
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      getGeminiApiKeyStatus
    } as unknown as typeof window.projectApi;
    render(<SettingsPage {...dummyProps} />);
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
    expect(await screen.findByText("○ 확인 실패")).toBeInTheDocument();
    expect(screen.queryByText("○ 미설정")).not.toBeInTheDocument();
  });

  function openAiTab() {
    fireEvent.click(screen.getByRole("tab", { name: /AI 번역 엔진/ }));
  }

  function geminiKeyInput() {
    return screen.getByPlaceholderText(/API 키를 입력하세요|새 API 키로 변경/);
  }

  const encryptedStatus = {
    configured: true,
    source: "encrypted" as const,
    persistence: "encrypted" as const,
    requiresReentry: false
  };
  const sessionOnlyStatus = {
    configured: true,
    source: "session" as const,
    persistence: "session-only" as const,
    requiresReentry: false
  };

  it("does not clear a newer Gemini key draft when an older save completes", async () => {
    const pendingSave = deferred<typeof encryptedStatus>();
    const setGeminiApiKey = vi.fn().mockReturnValue(pendingSave.promise);
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      setGeminiApiKey
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    openAiTab();
    fireEvent.change(geminiKeyInput(), { target: { value: "key-a" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalledWith({ apiKey: "key-a" }));

    fireEvent.change(geminiKeyInput(), { target: { value: "key-b" } });
    expect(geminiKeyInput()).toHaveValue("key-b");

    await act(async () => {
      pendingSave.resolve(encryptedStatus);
      await pendingSave.promise;
    });

    expect(geminiKeyInput()).toHaveValue("key-b");
  });

  it("clears the Gemini key input after save when the draft was not changed", async () => {
    const setGeminiApiKey = vi.fn().mockResolvedValue(encryptedStatus);
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      setGeminiApiKey
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    openAiTab();
    fireEvent.change(geminiKeyInput(), { target: { value: "key-a" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalledWith({ apiKey: "key-a" }));
    await waitFor(() => expect(geminiKeyInput()).toHaveValue(""));
  });

  it("does not let an older Gemini key save overwrite a newer key operation's status", async () => {
    const firstSave = deferred<typeof sessionOnlyStatus>();
    const secondSave = deferred<typeof encryptedStatus>();
    let callCount = 0;
    const setGeminiApiKey = vi.fn().mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? firstSave.promise : secondSave.promise;
    });
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      setGeminiApiKey
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    openAiTab();
    fireEvent.change(geminiKeyInput(), { target: { value: "key-a" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalledTimes(1));

    fireEvent.change(geminiKeyInput(), { target: { value: "key-b" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstSave.resolve(sessionOnlyStatus);
      await firstSave.promise;
    });
    expect(screen.queryByText(/현재 실행에서만 사용할 수 있습니다/)).not.toBeInTheDocument();

    await act(async () => {
      secondSave.resolve(encryptedStatus);
      await secondSave.promise;
    });
    expect(screen.getByText(/안전하게 저장되었습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/현재 실행에서만 사용할 수 있습니다/)).not.toBeInTheDocument();
  });

  it("does not show a deleted message when a newer set leaves the key configured", async () => {
    const pendingClear = deferred<typeof encryptedStatus>();
    const pendingSet = deferred<typeof encryptedStatus>();
    const getGeminiApiKeyStatus = vi.fn().mockResolvedValue(encryptedStatus);
    const clearGeminiApiKey = vi.fn().mockReturnValue(pendingClear.promise);
    const setGeminiApiKey = vi.fn().mockReturnValue(pendingSet.promise);
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      getGeminiApiKeyStatus,
      clearGeminiApiKey,
      setGeminiApiKey
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    openAiTab();
    expect(await screen.findByRole("button", { name: "키 삭제" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "키 삭제" }));
    await waitFor(() => expect(clearGeminiApiKey).toHaveBeenCalledOnce());

    fireEvent.change(geminiKeyInput(), { target: { value: "key-b" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalledWith({ apiKey: "key-b" }));

    await act(async () => {
      pendingClear.resolve(encryptedStatus);
      await pendingClear.promise;
    });
    expect(screen.queryByText("저장된 API 키가 삭제되었습니다.")).not.toBeInTheDocument();

    await act(async () => {
      pendingSet.resolve(encryptedStatus);
      await pendingSet.promise;
    });
    expect(screen.getByText(/안전하게 저장되었습니다/)).toBeInTheDocument();
    expect(screen.queryByText("저장된 API 키가 삭제되었습니다.")).not.toBeInTheDocument();
  });

  it("coalesces an immediate duplicate save and Enter submit before applying the key", async () => {
    const firstSave = deferred<typeof sessionOnlyStatus>();
    const secondSave = deferred<typeof encryptedStatus>();
    let callCount = 0;
    const setGeminiApiKey = vi.fn().mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? firstSave.promise : secondSave.promise;
    });
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      setGeminiApiKey
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    openAiTab();
    fireEvent.change(geminiKeyInput(), { target: { value: "key-a" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    fireEvent.keyDown(geminiKeyInput(), { key: "Enter" });
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalledTimes(1));

    await act(async () => {
      firstSave.resolve(sessionOnlyStatus);
      await firstSave.promise;
    });
    expect(screen.getByText(/현재 실행에서만 사용할 수 있습니다/)).toBeInTheDocument();
    expect(setGeminiApiKey).toHaveBeenCalledTimes(1);
    expect(geminiKeyInput()).toHaveValue("");
  });

  it("does not let a failed older Gemini key save overwrite a newer success", async () => {
    const firstSave = deferred<typeof encryptedStatus>();
    const secondSave = deferred<typeof encryptedStatus>();
    let callCount = 0;
    const setGeminiApiKey = vi.fn().mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? firstSave.promise : secondSave.promise;
    });
    window.projectApi = {
      ...((window.projectApi as object) || {}),
      setGeminiApiKey
    } as unknown as typeof window.projectApi;

    render(<SettingsPage {...dummyProps} />);
    openAiTab();
    fireEvent.change(geminiKeyInput(), { target: { value: "key-a" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(setGeminiApiKey).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondSave.resolve(encryptedStatus);
      await secondSave.promise;
    });
    expect(screen.getByText(/안전하게 저장되었습니다/)).toBeInTheDocument();

    await act(async () => {
      firstSave.reject(new Error("이전 저장 실패"));
      try {
        await firstSave.promise;
      } catch {
        // The page must ignore this stale rejection.
      }
    });
    expect(screen.queryByText("이전 저장 실패")).not.toBeInTheDocument();
    expect(screen.getByText(/안전하게 저장되었습니다/)).toBeInTheDocument();
  });
});
