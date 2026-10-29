import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DialogueTable } from "../../src/renderer/components/DialogueTable";
import type { DialogueLine } from "../../src/shared/projectTypes";

const line: DialogueLine = {
  id: "row-review", order: 7, pageNumber: 2, speaker: "긴 화자 이름",
  dialogueType: "speech", sourceLanguage: "ja", sourceText: "長い原文。".repeat(30),
  aiTranslation: "Long translation. ".repeat(30), userTranslation: "긴 수정문. ".repeat(30),
  lineStatus: "review", parseConfidence: .5, parseWarnings: ["긴 경고 설명을 숨기지 않습니다. ".repeat(10)]
};

describe("DialogueTable comparison navigation", () => {
  it("keeps full content and warning available while keyboard selection does not edit data", () => {
    const onSelectLine = vi.fn();
    const onUpdateLine = vi.fn();
    render(<DialogueTable lines={[line]} allLines={[line]} currentPage={2} hasProjectLines selectedLineId={line.id} onSelectLine={onSelectLine} onUpdateLine={onUpdateLine} />);
    const row = screen.getByRole("button", { name: "대사 #7 (긴 화자 이름)" });
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(row).toHaveTextContent(line.sourceText);
    expect(row).toHaveTextContent(line.aiTranslation!);
    expect(row).toHaveTextContent(line.userTranslation!);
    expect(row).toHaveTextContent(line.parseWarnings[0].trim());
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onSelectLine.mock.calls).toEqual([[line.id], [line.id]]);
    expect(onUpdateLine).not.toHaveBeenCalled();
  });

  it("preserves the nearby queue selection model without claiming editable grid semantics", () => {
    const onSelectLine = vi.fn();
    render(<DialogueTable lines={[line]} allLines={[line]} currentPage={2} hasProjectLines variant="queue" selectedLineId={null} onSelectLine={onSelectLine} onUpdateLine={vi.fn()} />);
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: "대사 #7 (긴 화자 이름)" });
    expect(row).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(row, { key: "Enter", ctrlKey: true });
    expect(onSelectLine).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onSelectLine).toHaveBeenCalledWith(line.id);
  });
});
