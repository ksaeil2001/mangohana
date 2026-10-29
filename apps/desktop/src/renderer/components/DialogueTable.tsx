import { Button } from "./Ui.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DialogueLine, DialogueType, LineStatus } from "../../shared/projectTypes";
import { getQueueWindow } from "../guidedWorkflow";

type StatusFilter = "all" | LineStatus;
type FilterScope = "current-page" | "project";

type Props = {
  lines: DialogueLine[];
  allLines: DialogueLine[];
  currentPage: number;
  hasProjectLines: boolean;
  selectedLineId: string | null;
  variant?: "queue" | "full";
  onSelectLine: (id: string) => void;
  onUpdateLine: (line: DialogueLine) => void;
  disabled?: boolean;
};

export function DialogueTable({
  lines,
  allLines,
  currentPage,
  hasProjectLines,
  selectedLineId,
  variant = "full",
  onSelectLine,
  onUpdateLine,
  disabled = false
}: Props) {
  const [showIssuesOnly, setShowIssuesOnly] = useState(false);
  const [searchText, setSearchText] = useState("");
  const updateLineIfEnabled = (line: DialogueLine) => {
    if (!disabled) onUpdateLine(line);
  };
  const [speakerFilter, setSpeakerFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [filterScope, setFilterScope] = useState<FilterScope>("current-page");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const scopedLines = filterScope === "project" ? allLines : lines;
  const statusSummary = useMemo(() => summarizeLineStatuses(scopedLines), [scopedLines]);
  const visibleLines = useMemo(() => {
    return scopedLines.filter((line) => {
      if (showIssuesOnly && !hasParserIssue(line)) return false;
      if (searchText.trim() && !matchesSearchText(line, searchText)) return false;
      if (speakerFilter.trim() && !matchesText(line.speaker, speakerFilter)) return false;
      if (statusFilter !== "all" && getLineStatus(line) !== statusFilter) return false;
      return true;
    });
  }, [scopedLines, searchText, showIssuesOnly, speakerFilter, statusFilter]);
  const displaySourceLines = variant === "queue" ? lines : scopedLines;
  const displayLines = variant === "queue" ? getQueueWindow(lines, selectedLineId, 3) : visibleLines;

  useEffect(() => {
    if (!selectedLineId) return;
    rowRefs.current.get(selectedLineId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [lines, selectedLineId, variant, visibleLines]);

  useEffect(() => {
    if (variant !== "full") return;
    if (!selectedLineId || visibleLines.length === 0) return;
    if (visibleLines.some((line) => line.id === selectedLineId)) return;
    onSelectLine(visibleLines[0].id);
  }, [onSelectLine, selectedLineId, variant, visibleLines]);

  return (
    <div className="dialogue-table">
      {variant === "queue" ? (
        <div className="dialogue-queue-heading">
          <strong>{displayLines.length}개 대사 작업 큐</strong>
          <span>선택한 대사와 가까운 작업만 표시합니다.</span>
        </div>
      ) : (
        <div className="table-toolbar">
          <div className="status-summary" aria-label="상태 요약">
            <strong>진행률 {statusSummary.progress}%</strong>
            <span>미번역 {statusSummary.untranslated}</span>
            <span>초안 {statusSummary.draft}</span>
            <span>완료 {statusSummary.complete}</span>
            <span>검토필요 {statusSummary.review}</span>
          </div>

          <div className="table-filters" aria-describedby="table-filter-scope">
            <label>
              범위
              <select
                id="filter-scope"
                name="filter-scope"
                value={filterScope}
                onChange={(event) => setFilterScope(event.target.value as FilterScope)}
                aria-label="필터 범위"
              >
                <option value="current-page">현재 페이지</option>
                <option value="project">전체 프로젝트</option>
              </select>
            </label>
            <label>
              {filterScope === "project" ? "전체 프로젝트 검색" : "현재 페이지 검색"}
              <input
                id="dialogue-search"
                name="dialogue-search"
                type="search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                aria-label="대사 검색"
              />
            </label>
            <label>
              {filterScope === "project" ? "전체 프로젝트 화자" : "현재 페이지 화자"}
              <input
                id="speaker-filter"
                name="speaker-filter"
                type="search"
                value={speakerFilter}
                onChange={(event) => setSpeakerFilter(event.target.value)}
                aria-label="화자 필터"
              />
            </label>
            <label>
              상태
              <select
                id="status-filter"
                name="status-filter"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                aria-label="상태 필터"
              >
                <option value="all">전체</option>
                <option value="untranslated">미번역</option>
                <option value="draft">초안</option>
                <option value="complete">완료</option>
                <option value="review">검토필요</option>
              </select>
            </label>
            <label className="issue-filter">
              <input
                id="issues-only"
                name="issues-only"
                type="checkbox"
                checked={showIssuesOnly}
                onChange={(event) => setShowIssuesOnly(event.target.checked)}
                aria-label="문제 라인만 보기"
              />
              문제 라인만 보기
            </label>
            {(searchText.trim() || speakerFilter.trim() || statusFilter !== "all" || showIssuesOnly) && (
              <Button
                type="button"
                variant="secondary"
                size="compact"
                style={{ marginLeft: "var(--trio-space-1)" }}
                aria-label="필터 초기화"
                onClick={() => {
                  setSearchText("");
                  setSpeakerFilter("");
                  setStatusFilter("all");
                  setShowIssuesOnly(false);
                }}
              >
                ✕ 필터 초기화
              </Button>
            )}
          </div>

          <small id="table-filter-scope" className="filter-scope-note">
            {filterScope === "project"
              ? `전체 프로젝트 ${allLines.length}개 라인에서 검색합니다. 다른 페이지 라인을 선택하면 해당 페이지로 이동합니다.`
              : `필터는 현재 ${currentPage}페이지 ${lines.length}개 라인에만 적용됩니다. 전체 프로젝트 검색이 필요하면 범위를 바꾸세요.`}
          </small>
          <span>
            {scopedLines.length}개 중 {visibleLines.length}개 표시
          </span>
        </div>
      )}
      <div className="table-header line-list-header">
        <span>라인</span>
        <span>원문 / AI 초안</span>
        <span>사용자 수정문</span>
        <span>상태</span>
        <span className="sr-only">원문</span>
        <span className="sr-only">AI 번역</span>
        <span className="sr-only">사용자 수정문</span>
      </div>
      {displaySourceLines.length === 0 ? (
        hasProjectLines ? (
          <div className="empty-state">현재 페이지에 대사가 없습니다.</div>
        ) : (
          <div className="empty-state">TXT 파일을 불러오면 편집을 시작할 수 있습니다.</div>
        )
      ) : displayLines.length === 0 ? (
        <div className="empty-state">현재 필터와 일치하는 라인이 없습니다.</div>
      ) : (
        displayLines.map((line) => {
          const isSelected = line.id === selectedLineId;
          const status = getLineStatus(line);

          return (
            <div
              className={`table-row line-list-row ${isSelected ? "selected" : ""}`}
              key={line.id}
              title={`[#${line.order}] ${line.sourceText}\n→ ${line.userTranslation || line.aiTranslation || "(미번역)"}`}
              ref={(element) => {
                if (element) {
                  rowRefs.current.set(line.id, element);
                } else {
                  rowRefs.current.delete(line.id);
                }
              }}
              role="button"
              aria-pressed={isSelected}
              aria-label={`대사 #${line.order} ${line.speaker ? `(${line.speaker})` : ""}`}
              tabIndex={0}
              onClick={() => onSelectLine(line.id)}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectLine(line.id);
                }
              }}
            >
              <div className="line-list-id">
                <strong>#{line.order}</strong>
                <span>{line.speaker || "화자 없음"}</span>
                <small>{getDialogueTypeLabel(line.dialogueType)}</small>
              </div>
              <div className="line-list-copy">
                <div className="line-list-meta row-metadata">
                  <span>{line.position || "위치 없음"}</span>
                  <span>{Math.round(line.parseConfidence * 100)}%</span>
                </div>
                <span className="line-field-label">원문</span>
                <p>{line.sourceText}</p>
                <span className="line-field-label">AI</span>
                <p>{line.aiTranslation || "AI 번역 없음"}</p>
              </div>
              <div className="line-list-state">
                <strong>{line.userTranslation ? "수정문 있음" : "수정문 없음"}</strong>
                <span className="line-field-label">수정문</span>
                <span className={`line-text-sample ${line.userTranslation ? "" : "empty"}`}>
                  {line.userTranslation || "아직 사용자 수정문 없음"}
                </span>
              </div>
              <div className="line-list-status" data-status={status}>
                <span>{getStatusLabel(status)}</span>
                {hasParserIssue(line) ? <small className="line-list-warning">문제 라인</small> : null}
              </div>
              {line.parseWarnings.length > 0 ? (
                <div className="line-list-warnings">
                  {line.parseWarnings.map((warning, index) => <small className="line-list-warning" key={index}>{warning}</small>)}
                </div>
              ) : null}
              {!isSelected ? (
                <div className="sr-only">
                  <textarea
                    id={`row-source-${line.id}`}
                    name={`row-source-${line.id}`}
                    value={line.sourceText}
                    tabIndex={-1}
                    readOnly={disabled}
                    onChange={(event) => updateLineIfEnabled({ ...line, sourceText: event.target.value })}
                    aria-label={`원문 ${line.order}`}
                  />
                  <textarea
                    id={`row-ai-${line.id}`}
                    name={`row-ai-${line.id}`}
                    value={line.aiTranslation ?? ""}
                    tabIndex={-1}
                    readOnly={disabled}
                    onChange={(event) => updateLineIfEnabled({ ...line, aiTranslation: event.target.value })}
                    aria-label={`AI 번역 ${line.order}`}
                  />
                  <textarea
                    id={`row-user-${line.id}`}
                    name={`row-user-${line.id}`}
                    value={line.userTranslation ?? ""}
                    tabIndex={-1}
                    readOnly={disabled}
                    onChange={(event) => updateLineIfEnabled({ ...line, userTranslation: event.target.value })}
                    aria-label={`사용자 수정문 ${line.order}`}
                  />
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

function hasParserIssue(line: DialogueLine): boolean {
  return line.parseWarnings.length > 0 || line.parseConfidence < 0.7;
}

function getLineStatus(line: DialogueLine): LineStatus {
  return line.lineStatus ?? "untranslated";
}

function getDialogueTypeLabel(type: DialogueType): string {
  if (type === "thought") return "💭 독백";
  if (type === "narration") return "📜 내레이션";
  if (type === "unknown") return "❓ 유형 없음";
  return "💬 대사";
}


function getStatusLabel(status: LineStatus): string {
  if (status === "draft") return "초안";
  if (status === "complete") return "완료";
  if (status === "review") return "검토필요";
  return "미번역";
}

function summarizeLineStatuses(lines: DialogueLine[]) {
  const summary = {
    untranslated: 0,
    draft: 0,
    complete: 0,
    review: 0,
    progress: 0
  };

  for (const line of lines) {
    summary[getLineStatus(line)] += 1;
  }

  summary.progress = lines.length > 0 ? Math.round((summary.complete / lines.length) * 100) : 0;
  return summary;
}

function matchesSearchText(line: DialogueLine, query: string): boolean {
  return [
    line.sourceText,
    line.aiTranslation,
    line.userTranslation,
    line.referenceTranslation,
    line.notes
  ].some((value) => matchesText(value, query));
}

function matchesText(value: string | undefined, query: string): boolean {
  return value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ?? false;
}
