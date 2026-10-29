import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageStrip } from "../../src/renderer/components/PageStrip";

const pages = [
  { pageNumber: 1, hasImage: true, lineCount: 4, issueCount: 0, storedRelativePath: "assets/one.png" },
  { pageNumber: 2, hasImage: false, lineCount: 3, issueCount: 2 },
  { pageNumber: 3, hasImage: false, lineCount: 0, issueCount: 0 }
];

afterEach(() => { vi.unstubAllGlobals(); });

describe("page navigator", () => {
  it("filters review targets while preserving the current page and navigation", () => {
    const select = vi.fn();
    render(<PageStrip pages={pages} currentPage={1} onSelectPage={select} />);
    fireEvent.click(screen.getByRole("button", { name: "검수 대상 1" }));
    expect(screen.getByRole("button", { name: "페이지 1 선택" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "페이지 3 선택" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "페이지 2 선택" }));
    expect(select).toHaveBeenCalledWith(2);
    expect(screen.getByRole("button", { name: "페이지 2 선택" })).toHaveAccessibleDescription(/이미지 없음.*라인 3.*문제 2/);
    fireEvent.click(screen.getByRole("button", { name: "전체 3" }));
    expect(screen.getByRole("button", { name: "페이지 3 선택" })).toBeInTheDocument();
  });

  it("loads only visible previews, ignores old session responses and releases offscreen images", async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    let finishOld!: (src: string) => void;
    const resolvePageImageSrc = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { finishOld = resolve; }))
      .mockResolvedValue("/new.png");
    const previousApi = window.projectApi;
    window.projectApi = { ...previousApi, resolvePageImageSrc } as typeof window.projectApi;
    try {
      const { rerender, container } = render(<PageStrip pages={pages} currentPage={1} onSelectPage={vi.fn()} currentFilePath="session:old" />);
      expect(resolvePageImageSrc).not.toHaveBeenCalled();
      act(() => callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(resolvePageImageSrc).toHaveBeenCalledWith({ projectSessionId: "old", storedRelativePath: "assets/one.png" });
      rerender(<PageStrip pages={pages} currentPage={1} onSelectPage={vi.fn()} currentFilePath="session:new" />);
      await waitFor(() => expect(container.querySelector("img")).toHaveAttribute("src", "/new.png"));
      await act(async () => finishOld("/stale.png"));
      expect(container.querySelector("img")).toHaveAttribute("src", "/new.png");
      act(() => callbacks[0]([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(container.querySelector("img")).toBeNull();
    } finally {
      window.projectApi = previousApi;
    }
  });
});
