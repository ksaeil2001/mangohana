import { Button } from "./Ui.js";
import { useEffect, useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import type {
  ExtractionLanguage,
  NormalizedBbox,
  OcrTextType,
  PolygonPoint,
  SpeakerCandidate,
  SpeechBubbleExtractionResult
} from "../../shared/speechBubbleExtraction";
import type {
  ProductionOcrOrientation,
  ProductionOcrProvenance
} from "../../shared/productionOcr.js";
import {
  contextOnlyTextTypes,
  hasOcrValidationDegradedWarning,
  normalizeSpeakerCandidates,
  optionalApplyTextTypes,
  speechBubbleTextTypes
} from "../../shared/speechBubbleExtraction";
import type { CharacterProfile } from "../../shared/projectTypes";
import { matchCharacterFromBank } from "../../shared/characterBank/characterAssociation";
import type { ReviewStage } from "../guidedWorkflow";
import { useFocusTrap } from "../useFocusTrap.js";

export type SpeechBubbleReviewItem = {
  id: string;
  textType: OcrTextType;
  text: string;
  language: ExtractionLanguage;
  bbox: NormalizedBbox;
  readingOrder: number;
  confidence: number;
  notes: string;
  speakerCandidates: SpeakerCandidate[];
  selectedSpeaker: string;
  polygon?: PolygonPoint[];
  orientation?: ProductionOcrOrientation;
  productionOcrProvenance?: ProductionOcrProvenance;
};

export type EditableReviewItem = SpeechBubbleReviewItem & {
  reviewId: string;
  selected: boolean;
};

export type SpeechBubbleReviewDraft = {
  items: EditableReviewItem[];
  activeReviewId: string | null;
};

type Props = {
  currentPage: number;
  result: SpeechBubbleExtractionResult;
  onApply: (items: SpeechBubbleReviewItem[]) => void;
  onCancel: () => void;
  onBack?: () => void;
  onActiveItemChange?: (item: SpeechBubbleReviewItem | null) => void;
  initialDraft?: SpeechBubbleReviewDraft;
  onDraftChange?: (draft: SpeechBubbleReviewDraft) => void;
  stage?: ReviewStage | "combined";
  submitLabel?: string;
  variant?: "modal" | "panel";
  primaryActionRef?: Ref<HTMLButtonElement>;
  characters?: readonly CharacterProfile[];
  disabled?: boolean;
};

type ReviewGroup = {
  title: string;
  description: string;
  items: EditableReviewItem[];
  collapsed?: boolean;
};

export function SpeechBubbleReviewDialog({
  currentPage,
  result,
  onApply,
  onCancel,
  onBack,
  onActiveItemChange,
  initialDraft,
  onDraftChange,
  stage = "combined",
  submitLabel = "현재 페이지에 적용",
  variant = "modal",
  primaryActionRef,
  characters,
  disabled = false
}: Props) {
  const [items, setItems] = useState<EditableReviewItem[]>(() => initialDraft?.items ?? createEditableItems(result));
  const [activeReviewId, setActiveReviewId] = useState<string | null>(() => initialDraft?.activeReviewId ?? null);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const selectedItems = items.filter((item) => item.selected && item.text.trim().length > 0);
  const stageItems = stage === "speaker" ? items.filter((item) => item.selected) : items;
  const groups = createGroups(stageItems);
  const validationDegraded = hasOcrValidationDegradedWarning(result);
  const activeItem = stageItems.find((item) => item.reviewId === activeReviewId) ?? stageItems[0];
  const fieldPrefix = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (variant !== "modal") return;
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (invoker?.isConnected) invoker.focus(); };
  }, [variant]);
  useFocusTrap(dialogRef, variant === "modal");

  useEffect(() => {
    const nextItems = initialDraft?.items ?? createEditableItems(result);
    setItems(nextItems);
    setActiveReviewId(initialDraft?.activeReviewId ?? nextItems.find((item) => item.selected)?.reviewId ?? nextItems[0]?.reviewId ?? null);
  }, [result]);

  useLayoutEffect(() => {
    onDraftChangeRef.current?.({ items, activeReviewId });
  }, [items, activeReviewId]);

  useEffect(() => {
    onActiveItemChange?.(activeItem ? toReviewItem(activeItem) : null);
  }, [activeItem, onActiveItemChange]);

  useEffect(() => {
    if (variant !== "modal") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, variant]);

  function updateItem(reviewId: string, patch: Partial<EditableReviewItem>) {
    setItems((current) => current.map((item) => (item.reviewId === reviewId ? { ...item, ...patch } : item)));
  }

  const dialog = (
    <section
      ref={dialogRef}
      tabIndex={variant === "modal" ? -1 : undefined}
      className={variant === "panel" ? "speech-review-dialog speech-review-panel stitch-workbench-inline stitch-ocr-review" : "speech-review-dialog stitch-dialog stitch-dialog--ocr"}
      role={variant === "modal" ? "dialog" : "region"}
      aria-modal={variant === "modal" ? true : undefined}
      aria-label={`${currentPage}페이지 말풍선 OCR 검토`}
    >
        <header className="speech-review-header">
          <div>
            <span className="stitch-dialog-kicker">{stage === "speaker" ? "02 화자 확인" : stage === "ocr" ? "01 원문 확인" : "OCR · 화자 확인"}</span>
            <h2>{stage === "speaker" ? "화자 검토" : "말풍선 OCR 검토"}</h2>
            <p>
              {currentPage}페이지 · 기본 후보 {result.speechBubbles.length}개 · 문맥 텍스트 {result.nonSpeechText.length}개
            </p>
          </div>
          <button type="button" onClick={onCancel} aria-label="말풍선 OCR 검토 닫기">
            닫기
          </button>
        </header>

        <div className="stitch-ocr-body">
        {stage !== "speaker" && items.length > 0 && (
          <div style={{ display: "flex", gap: "var(--trio-space-1)", margin: "var(--trio-space-1) 0 var(--trio-space-2)" }} aria-label="일괄 선택 도구">
            <Button
              type="button"
              variant="secondary"
              size="compact"
              onClick={() => setItems((prev) => prev.map((item) => ({ ...item, selected: true })))}
            >
              ✓ 전체 선택
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              onClick={() => setItems((prev) => prev.map((item) => ({ ...item, selected: false })))}
            >
              ✕ 전체 해제
            </Button>
          </div>
        )}

        {result.warnings.length > 0 ? (

          <div
            className={`speech-review-warnings${validationDegraded ? " speech-review-warnings-degraded" : ""}`}
            role="status"
            data-validation-status={validationDegraded ? "degraded" : "warnings"}
          >
            <strong>{validationDegraded ? "2차 검증 미완료" : "재확인 필요"}</strong>
            <ul>
              {result.warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="stitch-ocr-layout">
        <div className="speech-review-list" aria-label="OCR 검토 후보">
          {groups.some((group) => group.items.length > 0) ? (
            groups.map((group) =>
              group.collapsed ? (
                <details className="speech-review-group speech-review-group-collapsed" key={group.title}>
                  <summary>
                    <span>{group.title}</span>
                    <small>{group.items.length}개</small>
                  </summary>
                  <p className="speech-review-group-description">{group.description}</p>
                  <ReviewItemList
                    items={group.items}
                    stage={stage}
                    activeReviewId={activeItem?.reviewId ?? null}
                    onActivate={setActiveReviewId}
                    onUpdateItem={updateItem}
                  />
                </details>
              ) : (
                <section className="speech-review-group" key={group.title} aria-label={group.title}>
                  <div className="speech-review-group-heading">
                    <h3>{group.title}</h3>
                    <small>{group.items.length}개</small>
                  </div>
                  <p className="speech-review-group-description">{group.description}</p>
                  <ReviewItemList
                    items={group.items}
                    stage={stage}
                    activeReviewId={activeItem?.reviewId ?? null}
                    onActivate={setActiveReviewId}
                    onUpdateItem={updateItem}
                  />
                </section>
              )
            )
          ) : (
            <p className="speech-review-empty">적용할 OCR 텍스트가 없습니다.</p>
          )}
        </div>
        <section className="stitch-ocr-detail" aria-label={stage === "speaker" ? "현재 화자 후보 검토" : "현재 OCR 원문 검토"}>
          {activeItem ? (
            <>
              <header><span className="stitch-dialog-kicker">현재 검토 대상</span><h3>대사 #{activeItem.readingOrder}</h3><p>{activeItem.textType} · 신뢰도 {Math.round(activeItem.confidence * 100)}%</p></header>
              {stage === "speaker" ? <p className="speaker-review-source" aria-label={`대사 ${activeItem.readingOrder} 원문`}>{activeItem.text}</p> : (
                <label htmlFor={`${fieldPrefix}-text`}>인식한 원문
                  <textarea id={`${fieldPrefix}-text`} aria-label={`${activeItem.textType} ${activeItem.readingOrder} 원문`} value={activeItem.text} onChange={(event) => updateItem(activeItem.reviewId, { text: event.target.value })} />
                </label>
              )}
              {stage !== "ocr" ? renderSpeakerControls(activeItem, updateItem, characters) : null}
              <div className="speech-review-item-meta"><span>{formatBbox(activeItem.bbox)}</span><span>{activeItem.language}</span></div>
              {activeItem.notes ? <p className="speech-review-item-notes">{activeItem.notes}</p> : null}
              <p className="stitch-ocr-ownership">{stage === "speaker" ? "후보를 선택하거나 입력해 화자를 지정하세요. 적용 전에는 화자가 확정되지 않습니다." : "인식 결과를 확인하고 수정하세요. 선택한 원문만 적용됩니다."}</p>
            </>
          ) : <p className="speech-review-empty">검토할 후보를 목록에서 선택하세요.</p>}
        </section>
        </div>

        </div>
        <footer className="speech-review-actions">
          <span className="stitch-ocr-selection-count">적용 대상 {selectedItems.length}개</span>
          <div>
            {onBack ? (
              <button type="button" onClick={onBack}>
                이전 단계
              </button>
            ) : null}
            <button type="button" onClick={onCancel}>
              {variant === "panel" ? "닫기" : "취소"}
            </button>
          </div>
          <Button
            ref={primaryActionRef}
            type="button"
            variant="primary"
            data-primary-action={variant === "panel" && (stage === "ocr" || stage === "speaker") && selectedItems.length > 0 ? "true" : undefined}
            disabled={disabled || selectedItems.length === 0}
            onClick={() => onApply(selectedItems.map(toReviewItem).map((item) => ({ ...item, text: item.text.trim() })))}
          >
            {submitLabel}
          </Button>
        </footer>
    </section>
  );

  if (variant === "panel") return dialog;

  return (
    <div
      className="speech-review-backdrop stitch-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
    >
      {dialog}
    </div>
  );
}

function ReviewItemList({ items, stage, activeReviewId, onActivate, onUpdateItem }: {
  items: EditableReviewItem[];
  stage: ReviewStage | "combined";
  activeReviewId: string | null;
  onActivate: (reviewId: string) => void;
  onUpdateItem: (id: string, patch: Partial<EditableReviewItem>) => void;
}) {
  if (items.length === 0) return <p className="speech-review-empty">해당 그룹의 OCR 텍스트가 없습니다.</p>;
  return (
    <div className="speech-review-group-list">
      {items.map((item) => (
        <article className={`speech-review-item ${item.reviewId === activeReviewId ? "active" : ""}`} data-included={item.selected} key={item.reviewId} onFocusCapture={() => onActivate(item.reviewId)}>
          {stage === "speaker" ? <span className="speech-review-check" aria-label={`${item.textType} ${item.readingOrder} 선택됨`}>#{item.readingOrder}</span> : (
            <label className="speech-review-check"><input aria-label={`${item.textType} ${item.readingOrder} 적용`} type="checkbox" checked={item.selected} onChange={(event) => { onActivate(item.reviewId); onUpdateItem(item.reviewId, { selected: event.target.checked }); }} /><span>#{item.readingOrder}</span></label>
          )}
          <button type="button" className="stitch-ocr-candidate" aria-label={`${item.textType} ${item.readingOrder} 검토: ${item.text || "원문 없음"}`} aria-current={item.reviewId === activeReviewId ? "true" : undefined} onClick={() => onActivate(item.reviewId)}>
            <span>{item.text || "인식한 원문 없음"}</span><small>{item.textType} · 신뢰도 {Math.round(item.confidence * 100)}%</small>
          </button>
        </article>
      ))}
    </div>
  );
}

function toReviewItem(item: EditableReviewItem): SpeechBubbleReviewItem {
  const { reviewId: _reviewId, selected: _selected, ...reviewItem } = item;
  return reviewItem;
}

function renderSpeakerControls(
  item: EditableReviewItem,
  onUpdateItem: (id: string, patch: Partial<EditableReviewItem>) => void,
  characters: readonly CharacterProfile[] = []
) {
  const candidateNames = new Set(item.speakerCandidates.map((c) => c.speaker.trim().toLowerCase()));
  const extraBankOptions = characters.filter((c) => !candidateNames.has(c.name.trim().toLowerCase()));

  return (
    <div className="speech-review-speaker">
      <label>
        <span>화자</span>
        <input
          aria-label={`${item.textType} ${item.readingOrder} 화자`}
          value={item.selectedSpeaker}
          onChange={(event) => onUpdateItem(item.reviewId, { selectedSpeaker: event.target.value })}
          list={`speaker-candidates-${item.reviewId}`}
        />
      </label>
      <datalist id={`speaker-candidates-${item.reviewId}`}>
        {item.speakerCandidates.map((candidate) => (
          <option value={candidate.speaker} key={`${item.reviewId}-${candidate.speaker}`} />
        ))}
        {extraBankOptions.map((character) => (
          <option value={character.name} key={`${item.reviewId}-bank-${character.id}`} />
        ))}
      </datalist>
      {item.speakerCandidates.length > 0 ? (
        <div className="speech-review-speaker-candidates" aria-label={`${item.textType} ${item.readingOrder} 화자 후보`}>
          {item.speakerCandidates.map((candidate) => {
            const bankMatch = matchCharacterFromBank(candidate.speaker, characters as CharacterProfile[]);
            const isBank = bankMatch.matchType !== "none";
            return (
              <button
                type="button"
                className={[
                  candidate.confidence < 0.7 || candidate.speaker.toLowerCase() === "unknown" ? "low-confidence" : undefined,
                  isBank ? "character-bank-match" : undefined
                ].filter(Boolean).join(" ") || undefined}
                key={`${item.reviewId}-${candidate.speaker}-${candidate.confidence}`}
                title={bankMatch.matchedProfile ? `${candidate.reason} (등록 인물: ${bankMatch.matchedProfile.name})` : candidate.reason}
                onClick={() => onUpdateItem(item.reviewId, { selectedSpeaker: candidate.speaker })}
              >
                {candidate.speaker} {Math.round(candidate.confidence * 100)}%
              </button>
            );
          })}
        </div>
      ) : null}
      {item.speakerCandidates[0]?.reason ? <small>{item.speakerCandidates[0].reason}</small> : null}
    </div>
  );
}

function createEditableItems(result: SpeechBubbleExtractionResult): EditableReviewItem[] {
  const speechItems = result.speechBubbles.map((bubble, index) => {
    const speakerCandidates = normalizeReviewSpeakerCandidates(bubble.speakerCandidates);
    return {
      id: bubble.id,
      reviewId: `speech-${bubble.type}-${bubble.readingOrder}-${index}`,
      textType: bubble.type,
      text: bubble.text,
      language: bubble.language,
      bbox: bubble.bbox,
      polygon: bubble.polygon,
      readingOrder: bubble.readingOrder,
      confidence: bubble.confidence,
      notes: bubble.notes,
      speakerCandidates,
      selectedSpeaker: getDefaultSelectedSpeaker(speakerCandidates),
      orientation: bubble.orientation,
      productionOcrProvenance: bubble.productionOcrProvenance,
      selected: bubble.text.trim().length > 0
    };
  });
  const nonSpeechItems = result.nonSpeechText.map((textRegion, index) => {
    const speakerCandidates = normalizeReviewSpeakerCandidates(textRegion.speakerCandidates);
    return {
      id: `non-speech-${textRegion.type}-${textRegion.readingOrder}-${index}`,
      reviewId: `non-speech-${textRegion.type}-${textRegion.readingOrder}-${index}`,
      textType: textRegion.type,
      text: textRegion.text,
      language: "unknown" as const,
      bbox: textRegion.bbox,
      polygon: textRegion.polygon,
      readingOrder: textRegion.readingOrder,
      confidence: textRegion.confidence,
      notes: textRegion.notes,
      speakerCandidates,
      selectedSpeaker: getDefaultSelectedSpeaker(speakerCandidates),
      orientation: textRegion.orientation,
      productionOcrProvenance: textRegion.productionOcrProvenance,
      selected: false
    };
  });

  return [...speechItems, ...nonSpeechItems].sort((left, right) => left.readingOrder - right.readingOrder);
}

function createGroups(items: EditableReviewItem[]): ReviewGroup[] {
  return [
    {
      title: "기본 적용 대상",
      description: "말풍선, 생각 말풍선, 전화/방송/기계음 등 대사 계열입니다.",
      items: items.filter((item) => (speechBubbleTextTypes as readonly string[]).includes(item.textType))
    },
    {
      title: "선택 적용 가능",
      description: "번역 라인에 넣을 수 있는 내레이션, 시간/장소 캡션, 메모, 편지/문서입니다.",
      items: items.filter((item) => (optionalApplyTextTypes as readonly string[]).includes(item.textType))
    },
    {
      title: "문맥 참고 / 기본 제외",
      description: "간판, 화면/UI, 효과음, 장식글자, 배경 잡텍스트 등 기본 제외 대상입니다.",
      items: items.filter((item) => (contextOnlyTextTypes as readonly string[]).includes(item.textType)),
      collapsed: true
    }
  ];
}

function getDefaultSelectedSpeaker(candidates: SpeakerCandidate[]): string {
  // Candidates are provider proposals. A value is written to DialogueLine.speaker
  // only after the user clicks a candidate or types a value explicitly.
  void candidates;
  return "";
}

function normalizeReviewSpeakerCandidates(candidates: SpeakerCandidate[] | undefined): SpeakerCandidate[] {
  return normalizeSpeakerCandidates(candidates);
}

function formatBbox(bbox: NormalizedBbox): string {
  return `bbox ${bbox.x.toFixed(2)}, ${bbox.y.toFixed(2)}, ${bbox.width.toFixed(2)}, ${bbox.height.toFixed(2)}`;
}
