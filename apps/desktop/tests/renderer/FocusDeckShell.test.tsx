import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FocusDeckShell, type WorkspacePanelActions } from "../../src/renderer/components/FocusDeckShell";
import type { WorkspacePanelState } from "../../src/renderer/focusDeck";
import type { GuidedStage } from "../../src/renderer/guidedWorkflow";

const defaultPanels: WorkspacePanelState = {
  pagesOpen: true,
  inspectorOpen: true,
  resultsOpen: true,
  focusMode: false,
  inspectorWidth: 392
};

function Harness({
  initialPanels = defaultPanels,
  currentStage = "ocr",
  canvasPriority = false
}: {
  initialPanels?: WorkspacePanelState;
  currentStage?: GuidedStage;
  canvasPriority?: boolean;
}) {
  const [panels, setPanels] = useState(initialPanels);
  return (
    <FocusDeckShell
      topBar={<span>project controls</span>}
      pages={<span>page filmstrip</span>}
      canvas={<button>canvas action</button>}
      editor={<span>task inspector</span>}
      filmstrip={<span>result progress</span>}
      panelState={panels}
      onPanelStateChange={setPanels}
      pagesBadge={18}
      inspectorBadge={4}
      resultsBadge={1}
      currentStage={currentStage}
      canvasPriority={canvasPriority}
    />
  );
}

describe("FocusDeckShell", () => {
  it("keeps a separate navigation column when the legacy workspace forces a single column", () => {
    const style = document.createElement("style");
    style.textContent = `.focus-deck-shell { grid-template-columns: minmax(0, 1fr) !important; }\n${readFileSync("src/renderer/mangohana-workspace.css", "utf8")}`;
    document.head.append(style);
    try {
      render(<FocusDeckShell topBar={null} navigation={() => <nav>navigation</nav>} pages={null} canvas={<span>page</span>}
        editor={null} filmstrip={null} currentStage="translation" panelState={{ ...defaultPanels, pagesOpen: false, inspectorOpen: false, resultsOpen: false }}
        onPanelStateChange={vi.fn()} />);
      expect(getComputedStyle(screen.getByTestId("focus-deck-shell")).gridTemplateColumns).toBe("104px minmax(0, 1fr)");
    } finally {
      style.remove();
    }
  });

  it("returns to the image when the visible narrow editor is closed", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    render(<Harness />);
    expect(screen.getByText("task inspector")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "작업 인스펙터 접기" }));

    expect(screen.getByText("task inspector")).not.toBeVisible();
    expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();
    expect(screen.queryByText("result progress")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "canvas action" })).toBeVisible();
  });

  it.each([1100, 900])("opens the requested results panel from the top bar at %ipx", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    function TopBarHarness() {
      const [panels, setPanels] = useState({ ...defaultPanels, resultsOpen: false });
      return <FocusDeckShell
        topBar={({ resultsVisible, toggleResults }) => <button aria-expanded={resultsVisible} onClick={toggleResults}>확인 필요 목록</button>}
        pages={<span>pages</span>} canvas={<span>canvas</span>} editor={<span>editor</span>}
        filmstrip={<span>요청한 검수 목록</span>} currentStage="translation" panelState={panels} onPanelStateChange={setPanels}
      />;
    }
    render(<TopBarHarness />);
    expect(screen.queryByText("요청한 검수 목록")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "확인 필요 목록" }));
    expect(screen.getByText("요청한 검수 목록")).toBeVisible();
    expect(screen.getByRole("button", { name: "확인 필요 목록" })).toHaveAttribute("aria-expanded", "true");
  });

  it.each([1100, 900])("preserves the mounted reading editor when opening pages at %ipx", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const onPanelStateChange = vi.fn();
    const panelActionsRef = createRef<WorkspacePanelActions>();
    const props = {
      topBar: <span>controls</span>, pages: <span>reading pages</span>, canvas: <button>canvas</button>,
      editor: <input aria-label="narrow draft" defaultValue="보존할 번역" />, filmstrip: null,
      currentStage: "translation" as const, panelState: defaultPanels, onPanelStateChange, panelActionsRef
    };
    const { rerender } = render(<FocusDeckShell {...props} />);
    const editor = screen.getByRole("textbox", { name: "narrow draft" });
    rerender(<FocusDeckShell {...props} readingMode />);
    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 열기" }));
    expect(screen.getByText("reading pages")).toBeVisible();
    act(() => panelActionsRef.current?.togglePages());
    expect(screen.queryByText("reading pages")).not.toBeInTheDocument();
    act(() => panelActionsRef.current?.togglePages());
    expect(screen.getByText("reading pages")).toBeVisible();
    expect(editor).toBeInTheDocument();
    expect(editor).not.toBeVisible();
    rerender(<FocusDeckShell {...props} />);
    expect(screen.getByRole("textbox", { name: "narrow draft" })).toBe(editor);
    expect(editor).toHaveValue("보존할 번역");
    expect(onPanelStateChange).not.toHaveBeenCalled();
  });

  it("keeps translation editing beside the image in focus mode", () => {
    render(<Harness currentStage="translation" />);
    fireEvent.click(screen.getByRole("button", { name: "집중 모드 켜기" }));
    expect(screen.getByText("task inspector")).toBeVisible();
    expect(screen.getByRole("button", { name: "canvas action" })).toBeVisible();
    expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();
    expect(screen.queryByText("result progress")).not.toBeInTheDocument();
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "392");
  });
  let previousWidth: number;

  beforeEach(() => {
    previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
  });

  it("collapses pages, inspector, and results independently", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();
    expect(screen.getByText("task inspector")).toBeInTheDocument();
    expect(screen.getByText("result progress")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "작업 인스펙터 접기" }));
    expect(screen.getByText("task inspector")).not.toBeVisible();
    expect(screen.getByText("task inspector").closest("aside")).toHaveAttribute("inert");
    expect(screen.getByText("result progress")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 접기" }));
    expect(screen.queryByText("result progress")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "페이지 목록 열기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "작업 인스펙터 열기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "결과 및 진행 열기" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps an explicitly open inspector visible when the page requests canvas priority", () => {
    render(<Harness canvasPriority />);

    expect(screen.getByText("task inspector")).toBeVisible();
    expect(screen.getByTestId("focus-deck-shell")).not.toHaveClass("canvas-priority");

    fireEvent.click(screen.getByRole("button", { name: "작업 인스펙터 접기" }));
    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("canvas-priority");
  });

  it("keeps labeled reopen controls and badges visible for collapsed regions", () => {
    render(<Harness initialPanels={{ ...defaultPanels, pagesOpen: false, inspectorOpen: false, resultsOpen: false }} />);

    const shell = screen.getByTestId("focus-deck-shell");
    const pages = within(shell).getByRole("button", { name: "페이지 목록 열기" });
    const inspector = within(shell).getByRole("button", { name: "작업 인스펙터 열기" });
    const results = within(shell).getByRole("button", { name: "결과 및 진행 열기" });

    expect(pages).not.toHaveAttribute("aria-controls");
    expect(pages).toHaveAttribute("title", "페이지 목록 열기");
    expect(within(pages).getByText("18")).toHaveClass("focus-deck-panel-badge");
    expect(within(inspector).getByText("4")).toHaveClass("focus-deck-panel-badge");
    expect(within(results).getByText("1")).toHaveClass("focus-deck-panel-badge");
  });

  it("keeps canvas, editor drafts, and result content mounted while reading without changing preferences", () => {
    const onPanelStateChange = vi.fn();
    const props = {
      topBar: <button>내보내기</button>,
      pages: <button>다음 페이지</button>,
      canvas: <button>원본 비교</button>,
      editor: <input aria-label="번역 초안" defaultValue="초기 번역" />,
      filmstrip: <button>대사 목록 선택</button>,
      statusBar: <span>저장됨</span>,
      panelState: defaultPanels,
      onPanelStateChange,
      currentStage: "translation" as const
    };
    const { rerender } = render(<FocusDeckShell {...props} />);
    const canvas = screen.getByRole("button", { name: "원본 비교" });
    const draft = screen.getByRole("textbox", { name: "번역 초안" });
    const results = screen.getByRole("button", { name: "대사 목록 선택" });
    const separator = screen.getByRole("separator");
    fireEvent.change(draft, { target: { value: "보존할 사용자 번역" } });
    draft.focus();

    rerender(<FocusDeckShell {...props} readingMode />);

    expect(screen.getByTestId("focus-deck-shell")).toHaveClass("reading-mode", "inspector-collapsed", "results-collapsed");
    expect(screen.getByRole("button", { name: "원본 비교" })).toBe(canvas);
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBeVisible();
    expect(screen.getByRole("button", { name: "내보내기" })).toBeVisible();
    expect(screen.getByText("저장됨")).toBeVisible();
    expect(screen.getByRole("main")).toHaveFocus();
    expect(draft).toHaveValue("보존할 사용자 번역");
    expect(draft.closest(".focus-deck-editor")).toHaveAttribute("hidden");
    expect(draft.closest(".focus-deck-editor")).toHaveAttribute("inert");
    expect(separator).not.toBeVisible();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(results.closest(".focus-deck-filmstrip")).toHaveAttribute("hidden");
    expect(results.closest(".focus-deck-filmstrip")).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "번역 편집기 열기" })).not.toBeInTheDocument();
    expect(onPanelStateChange).not.toHaveBeenCalled();

    rerender(<FocusDeckShell {...props} />);

    expect(screen.getByRole("button", { name: "원본 비교" })).toBe(canvas);
    expect(screen.getByRole("textbox", { name: "번역 초안" })).toBe(draft);
    expect(draft).toHaveValue("보존할 사용자 번역");
    expect(screen.getByRole("separator")).toBe(separator);
    expect(screen.getByRole("button", { name: "대사 목록 선택" })).toBe(results);
    expect(onPanelStateChange).not.toHaveBeenCalled();
  });

  it("moves focus from hidden results to the canvas on reading entry", () => {
    const props = {
      topBar: <span>controls</span>,
      pages: <span>pages</span>,
      canvas: <button>읽기 캔버스</button>,
      editor: <span>editor</span>,
      filmstrip: <button>처리 현황</button>,
      panelState: defaultPanels,
      onPanelStateChange: vi.fn(),
      currentStage: "ocr" as const
    };
    const { rerender } = render(<FocusDeckShell {...props} />);
    screen.getByRole("button", { name: "처리 현황" }).focus();

    rerender(<FocusDeckShell {...props} readingMode />);

    expect(screen.getByRole("main")).toHaveFocus();
    expect(props.onPanelStateChange).not.toHaveBeenCalled();
  });

  it("keeps the existing empty workspace canvas when reading mode changes", () => {
    const props = {
      topBar: <span>controls</span>,
      pages: null,
      canvas: <button>시작 화면</button>,
      editor: null,
      filmstrip: null,
      statusBar: <span>status</span>,
      panelState: defaultPanels,
      onPanelStateChange: vi.fn(),
      currentStage: "ocr" as const,
      showWorkspaceChrome: false
    };
    const { rerender } = render(<FocusDeckShell {...props} />);
    const canvas = screen.getByRole("button", { name: "시작 화면" });

    rerender(<FocusDeckShell {...props} readingMode />);

    expect(screen.getByRole("button", { name: "시작 화면" })).toBe(canvas);
    expect(screen.queryByTestId("resizable-workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("status")).not.toBeInTheDocument();
  });

  it("keeps edge toggles and badges as direct children of their viewport tracks", () => {
    render(<Harness initialPanels={{ ...defaultPanels, pagesOpen: false, inspectorOpen: false }} />);

    const shell = screen.getByTestId("focus-deck-shell");
    for (const edgeClass of ["focus-deck-pages-edge", "focus-deck-inspector-edge"]) {
      const edge = shell.querySelector(`.${edgeClass}`);
      expect(edge).not.toBeNull();
      const toggle = edge?.querySelector(".focus-deck-panel-toggle");
      expect(toggle?.parentElement).toBe(edge);
      expect(toggle?.querySelector(".focus-deck-panel-badge")).not.toBeNull();
    }
  });

  it("keeps the narrow inspector edge control focusable for close and reopen", () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1099 });
    try {
      render(<Harness />);

      const close = screen.getByRole("button", { name: "작업 인스펙터 접기" });
      close.focus();
      expect(close).toHaveFocus();
      fireEvent.click(close);
      expect(screen.getByText("task inspector")).not.toBeVisible();

      const reopen = screen.getByRole("button", { name: "작업 인스펙터 열기" });
      reopen.focus();
      expect(reopen).toHaveFocus();
      fireEvent.click(reopen);
      expect(screen.getByText("task inspector")).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it.each([1200, 1280, 1440])("shows the saved page rail beside the editor at %spx", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    render(<Harness />);

    const shell = screen.getByTestId("focus-deck-shell");
    expect(shell).toHaveClass("stitch-workbench");
    expect(shell).toHaveAttribute("data-layout-tier", width < 1440 ? "compact" : "wide");
    expect(screen.getByText("page filmstrip")).toBeInTheDocument();
    expect(screen.getByText("task inspector")).toBeInTheDocument();
    expect(screen.getByText("result progress")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 접기" }));
    expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "페이지 목록 열기" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 열기" }));
    expect(screen.getByText("page filmstrip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "페이지 목록 접기" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the resizable workspace centered and the inspector edge last when pages are collapsed", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    render(<Harness initialPanels={{ ...defaultPanels, pagesOpen: false }} />);

    const shell = screen.getByTestId("focus-deck-shell");
    expect(shell).toHaveClass("pages-collapsed");
    const workspace = shell.querySelector(".focus-deck-workspace");
    expect(workspace).not.toBeNull();
    expect(Array.from(workspace?.children ?? []).map((child) => child.className)).toEqual([
      "focus-deck-pages-edge",
      "resizable-workspace",
      "focus-deck-inspector-edge"
    ]);
  });

  it("shows at most one auxiliary region at narrow width while explicit toggles switch panels", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1099 });
    render(<Harness />);

    expect(screen.getByText("task inspector")).toBeInTheDocument();
    expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();
    expect(screen.queryByText("result progress")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "결과 및 진행 열기" }));
    expect(screen.getByText("result progress")).toBeInTheDocument();
    expect(screen.getByText("task inspector")).not.toBeVisible();
    expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "페이지 목록 열기" }));
    expect(screen.getByText("page filmstrip")).toBeInTheDocument();
    expect(screen.getByText("task inspector")).not.toBeVisible();
    expect(screen.queryByText("result progress")).not.toBeInTheDocument();
  });

  it("retains the saved panel preference across compact and narrow resizes", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    render(<Harness initialPanels={{ ...defaultPanels, inspectorOpen: false }} />);

    expect(screen.getByText("page filmstrip")).toBeInTheDocument();
    expect(screen.queryByText("task inspector")).not.toBeInTheDocument();
    expect(screen.getByText("result progress")).toBeInTheDocument();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("focus-deck-shell")).toHaveAttribute("data-layout-tier", "precision-limited");
    expect(screen.getByText("result progress")).toBeInTheDocument();
    expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();
    expect(screen.queryByText("task inspector")).not.toBeInTheDocument();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("focus-deck-shell")).toHaveAttribute("data-layout-tier", "wide");
    expect(screen.getByText("page filmstrip")).toBeInTheDocument();
    expect(screen.getByText("result progress")).toBeInTheDocument();
    expect(screen.queryByText("task inspector")).not.toBeInTheDocument();
  });

  it("hides every supporting region in focus mode and restores the exact previous combination", () => {
    render(<Harness initialPanels={{ ...defaultPanels, inspectorOpen: false }} />);

    const focusToggle = screen.getByRole("button", { name: "집중 모드 켜기" });
    expect(focusToggle).toHaveAttribute("aria-expanded", "true");
    expect(focusToggle).toHaveAttribute("aria-controls", "focus-deck-workspace-regions");
    fireEvent.click(focusToggle);
    expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();
    expect(screen.queryByText("task inspector")).not.toBeInTheDocument();
    expect(screen.queryByText("result progress")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "페이지 목록 열기" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "집중 모드 끄기" }));
    expect(screen.getByText("page filmstrip")).toBeInTheDocument();
    expect(screen.queryByText("task inspector")).not.toBeInTheDocument();
    expect(screen.getByText("result progress")).toBeInTheDocument();
  });

  it("exits focus mode on Escape without canceling running workspace content", () => {
    render(
      <Harness
        initialPanels={{ ...defaultPanels, focusMode: true }}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByText("canvas action")).toBeInTheDocument();
    expect(screen.getByText("task inspector")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "집중 모드 켜기" })).toBeInTheDocument();
  });

  it("hides every supporting region during document fullscreen without changing saved panel state", () => {
    const previousFullscreen = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement
    });
    try {
      render(<Harness initialPanels={{ ...defaultPanels, pagesOpen: true, inspectorOpen: false, resultsOpen: true }} />);
      expect(screen.getByText("page filmstrip")).toBeInTheDocument();
      fullscreenElement = screen.getByTestId("focus-deck-shell");
      fireEvent(document, new Event("fullscreenchange"));

      const shell = screen.getByTestId("focus-deck-shell");
      expect(shell).toHaveClass("document-fullscreen");
      expect(screen.queryByText("page filmstrip")).not.toBeInTheDocument();
      expect(screen.queryByText("task inspector")).not.toBeInTheDocument();
      expect(screen.queryByText("result progress")).not.toBeInTheDocument();

      fullscreenElement = null;
      fireEvent(document, new Event("fullscreenchange"));
      expect(screen.getByText("page filmstrip")).toBeInTheDocument();
      expect(screen.queryByText("task inspector")).not.toBeInTheDocument();
      expect(screen.getByText("result progress")).toBeInTheDocument();
    } finally {
      if (previousFullscreen) Object.defineProperty(document, "fullscreenElement", previousFullscreen);
      else Reflect.deleteProperty(document, "fullscreenElement");
    }
  });

  it("announces precision limits below 1024px without removing the image canvas", () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    try {
      render(<Harness />);
      const shell = screen.getByTestId("focus-deck-shell");
      expect(shell).toHaveAttribute("data-layout-tier", "precision-limited");
      expect(screen.getByRole("status", { name: "정밀 편집 안내" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "canvas action" })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
    }
  });

  it("has no fixed Work, Pages, Context, or Settings navigation", () => {
    render(<Harness />);
    expect(screen.queryByRole("navigation", { name: "작업 도구" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "작업" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "문맥" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "설정" })).not.toBeInTheDocument();
  });

  it.each([
    ["ocr", "OCR"],
    ["speaker", "화자"],
    ["translation", "번역"],
    ["complete", "완료"]
  ] satisfies Array<[GuidedStage, string]>)('marks only the %s workflow stage as current', (currentStage, label) => {
    render(<Harness currentStage={currentStage} />);

    const workflow = screen.getByRole("list", { name: "작업 진행 단계" });
    const current = within(workflow).getByText(label).closest("li");
    expect(current).toHaveAttribute("aria-current", "step");
    expect(within(workflow).getAllByRole("listitem").filter((item) => item.hasAttribute("aria-current"))).toEqual([current]);
  });

  it("marks preceding workflow stages as complete", () => {
    render(<Harness currentStage="translation" />);

    const workflow = screen.getByRole("list", { name: "작업 진행 단계" });
    expect(within(workflow).getByText("OCR").closest("li")).toHaveAttribute("data-state", "complete");
    expect(within(workflow).getByText("화자").closest("li")).toHaveAttribute("data-state", "complete");
    expect(within(workflow).getByText("번역").closest("li")).toHaveAttribute("data-state", "current");
    expect(within(workflow).getByText("완료").closest("li")).toHaveAttribute("data-state", "upcoming");
    expect(within(workflow).getAllByText(", 완료")).toHaveLength(2);
    expect(within(workflow).getAllByText(", 완료")[0]).toHaveClass("sr-only");
    expect(within(workflow).getByText(", 현재 단계")).toHaveClass("sr-only");
    expect(within(workflow).getByText(", 다음 단계")).toHaveClass("sr-only");
  });
});
