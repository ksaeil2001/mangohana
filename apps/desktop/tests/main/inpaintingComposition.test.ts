import { describe, expect, it } from "vitest";
import { compositeRawRgbaBuffers } from "../../src/main/inpaintingImageGeometry.js";

describe("inpaintingComposition", () => {
  it("preserves 100% of source pixels where mask is 0", () => {
    const width = 2;
    const height = 2;
    // Source: 4 red pixels (255, 0, 0, 255)
    const sourceRgba = new Uint8Array([
      255, 0, 0, 255,
      255, 0, 0, 255,
      255, 0, 0, 255,
      255, 0, 0, 255
    ]);
    // Edited: 4 blue pixels (0, 0, 255, 255)
    const editedRgba = new Uint8Array([
      0, 0, 255, 255,
      0, 0, 255, 255,
      0, 0, 255, 255,
      0, 0, 255, 255
    ]);
    // Mask: only top-left pixel is masked (255), others are 0
    const maskBuffer = new Uint8Array([255, 0, 0, 0]);

    const result = compositeRawRgbaBuffers({
      sourceRgba,
      editedRgba,
      maskBuffer,
      width,
      height
    });

    // Pixel 0 (masked): should be blue (0, 0, 255, 255)
    expect(Array.from(result.slice(0, 4))).toEqual([0, 0, 255, 255]);
    // Pixel 1 (unmasked): should remain 100% red (255, 0, 0, 255)
    expect(Array.from(result.slice(4, 8))).toEqual([255, 0, 0, 255]);
    // Pixel 2 (unmasked): should remain 100% red (255, 0, 0, 255)
    expect(Array.from(result.slice(8, 12))).toEqual([255, 0, 0, 255]);
    // Pixel 3 (unmasked): should remain 100% red (255, 0, 0, 255)
    expect(Array.from(result.slice(12, 16))).toEqual([255, 0, 0, 255]);
  });

  it("smoothly blends feathered edge pixels when mask value is intermediate", () => {
    const width = 1;
    const height = 1;
    // Source: black (0, 0, 0, 255)
    const sourceRgba = new Uint8Array([0, 0, 0, 255]);
    // Edited: white (200, 200, 200, 255)
    const editedRgba = new Uint8Array([200, 200, 200, 255]);
    // 50% mask (128)
    const maskBuffer = new Uint8Array([128]);

    const result = compositeRawRgbaBuffers({
      sourceRgba,
      editedRgba,
      maskBuffer,
      width,
      height
    });

    // Roughly half (100, 100, 100, 255)
    expect(result[0]).toBeGreaterThanOrEqual(99);
    expect(result[0]).toBeLessThanOrEqual(101);
    expect(result[3]).toBe(255);
  });
});
