import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolsPage } from "../../src/renderer/components/ToolsPage";

describe("ToolsPage", () => {
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

  it("renders editing utilities tools cards with truthful readiness", () => {
    render(<ToolsPage {...dummyProps} />);

    expect(screen.getByRole("heading", { name: "편집 도구" })).toBeInTheDocument();
    expect(screen.getByText("이미지 이어붙이기 (웹툰 스크롤)")).toBeInTheDocument();
    expect(screen.getByText("프로젝트 대사 TXT 내보내기")).toBeInTheDocument();
    expect(screen.getAllByText("준비 중").length).toBeGreaterThan(0);
  });

  it("opens the project selection dialog and opens the selected recent project", () => {
    const recentProjects = [
      {
        recentProjectId: "rec-123",
        title: "내 만화 프로젝트",
        openedAt: "2026-05-29T00:00:00.000Z"
      }
    ];

    render(<ToolsPage {...dummyProps} recentProjects={recentProjects} />);

    const exportBtn = screen.getByRole("button", { name: "프로젝트 작업대 열기" });
    fireEvent.click(exportBtn);

    expect(screen.getByText("작업 대상 선택")).toBeInTheDocument();

    const selectEl = screen.getByRole("combobox", { name: "작업 대상 선택" });
    fireEvent.change(selectEl, { target: { value: "rec-123" } });

    const dialog = screen.getByRole("dialog", { name: "프로젝트 대사 TXT 내보내기" });
    expect(within(dialog).queryByRole("button", { name: "실행" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: "전체 프로젝트 파일" })).not.toBeInTheDocument();
    const executeBtn = within(dialog).getByRole("button", { name: "프로젝트 열기" });
    fireEvent.click(executeBtn);

    expect(dummyProps.onOpenRecent).toHaveBeenCalledWith("rec-123");
  });

  it("returns focus on cancel and Escape without opening a project", () => {
    const onOpenProject = vi.fn();
    render(<ToolsPage {...dummyProps} onOpenProject={onOpenProject} />);
    const trigger = screen.getByRole("button", { name: "프로젝트 파일 열기" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "프로젝트 보관 (.ctp)" })).toHaveClass("stitch-dialog");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("opens a file picker for the explicit direct-file option", () => {
    const onOpenProject = vi.fn();
    const onOpenRecent = vi.fn();
    render(<ToolsPage {...dummyProps} onOpenProject={onOpenProject} onOpenRecent={onOpenRecent} />);
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 작업대 열기" }));
    expect(screen.getByRole("combobox", { name: "작업 대상 선택" })).toHaveValue("all");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "프로젝트 열기" }));
    expect(onOpenProject).toHaveBeenCalledOnce();
    expect(onOpenRecent).not.toHaveBeenCalled();
  });
});
