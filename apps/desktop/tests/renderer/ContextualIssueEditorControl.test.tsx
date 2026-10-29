import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextualIssueEditorControl } from "../../src/renderer/components/ContextualIssueEditorControl";

describe("ContextualIssueEditorControl", () => {
  it("exposes a pin control and a non-blocking CTA for a pinned mismatch", () => {
    const onTogglePin = vi.fn();
    const onSwitchToRequired = vi.fn();
    render(
      <ContextualIssueEditorControl
        state={{ activeEditor: "translation", pinned: true, requiredEditor: "speaker" }}
        onTogglePin={onTogglePin}
        onSwitchToRequired={onSwitchToRequired}
      />
    );
    expect(screen.getByTestId("contextual-issue-editor-control")).toHaveAttribute("data-active-editor", "translation");
    expect(screen.getByRole("button", { name: /pin/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveAttribute("data-editor-mismatch", "true");
    fireEvent.click(screen.getByRole("button", { name: "필요한 화자 편집기 열기" }));
    expect(onSwitchToRequired).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /pin/i }));
    expect(onTogglePin).toHaveBeenCalledOnce();
  });
});
