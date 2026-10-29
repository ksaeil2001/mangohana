import type { NormalizedBbox } from "../shared/speechBubbleExtraction";

export type InpaintingMaskDraft = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  bounds: NormalizedBbox;
};

export function isMatchingMaskDraft(
  draft: InpaintingMaskDraft | null | undefined,
  width: number,
  height: number
): draft is InpaintingMaskDraft {
  return Boolean(
    draft &&
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      width > 0 &&
      height > 0 &&
      draft.width === width &&
      draft.height === height &&
      draft.pixels instanceof Uint8ClampedArray &&
      draft.pixels.length === width * height * 4
  );
}

export function cloneMaskDraft(draft: InpaintingMaskDraft): InpaintingMaskDraft {
  return {
    width: draft.width,
    height: draft.height,
    pixels: new Uint8ClampedArray(draft.pixels),
    bounds: { ...draft.bounds }
  };
}
