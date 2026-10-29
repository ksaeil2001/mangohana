import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProductionOcrPipeline } from "../../src/main/ocr/pipeline/productionOcrPipeline.js";
import { parseProductionOcrDetections } from "../../src/main/ocr/detection/productionDetectorParser.js";
import { buildProductionOcrReviewMergePatch } from "../../src/main/ocr/pipeline/productionOcrReviewMerge.js";
import { applyMainProjectPatch, applyNormalizedProjectMutation } from "../../src/main/projectReplay.js";
import { loadProjectFile, saveProjectFile } from "../../src/main/projectStorage.js";
import { formatTranslationTxt } from "../../src/shared/exportTranslations.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";

describe("Production OCR deterministic Golden Path", () => {
  it("connects imported image identity through review, downstream edits, save/reopen, and export", async () => {
    const sourceImage = Buffer.from("immutable-source-image");
    const sourceSnapshot = Buffer.from(sourceImage);
    const pipeline = new ProductionOcrPipeline({
      detector: {
        detect: async () => parseProductionOcrDetections({
          detections: [
            { detectionId: "det-1", quad: [[20, 10], [120, 10], [120, 30], [20, 30]], score: 0.93 },
            { detectionId: "det-2", quad: [[20, 34], [120, 34], [120, 54], [20, 54]], score: 0.89 }
          ]
        }, 200, 100)
      },
      cropGroup: ({ group }) => ({
        cropBytes: Buffer.from("group-crop"),
        transform: {
          sourceBboxPx: group.groupBboxPx,
          cropBboxPx: { x: 12, y: 6, width: 116, height: 52 },
          paddingRatio: 0.08,
          rotationDegrees: 0,
          imageWidth: 200,
          imageHeight: 100
        }
      }),
      recognizer: {
        recognizeGroup: async () => ({ text: "ＨＥＬＬＯ﹁猫﹂" })
      }
    });

    const extraction = await pipeline.execute({ imageBytes: sourceImage, pageNumber: 1 });
    expect(sourceImage).toEqual(sourceSnapshot);
    expect(extraction.speechBubbles[0]?.text).toBe("HELLO「猫」");
    const bubble = extraction.speechBubbles[0]!;
    expect(bubble.productionOcrProvenance).toBeDefined();

    let project = normalizeProject(createEmptyProject("Production OCR Golden Path", false));
    project.pageImages = [{
      id: "page-image-1",
      pageNumber: 1,
      storedRelativePath: "Production OCR Golden Path-assets/images/page-001.png",
      originalFileName: "page-001.png",
      sha256: "a".repeat(64),
      byteSize: sourceImage.byteLength,
      mimeType: "image/png",
      copiedAt: "2026-09-14T00:00:00.000Z"
    }];
    project = applyMainProjectPatch(project, buildProductionOcrReviewMergePatch({
      existingLines: project.dialogueLines,
      pageNumber: 1,
      pageImageId: "page-image-1",
      runId: "ocr-run-1",
      candidates: [{
        id: bubble.id,
        text: bubble.text,
        sourceLanguage: bubble.language === "ja" || bubble.language === "en" ? bubble.language : "unknown",
        dialogueType: "speech",
        bbox: bubble.bbox,
        polygon: bubble.polygon!,
        readingOrder: bubble.readingOrder,
        confidence: bubble.confidence,
        orientation: bubble.orientation!,
        selectedSpeaker: "",
        notes: "",
        provenance: bubble.productionOcrProvenance!,
        typesetting: { bbox: bubble.bbox, writingMode: "horizontal-tb" }
      }]
    }));

    const lineId = project.dialogueLines[0]!.id;
    project = applyMainProjectPatch(project, {
      type: "commit_batch_result",
      dialogueUpdates: [{ id: lineId, aiTranslation: "AI 번역", lineStatus: "draft" }]
    });
    project = applyMainProjectPatch(project, {
      type: "commit_processing_run",
      run: {
        runId: "inpaint-run-1",
        pageImageId: "page-image-1",
        source: "automatic_pipeline",
        status: "completed",
        sourceSha256: "a".repeat(64),
        appVersion: "0.1.4",
        queuedAt: "2026-09-14T00:00:00.000Z",
        completedAt: "2026-09-14T00:00:01.000Z"
      },
      pageRecord: {
        pageImageId: "page-image-1",
        latestCompletedRunId: "inpaint-run-1",
        approvedCleanedAssetId: "cleaned-asset-1",
        finalStatus: "auto_approved",
        updatedAt: "2026-09-14T00:00:01.000Z"
      },
      assets: [{
        assetId: "cleaned-asset-1",
        source: "automatic_pipeline",
        sourcePageImageId: "page-image-1",
        runId: "inpaint-run-1",
        role: "cleaned",
        storedRelativePath: "derived/cleaned-asset-1.png",
        sha256: "b".repeat(64),
        byteSize: 42,
        mimeType: "image/png",
        createdAt: "2026-09-14T00:00:01.000Z"
      }]
    });
    project = applyNormalizedProjectMutation(project, {
      type: "update_dialogue_line",
      lineId,
      patch: {
        sourceText: "사용자 수정 원문",
        userTranslation: "사용자 최종 번역"
      }
    });

    const temporaryRoot = await mkdtemp(join(tmpdir(), "trio-production-ocr-golden-"));
    try {
      const filePath = join(temporaryRoot, "golden.ctp");
      await saveProjectFile({ filePath, project });
      const reopened = await loadProjectFile({ filePath });
      const reopenedLine = reopened.project.dialogueLines[0]!;
      expect(reopenedLine).toMatchObject({
        sourceText: "사용자 수정 원문",
        userTranslation: "사용자 최종 번역",
        ocrEditStatus: "user_modified",
        ocrUserOwnedFields: ["source_text", "reading_order", "geometry", "group_assignment"],
        typesetting: { writingMode: "horizontal-tb" }
      });
      expect(reopenedLine.ocrSourceInfo?.productionOcrProvenance?.recognition).toEqual({
        rawOcrText: "ＨＥＬＬＯ﹁猫﹂",
        normalizedOcrText: "HELLO「猫」",
        normalization: "NFKC_JAPANESE_QUOTES"
      });
      const invalid = structuredClone(reopened.project);
      invalid.dialogueLines[0]!.ocrSourceInfo!.productionOcrProvenance = {
        ...bubble.productionOcrProvenance!,
        recognition: { rawOcrText: "Ａ", normalizedOcrText: "unrelated", normalization: "NFKC_JAPANESE_QUOTES" }
      };
      expect(() => normalizeProject(invalid)).toThrow();
      const legacy = structuredClone(reopened.project);
      const { recognition: _recognition, ...legacyProvenance } = legacy.dialogueLines[0]!.ocrSourceInfo!.productionOcrProvenance!;
      legacy.dialogueLines[0]!.ocrSourceInfo!.productionOcrProvenance = legacyProvenance;
      expect(normalizeProject(legacy).dialogueLines[0]!.sourceText).toBe("사용자 수정 원문");

      const rerun = await pipeline.execute({ imageBytes: sourceImage, pageNumber: 1 });
      const rerunBubble = rerun.speechBubbles[0]!;
      const merged = applyMainProjectPatch(reopened.project, buildProductionOcrReviewMergePatch({
        existingLines: reopened.project.dialogueLines, pageNumber: 1,
        pageImageId: "page-image-1", runId: "ocr-run-2",
        candidates: [{
          id: rerunBubble.id, text: rerunBubble.text, sourceLanguage: "ja", dialogueType: "speech",
          bbox: rerunBubble.bbox, polygon: rerunBubble.polygon!, readingOrder: rerunBubble.readingOrder,
          confidence: rerunBubble.confidence, orientation: rerunBubble.orientation!, selectedSpeaker: "",
          notes: "", provenance: rerunBubble.productionOcrProvenance!
        }]
      }));
      expect(merged.dialogueLines).toHaveLength(1);
      expect(merged.dialogueLines[0]).toMatchObject({
        sourceText: "사용자 수정 원문", userTranslation: "사용자 최종 번역",
        ocrEditStatus: "user_modified", origin: { latestRunId: "ocr-run-2" }
      });
      await saveProjectFile({ filePath, project: merged });
      const reopenedRerun = await loadProjectFile({ filePath });
      expect(reopenedRerun.project.dialogueLines[0]!.userTranslation).toBe("사용자 최종 번역");
      expect(reopenedRerun.project.dialogueLines[0]!.ocrSourceInfo?.productionOcrProvenance?.recognition)
        .toEqual(reopenedLine.ocrSourceInfo?.productionOcrProvenance?.recognition);
      expect(reopened.project.processing.pages[0]).toMatchObject({
        approvedCleanedAssetId: "cleaned-asset-1",
        finalStatus: "auto_approved"
      });
      expect(formatTranslationTxt(reopened.project)).toContain("사용자 최종 번역");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
