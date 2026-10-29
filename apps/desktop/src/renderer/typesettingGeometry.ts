import type { NormalizedBbox } from "../shared/speechBubbleExtraction.js";
import type { DialogueTypesetting } from "../shared/projectTypes.js";
import type { BubbleShape } from "../shared/typesettingShape.js";
import {
  DEFAULT_TYPESETTING_SAFE_AREA,
  TYPESETTING_MIN_SIZE,
  type TypesettingDraft,
  type TypesettingSafeArea,
  isValidTypesettingBbox
} from "../shared/typesettingGeometry.js";

export * from "../shared/typesettingGeometry.js";

export type ClientPoint = {
  clientX: number;
  clientY: number;
};

export type NormalizedPoint = {
  x: number;
  y: number;
};

export type TypesettingResizeHandle = "nw" | "ne" | "sw" | "se";

type MediaRect = Pick<DOMRect, "left" | "top" | "width" | "height"> & Partial<Pick<DOMRect, "right" | "bottom">>;

export function dialogueTypesettingFromDraft(draft: TypesettingDraft): DialogueTypesetting {
  const typesetting: DialogueTypesetting = {
    bbox: { ...draft.bbox },
    writingMode: draft.writingMode
  };
  if (Number.isFinite(draft.rotationDegrees)) {
    typesetting.rotationDegrees = draft.rotationDegrees;
  }
  if (draft.shape) typesetting.shape = draft.shape;
  return typesetting;
}

export function createTypesettingDraft(args: {
  id: string;
  sourceOcrId: string;
  ocrBbox: NormalizedBbox;
  safeArea?: TypesettingSafeArea | null;
  shape?: BubbleShape;
}): TypesettingDraft {
  const safeArea = normalizeSafeArea(args.safeArea);
  const bbox = constrainBboxToSafeArea(cloneBbox(args.ocrBbox), safeArea);
  return {
    id: args.id,
    sourceOcrId: args.sourceOcrId,
    bbox,
    rotationDegrees: 0,
    writingMode: "horizontal-tb",
    shape: args.shape ?? "ellipse"
  };
}


export function deriveTypesettingSafeArea(ocrBbox: NormalizedBbox | null | undefined): TypesettingSafeArea {
  if (!ocrBbox) return { ...DEFAULT_TYPESETTING_SAFE_AREA };
  return clampBbox({
    x: ocrBbox.x - 0.02,
    y: ocrBbox.y - 0.02,
    width: ocrBbox.width + 0.04,
    height: ocrBbox.height + 0.04
  });
}

export function clientPointToNormalized(point: ClientPoint, mediaRect: MediaRect): NormalizedPoint {
  const width = Number.isFinite(mediaRect.width) && mediaRect.width > 0 ? mediaRect.width : 1;
  const height = Number.isFinite(mediaRect.height) && mediaRect.height > 0 ? mediaRect.height : 1;
  return {
    x: clampUnit((point.clientX - mediaRect.left) / width),
    y: clampUnit((point.clientY - mediaRect.top) / height)
  };
}

export function normalizedPointToClient(point: NormalizedPoint, mediaRect: MediaRect): ClientPoint {
  return {
    clientX: mediaRect.left + point.x * mediaRect.width,
    clientY: mediaRect.top + point.y * mediaRect.height
  };
}

export function moveTypesettingDraft(
  draft: TypesettingDraft,
  delta: NormalizedPoint,
  safeArea: TypesettingSafeArea = DEFAULT_TYPESETTING_SAFE_AREA
): TypesettingDraft {
  const normalizedSafeArea = normalizeSafeArea(safeArea);
  const bbox = draft.bbox;
  const maxX = normalizedSafeArea.x + normalizedSafeArea.width - bbox.width;
  const maxY = normalizedSafeArea.y + normalizedSafeArea.height - bbox.height;
  const candidate = cloneDraft(draft, {
    bbox: {
      x: clampNumber(bbox.x + finiteOrZero(delta.x), normalizedSafeArea.x, Math.max(normalizedSafeArea.x, maxX)),
      y: clampNumber(bbox.y + finiteOrZero(delta.y), normalizedSafeArea.y, Math.max(normalizedSafeArea.y, maxY)),
      width: bbox.width,
      height: bbox.height
    }
  });
  return isDraftWithinSafeArea(candidate, normalizedSafeArea) ? candidate : cloneDraft(draft);
}

export function resizeTypesettingDraft(
  draft: TypesettingDraft,
  handle: TypesettingResizeHandle,
  delta: NormalizedPoint,
  safeArea: TypesettingSafeArea = DEFAULT_TYPESETTING_SAFE_AREA,
  minSize = TYPESETTING_MIN_SIZE
): TypesettingDraft {
  const area = normalizeSafeArea(safeArea);
  const minimum = clampNumber(finiteOrZero(minSize), 0.001, Math.min(area.width, area.height));
  const original = draft.bbox;
  const right = original.x + original.width;
  const bottom = original.y + original.height;
  let left = original.x;
  let top = original.y;
  let nextRight = right;
  let nextBottom = bottom;

  if (handle.includes("w")) {
    left = clampNumber(original.x + finiteOrZero(delta.x), area.x, right - minimum);
  } else if (handle.includes("e")) {
    nextRight = clampNumber(right + finiteOrZero(delta.x), original.x + minimum, area.x + area.width);
  }
  if (handle.includes("n")) {
    top = clampNumber(original.y + finiteOrZero(delta.y), area.y, bottom - minimum);
  } else if (handle.includes("s")) {
    nextBottom = clampNumber(bottom + finiteOrZero(delta.y), original.y + minimum, area.y + area.height);
  }

  if (!handle.includes("w")) left = clampNumber(left, area.x, area.x + area.width - minimum);
  if (!handle.includes("n")) top = clampNumber(top, area.y, area.y + area.height - minimum);
  const bbox = clampBbox({
    x: left,
    y: top,
    width: Math.max(minimum, nextRight - left),
    height: Math.max(minimum, nextBottom - top)
  }, area, minimum);
  const candidate = cloneDraft(draft, { bbox });
  return isDraftWithinSafeArea(candidate, area) ? candidate : cloneDraft(draft);
}

export function rotateTypesettingDraft(
  draft: TypesettingDraft,
  deltaDegrees: number,
  safeArea: TypesettingSafeArea = DEFAULT_TYPESETTING_SAFE_AREA
): TypesettingDraft {
  const rotationDegrees = normalizeDegrees(draft.rotationDegrees + finiteOrZero(deltaDegrees));
  const candidate = cloneDraft(draft, { rotationDegrees });
  return isDraftWithinSafeArea(candidate, safeArea) ? candidate : cloneDraft(draft);
}

export function constrainTypesettingDraftToSafeArea(
  draft: TypesettingDraft,
  safeArea: TypesettingSafeArea = DEFAULT_TYPESETTING_SAFE_AREA
): TypesettingDraft | null {
  const area = normalizeSafeArea(safeArea);
  if (!isValidTypesettingBbox(draft.bbox) || !isDraftWithinSafeArea(draft, area)) return null;
  return cloneDraft(draft);
}

export function getRotatedCorners(draft: Pick<TypesettingDraft, "bbox" | "rotationDegrees">): NormalizedPoint[] {
  const { x, y, width, height } = draft.bbox;
  const center = { x: x + width / 2, y: y + height / 2 };
  const radians = (draft.rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height }
  ].map((point) => ({
    x: center.x + (point.x - center.x) * cos - (point.y - center.y) * sin,
    y: center.y + (point.x - center.x) * sin + (point.y - center.y) * cos
  }));
}

export function isDraftWithinSafeArea(
  draft: Pick<TypesettingDraft, "bbox" | "rotationDegrees">,
  safeArea: TypesettingSafeArea = DEFAULT_TYPESETTING_SAFE_AREA
): boolean {
  const area = normalizeSafeArea(safeArea);
  const epsilon = 1e-9;
  return getRotatedCorners(draft).every((corner) =>
    corner.x >= area.x - epsilon &&
    corner.y >= area.y - epsilon &&
    corner.x <= area.x + area.width + epsilon &&
    corner.y <= area.y + area.height + epsilon
  );
}

export function normalizeSafeArea(safeArea: TypesettingSafeArea | null | undefined): TypesettingSafeArea {
  return clampBbox(safeArea ?? DEFAULT_TYPESETTING_SAFE_AREA);
}

function cloneDraft(draft: TypesettingDraft, patch: Partial<TypesettingDraft> = {}): TypesettingDraft {
  return {
    ...draft,
    ...patch,
    bbox: cloneBbox(patch.bbox ?? draft.bbox),
    shape: patch.shape ?? draft.shape
  };
}


function cloneBbox(bbox: NormalizedBbox): NormalizedBbox {
  return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
}

function constrainBboxToSafeArea(bbox: NormalizedBbox, safeArea: TypesettingSafeArea): NormalizedBbox {
  return clampBbox(bbox, safeArea, Math.min(TYPESETTING_MIN_SIZE, safeArea.width, safeArea.height));
}

function clampBbox(
  bbox: NormalizedBbox,
  area: TypesettingSafeArea = DEFAULT_TYPESETTING_SAFE_AREA,
  minSize = 0
): NormalizedBbox {
  const normalizedArea = area === DEFAULT_TYPESETTING_SAFE_AREA ? area : {
    x: clampUnit(area.x),
    y: clampUnit(area.y),
    width: Math.max(0, Math.min(finiteOrZero(area.width), 1 - clampUnit(area.x))),
    height: Math.max(0, Math.min(finiteOrZero(area.height), 1 - clampUnit(area.y)))
  };
  const widthLimit = normalizedArea.width;
  const heightLimit = normalizedArea.height;
  const width = clampNumber(Math.max(finiteOrZero(bbox.width), minSize), Math.min(minSize, widthLimit), widthLimit);
  const height = clampNumber(Math.max(finiteOrZero(bbox.height), minSize), Math.min(minSize, heightLimit), heightLimit);
  const x = clampNumber(finiteOrZero(bbox.x), normalizedArea.x, normalizedArea.x + normalizedArea.width - width);
  const y = clampNumber(finiteOrZero(bbox.y), normalizedArea.y, normalizedArea.y + normalizedArea.height - height);
  return { x, y, width, height };
}

function clampUnit(value: number): number {
  return clampNumber(finiteOrZero(value), 0, 1);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}
