import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TypesettingBoxEditor } from "../../src/renderer/components/TypesettingBoxEditor";
import type { TypesettingDraft } from "../../src/renderer/typesettingGeometry";

const draft: TypesettingDraft = {
  id: "draft-1",
  sourceOcrId: "ocr-1",
  bbox: { x: 0.2, y: 0.25, width: 0.3, height: 0.12 },
  rotationDegrees: 0,
  writingMode: "horizontal-tb"
};
const safeArea = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

describe("TypesettingBoxEditor", () => {
  it("places shape tools outside the transformed box in the viewport panel", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const { container } = render(<section className="page-image-panel"><div className="page-image-toolbar" /><div className="page-image-stage"><div className="page-image-media"><TypesettingBoxEditor draft={draft} onChange={vi.fn()} /></div></div></section>);
    expect(screen.getByRole("toolbar", { name: "말풍선 형태 및 쓰기 방향 선택" }).parentElement).toBe(container.querySelector(".page-image-panel"));
    expect(screen.getByTestId("typesetting-box-editor")).toHaveStyle({ left: "20%", top: "25%" });
    vi.unstubAllGlobals();
  });

  it("renders a horizontal box and accessible move/resize/rotate handles without owning viewport transforms", () => {
    const { container } = render(<TypesettingBoxEditor draft={draft} safeArea={safeArea} onChange={vi.fn()} />);
    const editor = screen.getByTestId("typesetting-box-editor");
    const body = screen.getByRole("button", { name: "식자 상자 이동" });
    expect(editor).toHaveAttribute("data-coordinate-space", "image");
    expect(editor).toHaveAttribute("data-writing-mode", "horizontal-tb");
    expect(editor).toHaveStyle({ left: "20%", top: "25%", width: "30%", height: "12%" });
    expect(editor).toHaveTextContent("한국어 가로쓰기");
    expect(screen.getByRole("button", { name: "식자 상자 북서쪽 크기 조절" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "식자 상자 남동쪽 크기 조절" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "식자 상자 회전" })).toBeInTheDocument();
    expect(editor).not.toHaveAttribute("data-zoom");
    expect(editor).not.toHaveAttribute("data-pan");
    expect(container.querySelector("[data-testid='typesetting-box-editor']")?.className).toContain("typesetting-box-editor");
  });

  it("moves with image-coordinate deltas from the live media rect and releases pointer capture on cancel/blur", () => {
    const onChange = vi.fn();
    const { container } = render(<div data-testid="page-image-media" className="page-image-media"><TypesettingBoxEditor draft={draft} safeArea={safeArea} onChange={onChange} /></div>);
    const media = screen.getByTestId("page-image-media");
    Object.defineProperty(media, "getBoundingClientRect", { configurable: true, value: () => ({ left: 100, top: 50, width: 400, height: 500, right: 500, bottom: 550 }) });
    const editor = screen.getByTestId("typesetting-box-editor");
    const body = screen.getByRole("button", { name: "식자 상자 이동" });
    Object.defineProperty(editor, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(editor, "releasePointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(body, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 240, clientY: 250 });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)?.[0] as TypesettingDraft;
    expect(next.bbox.x).toBeGreaterThan(draft.bbox.x);
    expect(next.bbox.y).toBeGreaterThan(draft.bbox.y);
    fireEvent.pointerCancel(editor, { pointerId: 1 });
    fireEvent.blur(window);
    expect(container.querySelector("[data-dragging='true']")).toBeNull();
  });

  it("keeps percentage handles aligned when the media rect changes with zoom and pan", () => {
    const { rerender } = render(
      <div data-testid="page-image-media" className="page-image-media">
        <TypesettingBoxEditor draft={draft} safeArea={safeArea} onChange={vi.fn()} />
      </div>
    );
    const media = screen.getByTestId("page-image-media");
    const editor = screen.getByTestId("typesetting-box-editor");
    Object.defineProperty(media, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 400, height: 500, right: 400, bottom: 500 })
    });
    expect(editor).toHaveStyle({ left: "20%", top: "25%", width: "30%", height: "12%" });
    expect(screen.getByRole("button", { name: "식자 상자 북서쪽 크기 조절" }).closest("[data-testid='page-image-media']")).toBe(media);
    Object.defineProperty(media, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: -120, top: -80, width: 800, height: 1000, right: 680, bottom: 920 })
    });
    rerender(
      <div data-testid="page-image-media" className="page-image-media">
        <TypesettingBoxEditor draft={draft} safeArea={safeArea} onChange={vi.fn()} />
      </div>
    );
    expect(screen.getByTestId("typesetting-box-editor")).toHaveStyle({ left: "20%", top: "25%", width: "30%", height: "12%" });
    expect(screen.getByRole("button", { name: "식자 상자 남동쪽 크기 조절" }).closest("[data-testid='page-image-media']")).toBe(media);
  });

  it("supports keyboard move and resize while leaving the OCR source bbox untouched", () => {
    const onChange = vi.fn();
    render(<TypesettingBoxEditor draft={draft} safeArea={safeArea} onChange={onChange} />);
    const body = screen.getByRole("button", { name: "식자 상자 이동" });
    fireEvent.keyDown(body, { key: "ArrowRight" });
    const moved = onChange.mock.calls.at(-1)?.[0] as TypesettingDraft;
    expect(moved.bbox.x).toBeGreaterThan(draft.bbox.x);
    const handle = screen.getByRole("button", { name: "식자 상자 남동쪽 크기 조절" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect((onChange.mock.calls.at(-1)?.[0] as TypesettingDraft).bbox.width).toBeGreaterThan(draft.bbox.width);
    expect(draft.bbox).toEqual({ x: 0.2, y: 0.25, width: 0.3, height: 0.12 });
  });

  it("renders shape selection buttons and triggers onChange with new shape", () => {
    const onChange = vi.fn();
    render(<TypesettingBoxEditor draft={draft} safeArea={safeArea} onChange={onChange} />);
    const cloudBtn = screen.getByRole("button", { name: "생각/독백 구름" });
    expect(cloudBtn).toBeInTheDocument();
    fireEvent.click(cloudBtn);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shape: "cloud" }));
  });

  it("renders live wrapped text lines when previewText is provided", () => {
    render(
      <TypesettingBoxEditor
        draft={{ ...draft, shape: "ellipse" }}
        safeArea={safeArea}
        previewText="정말 그렇게 생각하는 거야? 믿을 수 없어!"
        onChange={vi.fn()}
      />
    );
    const editor = screen.getByTestId("typesetting-box-editor");
    expect(editor).toHaveAttribute("data-bubble-shape", "ellipse");
    expect(screen.getByText(/정말 그렇게/)).toBeInTheDocument();
  });

  it("switches shapes via number keys 1, 2, 3, 4", () => {
    const onChange = vi.fn();
    render(<TypesettingBoxEditor draft={draft} safeArea={safeArea} onChange={onChange} />);
    const body = screen.getByRole("button", { name: "식자 상자 이동" });

    fireEvent.keyDown(body, { key: "1" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shape: "ellipse" }));

    fireEvent.keyDown(body, { key: "2" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shape: "rectangle" }));

    fireEvent.keyDown(body, { key: "3" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shape: "cloud" }));

    fireEvent.keyDown(body, { key: "4" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ shape: "spiky" }));
  });

  it("toggles writingMode when clicking the writingMode button in toolbar", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TypesettingBoxEditor draft={draft} safeArea={safeArea} onChange={onChange} />);

    const toggleBtn = screen.getByRole("button", { name: "세로쓰기로 전환" });
    expect(toggleBtn).toBeInTheDocument();
    fireEvent.click(toggleBtn);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ writingMode: "vertical-rl" }));

    rerender(
      <TypesettingBoxEditor
        draft={{ ...draft, writingMode: "vertical-rl" }}
        safeArea={safeArea}
        onChange={onChange}
      />
    );
    expect(screen.getByText("한국어 세로쓰기")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "가로쓰기로 전환" })).toBeInTheDocument();
  });

  it("applies vertical-rl writingMode styling to preview lines in vertical writing mode", () => {
    const { container } = render(
      <TypesettingBoxEditor
        draft={{ ...draft, writingMode: "vertical-rl", shape: "ellipse" }}
        safeArea={safeArea}
        previewText="세로쓰기 테스트입니다."
        onChange={vi.fn()}
      />
    );

    const previewLines = container.querySelector(".typesetting-preview-lines");
    expect(previewLines).toHaveStyle({ writingMode: "vertical-rl" });
  });
});
