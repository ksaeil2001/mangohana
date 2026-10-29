import { Button } from "./Ui.js";
import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import type { CharacterProfile, DialogueLine, DictionaryTerm } from "../../shared/projectTypes";
import type { SpeechBubbleExtractionResult } from "../../shared/speechBubbleExtraction";
import type { GuidedStage } from "../guidedWorkflow";
import type { IssueEditor } from "../issueEditorState";
import { LineDetailPanel } from "./LineDetailPanel";
import { canConfirmTranslation } from "../translationOwnership";
import { SpeechBubbleReviewDialog, type SpeechBubbleReviewDraft, type SpeechBubbleReviewItem } from "./SpeechBubbleReviewDialog";

type Props = {
  stage: GuidedStage;
  currentPage: number;
  review: SpeechBubbleExtractionResult | null;
  line: DialogueLine | null;
  busy?: boolean;
  error?: string | null;
  onApproveOcr: (items: SpeechBubbleReviewItem[]) => void;
  onApproveSpeaker: (items: SpeechBubbleReviewItem[]) => void;
  onCancelReview: () => void;
  onBackToOcr: () => void;
  onActiveReviewItemChange: (item: SpeechBubbleReviewItem | null) => void;
  reviewDraft?: SpeechBubbleReviewDraft;
  onReviewDraftChange?: (draft: SpeechBubbleReviewDraft) => void;
  onUpdateLine: (line: DialogueLine) => void;
  onDeleteLine: () => void;
  onMoveLine: (direction: 1 | -1) => void;
  canMovePrevious: boolean;
  canMoveNext: boolean;
  onApproveTranslation: () => void;
  onPostponeTranslation?: () => void;
  hasActionableProjectLines: boolean;
  hasProjectLines?: boolean;
  hasPageLines?: boolean;
  nextActionableLine: DialogueLine | null;
  onContinueProject: () => void;
  onExport: () => void;
  onReviewProject: () => void;
  onRetry: () => void;
  primaryActionRef?: Ref<HTMLButtonElement>;
  issueEditorOverride?: IssueEditor | null;
  issueContextId?: string | null;
  dialogueLines?: readonly DialogueLine[];
  characters?: readonly CharacterProfile[];
  dictionaryTerms?: readonly DictionaryTerm[];
  onRequestAiTranslation?: (line: DialogueLine) => Promise<void>;
  onCancelAiTranslation?: () => void;
  isTranslating?: boolean;
  hasPageImage?: boolean;
  ocrDisabledReason?: string;
  onOpenEnvironmentPreparation?: () => void;
  onRunOcr?: () => void;
  onCreateManualLine?: (sourceText: string) => void;
  focusUserTranslation?: boolean;
  onUserTranslationFocus?: () => void;
  projectEditingDisabled?: boolean;
};



export function StageEditor(props: Props) {
  const errorRef = useRef<HTMLDivElement>(null);
  const issueHeadingRef = useRef<HTMLHeadingElement>(null);
  const contextualEditor = props.issueEditorOverride ?? null;
  const contextualLine = props.line;

  useEffect(() => {
    if (props.error) errorRef.current?.focus();
  }, [props.error]);

  useEffect(() => {
    if (props.issueEditorOverride && props.issueContextId) {
      issueHeadingRef.current?.focus();
    }
  }, [props.issueContextId, props.issueEditorOverride]);

  const retryLabel =
    props.stage === "translation" && !props.error?.includes("OCR")
      ? "번역 다시 시도"
      : props.stage === "speaker"
        ? "화자 확인 다시 시도"
        : "OCR 다시 실행";

  return (
    <div className="stage-editor" data-testid="stage-editor" data-stage={contextualEditor ?? props.stage}>
      {props.error ? (
        <div ref={errorRef} className="guided-task-error" role="alert" tabIndex={-1}>
          <p>{props.error}</p>
          <Button
            ref={props.primaryActionRef}
            type="button"
            variant="primary"
            data-primary-action="true"
            disabled={props.projectEditingDisabled}
            onClick={props.onRetry}
          >
            {retryLabel}
          </Button>
        </div>
      ) : null}
      {contextualEditor && contextualLine ? (
        <section className="issue-context-editor" data-issue-editor-context={contextualEditor} aria-labelledby="issue-context-editor-heading">
          <h2 id="issue-context-editor-heading" ref={issueHeadingRef} tabIndex={-1}>
            문제 편집기 · {getIssueEditorLabel(contextualEditor)}
          </h2>
          <p className="issue-context-editor-description">
            현재 확정된 문제에 필요한 편집기입니다. 아래 기존 라인 편집 도구에서 바로 수정할 수 있습니다.
          </p>
        </section>
      ) : null}
      {contextualEditor && contextualLine ? (
        <IssueLineEditorSurface {...props} line={contextualLine} editor={contextualEditor} />
      ) : (
        <>
          {props.stage === "ocr" || props.stage === "speaker" ? <ReviewSection {...props} stage={props.stage} heading={props.stage === "ocr" ? "OCR 확인" : "화자 확인"} onApply={props.stage === "ocr" ? props.onApproveOcr : props.onApproveSpeaker} submitLabel={props.stage === "ocr" ? "OCR 적용 · 화자 확인" : "화자 적용 · 번역 수정"} /> : null}
          {props.stage === "translation" ? <TranslationSection {...props} context={props.issueEditorOverride ?? undefined} /> : null}
          {props.stage === "complete" ? <CompleteSection {...props} /> : null}
        </>
      )}
    </div>
  );
}

function ReviewSection(props: Props & { stage: "ocr" | "speaker"; heading: string; submitLabel: string; onApply: (items: SpeechBubbleReviewItem[]) => void }) {
  return (
    <section aria-labelledby={`${props.stage}-stage-heading`}>
      <h2 id={`${props.stage}-stage-heading`}>{props.heading}</h2>
      {props.review ? (
        <SpeechBubbleReviewDialog
          key={props.review.productionOcrContext?.runId ?? `${props.currentPage}`}
          currentPage={props.currentPage}
          result={props.review}
          initialDraft={props.reviewDraft}
          onDraftChange={props.onReviewDraftChange}
          variant="panel"
          stage={props.stage}
          characters={props.characters}
          submitLabel={props.submitLabel}
          primaryActionRef={props.error ? undefined : props.primaryActionRef}
          onActiveItemChange={props.onActiveReviewItemChange}
          onBack={props.stage === "speaker" ? props.onBackToOcr : undefined}
          onApply={props.onApply}
          onCancel={props.onCancelReview}
          disabled={props.projectEditingDisabled}
        />
      ) : (
        <p>OCR 확인 데이터가 없습니다.</p>
      )}
    </section>
  );
}

function TranslationSection(props: Props & { context?: IssueEditor }) {
  return (
    <section className="translation-work-surface" aria-labelledby="translation-stage-heading">
      <h2 id="translation-stage-heading" className="sr-only">번역 수정</h2>
      {props.line ? (
        <>
          <LineDetailPanel
            context={props.context ?? "translation"}
            line={props.line}
            onUpdateLine={props.onUpdateLine}
            onDeleteLine={props.onDeleteLine}
            onMoveLine={props.onMoveLine}
            canMovePrevious={props.canMovePrevious}
            canMoveNext={props.canMoveNext}
            dialogueLines={props.dialogueLines}
            characters={props.characters}
            dictionaryTerms={props.dictionaryTerms}
            onRequestAiTranslation={props.onRequestAiTranslation}
            onCancelAiTranslation={props.onCancelAiTranslation}
            isTranslating={props.isTranslating}
            focusUserTranslation={props.focusUserTranslation}
            onUserTranslationFocus={props.onUserTranslationFocus}
            disabled={props.projectEditingDisabled}
          />
          <div className="guided-primary-action">
            <button
              ref={props.error ? undefined : props.primaryActionRef}
              type="button"
              className={props.error ? "secondary-button" : "primary-button"}
              data-primary-action={props.error ? undefined : "true"}
              disabled={props.busy || Boolean(props.error) || props.projectEditingDisabled || !canConfirmTranslation(props.line)}
              title={!canConfirmTranslation(props.line) ? "확정할 번역문을 먼저 입력하거나 제안을 만드세요." : undefined}
              onClick={props.onApproveTranslation}
            >
              {!props.line.userTranslation && props.line.aiTranslation?.trim() ? "제안 채택 및 검수 확정" : "검수 확정"}
            </button>
            <span className="keyboard-hint" aria-label="단축키 Ctrl+Enter">
              <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
            </span>
          </div>
        </>
      ) : (
        <p>이미지를 연결하고 OCR을 실행하거나 기존 대사를 선택하세요.</p>
      )}
    </section>
  );
}

function getIssueEditorLabel(editor: IssueEditor): string {
  if (editor === "ocr") return "OCR";
  if (editor === "speaker") return "화자";
  return "번역";
}

function IssueLineEditorSurface(props: Props & { editor: IssueEditor }) {
  return (
    <section className="issue-line-editor-surface" data-issue-line-editor={props.editor} aria-label={`${getIssueEditorLabel(props.editor)} 문제 라인 편집`}>
      <LineDetailPanel
        context={props.editor}
        line={props.line}
        onUpdateLine={props.onUpdateLine}
        onDeleteLine={props.onDeleteLine}
        onMoveLine={props.onMoveLine}
        canMovePrevious={props.canMovePrevious}
        canMoveNext={props.canMoveNext}
        dialogueLines={props.dialogueLines}
        characters={props.characters}
        dictionaryTerms={props.dictionaryTerms}
        onRequestAiTranslation={props.onRequestAiTranslation}
        onCancelAiTranslation={props.onCancelAiTranslation}
        isTranslating={props.isTranslating}
        focusUserTranslation={props.focusUserTranslation}
        onUserTranslationFocus={props.onUserTranslationFocus}
        disabled={props.projectEditingDisabled}
      />


      {props.editor === "translation" ? (
        <div className="guided-primary-action">
          <button
            ref={props.error ? undefined : props.primaryActionRef}
            type="button"
            className={props.error ? "secondary-button" : "primary-button"}
            data-primary-action={props.error ? undefined : "true"}
            disabled={props.busy || Boolean(props.error) || props.projectEditingDisabled || !props.line || !canConfirmTranslation(props.line)}
            title={!props.line || !canConfirmTranslation(props.line) ? "확정할 번역문을 먼저 입력하거나 제안을 만드세요." : undefined}
            onClick={props.onApproveTranslation}
          >
            {!props.line?.userTranslation && props.line?.aiTranslation?.trim() ? "제안 채택 및 검수 확정" : "검수 확정"}
          </button>
          {props.onPostponeTranslation ? (
            <Button type="button" variant="secondary" onClick={props.onPostponeTranslation} disabled={props.busy || Boolean(props.error) || props.projectEditingDisabled}>
              보류
            </Button>
          ) : null}
          <span className="keyboard-hint" aria-label="단축키 Ctrl+Enter"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
        </div>
      ) : null}
    </section>
  );
}

function CompleteSection(props: Props) {
  const needsPageDialogue = props.hasPageLines === false || props.hasProjectLines === false;
  return (
    <section className="panel-section guided-complete-state" aria-labelledby="complete-stage-heading">
      <h2 id="complete-stage-heading">{needsPageDialogue && props.hasPageImage ? "대사 시작" : "완료"}</h2>
      {needsPageDialogue ? (
        props.hasPageImage ? <>
          <ManualDialogueStart {...props} />
          {props.hasActionableProjectLines && props.nextActionableLine ? <Button type="button" onClick={props.onContinueProject}>다른 페이지의 남은 대사로 이동</Button> : null}
        </> : <p>이미지를 연결하고 OCR을 실행하거나 기존 대사를 선택하세요.</p>
      ) : props.hasActionableProjectLines && props.nextActionableLine ? (
        <>
          <p>다른 페이지에 확인할 번역 대사가 남아 있습니다.</p>
          <button ref={props.error ? undefined : props.primaryActionRef} type="button" className={props.error ? "secondary-button" : "primary-button"} data-primary-action={props.error ? undefined : "true"} disabled={Boolean(props.error)} onClick={props.onContinueProject}>
            {props.nextActionableLine.pageNumber > props.currentPage ? "다음 페이지로 이동" : "남은 대사로 이동"}
          </button>
        </>
      ) : (
        <>
          <p>현재 프로젝트의 번역 대사를 모두 확인했습니다.</p>
          <button ref={props.error ? undefined : props.primaryActionRef} type="button" className={props.error ? "secondary-button" : "primary-button"} data-primary-action={props.error ? undefined : "true"} disabled={Boolean(props.error) || props.projectEditingDisabled} onClick={props.onExport}>번역 내보내기</button>
          <Button type="button" variant="secondary" onClick={props.onReviewProject}>프로젝트 검토</Button>
        </>
      )}
    </section>
  );
}

function ManualDialogueStart(props: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const sourceInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (formOpen) sourceInputRef.current?.focus();
  }, [formOpen]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = sourceText.trim();
    if (!trimmed || !props.onCreateManualLine) return;
    props.onCreateManualLine(trimmed);
    setSourceText("");
    setFormOpen(false);
  };

  return (
    <div className="manual-dialogue-start">
      <p>OCR을 실행하거나 원문을 직접 입력해 첫 대사를 만들 수 있습니다.</p>
      {props.ocrDisabledReason ? <p className="capability-disabled-reason" role="status">{props.ocrDisabledReason}</p> : null}
      <p className="manual-line-position-note">수동 대사 · 식자 영역 미지정</p>
      <div className="guided-primary-action">
        <Button type="button" variant="secondary" disabled={Boolean(props.ocrDisabledReason) || !props.onRunOcr} onClick={props.onRunOcr}>OCR로 대사 찾기</Button>
        {props.ocrDisabledReason && props.onOpenEnvironmentPreparation ? <Button type="button" variant="secondary" onClick={props.onOpenEnvironmentPreparation}>환경 준비</Button> : null}
        <Button type="button" variant="primary" disabled={props.projectEditingDisabled} onClick={() => setFormOpen(true)}>수동 대사 추가</Button>
      </div>
      {formOpen ? (
        <form className="manual-dialogue-form" onSubmit={submit}>
          <label htmlFor="manual-dialogue-source">수동 대사 원문</label>
          <textarea ref={sourceInputRef} id="manual-dialogue-source" name="manual-dialogue-source" value={sourceText} onChange={(event) => setSourceText(event.currentTarget.value)} />
          <div className="guided-primary-action">
            <Button type="button" variant="secondary" onClick={() => { setFormOpen(false); setSourceText(""); }}>취소</Button>
            <Button type="submit" variant="primary" disabled={props.projectEditingDisabled || !sourceText.trim()}>대사 만들기</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
