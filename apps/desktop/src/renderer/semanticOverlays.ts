import { OVERLAY_KINDS, type OverlayKind } from "./trioState";
import type { NormalizedBbox, SpeechBubbleExtractionResult } from "../shared/speechBubbleExtraction";

export const OVERLAY_KIND_ORDER = [...OVERLAY_KINDS] as readonly OverlayKind[];

export type SemanticOverlayPattern =
  | "diagonal"
  | "dots"
  | "crosshatch"
  | "grid"
  | "horizontal"
  | "vertical"
  | "zigzag";

export type SemanticOverlayLineStyle = "solid" | "dashed" | "dotted" | "double" | "dash-dot";

export type SemanticOverlayMeta = {
  label: string;
  className: string;
  pattern: SemanticOverlayPattern;
  lineStyle: SemanticOverlayLineStyle;
};

export type SemanticOverlayBbox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SemanticOverlayDescriptor = {
  id: string;
  kind: OverlayKind;
  bbox: SemanticOverlayBbox;
  label?: string;
  accessibleLabel?: string;
  className?: string;
  selected?: boolean;
};

export type SelectVisibleSemanticOverlaysOptions = {
  visibleKinds?: readonly OverlayKind[];
  selectedIds?: readonly string[];
  maxUnselected?: number;
};

export type BuildSemanticOverlayDescriptorsOptions = {
  extraction: SpeechBubbleExtractionResult | null;
  activeItemId?: string | null;
  inpaintingMaskBbox?: NormalizedBbox | null;
};

export const SEMANTIC_OVERLAY_META: Record<OverlayKind, SemanticOverlayMeta> = {
  ocr: {
    label: "OCR 영역",
    className: "semantic-overlay-ocr",
    pattern: "diagonal",
    lineStyle: "solid"
  },
  balloon: {
    label: "말풍선 컨테이너",
    className: "semantic-overlay-balloon",
    pattern: "dots",
    lineStyle: "dashed"
  },
  "safe-area": {
    label: "말풍선 안전 영역",
    className: "semantic-overlay-safe-area",
    pattern: "crosshatch",
    lineStyle: "dotted"
  },
  typeset: {
    label: "한국어 식자 영역",
    className: "semantic-overlay-typeset",
    pattern: "grid",
    lineStyle: "double"
  },
  "inpainting-mask": {
    label: "인페인팅 마스크",
    className: "semantic-overlay-inpainting-mask",
    pattern: "horizontal",
    lineStyle: "dashed"
  },
  preserve: {
    label: "보존 요소",
    className: "semantic-overlay-preserve",
    pattern: "vertical",
    lineStyle: "dash-dot"
  },
  issue: {
    label: "문제 오버레이",
    className: "semantic-overlay-issue",
    pattern: "zigzag",
    lineStyle: "double"
  }
};

export function getSemanticOverlayMeta(kind: OverlayKind): SemanticOverlayMeta {
  return SEMANTIC_OVERLAY_META[kind];
}

export function buildSemanticOverlayDescriptors({
  extraction,
  activeItemId = null,
  inpaintingMaskBbox = null
}: BuildSemanticOverlayDescriptorsOptions): SemanticOverlayDescriptor[] {
  const descriptors: SemanticOverlayDescriptor[] = [];
  const descriptorIds = new Set<string>();
  const bubbleOccurrences = new Map<string, number>();
  if (extraction) {
    for (const item of extraction.speechBubbles) {
      const occurrence = (bubbleOccurrences.get(item.id) ?? 0) + 1;
      bubbleOccurrences.set(item.id, occurrence);
      const selected = item.id === activeItemId;
      const ocrLabel = `OCR 후보 #${item.readingOrder}`;
      descriptors.push({
        id: reserveBubbleOverlayId("ocr", item.id, occurrence, descriptorIds),
        kind: "ocr",
        bbox: item.bbox,
        label: ocrLabel,
        accessibleLabel: selected ? "선택된 OCR 영역" : `${ocrLabel} (${item.id})`,
        className: selected ? "page-image-ocr-highlight" : undefined,
        selected
      });
      descriptors.push({
        id: reserveBubbleOverlayId("balloon", item.id, occurrence, descriptorIds),
        kind: "balloon",
        bbox: expandSemanticBbox(item.bbox, 0.06),
        label: "말풍선 컨테이너 (추정)",
        selected
      });
      descriptors.push({
        id: reserveBubbleOverlayId("safe-area", item.id, occurrence, descriptorIds),
        kind: "safe-area",
        bbox: expandSemanticBbox(item.bbox, 0.02),
        label: "말풍선 안전 영역 (추정)",
        selected
      });
      descriptors.push({
        id: reserveBubbleOverlayId("typeset", item.id, occurrence, descriptorIds),
        kind: "typeset",
        bbox: insetSemanticBbox(item.bbox, 0.04),
        label: "한국어 식자 영역 (초안)",
        selected
      });
      if (item.confidence < 0.75 || item.notes.trim().length > 0) {
        descriptors.push({
          id: reserveBubbleOverlayId("issue", item.id, occurrence, descriptorIds),
          kind: "issue",
          bbox: item.bbox,
          label: item.notes.trim() || "OCR 신뢰도 낮음 · 재검토 필요",
          selected
        });
      }
    }
    extraction.nonSpeechText.forEach((item, index) => {
      descriptors.push({
        id: reserveDescriptorId(`preserve:${item.readingOrder}:${index}`, descriptorIds),
        kind: "preserve",
        bbox: item.bbox,
        label: "보존 요소",
        selected: false
      });
      if (item.confidence < 0.75 || item.notes.trim().length > 0) {
        descriptors.push({
          id: reserveDescriptorId(`issue:non-speech:${item.readingOrder}:${index}`, descriptorIds),
          kind: "issue",
          bbox: item.bbox,
          label: item.notes.trim() || "비대사 텍스트 재검토 필요"
        });
      }
    });
    if (extraction.warnings.length > 0) {
      descriptors.push({
        id: reserveDescriptorId("issue:extraction-warning", descriptorIds),
        kind: "issue",
        bbox: { x: 0, y: 0, width: 1, height: 0.08 },
        label: `OCR 경고 · ${extraction.warnings[0]}`
      });
    }
  }
  if (inpaintingMaskBbox) {
    descriptors.push({
      id: reserveDescriptorId("inpainting-mask:active", descriptorIds),
      kind: "inpainting-mask",
      bbox: inpaintingMaskBbox,
      label: "인페인팅 마스크"
    });
  }
  return descriptors;
}

function reserveBubbleOverlayId(
  kind: OverlayKind,
  sourceId: string,
  occurrence: number,
  usedIds: Set<string>
): string {
  const baseId = `${kind}:${sourceId}${occurrence > 1 ? `:${occurrence}` : ""}`;
  return reserveDescriptorId(baseId, usedIds);
}

function reserveDescriptorId(baseId: string, usedIds: Set<string>): string {
  let candidate = baseId;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}:${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

export function clampSemanticBbox(bbox: SemanticOverlayBbox): SemanticOverlayBbox {
  const x = clampUnit(bbox.x);
  const y = clampUnit(bbox.y);
  const width = Math.min(Math.max(toFiniteNumber(bbox.width), 0), 1 - x);
  const height = Math.min(Math.max(toFiniteNumber(bbox.height), 0), 1 - y);
  return { x, y, width, height };
}

export function selectVisibleSemanticOverlays(
  overlays: readonly SemanticOverlayDescriptor[],
  options: SelectVisibleSemanticOverlaysOptions = {}
): SemanticOverlayDescriptor[] {
  const visibleKinds = new Set(options.visibleKinds ?? OVERLAY_KIND_ORDER);
  const selectedIds = new Set(options.selectedIds ?? []);
  const maxUnselected = Math.max(0, Math.floor(options.maxUnselected ?? 24));
  const candidates = overlays
    .filter((overlay) => visibleKinds.has(overlay.kind))
    .map((overlay) => ({
      ...overlay,
      bbox: clampSemanticBbox(overlay.bbox),
      selected: Boolean(overlay.selected || selectedIds.has(overlay.id))
    }));
  const selected = candidates.filter((overlay) => overlay.selected).sort(compareSemanticOverlays);
  const unselected = candidates.filter((overlay) => !overlay.selected).sort(compareSemanticOverlays);
  return [...selected, ...unselected.slice(0, maxUnselected)];
}

function compareSemanticOverlays(
  left: SemanticOverlayDescriptor,
  right: SemanticOverlayDescriptor
): number {
  const kindDifference = OVERLAY_KIND_ORDER.indexOf(left.kind) - OVERLAY_KIND_ORDER.indexOf(right.kind);
  return kindDifference || left.id.localeCompare(right.id);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, toFiniteNumber(value)));
}

function expandSemanticBbox(bbox: NormalizedBbox, padding: number): SemanticOverlayBbox {
  return clampSemanticBbox({
    x: bbox.x - padding,
    y: bbox.y - padding,
    width: bbox.width + padding * 2,
    height: bbox.height + padding * 2
  });
}

function insetSemanticBbox(bbox: NormalizedBbox, padding: number): SemanticOverlayBbox {
  return clampSemanticBbox({
    x: bbox.x + padding,
    y: bbox.y + padding,
    width: Math.max(0, bbox.width - padding * 2),
    height: Math.max(0, bbox.height - padding * 2)
  });
}

function toFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
