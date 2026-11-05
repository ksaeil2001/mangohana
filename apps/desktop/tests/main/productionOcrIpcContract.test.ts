import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  registerIpcHandlers,
  validateApplyProductionOcrReviewArgs,
  validateProductionOcrRequestArgs
} from "../../src/main/ipcHandlers.js";
import { MANGA_OCR_MODELS, PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr.js";
import { adaptiveProductionOcrProvenanceFixture, productionOcrProvenanceFixture } from "../fixtures/productionOcrProvenance.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";
import { createProjectSessionManager } from "../../src/main/projectSessions.js";
import { saveProjectFile } from "../../src/main/projectStorage.js";
import type { GeminiApiKeyStore } from "../../src/main/geminiApiKeyStore.js";
import type { ProductionOcrService } from "../../src/main/productionOcrService.js";

type IpcHandler = (event: unknown, args?: unknown) => Promise<unknown>;
const ipcMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn()
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: IpcHandler) => ipcMocks.handlers.set(channel, handler) },
  protocol: { handle: vi.fn() },
  dialog: { showOpenDialog: ipcMocks.showOpenDialog, showSaveDialog: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  net: { fetch: vi.fn() }
}));

const validRequest = {
  requestId: "ocr-request-1",
  projectSessionId: "session-1",
  pageImageId: "page-1",
  sourceSha256: "a".repeat(64)
};

const validReviewRequest = {
  projectSessionId: "session-1",
  pageImageId: "page-1",
  sourceSha256: "a".repeat(64),
  runId: "ocr-run-1",
  candidates: [{
    id: "group-1",
    textType: "speech_bubble",
    text: "Production OCR",
    language: "en",
    bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    polygon: [
      { x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 },
      { x: 0.4, y: 0.3 }, { x: 0.1, y: 0.3 }
    ],
    readingOrder: 1,
    confidence: 0.91,
    notes: "",
    selectedSpeaker: "",
    orientation: "horizontal",
    productionOcrProvenance: {
      contractVersion: 1,
      detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
      detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
      recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
      recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
      groupId: "group-1",
      sourceDetectionIds: ["detection-1"],
      sourceDetectionScores: [0.91],
      sourceQuadsPx: [[
        { x: 100, y: 200 }, { x: 400, y: 200 },
        { x: 400, y: 300 }, { x: 100, y: 300 }
      ]],
      orientation: "horizontal",
      cropTransform: {
        sourceBboxPx: { x: 100, y: 200, width: 300, height: 100 },
        cropBboxPx: { x: 76, y: 192, width: 348, height: 116 },
        paddingRatio: 0.08,
        rotationDegrees: 0,
        imageWidth: 1000,
        imageHeight: 1000
      },
      confidenceSource: "detector_min"
    },
    typesetting: {
      bbox: { x: 0.12, y: 0.21, width: 0.26, height: 0.08 },
      writingMode: "horizontal-tb",
      rotationDegrees: 0
    }
  }]
};

function adaptiveReviewRequest() {
  const provenance = adaptiveProductionOcrProvenanceFixture();
  return { ...validReviewRequest, candidates: [{
    ...structuredClone(validReviewRequest.candidates[0]!),
    id: provenance.groupId,
    productionOcrProvenance: provenance
  }] };
}

describe("Production OCR IPC contract", () => {
  it("accepts only Main-resolved source identity fields", () => {
    expect(validateProductionOcrRequestArgs(validRequest)).toEqual(validRequest);
  });

  it.each([
    ["engine", "manga-ocr"],
    ["ocrEndpoint", "http://localhost:5000/ocr"],
    ["mangaOcrEndpoint", "http://localhost:5000/ocr"],
    ["paddleOcrEndpoint", "http://localhost:5001/ocr"],
    ["projectFilePath", "C:\\project.ctp"],
    ["interestMaskPngBase64", "mask"]
  ])("rejects the legacy %s routing field", (field, value) => {
    expect(() => validateProductionOcrRequestArgs({
      ...validRequest,
      [field]: value
    })).toThrow("Production OCR request");
  });

  it("accepts a review candidate only with exact frozen-model provenance", () => {
    expect(validateApplyProductionOcrReviewArgs(validReviewRequest)).toEqual(validReviewRequest);
  });

  it("accepts a pinned Manga/Hayai review with ordered models and recognition evidence", () => {
    const request = structuredClone(validReviewRequest);
    Object.assign(request.candidates[0]!.productionOcrProvenance, {
      detectorModelId: MANGA_OCR_MODELS.detector.modelId,
      detectorRevision: MANGA_OCR_MODELS.detector.revision,
      recognizerModelId: MANGA_OCR_MODELS.recognizer.modelId,
      recognizerRevision: MANGA_OCR_MODELS.recognizer.revision,
      sourceDetectionModels: [MANGA_OCR_MODELS.detector],
      recognition: { rawOcrText: "ＳＹＮＴＨＥＴＩＣ", normalizedOcrText: "SYNTHETIC", normalization: PRODUCTION_OCR_CONTRACT.normalization }
    });
    expect(validateApplyProductionOcrReviewArgs(request)).toEqual(request);
  });

  it("accepts exact additional crop pixels without changing the source bbox or default crop settings", () => {
    const request = adaptiveReviewRequest();
    expect(validateApplyProductionOcrReviewArgs(request)).toEqual(request);
  });

  it.each([false, true])("requires all six crop fields and rejects unknown fields (additional padding: %s)", (adaptive) => {
    const request = adaptive ? adaptiveReviewRequest() : structuredClone(validReviewRequest);
    for (const key of ["sourceBboxPx", "cropBboxPx", "paddingRatio", "rotationDegrees", "imageWidth", "imageHeight"]) {
      const missing = structuredClone(request);
      const transform = missing.candidates[0]!.productionOcrProvenance.cropTransform;
      Reflect.deleteProperty(transform, key);
      expect(() => validateApplyProductionOcrReviewArgs(missing)).toThrow("candidate contract mismatch");
    }
    Object.assign(request.candidates[0]!.productionOcrProvenance.cropTransform, { extra: true });
    expect(() => validateApplyProductionOcrReviewArgs(request)).toThrow("candidate contract mismatch");
  });

  it.each([
    ["missing edge", { additionalPaddingPx: { left: 2, top: 3, right: 4 } }],
    ["fractional edge", { additionalPaddingPx: { left: 2.5, top: 3, right: 4, bottom: 5 } }],
    ["negative edge", { additionalPaddingPx: { left: -2, top: 3, right: 4, bottom: 5 } }],
    ["oversized edge", { additionalPaddingPx: { left: 2, top: 3, right: 45, bottom: 5 } }],
    ["unknown edge", { additionalPaddingPx: { left: 2, top: 3, right: 4, bottom: 5, extra: 1 } }],
    ["all zero", { additionalPaddingPx: { left: 0, top: 0, right: 0, bottom: 0 } }],
    ["undefined padding", { additionalPaddingPx: undefined }],
    ["mismatched crop", { cropBboxPx: { x: 10, y: 3, width: 123, height: 60 } }],
    ["changed padding ratio", { paddingRatio: 0.4 }],
    ["rotated crop", { rotationDegrees: 90 }],
    ["changed source bbox", { sourceBboxPx: { x: 21, y: 10, width: 100, height: 44 } }],
    ["out of bounds", { additionalPaddingPx: { left: 0, top: 7, right: 0, bottom: 0 }, cropBboxPx: { x: 12, y: -1, width: 116, height: 59 } }]
  ])("rejects adaptive crop %s in both saved project validation and IPC", (_label, patch) => {
    const request = adaptiveReviewRequest();
    const provenance = request.candidates[0]!.productionOcrProvenance;
    Object.assign(provenance.cropTransform, patch);
    const project = createEmptyProject("Synthetic invalid crop", false);
    project.dialogueLines = [{
      id: "synthetic-line", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "en",
      sourceText: "SYNTHETIC", parseConfidence: 0.55, parseWarnings: [],
      ocrSourceInfo: { productionOcrProvenance: provenance }
    }];
    expect(() => normalizeProject(project)).toThrow(/malformed dialogue line/i);
    expect(() => validateApplyProductionOcrReviewArgs(request)).toThrow("candidate contract mismatch");
  });

  it.each(["legacy Baberu", "without Manga support", "mixed group", "supported PP group"])(
    "rejects adaptive padding for %s in saved project validation and IPC", (mode) => {
      const request = adaptiveReviewRequest();
      const provenance = request.candidates[0]!.productionOcrProvenance;
      if (mode === "legacy Baberu") Object.assign(provenance, {
        recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId, recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision
      });
      else if (mode === "without Manga support") Object.assign(provenance, {
        sourceDetectionSupportModels: undefined,
        detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId, detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision
      });
      else Object.assign(provenance, {
        sourceDetectionIds: ["first", "second"],
        sourceQuadsPx: [provenance.sourceQuadsPx[0], provenance.sourceQuadsPx[0]],
        sourceDetectionScores: [0.55, 0.8],
        sourceDetectionModels: [provenance.sourceDetectionModels![0], mode === "mixed group" ? MANGA_OCR_MODELS.detector : provenance.sourceDetectionModels![0]],
        sourceDetectionSupportModels: [MANGA_OCR_MODELS.detector, null]
      });
      const project = createEmptyProject("Synthetic invalid adaptive source", false);
      project.dialogueLines = [{
        id: "synthetic-line", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "en",
        sourceText: "SYNTHETIC", parseConfidence: 0.55, parseWarnings: [],
        ocrSourceInfo: { productionOcrProvenance: provenance }
      }];
      expect(() => normalizeProject(project)).toThrow(/malformed dialogue line/i);
      expect(() => validateApplyProductionOcrReviewArgs(request)).toThrow("candidate contract mismatch");
    }
  );

  it("accepts adaptive provenance through registered IPC while preserving session ownership and stale-source rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "trio-ocr-adaptive-ipc-"));
    const manager = createProjectSessionManager();
    const keyStatus = { configured: false, source: "none", persistence: "encrypted", requiresReentry: false } as const;
    const geminiApiKeyStore: GeminiApiKeyStore = {
      initialize: vi.fn(async () => keyStatus), getStatus: vi.fn(() => keyStatus),
      set: vi.fn(async () => keyStatus), clear: vi.fn(async () => keyStatus)
    };
    const blocked = { state: "blocked", ready: false, message: "No model execution in this contract test" } as const;
    const productionOcrService: ProductionOcrService = {
      getStatus: vi.fn(async () => blocked), setResourceRoot: vi.fn(async () => blocked),
      installOrRepair: vi.fn(async () => blocked), close: vi.fn(),
      execute: vi.fn(async () => { throw new Error("Model execution is outside this contract test"); })
    };
    const invoke = (channel: string, args: unknown, ownerId: number) => {
      const handler = ipcMocks.handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler({ sender: { id: ownerId, isDestroyed: () => false, send: vi.fn() } }, args);
    };
    try {
      const filePath = join(root, "Project.ctp");
      const bytes = Buffer.from("synthetic-image-bytes");
      const project = createEmptyProject("Synthetic adaptive IPC", false);
      project.pageImages = [{
        id: "page-1", pageNumber: 1, storedRelativePath: "Project-assets/images/page-1.png", originalFileName: "page-1.png",
        sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length,
        mimeType: "image/png", copiedAt: "2026-11-05T00:00:00.000Z"
      }];
      await mkdir(join(root, "Project-assets", "images"), { recursive: true });
      await writeFile(join(root, "Project-assets", "images", "page-1.png"), bytes);
      await saveProjectFile({ filePath, project });
      ipcMocks.handlers.clear();
      registerIpcHandlers({ geminiApiKeyStore, projectSessionManager: manager, productionOcrService });
      ipcMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
      const session = await invoke("project:openFromDialog", undefined, 41) as { projectSessionId: string };
      const request = { ...adaptiveReviewRequest(), projectSessionId: session.projectSessionId, sourceSha256: project.pageImages[0]!.sha256 };

      await expect(invoke("project:applyProductionOcrReview", request, 42)).rejects.toThrow(/belongs to another renderer/);
      await expect(invoke("project:applyProductionOcrReview", { ...request, sourceSha256: "a".repeat(64) }, 41))
        .rejects.toThrow(/source revision is stale/);
      const invalid = structuredClone(request);
      Object.assign(invalid.candidates[0]!.productionOcrProvenance.cropTransform, { additionalPaddingPx: { left: -1, top: 3, right: 4, bottom: 5 } });
      await expect(invoke("project:applyProductionOcrReview", invalid, 41)).rejects.toThrow("candidate contract mismatch");
      expect(manager.getProject(session.projectSessionId).project.dialogueLines).toEqual([]);

      await invoke("project:applyProductionOcrReview", request, 41);

      const line = manager.getProject(session.projectSessionId).project.dialogueLines[0]!;
      expect(line).toMatchObject({ sourceText: "Production OCR", ocrEditStatus: "user_confirmed" });
      expect(line.ocrSourceInfo!.productionOcrProvenance).toEqual(request.candidates[0]!.productionOcrProvenance);
      expect(productionOcrService.execute).not.toHaveBeenCalled();
    } finally {
      await manager.disposeAll();
      ipcMocks.handlers.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  const pp = { modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: PRODUCTION_OCR_CONTRACT.detector.revision };
  it.each([
    ["unknown detector", { detectorModelId: "unknown" }],
    ["mismatched detector revision", { detectorRevision: MANGA_OCR_MODELS.detector.revision }],
    ["unknown recognizer", { recognizerModelId: "unknown" }],
    ["mismatched recognizer revision", { recognizerModelId: MANGA_OCR_MODELS.recognizer.modelId }],
    ["Hayai without models", { recognizerModelId: MANGA_OCR_MODELS.recognizer.modelId, recognizerRevision: MANGA_OCR_MODELS.recognizer.revision }],
    ["Manga without models", { detectorModelId: MANGA_OCR_MODELS.detector.modelId, detectorRevision: MANGA_OCR_MODELS.detector.revision }],
    ["composite without models", { detectorModelId: MANGA_OCR_MODELS.compositeDetector.modelId, detectorRevision: MANGA_OCR_MODELS.compositeDetector.revision }],
    ["unknown source model", { sourceDetectionModels: [pp, { modelId: "unknown", revision: "1" }] }],
    ["mismatched source revision", { sourceDetectionModels: [pp, { modelId: MANGA_OCR_MODELS.detector.modelId, revision: pp.revision }] }],
    ["composite as a source", { sourceDetectionModels: [pp, MANGA_OCR_MODELS.compositeDetector] }],
    ["truncated models", { sourceDetectionModels: [pp] }],
    ["extra models", { sourceDetectionModels: [pp, pp, pp] }],
    ["null models", { sourceDetectionModels: null }],
    ["PP identity with shuffled mixed members", { sourceDetectionModels: [MANGA_OCR_MODELS.detector, pp] }],
    ["Manga identity with mixed members", { detectorModelId: MANGA_OCR_MODELS.detector.modelId, detectorRevision: MANGA_OCR_MODELS.detector.revision, sourceDetectionModels: [pp, MANGA_OCR_MODELS.detector] }],
    ["composite identity with only PP members", { detectorModelId: MANGA_OCR_MODELS.compositeDetector.modelId, detectorRevision: MANGA_OCR_MODELS.compositeDetector.revision, sourceDetectionModels: [pp, pp] }],
    ["composite identity with only Manga members", { detectorModelId: MANGA_OCR_MODELS.compositeDetector.modelId, detectorRevision: MANGA_OCR_MODELS.compositeDetector.revision, sourceDetectionModels: [MANGA_OCR_MODELS.detector, MANGA_OCR_MODELS.detector] }],
    ["truncated quads", { sourceQuadsPx: productionOcrProvenanceFixture().sourceQuadsPx.slice(0, 1) }],
    ["truncated scores", { sourceDetectionScores: [0.9] }],
    ["duplicate IDs", { sourceDetectionIds: ["synthetic-a", "synthetic-a"] }],
    ["unknown provenance field", { unexpected: true }],
    ["inconsistent recognition", { recognition: { rawOcrText: "Ａ", normalizedOcrText: "B", normalization: PRODUCTION_OCR_CONTRACT.normalization } }]
  ])("rejects %s in both project validation and IPC", (_label, patch) => {
    const provenance = { ...productionOcrProvenanceFixture(), ...patch };
    const project = createEmptyProject("Synthetic invalid provenance", false);
    project.dialogueLines = [{
      id: "synthetic-line", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "en",
      sourceText: "SYNTHETIC", parseConfidence: 0.8, parseWarnings: [],
      ocrSourceInfo: { productionOcrProvenance: productionOcrProvenanceFixture() }
    }];
    Object.assign(project.dialogueLines[0]!.ocrSourceInfo!, { productionOcrProvenance: provenance });
    const request = structuredClone(validReviewRequest);
    request.candidates[0]!.id = "synthetic-group";
    Object.assign(request.candidates[0]!, { productionOcrProvenance: provenance });

    expect(() => normalizeProject(project)).toThrow(/malformed dialogue line/i);
    expect(() => validateApplyProductionOcrReviewArgs(request)).toThrow("candidate contract mismatch");
  });

  it.each([
    ["truncated support array", { sourceDetectionSupportModels: [MANGA_OCR_MODELS.detector] }],
    ["extra support entries", { sourceDetectionSupportModels: [null, MANGA_OCR_MODELS.detector, null] }],
    ["null support array", { sourceDetectionSupportModels: null }],
    ["undefined support entry", { sourceDetectionSupportModels: [undefined, MANGA_OCR_MODELS.detector] }],
    ["sparse support array", { sourceDetectionSupportModels: Array(2) }],
    ["unknown support model", { sourceDetectionSupportModels: [null, { modelId: "unknown", revision: "1" }] }],
    ["unpinned support revision", { sourceDetectionSupportModels: [null, { ...MANGA_OCR_MODELS.detector, revision: "latest" }] }],
    ["same PP support", { sourceDetectionSupportModels: [null, pp] }],
    ["same Manga support", { sourceDetectionModels: [pp, MANGA_OCR_MODELS.detector] }],
    ["Manga supported by PP", { sourceDetectionModels: [pp, MANGA_OCR_MODELS.detector], sourceDetectionSupportModels: [null, pp] }],
    ["support misaligned with shuffled source models", { sourceDetectionModels: [MANGA_OCR_MODELS.detector, pp], sourceDetectionSupportModels: [MANGA_OCR_MODELS.detector, null] }],
    ["composite as support", { sourceDetectionSupportModels: [null, MANGA_OCR_MODELS.compositeDetector] }],
    ["recognizer as support", { sourceDetectionSupportModels: [null, MANGA_OCR_MODELS.recognizer] }],
    ["raw capture inside support identity", { sourceDetectionSupportModels: [null, { ...MANGA_OCR_MODELS.detector, score: 0.9, quad: [] }] }],
    ["support without raw model array", { sourceDetectionModels: undefined }],
    ["null support without legacy raw model array", { detectorModelId: pp.modelId, detectorRevision: pp.revision, sourceDetectionModels: undefined, sourceDetectionSupportModels: [null, null] }],
    ["PP group identity despite support", { detectorModelId: pp.modelId, detectorRevision: pp.revision }],
    ["Manga group identity despite support", { detectorModelId: MANGA_OCR_MODELS.detector.modelId, detectorRevision: MANGA_OCR_MODELS.detector.revision }],
    ["composite with only PP and null support", { sourceDetectionSupportModels: [null, null] }]
  ])("rejects %s in both saved provenance and IPC", (_label, patch) => {
    const provenance = {
      ...productionOcrProvenanceFixture(),
      detectorModelId: MANGA_OCR_MODELS.compositeDetector.modelId,
      detectorRevision: MANGA_OCR_MODELS.compositeDetector.revision,
      sourceDetectionModels: [pp, pp], sourceDetectionSupportModels: [null, MANGA_OCR_MODELS.detector],
      ...patch
    };
    const project = createEmptyProject("Synthetic invalid support", false);
    project.dialogueLines = [{
      id: "synthetic-line", order: 1, pageNumber: 1, dialogueType: "speech", sourceLanguage: "en",
      sourceText: "SYNTHETIC", parseConfidence: 0.8, parseWarnings: [],
      ocrSourceInfo: { productionOcrProvenance: productionOcrProvenanceFixture() }
    }];
    Object.assign(project.dialogueLines[0]!.ocrSourceInfo!, { productionOcrProvenance: provenance });
    const request = structuredClone(validReviewRequest);
    request.candidates[0]!.id = "synthetic-group";
    Object.assign(request.candidates[0]!, { productionOcrProvenance: provenance });

    expect(() => normalizeProject(project)).toThrow(/malformed dialogue line/i);
    expect(() => validateApplyProductionOcrReviewArgs(request)).toThrow("candidate contract mismatch");
  });

  it.each([
    ["legacy candidate routing", (request: typeof validReviewRequest) => Object.assign(request.candidates[0]!, { engine: "manga-ocr" })],
    ["unsupported language", (request: typeof validReviewRequest) => { request.candidates[0]!.language = "fr"; }],
    ["recognizer revision drift", (request: typeof validReviewRequest) => {
      Object.defineProperty(request.candidates[0]!.productionOcrProvenance, "recognizerRevision", { value: "latest" });
    }],
    ["rotated vertical shortcut", (request: typeof validReviewRequest) => { request.candidates[0]!.productionOcrProvenance.cropTransform.rotationDegrees = 90; }],
    ["truncated detection quad", (request: typeof validReviewRequest) => { request.candidates[0]!.productionOcrProvenance.sourceQuadsPx[0]!.pop(); }],
    ["missing detection score", (request: typeof validReviewRequest) => { request.candidates[0]!.productionOcrProvenance.sourceDetectionScores.pop(); }],
    ["unbounded typesetting", (request: typeof validReviewRequest) => { request.candidates[0]!.typesetting!.bbox.x = 0.9; }]
  ])("rejects %s in a review candidate", (_label, mutate) => {
    const request = structuredClone(validReviewRequest);
    mutate(request);
    expect(() => validateApplyProductionOcrReviewArgs(request)).toThrow("candidate contract mismatch");
  });
});
