import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DialogueLine } from "../../src/shared/projectTypes";
import { IssueLinePanel, type IssueLineItem } from "../../src/renderer/components/IssueLinePanel";

function issue(id: string, order: number): IssueLineItem {
  const line: DialogueLine = {
    id,
    order,
    pageNumber: 1,
    speaker: "unknown",
    dialogueType: "speech",
    sourceLanguage: "en",
    sourceText: id,
    lineStatus: "review",
    parseConfidence: 0.5,
    parseWarnings: []
  };
  return { line, reasons: ["검토필요"] };
}

describe("IssueLinePanel current issue semantics", () => {
  it("marks currentIssueId rather than a merely selected normal line", () => {
    render(
      <IssueLinePanel
        issues={[issue("issue-a", 1), issue("issue-b", 2)]}
        currentIssueId="issue-a"
        onSelectLine={vi.fn()}
      />
    );
    const current = screen.getByRole("button", { name: "문제 라인 1 선택" });
    const other = screen.getByRole("button", { name: "문제 라인 2 선택" });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(other).not.toHaveAttribute("aria-current");
    expect(current).not.toHaveAttribute("aria-selected");
    expect(other).not.toHaveAttribute("aria-selected");
  });

  it("keeps selection callback independent from current issue", () => {
    const onSelectLine = vi.fn();
    render(<IssueLinePanel issues={[issue("issue-a", 1)]} currentIssueId={null} onSelectLine={onSelectLine} />);
    fireEvent.click(screen.getByRole("button", { name: "문제 라인 1 선택" }));
    expect(onSelectLine).toHaveBeenCalledWith(expect.objectContaining({ id: "issue-a" }));
  });
});
