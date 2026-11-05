import type { ProductionOcrDetection, ProductionOcrGroup, ProductionOcrPixelBbox } from "../../../shared/productionOcr.js";
import { throwIfAborted } from "../../abortSignals.js";
import { avoidsNewOcrCropIntrusion, ocrGroupCrop } from "../../../shared/imageCropGeometry.js";
import { groupProductionOcrDetections } from "../grouping/productionRegionGrouping.js";
import type { ProductionOcrDetector } from "../pipeline/productionOcrPipeline.js";

const TILE_SIZE = 1200;
const TILE_STRIDE = 1000;
const INTERNAL_EDGE_MARGIN = 16;
const MIN_DETAIL_SCORE = 0.7;
const MIN_EXTENSION_SCORE = 0.6;

type ExtensionCandidate = {
  detection: ProductionOcrDetection;
  tileX: number;
  tileY: number;
};

type DetailImage = {
  getSize(): { width: number; height: number };
  crop(rect: ProductionOcrPixelBbox): { toPNG(): Buffer };
};

export type ProductionOcrDetailCandidate = Readonly<{
  detection: ProductionOcrDetection;
  tile: ProductionOcrPixelBbox;
  touchesInternalEdge: boolean;
}>;

export class ProductionOcrDetailDetector implements ProductionOcrDetector {
  private readonly detector: ProductionOcrDetector;
  private readonly decodeImage: (imageBytes: Buffer) => DetailImage;
  private readonly tileSize: number;
  private readonly tileStride: number;

  constructor(options: {
    detector: ProductionOcrDetector;
    decodeImage: (imageBytes: Buffer) => DetailImage;
    tileSize?: 600 | 1200;
  }) {
    this.detector = options.detector;
    this.decodeImage = options.decodeImage;
    this.tileSize = options.tileSize ?? TILE_SIZE;
    this.tileStride = this.tileSize === 600 ? 400 : TILE_STRIDE;
  }

  async detect(input: Parameters<ProductionOcrDetector["detect"]>[0]): Promise<readonly ProductionOcrDetection[]> {
    return await this.detectPage(input);
  }

  async detectWithDetails(input: Parameters<ProductionOcrDetector["detect"]>[0]): Promise<Readonly<{
    detections: readonly ProductionOcrDetection[];
    fullpageDetections: readonly ProductionOcrDetection[];
    detailCandidates: readonly ProductionOcrDetailCandidate[];
  }>> {
    // Collection belongs to this invocation; concurrent/cancelled requests cannot
    // leave candidates in a shared observer or in the next page's result.
    const detailCandidates: ProductionOcrDetailCandidate[] = [];
    const detections = await this.detectPage(input, detailCandidates);
    const detailIds = new Set(detailCandidates.map((candidate) => candidate.detection.detectionId));
    return { detections, fullpageDetections: detections.filter((detection) => !detailIds.has(detection.detectionId)), detailCandidates };
  }

  private async detectPage(
    input: Parameters<ProductionOcrDetector["detect"]>[0],
    detailCandidates?: ProductionOcrDetailCandidate[]
  ): Promise<readonly ProductionOcrDetection[]> {
    throwIfAborted(input.signal);
    const fullpage = await this.detector.detect(input);
    throwIfAborted(input.signal);

    const image = this.decodeImage(input.imageBytes);
    throwIfAborted(input.signal);
    const { width, height } = image.getSize();
    throwIfAborted(input.signal);
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
      throw new Error("Invalid Production OCR detail image dimensions");
    }
    if (Math.max(width, height) <= this.tileSize) return fullpage;

    // Reserve a namespace disjoint from every fullpage ID without changing any original IDs.
    let prefix = "detail-tile:";
    while (fullpage.some((detection) => detection.detectionId.startsWith(prefix))) prefix = `_${prefix}`;

    const additions: ProductionOcrDetection[] = [];
    const extensionCandidates: ExtensionCandidate[] = [];
    const xs = tileOffsets(width, this.tileSize, this.tileStride);
    const ys = tileOffsets(height, this.tileSize, this.tileStride);
    for (const y of ys) {
      for (const x of xs) {
        throwIfAborted(input.signal);
        const rect = { x, y, width: Math.min(this.tileSize, width), height: Math.min(this.tileSize, height) };
        // Only the decoded source and this tile are retained; tiles are never queued or cached.
        const tileBytes = image.crop(rect).toPNG();
        throwIfAborted(input.signal);
        const detections = await this.detector.detect({
          imageBytes: tileBytes,
          signal: input.signal,
          onWarning: input.onWarning ? (warning) => input.onWarning!(
            `OCR_DETAIL_TILE (${x},${y},${rect.width},${rect.height}): ${warning}`
          ) : undefined
        });
        throwIfAborted(input.signal);

        for (const detection of detections) {
          if (detection.imageWidth !== rect.width || detection.imageHeight !== rect.height) {
            throw new Error(
              `Production OCR detail tile (${x},${y}) dimensions mismatch: expected ${rect.width}x${rect.height}, received ${detection.imageWidth}x${detection.imageHeight}`
            );
          }
          const restored = restoreCoordinates(detection, rect, width, height, prefix);
          const clipped = touchesInternalEdge(detection.sourceBboxPx, rect, width, height);
          detailCandidates?.push({ detection: restored, tile: rect, touchesInternalEdge: clipped });
          if (detection.score < MIN_EXTENSION_SCORE) continue;
          if (clipped) continue;
          if (fullpage.some((existing) => overlapsSameText(existing.sourceBboxPx, restored.sourceBboxPx))) {
            extensionCandidates.push({ detection: restored, tileX: x, tileY: y });
          } else if (detection.score >= MIN_DETAIL_SCORE) {
            // New independent regions still need stronger evidence against artwork.
            additions.push(restored);
          }
        }
      }
    }

    additions.sort(compareDetails);
    const merged = [...fullpage];
    let currentGroups = groupProductionOcrDetections(merged);
    const existingIds = new Set(merged.map((detection) => detection.detectionId));
    for (const candidate of additions) {
      if (merged.some((existing) => overlapsSameText(existing.sourceBboxPx, candidate.sourceBboxPx))) continue;
      const regrouped = groupProductionOcrDetections([...merged, candidate]);
      if (!preservesGroupPartition(currentGroups, regrouped, existingIds)) continue;
      const addedGroup = regrouped.find((group) => group.sourceDetectionIds.includes(candidate.detectionId))!;
      if (!avoidsNewOcrCropIntrusion(currentGroups, addedGroup)) continue;
      merged.push(candidate);
      existingIds.add(candidate.detectionId);
      currentGroups = regrouped;
    }

    if (extensionCandidates.length >= 2) {
      const originalGroups = groupProductionOcrDetections(fullpage);
      const originalsById = new Map(fullpage.map((detection) => [detection.detectionId, detection]));
      const extensions = extensionCandidates
        .sort((a, b) => compareDetails(a.detection, b.detection))
        .flatMap((candidate) => {
          const group = findExtensionGroup(candidate.detection, originalGroups, originalsById);
          return group ? [{ ...candidate, group }] : [];
        });
      const extendedGroups = new Set<string>();
      for (let firstIndex = 0; firstIndex < extensions.length; firstIndex += 1) {
        throwIfAborted(input.signal);
        const first = extensions[firstIndex]!;
        if (extendedGroups.has(first.group.groupId)) continue;
        for (let secondIndex = firstIndex + 1; secondIndex < extensions.length; secondIndex += 1) {
          throwIfAborted(input.signal);
          const second = extensions[secondIndex]!;
          if (first.group !== second.group || (first.tileX === second.tileX && first.tileY === second.tileY)) continue;
          const a = first.detection;
          const b = second.detection;
          const intersection = intersectionArea(a.sourceBboxPx, b.sourceBboxPx);
          if (intersection < 0.8 * (boxArea(a.sourceBboxPx) + boxArea(b.sourceBboxPx) - intersection)) continue;
          const currentTarget = currentGroups.find((group) => group.sourceDetectionIds.includes(first.group.sourceDetectionIds[0]!))!;
          const expanded = enclosingBox([currentTarget.groupBboxPx, a.sourceBboxPx, b.sourceBboxPx]);
          if (originalGroups.some((group) => group !== first.group && intersectionArea(expanded, group.groupBboxPx) > 0)) continue;
          if (currentGroups.some((group) => group !== currentTarget && intersectionArea(expanded, group.groupBboxPx) > 0)) continue;

          // Use the real grouping rules, including unknown-direction resolution.
          // Both raw detections must extend exactly one original group without
          // merging or splitting any current source-ID partition.
          const regrouped = groupProductionOcrDetections([...merged, a, b]);
          const extensionGroup = regrouped.find((group) => group.sourceDetectionIds.includes(a.detectionId));
          if (!extensionGroup?.sourceDetectionIds.includes(b.detectionId)) continue;
          const originalIds = extensionGroup.sourceDetectionIds.filter((id) => originalsById.has(id));
          if (originalIds.length !== first.group.sourceDetectionIds.length
            || !originalIds.every((id) => first.group.sourceDetectionIds.includes(id))) continue;
          if (!preservesGroupPartition(currentGroups, regrouped, existingIds)) continue;
          if (!avoidsNewOcrCropIntrusion(currentGroups, extensionGroup)) continue;

          merged.push(a, b);
          existingIds.add(a.detectionId);
          existingIds.add(b.detectionId);
          currentGroups = regrouped;
          extendedGroups.add(first.group.groupId);
          break;
        }
      }
    }
    throwIfAborted(input.signal);
    return merged.length === fullpage.length ? fullpage : merged;
  }
}

function tileOffsets(length: number, size: number, stride: number): number[] {
  const last = Math.max(0, length - size);
  const offsets = [0];
  for (let offset = stride; offset < last; offset += stride) offsets.push(offset);
  if (last > 0) offsets.push(last);
  return offsets;
}

export function touchesInternalEdge(box: ProductionOcrPixelBbox, tile: ProductionOcrPixelBbox, width: number, height: number): boolean {
  return (tile.x > 0 && box.x <= INTERNAL_EDGE_MARGIN)
    || (tile.y > 0 && box.y <= INTERNAL_EDGE_MARGIN)
    || (tile.x + tile.width < width && tile.width - box.x - box.width <= INTERNAL_EDGE_MARGIN)
    || (tile.y + tile.height < height && tile.height - box.y - box.height <= INTERNAL_EDGE_MARGIN);
}

export function restoreCoordinates(
  detection: ProductionOcrDetection,
  tile: ProductionOcrPixelBbox,
  width: number,
  height: number,
  prefix: string
): ProductionOcrDetection {
  const sourceQuadPx = detection.sourceQuadPx.map((point) => ({
    x: point.x + tile.x,
    y: point.y + tile.y
  })) as unknown as ProductionOcrDetection["sourceQuadPx"];
  const sourceBboxPx = {
    ...detection.sourceBboxPx,
    x: detection.sourceBboxPx.x + tile.x,
    y: detection.sourceBboxPx.y + tile.y
  };
  return {
    ...detection,
    detectionId: `${prefix}${tile.x},${tile.y}:${detection.detectionId}`,
    sourceQuadPx,
    sourceBboxPx,
    bbox: {
      x: sourceBboxPx.x / width,
      y: sourceBboxPx.y / height,
      width: sourceBboxPx.width / width,
      height: sourceBboxPx.height / height
    },
    polygon: sourceQuadPx.map((point) => ({ x: point.x / width, y: point.y / height })) as unknown as ProductionOcrDetection["polygon"],
    imageWidth: width,
    imageHeight: height
  };
}

function compareDetails(a: ProductionOcrDetection, b: ProductionOcrDetection): number {
  // Score first, then the more complete extent, then source geometry and the namespaced ID.
  const rank = b.score - a.score
    || boxArea(b.sourceBboxPx) - boxArea(a.sourceBboxPx)
    || a.sourceBboxPx.y - b.sourceBboxPx.y
    || a.sourceBboxPx.x - b.sourceBboxPx.x
    || a.sourceBboxPx.width - b.sourceBboxPx.width
    || a.sourceBboxPx.height - b.sourceBboxPx.height;
  if (rank !== 0) return rank;
  for (let index = 0; index < 4; index += 1) {
    const pointRank = a.sourceQuadPx[index]!.x - b.sourceQuadPx[index]!.x
      || a.sourceQuadPx[index]!.y - b.sourceQuadPx[index]!.y;
    if (pointRank !== 0) return pointRank;
  }
  return compareText(a.orientation, b.orientation) || compareText(a.detectionId, b.detectionId);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function boxArea(box: ProductionOcrPixelBbox): number {
  return box.width * box.height;
}

function intersectionArea(a: ProductionOcrPixelBbox, b: ProductionOcrPixelBbox): number {
  const intersectionWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const intersectionHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersectionWidth * intersectionHeight;
}

function overlapsSameText(a: ProductionOcrPixelBbox, b: ProductionOcrPixelBbox): boolean {
  // Overlap alone never authorizes a new independent region.
  return intersectionArea(a, b) >= 0.5 * Math.min(boxArea(a), boxArea(b));
}

function findExtensionGroup(
  candidate: ProductionOcrDetection,
  groups: readonly ProductionOcrGroup[],
  originalsById: ReadonlyMap<string, ProductionOcrDetection>
): ProductionOcrGroup | undefined {
  if (candidate.orientation === "unknown") return undefined;
  const box = candidate.sourceBboxPx;
  const thickness = candidate.orientation === "vertical" ? box.width : box.height;
  const matches = groups.filter((group) => group.orientation === candidate.orientation && group.sourceDetectionIds.some((id) => {
    const original = originalsById.get(id)!;
    if (original.orientation !== candidate.orientation) return false;
    const originalBox = original.sourceBboxPx;
    if (intersectionArea(box, originalBox) < 0.9 * boxArea(originalBox)) return false;
    const originalThickness = original.orientation === "vertical" ? originalBox.width : originalBox.height;
    if (Math.min(thickness, originalThickness) < 0.5 * Math.max(thickness, originalThickness)) return false;
    return extendsOriginalCrop(candidate, group, Math.min(thickness, originalThickness));
  }));
  return matches.length === 1 ? matches[0] : undefined;
}

function extendsOriginalCrop(candidate: ProductionOcrDetection, group: ProductionOcrGroup, thickness: number): boolean {
  const box = candidate.sourceBboxPx;
  const crop = ocrGroupCrop(group);
  // Match imageCrop's rounded, source-clamped eight-percent group padding.
  const extension = Math.max(crop.x - box.x, crop.y - box.y, box.x + box.width - crop.x - crop.width, box.y + box.height - crop.y - crop.height);
  return extension > 1 && extension >= 0.25 * thickness;
}

function enclosingBox(boxes: readonly ProductionOcrPixelBbox[]): ProductionOcrPixelBbox {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x, y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y
  };
}

export function preservesGroupPartition(
  before: readonly ProductionOcrGroup[],
  after: readonly ProductionOcrGroup[],
  existingIds: ReadonlySet<string>
): boolean {
  const groupById = new Map(after.flatMap((group, index) => group.sourceDetectionIds.map((id) => [id, index] as const)));
  return before.every((group) => {
    const index = groupById.get(group.sourceDetectionIds[0]!);
    return index !== undefined
      && group.sourceDetectionIds.every((id) => groupById.get(id) === index)
      && after[index]!.sourceDetectionIds.filter((id) => existingIds.has(id)).length === group.sourceDetectionIds.length;
  });
}
