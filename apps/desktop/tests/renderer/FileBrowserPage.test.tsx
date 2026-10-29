import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileBrowserPage } from "../../src/renderer/components/FileBrowserPage";

describe("FileBrowserPage", () => {
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

  it("renders a recent-title filter and empty placeholder without a fake folder tree", () => {
    render(<FileBrowserPage {...dummyProps} />);

    expect(screen.getByRole("heading", { name: "프로젝트 파일 탐색기" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "최근 제목 필터" })).toBeInTheDocument();
    expect(screen.queryByText("프로젝트 폴더")).not.toBeInTheDocument();
    expect(screen.getByText("최근 프로젝트 파일이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("월하의 기사 23화_ch01.png")).not.toBeInTheDocument();
  });

  it("opens matching recent project on button click when recent project exists", () => {
    const recentProjects = [
      {
        recentProjectId: "rec-moonlight",
        title: "내 만화 프로젝트",
        openedAt: "2026-05-29T00:00:00.000Z"
      }
    ];

    render(<FileBrowserPage {...dummyProps} recentProjects={recentProjects} />);

    expect(screen.getAllByText("내 만화 프로젝트.ctp")[0]).toBeInTheDocument();
    const openBtn = screen.getByRole("button", { name: "프로젝트에서 열기" });
    fireEvent.click(openBtn);

    expect(dummyProps.onOpenRecent).toHaveBeenCalledWith("rec-moonlight");
  });

  it("opens project on Enter key press on file card", () => {
    const recentProjects = [
      {
        recentProjectId: "rec-moonlight",
        title: "내 만화 프로젝트",
        openedAt: "2026-05-29T00:00:00.000Z"
      }
    ];

    render(<FileBrowserPage {...dummyProps} recentProjects={recentProjects} />);

    const fileCard = screen.getAllByText("내 만화 프로젝트.ctp")[0]?.closest(".trio-fb-file-card");
    expect(fileCard).toBeInTheDocument();
    if (fileCard) {
      fireEvent.keyDown(fileCard, { key: "Enter" });
      expect(dummyProps.onOpenRecent).toHaveBeenCalledWith("rec-moonlight");
    }
  });

  it("exposes the inspected file as selected after filtering and preserves Space/Enter actions", () => {
    const onOpenRecent = vi.fn();
    render(<FileBrowserPage {...dummyProps} onOpenRecent={onOpenRecent} recentProjects={[
      { recentProjectId: "one", title: "첫 프로젝트", openedAt: "2026-09-25T00:00:00Z" },
      { recentProjectId: "two", title: "긴 두 번째 프로젝트", openedAt: "2026-09-24T00:00:00Z" }
    ]} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "파일명 검색" }), { target: { value: "두 번째" } });
    const file = screen.getByRole("button", { name: /^파일: 긴 두 번째/ });
    expect(file).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("파일 형식", { selector: ".trio-fb-detail-fields span" })).toBeInTheDocument();
    expect(screen.getByText("마지막 열기")).toBeInTheDocument();
    fireEvent.keyDown(file, { key: " " });
    expect(onOpenRecent).not.toHaveBeenCalled();
    fireEvent.keyDown(file, { key: "Enter" });
    expect(onOpenRecent).toHaveBeenCalledExactlyOnceWith("two");
    fireEvent.change(screen.getByRole("searchbox", { name: "파일명 검색" }), { target: { value: "없는 파일" } });
    expect(screen.getByText("조건에 맞는 파일이 없습니다.")).toBeInTheDocument();
  });

  it("uses recent identities to distinguish projects with the same title", () => {
    const onOpenRecent = vi.fn();
    render(<FileBrowserPage {...dummyProps} onOpenRecent={onOpenRecent} recentProjects={[
      { recentProjectId: "same-title-1", title: "같은 제목", openedAt: "2026-10-18T00:00:00Z" },
      { recentProjectId: "same-title-2", title: "같은 제목", openedAt: "2026-10-19T00:00:00Z" }
    ]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "최근 제목 필터" }), { target: { value: "same-title-2" } });
    expect(screen.getAllByRole("button", { name: /^파일:/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "프로젝트에서 열기" }));
    expect(onOpenRecent).toHaveBeenCalledExactlyOnceWith("same-title-2");
  });
});
