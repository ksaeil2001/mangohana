import { describe, expect, it, vi } from "vitest";
import { normalizeInpaintingImageBytes } from "../../src/main/inpaintingImageGeometry";

type NativeImageMock = {
  getSize: () => { width: number; height: number };
  resize: (options: { width: number; height: number; quality: "best" }) => NativeImageMock;
  toPNG: () => Buffer;
};

const image = (
  size: { width: number; height: number },
  png: Buffer
): NativeImageMock => ({
  getSize: () => size,
  resize: vi.fn(() => image({ width: size.width, height: size.height }, png)),
  toPNG: vi.fn(() => png)
});

describe("inpainting image geometry", () => {
  it("normalizes a same-size edited image to decoded PNG bytes", () => {
    const source = image({ width: 100, height: 80 }, Buffer.from("source"));
    const edited = image({ width: 100, height: 80 }, Buffer.from("edited-png"));

    const result = normalizeInpaintingImageBytes({
      sourceImageBytes: Buffer.from([1, 2, 3]),
      editedImageBytes: Buffer.from([4, 5, 6]),
      decodeImage: vi
        .fn()
        .mockReturnValueOnce(source)
        .mockReturnValueOnce(edited)
    });

    expect(result).toEqual(Buffer.from("edited-png"));
    expect(edited.resize).not.toHaveBeenCalled();
    expect(edited.toPNG).toHaveBeenCalledTimes(1);
  });

  it("resizes an aspect-compatible edited image to the source canvas before PNG encoding", () => {
    const source = image({ width: 100, height: 80 }, Buffer.from("source"));
    const resized = image({ width: 100, height: 80 }, Buffer.from("resized-png"));
    const edited = image({ width: 200, height: 160 }, Buffer.from("edited"));
    edited.resize = vi.fn(() => resized);
    const decodeImage = vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(edited);

    const result = normalizeInpaintingImageBytes({
      sourceImageBytes: Buffer.from([1]),
      editedImageBytes: Buffer.from([2]),
      decodeImage
    });

    expect(result).toEqual(Buffer.from("resized-png"));
    expect(edited.resize).toHaveBeenCalledWith({ width: 100, height: 80, quality: "best" });
    expect(resized.toPNG).toHaveBeenCalledTimes(1);
  });

  it("rejects edited images whose aspect ratio differs by more than 0.5 percent", () => {
    const decodeImage = vi
      .fn()
      .mockReturnValueOnce(image({ width: 100, height: 80 }, Buffer.from("source")))
      .mockReturnValueOnce(image({ width: 100, height: 79 }, Buffer.from("edited")));

    expect(() =>
      normalizeInpaintingImageBytes({
        sourceImageBytes: Buffer.from([1]),
        editedImageBytes: Buffer.from([2]),
        decodeImage
      })
    ).toThrow(/aspect ratio/i);
  });

  it("rejects invalid and zero-sized decoded canvases with a clear error", () => {
    const decodeImage = vi.fn().mockReturnValue({
      getSize: () => ({ width: 0, height: 80 }),
      resize: vi.fn(),
      toPNG: vi.fn()
    });

    expect(() =>
      normalizeInpaintingImageBytes({
        sourceImageBytes: Buffer.from([1]),
        editedImageBytes: Buffer.from([2]),
        decodeImage
      })
    ).toThrow(/invalid.*canvas|dimensions/i);
  });

  it("rejects empty bytes and decoder failures before reading canvas geometry", () => {
    expect(() =>
      normalizeInpaintingImageBytes({
        sourceImageBytes: Buffer.alloc(0),
        editedImageBytes: Buffer.from([2]),
        decodeImage: vi.fn()
      })
    ).toThrow(/invalid source inpainting image bytes/i);

    expect(() =>
      normalizeInpaintingImageBytes({
        sourceImageBytes: Buffer.from([1]),
        editedImageBytes: Buffer.from([2]),
        decodeImage: vi.fn(() => {
          throw new Error("decoder failed");
        })
      })
    ).toThrow(/invalid source inpainting image: decoder failed/i);
  });
});
