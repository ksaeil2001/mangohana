import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAutoUpdateState } from "../../src/shared/autoUpdateStatus";
import { AutoUpdateStatusControl } from "../../src/renderer/components/AutoUpdateStatusControl";

describe("AutoUpdateStatusControl", () => {
  it("shows a retry action after an update check failure", () => {
    const onCheck = vi.fn();
    render(
      <AutoUpdateStatusControl
        state={createAutoUpdateState("error", { message: "업데이트를 확인하지 못했습니다." })}
        hasUnsavedChanges={false}
        onCheck={onCheck}
        onDownload={vi.fn()}
        onInstall={vi.fn()}
        onOpenRelease={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "업데이트 확인" }));
    expect(onCheck).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "릴리스 보기" })).toBeEnabled();
    expect(screen.getByText("업데이트를 확인하지 못했습니다.")).toBeVisible();
    expect(screen.getByText("업데이트를 확인하지 못했습니다.")).toHaveClass("auto-update-status-message");
  });

  it("exposes download progress and protects unsaved work before installation", () => {
    render(
      <AutoUpdateStatusControl
        state={createAutoUpdateState("ready-to-install", {
          availableVersion: "0.1.3",
          message: "Trio 0.1.3 업데이트를 설치할 준비가 되었습니다."
        })}
        hasUnsavedChanges
        onCheck={vi.fn()}
        onDownload={vi.fn()}
        onInstall={vi.fn()}
        onOpenRelease={vi.fn()}
      />
    );

    const install = screen.getByRole("button", { name: "저장 후 재시작" });
    expect(install).toBeDisabled();
    expect(install).toHaveAttribute("aria-describedby", "auto-update-save-note");
    expect(screen.getByText(/저장하지 않은 변경사항/i)).toBeInTheDocument();
  });
});
