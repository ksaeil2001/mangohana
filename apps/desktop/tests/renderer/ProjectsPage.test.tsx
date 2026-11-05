import { fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(screen.getAllByRole("button", { name: "새 프로젝트 만들기" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "기존 프로젝트 파일 열기" })).toHaveLength(1);
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

  it("filters and sorts project rows by title", () => {
    const props = {
      ...dummyProps,
      recentProjects: [
        {
          recentProjectId: "recent-1",
          title: "B 프로젝트",
          openedAt: "2026-08-20T10:00:00.000Z"
        },
        {
          recentProjectId: "recent-2",
          title: "A 프로젝트",
          openedAt: "2026-08-19T10:00:00.000Z"
        }
      ]
    };

    render(<ProjectsPage {...props} />);

    const table = screen.getByRole("table", { name: "최근 프로젝트" });
    expect(within(table).getAllByRole("button").map((button) => button.textContent)).toEqual(["B 프로젝트", "A 프로젝트"]);
    fireEvent.change(screen.getByRole("combobox", { name: "정렬 기준" }), { target: { value: "name" } });
    expect(within(table).getAllByRole("button").map((button) => button.textContent)).toEqual(["A 프로젝트", "B 프로젝트"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "프로젝트 검색" }), { target: { value: "b 프로젝트" } });
    expect(within(table).getAllByRole("button").map((button) => button.textContent)).toEqual(["B 프로젝트"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "프로젝트 검색" }), { target: { value: "없는 제목" } });
    expect(screen.getByText("검색 조건에 맞는 프로젝트가 없습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "검색 초기화" }));
    expect(screen.getByRole("button", { name: "A 프로젝트" })).toBeInTheDocument();
  });

  it("keeps full identity, opened time, and a single open action", () => {
    const title = "아주 긴 프로젝트 이름 — 雨上がりの約束 第十二巻 검토";
    const onOpenRecent = vi.fn();
    render(<ProjectsPage {...dummyProps} onOpenRecent={onOpenRecent} recentProjects={[
      { recentProjectId: "long", title, openedAt: "2026-09-25T00:00:00Z" }
    ]} />);
    expect(screen.getByRole("columnheader", { name: "마지막 열기" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "최근 프로젝트" });
    expect(within(table).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(table).getByRole("button", { name: title }));
    expect(onOpenRecent.mock.calls).toEqual([["long"]]);
    expect(screen.queryByRole("button", { name: /최근 목록에서 제거/ })).not.toBeInTheDocument();
  });

  it("explains unavailable files and removes only their recent entry", () => {
    const onOpenRecent = vi.fn();
    const onRemoveRecent = vi.fn();
    render(<ProjectsPage {...dummyProps} onOpenRecent={onOpenRecent} onRemoveRecent={onRemoveRecent}
      statusMessage="최근 프로젝트를 열 수 없습니다." unavailableRecentPath="missing"
      recentProjects={[
        { recentProjectId: "missing", title: "이동한 프로젝트", openedAt: "" },
        { recentProjectId: "available", title: "다른 프로젝트", openedAt: "2026-08-21T10:00:00.000Z" }
      ]}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("최근 프로젝트를 열 수 없습니다.");
    const missing = screen.getByRole("button", { name: "이동한 프로젝트" });
    expect(missing).toBeDisabled();
    expect(missing).toHaveAccessibleDescription("파일을 찾을 수 없음");
    fireEvent.click(missing);
    fireEvent.click(screen.getByRole("button", { name: "이동한 프로젝트 최근 목록에서 제거" }));
    expect(onRemoveRecent.mock.calls).toEqual([["missing"]]);
    fireEvent.click(screen.getByRole("button", { name: "다른 프로젝트" }));
    expect(onOpenRecent.mock.calls).toEqual([["available"]]);
  });
});
