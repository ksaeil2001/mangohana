import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "../../src/renderer/components/ProjectsPage";

describe("ProjectsPage", () => {
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

  it("renders empty state when no recent projects exist", () => {
    render(<ProjectsPage {...dummyProps} />);

    expect(screen.getByRole("heading", { name: "프로젝트 관리" })).toBeInTheDocument();
    expect(screen.getByText("최근 작업한 프로젝트가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("월하의 기사 23화")).not.toBeInTheDocument();
  });

  it("renders actual recent projects and opens selected project", () => {
    const onOpenRecent = vi.fn();
    const props = {
      ...dummyProps,
      onOpenRecent,
      recentProjects: [
        {
          recentProjectId: "recent-1",
          title: "내 만화 프로젝트 1화",
          openedAt: "2026-08-20T10:00:00.000Z"
        },
        {
          recentProjectId: "recent-2",
          title: "다른 만화 프로젝트 2화",
          openedAt: "2026-08-21T10:00:00.000Z"
        }
      ]
    };

    render(<ProjectsPage {...props} />);

    expect(screen.getByRole("table", { name: "최근 프로젝트" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다른 만화 프로젝트 2화" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "내 만화 프로젝트 1화" }));
    expect(onOpenRecent).toHaveBeenCalledWith("recent-1");
  });

  it("toggles between grid and list views", () => {
    const props = {
      ...dummyProps,
      recentProjects: [
        {
          recentProjectId: "recent-1",
          title: "내 만화 프로젝트 1화",
          openedAt: "2026-08-20T10:00:00.000Z"
        }
      ]
    };

    render(<ProjectsPage {...props} />);

    expect(screen.getByRole("button", { name: "리스트 뷰" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "그리드 뷰" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "내 만화 프로젝트 1화" })).toBeInTheDocument();
    const listBtn = screen.getByRole("button", { name: "리스트 뷰" });
    fireEvent.click(listBtn);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("프로젝트명")).toBeInTheDocument();
  });

  it("keeps full identity, opened-time meaning and open action consistent across modes", () => {
    const title = "아주 긴 프로젝트 이름 — 雨上がりの約束 第十二巻 검토";
    const onOpenRecent = vi.fn();
    render(<ProjectsPage {...dummyProps} onOpenRecent={onOpenRecent} recentProjects={[
      { recentProjectId: "long", title, openedAt: "2026-09-25T00:00:00Z" }
    ]} />);
    expect(screen.getByRole("columnheader", { name: "마지막 열기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "리스트 뷰" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: `${title} 프로젝트 열기` }));
    fireEvent.click(screen.getByRole("button", { name: "그리드 뷰" }));
    expect(screen.getByText(/마지막 열기:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "그리드 뷰" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: `${title} 프로젝트 열기` }));
    expect(onOpenRecent.mock.calls).toEqual([["long"], ["long"]]);
    expect(screen.queryByRole("button", { name: /삭제/ })).not.toBeInTheDocument();
  });
});
