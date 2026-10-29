import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, ModalSurface } from "../../src/renderer/components/Ui";

function DialogExample() {
  const [open, setOpen] = useState(false);
  return <>
    <Button onClick={() => setOpen(true)}>인물 추가</Button>
    {open && <ModalSurface aria-label="인물 편집">
      <input aria-label="한국어 이름" />
      <Button onClick={() => setOpen(false)}>취소</Button>
    </ModalSurface>}
  </>;
}

describe("shared dialog keyboard behavior", () => {
  it("contains Tab navigation and restores the opening control after closing", () => {
    render(<DialogExample />);
    const opener = screen.getByRole("button", { name: "인물 추가" });
    opener.focus();
    fireEvent.click(opener);
    const field = screen.getByRole("textbox", { name: "한국어 이름" });
    const close = screen.getByRole("button", { name: "취소" });
    expect(screen.getByRole("dialog", { name: "인물 편집" })).toHaveClass("stitch-dialog");
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(field).toHaveFocus();
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
