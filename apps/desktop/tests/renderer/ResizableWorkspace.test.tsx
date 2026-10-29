import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ResizableWorkspace } from "../../src/renderer/components/ResizableWorkspace";

function renderWorkspace(editorWidth = 432) {
  const onChange = vi.fn();
  render(
    <ResizableWorkspace
      editorWidth={editorWidth}
      onEditorWidthChange={onChange}
      canvas={<span>canvas</span>}
      editor={<span>editor</span>}
    />
  );
  return { onChange, separator: screen.getByRole("separator") };
}

describe("ResizableWorkspace", () => {
  it("preserves an unfinished editor draft when the user closes and reopens the editor", () => {
    const props = {
      editorWidth: 432,
      onEditorWidthChange: vi.fn(),
      canvas: <span>canvas</span>,
      editor: <textarea aria-label="OCR 초안" defaultValue="인식 결과" />
    };
    const { rerender } = render(<ResizableWorkspace {...props} editorOpen />);
    const draft = screen.getByRole("textbox", { name: "OCR 초안" });
    fireEvent.change(draft, { target: { value: "사용자가 수정한 원문" } });
    draft.focus();

    rerender(<ResizableWorkspace {...props} editorOpen={false} />);

    expect(screen.queryByRole("textbox", { name: "OCR 초안" })).not.toBeInTheDocument();
    expect(draft.closest("aside")).toHaveAttribute("hidden");
    expect(draft.closest("aside")).toHaveAttribute("inert");
    expect(screen.getByRole("main")).toHaveFocus();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();

    rerender(<ResizableWorkspace {...props} editorOpen />);

    expect(screen.getByRole("textbox", { name: "OCR 초안" })).toBe(draft);
    expect(draft).toHaveValue("사용자가 수정한 원문");
  });

  it("releases the inspector width and resize handle when the inspector is closed", () => {
    render(
      <ResizableWorkspace
        editorWidth={432}
        onEditorWidthChange={vi.fn()}
        canvas={<span>canvas</span>}
        editor={<span>editor</span>}
        editorOpen={false}
      />
    );

    expect(screen.getByTestId("resizable-workspace")).toHaveClass("inspector-collapsed");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.queryByText("editor")).not.toBeInTheDocument();
    expect(screen.getByText("canvas")).toBeInTheDocument();
  });

  it("hides and inerts the open editor without remounting it or leaving focus and resize active", () => {
    const onChange = vi.fn();
    const props = {
      editorWidth: 432,
      onEditorWidthChange: onChange,
      canvas: <input aria-label="캔버스 상태" defaultValue="확대 150%" />,
      editor: <input aria-label="편집기 초안" defaultValue="사용자 번역" />
    };
    const { rerender } = render(<ResizableWorkspace {...props} />);
    const canvas = screen.getByRole("textbox", { name: "캔버스 상태" });
    const draft = screen.getByRole("textbox", { name: "편집기 초안" });
    const separator = screen.getByRole("separator");
    const capture = vi.fn();
    const releaseCapture = vi.fn();
    Object.defineProperty(separator, "setPointerCapture", { value: capture });
    Object.defineProperty(separator, "hasPointerCapture", { value: vi.fn().mockReturnValue(true) });
    Object.defineProperty(separator, "releasePointerCapture", { value: releaseCapture });
    vi.spyOn(screen.getByTestId("resizable-workspace"), "getBoundingClientRect").mockReturnValue({ right: 1000 } as DOMRect);
    fireEvent.pointerDown(separator, { pointerId: 7, clientX: 600 });
    onChange.mockClear();
    draft.focus();

    rerender(<ResizableWorkspace {...props} editorHidden />);

    expect(screen.getByTestId("resizable-workspace")).toHaveClass("inspector-collapsed");
    expect(draft.closest("aside")).toHaveAttribute("hidden");
    expect(draft.closest("aside")).toHaveAttribute("inert");
    expect(draft).not.toBeVisible();
    expect(screen.getByRole("main")).toHaveFocus();
    expect(separator).toHaveAttribute("tabindex", "-1");
    expect(separator).toHaveAttribute("hidden");
    expect(separator).toHaveAttribute("inert");
    expect(releaseCapture).toHaveBeenCalledWith(7);
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 900 });
    fireEvent.pointerDown(separator, { pointerId: 8, clientX: 700 });
    expect(onChange).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);

    rerender(<ResizableWorkspace {...props} />);

    expect(screen.getByRole("textbox", { name: "캔버스 상태" })).toBe(canvas);
    expect(screen.getByRole("textbox", { name: "편집기 초안" })).toBe(draft);
    expect(draft).toHaveValue("사용자 번역");
    expect(screen.getByRole("separator")).toBe(separator);
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 800 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(416);
  });

  it("keeps a closed editor unmounted when temporarily hidden", () => {
    render(
      <ResizableWorkspace
        editorWidth={320}
        onEditorWidthChange={vi.fn()}
        canvas={<span>canvas</span>}
        editor={<span>editor</span>}
        editorOpen={false}
        editorHidden
      />
    );

    expect(screen.queryByText("editor")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText("canvas")).toBeVisible();
  });

  it("releases hidden editor tracks even when legacy stage CSS gives the editor a display and grid track", () => {
    const style = document.createElement("style");
    style.textContent = `
      .focus-deck-shell[data-workspace-stage="translation"] .focus-deck-editor { display: flex; }
      .focus-deck-shell .focus-deck-workspace .resizable-workspace { grid-template-columns: 1fr 8px 432px; }
      ${readFileSync("src/renderer/stitch-workbench.css", "utf8")}
    `;
    document.head.append(style);
    try {
      render(
        <div className="focus-deck-shell stitch-workbench" data-workspace-stage="translation" data-layout-tier="compact">
          <div className="focus-deck-workspace">
            <ResizableWorkspace
              editorWidth={432}
              onEditorWidthChange={vi.fn()}
              canvas={<span>canvas</span>}
              editor={<span>editor</span>}
              editorHidden
            />
          </div>
        </div>
      );

      const editor = screen.getByText("editor").closest("aside")!;
      const workspace = screen.getByTestId("resizable-workspace");
      expect(getComputedStyle(editor).display).toBe("none");
      expect(getComputedStyle(workspace).gridTemplateColumns).toBe("minmax(0, 1fr)");
    } finally {
      style.remove();
    }
  });

  it("resizes by 16px with arrow keys and 48px with Shift", () => {
    const { onChange, separator } = renderWorkspace();
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(448);
    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(384);
  });

  it("clamps keyboard changes and exposes the clamped value", () => {
    const { onChange, separator } = renderWorkspace(999);
    expect(separator).toHaveAttribute("aria-valuemin", "320");
    expect(separator).toHaveAttribute("aria-valuemax", "520");
    expect(separator).toHaveAttribute("aria-valuenow", "520");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(520);
  });

  it("uses the container right edge for pointer dragging and clamps callbacks", () => {
    const { onChange, separator } = renderWorkspace();
    const workspace = screen.getByTestId("resizable-workspace");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({ right: 1000 } as DOMRect);
    Object.defineProperty(separator, "setPointerCapture", { value: vi.fn() });

    fireEvent.pointerDown(separator, { pointerId: 7, clientX: 600 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 900 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 100 });

    expect(separator.setPointerCapture).toHaveBeenCalledWith(7);
    expect(onChange).toHaveBeenNthCalledWith(1, 400);
    expect(onChange).toHaveBeenNthCalledWith(2, 320);
    expect(onChange).toHaveBeenNthCalledWith(3, 520);
  });
});
