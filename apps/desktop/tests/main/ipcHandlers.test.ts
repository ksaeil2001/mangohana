import { describe, expect, it, vi } from "vitest";
import * as ipcHandlersModule from "../../src/main/ipcHandlers";
import {
  validateChooseSaveFileArgs,
  validateExportTranslationsArgs,
  validateExportProjectImagesArgs,
  validateProcessingQueueActionArgs,
  validateGeminiApiKeyArgs,
  validateImportPageImagesArgs,
  validateInpaintPageImageArgs,
  validateOpenProjectArgs,
  validateSaveProjectArgs,
  validateBatchRunArgs
} from "../../src/main/ipcHandlers";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  },
  ipcMain: {
    handle: vi.fn()
  }
}));

describe("ipc argument validation", () => {
  it("requires exactly the clicked cleaned result identity and a safe exact revision", () => {
    const validate = ipcHandlersModule.validateReviewCleanedAssetArgs;
    expect(validate).toBeTypeOf("function");
    const args = { projectSessionId: "session-1", pageImageId: "page-1", cleanedAssetId: "cleaned-1", expectedRevision: 3 };
    expect(validate(args)).toEqual(args);
    for (const expectedRevision of [undefined, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "3"]) {
      expect(() => validate({ ...args, expectedRevision })).toThrow();
    }
    for (const key of ["projectSessionId", "pageImageId", "cleanedAssetId"]) {
      expect(() => validate({ ...args, [key]: "  " })).toThrow();
    }
    for (const key of ["filePath", "project", "mutation", "userReviewedCleanedAssetId"]) {
      expect(() => validate({ ...args, [key]: "forged" })).toThrow();
    }
  });

  it.each(["pause", "cancel", "resume", "retry"] as const)("requires a runtime queueId for %s", (action) => {
    expect(validateProcessingQueueActionArgs({
      projectSessionId: "session-1", action, queueId: "queue-1"
    })).toMatchObject({ projectSessionId: "session-1", action, queueId: "queue-1" });
    for (const queueId of [undefined, "", "  ", null, 3, {}, []]) {
      expect(() => validateProcessingQueueActionArgs({ projectSessionId: "session-1", action, queueId }))
        .toThrow(/queueId.*non-empty string/);
    }
  });

  it.each(["create", "start", "complete_stage", "approve_stage", "fail"] as const)(
    "keeps %s separate from existing-queue identity requests", (action) => {
      expect(validateProcessingQueueActionArgs({ projectSessionId: "session-1", action })).toMatchObject({ action });
      expect(() => validateProcessingQueueActionArgs({ projectSessionId: "session-1", action, queueId: "queue-1" }))
        .toThrow(/queueId is not allowed/);
    }
  );

  it("derives one Main-trusted font evidence value from all requested typeset pages", async () => {
    const resolveExportTypesetFontEvidence = (
      ipcHandlersModule as typeof ipcHandlersModule & {
        resolveExportTypesetFontEvidence: (
          pages: ReadonlyArray<{ readiness: { evidence: { font: {
            identity: string;
            resourceAvailable: boolean;
            metricsCalculated: boolean;
            glyphCoverageVerified: boolean;
          } } } }>,
          verifier: (identity: string) => Promise<boolean>
        ) => Promise<unknown>;
      }
    ).resolveExportTypesetFontEvidence;
    const font = {
      identity: "Pretendard Std Variable@1.3.9",
      resourceAvailable: true,
      metricsCalculated: true,
      glyphCoverageVerified: true
    };

    await expect(resolveExportTypesetFontEvidence([
      { readiness: { evidence: { font } } },
      { readiness: { evidence: { font: { ...font } } } }
    ], async () => true)).resolves.toEqual(font);
  });

  it("accepts valid save payloads for .ctp files", () => {
    const project = createEmptyProject("Project", false);
    const args = {
      filePath: "C:\\projects\\sample.ctp",
      project,
      password: "optional"
    };

    expect(validateSaveProjectArgs(args)).toEqual(args);
  });

  it("rejects malformed save payloads before storage receives them", () => {
    expect(() => validateSaveProjectArgs(undefined)).toThrow(/expected object/);
    expect(() => validateSaveProjectArgs({ filePath: 1, project: {} })).toThrow(/filePath/);
    expect(() => validateSaveProjectArgs({ filePath: "sample.txt", project: {} })).toThrow(/\.ctp/);
    expect(() => validateSaveProjectArgs({ filePath: "sample.ctp", project: null })).toThrow(/project/);
    expect(() => validateSaveProjectArgs({ filePath: "sample.ctp", project: {}, password: 1 })).toThrow(/password/);
  });

  it("defaults open payloads and accepts .ctp paths", () => {
    expect(validateOpenProjectArgs()).toEqual({});
    expect(validateOpenProjectArgs({ filePath: "sample.CTP" })).toEqual({ filePath: "sample.CTP" });
    expect(validateOpenProjectArgs({ password: "secret" })).toEqual({ password: "secret" });
  });

  it("rejects malformed open payloads", () => {
    expect(() => validateOpenProjectArgs("sample.ctp")).toThrow(/expected object/);
    expect(() => validateOpenProjectArgs({ filePath: 1 })).toThrow(/filePath/);
    expect(() => validateOpenProjectArgs({ filePath: "sample.txt" })).toThrow(/\.ctp/);
    expect(() => validateOpenProjectArgs({ password: 1 })).toThrow(/password/);
  });

  it("validates save file dialog defaults", () => {
    expect(validateChooseSaveFileArgs()).toEqual({});
    expect(validateChooseSaveFileArgs({ defaultPath: "draft.ctp" })).toEqual({ defaultPath: "draft.ctp" });

    expect(() => validateChooseSaveFileArgs("draft.ctp")).toThrow(/expected object/);
    expect(() => validateChooseSaveFileArgs({ defaultPath: 1 })).toThrow(/defaultPath/);
    expect(() => validateChooseSaveFileArgs({ defaultPath: "draft.txt" })).toThrow(/\.ctp/);
  });

  it("validates translation export payloads for .txt files", () => {
    const project = createEmptyProject("Export", false);
    const args = { filePath: "C:\\projects\\export.txt", project };

    expect(validateExportTranslationsArgs(args)).toEqual(args);
    expect(() => validateExportTranslationsArgs(undefined)).toThrow(/expected object/);
    expect(() => validateExportTranslationsArgs({ filePath: 1, project })).toThrow(/filePath/);
    expect(() => validateExportTranslationsArgs({ filePath: "export.ctp", project })).toThrow(/\.txt/);
    expect(() => validateExportTranslationsArgs({ filePath: "export.txt", project: null })).toThrow(/project/);
  });

  it("validates image export and queue control payloads without accepting renderer paths as targets", () => {
    const readiness = {
      ready: true,
      revision: 1,
      blockers: [],
      warnings: [],
      pageImageId: "page-1",
      lineIds: [],
      sourceFingerprint: "source",
      userTranslationFingerprint: "user",
      typesettingGeometryFingerprint: "typeset",
      fontIdentity: "font",
      evidence: {
        font: {
          identity: "font",
          resourceAvailable: true,
          metricsCalculated: true,
          glyphCoverageVerified: true
        },
        safeAreaProvisionalLineIds: [],
        missingGlyphLineIds: [],
        overflowLineIds: []
      }
    };
    expect(validateExportProjectImagesArgs({
      projectSessionId: "session-1",
      includeZip: true,
      typesetPages: [{ pageImageId: "page-1", pngBase64: "iVBORw0KGgo=", readiness }]
    })).toMatchObject({ projectSessionId: "session-1", includeZip: true });
    expect(() => validateExportProjectImagesArgs({
      projectSessionId: "session-1",
      typesetPages: [{
        pageImageId: "page-1",
        pngBase64: "iVBORw0KGgo=",
        readiness: { ...readiness, evidence: undefined }
      }]
    })).toThrow(/evidence/);
    expect(() => validateExportProjectImagesArgs({
      projectSessionId: "session-1",
      typesetPages: [{
        pageImageId: "page-1",
        pngBase64: "iVBORw0KGgo=",
        readiness: {
          ...readiness,
          ready: false,
          blockers: [{ code: "stale_result", message: "stale" }]
        }
      }]
    })).toThrow(/render-ready/);
    expect(() => validateExportProjectImagesArgs({ projectSessionId: "session-1", defaultPath: "relative" })).toThrow(/absolute/);
    expect(validateProcessingQueueActionArgs({
      projectSessionId: "session-1",
      action: "complete_stage",
      pageImageId: "page-1",
      stage: "ocr",
      revision: 2
    })).toMatchObject({ action: "complete_stage", revision: 2 });
    expect(() => validateProcessingQueueActionArgs({ projectSessionId: "session-1", action: "unknown" })).toThrow(/not supported/);
  });

  it("validates page image import payloads", () => {
    expect(
      validateImportPageImagesArgs({
        projectFilePath: "C:\\projects\\Book.ctp",
        files: [
          { sourcePath: "C:\\images\\one.jpg", pageNumber: 1 },
          { sourcePath: "C:\\images\\two.png", pageNumber: 2 }
        ]
      })
    ).toEqual({
      projectFilePath: "C:\\projects\\Book.ctp",
      files: [
        { sourcePath: "C:\\images\\one.jpg", pageNumber: 1 },
        { sourcePath: "C:\\images\\two.png", pageNumber: 2 }
      ]
    });

    expect(() => validateImportPageImagesArgs({ projectFilePath: "Book.txt", files: [] })).toThrow(/\.ctp/);
    expect(() =>
      validateImportPageImagesArgs({ projectFilePath: "Book.ctp", files: [{ sourcePath: 1, pageNumber: 1 }] })
    ).toThrow(/sourcePath/);
    expect(() =>
      validateImportPageImagesArgs({ projectFilePath: "Book.ctp", files: [{ sourcePath: "one.jpg", pageNumber: 0 }] })
    ).toThrow(/pageNumber/);
  });

  it("validates Gemini API key payloads without exposing the key", () => {
    expect(validateGeminiApiKeyArgs({ apiKey: "  test-gemini-key  " })).toEqual({ apiKey: "test-gemini-key" });

    expect(() => validateGeminiApiKeyArgs(undefined)).toThrow(/expected object/);
    expect(() => validateGeminiApiKeyArgs({ apiKey: 1 })).toThrow(/apiKey/);
    expect(() => validateGeminiApiKeyArgs({ apiKey: "   " })).toThrow(/non-empty/);
  });

  it("validates inpainting request payloads and preserves options", () => {
    const validPageImage = {
      id: "page-1",
      pageNumber: 1,
      storedRelativePath: "pages/page-1.png",
      originalFileName: "page-1.png",
      mimeType: "image/png",
      byteSize: 1024,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      copiedAt: new Date().toISOString()
    };

    const validArgs = {
      requestId: "inpaint-request-1",
      projectFilePath: "C:\\projects\\sample.ctp",
      pageImage: validPageImage,
      maskPngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      mode: "speech-bubble" as const,
      provider: "openai" as const,
      options: {
        conservative: true,
        skipOnLowConfidence: false,
        dilatePixels: 4
      }
    };

    expect(validateInpaintPageImageArgs(validArgs)).toEqual(validArgs);
    expect(() => validateInpaintPageImageArgs({ ...validArgs, options: "invalid" })).toThrow(/options must be an object/);
  });

  it("validates batch:run payloads and normalizes config", () => {
    const project = createEmptyProject("BatchProject", false);
    const validArgs = {
      requestId: "req-valid-1",
      project,
      pageCount: 3,
      config: {
        targetPages: [1, 2],
        speechStylePreset: "honorific",
        runTranslate: true,
        runTypeset: true,
        overwriteExisting: false
      }
    };

    const validated = validateBatchRunArgs(validArgs);
    expect(validated.requestId).toBe("req-valid-1");
    expect(validated.project).toEqual(normalizeProject(project));
    expect(validated.pageCount).toBe(3);
    expect(validated.config.targetPages).toEqual([1, 2]);

    // Accepts projectSessionId without project payload
    const sessionOnlyArgs = {
      requestId: "req-session-only",
      projectSessionId: "session-xyz",
      config: validArgs.config
    };
    const validatedSessionOnly = validateBatchRunArgs(sessionOnlyArgs);
    expect(validatedSessionOnly.projectSessionId).toBe("session-xyz");
    expect(validatedSessionOnly.project).toBeUndefined();

    // Rejects non-object payload
    expect(() => validateBatchRunArgs(null)).toThrow(/payload must be an object/);

    // Rejects empty or too long requestId
    expect(() => validateBatchRunArgs({ ...validArgs, requestId: "" })).toThrow(/requestId must be a non-empty string/);
    expect(() => validateBatchRunArgs({ ...validArgs, requestId: "a".repeat(300) })).toThrow(/requestId must be a non-empty string/);

    // Rejects missing both project and projectSessionId
    expect(() => validateBatchRunArgs({ requestId: "req-1", config: validArgs.config })).toThrow(/project or projectSessionId is required/);

    // Rejects malformed project when projectSessionId is missing
    expect(() => validateBatchRunArgs({ requestId: "req-1", config: validArgs.config, project: { not: "a valid project" } })).toThrow(/Invalid project/);

    // Rejects invalid pageCount
    expect(() => validateBatchRunArgs({ ...validArgs, pageCount: -1 })).toThrow(/pageCount must be a positive integer/);
    expect(() => validateBatchRunArgs({ ...validArgs, pageCount: 0 })).toThrow(/pageCount must be a positive integer/);
    expect(() => validateBatchRunArgs({ ...validArgs, pageCount: 1.5 })).toThrow(/pageCount must be a positive integer/);
  });
});
