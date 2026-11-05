import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectFile, saveProjectFile } from "../../src/main/projectStorage.js";
import { MANGA_OCR_MODELS, PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";
import { adaptiveProductionOcrProvenanceFixture, productionOcrProvenanceFixture } from "../fixtures/productionOcrProvenance.js";

const pp = { modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: PRODUCTION_OCR_CONTRACT.detector.revision };

describe("Production OCR saved provenance compatibility", () => {
  it.each([
    ["legacy PP/Baberu without model arrays or recognition", PRODUCTION_OCR_CONTRACT.detector, PRODUCTION_OCR_CONTRACT.recognizer, undefined, undefined],
    ["PP/Baberu", PRODUCTION_OCR_CONTRACT.detector, PRODUCTION_OCR_CONTRACT.recognizer, [pp, pp], undefined],
    ["PP/Hayai", PRODUCTION_OCR_CONTRACT.detector, MANGA_OCR_MODELS.recognizer, [pp, pp], undefined],
    ["Manga/Baberu", MANGA_OCR_MODELS.detector, PRODUCTION_OCR_CONTRACT.recognizer, [MANGA_OCR_MODELS.detector, MANGA_OCR_MODELS.detector], undefined],
    ["Manga/Hayai", MANGA_OCR_MODELS.detector, MANGA_OCR_MODELS.recognizer, [MANGA_OCR_MODELS.detector, MANGA_OCR_MODELS.detector], undefined],
    ["mixed/Baberu", MANGA_OCR_MODELS.compositeDetector, PRODUCTION_OCR_CONTRACT.recognizer, [pp, MANGA_OCR_MODELS.detector], undefined],
    ["mixed/Hayai", MANGA_OCR_MODELS.compositeDetector, MANGA_OCR_MODELS.recognizer, [MANGA_OCR_MODELS.detector, pp], undefined],
    ["supported PP/Baberu", MANGA_OCR_MODELS.compositeDetector, PRODUCTION_OCR_CONTRACT.recognizer, [pp, pp], [MANGA_OCR_MODELS.detector, null]],
    ["supported PP/Hayai", MANGA_OCR_MODELS.compositeDetector, MANGA_OCR_MODELS.recognizer, [pp, pp], [null, MANGA_OCR_MODELS.detector]],
    ["supported mixed/Hayai", MANGA_OCR_MODELS.compositeDetector, MANGA_OCR_MODELS.recognizer, [pp, MANGA_OCR_MODELS.detector], [MANGA_OCR_MODELS.detector, null]],
    ["PP with null support", PRODUCTION_OCR_CONTRACT.detector, MANGA_OCR_MODELS.recognizer, [pp, pp], [null, null]],
    ["Manga with null support", MANGA_OCR_MODELS.detector, MANGA_OCR_MODELS.recognizer, [MANGA_OCR_MODELS.detector, MANGA_OCR_MODELS.detector], [null, null]]
  ] as const)("round-trips %s through .ctp while preserving user ownership", async (_label, detector, recognizer, models, supportModels) => {
    const provenance = {
      ...productionOcrProvenanceFixture(),
      detectorModelId: detector.modelId, detectorRevision: detector.revision,
      recognizerModelId: recognizer.modelId, recognizerRevision: recognizer.revision,
      ...(supportModels === undefined ? {} : { sourceDetectionSupportModels: supportModels }),
      ...(models ? {
        sourceDetectionModels: models,
        recognition: { rawOcrText: "ＳＹＮＴＨＥＴＩＣ", normalizedOcrText: "SYNTHETIC", normalization: PRODUCTION_OCR_CONTRACT.normalization }
      } : {})
    };
    const project = normalizeProject(createEmptyProject("Synthetic OCR provenance", false));
    project.dialogueLines = [{
      id: "synthetic-line", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "en",
      sourceText: "SYNTHETIC_USER_EDIT", parseConfidence: 0.8, parseWarnings: [],
      origin: { kind: "manual" }, ocrEditStatus: "user_modified", ocrUserOwnedFields: ["source_text"],
      ocrSourceInfo: { productionOcrProvenance: provenance }
    }];
    const root = await mkdtemp(join(tmpdir(), "trio-ocr-provenance-"));
    try {
      const filePath = join(root, "synthetic.ctp");
      await saveProjectFile({ filePath, project });
      const reopened = await loadProjectFile({ filePath });

      expect(reopened.project.dialogueLines[0]).toMatchObject({
        sourceText: "SYNTHETIC_USER_EDIT", ocrEditStatus: "user_modified", ocrUserOwnedFields: ["source_text"]
      });
      expect(reopened.project.dialogueLines[0]!.ocrSourceInfo!.productionOcrProvenance).toEqual(provenance);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips the actual additional crop pixels and recognition evidence through .ctp", async () => {
    const provenance = adaptiveProductionOcrProvenanceFixture();
    const project = createEmptyProject("Synthetic adaptive crop provenance", false);
    project.dialogueLines = [{
      id: "synthetic-adaptive-line", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "en",
      sourceText: "SYNTHETIC_USER_EDIT", parseConfidence: 0.55, parseWarnings: [],
      origin: { kind: "manual" }, ocrEditStatus: "user_modified", ocrUserOwnedFields: ["source_text"],
      ocrSourceInfo: { productionOcrProvenance: provenance }
    }];
    const root = await mkdtemp(join(tmpdir(), "trio-ocr-adaptive-provenance-"));
    try {
      const filePath = join(root, "synthetic.ctp");
      await saveProjectFile({ filePath, project });
      const reopened = await loadProjectFile({ filePath });
      expect(reopened.project.dialogueLines[0]).toMatchObject({
        sourceText: "SYNTHETIC_USER_EDIT", ocrEditStatus: "user_modified", ocrUserOwnedFields: ["source_text"]
      });
      expect(reopened.project.dialogueLines[0]!.ocrSourceInfo!.productionOcrProvenance).toEqual(provenance);
      expect(reopened.project.dialogueLines[0]!.ocrSourceInfo!.productionOcrProvenance!.cropTransform).toEqual({
        sourceBboxPx: { x: 20, y: 10, width: 100, height: 44 },
        cropBboxPx: { x: 10, y: 3, width: 122, height: 60 },
        paddingRatio: 0.08, rotationDegrees: 0, imageWidth: 200, imageHeight: 100,
        additionalPaddingPx: { left: 2, top: 3, right: 4, bottom: 5 }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
