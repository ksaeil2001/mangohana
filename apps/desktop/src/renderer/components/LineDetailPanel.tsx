import { Button } from "./Ui.js";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  CharacterProfile,
  DialogueLine,
  DialogueType,
  DictionaryTerm,
  LineStatus,
  SourceLanguage
} from "../../shared/projectTypes";

import {
  buildDialogueTranslationContext,
  inspectTranslationQuality,
  mangaSpeechStylePresetLabels,
  mangaSpeechStylePresets,
  type MangaSpeechStylePreset,
  type TranslationQaReport
} from "../../shared/translationContext";
import type { IssueEditor } from "../issueEditorState";
import { classifyTranslationOwnership } from "../translationOwnership";

type Props = {
  line: DialogueLine | null;
  onUpdateLine: (line: DialogueLine) => void;
  onDeleteLine: () => void;
  onMoveLine: (direction: 1 | -1) => void;
  canMovePrevious: boolean;
  canMoveNext: boolean;
  context?: IssueEditor;
  dialogueLines?: readonly DialogueLine[];
  characters?: readonly CharacterProfile[];
  dictionaryTerms?: readonly DictionaryTerm[];
  onRequestAiTranslation?: (line: DialogueLine) => Promise<void>;
  onCancelAiTranslation?: () => void;
  isTranslating?: boolean;
  focusUserTranslation?: boolean;
  onUserTranslationFocus?: () => void;
  disabled?: boolean;
};

export function LineDetailPanel({
  line,
  onUpdateLine,
  onDeleteLine,
  onMoveLine,
  canMovePrevious,
  canMoveNext,
  context,
  dialogueLines,
  characters,
  dictionaryTerms,
  onRequestAiTranslation,
  onCancelAiTranslation,
  isTranslating = false,
  focusUserTranslation = false,
  onUserTranslationFocus,
  disabled = false
}: Props) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [contextWindowSize, setContextWindowSize] = useState<number>(5);
  const [stylePreset, setStylePreset] = useState<MangaSpeechStylePreset>("literal");
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userTranslationRef = useRef<HTMLTextAreaElement>(null);

  const lineId = line?.id;
  const dialogueType = line?.dialogueType;
  const currentTransText = line ? (line.userTranslation || line.aiTranslation || "") : "";
  const deferredTransText = useDeferredValue(currentTransText);
  const deferredSourceText = useDeferredValue(line?.sourceText ?? "");

  const transContext = useMemo(() => {
    if (!lineId || !dialogueLines || dialogueLines.length === 0) return null;
    try {
      return buildDialogueTranslationContext({
        dialogueLines,
        targetLineId: lineId,
        characters,
        dictionaryTerms,
        options: { contextWindowSize, stylePreset, lookaheadWindowSize: 2, includeFuzzyTm: true }
      });
    } catch {
      return null;
    }
  }, [lineId, dialogueLines, characters, dictionaryTerms, contextWindowSize, stylePreset]);

  const qaReport = useMemo<TranslationQaReport | null>(() => {
    if (!lineId || !deferredTransText.trim() || !transContext) return null;
    try {
      return inspectTranslationQuality({
        sourceText: deferredSourceText,
        translatedText: deferredTransText,
        matchedTerms: transContext.matchedTerms,
        speakerProfile: transContext.speakerProfile,
        dialogueType
      });
    } catch {
      return null;
    }
  }, [lineId, deferredSourceText, deferredTransText, transContext, dialogueType]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!focusUserTranslation || !line) return;
    const timeoutId = window.setTimeout(() => {
      userTranslationRef.current?.focus();
      onUserTranslationFocus?.();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [focusUserTranslation, line?.id, onUserTranslationFocus]);

  if (!line) return <section className="panel-section line-detail-panel empty-detail">선택된 라인이 없습니다.</section>;
  const ownership = classifyTranslationOwnership(line);
  const updateLineIfEnabled = (nextLine: DialogueLine) => {
    if (!disabled) onUpdateLine(nextLine);
  };
  const moveLineIfEnabled = (direction: 1 | -1) => {
    if (!disabled) onMoveLine(direction);
  };
  const requestAiTranslationIfEnabled = () => {
    if (disabled || !onRequestAiTranslation || !line.sourceText?.trim() || isTranslating) return;
    void onRequestAiTranslation(line);
  };

  const copyToClipboard = async (field: string, text: string) => {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedField(field);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        setCopiedField((curr) => (curr === field ? null : curr));
        copyTimeoutRef.current = null;
      }, 1800);
    } catch {
      // Ignore copy error
    }
  };

  function updateParseWarnings(value: string) {
    if (!line) return;

    updateLineIfEnabled({
      ...line,
      parseWarnings: value
        .split("\n")
        .map((warning) => warning.trim())
        .filter(Boolean)
    });
  }

  function updateLineStatus(lineStatus: LineStatus) {
    if (!line) return;
    if (lineStatus === "complete" && !line.userTranslation?.trim()) return;
    updateLineIfEnabled({ ...line, lineStatus });
  }

  function handlePanelKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    if (event.altKey && (event.key === "t" || event.key === "T")) {
      if (onRequestAiTranslation && line?.sourceText?.trim() && !isTranslating) {
        event.preventDefault();
        event.stopPropagation();
        requestAiTranslationIfEnabled();
      }
    } else if (event.altKey && event.key === "ArrowUp") {
      if (canMovePrevious) {
        event.preventDefault();
        event.stopPropagation();
        moveLineIfEnabled(-1);
      }
    } else if (event.altKey && event.key === "ArrowDown") {
      if (canMoveNext) {
        event.preventDefault();
        event.stopPropagation();
        moveLineIfEnabled(1);
      }
    } else if (event.altKey && event.key === "1") {
      event.preventDefault();
      event.stopPropagation();
      updateLineStatus("draft");
    } else if (event.altKey && event.key === "2") {
      event.preventDefault();
      event.stopPropagation();
      updateLineStatus("complete");
    } else if (event.altKey && event.key === "3") {
      event.preventDefault();
      event.stopPropagation();
      updateLineStatus("review");
    }
  }


  return (
    <section
      className="panel-section line-detail-panel"
      data-testid="line-detail-panel"
      data-line-editor-context={context ?? "none"}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="line-detail-heading" data-translation-state={ownership.state}>
        <div>
          <h2>{context === "translation" ? `${line.pageNumber}페이지 · 대사 ${line.order}` : "라인 상세"}</h2>
          <p>{`#${line.order} · ${line.speaker || "화자 없음"} · ${getLegacyStatusLabel(line)}`}</p>
          {line.position ? <small>{line.position}</small> : null}
        </div>
        <span
          className={`translation-ownership-badge translation-ownership-${ownership.state}`}
          data-workspace-state={ownership.state}
          title={ownership.description}
        >
          {ownership.label}
        </span>
      </div>

      {context ? (
        <div className="line-detail-context" data-line-editor-context={context} role="note">
          {context === "ocr" ? "OCR 원문을 확인하세요." : context === "speaker" ? "화자 메타데이터를 확인하세요." : "번역 및 사용자 수정문을 확인하세요."}
        </div>
      ) : null}

      <div className="studio-editor-toolbar">
      <div className="line-navigation-actions" aria-label="라인 이동">
        <button type="button" onClick={() => moveLineIfEnabled(-1)} title="이전 대사 (Alt+↑)" aria-keyshortcuts="Alt+ArrowUp" disabled={disabled || !canMovePrevious}>
          이전 라인
        </button>
        <button type="button" onClick={() => moveLineIfEnabled(1)} title="다음 대사 (Alt+↓)" aria-keyshortcuts="Alt+ArrowDown" disabled={disabled || !canMoveNext}>
          다음 라인
        </button>
      </div>
        {onRequestAiTranslation && (
          <div className="studio-translation-actions" aria-busy={isTranslating}>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              title="이전 문맥과 화자 어투를 바탕으로 AI 번역을 생성합니다 (단축키: Alt+T)"
              disabled={disabled || isTranslating || !line.sourceText?.trim()}
              aria-keyshortcuts="Alt+t"
              onClick={requestAiTranslationIfEnabled}
            >
              {isTranslating ? "⚡ AI 번역 생성 중..." : "✨ AI 문맥 번역 실행 (Alt+T)"}
            </Button>
            {isTranslating && onCancelAiTranslation ? (
              <Button type="button" variant="secondary" onClick={onCancelAiTranslation}>
                AI 번역 취소
              </Button>
            ) : null}
            <span className="sr-only">
              (이전 문맥·화자 어투·용어집 자동 반영)
            </span>
          </div>
        )}
      </div>

      <div className="focus-editor trio-text-inspector-fields">
        <label className={context === "ocr" ? "context-target" : undefined}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>원문 <small className="studio-field-language" aria-hidden="true">{line.sourceLanguage === "ja" ? "日本語" : line.sourceLanguage === "en" ? "English" : "Original"}</small><span className="sr-only">대사 원문</span></span>
            {line.sourceText?.trim() && (
              <Button
                type="button"
                variant="secondary"
                size="compact"
                aria-label="원문 클립보드 복사"
                onClick={(e) => {
                  e.preventDefault();
                  copyToClipboard("source", line.sourceText);
                }}
              >
                {copiedField === "source" ? "✓ 복사됨" : "📋 복사"}
              </Button>
            )}
          </div>
          <textarea
            id={`detail-source-${line.id}`}
            name={`detail-source-${line.id}`}
            className="source-editor"
            lang={line.sourceLanguage === "ja" ? "ja" : line.sourceLanguage === "en" ? "en" : undefined}
            aria-label={`원문 ${line.order}`}
            value={line.sourceText}
            readOnly={disabled}
            onChange={(event) => updateLineIfEnabled({ ...line, sourceText: event.target.value })}
          />
        </label>
        <label className={context === "translation" ? "context-target" : undefined}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>번역문 <small className="studio-field-language" aria-hidden="true">한국어</small><span className="sr-only">사용자 수정문</span></span>
            <div style={{ display: "flex", gap: "var(--trio-space-1)" }}>
              {line.userTranslation?.trim() && (
                <button
                  type="button"
                  className="trio-inline-clear-btn"
                  disabled={disabled}
                  onClick={() => updateLineIfEnabled({ ...line, userTranslation: undefined })}
                  aria-label="사용자 수정문 비우기"
                  title="사용자 수정문 비우기"
                >
                  ✕ 비우기
                </button>
              )}
              {(line.userTranslation?.trim() || line.aiTranslation?.trim()) && (
                <Button
                  type="button"
                  variant="secondary"
                  size="compact"
                  aria-label="번역문 클립보드 복사"
                  onClick={(e) => {
                    e.preventDefault();
                    copyToClipboard("user", line.userTranslation || line.aiTranslation || "");
                  }}
                >
                  {copiedField === "user" ? "✓ 복사됨" : "📋 복사"}
                </Button>
              )}
            </div>
          </div>

          <textarea
            ref={userTranslationRef}
            id={`detail-user-${line.id}`}
            name={`detail-user-${line.id}`}
            className="user-translation-editor"
            lang="ko"
            aria-label={`사용자 수정문 ${line.order}`}
            value={line.userTranslation ?? line.aiTranslation ?? ""}
            placeholder="번역을 입력하세요"
            readOnly={disabled}
            onChange={(event) => updateLineIfEnabled({ ...line, userTranslation: event.target.value })}
            onFocus={onUserTranslationFocus}
          />
          {!line.typesetting?.bbox ? <small className="manual-line-position-note">식자 영역 미지정 · 글자 배치에서 지정</small> : null}
          <small className="translation-field-note">{line.userTranslation ? "사용자 수정이 AI 제안보다 우선" : line.aiTranslation ? "AI 제안 · 수정 가능" : "AI 제안 없음"}</small>
          {context === "translation" && line.aiTranslation ? (
            <div className="translation-inline-proposal" aria-label="현재 AI 제안">
              <strong>AI 제안</strong><p>{line.aiTranslation}</p>
            </div>
          ) : null}
        </label>
        <label className={context === "speaker" ? "context-target" : undefined}>
          화자
          <input
            id={`detail-speaker-${line.id}`}
            name={`detail-speaker-${line.id}`}
            aria-label="라인 화자"
            value={line.speaker ?? ""}
            placeholder="화자 없음"
            readOnly={disabled}
            onChange={(event) => updateLineIfEnabled({ ...line, speaker: event.target.value })}
          />
          {characters && characters.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--trio-space-1)", marginTop: "var(--trio-space-1)" }} aria-label="등록된 인물 빠른 선택">
              {characters.map((c) => (
                <Button
                  key={c.id}
                  type="button"
                  variant="secondary"
                  size="compact"
                  title={c.speechStyle ? `말투: ${c.speechStyle}` : undefined}
                  disabled={disabled}
                  onClick={() => updateLineIfEnabled({ ...line, speaker: c.name })}
                >
                  +{c.name}
                </Button>
              ))}
            </div>
          )}
        </label>
      </div>

      {context === "translation" && transContext ? (
        <section className="translation-neighbours" aria-label="앞뒤 대사">
          {([
            ["이전", transContext.previousTurns.at(-1)],
            ["다음", transContext.nextTurns[0]]
          ] as const).map(([label, turn]) => {
            return (
              <div key={label}>
                <strong>{label}{turn ? ` · ${turn.speaker || "화자 없음"}` : ""}</strong>
                <p>{turn?.sourceText || "대사 없음"}</p>
                {turn?.resolvedTranslation ? <p className="neighbour-translation">{turn.resolvedTranslation}</p> : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {/* Translation Context Preview & QA */}
      {transContext && (
        <>
          {/* QA Alert Banner if issues exist */}
          {qaReport && qaReport.issues.length > 0 && (
            <div
              className="trio-qa-alert-box"
              data-testid="translation-qa-alert"
              style={{
                margin: "var(--trio-space-2) 0",
                padding: "var(--trio-space-2) var(--trio-space-2)",
                background: qaReport.passed ? "var(--trio-warning-soft)" : "var(--trio-error-soft)",
                border: `1px solid ${qaReport.passed ? "var(--trio-warning)" : "var(--trio-error)"}`,
                borderRadius: "var(--trio-radius-sm)",
                fontSize: "var(--trio-text-caption)"
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: "var(--trio-space-1)", color: qaReport.passed ? "var(--trio-warning)" : "var(--trio-error)" }}>
                {qaReport.passed ? "품질 검사 통과 · 확인할 항목 있음" : "⚠️ 번역 품질 검사 이슈 감지 (Glossarion QA)"}
              </div>
              <ul style={{ margin: 0, paddingLeft: "var(--trio-space-4)" }}>
                {qaReport.issues.map((issue, idx) => (
                  <li key={idx} style={{ color: issue.severity === "error" ? "var(--trio-error)" : issue.severity === "warning" ? "var(--trio-warning)" : "var(--trio-text)" }}>
                    {issue.message}
                    {issue.suggestedFix && (
                      <span style={{ marginLeft: "var(--trio-space-2)", display: "inline-flex", alignItems: "center", gap: "var(--trio-space-1)" }}>
                        <span
                          style={{
                            fontWeight: 600,
                            color: "var(--trio-accent)",
                            background: "var(--trio-accent-soft)",
                            padding: "1px var(--trio-space-1)",
                            borderRadius: "var(--trio-radius-sm)",
                            fontSize: "var(--trio-text-caption)"
                          }}
                        >
                          권장 용어: {issue.suggestedFix}
                        </span>
                        <Button
                          type="button"
                          variant="secondary"
                          size="compact"
                          aria-label={`권장 용어 ${issue.suggestedFix} 복사`}
                          onClick={(e) => {
                            e.preventDefault();
                            if (issue.suggestedFix) {
                              copyToClipboard(`qa-fix-${idx}`, issue.suggestedFix);
                            }
                          }}
                        >
                          {copiedField === `qa-fix-${idx}` ? "✓ 복사됨" : "📋 복사"}
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Translation Memory (TM) Recommendation Banner */}
          {transContext.fuzzyTmMatches && transContext.fuzzyTmMatches.length > 0 && (
            <div
              className="trio-tm-recommend-box"
              data-testid="translation-tm-recommend"
              style={{
                margin: "var(--trio-space-1) 0 var(--trio-space-2)",
                padding: "var(--trio-space-1) var(--trio-space-2)",
                background: "var(--trio-accent-soft)",
                border: "1px solid var(--trio-border-soft)",
                borderRadius: "var(--trio-radius-sm)",
                fontSize: "var(--trio-text-caption)"
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--trio-accent)", marginBottom: "var(--trio-space-1)" }}>
                ⚡ 번역 메모리(TM) 추천
              </div>
              {transContext.fuzzyTmMatches.map((tmMatch, idx) => (
                <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "2px" }}>
                  <span style={{ color: "var(--trio-text)" }}>
                    <span style={{ fontWeight: 600, color: "var(--trio-accent)" }}>[{Math.round(tmMatch.similarity * 100)}% 일치]</span>{" "}
                    &ldquo;{tmMatch.entry.targetTranslation}&rdquo;
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    disabled={disabled}
                    onClick={() => {
                      updateLineIfEnabled({
                        ...line,
                        userTranslation: tmMatch.entry.targetTranslation
                      });
                    }}
                  >
                    적용
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Context Details Accordion */}
          <details className="line-meta-details translation-context-preview" data-testid="translation-context-preview">
            <summary>
              번역 문맥 미리보기 (이전 {transContext.previousTurns.length}개 · 이후 {transContext.nextTurns.length}개 · {transContext.speakerProfile?.name ? `화자: ${transContext.speakerProfile.name}` : "화자 미지정"})
            </summary>
            <div className="translation-context-content">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--trio-space-2)" }}>
                <span style={{ fontSize: "var(--trio-text-caption)", fontWeight: 600, color: "var(--ink-muted)" }}>문맥 탐색 범위:</span>
                <div style={{ display: "flex", gap: "var(--trio-space-1)" }}>
                  {[3, 5, 10].map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      className={`secondary-button ${contextWindowSize === sz ? "active" : ""}`}
                      style={{
                        fontSize: "var(--trio-text-caption)",
                        padding: "1px var(--trio-space-1)",
                        borderRadius: "var(--trio-radius)",
                        background: contextWindowSize === sz ? "var(--accent)" : undefined,
                        color: contextWindowSize === sz ? "var(--trio-on-accent)" : undefined
                      }}
                      onClick={() => setContextWindowSize(sz)}
                    >
                      {sz}개
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--trio-space-2)" }}>
                <span style={{ fontSize: "var(--trio-text-caption)", fontWeight: 600, color: "var(--ink-muted)" }}>대사 어조 프리셋:</span>
                <select
                  value={stylePreset}
                  onChange={(e) => setStylePreset(e.target.value as MangaSpeechStylePreset)}
                  style={{ fontSize: "var(--trio-text-caption)", padding: "2px var(--trio-space-1)", borderRadius: "var(--trio-radius-sm)" }}
                  aria-label="대사 어조 프리셋 선택"
                >
                  {mangaSpeechStylePresets.map((preset) => (
                    <option key={preset} value={preset}>
                      {mangaSpeechStylePresetLabels[preset]}
                    </option>
                  ))}
                </select>
              </div>
              {transContext.speakerProfile && (
                <div className="context-item context-speaker">
                  <strong>화자 페르소나:</strong> {transContext.speakerProfile.name}
                  {transContext.speakerProfile.speechStyle && <span> ({transContext.speakerProfile.speechStyle})</span>}
                </div>
              )}

              {transContext.matchedTerms.length > 0 && (
                <div className="context-item context-glossary">
                  <strong>매칭된 사전 용어:</strong>
                  <ul>
                    {transContext.matchedTerms.map((t) => (
                      <li key={t.id}>{t.source} → {t.target} {t.note ? `(${t.note})` : ""}</li>
                    ))}
                  </ul>
                </div>
              )}
              {transContext.previousTurns.length > 0 && (
                <div className="context-item context-turns">
                  <strong>직전 대화 흐름 (Previous):</strong>
                  <ol>
                    {transContext.previousTurns.map((turn) => (
                      <li key={turn.order}>
                        <span className="turn-speaker">{turn.speaker ? `[${turn.speaker}] ` : ""}</span>
                        <span className="turn-source">{turn.sourceText}</span>
                        {turn.resolvedTranslation && <span className="turn-trans"> → {turn.resolvedTranslation}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {transContext.nextTurns.length > 0 && (
                <div className="context-item context-turns context-lookahead" style={{ borderTop: "1px dashed var(--trio-border-soft)", paddingTop: "var(--trio-space-1)", marginTop: "var(--trio-space-1)" }}>
                  <strong>이후 대화 흐름 (Lookahead):</strong>
                  <ol>
                    {transContext.nextTurns.map((turn) => (
                      <li key={turn.order}>
                        <span className="turn-speaker">{turn.speaker ? `[${turn.speaker}] ` : ""}</span>
                        <span className="turn-source">{turn.sourceText}</span>
                        {turn.resolvedTranslation && <span className="turn-trans"> → {turn.resolvedTranslation}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </details>
        </>
      )}

      <details className="line-meta-details trio-ai-proposal-details">
        <summary>AI 제안 및 고급 정보</summary>


        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--trio-space-1)" }}>
          <label htmlFor={`detail-ai-${line.id}`} style={{ margin: 0, fontWeight: 700, fontSize: "var(--trio-text-caption)", color: "var(--ink)" }}>
            AI 번역 제안 <span className="sr-only">AI 번역</span>
          </label>
          {line.aiTranslation?.trim() && line.aiTranslation !== line.userTranslation && (
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={disabled}
              aria-label="AI 번역을 사용자 수정문에 적용"
              onClick={() => updateLineIfEnabled({ ...line, userTranslation: line.aiTranslation })}
            >
              📥 번역창에 적용
            </Button>
          )}
        </div>
        <textarea
          id={`detail-ai-${line.id}`}
          name={`detail-ai-${line.id}`}
          aria-label={`AI 번역 ${line.order}`}
          value={line.aiTranslation ?? ""}
          readOnly
          placeholder="AI 번역 없음"
        />
      </details>





      <div className="quick-status-actions" aria-label="빠른 상태 변경">
        <button
          type="button"
          aria-label="초안 표시"
          aria-pressed={line.lineStatus === "draft"}
          className={line.lineStatus === "draft" ? "active" : undefined}
          disabled={disabled}
          onClick={() => updateLineStatus("draft")}
        >
          초안
        </button>
        <button
          type="button"
          aria-label="완료 표시"
          aria-pressed={line.lineStatus === "complete"}
          className={line.lineStatus === "complete" ? "active" : undefined}
          disabled={disabled || !line.userTranslation?.trim()}
          title={!line.userTranslation?.trim() ? "사용자 번역을 먼저 입력하거나 제안을 채택하세요." : undefined}
          onClick={() => updateLineStatus("complete")}
        >
          완료
        </button>
        <button
          type="button"
          aria-label="검토필요 표시"
          aria-pressed={line.lineStatus === "review"}
          className={line.lineStatus === "review" ? "active" : undefined}
          disabled={disabled}
          onClick={() => updateLineStatus("review")}
        >
          검토필요
        </button>
      </div>



      <div className="detail-readout">
        <span>파싱 신뢰도</span>
        <strong>{Math.round(line.parseConfidence * 100)}%</strong>
      </div>

      <details className="line-meta-details" open={context === "speaker"}>
        <summary>라인 메타</summary>
        <div className="line-meta-grid">
          <label>
            페이지
            <input
              id={`detail-page-${line.id}`}
              name={`detail-page-${line.id}`}
              aria-label="라인 페이지"
              type="number"
              min={1}
              value={line.pageNumber}
              readOnly={disabled}
              onChange={(event) => {
                const pageNumber = Number(event.target.value);
                if (!Number.isInteger(pageNumber) || pageNumber < 1) return;
                updateLineIfEnabled({ ...line, pageNumber });
              }}
            />
          </label>
          <label>
            위치
            <input
              id={`detail-position-${line.id}`}
              name={`detail-position-${line.id}`}
              aria-label="라인 위치"
              value={line.position ?? ""}
              placeholder="예: 상단 우측"
              readOnly={disabled}
              onChange={(event) => updateLineIfEnabled({ ...line, position: event.target.value })}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--trio-space-1)", marginTop: "var(--trio-space-1)" }} aria-label="빠른 위치 선택">
              {["상단 좌측", "상단 우측", "중앙", "하단 좌측", "하단 우측", "효과음"].map((pos) => (
                <Button
                  key={pos}
                  type="button"
                  variant="secondary"
                  size="compact"
                  disabled={disabled}
                  onClick={() => updateLineIfEnabled({ ...line, position: pos })}
                >
                  {pos}
                </Button>
              ))}
            </div>
          </label>

          <label>
            유형
            <select
              id={`detail-type-${line.id}`}
              name={`detail-type-${line.id}`}
              aria-label="라인 유형"
              value={line.dialogueType}
              disabled={disabled}
              onChange={(event) => updateLineIfEnabled({ ...line, dialogueType: event.target.value as DialogueType })}
            >
              <option value="speech">대사</option>
              <option value="thought">독백</option>
              <option value="narration">내레이션</option>
              <option value="unknown">유형 없음</option>
            </select>
          </label>
          <label>
            언어
            <select
              id={`detail-language-${line.id}`}
              name={`detail-language-${line.id}`}
              aria-label="라인 언어"
              value={line.sourceLanguage}
              disabled={disabled}
              onChange={(event) => updateLineIfEnabled({ ...line, sourceLanguage: event.target.value as SourceLanguage })}
            >
              <option value="ja">일본어</option>
              <option value="en">영어</option>
              <option value="mixed">혼합</option>
              <option value="unknown">언어 없음</option>
            </select>
          </label>
        </div>
      </details>

      <details className="line-meta-details">
        <summary>참고 / 경고</summary>
        <div className="line-meta-grid">
          <label>
            참고 번역
            <textarea
              id={`detail-reference-${line.id}`}
              name={`detail-reference-${line.id}`}
              aria-label="참고 번역"
              value={line.referenceTranslation ?? ""}
              readOnly={disabled}
              onChange={(event) => updateLineIfEnabled({ ...line, referenceTranslation: event.target.value })}
            />
          </label>
          <label>
            상세 메모
            <textarea
              id={`detail-notes-${line.id}`}
              name={`detail-notes-${line.id}`}
              aria-label="상세 메모"
              value={line.notes ?? ""}
              readOnly={disabled}
              onChange={(event) => updateLineIfEnabled({ ...line, notes: event.target.value })}
            />
          </label>
          <label>
            파서 경고
            <textarea
              id={`detail-warnings-${line.id}`}
              name={`detail-warnings-${line.id}`}
              aria-label="파서 경고"
              value={line.parseWarnings.join("\n")}
              readOnly={disabled}
              onChange={(event) => updateParseWarnings(event.target.value)}
            />
          </label>
          <div className="warnings">{line.parseWarnings.length > 0 ? line.parseWarnings.join(", ") : "파서 경고 없음"}</div>
        </div>
      </details>

      <div className="danger-zone">
        <button type="button" className="danger-button" disabled={disabled} onClick={() => { if (!disabled) onDeleteLine(); }}>
          라인 삭제
        </button>
      </div>
    </section>
  );
}

function getLegacyStatusLabel(line: DialogueLine): string {
  const status = line.lineStatus ?? "untranslated";
  if (status === "complete") return "완료";
  if (status === "review") return "검토필요";
  if (status === "draft") return line.userTranslation?.trim() ? "초안 작성" : "AI 초안";
  return "미번역";
}
