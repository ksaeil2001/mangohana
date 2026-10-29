import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DialogueLine, LineStatus } from "../../src/shared/projectTypes";
import { DialogueFilmstrip } from "../../src/renderer/components/DialogueFilmstrip";

function dialogueLine(id: string, order: number, lineStatus: LineStatus = "untranslated"): DialogueLine {
  return {
    id,
    order,
    pageNumber: 1,
    dialogueType: "speech",
    sourceLanguage: "ja",
    sourceText: `source-${id}`,
    lineStatus,
    parseConfidence: 0.95,
    parseWarnings: []
  };
}

describe("DialogueFilmstrip", () => {
  it("renders five semantic line buttons with the current line and labeled statuses", () => {
    const statuses: LineStatus[] = ["untranslated", "draft", "complete", "review", "untranslated"];
    const lines = statuses.map((status, index) => dialogueLine(String(index + 1), index + 1, status));

    render(<DialogueFilmstrip lines={lines} selectedLineId="3" onSelectLine={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(5);
    expect(screen.getByRole("button", { name: /#3/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getAllByText("미번역")).toHaveLength(2);
    expect(screen.getByText("초안")).toBeInTheDocument();
    expect(screen.getByText("완료")).toBeInTheDocument();
    expect(screen.getByText("검토필요")).toBeInTheDocument();
  });

  it("selects a line when its button is clicked", () => {
    const onSelectLine = vi.fn();
    render(<DialogueFilmstrip lines={[dialogueLine("line-1", 1)]} selectedLineId={null} onSelectLine={onSelectLine} />);

    fireEvent.click(screen.getByRole("button", { name: /#1/ }));

    expect(onSelectLine).toHaveBeenCalledWith("line-1");
  });

  it("falls back to source text when the user translation is empty", () => {
    const line = { ...dialogueLine("fallback", 1), userTranslation: "   " };
    render(<DialogueFilmstrip lines={[line]} selectedLineId={line.id} onSelectLine={vi.fn()} />);

    expect(screen.getByText("source-fallback")).toBeInTheDocument();
  });

  it("renders speaker name and warning badge when line has parser issues", () => {
    const line: DialogueLine = {
      ...dialogueLine("speaker-issue", 1, "review"),
      speaker: "루피",
      parseWarnings: ["불완전한 문장"],
      parseConfidence: 0.5
    };

    render(<DialogueFilmstrip lines={[line]} selectedLineId={line.id} onSelectLine={vi.fn()} />);

    expect(screen.getByRole("button", { name: /#1.*루피/ })).toBeInTheDocument();
    expect(screen.getByText("루피")).toBeInTheDocument();
    expect(screen.getByTitle("파싱 경고/낮은 신뢰도")).toHaveTextContent("⚠️");
  });

  it("renders helpful empty state when no lines are present", () => {
    render(<DialogueFilmstrip lines={[]} selectedLineId={null} onSelectLine={vi.fn()} />);

    expect(screen.getByText("대사 목록이 비어 있습니다. 이미지를 OCR하거나 프로젝트를 불러오세요.")).toBeInTheDocument();
  });
});
