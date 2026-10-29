import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectHomeScreen, type ProjectHomeScreenProps } from "../../src/renderer/components/ProjectHomeScreen";

function setup(overrides: Partial<ProjectHomeScreenProps> = {}) {
  const props: ProjectHomeScreenProps = {
    recentProjects: [],
    apiReady: true,
    projectSessionReady: true,
    sessionRetryAvailable: false,
    isImportingTxt: false,
    onNewProject: vi.fn(),
    onRetryProjectSession: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
    onImportTxt: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenPreparation: vi.fn(),
    ...overrides
  };
  render(<ProjectHomeScreen {...props} />);
  return props;
}

describe("ProjectHomeScreen", () => {
  it("gives a new user one primary project action and keeps TXT under another-method disclosure", () => {
    const props = setup();

    expect(screen.getByRole("heading", { name: "번역 프로젝트" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "이미지로 프로젝트 시작" })).toBeVisible();
    const newButton = screen.getByRole("button", { name: "새 번역 프로젝트" });
    expect(newButton).toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).toBeVisible();
    expect(screen.getByRole("region", { name: "현재 준비 상태" })).toBeVisible();
    fireEvent.click(within(screen.getByRole("region", { name: "현재 준비 상태" })).getByRole("button", { name: "환경 준비" }));
    const disclosure = screen.getByText("다른 시작 방법").closest("details");
    const txtButton = screen.getByRole("button", { name: "TXT로 시작" });
    expect(disclosure).not.toHaveAttribute("open");
    expect(txtButton).not.toBeVisible();
    expect(props.onImportTxt).not.toHaveBeenCalled();

    fireEvent.click(newButton);
    fireEvent.click(screen.getByRole("button", { name: "기존 프로젝트 열기" }));
    fireEvent.click(screen.getByText("다른 시작 방법"));
    expect(disclosure).toHaveAttribute("open");
    expect(txtButton).toBeVisible();
    fireEvent.click(txtButton);
    fireEvent.click(within(screen.getByRole("region", { name: "현재 준비 상태" })).getByRole("button", { name: "설정" }));

    expect(props.onNewProject).toHaveBeenCalledOnce();
    expect(props.onOpenProject).toHaveBeenCalledOnce();
    expect(props.onImportTxt).toHaveBeenCalledOnce();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    expect(props.onOpenPreparation).toHaveBeenCalledOnce();
  });

  it("offers the most recent project as a resume action without rendering local paths", () => {
    const props = setup({
      recentProjects: [
        {
          recentProjectId: "recent-book",
          title: "Book",
          openedAt: "2026-07-17T00:00:00.000Z"
        }
      ]
    });

    fireEvent.click(screen.getByRole("button", { name: "최근 프로젝트 Book 이어하기" }));

    expect(props.onOpenRecent).toHaveBeenCalledWith("recent-book");
    expect(screen.getByRole("heading", { name: "번역 프로젝트" })).toBeVisible();
    expect(screen.queryByText("C:\\private\\Book.ctp")).not.toBeInTheDocument();
  });

  it("shows a recoverable inline error and offers removal for an unavailable recent project", () => {
    const props = setup({
      recentProjects: [
        {
          recentProjectId: "recent-missing",
          title: "Missing Book",
          openedAt: "2026-07-17T00:00:00.000Z"
        }
      ],
      unavailableRecentPath: "recent-missing",
      statusMessage: "최근 프로젝트를 열 수 없습니다. 파일이 이동되었거나 삭제되었을 수 있습니다."
    });

    expect(screen.getByRole("alert")).toHaveTextContent("최근 프로젝트를 열 수 없습니다");
    expect(screen.getByRole("alert")).toHaveClass("project-home-status");
    fireEvent.click(screen.getByRole("button", { name: "Missing Book 최근 목록에서 제거" }));
    expect(props.onRemoveRecent).toHaveBeenCalledWith("recent-missing");
  });
  it("renders the two-column start surface with truthful state and real entry actions", () => {
    const props = setup();
    expect(screen.getByRole("banner", { name: "앱 헤더" })).toBeVisible();
    expect(screen.getByRole("button", { name: "망고하나 홈으로 이동" })).toBeVisible();
    expect(screen.getByRole("button", { name: "프로젝트 목록으로 이동" })).toBeVisible();
    expect(screen.queryByPlaceholderText("프로젝트, 파일, 태그 검색...")).not.toBeInTheDocument();
    expect(screen.queryByText("seil_kim")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "메인 사이드바" })).toBeVisible();
    expect(screen.queryByText("로컬 저장소")).not.toBeInTheDocument();
    expect(screen.queryByText("Trio Pro로 업그레이드")).not.toBeInTheDocument();
    expect(screen.getByText("만화 번역 작업실")).toBeVisible();
    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toBeVisible();
    expect(screen.queryByText("자연스러운 번역과 말풍선 감지")).not.toBeInTheDocument();
    expect(screen.queryByText("Trio 업데이트")).not.toBeInTheDocument();
    expect(screen.queryByText("v1.6.0 · 2024.05.20")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "작업 현황" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "최근 파일" })).not.toBeInTheDocument();
    const readiness = screen.getByRole("region", { name: "현재 준비 상태" });
    expect(within(readiness).getByText("프로젝트 시작 가능")).toBeVisible();
    fireEvent.click(within(readiness).getByRole("button", { name: "환경 준비" }));
    fireEvent.click(within(readiness).getByRole("button", { name: "설정" }));
    expect(props.onOpenPreparation).toHaveBeenCalledOnce();
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    fireEvent.click(within(readiness).getByRole("button", { name: "사용 안내" }));
    expect(screen.getByRole("dialog", { name: "망고하나 사용 시작하기" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves session readiness, import progress and retry actions", () => {
    const props = setup({ projectSessionReady: false, sessionRetryAvailable: true, statusMessage: "세션을 준비하지 못했습니다." });
    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "TXT로 시작" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("세션을 준비하지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "프로젝트 세션 다시 시도" }));
    expect(props.onRetryProjectSession).toHaveBeenCalledOnce();
  });

  it("keeps the original loading label while importing TXT", () => {
    setup({ isImportingTxt: true });
    fireEvent.click(screen.getByText("다른 시작 방법"));
    expect(screen.getByRole("button", { name: "TXT 불러오는 중" })).toBeDisabled();
  });

  it("explains disabled entry actions and prevents the header switcher from bypassing file readiness", () => {
    const props = setup({
      apiReady: false,
      projectSessionReady: false,
      recentProjects: [{ recentProjectId: "book", title: "Book", openedAt: "2026-10-19T00:00:00Z" }]
    });
    const switcher = screen.getByRole("combobox", { name: "최근 프로젝트 전환" });
    expect(switcher).toBeDisabled();
    expect(switcher).toHaveAccessibleDescription("앱 파일 기능을 준비하고 있습니다.");
    expect(screen.getByRole("button", { name: "기존 프로젝트 열기" })).toHaveAccessibleDescription("앱 파일 기능을 준비하고 있습니다.");
    expect(screen.getByRole("button", { name: "새 번역 프로젝트" })).toHaveAccessibleDescription("프로젝트 세션이 준비되면 새 작업을 시작할 수 있습니다.");

    fireEvent.change(switcher, { target: { value: "book" } });
    fireEvent.drop(screen.getByRole("heading", { name: "번역 프로젝트" }), { dataTransfer: { files: [new File(["fixture"], "book.ctp")] } });
    expect(props.onOpenRecent).not.toHaveBeenCalled();
    expect(props.onOpenProject).not.toHaveBeenCalled();
  });

  it("keeps an unavailable recent project disabled in the header while another project can open", () => {
    const props = setup({ recentProjects: [
      { recentProjectId: "missing", title: "Missing", openedAt: "2026-10-19T00:00:00Z" },
      { recentProjectId: "available", title: "Available", openedAt: "2026-10-18T00:00:00Z" }
    ], unavailableRecentPath: "missing" });
    expect(screen.getByRole("option", { name: "Missing" })).toBeDisabled();
    const switcher = screen.getByRole("combobox", { name: "최근 프로젝트 전환" });
    fireEvent.change(switcher, { target: { value: "missing" } });
    expect(props.onOpenRecent).not.toHaveBeenCalled();
    fireEvent.change(switcher, { target: { value: "available" } });
    expect(props.onOpenRecent).toHaveBeenCalledExactlyOnceWith("available");
  });

  it("disables only the unavailable recent project's open and resume actions", () => {
    const props = setup({ recentProjects: [
      { recentProjectId: "missing", title: "Missing", openedAt: "2026-10-19T00:00:00Z" },
      { recentProjectId: "busy", title: "Busy", openedAt: "2026-10-18T00:00:00Z" }
    ], unavailableRecentPath: "missing" });
    expect(screen.getByRole("button", { name: "최근 프로젝트 Missing 열기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "최근 프로젝트 Missing 이어하기" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "최근 프로젝트 Busy 열기" }));
    expect(props.onOpenRecent).toHaveBeenCalledExactlyOnceWith("busy");
  });
});
