import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StageEditor } from "../../src/renderer/components/StageEditor";
import type { DialogueLine } from "../../src/shared/projectTypes";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction";

const line: DialogueLine = { id: "line-1", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "ja", sourceText: "source", speaker: "Yuna", userTranslation: "draft", lineStatus: "untranslated", parseConfidence: .9, parseWarnings: [] };
const review: SpeechBubbleExtractionResult = { pageNumber: 1, speechBubbles: [{ id: "b1", type: "speech_bubble", text: "source", language: "ja", bbox: { x: .1, y: .1, width: .2, height: .2 }, readingOrder: 1, confidence: .9, notes: "", speakerCandidates: [{ speaker: "Yuna", confidence: .9, reason: "context" }] }], nonSpeechText: [], warnings: [] };

const props = {
  stage: "translation" as const, currentPage: 1, review: null, line,
  onApproveOcr: vi.fn(), onApproveSpeaker: vi.fn(), onCancelReview: vi.fn(), onBackToOcr: vi.fn(), onActiveReviewItemChange: vi.fn(),
  onUpdateLine: vi.fn(), onDeleteLine: vi.fn(), onMoveLine: vi.fn(), canMovePrevious: false, canMoveNext: false, onApproveTranslation: vi.fn(),
  hasActionableProjectLines: true, nextActionableLine: line, onContinueProject: vi.fn(), onExport: vi.fn(), onReviewProject: vi.fn(), onRetry: vi.fn()
};

function expectPrimaryAction(accessibleName: string) {
  const primaryActions = document.querySelectorAll('[data-primary-action="true"]');
  expect(primaryActions).toHaveLength(1);
  expect(primaryActions[0]).toHaveAccessibleName(accessibleName);
}

function expectOnlyEnabledPrimaryButton(accessibleName: string) {
  const primaryButtons = document.querySelectorAll<HTMLButtonElement>(".stage-editor .primary-button:not(:disabled)");
  expect(primaryButtons).toHaveLength(1);
  expect(primaryButtons[0]).toBeVisible();
  expect(primaryButtons[0]).toHaveAccessibleName(accessibleName);
}

describe("StageEditor", () => {
  it("offers OCR and manual entry on a blank page even when other pages contain dialogue", () => {
    const onCreateManualLine = vi.fn();
    render(<StageEditor {...props} stage="complete" currentPage={2} line={null} hasProjectLines hasPageLines={false} hasPageImage hasActionableProjectLines nextActionableLine={line} onCreateManualLine={onCreateManualLine} />);
    expect(screen.getByRole("heading", { name: "대사 시작" })).toBeVisible();
    expect(screen.getByRole("button", { name: "OCR로 대사 찾기" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "수동 대사 추가" }));
    fireEvent.change(screen.getByLabelText("수동 대사 원문"), { target: { value: "새 페이지의 대사" } });
    fireEvent.click(screen.getByRole("button", { name: "대사 만들기" }));
    expect(onCreateManualLine).toHaveBeenCalledWith("새 페이지의 대사");
    expect(screen.getByRole("button", { name: "다른 페이지의 남은 대사로 이동" })).toBeInTheDocument();
  });
  it.each([["ocr", "OCR 확인"], ["speaker", "화자 확인"], ["translation", "번역 수정"], ["complete", "완료"]] as const)("renders only the %s stage", (stage, heading) => {
    render(<StageEditor {...props} stage={stage} review={stage === "ocr" || stage === "speaker" ? review : null} />);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    for (const other of ["OCR 확인", "화자 확인", "번역 수정", "완료"].filter(value => value !== heading)) expect(screen.queryByRole("heading", { name: other })).not.toBeInTheDocument();
  });

  it("dispatches OCR and speaker approvals", () => {
    const onApproveOcr = vi.fn();
    const { rerender } = render(<StageEditor {...props} stage="ocr" review={review} onApproveOcr={onApproveOcr} />);
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    expect(onApproveOcr).toHaveBeenCalled();
    const onApproveSpeaker = vi.fn();
    rerender(<StageEditor {...props} stage="speaker" review={review} onApproveSpeaker={onApproveSpeaker} />);
    fireEvent.click(screen.getByRole("button", { name: "화자 적용 · 번역 수정" }));
    expect(onApproveSpeaker).toHaveBeenCalled();
  });

  it("shows translation context and preserves typed input while retrying", () => {
    const onUpdateLine = vi.fn(); const onRetry = vi.fn(); const onApproveTranslation = vi.fn();
    render(<StageEditor {...props} error="temporary" onUpdateLine={onUpdateLine} onRetry={onRetry} onApproveTranslation={onApproveTranslation} />);
    expect(screen.getByRole("textbox", { name: "원문 1" })).toHaveValue("source");
    expect(screen.getByRole("textbox", { name: "라인 화자" })).toHaveValue("Yuna");
    const textarea = screen.getByRole("textbox", { name: "사용자 수정문 1" });
    fireEvent.change(textarea, { target: { value: "typed" } });
    fireEvent.click(screen.getByRole("button", { name: "번역 다시 시도" }));
    expect(onUpdateLine).toHaveBeenCalledWith(expect.objectContaining({ userTranslation: "typed" }));
    expect(onRetry).toHaveBeenCalled();
    expect(onApproveTranslation).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("temporary");
    expectPrimaryAction("번역 다시 시도");
    expectOnlyEnabledPrimaryButton("번역 다시 시도");
  });

  it("disables and demotes underlying workflow actions while retry is primary", () => {
    const onRetry = vi.fn();
    const onApproveTranslation = vi.fn();
    const onContinueProject = vi.fn();
    const onExport = vi.fn();
    const { rerender } = render(
      <StageEditor {...props} error="temporary" onRetry={onRetry} onApproveTranslation={onApproveTranslation} />
    );

    const translationAction = screen.getByRole("button", { name: "검수 확정" });
    expect(translationAction).toBeDisabled();
    expect(translationAction).not.toHaveClass("primary-button");
    fireEvent.click(translationAction);
    expectOnlyEnabledPrimaryButton("번역 다시 시도");

    rerender(<StageEditor {...props} stage="complete" error="temporary" onRetry={onRetry} onContinueProject={onContinueProject} />);
    const continuationAction = screen.getByRole("button", { name: "남은 대사로 이동" });
    expect(continuationAction).toBeDisabled();
    expect(continuationAction).not.toHaveClass("primary-button");
    fireEvent.click(continuationAction);
    expectOnlyEnabledPrimaryButton("OCR 다시 실행");

    rerender(<StageEditor {...props} stage="complete" error="temporary" hasActionableProjectLines={false} nextActionableLine={null} onRetry={onRetry} onExport={onExport} />);
    const exportAction = screen.getByRole("button", { name: "번역 내보내기" });
    expect(exportAction).toBeDisabled();
    expect(exportAction).not.toHaveClass("primary-button");
    fireEvent.click(exportAction);
    fireEvent.click(screen.getByRole("button", { name: "OCR 다시 실행" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onApproveTranslation).not.toHaveBeenCalled();
    expect(onContinueProject).not.toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
    expectOnlyEnabledPrimaryButton("OCR 다시 실행");
  });

  it("shows completion as the primary translation action with its shortcut", () => {
    render(<StageEditor {...props} />);

    expect(screen.getByRole("button", { name: "검수 확정" })).toHaveClass("primary-button");
    expect(screen.getByLabelText("단축키 Ctrl+Enter")).toHaveTextContent("Ctrl+Enter");
    expectPrimaryAction("검수 확정");
  });

  it("labels confirmation as adopting the AI suggestion when the user has no translation", () => {
    render(<StageEditor {...props} line={{ ...props.line!, userTranslation: "", aiTranslation: "AI가 제안한 번역" }} />);
    expect(screen.getByRole("button", { name: "제안 채택 및 검수 확정" })).toBeEnabled();
  });

  it("offers continuation for incomplete projects and export/review for complete projects", () => {
    const { rerender } = render(<StageEditor {...props} stage="complete" />);
    expect(screen.getByRole("button", { name: "남은 대사로 이동" })).toBeInTheDocument();
    expectPrimaryAction("남은 대사로 이동");
    rerender(<StageEditor {...props} stage="complete" nextActionableLine={{ ...line, pageNumber: 2 }} />);
    expectPrimaryAction("다음 페이지로 이동");
    rerender(<StageEditor {...props} stage="complete" hasActionableProjectLines={false} nextActionableLine={null} />);
    expect(screen.getByRole("button", { name: "번역 내보내기" })).toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "프로젝트 검토" })).toHaveClass("secondary-button");
    expectPrimaryAction("번역 내보내기");
  });

  it.each([
    ["ocr", "OCR"],
    ["speaker", "화자"],
    ["translation", "번역"]
  ] as const)("renders and focuses the confirmed %s issue editor surface", (editor, label) => {
    render(<StageEditor {...props} issueEditorOverride={editor} issueContextId={`issue-${editor}`} />);
    const heading = screen.getByRole("heading", { name: `문제 편집기 · ${label}` });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(heading);
    expect(screen.getByTestId("line-detail-panel")).toHaveAttribute("data-line-editor-context", editor);
    if (editor === "speaker") {
      expect(screen.getByText("화자 메타데이터를 확인하세요.")).toBeInTheDocument();
    }
  });

  it.each(["ocr", "speaker", "translation"] as const)("uses only the confirmed %s contextual surface while a review is active", (editor) => {
    render(<StageEditor {...props} stage="ocr" review={review} issueEditorOverride={editor} issueContextId={`exclusive-${editor}`} />);
    expect(screen.queryByRole("heading", { name: "OCR 확인" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "OCR 적용 · 화자 확인" })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("line-detail-panel")).toHaveLength(1);
    expect(screen.getByTestId("line-detail-panel")).toHaveAttribute("data-line-editor-context", editor);
    expect(screen.getByTestId("stage-editor")).toHaveAttribute("data-stage", editor);
    if (editor === "translation") {
      expect(screen.getByRole("button", { name: "검수 확정" })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("button", { name: "검수 확정" })).not.toBeInTheDocument();
    }
  });

  it("offers an explicit postpone action only when the issue workflow provides one", () => {
    const onPostponeTranslation = vi.fn();
    render(<StageEditor {...props} issueEditorOverride="translation" issueContextId="postpone" onPostponeTranslation={onPostponeTranslation} />);
    fireEvent.click(screen.getByRole("button", { name: "보류" }));
    expect(onPostponeTranslation).toHaveBeenCalledOnce();
  });

  it("disables project mutation actions while session recovery is required", () => {
    const onApproveOcr = vi.fn();
    const onApproveTranslation = vi.fn();
    const { rerender } = render(
      <StageEditor
        {...props}
        projectEditingDisabled
        onApproveOcr={onApproveOcr}
        onApproveTranslation={onApproveTranslation}
      />
    );

    expect(screen.getByRole("button", { name: "검수 확정" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "사용자 수정문 1" })).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "검수 확정" }));
    expect(onApproveTranslation).not.toHaveBeenCalled();

    rerender(
      <StageEditor
        {...props}
        stage="ocr"
        review={review}
        projectEditingDisabled
        onApproveOcr={onApproveOcr}
      />
    );
    expect(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "OCR 적용 · 화자 확인" }));
    expect(onApproveOcr).not.toHaveBeenCalled();
  });
});
