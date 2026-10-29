import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";
import { SpeechBubbleReviewDialog } from "../../src/renderer/components/SpeechBubbleReviewDialog";

const result: SpeechBubbleExtractionResult = {
  pageNumber: 1,
  speechBubbles: [
    {
      id: "bubble-1",
      type: "speech_bubble",
      text: "誰なの？",
      language: "ja",
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.12 },
      readingOrder: 1,
      confidence: 0.92,
      notes: "",
      speakerCandidates: [
        { speaker: "유나", confidence: 0.92, reason: "말풍선 꼬리가 유나를 향합니다." },
        { speaker: "unknown", confidence: 0.31, reason: "얼굴 일부가 가려졌습니다." }
      ]
    }
  ],
  nonSpeechText: [],
  warnings: []
};

describe("SpeechBubbleReviewDialog stages", () => {
  it("retains edits and per-item inclusion when selecting candidates in the inline master and detail review", () => {
    const multiResult = { ...result, speechBubbles: [...result.speechBubbles, {
      ...result.speechBubbles[0]!, id: "bubble-2", type: "thought_bubble" as const, readingOrder: 2, text: "そうか…"
    }] };
    const onApply = vi.fn();
    render(<SpeechBubbleReviewDialog currentPage={1} result={multiResult} variant="panel" stage="ocr" onApply={onApply} onCancel={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /thought_bubble 2 검토/ })).toHaveTextContent("そうか…");
    fireEvent.change(screen.getByLabelText("speech_bubble 1 원문"), { target: { value: "수정한 첫 원문" } });
    fireEvent.click(screen.getByRole("button", { name: /thought_bubble 2 검토/ }));
    fireEvent.change(screen.getByLabelText("thought_bubble 2 원문"), { target: { value: "수정한 둘째 원문" } });
    fireEvent.click(screen.getByRole("button", { name: /speech_bubble 1 검토/ }));
    expect(screen.getByLabelText("speech_bubble 1 원문")).toHaveValue("수정한 첫 원문");
    fireEvent.click(screen.getByLabelText("thought_bubble 2 적용"));
    fireEvent.click(screen.getByRole("button", { name: "현재 페이지에 적용" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: "bubble-1", text: "수정한 첫 원문", selectedSpeaker: "" })]);
    fireEvent.click(screen.getByLabelText("thought_bubble 2 적용"));
    expect(screen.getByLabelText("thought_bubble 2 원문")).toHaveValue("수정한 둘째 원문");
    fireEvent.click(screen.getByRole("button", { name: "현재 페이지에 적용" }));
    expect(onApply).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "bubble-1", text: "수정한 첫 원문" }),
      expect.objectContaining({ id: "bubble-2", text: "수정한 둘째 원문" })
    ]);
  });

  it("contains modal focus, ignores composing Escape, and returns focus to its invoker on cancel", () => {
    function Example() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>OCR 검토 열기</button>{open ? <SpeechBubbleReviewDialog currentPage={1} result={result} onApply={vi.fn()} onCancel={() => setOpen(false)} /> : null}</>;
    }
    render(<Example />);
    const opener = screen.getByRole("button", { name: "OCR 검토 열기" });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole("button", { name: "말풍선 OCR 검토 닫기" });
    expect(close).toHaveFocus();
    const apply = screen.getByRole("button", { name: "현재 페이지에 적용" });
    apply.focus();
    fireEvent.keyDown(apply, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it("preserves corrected OCR text when moving from OCR to speaker stage", () => {
    const onApply = vi.fn();
    const { rerender } = render(
      <SpeechBubbleReviewDialog
        currentPage={1}
        result={result}
        variant="panel"
        stage="ocr"
        submitLabel="OCR 적용 · 화자 확인"
        onApply={onApply}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("speech_bubble 1 화자")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("speech_bubble 1 원문"), { target: { value: "誰なの、そこ？" } });
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ text: "誰なの、そこ？" })]);

    rerender(
      <SpeechBubbleReviewDialog
        currentPage={1}
        result={result}
        variant="panel"
        stage="speaker"
        submitLabel="화자 적용 · 번역 수정"
        onBack={vi.fn()}
        onApply={onApply}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("speech_bubble 1 원문")).not.toBeInTheDocument();
    expect(screen.getByLabelText("대사 1 원문")).toHaveTextContent("誰なの、そこ？");
    expect(screen.getByLabelText("speech_bubble 1 화자")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "유나 92%" }));
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    expect(onApply).toHaveBeenLastCalledWith([
      expect.objectContaining({ text: "誰なの、そこ？", selectedSpeaker: "유나" })
    ]);
  });

  it("reports the active OCR item for image highlighting", async () => {
    const onActiveItemChange = vi.fn();
    render(
      <SpeechBubbleReviewDialog
        currentPage={1}
        result={result}
        variant="panel"
        stage="ocr"
        onActiveItemChange={onActiveItemChange}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(onActiveItemChange).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bubble-1", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.12 } })
      );
    });
  });

  it("selects and deselects all items using bulk toggle buttons", () => {
    render(
      <SpeechBubbleReviewDialog
        currentPage={1}
        result={result}
        variant="panel"
        stage="ocr"
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const checkbox = screen.getByLabelText("speech_bubble 1 적용") as HTMLInputElement;
    const selectAllBtn = screen.getByRole("button", { name: "✓ 전체 선택" });
    const deselectAllBtn = screen.getByRole("button", { name: "✕ 전체 해제" });

    expect(checkbox.checked).toBe(true);

    fireEvent.click(deselectAllBtn);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(selectAllBtn);
    expect(checkbox.checked).toBe(true);
  });

  it("matches speaker candidate with Character Bank and displays star marker", () => {
    const characters = [
      { id: "char-1", name: "유나", aliases: ["Yuna"], speechStyle: "반말" }
    ];
    render(
      <SpeechBubbleReviewDialog
        currentPage={1}
        result={result}
        variant="panel"
        stage="speaker"
        characters={characters}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const bankButton = screen.getByRole("button", { name: "유나 92%" });
    expect(bankButton).toBeInTheDocument();
    expect(bankButton).toHaveClass("character-bank-match");
    expect(bankButton).toHaveAttribute("title", expect.stringContaining("등록 인물: 유나"));
    expect(screen.getByRole("button", { name: "unknown 31%" })).toBeInTheDocument();
  });
});
