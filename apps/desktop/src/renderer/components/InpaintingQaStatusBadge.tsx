import { Button } from "./Ui.js";
import {
  inpaintingQaStatusLabels,
  type InpaintingQaResult
} from "../../shared/inpaintingQa.js";

export type InpaintingQaStatusBadgeProps = {
  qaResult?: InpaintingQaResult;
  onRetry?: () => void;
  onManualEdit?: () => void;
  isRetrying?: boolean;
};

export function InpaintingQaStatusBadge({
  qaResult,
  onRetry,
  onManualEdit,
  isRetrying = false
}: InpaintingQaStatusBadgeProps) {
  if (!qaResult) return null;

  const { qaStatus, cleanlinessScore, residualRegions, reason, attemptCount, maxRetryAttempts } = qaResult;

  if (qaStatus === "pass") {
    return (
      <div
        className="trio-qa-status-badge pass"
        role="status"
        aria-label="인페인팅 QA 통과 · 사용자 승인과 별도"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--trio-space-1)",
          padding: "var(--trio-space-1) var(--trio-space-2)",
          borderRadius: "var(--trio-radius-sm)",
          background: "var(--trio-success-soft)",
          color: "var(--trio-success)",
          border: "1px solid var(--trio-border-soft)",
          fontSize: "var(--trio-text-caption)",
          fontWeight: 600
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>QA 통과 (PASS) · 청결도 {Math.round(cleanlinessScore * 100)}%</span>
      </div>
    );
  }

  if (qaStatus === "retry") {
    return (
      <div
        className="trio-qa-status-badge retry"
        role="status"
        aria-label="인페인팅 QA 재시도 권장"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--trio-space-2)",
          padding: "var(--trio-space-1) var(--trio-space-2)",
          borderRadius: "var(--trio-radius-sm)",
          background: "var(--trio-warning-soft)",
          color: "var(--trio-warning)",
          border: "1px solid var(--trio-border-soft)",
          fontSize: "var(--trio-text-caption)"
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <span style={{ fontWeight: 600 }}>
          {inpaintingQaStatusLabels.retry} (잔여 {residualRegions.length}개소, {attemptCount}/{maxRetryAttempts}회차)
        </span>
        {onRetry && (
          <Button
            type="button"
            variant="primary"
            size="compact"
            style={{ height: "auto" }}
            disabled={isRetrying}
            onClick={onRetry}
          >
            {isRetrying ? "재시도 중..." : "⚡ 마스크 확장 재시도"}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className="trio-qa-status-badge manual"
      role="status"
      aria-label="인페인팅 QA 수동 검수 필요"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--trio-space-2)",
        padding: "var(--trio-space-1) var(--trio-space-2)",
        borderRadius: "var(--trio-radius-sm)",
        background: "var(--trio-warning-soft)",
        color: "var(--trio-warning)",
        border: "1px solid var(--trio-border-soft)",
        fontSize: "var(--trio-text-caption)"
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="15" y1="9" x2="9" y2="15"></line>
        <line x1="9" y1="9" x2="15" y2="15"></line>
      </svg>
      <div>
        <strong style={{ display: "block" }}>{inpaintingQaStatusLabels.manual_review}</strong>
        {reason && <small style={{ display: "block", color: "var(--ink-muted)", fontSize: "var(--trio-text-caption)" }}>{reason}</small>}
      </div>
      {onManualEdit && (
        <Button
          type="button"
          variant="secondary"
          size="compact"
          style={{ height: "auto" }}
          onClick={onManualEdit}
        >
          🖌️ 수동 브러시 수정
        </Button>
      )}
    </div>
  );
}
