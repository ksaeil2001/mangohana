import { describe, expect, it } from "vitest";
import {
  buildProductionOcrReviewMergePatch,
  type ProductionOcrReviewedCandidate
} from "../../src/main/ocr/pipeline/productionOcrReviewMerge.js";
import { applyMainProjectPatch } from "../../src/main/projectReplay.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";
import type { DialogueLineV2, DialogueOrigin } from "../../src/shared/projectTypes.js";
import { OCR_USER_OWNED_FIELDS, PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";

function candidate(overrides: Partial<ProductionOcrReviewedCandidate> = {}): ProductionOcrReviewedCandidate {
  return {
    id: "group-new",
    text: "새 OCR 텍스트",
    sourceLanguage: "ja",
    dialogueType: "speech",
    bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
    polygon: [
      { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 },
      { x: 0.4, y: 0.3 }, { x: 0.1, y: 0.3 }
    ],
    readingOrder: 1,
    confidence: 0.91,
    orientation: "vertical",
    selectedSpeaker: "",
    notes: "",
    provenance: {
      contractVersion: 1,
      detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
      detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
      recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
      recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
      groupId: "group-new",
      sourceDetectionIds: ["det-2"],
      sourceDetectionScores: [0.91],
      sourceQuadsPx: [[
        { x: 10, y: 10 }, { x: 40, y: 10 },
        { x: 40, y: 30 }, { x: 10, y: 30 }
      ]],
      orientation: "vertical",
      cropTransform: {
        sourceBboxPx: { x: 10, y: 10, width: 30, height: 20 },
        cropBboxPx: { x: 8, y: 8, width: 34, height: 24 },
        paddingRatio: 0.08,
        rotationDegrees: 0,
        imageWidth: 100,
        imageHeight: 100
      },
      confidenceSource: "detector_min"
    },
    ...overrides
  };
}

function existingPipelineLine(): DialogueLineV2 {
  return {
    id: "line-existing",
    order: 7,
    pageNumber: 1,
    dialogueType: "speech",
    lineStatus: "draft",
    sourceLanguage: "ja",
    sourceText: "사용자 수정 원문",
    userTranslation: "사용자 번역",
    parseConfidence: 0.5,
    parseWarnings: [],
    polygon: [
      { x: 0.11, y: 0.11 }, { x: 0.39, y: 0.11 },
      { x: 0.39, y: 0.29 }, { x: 0.11, y: 0.29 }
    ],
    typesetting: {
      bbox: { x: 0.11, y: 0.11, width: 0.28, height: 0.18 },
      writingMode: "vertical-rl"
    },
    ocrEditStatus: "user_modified",
    ocrUserOwnedFields: [...OCR_USER_OWNED_FIELDS],
    ocrGroupId: "user-group",
    origin: pipelineOrigin("persistent-1")
  };
}

function pipelineOrigin(persistentRegionId: string): Extract<DialogueOrigin, { kind: "pipeline" }> {
  return {
      kind: "pipeline",
      persistentRegionId,
      latestRunId: "run-old",
      latestRegionId: "group-old",
      pageImageId: "page-image-1",
      candidateIds: ["det-1"],
      readingIndex: 7,
      sourceFingerprint: "old"
  };
}

describe("Production OCR reviewed candidate merge", () => {
  it("matches by IoU while preserving field-owned user values and translation", () => {
    const project = normalizeProject(createEmptyProject("OCR merge", false));
    const existing = existingPipelineLine();
    project.dialogueLines = [existing];

    const patch = buildProductionOcrReviewMergePatch({
      existingLines: project.dialogueLines,
      candidates: [candidate()],
      pageNumber: 1,
      pageImageId: "page-image-1",
      runId: "run-new"
    });
    const merged = applyMainProjectPatch(project, patch).dialogueLines[0]!;

    expect(merged.id).toBe("line-existing");
    expect(merged.origin).toMatchObject({
      kind: "pipeline",
      persistentRegionId: "persistent-1",
      latestRunId: "run-new",
      latestRegionId: "group-new"
    });
    expect(merged.sourceText).toBe("사용자 수정 원문");
    expect(merged.order).toBe(7);
    expect(merged.typesetting).toEqual(existing.typesetting);
    expect(merged.polygon).toEqual(existing.polygon);
    expect(merged.ocrGroupId).toBe("user-group");
    expect(merged.userTranslation).toBe("사용자 번역");
    expect(merged.ocrSourceInfo?.productionOcrProvenance?.groupId).toBe("group-new");
  });

  it("keeps manual and unmatched lines, and creates deterministic pipeline identity for new groups", () => {
    const manual: DialogueLineV2 = {
      ...existingPipelineLine(),
      id: "manual-line",
      origin: { kind: "manual" }
    };
    const unmatched = {
      ...existingPipelineLine(),
      id: "unmatched-pipeline",
      typesetting: {
        bbox: { x: 0.7, y: 0.7, width: 0.1, height: 0.1 },
        writingMode: "horizontal-tb" as const
      },
      origin: {
        ...pipelineOrigin("persistent-unmatched")
      }
    };

    const patch = buildProductionOcrReviewMergePatch({
      existingLines: [manual, unmatched],
      candidates: [candidate()],
      pageNumber: 1,
      pageImageId: "page-image-1",
      runId: "run-new"
    });

    expect(patch.orphanedPersistentRegionIds).toEqual(["persistent-unmatched"]);
    expect(patch.lines[0]?.origin).toMatchObject({
      kind: "pipeline",
      persistentRegionId: "ocr-region-group-new",
      latestRunId: "run-new"
    });
    expect(patch.lines[0]?.ocrEditStatus).toBe("user_confirmed");
    expect(patch.lines[0]?.ocrUserOwnedFields).toEqual(OCR_USER_OWNED_FIELDS);
    expect(patch.lines[0]?.order).toBe(8);
  });

  it("uses score order and stable IDs to resolve competing matches deterministically", () => {
    const first = existingPipelineLine();
    const second = {
      ...existingPipelineLine(),
      id: "line-second",
      origin: {
        ...pipelineOrigin("persistent-2")
      }
    };
    const candidates = [candidate({ id: "z", provenance: { ...candidate().provenance, groupId: "z" } }), candidate({
      id: "a",
      bbox: { x: 0.1, y: 0.1, width: 0.29, height: 0.19 },
      provenance: { ...candidate().provenance, groupId: "a" }
    })];

    const forward = buildProductionOcrReviewMergePatch({
      existingLines: [second, first], candidates, pageNumber: 1, pageImageId: "page-image-1", runId: "run"
    });
    const reversed = buildProductionOcrReviewMergePatch({
      existingLines: [first, second], candidates: [...candidates].reverse(), pageNumber: 1, pageImageId: "page-image-1", runId: "run"
    });

    expect(forward.lines.map((line) => [line.id, line.origin.kind === "pipeline" && line.origin.latestRegionId]))
      .toEqual(reversed.lines.map((line) => [line.id, line.origin.kind === "pipeline" && line.origin.latestRegionId]));
  });
});
