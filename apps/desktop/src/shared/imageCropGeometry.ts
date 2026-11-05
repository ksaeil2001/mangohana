import type { NormalizedBbox } from "./speechBubbleExtraction.js";
import { MANGA_OCR_MODELS, PRODUCTION_OCR_CONTRACT, type ProductionOcrGroup, type ProductionOcrAdditionalPaddingPx } from "./productionOcr.js";

export type PixelSize = { width: number; height: number };
export type PixelCropRect = { x: number; y: number; width: number; height: number };

/** Shared by OCR selection and the actual image crop to keep padding identical. */
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
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ocrGroupCrop(group: ProductionOcrGroup): PixelCropRect {
  return baseProductionOcrCrop(group.groupBboxPx, group.imageWidth, group.imageHeight);
}

export function baseProductionOcrCrop(box: PixelCropRect, imageWidth: number, imageHeight: number): PixelCropRect {
  return buildPaddedCropRect({x:box.x/imageWidth,y:box.y/imageHeight,width:box.width/imageWidth,height:box.height/imageHeight}, {width:imageWidth,height:imageHeight}, 0.08);
}

export function buildOcrRecognitionCrop(group: ProductionOcrGroup, groups: readonly ProductionOcrGroup[]): {
  cropBboxPx: PixelCropRect; additionalPaddingPx?: ProductionOcrAdditionalPaddingPx;
} {
  const base = ocrGroupCrop(group);
  if (group.sourceDetectionIds.length !== 1
    || group.memberModels?.[0]?.modelId !== PRODUCTION_OCR_CONTRACT.detector.modelId
    || group.memberSupportModels?.[0]?.modelId !== MANGA_OCR_MODELS.detector.modelId) return { cropBboxPx: base };
  const box = group.groupBboxPx;
  const thickness = Math.min(box.width, box.height);
  const requested = { left: 0, top: 0, right: 0, bottom: 0 };
  if (group.orientation === "vertical" && box.height / box.width >= 3) {
    // Total cross-line padding is 40%, matching the fixed local comparison.
    requested.left = Math.max(0, base.x - Math.max(0, Math.floor(box.x - box.width * 0.4)));
    requested.right = Math.max(0, Math.min(group.imageWidth, Math.ceil(box.x + box.width * 1.4)) - base.x - base.width);
  } else if (Math.max(box.width, box.height) / thickness < 1.5) {
    // A short region can omit the trailing part of a handwritten long stroke.
    // This geometric heuristic does not assign a new reading orientation.
    if (box.height >= box.width) requested.bottom = Math.min(Math.ceil(thickness), group.imageHeight - base.y - base.height);
    else requested.right = Math.min(Math.ceil(thickness), group.imageWidth - base.x - base.width);
  }
  const extra = { left: 0, top: 0, right: 0, bottom: 0 };
  const rect = (padding: ProductionOcrAdditionalPaddingPx): PixelCropRect => ({
    x: base.x - padding.left, y: base.y - padding.top,
    width: base.width + padding.left + padding.right, height: base.height + padding.top + padding.bottom
  });
  const avoidsIntrusion = (crop: PixelCropRect) => groups.every((other) => other.groupId === group.groupId
    || intersectionArea(crop, other.groupBboxPx) <= intersectionArea(base, other.groupBboxPx));
  for (const edge of ["left", "top", "right", "bottom"] as const) {
    let low = 0, high = Math.min(requested[edge], Math.ceil(thickness));
    while (low < high) {
      const trial = Math.ceil((low + high) / 2);
      if (avoidsIntrusion(rect({ ...extra, [edge]: trial }))) low = trial;
      else high = trial - 1;
    }
    extra[edge] = low;
  }
  const cropBboxPx = rect(extra);
  if (!avoidsIntrusion(cropBboxPx)) throw new Error("OCR context crop intrudes on another text group");
  return Object.values(extra).some((value) => value > 0) ? { cropBboxPx, additionalPaddingPx: extra } : { cropBboxPx: base };
}

function intersectionArea(a: PixelCropRect, b: PixelCropRect): number {
  return Math.max(0, Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))
    * Math.max(0, Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
}

export function avoidsNewOcrCropIntrusion(before: readonly ProductionOcrGroup[], expanded: ProductionOcrGroup): boolean {
  const previous = before.find((group) => group.sourceDetectionIds.some((id) => expanded.sourceDetectionIds.includes(id)));
  const crop = ocrGroupCrop(expanded);
  const previousCrop = previous ? ocrGroupCrop(previous) : undefined;
  return before.every((group) => group === previous || intersectionArea(crop, group.groupBboxPx)
    <= (previousCrop ? intersectionArea(previousCrop, group.groupBboxPx) : 0));
}
