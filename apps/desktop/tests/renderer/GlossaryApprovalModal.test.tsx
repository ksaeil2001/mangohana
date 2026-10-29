import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlossaryApprovalModal } from "../../src/renderer/components/GlossaryApprovalModal.js";
import type { GlossaryExtractionResult } from "../../src/shared/glossaryPipeline.js";

describe("GlossaryApprovalModal", () => {
  const sampleExtraction: GlossaryExtractionResult = {
    terms: [
      {
        id: "t1",
        source: "月華一閃",
        suggestedTarget: "월화일섬",
        category: "skill",
        occurrenceCount: 5,
        contextSamples: ["月華一閃！"],
        confidence: 0.9,
        status: "proposed"
      },
      {
        id: "t2",
        source: "〜じゃのう",
        suggestedTarget: "~인 게지",
        category: "tone",
        occurrenceCount: 8,
        contextSamples: ["そうじゃのう"],
        confidence: 0.85,
        status: "proposed"
      }
    ],
    characters: [
      {
        id: "c1",
        nameJa: "セシル",
        nameKo: "세실",
        role: "흑기사",
        tone: "호전적인 반말",
        gender: "남성",
        confidence: 0.95,
        status: "proposed",
        aliases: ["발렌타인"]
      }
    ],
    corpusStats: {
      totalDialogueLines: 50,
      totalCharactersAnalyzed: 800,
      uniqueCandidatesFound: 3
    }
  };

  it("renders terms and characters tabs with analysis statistics", () => {
    render(
      <GlossaryApprovalModal
        extractionResult={sampleExtraction}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/대사 50줄 분석 완료/)).toBeInTheDocument();
    expect(screen.getByText(/용어 후보/)).toBeInTheDocument();
    expect(screen.getByText(/캐릭터 후보/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("月華一閃")).toBeInTheDocument();
    expect(screen.getByDisplayValue("월화일섬")).toBeInTheDocument();
  });

  it("switches tabs and toggles candidate approval status", () => {
    render(
      <GlossaryApprovalModal
        extractionResult={sampleExtraction}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // Switch to character tab
    const charTabBtn = screen.getByRole("button", { name: /캐릭터 후보/ });
    fireEvent.click(charTabBtn);

    expect(screen.getByDisplayValue("세실")).toBeInTheDocument();
    expect(screen.getByDisplayValue("호전적인 반말")).toBeInTheDocument();
  });

  it("preserves candidate edits across master selection and applies bulk exclusion only to filtered terms", () => {
    const onApply = vi.fn();
    render(<GlossaryApprovalModal extractionResult={sampleExtraction} onApply={onApply} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "권장 번역어" }), { target: { value: "수정한 기술명" } });
    fireEvent.click(screen.getByRole("button", { name: /〜じゃのう/ }));
    expect(screen.getByRole("textbox", { name: "용어 원문" })).toHaveValue("〜じゃのう");
    fireEvent.click(screen.getByRole("button", { name: /月華一閃/ }));
    expect(screen.getByRole("textbox", { name: "권장 번역어" })).toHaveValue("수정한 기술명");
    fireEvent.change(screen.getByRole("combobox", { name: "카테고리 필터" }), { target: { value: "tone" } });
    fireEvent.click(screen.getByRole("button", { name: "✕ 전체 제외" }));
    expect(screen.getByRole("button", { name: "미선택 (클릭하여 선택)" })).toHaveAttribute("aria-pressed", "false");
    const apply = screen.getByRole("button", { name: "선택한 항목 승인·사전 반영 (2개)" });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledExactlyOnceWith({
      terms: [expect.objectContaining({ id: "t1", suggestedTarget: "수정한 기술명" })],
      characters: [expect.objectContaining({ id: "c1", nameKo: "세실" })]
    });
    fireEvent.click(screen.getByRole("button", { name: /캐릭터 후보/ }));
    fireEvent.click(screen.getByRole("button", { name: "✕ 전체 제외" }));
    fireEvent.click(screen.getByRole("button", { name: /용어 후보/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "카테고리 필터" }), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "✕ 전체 제외" }));
    expect(screen.getByRole("button", { name: "선택한 항목 승인·사전 반영 (0개)" })).toBeDisabled();
  });

  it("cancels without applying during review and returns focus after a non-composing Escape", () => {
    const onApply = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>추출 후보 열기</button>{open ? <GlossaryApprovalModal extractionResult={sampleExtraction} onApply={onApply} onClose={() => setOpen(false)} /> : null}</>;
    }
    render(<Example />);
    const opener = screen.getByRole("button", { name: "추출 후보 열기" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.change(screen.getByRole("textbox", { name: "권장 번역어" }), { target: { value: "검토 중인 번역" } });
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });

  it("preserves edited candidates across review tabs and keeps footer keyboard access", () => {
    const onApply = vi.fn();
    render(<GlossaryApprovalModal extractionResult={sampleExtraction} onApply={onApply} onClose={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue("월화일섬"), { target: { value: "수정한 번역" } });
    fireEvent.click(screen.getByRole("button", { name: /캐릭터 후보/ }));
    fireEvent.click(screen.getByRole("button", { name: /용어 후보/ }));
    expect(screen.getByDisplayValue("수정한 번역")).toBeInTheDocument();

    const apply = screen.getByRole("button", { name: /선택한 항목 승인·사전 반영/ });
    apply.focus();
    fireEvent.keyDown(apply, { key: "Tab" });
    expect(screen.getByRole("button", { name: "닫기" })).toHaveFocus();
    fireEvent.click(apply);
    expect(onApply.mock.calls[0]![0].terms).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "t1", suggestedTarget: "수정한 번역" })
    ]));
  });

  it("calls onApply with approved items on submit", () => {
    const handleApply = vi.fn();
    render(
      <GlossaryApprovalModal
        extractionResult={sampleExtraction}
        onApply={handleApply}
        onClose={vi.fn()}
      />
    );

    expect(handleApply).not.toHaveBeenCalled();
    expect(screen.queryByText("✓ 승인됨")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "✓ 선택됨" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "✓ 선택됨" })[0]).toHaveAttribute("aria-pressed", "true");
    const submitBtn = screen.getByRole("button", { name: /선택한 항목 승인·사전 반영/ });
    fireEvent.click(submitBtn);

    expect(handleApply).toHaveBeenCalledTimes(1);
    const appliedData = handleApply.mock.calls[0]![0];
    expect(appliedData.terms.length + appliedData.characters.length).toBeGreaterThan(0);
  });
});
