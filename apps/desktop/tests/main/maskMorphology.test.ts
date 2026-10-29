import { describe, expect, it } from "vitest";
import {
  applyConservativeMaskDilation,
  calculateAdaptiveDilationRadius,
  clipMaskToNormalizedBounds,
  dilateBinaryMask
} from "../../src/shared/maskMorphology.js";

describe("maskMorphology", () => {
  describe("calculateAdaptiveDilationRadius", () => {
    it("computes smaller radius for small speech bubble bounding boxes", () => {
      const radius = calculateAdaptiveDilationRadius({
        bboxWidth: 0.1,
        bboxHeight: 0.1,
        canvasWidth: 1000,
        canvasHeight: 1500,
        minRadius: 3,
        maxRadius: 24
      });

      expect(radius).toBeGreaterThanOrEqual(3);
      expect(radius).toBeLessThanOrEqual(15);
    });

    it("computes larger radius for large bounding boxes on high-resolution canvases", () => {
      const radius = calculateAdaptiveDilationRadius({
        bboxWidth: 0.5,
        bboxHeight: 0.4,
        canvasWidth: 2400,
        canvasHeight: 3600,
        minRadius: 3,
        maxRadius: 24
      });

      expect(radius).toBe(24); // Hits or approaches maxRadius
    });

    it("respects custom minRadius and maxRadius constraints", () => {
      const minConstrained = calculateAdaptiveDilationRadius({
        bboxWidth: 0.01,
        bboxHeight: 0.01,
        canvasWidth: 500,
        canvasHeight: 500,
        minRadius: 5,
        maxRadius: 10
      });
      expect(minConstrained).toBe(5);

      const maxConstrained = calculateAdaptiveDilationRadius({
        bboxWidth: 0.9,
        bboxHeight: 0.9,
        canvasWidth: 4000,
        canvasHeight: 4000,
        minRadius: 2,
        maxRadius: 12
      });
      expect(maxConstrained).toBe(12);
    });
  });

  describe("dilateBinaryMask", () => {
    it("expands a single central pixel by given radius", () => {
      const width = 7;
      const height = 7;
      const mask = new Uint8Array(width * height);
      // Set center pixel (3, 3) to 255
      mask[3 * width + 3] = 255;

      const dilated = dilateBinaryMask(mask, width, height, 2);

      // Center should be 255
      expect(dilated[3 * width + 3]).toBe(255);
      // Distance 1 (3, 2) should be 255
      expect(dilated[2 * width + 3]).toBe(255);
      // Distance 2 (3, 1) should be 255
      expect(dilated[1 * width + 3]).toBe(255);
      // Distance 3 (3, 0) should be 0 (outside radius 2)
      expect(dilated[0 * width + 3]).toBe(0);
      // Corner (0, 0) should be 0
      expect(dilated[0]).toBe(0);
    });

    it("returns unchanged copy when radius is 0", () => {
      const width = 4;
      const height = 4;
      const mask = new Uint8Array(width * height);
      mask[5] = 255;

      const dilated = dilateBinaryMask(mask, width, height, 0);
      expect(dilated).toEqual(mask);
    });

    it("throws on invalid dimensions", () => {
      expect(() => dilateBinaryMask(new Uint8Array(10), 4, 4, 1)).toThrow(/dimensions/i);
    });
  });

  describe("clipMaskToNormalizedBounds", () => {
    it("zeros out pixels outside the specified normalized rectangle", () => {
      const width = 10;
      const height = 10;
      const mask = new Uint8Array(width * height).fill(255);

      // Safe area from (0.2, 0.2) to (0.8, 0.8) -> x: 2..8, y: 2..8
      const clipped = clipMaskToNormalizedBounds(mask, width, height, {
        x: 0.2,
        y: 0.2,
        width: 0.6,
        height: 0.6
      });

      // Inside safe area (5, 5) -> should be 255
      expect(clipped[5 * width + 5]).toBe(255);
      // Outside safe area (0, 0) -> should be 0
      expect(clipped[0]).toBe(0);
      // Outside safe area (9, 9) -> should be 0
      expect(clipped[9 * width + 9]).toBe(0);
    });
  });

  describe("applyConservativeMaskDilation (PanelCleaner principle)", () => {
    it("clamps large dilation radii to conservative bounds", () => {
      const width = 15;
      const height = 15;
      const mask = new Uint8Array(width * height);
      mask[7 * width + 7] = 255;

      // Passing aggressive radius 20 should be clamped to 6 max
      const conservative = applyConservativeMaskDilation({
        mask,
        width,
        height,
        radius: 20
      });

      // Pixel within radius 6 (7, 1) should be 255
      expect(conservative[1 * width + 7]).toBe(255);
      // Pixel outside radius 6 (7, 0) should be 0
      expect(conservative[0 * width + 7]).toBe(0);
    });

    it("clips to safe area if provided", () => {
      const width = 10;
      const height = 10;
      const mask = new Uint8Array(width * height);
      mask[5 * width + 5] = 255;

      const conservative = applyConservativeMaskDilation({
        mask,
        width,
        height,
        radius: 3,
        safeArea: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } // only (4..6, 4..6)
      });

      expect(conservative[5 * width + 5]).toBe(255);
      expect(conservative[2 * width + 5]).toBe(0);
    });
  });
});
