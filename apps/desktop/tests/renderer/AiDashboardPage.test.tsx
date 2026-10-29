import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiDashboardPage } from "../../src/renderer/components/AiDashboardPage";
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from "../../src/shared/providerSettings";

describe("AiDashboardPage", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "projectApi");
  });

  const dummyProps = {
    recentProjects: [],
    apiReady: true,
    onNewProject: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenPreparation: vi.fn(),
    onNavigate: vi.fn()
  };

  it("renders AI dashboard metrics, launcher card, and history section", () => {
    render(<AiDashboardPage {...dummyProps} />);

    expect(screen.getByRole("heading", { name: "AI 번역 대시보드" })).toBeInTheDocument();
    expect(screen.getByText("등록된 프로젝트")).toBeInTheDocument();
    expect(screen.getByText("클라우드 Gemini API")).toBeInTheDocument();
    expect(screen.getByText("로컬 AI 엔진")).toBeInTheDocument();
    expect(screen.getByText("프로젝트 열기 & 작업대 이동")).toBeInTheDocument();
  });

  it("transitions to workspace for selected recent project", () => {
    const recentProjects = [
      {
        recentProjectId: "rec-dash",
        title: "내 만화 프로젝트",
        openedAt: "2026-05-29T00:00:00.000Z"
      }
    ];

    render(<AiDashboardPage {...dummyProps} recentProjects={recentProjects} />);

    const selectEl = screen.getByRole("combobox", { name: "대상 프로젝트" });
    fireEvent.change(selectEl, { target: { value: "rec-dash" } });

    const launchBtn = screen.getByRole("button", { name: "선택 프로젝트 작업대로 이동" });
    fireEvent.click(launchBtn);

    expect(dummyProps.onOpenRecent).toHaveBeenCalledWith("rec-dash");
  });

  it("renders accessible table action button and truthful API key label", async () => {
    (window as any).projectApi = {
      getGeminiApiKeyStatus: vi.fn().mockResolvedValue({ configured: true })
    };

    const recentProjects = [
      {
        recentProjectId: "rec-acc",
        title: "접근성 테스트 프로젝트",
        openedAt: "2026-05-29T00:00:00.000Z"
      }
    ];

    render(<AiDashboardPage {...dummyProps} recentProjects={recentProjects} />);

    expect(await screen.findByText("API 키 설정됨")).toHaveAttribute("data-status-tone", "neutral");
    expect(screen.getByText("키 설정 확인 · 연결 및 기능 실행은 미검증")).toBeVisible();

    const openBtn = screen.getByRole("button", { name: "접근성 테스트 프로젝트 프로젝트 열기" });
    expect(openBtn).toBeInTheDocument();
    fireEvent.click(openBtn);
    expect(dummyProps.onOpenRecent).toHaveBeenCalledWith("rec-acc");

    // Verify row itself is not an invalid button
    expect(screen.queryByRole("button", { name: /^접근성 테스트 프로젝트$/ })).not.toBeInTheDocument();
  });

  it("syncs the launcher selection with asynchronously loaded recent projects", async () => {
    const onOpenRecent = vi.fn();
    const onOpenProject = vi.fn();
    const projectA = {
      recentProjectId: "rec-a",
      title: "프로젝트 A",
      openedAt: "2026-05-29T00:00:00.000Z"
    };
    const projectB = {
      recentProjectId: "rec-b",
      title: "프로젝트 B",
      openedAt: "2026-05-30T00:00:00.000Z"
    };
    const { rerender } = render(
      <AiDashboardPage
        {...dummyProps}
        onOpenRecent={onOpenRecent}
        onOpenProject={onOpenProject}
        recentProjects={[]}
      />
    );

    expect(screen.getByRole("combobox", { name: "대상 프로젝트" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "기존 프로젝트 파일 열기" })).toBeInTheDocument();

    rerender(
      <AiDashboardPage
        {...dummyProps}
        onOpenRecent={onOpenRecent}
        onOpenProject={onOpenProject}
        recentProjects={[projectA, projectB]}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "대상 프로젝트" })).toHaveValue("rec-a");
    });
    fireEvent.click(screen.getByRole("button", { name: "선택 프로젝트 작업대로 이동" }));
    expect(onOpenRecent).toHaveBeenCalledWith("rec-a");
    expect(onOpenProject).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: "대상 프로젝트" }), {
      target: { value: "rec-b" }
    });
    rerender(
      <AiDashboardPage
        {...dummyProps}
        onOpenRecent={onOpenRecent}
        onOpenProject={onOpenProject}
        recentProjects={[projectB, projectA]}
      />
    );
    expect(screen.getByRole("combobox", { name: "대상 프로젝트" })).toHaveValue("rec-b");

    rerender(
      <AiDashboardPage
        {...dummyProps}
        onOpenRecent={onOpenRecent}
        onOpenProject={onOpenProject}
        recentProjects={[projectA]}
      />
    );
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "대상 프로젝트" })).toHaveValue("rec-a");
    });

    rerender(
      <AiDashboardPage
        {...dummyProps}
        onOpenRecent={onOpenRecent}
        onOpenProject={onOpenProject}
        recentProjects={[]}
      />
    );
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "대상 프로젝트" })).toHaveValue("");
    });
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 파일 열기" }));
    expect(onOpenProject).toHaveBeenCalledOnce();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("does not treat a pending Gemini key lookup as unset", () => {
    const pending = deferred<{ configured: boolean }>();
    (window as unknown as { projectApi: object }).projectApi = {
      getGeminiApiKeyStatus: vi.fn().mockReturnValue(pending.promise)
    };
    render(<AiDashboardPage {...dummyProps} />);
    expect(screen.getByText("확인 중")).toBeInTheDocument();
    expect(screen.queryByText("키 미설정")).not.toBeInTheDocument();
    expect(screen.queryByText("API 키 설정됨")).not.toBeInTheDocument();
  });

  it("shows a lookup failure when Gemini key status rejects", async () => {
    (window as unknown as { projectApi: object }).projectApi = {
      getGeminiApiKeyStatus: vi.fn().mockRejectedValue(new Error("키 저장소를 읽지 못했습니다."))
    };
    render(<AiDashboardPage {...dummyProps} />);
    expect(await screen.findByText("확인 실패")).toBeInTheDocument();
    expect(screen.getByText("키 저장소를 읽지 못했습니다.")).toBeInTheDocument();
    expect(screen.queryByText("키 미설정")).not.toBeInTheDocument();
  });

  it("does not display default Local AI endpoint or model while provider settings are pending", () => {
    const pending = deferred<ProviderSettings>();
    (window as unknown as { projectApi: object }).projectApi = {
      getProviderSettings: vi.fn().mockReturnValue(pending.promise)
    };
    render(<AiDashboardPage {...dummyProps} />);
    expect(screen.getAllByText("확인 중").length).toBeGreaterThan(0);
    expect(screen.queryByText("http://localhost:11434")).not.toBeInTheDocument();
    expect(screen.queryByText("qwen2.5:7b-instruct")).not.toBeInTheDocument();
    expect(screen.queryByText("Gemini 클라우드")).not.toBeInTheDocument();
  });

  it("shows a lookup failure when provider settings reject", async () => {
    (window as unknown as { projectApi: object }).projectApi = {
      getProviderSettings: vi.fn().mockRejectedValue(new Error("설정 파일을 열지 못했습니다."))
    };
    render(<AiDashboardPage {...dummyProps} />);
    expect(await screen.findAllByText("확인 실패")).not.toHaveLength(0);
    expect(screen.getAllByText("설정 파일을 열지 못했습니다.").length).toBeGreaterThan(0);
    expect(screen.queryByText("http://localhost:11434")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Provider 설정 다시 확인" }).length).toBeGreaterThan(0);
  });

  it.each([
    ["ollama", "로컬 AI (Ollama)"],
    ["lmstudio", "로컬 AI (LM Studio)"],
    ["vllm", "로컬 AI (vLLM)"],
    ["custom", "로컬 AI (사용자 지정)"]
  ] as const)("labels a local_ai %s runtime without calling it Ollama by default", async (runtime, label) => {
    (window as unknown as { projectApi: object }).projectApi = {
      getGeminiApiKeyStatus: vi.fn().mockResolvedValue({ configured: true }),
      getProviderSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_PROVIDER_SETTINGS,
        translationEngine: "local_ai",
        localAiRuntime: runtime,
        localAiEndpoint: "http://127.0.0.1:1234",
        localAiModel: "custom-model"
      })
    };
    render(<AiDashboardPage {...dummyProps} />);
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText("custom-model")).toBeInTheDocument();
    expect(screen.getByText("http://127.0.0.1:1234")).toBeInTheDocument();
    if (runtime !== "ollama") {
      expect(screen.queryByText("로컬 AI (Ollama)")).not.toBeInTheDocument();
    }
  });

  it("retries provider settings after a load failure and then shows the stored engine", async () => {
    const getProviderSettings = vi.fn()
      .mockRejectedValueOnce(new Error("일시적 오류"))
      .mockResolvedValueOnce({
        ...DEFAULT_PROVIDER_SETTINGS,
        translationEngine: "gemini",
        geminiModel: "gemini-2.5-flash"
      });
    (window as unknown as { projectApi: object }).projectApi = {
      getGeminiApiKeyStatus: vi.fn().mockResolvedValue({ configured: true }),
      getProviderSettings
    };
    render(<AiDashboardPage {...dummyProps} />);
    expect(await screen.findAllByText("확인 실패")).not.toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Provider 설정 다시 확인" })[0]!);
    expect(await screen.findByText("Gemini 클라우드")).toBeInTheDocument();
    expect(screen.getByText("API 키 설정됨")).toBeInTheDocument();
  });
});
