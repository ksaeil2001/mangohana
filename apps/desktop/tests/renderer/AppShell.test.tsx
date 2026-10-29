import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../../src/renderer/components/AppShell";

describe("AppShell", () => {
  const dummyProps = {
    activeNav: "home" as const,
    recentProjects: [],
    onNavigate: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecent: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenPreparation: vi.fn(),
    onNewProject: vi.fn()
  };

  it("renders global brand, project navigation and main layout without a fake search field", () => {
    render(
      <AppShell {...dummyProps}>
        <div data-testid="test-child">메인 콘텐츠</div>
      </AppShell>
    );

    expect(screen.getByRole("button", { name: "망고하나 홈으로 이동" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "프로젝트 목록으로 이동" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("프로젝트, 파일, 태그 검색...")).not.toBeInTheDocument();
    expect(screen.getByTestId("test-child")).toBeInTheDocument();
  });

  it("navigates to projects from the header project-list action", () => {
    render(
      <AppShell {...dummyProps}>
        <div>본문</div>
      </AppShell>
    );

    fireEvent.click(screen.getByRole("button", { name: "프로젝트 목록으로 이동" }));

    expect(dummyProps.onNavigate).toHaveBeenCalledWith("projects");
  });

  it("returns home from the named brand and keeps every existing navigation destination", () => {
    const onNavigate = vi.fn();
    render(<AppShell {...dummyProps} activeNav="settings" onNavigate={onNavigate}><p>본문</p></AppShell>);

    fireEvent.click(screen.getByRole("button", { name: "망고하나 홈으로 이동" }));
    expect(onNavigate).toHaveBeenLastCalledWith("home");
    for (const [label, nav] of [["프로젝트", "projects"], ["파일", "files"], ["AI 번역", "ai"], ["편집 도구", "tools"], ["용어 사전", "dictionary"], ["설정", "settings"]]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onNavigate).toHaveBeenLastCalledWith(nav);
    }
  });

  it("exposes current navigation and returns focus when the mobile menu is dismissed", () => {
    render(<AppShell {...dummyProps}><p>본문</p></AppShell>);
    expect(screen.getByRole("button", { name: "홈" })).toHaveAttribute("aria-current", "page");
    const menu = screen.getByRole("button", { name: "메인 메뉴" });
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("complementary", { name: "메인 사이드바" }), { key: "Escape" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();
    expect(screen.getByRole("link", { name: "본문으로 건너뛰기" })).toHaveAttribute("href", "#trio-main-content");
  });

  it("does not render fake notifications or profile data", () => {
    render(
      <AppShell {...dummyProps}>
        <div>본문</div>
      </AppShell>
    );

    expect(screen.queryByRole("button", { name: "알림" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "사용자 프로필 설정" })).not.toBeInTheDocument();
    expect(screen.queryByText("seil_kim")).not.toBeInTheDocument();
    expect(screen.queryByText("로컬 저장소")).not.toBeInTheDocument();
    expect(screen.queryByText("Trio Pro로 업그레이드")).not.toBeInTheDocument();
  });

  it("returns focus to the menu toggle when choosing a destination hides the compact navigation", () => {
    const onNavigate = vi.fn();
    render(<AppShell {...dummyProps} onNavigate={onNavigate}><p>본문</p></AppShell>);
    const menu = screen.getByRole("button", { name: "메인 메뉴" });
    fireEvent.click(menu);
    const files = screen.getByRole("button", { name: "파일" });
    files.focus();
    fireEvent.click(files);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("files");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();
  });

  it("opens guide modal with topic-specific body and closes via close button or Escape key", () => {
    render(
      <AppShell {...dummyProps}>
        <div>본문</div>
      </AppShell>
    );

    const guideBtn = screen.getByRole("button", { name: /개인정보 처리방침/ });
    guideBtn.focus();
    fireEvent.click(guideBtn);

    expect(screen.getByRole("dialog", { name: /개인정보 처리방침/ })).toBeInTheDocument();
    expect(screen.getByText(/개인정보 처리방침 및 데이터 보안 원칙/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "안내창 닫기" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "확인" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(guideBtn).toHaveFocus();
  });

  it("updates main element aria-label according to activeNav", () => {
    const { rerender } = render(
      <AppShell {...dummyProps} activeNav="projects">
        <div>본문</div>
      </AppShell>
    );

    expect(screen.getByRole("main")).toHaveAttribute("aria-label", "프로젝트 관리");

    rerender(
      <AppShell {...dummyProps} activeNav="settings">
        <div>본문</div>
      </AppShell>
    );

    expect(screen.getByRole("main")).toHaveAttribute("aria-label", "환경 설정");
  });

  it("moves all recent project switching into the header and keeps the supplied callback", () => {
    const onOpenRecent = vi.fn();
    const recentProjects = Array.from({ length: 7 }, (_, index) => ({ recentProjectId: `recent-${index}`, title: `프로젝트 ${index}`, openedAt: "2026-10-19T00:00:00Z" }));
    render(<AppShell {...dummyProps} activeNav="settings" recentProjects={recentProjects} onOpenRecent={onOpenRecent}><p>본문</p></AppShell>);
    const select = screen.getByRole("combobox", { name: "최근 프로젝트 전환" });
    expect(screen.getByRole("banner", { name: "앱 헤더" })).toContainElement(select);
    expect(screen.getByRole("complementary", { name: "메인 사이드바" })).not.toContainElement(select);
    fireEvent.change(select, { target: { value: "recent-6" } });
    expect(onOpenRecent).toHaveBeenCalledExactlyOnceWith("recent-6");
    expect(screen.getByRole("main").closest(".stitch-suite")).toHaveAttribute("data-stitch-screen", "settings");
  });

  it("shows workspace return only when supplied and calls it without reopening a project", () => {
    const onResumeWorkspace = vi.fn();
    const onOpenProject = vi.fn();
    const onOpenRecent = vi.fn();
    const { rerender } = render(<AppShell {...dummyProps} onOpenProject={onOpenProject} onOpenRecent={onOpenRecent}><p>본문</p></AppShell>);
    expect(screen.queryByRole("button", { name: "작업대로 돌아가기" })).not.toBeInTheDocument();
    rerender(<AppShell {...dummyProps} onOpenProject={onOpenProject} onOpenRecent={onOpenRecent} onResumeWorkspace={onResumeWorkspace}><p>본문</p></AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "작업대로 돌아가기" }));
    expect(onResumeWorkspace).toHaveBeenCalledOnce();
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(onOpenRecent).not.toHaveBeenCalled();
  });
});
