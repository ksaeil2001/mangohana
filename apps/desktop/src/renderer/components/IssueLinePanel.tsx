import type { DialogueLine } from "../../shared/projectTypes";
import type { IssueLineItem } from "../issueNavigation";

export type { IssueLineItem } from "../issueNavigation";

type IssueLinePanelProps = {
  issues: IssueLineItem[];
  currentIssueId: string | null;
  onSelectLine: (line: DialogueLine) => void;
};

export function IssueLinePanel({ issues, currentIssueId, onSelectLine }: IssueLinePanelProps) {
  if (issues.length === 0) {
    return <p className="empty-state">문제 라인이 없습니다.</p>;
  }

  return (
    <div className="issue-line-panel" aria-label="문제 라인 목록">
      {issues.map(({ line, reasons }) => (
        <button
          type="button"
          key={line.id}
          className={line.id === currentIssueId ? "issue-line-row selected" : "issue-line-row"}
          aria-label={`문제 라인 ${line.order} 선택`}
          aria-current={line.id === currentIssueId ? "true" : undefined}
          aria-describedby={`issue-line-description-${line.id}`}
          onClick={() => onSelectLine(line)}
        >
          <span className="issue-line-id">#{line.order}</span>
          <span className="issue-line-copy" id={`issue-line-description-${line.id}`}>
            <span className="issue-line-reasons">
              {reasons.map((reason) => <span key={reason}>{reason}</span>)}
            </span>
            <span className="issue-line-context">{line.sourceText || line.aiTranslation || line.userTranslation || "내용 없음"}</span>
            <small>
              {line.pageNumber}페이지 · {line.speaker ? `화자 ${line.speaker}` : "화자 없음"}
            </small>
          </span>
          <span className="issue-line-status">문제 {reasons.length}</span>
        </button>
      ))}
    </div>
  );
}
