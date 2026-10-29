import { nativeImage } from "electron";
import type { NormalizedBbox } from "../shared/speechBubbleExtraction.js";
import type { ProductionOcrCropTransform, ProductionOcrGroup } from "../shared/productionOcr.js";

export type PixelSize = {
  width: number;
  height: number;
};

export type PixelCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function cropImageToPng(args: {
  imageBytes: Buffer;
  bbox: NormalizedBbox;
  paddingRatio?: number;
}): Buffer {
  const image = nativeImage.createFromBuffer(args.imageBytes);
  const size = image.getSize();
  const rect = buildPaddedCropRect(args.bbox, size, args.paddingRatio ?? 0.08);
  return image.crop(rect).toPNG();
}

export function cropProductionOcrGroup(args: {
  imageBytes: Buffer;
  group: ProductionOcrGroup;
}): { cropBytes: Buffer; transform: ProductionOcrCropTransform } {
  const image = nativeImage.createFromBuffer(args.imageBytes);
  const size = image.getSize();
  if (size.width !== args.group.imageWidth || size.height !== args.group.imageHeight) {
    throw new Error("Production OCR crop source dimensions changed");
  }
  const cropBboxPx = buildPaddedCropRect(args.group.bbox, size, 0.08);
  return {
    cropBytes: image.crop(cropBboxPx).toPNG(),
    transform: {
      sourceBboxPx: { ...args.group.groupBboxPx },
      cropBboxPx,
      paddingRatio: 0.08,
      rotationDegrees: 0,
      imageWidth: size.width,
      imageHeight: size.height
    }
  };
}

export function buildPaddedCropRect(bbox: NormalizedBbox, size: PixelSize, paddingRatio: number): PixelCropRect {
  const imageWidth = Math.max(1, Math.round(size.width));
  const imageHeight = Math.max(1, Math.round(size.height));
  const rawX = bbox.x * imageWidth;
  const rawY = bbox.y * imageHeight;
  const rawWidth = bbox.width * imageWidth;
  const rawHeight = bbox.height * imageHeight;
  const padX = rawWidth * Math.max(0, paddingRatio);
  const padY = rawHeight * Math.max(0, paddingRatio);

  const x = clampInteger(Math.floor(rawX - padX), 0, imageWidth - 1);
  const y = clampInteger(Math.floor(rawY - padY), 0, imageHeight - 1);
  const right = clampInteger(Math.ceil(rawX + rawWidth + padX), x + 1, imageWidth);
  const bottom = clampInteger(Math.ceil(rawY + rawHeight + padY), y + 1, imageHeight);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
