import { createHash } from "node:crypto";
import type { MainProjectPatch } from "../../../shared/projectChanges.js";
import type {
  DialogueLineV2,
  DialogueType,
  SourceLanguage
} from "../../../shared/projectTypes.js";
import type {
  NormalizedBbox,
  PolygonPoint
} from "../../../shared/speechBubbleExtraction.js";
import {
  OCR_USER_OWNED_FIELDS,
  type ProductionOcrOrientation,
  type ProductionOcrProvenance
} from "../../../shared/productionOcr.js";
import { calculateBboxIou } from "./reRunMatcher.js";

const MATCH_IOU_THRESHOLD = 0.45;

export type ProductionOcrReviewedCandidate = Readonly<{
  id: string;
  text: string;
  sourceLanguage: SourceLanguage;
  dialogueType: DialogueType;
  bbox: NormalizedBbox;
  polygon: readonly PolygonPoint[];
  readingOrder: number;
  confidence: number;
  orientation: ProductionOcrOrientation;
  selectedSpeaker: string;
  notes: string;
  provenance: ProductionOcrProvenance;
  typesetting?: DialogueLineV2["typesetting"];
}>;

export function buildProductionOcrReviewMergePatch(args: {
  existingLines: readonly DialogueLineV2[];
  candidates: readonly ProductionOcrReviewedCandidate[];
  pageNumber: number;
  pageImageId: string;
  runId: string;
}): Extract<MainProjectPatch, { type: "merge_pipeline_dialogues" }> {
  const existing = args.existingLines
    .filter((line) =>
      line.pageNumber === args.pageNumber
      && line.origin.kind === "pipeline"
      && line.origin.pageImageId === args.pageImageId)
    .sort((left, right) => stableLineId(left).localeCompare(stableLineId(right)));
  const candidates = [...args.candidates].sort((left, right) =>
    left.provenance.groupId.localeCompare(right.provenance.groupId));

  const pairs: Array<{
    line: DialogueLineV2;
    candidate: ProductionOcrReviewedCandidate;
    iou: number;
  }> = [];
  for (const line of existing) {
    const bbox = line.typesetting?.bbox;
    if (!bbox) continue;
    for (const candidate of candidates) {
      if (!orientationsCanMatch(line, candidate.orientation)) continue;
      const iou = calculateBboxIou(bbox, candidate.bbox);
      if (iou >= MATCH_IOU_THRESHOLD) pairs.push({ line, candidate, iou });
    }
  }
  pairs.sort((left, right) =>
    right.iou - left.iou
    || stableLineId(left.line).localeCompare(stableLineId(right.line))
    || left.candidate.provenance.groupId.localeCompare(right.candidate.provenance.groupId));

  const matchedLines = new Map<string, ProductionOcrReviewedCandidate>();
  const matchedGroups = new Set<string>();
  for (const pair of pairs) {
    const lineKey = stableLineId(pair.line);
    const groupId = pair.candidate.provenance.groupId;
    if (matchedLines.has(lineKey) || matchedGroups.has(groupId)) continue;
    matchedLines.set(lineKey, pair.candidate);
    matchedGroups.add(groupId);
  }

  const lines: DialogueLineV2[] = [];
  for (const line of existing) {
    const candidate = matchedLines.get(stableLineId(line));
    if (!candidate || line.origin.kind !== "pipeline") continue;
    lines.push(toPipelineLine(candidate, args, {
      lineId: line.id,
      persistentRegionId: line.origin.persistentRegionId
    }));
  }
  for (const candidate of candidates) {
    if (matchedGroups.has(candidate.provenance.groupId)) continue;
    lines.push(toPipelineLine(candidate, args, {
      lineId: `ocr-line-${args.pageImageId}-${candidate.provenance.groupId}`,
      persistentRegionId: `ocr-region-${candidate.provenance.groupId}`
    }));
  }
  lines.sort((left, right) => {
    const leftIndex = left.origin.kind === "pipeline" ? left.origin.readingIndex : left.order;
    const rightIndex = right.origin.kind === "pipeline" ? right.origin.readingIndex : right.order;
    return leftIndex - rightIndex || left.id.localeCompare(right.id);
  });
  const existingByPersistentRegionId = new Map(existing.flatMap((line) =>
    line.origin.kind === "pipeline" ? [[line.origin.persistentRegionId, line] as const] : []));
  let nextOrder = args.existingLines.reduce((maximum, line) => Math.max(maximum, line.order), 0) + 1;
  for (const line of lines) {
    if (line.origin.kind !== "pipeline") continue;
    const matched = existingByPersistentRegionId.get(line.origin.persistentRegionId);
    line.order = matched?.order ?? nextOrder++;
  }

  const matchedPersistentRegionIds = new Set(lines.flatMap((line) =>
    line.origin.kind === "pipeline" ? [line.origin.persistentRegionId] : []));
  const orphanedPersistentRegionIds = existing
    .flatMap((line) => line.origin.kind === "pipeline" ? [line.origin.persistentRegionId] : [])
    .filter((persistentRegionId) => !matchedPersistentRegionIds.has(persistentRegionId))
    .sort();

  return {
    type: "merge_pipeline_dialogues",
    pageImageId: args.pageImageId,
    lines,
    orphanedPersistentRegionIds
  };
}

function toPipelineLine(
  candidate: ProductionOcrReviewedCandidate,
  context: { pageNumber: number; pageImageId: string; runId: string },
  identity: { lineId: string; persistentRegionId: string }
): DialogueLineV2 {
  const speaker = candidate.selectedSpeaker.trim();
  return {
    id: identity.lineId,
    order: candidate.readingOrder,
    pageNumber: context.pageNumber,
    ...(speaker ? { speaker } : {}),
    dialogueType: candidate.dialogueType,
    lineStatus: "untranslated",
    sourceLanguage: candidate.sourceLanguage,
    sourceText: candidate.text,
    notes: candidate.notes || undefined,
    parseConfidence: candidate.confidence,
    parseWarnings: [],
    polygon: candidate.polygon.map((point) => ({ ...point })),
    typesetting: candidate.typesetting
      ? structuredClone(candidate.typesetting)
      : {
          bbox: { ...candidate.bbox },
          writingMode: candidate.orientation === "vertical" ? "vertical-rl" : "horizontal-tb"
        },
    ocrEditStatus: "user_confirmed",
    ocrUserOwnedFields: [...OCR_USER_OWNED_FIELDS],
    ocrGroupId: candidate.provenance.groupId,
    ocrSourceInfo: {
      detectorName: "PP-OCRv6_medium_det",
      ocrEngine: "baberu-ocr",
      confidence: candidate.confidence,
      orientation: candidate.orientation,
      productionOcrProvenance: structuredClone(candidate.provenance)
    },
    origin: {
      kind: "pipeline",
      persistentRegionId: identity.persistentRegionId,
      latestRunId: context.runId,
      latestRegionId: candidate.provenance.groupId,
      pageImageId: context.pageImageId,
      candidateIds: [...candidate.provenance.sourceDetectionIds],
      readingIndex: candidate.readingOrder,
      sourceFingerprint: createHash("sha256").update(candidate.text, "utf8").digest("hex")
    }
  };
}

function orientationsCanMatch(
  line: DialogueLineV2,
  candidateOrientation: ProductionOcrOrientation
): boolean {
  const existingOrientation = line.ocrSourceInfo?.orientation
    ?? line.ocrSourceInfo?.productionOcrProvenance?.orientation
    ?? (line.typesetting?.writingMode === "vertical-rl" ? "vertical" : "horizontal");
  return existingOrientation === "unknown"
    || candidateOrientation === "unknown"
    || existingOrientation === candidateOrientation;
}

function stableLineId(line: DialogueLineV2): string {
  return line.origin.kind === "pipeline" ? line.origin.persistentRegionId : line.id;
}
