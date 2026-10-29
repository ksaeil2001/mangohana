import { describe, expect, it, vi } from "vitest";
import { buildPaddedCropRect, cropImageToPng, cropProductionOcrGroup } from "../../src/main/imageCrop";

const electronMocks = vi.hoisted(() => ({
  crop: vi.fn(),
  toPNG: vi.fn(),
  getSize: vi.fn(),
  createFromBuffer: vi.fn()
}));

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: electronMocks.createFromBuffer
  }
}));

describe("imageCrop", () => {
  it("expands normalized bbox by padding and clamps to image bounds", () => {
    expect(
      buildPaddedCropRect(
        { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
        { width: 1000, height: 500 },
        0.1
      )
    ).toEqual({ x: 70, y: 90, width: 360, height: 120 });

    expect(
      buildPaddedCropRect(
        { x: 0.95, y: 0.9, width: 0.1, height: 0.2 },
        { width: 1000, height: 500 },
        0.2
      )
    ).toEqual({ x: 930, y: 430, width: 70, height: 70 });
  });

  it("returns at least a 1x1 crop rectangle for tiny boxes", () => {
    expect(
      buildPaddedCropRect(
        { x: 0.5, y: 0.5, width: 0, height: 0 },
        { width: 1000, height: 500 },
        0
      )
    ).toEqual({ x: 500, y: 250, width: 1, height: 1 });
  });

  it("crops an image buffer and returns PNG bytes", () => {
    const pngBytes = Buffer.from([1, 2, 3]);
    electronMocks.toPNG.mockReturnValue(pngBytes);
    electronMocks.crop.mockReturnValue({ toPNG: electronMocks.toPNG });
    electronMocks.getSize.mockReturnValue({ width: 100, height: 50 });
    electronMocks.createFromBuffer.mockReturnValue({
      getSize: electronMocks.getSize,
      crop: electronMocks.crop
    });

    expect(
      cropImageToPng({
        imageBytes: Buffer.from([9, 8, 7]),
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
        paddingRatio: 0.1
      })
    ).toBe(pngBytes);
    expect(electronMocks.createFromBuffer).toHaveBeenCalledWith(Buffer.from([9, 8, 7]));
    expect(electronMocks.crop).toHaveBeenCalledWith({ x: 7, y: 9, width: 36, height: 12 });
  });

  it("crops a Production OCR group without rotating it and records the source transform", () => {
    const pngBytes = Buffer.from([4, 5, 6]);
    electronMocks.toPNG.mockReturnValue(pngBytes);
    electronMocks.crop.mockReturnValue({ toPNG: electronMocks.toPNG });
    electronMocks.getSize.mockReturnValue({ width: 200, height: 100 });
    electronMocks.createFromBuffer.mockReturnValue({
      getSize: electronMocks.getSize,
      crop: electronMocks.crop
    });

    const result = cropProductionOcrGroup({
      imageBytes: Buffer.from("source"),
      group: {
        groupId: "group-1",
        sourceDetectionIds: ["det-1"],
        memberQuadsPx: [[{ x: 20, y: 10 }, { x: 120, y: 10 }, { x: 120, y: 30 }, { x: 20, y: 30 }]],
        memberScores: [0.9],
        groupBboxPx: { x: 20, y: 10, width: 100, height: 20 },
        bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
        polygon: [{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.6, y: 0.3 }, { x: 0.1, y: 0.3 }],
        orientation: "vertical",
        readingOrder: 1,
        confidence: 0.9,
        imageWidth: 200,
        imageHeight: 100
      }
    });

    expect(result).toEqual({
      cropBytes: pngBytes,
      transform: {
        sourceBboxPx: { x: 20, y: 10, width: 100, height: 20 },
        cropBboxPx: { x: 12, y: 8, width: 116, height: 24 },
        paddingRatio: 0.08,
        rotationDegrees: 0,
        imageWidth: 200,
        imageHeight: 100
      }
    });
    expect(electronMocks.crop).toHaveBeenCalledWith({ x: 12, y: 8, width: 116, height: 24 });
  });
});
