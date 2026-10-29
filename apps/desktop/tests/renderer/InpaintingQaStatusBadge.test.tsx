import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InpaintingQaStatusBadge } from "../../src/renderer/components/InpaintingQaStatusBadge.js";
import type { InpaintingQaResult } from "../../src/shared/inpaintingQa.js";

describe("InpaintingQaStatusBadge", () => {
  it("renders null when qaResult is undefined", () => {
    const { container } = render(<InpaintingQaStatusBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("renders pass badge for PASS status", () => {
    const passResult: InpaintingQaResult = {
      qaStatus: "pass",
      cleanlinessScore: 1.0,
      residualRegions: [],
      attemptCount: 1,
      maxRetryAttempts: 2,
      evaluatedAt: new Date().toISOString()
    };

    render(<InpaintingQaStatusBadge qaResult={passResult} />);
    expect(screen.getByText(/QA 통과 \(PASS\)/)).toBeInTheDocument();
    expect(screen.getByText(/청결도 100%/)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "인페인팅 QA 통과 · 사용자 승인과 별도" })).toBeVisible();
  });

  it("renders retry badge and triggers onRetry when clicked", () => {
    const retryResult: InpaintingQaResult = {
      qaStatus: "retry",
      cleanlinessScore: 0.85,
      residualRegions: [
        {
          bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
          residualConfidence: 0.4,
          severity: "minor"
        }
      ],
      attemptCount: 1,
      maxRetryAttempts: 2,
      evaluatedAt: new Date().toISOString()
    };

    const handleRetry = vi.fn();
    render(<InpaintingQaStatusBadge qaResult={retryResult} onRetry={handleRetry} />);

    expect(screen.getByText(/자동 재시도 권장 \(RETRY\)/)).toBeInTheDocument();
    const retryBtn = screen.getByRole("button", { name: /마스크 확장 재시도/ });
    fireEvent.click(retryBtn);

    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it("renders manual review badge for MANUAL_REVIEW status", () => {
    const manualResult: InpaintingQaResult = {
      qaStatus: "manual_review",
      cleanlinessScore: 0.5,
      residualRegions: [
        {
          bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          residualConfidence: 0.9,
          severity: "severe"
        }
      ],
      attemptCount: 2,
      maxRetryAttempts: 2,
      reason: "최대 재시도 횟수 초과",
      evaluatedAt: new Date().toISOString()
    };

    const handleManualEdit = vi.fn();
    render(<InpaintingQaStatusBadge qaResult={manualResult} onManualEdit={handleManualEdit} />);

    expect(screen.getByText(/수동 검수 필요 \(MANUAL_REVIEW\)/)).toBeInTheDocument();
    expect(screen.getByText(/최대 재시도 횟수 초과/)).toBeInTheDocument();

    const manualBtn = screen.getByRole("button", { name: /수동 브러시 수정/ });
    fireEvent.click(manualBtn);
    expect(handleManualEdit).toHaveBeenCalledTimes(1);
  });
});
