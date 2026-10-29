import { describe, expect, it } from "vitest";
import {
  calculateCleanlinessScore,
  evaluateInpaintingQuality,
  type ResidualTextRegion
} from "../../src/shared/inpaintingQa.js";

describe("inpaintingQa", () => {
  it("evaluates to PASS when there are no residual text regions", () => {
    const result = evaluateInpaintingQuality({
      residualRegions: [],
      attemptCount: 1,
      maxRetryAttempts: 2
    });

    expect(result.qaStatus).toBe("pass");
    expect(result.cleanlinessScore).toBe(1.0);
    expect(result.residualRegions).toEqual([]);
    expect(result.reason).toContain("통과");
  });

  it("filters out residual regions below confidence threshold and passes if empty", () => {
    const lowConfRegions: ResidualTextRegion[] = [
      {
        bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        residualConfidence: 0.15, // Below 0.25 threshold
        severity: "minor"
      }
    ];

    const result = evaluateInpaintingQuality({
      residualRegions: lowConfRegions,
      attemptCount: 1,
      maxRetryAttempts: 2
    });

    expect(result.qaStatus).toBe("pass");
    expect(result.cleanlinessScore).toBe(1.0);
  });

  it("evaluates to RETRY when minor residual text is detected on initial attempt", () => {
    const minorRegions: ResidualTextRegion[] = [
      {
        bbox: { x: 0.2, y: 0.3, width: 0.15, height: 0.08 },
        residualConfidence: 0.45,
        severity: "minor",
        detectedText: "..."
      }
    ];

    const result = evaluateInpaintingQuality({
      residualRegions: minorRegions,
      attemptCount: 1,
      maxRetryAttempts: 2
    });

    expect(result.qaStatus).toBe("retry");
    expect(result.cleanlinessScore).toBeLessThan(1.0);
    expect(result.residualRegions).toHaveLength(1);
    expect(result.reason).toContain("재인페인팅을 권장");
  });

  it("evaluates to MANUAL_REVIEW when max retry attempts are reached", () => {
    const minorRegions: ResidualTextRegion[] = [
      {
        bbox: { x: 0.2, y: 0.3, width: 0.15, height: 0.08 },
        residualConfidence: 0.45,
        severity: "minor"
      }
    ];

    const result = evaluateInpaintingQuality({
      residualRegions: minorRegions,
      attemptCount: 2, // Max reached
      maxRetryAttempts: 2
    });

    expect(result.qaStatus).toBe("manual_review");
    expect(result.reason).toContain("최대 재시도 횟수");
  });

  it("evaluates to MANUAL_REVIEW when multiple severe residuals are detected", () => {
    const severeRegions: ResidualTextRegion[] = [
      {
        bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        residualConfidence: 0.85,
        severity: "severe"
      },
      {
        bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
        residualConfidence: 0.75,
        severity: "severe"
      },
      {
        bbox: { x: 0.7, y: 0.7, width: 0.2, height: 0.2 },
        residualConfidence: 0.7,
        severity: "severe"
      }
    ];

    const result = evaluateInpaintingQuality({
      residualRegions: severeRegions,
      attemptCount: 1,
      maxRetryAttempts: 2
    });

    expect(result.qaStatus).toBe("manual_review");
    expect(result.reason).toContain("수동 브러시 수정");
    expect(result.recommendedAction).toBe("manual_brush");
  });

  it("provides recommended dilation and action for automatic retry (BallonsTranslator-vibe principle)", () => {
    const minorRegions: ResidualTextRegion[] = [
      {
        bbox: { x: 0.2, y: 0.3, width: 0.15, height: 0.08 },
        residualConfidence: 0.45,
        severity: "minor"
      }
    ];

    const result = evaluateInpaintingQuality({
      residualRegions: minorRegions,
      attemptCount: 1,
      maxRetryAttempts: 2
    });

    expect(result.recommendedAction).toBe("auto_retry_dilate");
    expect(result.recommendedDilation).toBe(2);
  });

  it("calculates cleanliness score properly", () => {
    expect(calculateCleanlinessScore([])).toBe(1.0);

    const scoreWithMinor = calculateCleanlinessScore([
      {
        bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        residualConfidence: 0.3,
        severity: "minor"
      }
    ]);
    expect(scoreWithMinor).toBeGreaterThan(0.8);
    expect(scoreWithMinor).toBeLessThan(1.0);
  });
});
