import { MANGA_OCR_MODELS, type ProductionOcrDetection, type ProductionOcrGroup, type ProductionOcrPixelBbox } from "../../../shared/productionOcr.js";
import { throwIfAborted } from "../../abortSignals.js";
import { avoidsNewOcrCropIntrusion, ocrGroupCrop } from "../../../shared/imageCropGeometry.js";
import { groupProductionOcrDetections } from "../grouping/productionRegionGrouping.js";
import type { ProductionOcrDetector } from "../pipeline/productionOcrPipeline.js";
import { preservesGroupPartition, restoreCoordinates, touchesInternalEdge, type ProductionOcrDetailCandidate, type ProductionOcrDetailDetector } from "./productionOcrDetailDetector.js";

type SupportDetections = Readonly<{
  fullpageDetections: readonly ProductionOcrDetection[];
  detailCandidates: readonly ProductionOcrDetailCandidate[];
}>;
type TextEvidence = Readonly<{ accepted: boolean; inputs?: readonly Readonly<{ text: string; mean: number }>[] }>;

/** Keeps the primary detector's regions and uses manga detection as evidence for additions. */
export class MangaAssistedOcrDetector implements ProductionOcrDetector {
  constructor(private readonly options: {
    primary: Pick<ProductionOcrDetailDetector, "detectWithDetails">;
    support: Pick<ProductionOcrDetailDetector, "detectWithDetails">;
    confirmationDetector: ProductionOcrDetector;
    textVerifier: { verify(input: {
      imageBytes: Buffer;
      candidateId: string;
      sourceQuadPx: ProductionOcrDetection["sourceQuadPx"];
      cropBboxPx: ProductionOcrPixelBbox;
      signal?: AbortSignal;
    }): Promise<TextEvidence> };
    decodeImage: (bytes: Buffer) => {
      getSize(): { width: number; height: number };
      crop(rect: ProductionOcrPixelBbox): { toPNG(): Buffer };
    };
  }) {}

  async detect(input: Parameters<ProductionOcrDetector["detect"]>[0]): Promise<readonly ProductionOcrDetection[]> {
    throwIfAborted(input.signal);
    const primary = await this.options.primary.detectWithDetails(input);
    throwIfAborted(input.signal);
    const support = await this.options.support.detectWithDetails(input);
    throwIfAborted(input.signal);
    const confirmed: ProductionOcrDetection[] = [];
    const ambiguous = primary.detailCandidates.filter((candidate) => !candidate.touchesInternalEdge && candidate.detection.score >= 0.45);
    const fineCandidates = support.detailCandidates.filter((candidate) => !candidate.touchesInternalEdge && candidate.detection.score >= 0.7)
      .sort((a, b) => b.detection.score - a.detection.score || a.detection.detectionId.localeCompare(b.detection.detectionId, "en-US"));
    let merged = mergeMangaOcrDetections(primary.detections, support);
    const confirmationByTile = new Map<string, readonly ProductionOcrDetection[]>();
    const textEvidenceById = new Map<string, TextEvidence>();
    let image: ReturnType<typeof this.options.decodeImage> | undefined;
    const verifyText = async (detection: ProductionOcrDetection): Promise<TextEvidence> => {
      throwIfAborted(input.signal);
      const cached = textEvidenceById.get(detection.detectionId);
      if (cached !== undefined) return cached;
      image ??= this.options.decodeImage(input.imageBytes);
      const { width, height } = image.getSize();
      if (width !== detection.imageWidth || height !== detection.imageHeight) throw new Error("Manga text verification source dimensions changed");
      const box = detection.sourceBboxPx;
      // This context contains both fixed rectifications, even for a slanted line.
      // It is local verification input, not the final Hayai recognition crop.
      const margin = Math.ceil(Math.min(box.width, box.height) + Math.max(box.width, box.height) * 0.08);
      const x = Math.max(0, Math.floor(box.x - margin)), y = Math.max(0, Math.floor(box.y - margin));
      const cropBboxPx = { x, y, width: Math.min(width, Math.ceil(box.x + box.width + margin)) - x,
        height: Math.min(height, Math.ceil(box.y + box.height + margin)) - y };
      const evidence = await this.options.textVerifier.verify({ imageBytes: image.crop(cropBboxPx).toPNG(),
        candidateId: detection.detectionId, sourceQuadPx: detection.sourceQuadPx, cropBboxPx, signal: input.signal });
      throwIfAborted(input.signal);
      textEvidenceById.set(detection.detectionId, evidence);
      return evidence;
    };
    for (const candidate of fineCandidates) {
      throwIfAborted(input.signal);
      if (merged.some((detection) => overlapsText(detection, candidate.detection))) continue;
      let matching = ambiguous.map((entry) => entry.detection).filter((detection) => agreesWithLocalDetection(detection, candidate.detection));
      if (matching.length === 0) {
        // Filter unstable fine-scale guesses before an expensive PP recheck.
        const evidence = await verifyText(candidate.detection);
        if (!evidence.accepted) continue;
        // Exact, stronger agreement in both CTC views can corroborate a fine
        // Manga region even when PP misses this handwritten line entirely.
        // The final text still comes from Hayai on the recorded source crop.
        if (evidence.inputs?.length === 2 && evidence.inputs.every((view) => view.mean >= 0.7 && view.mean <= 1)
          && evidence.inputs[0]!.text.length > 0 && evidence.inputs[0]!.text === evidence.inputs[1]!.text) {
          confirmed.push(candidate.detection);
          merged = mergeMangaOcrDetections(primary.detections, support, confirmed);
          continue;
        }
        image ??= this.options.decodeImage(input.imageBytes);
        const { width, height } = image.getSize();
        const tile = candidate.tile;
        const key = `${tile.x},${tile.y},${tile.width},${tile.height}`;
        let detections = confirmationByTile.get(key);
        if (!detections) {
          const response = await this.options.confirmationDetector.detect({
            imageBytes: image.crop(tile).toPNG(), signal: input.signal,
            onWarning: input.onWarning ? (warning) => input.onWarning!(`OCR_MANGA_CONFIRM (${key}): ${warning}`) : undefined
          });
          throwIfAborted(input.signal);
          detections = response.flatMap((detection) => {
            if (detection.imageWidth !== tile.width || detection.imageHeight !== tile.height) throw new Error("Manga OCR confirmation dimensions mismatch");
            return detection.score >= 0.7 && !touchesInternalEdge(detection.sourceBboxPx, tile, width, height)
              ? [restoreCoordinates(detection, tile, width, height, "manga-confirm:")] : [];
          });
          confirmationByTile.set(key, detections);
        }
        matching = detections.filter((detection) => agreesWithLocalDetection(detection, candidate.detection));
      }
      const match = matching.sort((a, b) => b.score - a.score || boxArea(b.sourceBboxPx) - boxArea(a.sourceBboxPx))[0];
      if (!match) continue;
      if (!(await verifyText(match)).accepted) continue;
      // The larger PP view supplies the crop; Manga independently confirms text
      // at this location. Keep both roles distinct in the saved evidence.
      confirmed.push({ ...match, supportedBy: MANGA_OCR_MODELS.detector });
      merged = mergeMangaOcrDetections(primary.detections, support, confirmed);
    }
    throwIfAborted(input.signal);
    return merged;
  }
}

export function mergeMangaOcrDetections(
  primary: readonly ProductionOcrDetection[],
  support: SupportDetections,
  confirmedPrimary: readonly ProductionOcrDetection[] = []
): readonly ProductionOcrDetection[] {
  const all = [...primary, ...confirmedPrimary, ...support.fullpageDetections, ...support.detailCandidates.map((candidate) => candidate.detection)];
  const source = all[0];
  if (!source) return primary;
  if (all.some((detection) => detection.imageWidth !== source.imageWidth || detection.imageHeight !== source.imageHeight)) {
    throw new Error("Manga OCR support dimensions must match the primary source image");
  }

  // A weak tiny region must also be found clearly in an unclipped local view.
  // Isolated tile predictions do not relax the existing artwork filter.
  const candidates = [
    ...confirmedPrimary,
    ...support.fullpageDetections.filter((detection) => detection.score >= 0.7),
    ...support.detailCandidates.filter((candidate) => !candidate.touchesInternalEdge
      && candidate.detection.score >= 0.7
      && support.fullpageDetections.some((whole) => whole.score >= 0.7
        && agreesWithLocalDetection(whole, candidate.detection)))
      .map((candidate) => candidate.detection)
  ].sort((a, b) => b.score - a.score || boxArea(b.sourceBboxPx) - boxArea(a.sourceBboxPx)
    || a.sourceBboxPx.y - b.sourceBboxPx.y || a.sourceBboxPx.x - b.sourceBboxPx.x
    || a.detectionId.localeCompare(b.detectionId, "en-US"));

  const merged = [...primary];
  let groups = groupProductionOcrDetections(merged);
  const existingIds = new Set(merged.map((detection) => detection.detectionId));
  for (const candidate of candidates) {
    if (existingIds.has(candidate.detectionId)) continue;
    const overlapping = merged.filter((detection) => intersectionArea(detection.sourceBboxPx, candidate.sourceBboxPx)
      >= 0.5 * Math.min(boxArea(detection.sourceBboxPx), boxArea(candidate.sourceBboxPx)));
    const targets = groups.filter((group) => overlapping.some((detection) => group.sourceDetectionIds.includes(detection.detectionId)));
    if (targets.length > 1) continue;
    const target = targets[0];
    if (target && (!extendsCrop(candidate, target)
      || !overlapping.some((detection) => continuesLine(detection, candidate)))) continue;

    const regrouped = groupProductionOcrDetections([...merged, candidate]);
    if (!preservesGroupPartition(groups, regrouped, existingIds)) continue;
    const addedGroup = regrouped.find((group) => group.sourceDetectionIds.includes(candidate.detectionId))!;
    if (target && !target.sourceDetectionIds.every((id) => addedGroup.sourceDetectionIds.includes(id))) continue;
    // A new/expanded crop cannot cover another sentence merely because its
    // orientation prevented the grouping algorithm from joining that sentence.
    if (groups.some((group) => !group.sourceDetectionIds.some((id) => addedGroup.sourceDetectionIds.includes(id))
      && intersectionArea(group.groupBboxPx, addedGroup.groupBboxPx) > 0)) continue;
    if (!avoidsNewOcrCropIntrusion(groups, addedGroup)) continue;

    merged.push(candidate);
    existingIds.add(candidate.detectionId);
    groups = regrouped;
  }
  return merged.length === primary.length ? primary : merged;
}

function overlapsText(a: ProductionOcrDetection, b: ProductionOcrDetection): boolean {
  return intersectionArea(a.sourceBboxPx, b.sourceBboxPx) >= 0.5 * Math.min(boxArea(a.sourceBboxPx), boxArea(b.sourceBboxPx));
}

function agreesWithLocalDetection(whole: ProductionOcrDetection, detail: ProductionOcrDetection): boolean {
  return sameScale(whole, detail)
    && intersectionArea(whole.sourceBboxPx, detail.sourceBboxPx) >= 0.5 * Math.min(boxArea(whole.sourceBboxPx), boxArea(detail.sourceBboxPx))
    && intersectionArea(whole.sourceBboxPx, detail.sourceBboxPx) >= 0.4 * Math.max(boxArea(whole.sourceBboxPx), boxArea(detail.sourceBboxPx));
}

function sameScale(a: ProductionOcrDetection, b: ProductionOcrDetection): boolean {
  if (a.orientation !== "unknown" && b.orientation !== "unknown" && a.orientation !== b.orientation) return false;
  const orientation = a.orientation !== "unknown" ? a.orientation : b.orientation;
  const thickness = (box: ProductionOcrPixelBbox) => orientation === "vertical" ? box.width
    : orientation === "horizontal" ? box.height : Math.min(box.width, box.height);
  const first = thickness(a.sourceBboxPx), second = thickness(b.sourceBboxPx);
  return Math.min(first, second) >= 0.5 * Math.max(first, second);
}

function continuesLine(original: ProductionOcrDetection, candidate: ProductionOcrDetection): boolean {
  if (!sameScale(original, candidate)) return false;
  const a = original.sourceBboxPx, b = candidate.sourceBboxPx;
  if (original.orientation === "unknown" || candidate.orientation === "unknown") {
    return intersectionArea(a, b) >= 0.85 * boxArea(a);
  }
  // Detector padding can differ across the line. Check completeness along the
  // reading axis so a narrower but longer result can restore leading dots.
  const vertical = original.orientation === "vertical";
  const start = vertical ? "y" : "x";
  const length = vertical ? "height" : "width";
  const overlap = Math.max(0, Math.min(a[start] + a[length], b[start] + b[length]) - Math.max(a[start], b[start]));
  return b[length] >= a[length] && overlap >= 0.8 * a[length];
}

function extendsCrop(candidate: ProductionOcrDetection, group: ProductionOcrGroup): boolean {
  const box = group.groupBboxPx;
  const crop = ocrGroupCrop(group);
  const incoming = candidate.sourceBboxPx;
  const extension = Math.max(
    crop.x - incoming.x, crop.y - incoming.y,
    incoming.x + incoming.width - crop.x - crop.width,
    incoming.y + incoming.height - crop.y - crop.height
  );
  return extension > 1 && extension >= 0.25 * Math.min(box.width, box.height, incoming.width, incoming.height);
}

function boxArea(box: ProductionOcrPixelBbox): number { return box.width * box.height; }

function intersectionArea(a: ProductionOcrPixelBbox, b: ProductionOcrPixelBbox): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
