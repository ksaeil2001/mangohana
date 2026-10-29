import { Button } from "./Ui.js";
import type { IssueEditorState } from "../issueEditorState";
import { getIssueEditorMismatch } from "../issueEditorState";

type Props = {
  state: IssueEditorState;
  onTogglePin: () => void;
  onSwitchToRequired: () => void;
};

const EDITOR_LABELS = {
  ocr: "OCR",
  speaker: "화자",
  translation: "번역"
} as const;

export function ContextualIssueEditorControl({ state, onTogglePin, onSwitchToRequired }: Props) {
  const mismatch = getIssueEditorMismatch(state);
  return (
    <section
      className="panel-section contextual-issue-editor-control"
      data-testid="contextual-issue-editor-control"
      data-active-editor={state.activeEditor ?? "none"}
      data-required-editor={state.requiredEditor ?? "none"}
      aria-label="현재 문제 편집기"
    >
      <div className="contextual-issue-editor-heading">
        <div>
          <h2>문제 편집기</h2>
          <p data-testid="contextual-active-editor">현재: {formatEditor(state.activeEditor)}</p>
        </div>
        <button
          type="button"
          className={state.pinned ? "primary-button" : "secondary-button"}
          aria-pressed={state.pinned}
          aria-label={state.pinned ? "편집기 pin 해제" : "편집기 pin"}
          onClick={onTogglePin}
        >
          {state.pinned ? "Pin 고정됨" : "편집기 pin"}
        </button>
      </div>
      {mismatch ? (
        <div className="contextual-issue-editor-mismatch" role="status" data-editor-mismatch="true">
          <p>현재 편집기를 유지하고 있습니다. 이 문제에는 {formatEditor(mismatch.requiredEditor)} 편집기가 필요합니다.</p>
          <Button type="button" variant="secondary" onClick={onSwitchToRequired} aria-label={`필요한 ${formatEditor(mismatch.requiredEditor)} 편집기 열기`}>
            필요한 {formatEditor(mismatch.requiredEditor)} 편집기 열기
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function formatEditor(editor: IssueEditorState["activeEditor"]): string {
  return editor ? EDITOR_LABELS[editor] : "없음";
}
