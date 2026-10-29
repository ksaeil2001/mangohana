import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ProjectActionsPanel } from "../../src/renderer/components/ProjectActionsPanel.js";
import { createEmptyProject } from "../../src/shared/projectValidation.js";

describe("ProjectActionsPanel - AI Settings Tab", () => {
  const mockProject = createEmptyProject("Test Project", false);

  const defaultProps = {
    project: mockProject,
    currentFilePath: "C:\\projects\\test.ctp",
    statusMessage: "정상",
    isDirty: false,
    onNewProject: vi.fn(),
    onOpenProject: vi.fn().mockResolvedValue(undefined),
    onSaveProject: vi.fn().mockResolvedValue(undefined),
    onSaveProjectAs: vi.fn().mockResolvedValue(undefined),
    onExportTranslations: vi.fn().mockResolvedValue(undefined),
    onRenameProject: vi.fn(),
    onToggleSecret: vi.fn()
  };

  beforeEach(() => {
    window.projectApi = {
      getGeminiApiKeyStatus: vi.fn().mockResolvedValue({ source: "none" }),
      testLocalAiConnection: vi.fn().mockResolvedValue({
        ok: true,
        message: "Ollama 서버에 성공적으로 연결되었습니다. (15ms)"
      }),
      listLocalAiModels: vi.fn().mockResolvedValue([
        { id: "sakura-13b-q4", name: "sakura-13b-q4", size: "8.0 GB" },
        { id: "qwen2.5:7b", name: "qwen2.5:7b", size: "4.5 GB" }
      ])
    } as any;
  });

  it("keeps labels unique when both connected project settings surfaces are mounted", () => {
    const { container } = render(<><ProjectActionsPanel {...defaultProps} /><ProjectActionsPanel {...defaultProps} /></>);
    const ids = [...container.querySelectorAll("[id]")].map(el => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const input of screen.getAllByRole("textbox", { name: "프로젝트 제목" })) {
      expect((input as HTMLInputElement).labels).toHaveLength(1);
    }
  });

  it("states the unconnected scope separately without disabling the connected title callback", () => {
    render(<ProjectActionsPanel {...defaultProps} />);
    fireEvent.change(screen.getByRole("textbox", { name: "프로젝트 제목" }), { target: { value: "SIM title" } });
    expect(defaultProps.onRenameProject).toHaveBeenCalledWith("SIM title");
    fireEvent.click(screen.getByRole("button", { name: /AI & API/ }));
    expect(screen.getByText(/실제 번역·인페인팅 실행이나 설정 저장에 연결되어 있지 않습니다/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /번역·내보내기/ }));
    expect(screen.getByText(/원문 언어·번역·TXT 내보내기에 적용되거나 저장되지 않습니다/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /화면·캔버스/ }));
    expect(screen.getByText(/실제 캔버스 배율·오버레이에 적용되거나 저장되지 않습니다/)).toBeVisible();
  });

  it("preserves the local draft across tabs and exposes the full selected model without testing the connection", async () => {
    const name = "translation-korean-japanese-extended-context-model-with-a-long-display-name";
    window.projectApi.listLocalAiModels = vi.fn().mockResolvedValue([{ id: "sim-model", name, size: "4 GB" }]);
    render(<ProjectActionsPanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /AI & API/ }));
    fireEvent.click(screen.getByRole("button", { name: /로컬 AI \(On-Device\)/ }));
    fireEvent.change(screen.getByLabelText("로컬 서버 엔드포인트 URL"), { target: { value: "http://localhost:11434/sim-draft" } });
    fireEvent.click(screen.getByRole("button", { name: /모델 목록 새로고침/ }));
    await waitFor(() => expect(screen.getByLabelText("설치된 로컬 모델")).toHaveValue("sim-model"));
    expect(screen.getByLabelText("설치된 로컬 모델")).toHaveAccessibleDescription(`${name} (4 GB)`);
    expect(window.projectApi.testLocalAiConnection).not.toHaveBeenCalled();
    expect(window.projectApi.listLocalAiModels).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /일반/ }));
    fireEvent.click(screen.getByRole("button", { name: /AI & API/ }));
    expect(screen.getByLabelText("로컬 서버 엔드포인트 URL")).toHaveValue("http://localhost:11434/sim-draft");
    expect(screen.getByLabelText("설치된 로컬 모델")).toHaveValue("sim-model");
  });

  it("does not let layout CSS expose inactive settings panels", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("src/renderer/styles.css", "utf8") + readFileSync("src/renderer/design-system.css", "utf8");
    document.head.append(style);
    try {
      const { container } = render(<ProjectActionsPanel {...defaultProps} />);
      await waitFor(() => expect(screen.getByLabelText("프로젝트 제목")).toBeVisible());
      expect([...container.querySelectorAll<HTMLElement>(".settings-tab-panel")].filter((panel) => getComputedStyle(panel).display !== "none")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: /AI & API/ }));
      expect(screen.getByLabelText("프로젝트 제목")).not.toBeVisible();
      expect(screen.queryByRole("combobox", { name: "만화 텍스트 인식 엔진" })).not.toBeInTheDocument();
      expect(screen.getByText(/PP-OCRv6_medium_det.*Baberu OCR/)).toBeVisible();
      expect([...container.querySelectorAll<HTMLElement>(".settings-tab-panel")].filter((panel) => getComputedStyle(panel).display !== "none")).toHaveLength(1);
    } finally {
      style.remove();
    }
  });

  it("does not report cloud connection success without a connection request", async () => {
    render(<ProjectActionsPanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /AI & API/ }));
    fireEvent.click(screen.getByRole("button", { name: "연결 확인 안내" }));
    expect(await screen.findByText(/이 화면에서는 실제 클라우드 연결 요청을 수행하지 않습니다/)).toBeVisible();
    expect(screen.queryByText(/142ms|클라우드 API 연결 성공/)).not.toBeInTheDocument();
    expect(window.projectApi.testLocalAiConnection).not.toHaveBeenCalled();
  });

  it("switches to AI tab, selects Local AI, tests connection, and refreshes model list", async () => {
    render(<ProjectActionsPanel {...defaultProps} />);

    // Click AI tab
    fireEvent.click(screen.getByRole("button", { name: /AI & API/ }));

    // Click Local AI mode
    fireEvent.click(screen.getByRole("button", { name: /로컬 AI \(On-Device\)/ }));

    // Verify endpoint input is visible
    const endpointInput = screen.getByLabelText("로컬 서버 엔드포인트 URL");
    expect(endpointInput).toHaveValue("http://localhost:11434");

    // Click connection test button
    const testButton = screen.getByRole("button", { name: /로컬 서버 연결 확인/ });
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(window.projectApi.testLocalAiConnection).toHaveBeenCalledWith({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });
      expect(screen.getByText(/Ollama 서버에 성공적으로 연결되었습니다/)).toBeInTheDocument();
    });

    // Click refresh models button
    const refreshButton = screen.getByRole("button", { name: /모델 목록 새로고침/ });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(window.projectApi.listLocalAiModels).toHaveBeenCalledWith({
        runtime: "ollama",
        endpoint: "http://localhost:11434"
      });
      expect(screen.getByText(/로컬 모델 2개를 성공적으로 가져왔습니다/)).toBeInTheDocument();
    });

    // Verify populated options in select
    const modelSelect = screen.getByLabelText("설치된 로컬 모델");
    expect(modelSelect).toContainHTML("sakura-13b-q4 (8.0 GB)");
    expect(modelSelect).toContainHTML("qwen2.5:7b (4.5 GB)");
  });

  it("handles connection failure gracefully with error message", async () => {
    window.projectApi.testLocalAiConnection = vi.fn().mockResolvedValue({
      ok: false,
      message: "서버에 연결할 수 없습니다"
    });

    render(<ProjectActionsPanel {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: /AI & API/ }));
    fireEvent.click(screen.getByRole("button", { name: /로컬 AI \(On-Device\)/ }));

    fireEvent.click(screen.getByRole("button", { name: /로컬 서버 연결 확인/ }));

    await waitFor(() => {
      expect(screen.getByText(/연결 실패: 서버에 연결할 수 없습니다/)).toBeInTheDocument();
    });
  });
});
