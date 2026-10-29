import { describe, expect, it } from "vitest";
import {
  applyConservativeMaskDilation,
  calculateAdaptiveDilationRadius,
  clipMaskToNormalizedBounds,
  dilateBinaryMask
} from "../../src/shared/maskMorphology.js";
import {
  buildDialogueTranslationContext,
  formatMangaTranslationSystemPrompt
} from "../../src/shared/translationContext.js";
import {
  parseGlossaryFile,
  reconcileGlossaryTerms
} from "../../src/shared/glossaryPipeline.js";
import {
  compositeRawRgbaBuffers
} from "../../src/main/inpaintingImageGeometry.js";
import {
  createDefaultInpaintingRegistry,
  InpaintingEngineRegistry
} from "../../src/main/inpainting/inpaintingRegistry.js";
import {
  evaluateInpaintingQuality
} from "../../src/shared/inpaintingQa.js";
import {
  autoFitFontSizeForBubbleShape,
  calculateContrastStroke,
  dialogueTypesettingToDraft,
  draftToDialogueTypesetting,
  getRecommendedFontFallbackChain,
  layoutTextForBubbleShape
} from "../../src/renderer/typesettingGeometry.js";
import {
  createEmptyProject,
  normalizeProject
} from "../../src/shared/projectValidation.js";
import {
  validateAndNormalizeProjectMutation
} from "../../src/main/projectMutations.js";
import {
  applyNormalizedProjectMutation
} from "../../src/main/projectReplay.js";
import type { DialogueLine, DialogueTypesetting } from "../../src/shared/projectTypes.js";

describe("E2E Manga Translation Pipeline Benchmark", () => {
  it("executes the full 4-stage pipeline on a complex manga sample page", async () => {
    // -------------------------------------------------------------
    // Stage 1: Mask Morphology & Boundary Preservation
    // -------------------------------------------------------------
    const canvasWidth = 800;
    const canvasHeight = 1200;
    const bubbleBbox = { x: 0.2, y: 0.15, width: 0.4, height: 0.25 }; // 40% x 25%

    const dilationRadius = calculateAdaptiveDilationRadius({
      bboxWidth: bubbleBbox.width,
      bboxHeight: bubbleBbox.height,
      canvasWidth,
      canvasHeight
    });
    expect(dilationRadius).toBeGreaterThanOrEqual(4);
    expect(dilationRadius).toBeLessThanOrEqual(24);

    // Create 100x100 mock 1-channel binary mask
    const maskWidth = 100;
    const maskHeight = 100;
    const rawMask = new Uint8Array(maskWidth * maskHeight);
    rawMask[50 * maskWidth + 50] = 255; // Single point at center

    const dilatedMask = dilateBinaryMask(rawMask, maskWidth, maskHeight, 3);
    expect(dilatedMask[50 * maskWidth + 50]).toBe(255);
    expect(dilatedMask[50 * maskWidth + 52]).toBe(255); // 2px right is dilated

    const safeArea = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const clippedMask = clipMaskToNormalizedBounds(dilatedMask, maskWidth, maskHeight, safeArea);
    expect(clippedMask).toHaveLength(maskWidth * maskHeight);

    // -------------------------------------------------------------
    // Stage 2: Context Window, Tone Presets & Glossary Reconciliation
    // -------------------------------------------------------------
    const rawGlossaryText = [
      "月華一閃\t월화일섬\t필살기",
      "黒妖の森\t흑요의 숲\t지명",
      "先輩\t선배\t존칭"
    ].join("\n");
    const dictionaryTerms = parseGlossaryFile(rawGlossaryText, "tsv");
    expect(dictionaryTerms).toHaveLength(3);

    const characters = [
      {
        id: "char-1",
        name: "세실",
        aliases: ["セシル", "발렌타인"],
        description: "흑기사",
        speechStyle: "호전적인 츤데레 어조"
      }
    ];

    const dialogueLines: DialogueLine[] = [
      {
        id: "line-1",
        order: 1,
        pageNumber: 1,
        speaker: "세실",
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "ここは黒妖の森…気をつけるのだ、先輩。",
        userTranslation: "여기는 흑요의 숲… 조심해, 선배.",
        parseConfidence: 0.95,
        parseWarnings: []
      },
      {
        id: "line-2",
        order: 2,
        pageNumber: 1,
        speaker: "세실",
        dialogueType: "speech",
        sourceLanguage: "ja",
        sourceText: "これでも喰らえ！月華一閃！",
        parseConfidence: 0.98,
        parseWarnings: []
      }
    ];

    const context = buildDialogueTranslationContext({
      dialogueLines,
      targetLineId: "line-2",
      characters,
      dictionaryTerms,
      options: { stylePreset: "tsundere", contextWindowSize: 2 }
    });

    expect(context.targetLine.id).toBe("line-2");
    expect(context.speakerProfile?.name).toBe("세실");
    expect(context.matchedTerms.map((t) => t.target)).toContain("월화일섬");
    expect(context.formattedSystemPrompt).toContain("츤데레");

    // Glossary reconciliation test
    const rawAiOutput = "이거나 먹어라! 달빛 베기!";
    const reconciled = reconcileGlossaryTerms(context.targetLine.sourceText, rawAiOutput, context.matchedTerms);
    expect(reconciled.replacements).toEqual([{ source: "月華一閃", target: "월화일섬" }]);

    // -------------------------------------------------------------
    // Stage 3: Inpainting Lossless Composite & Residual Text QA Loop
    // -------------------------------------------------------------
    const registry = createDefaultInpaintingRegistry();
    expect(registry.hasEngine("gemini")).toBe(true);
    expect(registry.hasEngine("openai")).toBe(true);
    expect(registry.hasEngine("local-lama")).toBe(true);
    expect(registry.hasEngine("local-aot")).toBe(true);
    expect(registry.listEngines().map((e) => e.providerId)).toContain("gemini");

    // Lossless RGBA Composite test: 2x2 mock images
    const width = 2;
    const height = 2;
    // Source: pure blue [0, 0, 255, 255]
    const sourceRgba = Buffer.from([
      0, 0, 255, 255,   0, 0, 255, 255,
      0, 0, 255, 255,   0, 0, 255, 255
    ]);
    // Edited: pure red [255, 0, 0, 255]
    const editedRgba = Buffer.from([
      255, 0, 0, 255,   255, 0, 0, 255,
      255, 0, 0, 255,   255, 0, 0, 255
    ]);
    // Mask: only top-left pixel is 255 (masked)
    const compositeMask = Buffer.from([
      255, 0,
      0,   0
    ]);

    const composited = compositeRawRgbaBuffers({
      sourceRgba,
      editedRgba,
      maskBuffer: compositeMask,
      width,
      height
    });

    // Top-left should be red (inpainted)
    expect(composited[0]).toBe(255);
    expect(composited[2]).toBe(0);
    // Bottom-right should be 100% untouched source blue
    expect(composited[12]).toBe(0);
    expect(composited[14]).toBe(255);

    // QA Inspection evaluation
    const cleanQa = evaluateInpaintingQuality({ residualRegions: [] });
    expect(cleanQa.qaStatus).toBe("pass");
    expect(cleanQa.cleanlinessScore).toBe(1.0);

    // -------------------------------------------------------------
    // Stage 4: Intelligent Typesetting & Non-Destructive Persistence
    // -------------------------------------------------------------
    const finalTranslation = "이거나 먹어라! 월화일섬!";
    const fontChain = getRecommendedFontFallbackChain("ko", "Pretendard");
    expect(fontChain).toContain("Pretendard");
    expect(fontChain).toContain("NanumGothic");
    expect(fontChain).toContain("Noto Sans CJK KR");

    const contrast = calculateContrastStroke({
      textColor: "#000000",
      isDarkBackground: false,
      fontSizeRatio: 0.12
    });
    expect(contrast.strokeColor).toBe("#ffffff");
    expect(contrast.strokeWidth).toBeGreaterThanOrEqual(2);

    const layout = layoutTextForBubbleShape(finalTranslation, {
      shape: "ellipse",
      fontSizeRatio: 0.14
    });
    expect(layout.lines.length).toBeGreaterThan(0);

    const autoFit = autoFitFontSizeForBubbleShape(finalTranslation, { shape: "ellipse" });
    expect(autoFit.fontSizeRatio).toBeGreaterThan(0.04);

    // Project mutation & persistence
    const project = normalizeProject(createEmptyProject("Pipeline Benchmark", false));
    project.dialogueLines.push({
      ...dialogueLines[1]!,
      origin: { kind: "manual" }
    });

    const typesettingPayload: DialogueTypesetting = {
      bbox: bubbleBbox,
      writingMode: "horizontal-tb",
      shape: "ellipse",
      fontFamily: "Pretendard",
      fontSizeRatio: autoFit.fontSizeRatio,
      color: "#000000",
      strokeColor: contrast.strokeColor,
      strokeWidth: contrast.strokeWidth,
      align: "center",
      lineHeight: 1.2
    };

    const draft = dialogueTypesettingToDraft("draft-bench", "line-2", typesettingPayload);
    expect(draft.bbox).toEqual(bubbleBbox);

    const mutationResult = validateAndNormalizeProjectMutation(project, {
      type: "update_dialogue_typesetting",
      lineId: "line-2",
      typesetting: typesettingPayload
    });

    const updatedProject = applyNormalizedProjectMutation(project, mutationResult.mutation);
    expect(updatedProject.dialogueLines[0]?.typesetting).toEqual(typesettingPayload);
  });

  it("benchmarks inpainting pipeline 6-principle architecture (conservative masking, QA loop, fallback)", async () => {
    // 1. Conservative Dilation Benchmark (PanelCleaner principle)
    const denseMaskWidth = 200;
    const denseMaskHeight = 300;
    const denseMask = new Uint8Array(denseMaskWidth * denseMaskHeight);
    // Draw an arbitrary text region in center
    for (let y = 100; y < 150; y++) {
      for (let x = 80; x < 120; x++) {
        denseMask[y * denseMaskWidth + x] = 255;
      }
    }
    const safeBounds = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const conservativeDilated = applyConservativeMaskDilation({
      mask: denseMask,
      width: denseMaskWidth,
      height: denseMaskHeight,
      radius: 4,
      safeArea: safeBounds
    });
    expect(conservativeDilated.length).toBe(denseMaskWidth * denseMaskHeight);
    // Verified boundary expansion
    expect(conservativeDilated[98 * denseMaskWidth + 80]).toBe(255);

    // 2. Residual Text QA Inspection & Action Recommendation (BallonsTranslator-vibe principle)
    const qaWithResiduals = evaluateInpaintingQuality({
      residualRegions: [
        {
          bbox: { x: 0.45, y: 0.45, width: 0.05, height: 0.05 },
          severity: "minor",
          residualConfidence: 0.72,
          notes: "작은 잔여 선화 발견"
        }
      ],
      attemptCount: 1,
      maxRetryAttempts: 2
    });
    expect(qaWithResiduals.qaStatus).toBe("retry");
    expect(qaWithResiduals.recommendedAction).toBe("auto_retry_dilate");
    expect(qaWithResiduals.recommendedDilation).toBe(2);

    // 3. MangaTranslator Fallback Engine Benchmark
    const registry = new InpaintingEngineRegistry();
    registry.register({
      providerId: "openai",
      displayName: "OpenAI DALL-E",
      isLocal: false,
      isAvailable: async () => ({ available: true }),
      inpaint: async () => {
        throw new Error("OpenAI API rate limit exceeded");
      }
    });
    registry.register({
      providerId: "local-lama",
      displayName: "Local-LaMa-Deterministic",
      isLocal: true,
      isAvailable: async () => ({ available: true }),
      inpaint: async () => ({
        editedImageBytes: Buffer.from("mock-reconstructed-clean-png"),
        provider: "local-lama" as const
      })
    });

    const fallbackResult = await registry.executeWithFallback("openai", "local-lama", {
      imageBytes: Buffer.from("mock-source-png"),
      maskBytes: Buffer.from("mock-mask-png"),
      sourceMimeType: "image/png",
      mode: "speech-bubble"
    });
    expect(fallbackResult.provider).toBe("local-lama");
    expect(fallbackResult.fallbackTriggered).toBe(true);
    expect(fallbackResult.editedImageBytes.length).toBeGreaterThan(0);
  });
});
