import { nativeImage } from "electron";
import type { NormalizedBbox } from "../shared/speechBubbleExtraction.js";
import type { ProductionOcrCropTransform, ProductionOcrGroup } from "../shared/productionOcr.js";
import { buildPaddedCropRect, buildOcrRecognitionCrop, ocrGroupCrop } from "../shared/imageCropGeometry.js";
export { buildPaddedCropRect } from "../shared/imageCropGeometry.js";
export type { PixelSize, PixelCropRect } from "../shared/imageCropGeometry.js";

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
  groups?: readonly ProductionOcrGroup[];
}): { cropBytes: Buffer; transform: ProductionOcrCropTransform } {
  const image = nativeImage.createFromBuffer(args.imageBytes);
  const size = image.getSize();
  if (size.width !== args.group.imageWidth || size.height !== args.group.imageHeight) {
    throw new Error("Production OCR crop source dimensions changed");
  }
  const { cropBboxPx, additionalPaddingPx } = args.groups ? buildOcrRecognitionCrop(args.group, args.groups) : { cropBboxPx: ocrGroupCrop(args.group), additionalPaddingPx: undefined };
  return {
    cropBytes: image.crop(cropBboxPx).toPNG(),
    transform: {
      sourceBboxPx: { ...args.group.groupBboxPx },
      cropBboxPx,
      paddingRatio: 0.08,
      rotationDegrees: 0,
      imageWidth: size.width,
      imageHeight: size.height,
      ...(additionalPaddingPx ? { additionalPaddingPx } : {})
    }
  };
}
