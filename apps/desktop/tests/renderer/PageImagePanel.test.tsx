import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PageImage } from "../../src/shared/projectTypes";
import { getFocusPan, PageImagePanel } from "../../src/renderer/components/PageImagePanel";

const image: PageImage = {
  id: "page-image-1",
  pageNumber: 1,
  storedRelativePath: "/review-assets/page-001.png",
  originalFileName: "page-001.png",
  sha256: "hash",
  byteSize: 100,
  mimeType: "image/png",
  copiedAt: "2026-07-10T00:00:00.000Z"
};

const baseProps = {
  currentPage: 1,
  currentFilePath: null,
  image,
  onImportImages: vi.fn().mockResolvedValue(undefined),
  onInpaintImage: vi.fn().mockResolvedValue(false),
  onExtractSpeechBubbles: vi.fn().mockResolvedValue(undefined)
};

const comparisonResultLayers = {
  original: { layer: "original" as const, image, status: "ready" as const, message: "Original" },
  inpainted: {
    layer: "inpainted" as const,
    image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
    status: "ready" as const,
    message: "Inpainted"
  },
  translated: { layer: "translated" as const, image: null, status: "missing" as const, message: "Translated" }
};

const styles = readFileSync("src/renderer/styles.css", "utf8");

describe("PageImagePanel OCR highlight", () => {
  it("places the image above its toolbar despite the legacy grid reset", () => {
    const style = document.createElement("style");
    style.textContent = styles + readFileSync("src/renderer/stitch-workbench.css", "utf8") + readFileSync("src/renderer/mangohana-workspace.css", "utf8");
    document.head.append(style);
    try {
      const { container } = render(<div className="focus-deck-shell stitch-workbench has-workspace-navigation"><PageImagePanel {...baseProps} /></div>);
      expect(getComputedStyle(screen.getByTestId("page-image-viewport")).gridArea).toBe("1 / 1");
      expect(getComputedStyle(container.querySelector<HTMLElement>(".page-image-toolbar")!).gridArea).toBe("2 / 1");
    } finally {
      style.remove();
    }
  });

  it("keeps comparison controls available on demand while leaving image zoom visible", () => {
    render(<PageImagePanel {...baseProps} resultLayers={comparisonResultLayers} />);
    expect(screen.getByRole("button", { name: "화면 맞춤" })).toBeVisible();
    expect(screen.getByRole("button", { name: "확대" })).toBeVisible();
    expect(screen.getByRole("button", { name: "분할 비교" })).not.toBeVisible();

    fireEvent.click(screen.getByText("보기·비교"));
    fireEvent.click(screen.getByRole("button", { name: "분할 비교" }));
    expect(screen.getByRole("button", { name: "분할 비교" })).toHaveAttribute("aria-pressed", "true");
  });

  it("selects a dialogue on the image without starting the pan gesture", () => {
    const onSelectLine = vi.fn();
    const { rerender } = render(<PageImagePanel {...baseProps} onSelectLine={onSelectLine} dialogueTargets={[
      { id: "dialogue-2", order: 2, bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 }, selected: false }
    ]} />);
    const target = screen.getByRole("button", { name: "이미지 대사 2 선택" });
    expect(target).toHaveStyle({ left: "20%", top: "30%", width: "40%", height: "10%" });
    fireEvent.pointerDown(target, { pointerId: 1 });
    fireEvent.click(target);
    expect(onSelectLine).toHaveBeenCalledExactlyOnceWith("dialogue-2");
    rerender(<PageImagePanel {...baseProps} onSelectLine={onSelectLine} dialogueTargets={[]} />);
    expect(screen.queryByRole("button", { name: "이미지 대사 2 선택" })).not.toBeInTheDocument();
  });

  it("keeps the overlay menu outside horizontally scrolling tools and anchors it within the toolbar", () => {
    const style = document.createElement("style");
    style.textContent = styles + readFileSync("src/renderer/design-system.css", "utf8");
    document.head.append(style);
    try {
      const { container } = render(<PageImagePanel {...baseProps} />);
      const tools = container.querySelector<HTMLElement>(".page-image-tools")!;
      const menu = container.querySelector<HTMLElement>(".page-image-overlay-dropdown")!;
      expect(tools.contains(menu)).toBe(false);
      expect(getComputedStyle(tools).justifyContent).toBe("flex-start");
      expect(getComputedStyle(menu.querySelector<HTMLElement>(".semantic-overlay-legend")!).left).toBe("auto");
    } finally {
      style.remove();
    }
  });

  it("computes bounded focus pans for a bbox, edges, and the page center fallback", () => {
    expect(getFocusPan({ stageWidth: 200, stageHeight: 200, mediaWidth: 800, mediaHeight: 600, bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })).toEqual({ x: 300, y: 200 });
    expect(getFocusPan({ stageWidth: 200, stageHeight: 200, mediaWidth: 800, mediaHeight: 600, bbox: { x: 0, y: 0, width: 0.1, height: 0.1 } })).toEqual({ x: 0, y: 0 });
    expect(getFocusPan({ stageWidth: 200, stageHeight: 200, mediaWidth: 800, mediaHeight: 600 })).toEqual({ x: 300, y: 200 });
  });

  it("applies a focus request to the image viewport without changing the image coordinate bbox", () => {
    const { rerender } = render(<PageImagePanel {...baseProps} />);
    const stage = screen.getByTestId("page-image-viewport");
    const media = screen.getByTestId("page-image-media");
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(media, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(media, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(media, "scrollWidth", { configurable: true, value: 800 });
    Object.defineProperty(media, "scrollHeight", { configurable: true, value: 600 });
    rerender(<PageImagePanel {...baseProps} focusRequest={{ key: "focus-1", bbox: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 } }} />);
    expect(stage).toHaveProperty("scrollLeft", 540);
    expect(stage).toHaveProperty("scrollTop", 20);
  });

  it("emits a render request identity for every page image generation", () => {
    const events: Array<Record<string, unknown>> = [];
    const pageTwo = { ...image, id: "page-image-2", pageNumber: 2 };
    const { rerender } = render(
      <PageImagePanel {...baseProps} onRenderStateChange={(state) => events.push(state)} />
    );
    fireEvent.load(screen.getByAltText("1페이지 이미지"));
    rerender(
      <PageImagePanel
        {...baseProps}
        currentPage={2}
        image={pageTwo}
        onRenderStateChange={(state) => events.push(state)}
      />
    );
    const first = events.find((state) => state.status === "ready" && state.currentPage === 1);
    const second = events.find((state) => state.currentPage === 2);
    expect(first?.renderRequestKey).toBeTruthy();
    expect(second?.renderRequestKey).toBeTruthy();
    expect(first?.renderRequestKey).not.toBe(second?.renderRequestKey);
  });

  it("keeps the divider hit area interactive while comparison surfaces ignore pointer input", () => {
    expect(styles).toMatch(/\.page-image-comparison-divider\s*\{[^}]*pointer-events:\s*auto;/);
    expect(styles).toMatch(/\.page-image-comparison-media \.comparison-surface\s*\{[^}]*pointer-events:\s*none;/);
  });

  it("restores keyed comparison controls without persisting a held-original gesture", () => {
    const changes: Array<{ mode: string; revealPosition: number; opacity: number }> = [];
    const { rerender } = render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={comparisonResultLayers}
        initialComparisonState={{ key: "restore-1", mode: "reveal", revealPosition: 68, opacity: 0.35 }}
        onComparisonStateChange={(state) => changes.push(state)}
      />
    );

    expect(screen.getByRole("button", { name: /Reveal comparison|슬라이더 비교/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("slider", { name: /Reveal comparison line|슬라이더 비교선/i })).toHaveAttribute("aria-valuenow", "68");
    fireEvent.keyDown(window, { key: "\\", code: "Backslash" });
    expect(screen.getByRole("img")).toHaveAttribute("src", "/review-assets/page-001.png");
    fireEvent.keyUp(window, { key: "\\", code: "Backslash" });
    expect(screen.getByTestId("comparison-surface-result")).toHaveAttribute("src", "/review-assets/inpainted.png");

    fireEvent.click(screen.getByRole("button", { name: /Opacity comparison|투명도 비교/i }));
    expect(changes.at(-1)).toEqual({ mode: "opacity", revealPosition: 68, opacity: 0.35 });
    rerender(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={comparisonResultLayers}
        initialComparisonState={{ key: "restore-2", mode: "single", revealPosition: 20, opacity: 0.8 }}
        onComparisonStateChange={(state) => changes.push(state)}
      />
    );
    expect(screen.getByRole("button", { name: /Single comparison|단일 비교/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("img")).toHaveAttribute("src", "/review-assets/inpainted.png");
  });

  it("maps reveal pointer coordinates to the centered image surface in Fit mode", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={comparisonResultLayers}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Reveal comparison|슬라이더 비교/i }));
    const media = screen.getByTestId("page-image-media");
    Object.defineProperty(media, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 200, top: 0, width: 400, height: 600, right: 600, bottom: 600 })
    });
    const handle = screen.getByRole("slider", { name: /Reveal comparison line|슬라이더 비교선/i });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(screen.getByTestId("page-image-viewport"), {
      pointerId: 1,
      clientX: 400,
      clientY: 300
    });
    expect(handle).toHaveAttribute("aria-valuenow", "50");
    fireEvent.pointerUp(screen.getByTestId("page-image-viewport"), { pointerId: 1 });
  });

  it("allows dragging the reveal divider itself outside the handle", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={comparisonResultLayers}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Reveal comparison|슬라이더 비교/i }));
    const media = screen.getByTestId("page-image-media");
    Object.defineProperty(media, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 200, top: 0, width: 400, height: 600, right: 600, bottom: 600 })
    });
    const divider = screen.getByTestId("comparison-divider");
    const handle = screen.getByRole("slider", { name: /Reveal comparison line|슬라이더 비교선/i });

    fireEvent.pointerDown(divider, { pointerId: 3, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(screen.getByTestId("page-image-viewport"), {
      pointerId: 3,
      clientX: 500,
      clientY: 300
    });
    expect(handle).toHaveAttribute("aria-valuenow", "75");
    fireEvent.pointerUp(screen.getByTestId("page-image-viewport"), { pointerId: 3 });
  });

  it("maps reveal pointer coordinates to the zoomed image surface after pan", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={comparisonResultLayers}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Width Fit|너비 맞춤/i }));
    fireEvent.click(screen.getByRole("button", { name: /Zoom in|확대/i }));
    const stage = screen.getByTestId("page-image-viewport");
    stage.scrollLeft = 120;
    fireEvent.scroll(stage);
    fireEvent.click(screen.getByRole("button", { name: /Reveal comparison|슬라이더 비교/i }));
    const media = screen.getByTestId("page-image-media");
    Object.defineProperty(media, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: -120, top: 0, width: 800, height: 1200, right: 680, bottom: 1200 })
    });
    const handle = screen.getByRole("slider", { name: /Reveal comparison line|슬라이더 비교선/i });

    fireEvent.pointerDown(handle, { pointerId: 2, clientX: -120, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 280, clientY: 300 });
    expect(handle).toHaveAttribute("aria-valuenow", "50");
    fireEvent.pointerUp(stage, { pointerId: 2 });
  });

  it("preserves viewport, OCR overlay, and selected result while comparison mode changes", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={comparisonResultLayers}
        activeOcrBbox={{ x: 0.1, y: 0.2, width: 0.3, height: 0.12 }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Width Fit|너비 맞춤/i }));
    fireEvent.click(screen.getByRole("button", { name: /Zoom in|확대/i }));
    fireEvent.click(screen.getByRole("button", { name: /Original layer|원본 레이어/i }));
    const stage = screen.getByTestId("page-image-viewport");
    stage.scrollLeft = 64;
    stage.scrollTop = 38;
    fireEvent.scroll(stage);
    fireEvent.click(screen.getByRole("button", { name: /Original layer|원본 레이어/i }));

    for (const [enMode, koMode] of [["Split", "분할"], ["Reveal", "슬라이더"], ["Opacity", "투명도"]]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`${enMode} comparison|${koMode} 비교`, "i") }));
      expect(screen.getByRole("button", { name: /Inpainted result|인페인팅 결과/i })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
      expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument();
      expect(screen.getByTestId("page-image-viewport").querySelector(".page-image-ocr-highlight")).toBeInTheDocument();
      expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 64);
      expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 38);
    }
  });

  it("falls back to the original with status and retry when a comparison result fails to render", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={comparisonResultLayers}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Split comparison|분할 비교/i }));
    fireEvent.error(screen.getByTestId("comparison-surface-result"));
    expect(screen.getByTestId("comparison-surface-result")).toHaveAttribute("src", "/review-assets/page-001.png");
    expect(screen.getByRole("button", { name: "인페인팅 결과" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /인페인팅 결과 다시 시도|Retry inpainted result/i })).toBeInTheDocument();

    for (const [enMode, koMode] of [["Reveal", "슬라이더"], ["Opacity", "투명도"]]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`${enMode} comparison|${koMode} 비교`, "i") }));
      expect(screen.getByTestId("comparison-surface-result")).toHaveAttribute("src", "/review-assets/page-001.png");
      expect(screen.getByRole("button", { name: /인페인팅 결과 다시 시도|Retry inpainted result/i })).toBeInTheDocument();
    }
  });

  it("keeps the original result selected when comparison controls are used", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="original"
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "Inpainted"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Split comparison|분할 비교/i }));

    expect(screen.getByRole("button", { name: /Original result|원본 결과/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Split comparison|분할 비교/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("comparison-surface-original")).toHaveLength(1);
    expect(screen.queryByTestId("comparison-surface-result")).not.toBeInTheDocument();
  });

  it("renders original and selected result surfaces in split, reveal, and opacity modes", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "Inpainted"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    const stage = screen.getByTestId("page-image-viewport");
    for (const [enMode, koMode] of [["Split", "분할"], ["Reveal", "슬라이더"], ["Opacity", "투명도"]]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`${enMode} comparison|${koMode} 비교`, "i") }));
      expect(stage).toContainElement(screen.getByTestId("comparison-surface-original"));
      expect(stage).toContainElement(screen.getByTestId("comparison-surface-result"));
      expect(screen.getByTestId("comparison-surface-original").parentElement).toBe(
        screen.getByTestId("comparison-surface-result").parentElement
      );
    }
  });

  it("moves the reveal divider with keyboard controls", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "Inpainted"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Reveal comparison|슬라이더 비교/i }));
    const handle = screen.getByRole("slider", { name: /Reveal comparison line|슬라이더 비교선/i });
    expect(handle).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "55");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "50");
  });

  it("changes opacity in five percent keyboard steps", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "Inpainted"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Opacity comparison|투명도 비교/i }));
    const opacity = screen.getByRole("slider", { name: /Comparison opacity|비교 투명도/i });
    expect(opacity).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(opacity, { key: "ArrowRight" });
    expect(opacity).toHaveAttribute("aria-valuenow", "55");
  });

  it("shows original while Backslash is held and restores the selected result on keyup or blur", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "Inpainted"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Single comparison|단일 비교/i }));
    expect(screen.getByRole("img")).toHaveAttribute("src", "/review-assets/inpainted.png");
    fireEvent.keyDown(window, { key: "\\", code: "Backslash" });
    expect(screen.getByRole("img")).toHaveAttribute("src", "/review-assets/page-001.png");
    fireEvent.keyUp(window, { key: "\\", code: "Backslash" });
    expect(screen.getByRole("img")).toHaveAttribute("src", "/review-assets/inpainted.png");
    fireEvent.keyDown(window, { key: "\\", code: "Backslash" });
    fireEvent.blur(window);
    expect(screen.getByRole("img")).toHaveAttribute("src", "/review-assets/inpainted.png");
  });

  it("ignores Backslash while an editable control has focus", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "Inpainted"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "\\", code: "Backslash" });
    expect(screen.getByRole("img")).toHaveAttribute("src", "/review-assets/inpainted.png");
    input.remove();
  });

  it("renders an uncropped fit viewport with complete view controls", () => {
    render(<PageImagePanel {...baseProps} />);

    const pageImage = screen.getByAltText("1페이지 이미지");
    expect(pageImage).toHaveAttribute("data-view-mode", "fit");
    expect(pageImage).not.toHaveClass("cover");
    expect(screen.getByRole("button", { name: /Fit|화면 맞춤/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Width Fit|너비 맞춤/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Zoom out|축소/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Zoom in|확대/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reset view|보기 초기화/i })).toBeInTheDocument();
  });

  it("toggles original and OCR layers independently and labels unavailable future layers", () => {
    render(
      <PageImagePanel
        {...baseProps}
        activeOcrBbox={{ x: 0.1, y: 0.2, width: 0.3, height: 0.12 }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Original layer|원본 레이어/i }));
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByLabelText("선택된 OCR 영역")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /OCR layer|OCR 레이어/i }));
    expect(screen.queryByLabelText("선택된 OCR 영역")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Source layer unavailable|원문 레이어 미지원/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Translation layer unavailable|번역 레이어 미지원/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Final layer unavailable|최종 레이어 미지원/i })).toBeDisabled();
  });

  it("does not capture a plain wheel and captures Ctrl+wheel zoom", () => {
    render(<PageImagePanel {...baseProps} />);
    const stage = screen.getByTestId("page-image-viewport");

    expect(fireEvent.wheel(stage, { deltaY: 100 })).toBe(true);
    expect(fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true })).toBe(false);
    expect(screen.getByText("125%")).toBeInTheDocument();
  });

  it("keeps reconnect and OCR retry actions in the image error state", () => {
    const onExtractSpeechBubbles = vi.fn().mockResolvedValue(undefined);
    render(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        onExtractSpeechBubbles={onExtractSpeechBubbles}
      />
    );
    fireEvent.error(screen.getByAltText("1페이지 이미지"));

    expect(screen.getByRole("button", { name: "이미지 다시 연결" })).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "OCR 다시 실행" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(onExtractSpeechBubbles).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate normal OCR actions under the image stage", () => {
    render(<PageImagePanel {...baseProps} currentFilePath="C:\\projects\\Book.ctp" />);
    expect(screen.queryByRole("button", { name: "빠른 OCR" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("이미지 빠른 작업")).not.toBeInTheDocument();
  });

  it("resets the view on page switch without resetting layer choices", () => {
    const { rerender } = render(<PageImagePanel {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Width Fit|너비 맞춤/i }));
    fireEvent.click(screen.getByRole("button", { name: /Original layer|원본 레이어/i }));
    const stage = screen.getByTestId("page-image-viewport");
    stage.scrollLeft = 91;
    stage.scrollTop = 73;

    rerender(
      <PageImagePanel
        {...baseProps}
        currentPage={2}
        image={{ ...image, id: "page-image-2", pageNumber: 2, originalFileName: "page-002.png" }}
      />
    );

    expect(screen.getByRole("button", { name: /Fit|화면 맞춤/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText("2페이지 이미지")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("page-image-viewport").scrollLeft).toBe(0);
    expect(screen.getByTestId("page-image-viewport").scrollTop).toBe(0);
  });

  it("resets stage scroll for view changes and clears pointer drag on capture loss and unmount", () => {
    const { unmount } = render(<PageImagePanel {...baseProps} />);
    const stage = screen.getByTestId("page-image-viewport");
    Object.defineProperty(stage, "scrollWidth", { configurable: true, value: 500 });
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 100 });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(stage, { setPointerCapture, releasePointerCapture });

    stage.scrollLeft = 80;
    stage.scrollTop = 40;
    fireEvent.click(screen.getByRole("button", { name: /Reset view|보기 초기화/i }));
    expect(stage.scrollLeft).toBe(0);
    expect(stage.scrollTop).toBe(0);

    stage.scrollLeft = 20;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.lostPointerCapture(stage, { pointerId: 1 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 0, clientY: 10 });
    expect(stage.scrollLeft).toBe(20);

    fireEvent(
      stage,
      Object.assign(new Event("pointerdown", { bubbles: true }), { pointerId: 2, clientX: 10, clientY: 10 })
    );
    unmount();
    expect(releasePointerCapture).toHaveBeenCalledWith(2);
  });

  it("reports native stage scrolling through the viewport callback", () => {
    const onViewportChange = vi.fn();
    render(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        onViewportChange={onViewportChange}
      />
    );
    onViewportChange.mockClear();
    const stage = screen.getByTestId("page-image-viewport");
    stage.scrollLeft = 73;
    stage.scrollTop = 41;
    fireEvent.scroll(stage);

    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pan: { x: 73, y: 41 } })
    );
  });

  it("keeps the main image stage visible in an explicit split while the inpainting editor scrolls", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    render(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        inpaintingOpen
      />
    );

    expect(screen.getByLabelText("페이지 이미지")).toHaveClass("editor-open");
    expect(screen.getByTestId("page-image-viewport")).toBeInTheDocument();
    expect(screen.getByLabelText("1페이지 인페인팅 편집기")).toBeInTheDocument();
    expect(styles).toContain(".page-image-panel.editor-open");
    expect(styles).toContain('grid-template-areas: "toolbar" "stage" "editor"');
    expect(styles).toContain("minmax(180px, 1fr)");
    expect(styles).toContain(".page-image-panel.editor-open > .inpainting-editor");
    expect(styles).toContain("overflow: auto");
  });

  it("preserves a controlled inpainting editor on an environment-return remount", () => {
    const onInpaintingOpenChange = vi.fn();
    const { rerender } = render(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        inpaintingOpen
        initialViewport={{ key: "project-a:environment-return:1", zoom: 1, preserveInpainting: true }}
        onInpaintingOpenChange={onInpaintingOpenChange}
      />
    );

    expect(screen.getByLabelText("1페이지 인페인팅 편집기")).toBeInTheDocument();
    expect(onInpaintingOpenChange).not.toHaveBeenCalledWith(false);

    rerender(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        currentPage={2}
        image={{ ...image, id: "page-image-2", pageNumber: 2 }}
        inpaintingOpen
        initialViewport={{ key: "project-a:environment-return:1", zoom: 1, preserveInpainting: true }}
        onInpaintingOpenChange={onInpaintingOpenChange}
      />
    );
    expect(onInpaintingOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText("2페이지 인페인팅 편집기")).toBeInTheDocument();
    rerender(
      <PageImagePanel {...baseProps} currentFilePath="C:\\projects\\Other.ctp" inpaintingOpen
        onInpaintingOpenChange={onInpaintingOpenChange} />
    );
    expect(onInpaintingOpenChange).toHaveBeenCalledWith(false);
  });

  it("caps Fit media at the image natural dimensions and disables native image dragging", () => {
    render(<PageImagePanel {...baseProps} />);
    const pageImage = screen.getByAltText("1페이지 이미지");
    Object.defineProperty(pageImage, "naturalWidth", { configurable: true, value: 600 });
    Object.defineProperty(pageImage, "naturalHeight", { configurable: true, value: 900 });
    fireEvent.load(pageImage);

    const media = pageImage.parentElement;
    expect(pageImage).toHaveAttribute("draggable", "false");
    expect(media).toHaveStyle({ "--image-natural-width": "600px", "--image-natural-height": "900px" });
    expect(styles).toContain("var(--image-natural-width)");
  });

  it("restores the initial workspace zoom once but still resets to Fit on a page switch", () => {
    const { rerender } = render(
      <PageImagePanel
        {...baseProps}
        initialViewport={{ key: "project-a", zoom: 1.75 }}
      />
    );

    expect(screen.getByText("175%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "100%" })).not.toHaveAttribute("aria-pressed", "true");

    rerender(
      <PageImagePanel
        {...baseProps}
        currentPage={2}
        image={{ ...image, id: "page-image-2", pageNumber: 2 }}
        initialViewport={{ key: "project-a", zoom: 1.75 }}
      />
    );
    expect(screen.getByRole("button", { name: /Fit|화면 맞춤/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("100%", { selector: ".page-image-zoom" })).toBeInTheDocument();
  });

  it("restores the complete viewport context when returning to the workspace", () => {
    render(
      <PageImagePanel
        {...baseProps}
        initialViewport={{
          key: "project-a:environment-return",
          viewMode: "actual",
          zoom: 1.75,
          pan: { x: 42, y: 18 },
          layers: {
            original: true,
            ocr: false,
            sourceText: true,
            translation: false,
            final: true
          }
        }}
      />
    );

    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("data-view-mode", "actual");
    expect(screen.getByText("175%", { selector: ".page-image-zoom" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OCR layer|OCR 레이어/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 42);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 18);
  });

  it("keeps the same viewport transform when the result layer changes", () => {
    const { rerender } = render(
      <PageImagePanel
        {...baseProps}
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "인페인팅 결과"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    const stage = screen.getByTestId("page-image-viewport");
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    fireEvent.click(screen.getByRole("button", { name: /Zoom in|확대/i }));
    fireEvent.click(screen.getByRole("button", { name: /OCR layer|OCR 레이어/i }));
    stage.scrollLeft = 71;
    stage.scrollTop = 43;
    fireEvent.scroll(stage);

    rerender(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "인페인팅 결과"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
    expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OCR layer|OCR 레이어/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("인페인팅 결과")).toBeInTheDocument();
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 71);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 43);
  });

  it("does not reuse a previous resolved URL while switching result layers", async () => {
    let resolveInpainted: ((src: string) => void) | undefined;
    const resolvePageImageSrc = vi.fn(({ storedRelativePath }: { storedRelativePath: string }) => {
      if (storedRelativePath === image.storedRelativePath) return Promise.resolve("resolved://original");
      return new Promise<string>((resolve) => {
        resolveInpainted = resolve;
      });
    });
    window.projectApi = { resolvePageImageSrc } as unknown as NonNullable<typeof window.projectApi>;

    const inpaintedImage = {
      ...image,
      id: "inpainted-1",
      storedRelativePath: "/review-assets/inpainted.png"
    };
    const resultLayers = {
      original: { layer: "original" as const, image, status: "ready" as const, message: "Original" },
      inpainted: {
        layer: "inpainted" as const,
        image: inpaintedImage,
        status: "ready" as const,
        message: "Inpainted"
      },
      translated: { layer: "translated" as const, image: null, status: "missing" as const, message: "Translated" }
    };

    const { rerender } = render(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        resultLayer="original"
        resultLayers={resultLayers}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("img")).toHaveAttribute("src", "resolved://original");

    rerender(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        resultLayer="inpainted"
        resultLayers={resultLayers}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(resolveInpainted).toBeTypeOf("function");
    expect(screen.getByRole("img")).not.toHaveAttribute("src", "resolved://original");

    await act(async () => {
      resolveInpainted?.("resolved://inpainted");
      await Promise.resolve();
    });
    expect(screen.getByRole("img")).toHaveAttribute("src", "resolved://inpainted");
    Reflect.deleteProperty(window, "projectApi");
  });

  it("shows result statuses and keeps original visible for an unavailable layer", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: { layer: "inpainted", image: null, status: "processing", message: "인페인팅 처리 중" },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Inpainted result|인페인팅 결과/i }));
    expect(screen.getByText("인페인팅 처리 중")).toBeInTheDocument();
    expect(screen.getByAltText("1페이지 이미지")).toBeInTheDocument();
  });

  it("falls back to the original and retries a failed result without resetting the viewport", () => {
    render(
      <PageImagePanel
        {...baseProps}
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: {
            layer: "inpainted",
            image: { ...image, id: "inpainted-1", storedRelativePath: "/review-assets/inpainted.png" },
            status: "ready",
            message: "인페인팅 결과"
          },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Width Fit|너비 맞춤/i }));
    const stage = screen.getByTestId("page-image-viewport");
    stage.scrollLeft = 55;
    stage.scrollTop = 24;
    fireEvent.scroll(stage);
    fireEvent.click(screen.getByRole("button", { name: /Inpainted result|인페인팅 결과/i }));

    const resultImage = screen.getByAltText("1페이지 이미지");
    expect(resultImage).toHaveAttribute("src", "/review-assets/inpainted.png");
    fireEvent.error(resultImage);

    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", "/review-assets/page-001.png");
    expect(screen.getByRole("button", { name: /인페인팅 결과 다시 시도|Retry inpainted result/i })).toBeInTheDocument();
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 55);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 24);

    fireEvent.load(screen.getByAltText("1페이지 이미지"));
    expect(screen.getByRole("button", { name: /인페인팅 결과 다시 시도|Retry inpainted result/i })).toBeInTheDocument();
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 55);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 24);

    fireEvent.click(screen.getByRole("button", { name: /인페인팅 결과 다시 시도|Retry inpainted result/i }));
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", "/review-assets/inpainted.png");
  });

  it("clears a failed result identity when a replacement arrives without resetting the viewport context", () => {
    const resultA = {
      ...image,
      id: "inpainted-a",
      storedRelativePath: "/review-assets/inpainted-a.png"
    };
    const resultB = {
      ...image,
      id: "inpainted-b",
      storedRelativePath: "/review-assets/inpainted-b.png"
    };
    const createResultLayers = (inpaintedImage: PageImage) => ({
      original: { layer: "original" as const, image, status: "ready" as const, message: "Original" },
      inpainted: {
        layer: "inpainted" as const,
        image: inpaintedImage,
        status: "ready" as const,
        message: "Inpainted"
      },
      translated: { layer: "translated" as const, image: null, status: "missing" as const, message: "Translated" }
    });

    const { rerender } = render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        activeOcrBbox={{ x: 0.1, y: 0.2, width: 0.3, height: 0.12 }}
        resultLayers={createResultLayers(resultA)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    fireEvent.click(screen.getByRole("button", { name: /Zoom in|확대/i }));
    const stage = screen.getByTestId("page-image-viewport");
    stage.scrollLeft = 91;
    stage.scrollTop = 73;
    fireEvent.scroll(stage);

    const resultImage = screen.getByAltText("1페이지 이미지");
    expect(resultImage).toHaveAttribute("src", "/review-assets/inpainted-a.png");
    fireEvent.error(resultImage);
    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", "/review-assets/page-001.png");
    expect(screen.getByRole("button", { name: /인페인팅 결과 다시 시도|Retry inpainted result/i })).toBeInTheDocument();

    rerender(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        activeOcrBbox={{ x: 0.1, y: 0.2, width: 0.3, height: 0.12 }}
        resultLayers={createResultLayers(resultB)}
      />
    );

    expect(screen.getByAltText("1페이지 이미지")).toHaveAttribute("src", "/review-assets/inpainted-b.png");
    expect(screen.queryByRole("button", { name: /Retry inpainted result|인페인팅 결과 다시 시도/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Inpainted result|인페인팅 결과/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /OCR layer|OCR 레이어/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "actual");
    expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument();
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollLeft", 91);
    expect(screen.getByTestId("page-image-viewport")).toHaveProperty("scrollTop", 73);
  });

  it("does not reuse an old editor source URL while a same-page replacement resolves", async () => {
    const sourceA = {
      ...image,
      id: "editor-source-a",
      storedRelativePath: "/review-assets/editor-source-a.png"
    };
    const sourceB = {
      ...image,
      id: "editor-source-b",
      storedRelativePath: "/review-assets/editor-source-b.png"
    };
    const resolveReplacement: Array<(src: string) => void> = [];
    const resolvePageImageSrc = vi.fn(({ storedRelativePath }: { storedRelativePath: string }) => {
      if (storedRelativePath === sourceA.storedRelativePath) return Promise.resolve("resolved://editor-source-a");
      if (storedRelativePath === sourceB.storedRelativePath) {
        return new Promise<string>((resolve) => {
          resolveReplacement.push(resolve);
        });
      }
      return Promise.resolve(storedRelativePath);
    });
    window.projectApi = { resolvePageImageSrc } as unknown as NonNullable<typeof window.projectApi>;

    const { rerender } = render(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        image={sourceA}
        inpaintingOpen
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getAllByRole("img")[1]).toHaveAttribute("src", "resolved://editor-source-a");

    rerender(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        image={sourceB}
        inpaintingOpen
      />
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByRole("img")[1]).not.toHaveAttribute("src", "resolved://editor-source-a");
    expect(screen.getAllByRole("img")[1]).toHaveAttribute("src", sourceB.storedRelativePath);

    await act(async () => {
      for (const resolve of resolveReplacement) resolve("resolved://editor-source-b");
      await Promise.resolve();
    });
    expect(screen.getAllByRole("img")[1]).toHaveAttribute("src", "resolved://editor-source-b");
    Reflect.deleteProperty(window, "projectApi");
  });

  it("uses the active result image as the inpainting editor source", () => {
    const inpaintedImage = {
      ...image,
      id: "inpainted-1",
      storedRelativePath: "/review-assets/inpainted.png",
      originalFileName: "inpainted.png"
    };

    render(
      <PageImagePanel
        {...baseProps}
        image={inpaintedImage}
        resultLayer="inpainted"
        resultLayers={{
          original: { layer: "original", image, status: "ready", message: "원본" },
          inpainted: { layer: "inpainted", image: inpaintedImage, status: "ready", message: "인페인팅 결과" },
          translated: { layer: "translated", image: null, status: "missing", message: "번역 결과가 생성되지 않았습니다." }
        }}
        inpaintingOpen
      />
    );

    expect(screen.getByAltText("1페이지 인페인팅 대상")).toHaveAttribute(
      "src",
      "/review-assets/inpainted.png"
    );
  });

  it("exposes a visible next step and disables OCR while its capability is blocked", () => {
    render(
      <PageImagePanel
        {...baseProps}
        currentFilePath="C:\\projects\\Book.ctp"
        ocrDisabledReason="PaddleOCR 리소스를 준비하려면 환경 준비에서 설치를 완료하세요."
      />
    );

    expect(screen.queryByTestId("page-image-ocr-disabled-reason")).not.toBeInTheDocument();
    fireEvent.error(screen.getByAltText("1페이지 이미지"));
    const retry = screen.getByRole("button", { name: "OCR 다시 실행" });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-describedby", "page-image-ocr-disabled-reason");
    expect(screen.getByText(/환경 준비에서 OCR 상태를 확인하세요.*환경 준비에서 설치를 완료하세요./)).toBeInTheDocument();
  });

  it("uses the controlled image fit and reports user changes", () => {
    const onImageFitChange = vi.fn();
    const { rerender } = render(
      <PageImagePanel {...baseProps} imageFit="actual" onImageFitChange={onImageFitChange} />
    );

    expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /화면 맞춤|Fit/i }));
    expect(onImageFitChange).toHaveBeenCalledWith("fit");

    rerender(<PageImagePanel {...baseProps} imageFit="fit" onImageFitChange={onImageFitChange} />);
    expect(screen.getByRole("button", { name: /화면 맞춤|Fit/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders a normalized OCR bounding box over the page image", () => {
    render(
      <PageImagePanel
        {...baseProps}
        activeOcrBbox={{ x: 0.1, y: 0.2, width: 0.3, height: 0.12 }}
        stageHint="OCR 후보 #1"
      />
    );

    const overlay = screen.getByLabelText("선택된 OCR 영역");
    expect(overlay).toHaveStyle({ left: "10%", top: "20%", width: "30%", height: "12%" });
    expect(screen.getByText("OCR 후보 #1")).toBeInTheDocument();
  });

  it("omits the overlay when no OCR item is active", () => {
    render(<PageImagePanel {...baseProps} activeOcrBbox={null} />);
    expect(screen.queryByLabelText("선택된 OCR 영역")).not.toBeInTheDocument();
  });

  it("renders semantic overlay legend and quick toggles for every kind", () => {
    const semanticOverlays = [
      "ocr",
      "balloon",
      "safe-area",
      "typeset",
      "inpainting-mask",
      "preserve",
      "issue"
    ].map((kind) => ({
      id: `${kind}-1`,
      kind: kind as "ocr" | "balloon" | "safe-area" | "typeset" | "inpainting-mask" | "preserve" | "issue",
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.12 }
    }));

    render(<PageImagePanel {...baseProps} semanticOverlays={semanticOverlays} />);

    expect(screen.getByText("오버레이 범례")).toBeInTheDocument();
    for (const kind of ["ocr", "balloon", "safe-area", "typeset", "inpainting-mask", "preserve", "issue"]) {
      expect(screen.getByRole("button", { name: kind === "inpainting-mask" ? /inpainting-mask overlay/ : new RegExp(`${kind} 오버레이`) })).toHaveAttribute("aria-pressed", "true");
    }
    expect(screen.getByTestId("semantic-overlay-ocr-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /ocr 오버레이/i }));
    expect(screen.queryByTestId("semantic-overlay-ocr-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("semantic-overlay-legend").parentElement).not.toBe(screen.getByTestId("page-image-media"));
  });

  it("keeps the active OCR descriptor when other OCR descriptors are present", () => {
    render(
      <PageImagePanel
        {...baseProps}
        activeOcrBbox={{ x: 0.6, y: 0.65, width: 0.2, height: 0.1 }}
        stageHint="OCR 후보 #2"
        semanticOverlays={[{
          id: "ocr-other",
          kind: "ocr",
          bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          label: "OCR 후보 #1"
        }]}
      />
    );

    expect(screen.getByLabelText("선택된 OCR 영역")).toHaveTextContent("OCR 후보 #2");
    expect(screen.getByLabelText("선택된 OCR 영역")).toHaveStyle({ left: "60%", top: "65%" });
    expect(screen.getByTestId("semantic-overlay-layer").querySelectorAll('[data-overlay-kind="ocr"]')).toHaveLength(2);
  });

  it("keeps OCR overlays in image coordinates above every comparison surface without changing viewport or result", () => {
    const semanticOverlays = [
      {
        id: "ocr-1",
        kind: "ocr" as const,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.12 },
        selected: true
      }
    ];
    render(
      <PageImagePanel
        {...baseProps}
        resultLayer="inpainted"
        resultLayers={comparisonResultLayers}
        semanticOverlays={semanticOverlays}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Zoom in|확대/i }));
    fireEvent.click(screen.getByRole("button", { name: /Reveal comparison|슬라이더 비교/i }));
    fireEvent.click(screen.getByRole("button", { name: /ocr 오버레이/i }));
    fireEvent.click(screen.getByRole("button", { name: /ocr 오버레이/i }));

    const layer = screen.getByTestId("semantic-overlay-layer");
    expect(layer.parentElement).toBe(screen.getByTestId("page-image-media"));
    expect(layer).toHaveAttribute("data-coordinate-space", "image");
    expect(screen.getByRole("button", { name: /Inpainted result|인페인팅 결과/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Reveal comparison|슬라이더 비교/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("125%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /OCR layer|OCR 레이어/i }));
    expect(screen.queryByTestId("semantic-overlay-ocr-1")).not.toBeInTheDocument();
  });

  it("supports a speech balloon descriptor when present and keeps the legend usable when absent", () => {
    const { rerender } = render(
      <PageImagePanel
        {...baseProps}
        semanticOverlays={[{
          id: "balloon-1",
          kind: "balloon",
          bbox: { x: 0.2, y: 0.25, width: 0.4, height: 0.2 },
          label: "말풍선 컨테이너"
        }]}
      />
    );
    expect(screen.getByTestId("semantic-overlay-balloon-1")).toBeInTheDocument();
    expect(screen.getByTestId("semantic-overlay-balloon-1")).toHaveTextContent("말풍선 컨테이너");

    rerender(<PageImagePanel {...baseProps} semanticOverlays={[]} />);
    expect(screen.queryByTestId("semantic-overlay-balloon-1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /balloon/i })).toBeInTheDocument();
  });

  it("renders a direct typesetting editor independently of the immutable OCR overlay", () => {
    const onTypesettingDraftChange = vi.fn();
    const ocrBbox = { x: 0.2, y: 0.25, width: 0.3, height: 0.12 };
    const typesettingDraft = {
      id: "draft-1",
      sourceOcrId: "ocr-1",
      bbox: ocrBbox,
      rotationDegrees: 0,
      writingMode: "horizontal-tb" as const
    };
    render(
      <PageImagePanel
        {...baseProps}
        activeOcrBbox={ocrBbox}
        typesettingDraft={typesettingDraft}
        typesettingSafeArea={{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }}
        onTypesettingDraftChange={onTypesettingDraftChange}
      />
    );

    expect(screen.getByTestId("typesetting-box-editor")).toHaveStyle({ left: "20%", top: "25%" });
    expect(screen.getByRole("img", { name: "선택된 OCR 영역" })).toHaveStyle({ left: "20%", top: "25%", width: "30%", height: "12%" });
    fireEvent.keyDown(screen.getByRole("button", { name: "식자 상자 이동" }), { key: "ArrowRight" });
    expect(onTypesettingDraftChange).toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "선택된 OCR 영역" })).toHaveStyle({ left: "20%", top: "25%", width: "30%", height: "12%" });
  });

  it("disables only precision editing in a sub-1024 viewport while retaining the OCR overlay", () => {
    const onTypesettingDraftChange = vi.fn();
    const ocrBbox = { x: 0.2, y: 0.25, width: 0.3, height: 0.12 };
    render(
      <PageImagePanel
        {...baseProps}
        activeOcrBbox={ocrBbox}
        typesettingDraft={{
          id: "draft-precision-limited",
          sourceOcrId: "ocr-precision-limited",
          bbox: ocrBbox,
          rotationDegrees: 0,
          writingMode: "horizontal-tb"
        }}
        typesettingSafeArea={{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }}
        precisionEditingDisabled
        onTypesettingDraftChange={onTypesettingDraftChange}
      />
    );

    expect(screen.getByTestId("typesetting-box-editor")).toHaveClass("is-disabled");
    expect(screen.getByRole("button", { name: "식자 상자 이동" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "식자 상자 남동쪽 크기 조절" })).toBeDisabled();
    expect(screen.getByRole("img", { name: "선택된 OCR 영역" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "식자 상자 이동" }), { key: "ArrowRight" });
    expect(onTypesettingDraftChange).not.toHaveBeenCalled();
  });

  it("zooms in, zooms out, and resets view with +, -, 0 keyboard shortcuts on viewport", () => {
    render(<PageImagePanel {...baseProps} />);
    const viewport = screen.getByTestId("page-image-viewport");

    expect(screen.getByText("100%", { selector: ".page-image-zoom" })).toBeInTheDocument();

    fireEvent.keyDown(viewport, { key: "+" });
    expect(screen.getByText("125%", { selector: ".page-image-zoom" })).toBeInTheDocument();

    fireEvent.keyDown(viewport, { key: "-" });
    expect(screen.getByText("100%", { selector: ".page-image-zoom" })).toBeInTheDocument();

    fireEvent.keyDown(viewport, { key: "0" });
    expect(screen.getByTestId("page-image-viewport")).toHaveAttribute("data-view-mode", "fit");
  });
});
