import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDialogProvider, useAppDialogs } from "../../src/renderer/components/AppDialogs";

afterEach(cleanup);

function Harness({ resolved }: { resolved: (value: unknown) => void }) {
  const dialogs = useAppDialogs();
  return <>
    <button onClick={async () => resolved(await dialogs.confirm({ title: "대사 삭제", message: "선택한 대사를 삭제합니다.", danger: true }))}>삭제 열기</button>
    <button onClick={async () => resolved(await dialogs.prompt({ title: "프로젝트 열기", message: "암호를 입력하세요.", password: true, fieldLabel: "프로젝트 암호" }))}>암호 열기</button>
  </>;
}

describe("AppDialogs", () => {
  it("defaults to cancel, makes the background inert, and restores the invoker", async () => {
    const resolved = vi.fn();
    render(<AppDialogProvider><Harness resolved={resolved} /></AppDialogProvider>);
    const invoker = screen.getByRole("button", { name: "삭제 열기" });
    invoker.focus();
    fireEvent.click(invoker);
    const dialog = screen.getByRole("alertdialog", { name: "대사 삭제" });
    expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus();
    expect(invoker.closest("[inert]")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(resolved).toHaveBeenCalledWith(false));
    expect(invoker).toHaveFocus();
    expect(invoker.closest("[inert]")).toBeNull();
  });

  it("does not replace an existing request when another action is dispatched", async () => {
    const resolved = vi.fn();
    render(<AppDialogProvider><Harness resolved={resolved} /></AppDialogProvider>);
    fireEvent.click(screen.getByRole("button", { name: "삭제 열기" }));
    // Programmatic dispatch represents a duplicate shortcut/action; real pointer input is inert.
    fireEvent.click(screen.getByRole("button", { name: "암호 열기" }));
    await waitFor(() => expect(resolved).toHaveBeenCalledWith(null));
    expect(screen.getByRole("alertdialog", { name: "대사 삭제" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    await waitFor(() => expect(resolved).toHaveBeenLastCalledWith(true));
  });

  it("keeps the password masked, requires a value and submits only an explicit action", async () => {
    const resolved = vi.fn();
    render(<AppDialogProvider><Harness resolved={resolved} /></AppDialogProvider>);
    fireEvent.click(screen.getByRole("button", { name: "암호 열기" }));
    const input = screen.getByLabelText("프로젝트 암호");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "확인" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "fixture-only" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.submit(input.closest("form")!);
    expect(resolved).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    await waitFor(() => expect(resolved).toHaveBeenCalledWith("fixture-only"));
    expect(screen.queryByLabelText("프로젝트 암호")).not.toBeInTheDocument();
  });

  it("consumes Escape before background document shortcuts can close another surface", async () => {
    const resolved = vi.fn();
    const backgroundShortcut = vi.fn();
    document.addEventListener("keydown", backgroundShortcut);
    try {
      render(<AppDialogProvider><Harness resolved={resolved} /></AppDialogProvider>);
      fireEvent.click(screen.getByRole("button", { name: "암호 열기" }));
      fireEvent.keyDown(screen.getByLabelText("프로젝트 암호"), { key: "Escape" });
      await waitFor(() => expect(resolved).toHaveBeenCalledWith(null));
      expect(backgroundShortcut).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", backgroundShortcut);
    }
  });

  it("contains Tab focus and resolves pending requests as canceled on unmount", async () => {
    const resolved = vi.fn();
    const view = render(<AppDialogProvider><Harness resolved={resolved} /></AppDialogProvider>);
    fireEvent.click(screen.getByRole("button", { name: "삭제 열기" }));
    const confirm = screen.getByRole("button", { name: "확인" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(screen.getByRole("button", { name: "대화상자 닫기" })).toHaveFocus();
    await act(async () => view.unmount());
    expect(resolved).toHaveBeenCalledWith(false);
  });
});
