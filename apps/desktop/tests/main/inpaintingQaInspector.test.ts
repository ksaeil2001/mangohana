import { describe, expect, it } from "vitest";
import { inspectInpaintingQa } from "../../src/main/inpaintingQaInspector.js";

describe("inpaintingQaInspector", () => {
  it("inspects valid image bytes and passes locally without errors", async () => {
    // 100 bytes dummy PNG buffer
    const dummyImage = Buffer.alloc(128, 0xff);
    const dummyMask = Buffer.alloc(128, 0x00);

    const result = await inspectInpaintingQa({
      inpaintedImageBytes: dummyImage,
      maskBytes: dummyMask,
      attemptCount: 1,
      maxRetryAttempts: 2
    });

    expect(result.qaStatus).toBe("pass");
    expect(result.cleanlinessScore).toBe(1.0);
    expect(result.attemptCount).toBe(1);
    expect(result.maxRetryAttempts).toBe(2);
  });

  it("handles empty or invalid image buffer gracefully by marking manual review", async () => {
    const invalidImage = Buffer.alloc(0);

    const result = await inspectInpaintingQa({
      inpaintedImageBytes: invalidImage,
      attemptCount: 1
    });

    expect(result.qaStatus).toBe("manual_review");
    expect(result.cleanlinessScore).toBe(0.0);
    expect(result.reason).toContain("올바르지 않습니다");
  });
});
