import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App";
import { DEFAULT_PROVIDER_SETTINGS } from "../../src/shared/providerSettings";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function installApi() {
  const api = {
    getProviderSettings: vi.fn().mockResolvedValue(DEFAULT_PROVIDER_SETTINGS),
    updateProviderSettings: vi.fn().mockImplementation(async (settings) => settings),
    createProjectSession: vi.fn().mockResolvedValue({
      projectSessionId: "theme-test-session",
      project: {
        revision: 0,
        project: normalizeProject(createEmptyProject("테마 테스트", false)),
        pendingPageImages: [],
        dirty: false,
        status: "active"
      },
      encrypted: false
    }),
    importTxtFile: vi.fn(), chooseSaveFile: vi.fn(), exportTranslations: vi.fn(),
    openProject: vi.fn(), saveProject: vi.fn()
  };
  window.projectApi = api as unknown as typeof window.projectApi;
  return api;
}

function openSettings() {
  fireEvent.click(within(screen.getByRole("navigation", { name: "메뉴" })).getByRole("button", { name: "설정" }));
}

describe("App theme preferences", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "projectApi");
    window.localStorage.clear();
    Reflect.deleteProperty(document.documentElement.dataset, "theme");
    vi.restoreAllMocks();
  });

  it.each([
    { theme: "light", marker: null, mainTheme: "dark" },
    { theme: "dark", marker: null, mainTheme: "light" },
    { theme: "light", marker: "previous-workspace", mainTheme: "dark" }
  ] as const)("preserves stored $theme with marker $marker over Main $mainTheme", async ({ theme, marker, mainTheme }) => {
    window.localStorage.setItem("trio:ui-theme", theme);
    if (marker) window.localStorage.setItem("trio:workspace-theme-version", marker);
    const api = installApi();
    api.getProviderSettings.mockResolvedValue({ ...DEFAULT_PROVIDER_SETTINGS, theme: mainTheme });
    render(<App />);
    await waitFor(() => expect(api.createProjectSession).toHaveBeenCalledOnce());
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(window.localStorage.getItem("trio:ui-theme")).toBe(theme);
    expect(api.getProviderSettings).toHaveBeenCalledOnce();
    expect(api.updateProviderSettings).not.toHaveBeenCalled();
  });

  it.each([
    { stored: null, theme: "light" },
    { stored: null, theme: "dark" },
    { stored: "invalid-theme", theme: "light" }
  ] as const)("uses the existing startup Main lookup for $theme when stored theme is $stored", async ({ stored, theme }) => {
    if (stored) window.localStorage.setItem("trio:ui-theme", stored);
    const api = installApi();
    api.getProviderSettings.mockResolvedValue({ ...DEFAULT_PROVIDER_SETTINGS, theme });
    render(<App />);
    await waitFor(() => expect(api.createProjectSession).toHaveBeenCalledOnce());
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(window.localStorage.getItem("trio:ui-theme")).toBe(theme);
    expect(api.getProviderSettings).toHaveBeenCalledOnce();
    expect(api.updateProviderSettings).not.toHaveBeenCalled();
  });

  it("does not persist a provisional default when the startup Main lookup fails", async () => {
    const api = installApi();
    api.getProviderSettings.mockRejectedValue(new Error("설정 조회 테스트 실패"));
    const first = render(<App />);
    await waitFor(() => expect(api.createProjectSession).toHaveBeenCalledOnce());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("trio:ui-theme")).toBeNull();
    first.unmount();

    api.getProviderSettings.mockResolvedValue({ ...DEFAULT_PROVIDER_SETTINGS, theme: "light" });
    render(<App />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(api.updateProviderSettings).not.toHaveBeenCalled();
  });

  it("keeps an explicit Settings choice when a startup lookup resolves later", async () => {
    const pending = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const api = installApi();
    api.getProviderSettings.mockReturnValueOnce(pending.promise);
    render(<App />);
    openSettings();
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "다크" }));

    await act(async () => { pending.resolve({ ...DEFAULT_PROVIDER_SETTINGS, theme: "light" }); });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("trio:ui-theme")).toBe("dark");
    expect(api.updateProviderSettings).not.toHaveBeenCalled();
  });

  it("keeps startup hydration clean when Main resolves while Settings is open", async () => {
    const pendingStartup = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const pendingSettings = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const api = installApi();
    api.getProviderSettings.mockReturnValueOnce(pendingStartup.promise).mockReturnValueOnce(pendingSettings.promise);
    render(<App />);
    openSettings();
    await act(async () => { pendingSettings.resolve(DEFAULT_PROVIDER_SETTINGS); });
    await act(async () => { pendingStartup.resolve(DEFAULT_PROVIDER_SETTINGS); });

    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(screen.queryByRole("dialog", { name: "저장하지 않은 설정" })).not.toBeInTheDocument();
    expect(api.updateProviderSettings).not.toHaveBeenCalled();
  });

  it("keeps the explicitly submitted theme when the startup lookup resolves after saving", async () => {
    const pending = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const api = installApi();
    api.getProviderSettings.mockReturnValueOnce(pending.promise);
    render(<App />);
    openSettings();
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "다크" }));
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await screen.findByText(/설정이 저장되었습니다/);
    expect(api.updateProviderSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ theme: "dark" }));

    await act(async () => { pending.resolve(DEFAULT_PROVIDER_SETTINGS); });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("trio:ui-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(screen.queryByRole("dialog", { name: "저장하지 않은 설정" })).not.toBeInTheDocument();
  });

  it("uses confirmed Main theme when startup failed and the user saves other settings", async () => {
    const api = installApi();
    api.getProviderSettings
      .mockRejectedValueOnce(new Error("시작 설정 조회 실패"))
      .mockResolvedValueOnce({ ...DEFAULT_PROVIDER_SETTINGS, theme: "light" });
    render(<App />);
    await waitFor(() => expect(api.createProjectSession).toHaveBeenCalledOnce());
    expect(window.localStorage.getItem("trio:ui-theme")).toBeNull();
    openSettings();
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "projects" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await screen.findByText(/설정이 저장되었습니다/);
    expect(api.updateProviderSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ startScreen: "projects" }));
    expect(api.updateProviderSettings.mock.calls[0]?.[0]).not.toHaveProperty("theme");
  });

  it("does not replace an existing system theme when saving another setting", async () => {
    const api = installApi();
    api.getProviderSettings.mockResolvedValue({ ...DEFAULT_PROVIDER_SETTINGS, theme: "system" });
    render(<App />);
    await waitFor(() => expect(api.createProjectSession).toHaveBeenCalledOnce());
    openSettings();
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 저장" })).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "시작 화면" }), { target: { value: "projects" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await screen.findByText(/설정이 저장되었습니다/);
    expect(api.updateProviderSettings.mock.calls[0]?.[0]).not.toHaveProperty("theme");
    expect(window.localStorage.getItem("trio:ui-theme")).toBeNull();
  });

  it("ignores a late Settings lookup after leaving while the startup theme is unresolved", async () => {
    const pendingStartup = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const pendingSettings = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const api = installApi();
    api.getProviderSettings.mockReturnValueOnce(pendingStartup.promise).mockReturnValueOnce(pendingSettings.promise);
    render(<App />);
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(screen.queryByRole("dialog", { name: "저장하지 않은 설정" })).not.toBeInTheDocument();
    await act(async () => { pendingSettings.resolve({ ...DEFAULT_PROVIDER_SETTINGS, theme: "light" }); });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("trio:ui-theme")).toBeNull();
    await act(async () => { pendingStartup.resolve({ ...DEFAULT_PROVIDER_SETTINGS, theme: "light" }); });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("ignores a Settings theme lookup that finishes after leaving the page", async () => {
    window.localStorage.setItem("trio:ui-theme", "dark");
    const pending = deferred<typeof DEFAULT_PROVIDER_SETTINGS>();
    const api = installApi();
    api.getProviderSettings.mockResolvedValueOnce(DEFAULT_PROVIDER_SETTINGS).mockReturnValueOnce(pending.promise);
    render(<App />);
    await waitFor(() => expect(api.createProjectSession).toHaveBeenCalledOnce());
    openSettings();
    expect(screen.getByRole("button", { name: "설정 저장" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "홈" }));
    expect(screen.queryByRole("dialog", { name: "저장하지 않은 설정" })).not.toBeInTheDocument();

    await act(async () => { pending.resolve(DEFAULT_PROVIDER_SETTINGS); });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("trio:ui-theme")).toBe("dark");
    expect(api.updateProviderSettings).not.toHaveBeenCalled();
  });
});
