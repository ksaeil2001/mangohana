import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProjectFile,
  loadProjectFileWithRecovery,
  projectFileRequiresPassword,
  saveProjectFile
} from "../../src/main/projectStorage";
import { zeroizeProtection } from "../../src/main/projectProtection";
import { applyMainProjectPatch } from "../../src/main/projectReplay";
import { buildProductionOcrReviewMergePatch } from "../../src/main/ocr/pipeline/productionOcrReviewMerge";
import { PRODUCTION_OCR_CONTRACT } from "../../src/shared/productionOcr";
import { createEmptyProject } from "../../src/shared/projectValidation";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dialogue-editor-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("projectStorage", () => {
  it("loads the checked-in plain Container v1 fixture as a migrated v2 project", async () => {
    const fixturePath = join(process.cwd(), "tests", "fixtures", "projects", "plain-v1.ctp");
    const wrapperBefore = JSON.parse(await readFile(fixturePath, "utf8"));

    const loaded = await loadProjectFile({ filePath: fixturePath });

    expect(loaded.project).toMatchObject({
      schemaVersion: 2,
      metadata: { id: "fixture-plain-v1", title: "Plain v1 fixture", secret: false },
      dialogueLines: [{ id: "legacy-plain-line", origin: { kind: "manual" } }],
      processing: { pages: [], runs: [], assets: [] }
    });
    expect(JSON.parse(await readFile(fixturePath, "utf8"))).toEqual(wrapperBefore);
  });

  it("saves and loads normal projects", async () => {
    const project = createEmptyProject("Normal", false);
    const filePath = join(tempDir, "normal.ctp");

    await saveProjectFile({ filePath, project });
    const loaded = await loadProjectFile({ filePath });

    expect(loaded.project.metadata.title).toBe("Normal");
    expect(loaded.project.schemaVersion).toBe(2);
    expect(loaded.encrypted).toBe(false);
    const wrapper = JSON.parse(await readFile(filePath, "utf8"));
    expect(wrapper).toMatchObject({
      format: "ctp-json",
      schemaVersion: 1,
      encrypted: false,
      payload: { schemaVersion: 2 }
    });
  });

  it("preserves Production OCR ownership and provenance across save and reopen", async () => {
    const project = createEmptyProject("OCR ownership", false);
    project.dialogueLines = [{
      id: "ocr-line-1",
      order: 3,
      pageNumber: 1,
      dialogueType: "speech",
      sourceLanguage: "ja",
      sourceText: "ユーザー修正",
      userTranslation: "사용자 번역",
      parseConfidence: 0.91,
      parseWarnings: [],
      ocrEditStatus: "user_modified",
      ocrUserOwnedFields: ["source_text", "reading_order", "geometry", "group_assignment"],
      ocrGroupId: "group-user",
      typesetting: {
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        writingMode: "vertical-rl"
      },
      polygon: [
        { x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 },
        { x: 0.4, y: 0.6 }, { x: 0.1, y: 0.6 }
      ],
      ocrSourceInfo: {
        detectorName: "PP-OCRv6_medium_det",
        ocrEngine: "baberu-ocr",
        confidence: 0.91,
        orientation: "vertical",
        productionOcrProvenance: {
          contractVersion: 1,
          detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
          detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
          recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
          recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
          groupId: "group-1",
          sourceDetectionIds: ["det-1"],
          sourceDetectionScores: [0.91],
          sourceQuadsPx: [[
            { x: 100, y: 200 }, { x: 400, y: 200 },
            { x: 400, y: 600 }, { x: 100, y: 600 }
          ]],
          orientation: "vertical",
          cropTransform: {
            sourceBboxPx: { x: 100, y: 200, width: 300, height: 400 },
            cropBboxPx: { x: 76, y: 168, width: 348, height: 464 },
            paddingRatio: 0.08,
            rotationDegrees: 0,
            imageWidth: 1000,
            imageHeight: 1000
          },
          confidenceSource: "detector_min"
        }
      },
      origin: {
        kind: "pipeline",
        persistentRegionId: "persistent-1",
        latestRunId: "run-1",
        latestRegionId: "group-1",
        pageImageId: "page-1",
        candidateIds: ["det-1"],
        readingIndex: 3,
        sourceFingerprint: "fingerprint"
      }
    }];
    const filePath = join(tempDir, "ocr-ownership.ctp");

    await saveProjectFile({ filePath, project });
    const reopened = await loadProjectFile({ filePath });

    expect(reopened.project.dialogueLines[0]).toMatchObject({
      sourceText: "ユーザー修正",
      userTranslation: "사용자 번역",
      order: 3,
      ocrEditStatus: "user_modified",
      ocrUserOwnedFields: ["source_text", "reading_order", "geometry", "group_assignment"],
      ocrGroupId: "group-user",
      typesetting: { writingMode: "vertical-rl" },
      origin: { kind: "pipeline", persistentRegionId: "persistent-1" },
      ocrSourceInfo: {
        productionOcrProvenance: {
          groupId: "group-1",
          sourceDetectionScores: [0.91]
        }
      }
    });

    const rerunPatch = buildProductionOcrReviewMergePatch({
      existingLines: reopened.project.dialogueLines,
      pageNumber: 1,
      pageImageId: "page-1",
      runId: "run-2",
      candidates: [{
        id: "group-2",
        text: "AI 재인식 텍스트",
        sourceLanguage: "ja",
        dialogueType: "speech",
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        polygon: [
          { x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 },
          { x: 0.4, y: 0.6 }, { x: 0.1, y: 0.6 }
        ],
        readingOrder: 1,
        confidence: 0.88,
        orientation: "vertical",
        selectedSpeaker: "",
        notes: "",
        provenance: {
          contractVersion: 1,
          detectorModelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
          detectorRevision: PRODUCTION_OCR_CONTRACT.detector.revision,
          recognizerModelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
          recognizerRevision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
          groupId: "group-2",
          sourceDetectionIds: ["det-2"],
          sourceDetectionScores: [0.88],
          sourceQuadsPx: [[
            { x: 100, y: 200 }, { x: 400, y: 200 },
            { x: 400, y: 600 }, { x: 100, y: 600 }
          ]],
          orientation: "vertical",
          cropTransform: {
            sourceBboxPx: { x: 100, y: 200, width: 300, height: 400 },
            cropBboxPx: { x: 76, y: 168, width: 348, height: 464 },
            paddingRatio: 0.08,
            rotationDegrees: 0,
            imageWidth: 1000,
            imageHeight: 1000
          },
          confidenceSource: "detector_min"
        }
      }]
    });
    const afterRerun = applyMainProjectPatch(reopened.project, rerunPatch).dialogueLines[0]!;

    expect(afterRerun).toMatchObject({
      sourceText: "ユーザー修正",
      userTranslation: "사용자 번역",
      order: 3,
      ocrGroupId: "group-user",
      typesetting: { writingMode: "vertical-rl" },
      origin: { kind: "pipeline", persistentRegionId: "persistent-1", latestRunId: "run-2" },
      ocrSourceInfo: { productionOcrProvenance: { groupId: "group-2", sourceDetectionScores: [0.88] } }
    });
  });

  it("opens a legacy v1 payload as v2 without changing the container wrapper", async () => {
    const filePath = join(tempDir, "plain-v1.ctp");
    const legacyProject = {
      schemaVersion: 1,
      metadata: {
        id: "legacy-project",
        title: "Legacy",
        createdAt: "2026-07-27T00:00:00.000Z",
        updatedAt: "2026-07-27T00:00:00.000Z",
        secret: false
      },
      characters: [],
      dictionaryTerms: [],
      dialogueLines: [
        {
          id: "legacy-line",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "こんにちは",
          parseConfidence: 1,
          parseWarnings: []
        }
      ],
      pageImages: [],
      settings: { defaultSourceLanguage: "ja" }
    };
    await writeFile(
      filePath,
      JSON.stringify({ format: "ctp-json", schemaVersion: 1, encrypted: false, payload: legacyProject }),
      "utf8"
    );

    const loaded = await loadProjectFile({ filePath });

    expect(loaded.project.schemaVersion).toBe(2);
    expect(loaded.project.dialogueLines[0]?.origin).toEqual({ kind: "manual" });
    expect(loaded.artifactKeyPersisted).toBe(true);
  });

  it("encrypts secret projects and rejects wrong passwords", async () => {
    const project = createEmptyProject("Secret", true);
    project.dictionaryTerms.push({
      id: "term-1",
      source: "Visible Content",
      target: "Hidden Content"
    });
    const filePath = join(tempDir, "secret.ctp");

    await saveProjectFile({ filePath, project, password: "correct horse" });
    const raw = await readFile(filePath, "utf8");
    const wrapper = JSON.parse(raw) as { encrypted?: unknown };

    expect(wrapper.encrypted).toBe(true);
    expect(raw).not.toContain("Secret");
    expect(raw).not.toContain("Visible Content");
    expect(raw).not.toContain("Hidden Content");
    await expect(loadProjectFile({ filePath, password: "wrong" })).rejects.toThrow(/password/i);

    const loaded = await loadProjectFile({ filePath, password: "correct horse" });
    expect(loaded.project.metadata.title).toBe("Secret");
    expect(loaded.project.dictionaryTerms[0]?.source).toBe("Visible Content");
    expect(loaded.encrypted).toBe(true);
    expect(loaded.artifactKeyPersisted).toBe(true);
    expect(loaded.project).not.toHaveProperty("security");
  });

  it("rejects invalid JSON with a controlled project file error", async () => {
    const filePath = join(tempDir, "invalid-json.ctp");
    await writeFile(filePath, "{not json", "utf8");

    await expect(loadProjectFile({ filePath })).rejects.toThrow(/Invalid project file/);
  });

  it("rejects null, array, and malformed wrapper values", async () => {
    const cases = [
      { name: "null", value: null },
      { name: "array", value: [] },
      { name: "wrong-format", value: { format: "other", schemaVersion: 1, encrypted: false, payload: {} } },
      { name: "wrong-version", value: { format: "ctp-json", schemaVersion: 2, encrypted: false, payload: {} } },
      { name: "missing-encrypted", value: { format: "ctp-json", schemaVersion: 1, payload: {} } },
      { name: "string-encrypted", value: { format: "ctp-json", schemaVersion: 1, encrypted: "no", payload: {} } },
      { name: "missing-payload", value: { format: "ctp-json", schemaVersion: 1, encrypted: false } }
    ];

    for (const item of cases) {
      const filePath = join(tempDir, `${item.name}.ctp`);
      await writeFile(filePath, JSON.stringify(item.value), "utf8");

      await expect(loadProjectFile({ filePath })).rejects.toThrow(/Invalid project file/);
    }
  });

  it("rejects encrypted wrappers with unsupported kdf or missing fields", async () => {
    const baseWrapper = {
      format: "ctp-json",
      schemaVersion: 1,
      encrypted: true,
      kdf: "scrypt",
      salt: "salt",
      iv: "iv",
      authTag: "tag",
      payload: "payload"
    };
    const cases = [
      { name: "unsupported-kdf", value: { ...baseWrapper, kdf: "argon2" } },
      { name: "missing-salt", value: { ...baseWrapper, salt: undefined } },
      { name: "missing-iv", value: { ...baseWrapper, iv: undefined } },
      { name: "missing-auth-tag", value: { ...baseWrapper, authTag: undefined } },
      { name: "missing-payload", value: { ...baseWrapper, payload: undefined } }
    ];

    for (const item of cases) {
      const filePath = join(tempDir, `${item.name}.ctp`);
      await writeFile(filePath, JSON.stringify(item.value), "utf8");

      await expect(loadProjectFile({ filePath, password: "password" })).rejects.toThrow(/Invalid project file/);
    }
  });

  it("requires passwords for secret saves and encrypted loads", async () => {
    const project = createEmptyProject("Secret", true);
    const filePath = join(tempDir, "requires-password.ctp");

    await expect(saveProjectFile({ filePath, project })).rejects.toThrow(/password/i);

    await saveProjectFile({ filePath, project, password: "correct horse" });
    await expect(loadProjectFile({ filePath })).rejects.toThrow(/password/i);
  });

  it("rejects tampered encrypted payloads and auth tags", async () => {
    const project = createEmptyProject("Secret", true);
    const filePath = join(tempDir, "tampered.ctp");

    await saveProjectFile({ filePath, project, password: "correct horse" });
    const wrapper = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

    const tamperedPayloadPath = join(tempDir, "tampered-payload.ctp");
    await writeFile(tamperedPayloadPath, JSON.stringify({ ...wrapper, payload: "tampered" }), "utf8");
    await expect(loadProjectFile({ filePath: tamperedPayloadPath, password: "correct horse" })).rejects.toThrow(
      /password|project file/i
    );

    const tamperedAuthTagPath = join(tempDir, "tampered-auth-tag.ctp");
    await writeFile(tamperedAuthTagPath, JSON.stringify({ ...wrapper, authTag: "tampered" }), "utf8");
    await expect(loadProjectFile({ filePath: tamperedAuthTagPath, password: "correct horse" })).rejects.toThrow(
      /password|project file/i
    );
  });

  it("preserves an existing file when malformed project save validation fails", async () => {
    const filePath = join(tempDir, "existing.ctp");
    await writeFile(filePath, "old file", "utf8");
    const malformedProject = { ...createEmptyProject("Malformed", false), metadata: undefined };

    await expect(saveProjectFile({ filePath, project: malformedProject as never })).rejects.toThrow(/Invalid project/);

    await expect(readFile(filePath, "utf8")).resolves.toBe("old file");
  });

  it("restores and opens a valid plain backup when the current file is corrupt", async () => {
    const validPath = join(tempDir, "valid-plain.ctp");
    const filePath = join(tempDir, "recover-plain.ctp");
    await saveProjectFile({ filePath: validPath, project: createEmptyProject("Recovered plain", false) });
    await writeFile(filePath, "corrupt current", "utf8");
    await writeFile(`${filePath}.bak`, await readFile(validPath));

    const loaded = await loadProjectFileWithRecovery({ filePath });

    expect(loaded.project.metadata.title).toBe("Recovered plain");
    await expect(readFile(`${filePath}.recovery-invalid`, "utf8")).resolves.toBe("corrupt current");
  });

  it("detects an encrypted backup before unlock and restores it with the password", async () => {
    const filePath = join(tempDir, "recover-secret.ctp");
    await saveProjectFile({
      filePath,
      project: createEmptyProject("Recovered secret", true),
      password: "recovery password"
    });
    await rename(filePath, `${filePath}.bak`);

    await expect(projectFileRequiresPassword(filePath)).resolves.toBe(true);
    const loaded = await loadProjectFileWithRecovery({
      filePath,
      password: "recovery password"
    });

    expect(loaded).toMatchObject({
      encrypted: true,
      project: { metadata: { title: "Recovered secret", secret: true } }
    });
    zeroizeProtection(loaded.protection!);
  });

  it("rejects mixed plain and encrypted recovery artifacts", async () => {
    const filePath = join(tempDir, "mixed.ctp");
    const secretPath = join(tempDir, "mixed-secret.ctp");
    await saveProjectFile({ filePath, project: createEmptyProject("Plain", false) });
    await saveProjectFile({
      filePath: secretPath,
      project: createEmptyProject("Secret", true),
      password: "mixed password"
    });
    await writeFile(`${filePath}.bak`, await readFile(secretPath));

    await expect(projectFileRequiresPassword(filePath)).rejects.toThrow(/protection modes/i);
  });
});
