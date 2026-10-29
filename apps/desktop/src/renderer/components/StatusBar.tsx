import { useState, type ReactNode } from "react";

export interface StatusBarProps {
  /* --- Processing state --- */
  isProcessing: boolean;
  processingLabel: string;

  /* --- Issue counter --- */
  issueCount: number;

  /* --- Translation progress --- */
  dialogueCount: number;
  completeCount: number;
  reviewCount: number;

  /* --- Expandable filmstrip --- */
  filmstripContent: ReactNode;

  /* --- Visibility --- */
  visible: boolean;
}

export function StatusBar({
  isProcessing,
  processingLabel,
  issueCount,
  dialogueCount,
  completeCount,
  reviewCount,
  filmstripContent,
  visible
}: StatusBarProps) {
  const [filmstripExpanded, setFilmstripExpanded] = useState(false);

  if (!visible) return null;

  const progressPercent = dialogueCount > 0
    ? Math.round((completeCount / dialogueCount) * 100)
    : 0;

  return (
    <footer
      className={[
        "trio-status-bar",
        filmstripExpanded ? "trio-status-bar-expanded" : ""
      ].filter(Boolean).join(" ")}
      aria-label="상태 표시줄"
    >
      {/* Expanded filmstrip area */}
      {filmstripExpanded ? (
        <div className="trio-status-filmstrip" aria-label="대사 상세 패널">
          {filmstripContent}
        </div>
      ) : null}

      {/* Status bar main row */}
      <div className="trio-status-bar-row">
        {/* Left: Processing indicator */}
        <div className="trio-status-left">
          {isProcessing ? (
            <span className="trio-status-processing" role="status" aria-label={processingLabel}>
              <span className="trio-status-spinner" aria-hidden="true" />
              {processingLabel}
            </span>
          ) : null}
        </div>

        {/* Center: Issue counter */}
        <div className="trio-status-center">
          {issueCount > 0 ? (
            <span className="trio-status-issues" aria-label={`검토 필요 ${issueCount}건`}>
              ⚠ {issueCount}건의 검토 필요
            </span>
          ) : null}
        </div>

        {/* Right: Progress + Filmstrip toggle */}
        <div className="trio-status-right">
          {dialogueCount > 0 ? (
            <span className="trio-status-progress" aria-label={`번역 진행률 ${progressPercent}%`}>
              번역 {progressPercent}%
              <span className="trio-status-detail">
                ({completeCount}/{dialogueCount})
              </span>
            </span>
          ) : null}
          <button
            type="button"
            className="trio-status-filmstrip-toggle"
            aria-expanded={filmstripExpanded}
            aria-label={filmstripExpanded ? "대사 패널 접기" : "대사 패널 펼치기"}
            title={filmstripExpanded ? "대사 패널 접기" : "대사 패널 펼치기"}
            onClick={() => setFilmstripExpanded((open) => !open)}
          >
            {filmstripExpanded ? "▼" : "▲"}
          </button>
        </div>
      </div>
    </footer>
  );
}
