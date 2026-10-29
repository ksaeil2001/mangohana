import { describe, expect, it } from "vitest";
import {
  composeProjectFromChunks,
  computeChunkHash,
  decomposeProjectToChunks
} from "../../src/shared/projectChunkAdapter.js";
import type {
  SecretProjectSecurityV1,
  TranslationProjectV2
} from "../../src/shared/projectTypes.js";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation.js";

describe("projectChunkAdapter", () => {
  it("decomposes and composes an empty project with perfect round-trip fidelity", () => {
    const empty = normalizeProject(createEmptyProject("Test Project", false));
    const snapshot = decomposeProjectToChunks(empty);

    expect(snapshot.manifest.metadata.title).toBe("Test Project");
    expect(snapshot.manifest.pageIndex).toHaveLength(0);
    expect(snapshot.chunks).toHaveLength(0);

    const recomposed = composeProjectFromChunks(snapshot);
    expect(recomposed).toEqual(empty);
  });


  it("decomposes a complex multi-page project and preserves all nested properties on recomposition", () => {
    const project: TranslationProjectV2 = {
      schemaVersion: 2,
      metadata: {
        id: "proj-123",
        title: "Multi-page Comic",
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T12:00:00.000Z",
        secret: false
      },
      characters: [
        {
          id: "char-1",
          name: "Hero",
          aliases: ["Main Guy"],
          description: "Protagonist",
          speechStyle: "casual"
        }
      ],
      dictionaryTerms: [
        {
          id: "term-1",
          source: "魔法",
          target: "마법",
          note: "Magic term"
        }
      ],
      pageImages: [
        {
          id: "img-1",
          pageNumber: 1,
          storedRelativePath: "images/p1.png",
          originalFileName: "01.png",
          sha256: "hash1",
          byteSize: 1024,
          mimeType: "image/png",
          copiedAt: "2026-08-21T00:00:00.000Z"
        },
        {
          id: "img-2",
          pageNumber: 2,
          storedRelativePath: "images/p2.png",
          originalFileName: "02.png",
          sha256: "hash2",
          byteSize: 2048,
          mimeType: "image/png",
          copiedAt: "2026-08-21T00:00:00.000Z"
        }
      ],
      settings: {
        defaultSourceLanguage: "ja",
        translationMode: "precise",
        allowExternalAi: true,
        debugArtifactsEnabled: false
      },
      dialogueLines: [
        {
          id: "line-1",
          order: 1,
          pageNumber: 1,
          dialogueType: "speech",
          sourceLanguage: "ja",
          sourceText: "こんにちは！",
          userTranslation: "안녕!",
          lineStatus: "complete",
          parseConfidence: 0.98,
          parseWarnings: [],
          origin: { kind: "manual" },
          speaker: "Hero",
          typesetting: {
            bbox: { x: 10, y: 20, width: 100, height: 50 },
            writingMode: "horizontal-tb",
            fontSizeRatio: 1.2
          }
        },
        {
          id: "line-2",
          order: 2,
          pageNumber: 2,
          dialogueType: "thought",
          sourceLanguage: "ja",
          sourceText: "ここはどこだ？",
          lineStatus: "draft",
          parseConfidence: 0.95,
          parseWarnings: [],
          origin: {
            kind: "pipeline",
            persistentRegionId: "reg-1",
            latestRunId: "run-1",
            latestRegionId: "r-1",
            pageImageId: "img-2",
            candidateIds: ["c-1"],
            readingIndex: 1,
            sourceFingerprint: "fp-1"
          }
        }
      ],
      processing: {
        pages: [
          {
            pageImageId: "img-1",
            finalStatus: "auto_approved",
            approvedCleanedAssetId: "asset-cleaned-1",
            updatedAt: "2026-08-21T10:00:00.000Z"
          },
          {
            pageImageId: "img-2",
            finalStatus: "needs_review",
            updatedAt: "2026-08-21T11:00:00.000Z"
          }
        ],
        runs: [
          {
            runId: "run-1",
            pageImageId: "img-2",
            source: "automatic_pipeline",
            status: "completed",
            sourceSha256: "hash2",
            appVersion: "0.1.3",
            queuedAt: "2026-08-21T10:50:00.000Z"
          }
        ],
        assets: [
          {
            assetId: "asset-cleaned-1",
            source: "automatic_pipeline",
            sourcePageImageId: "img-1",
            runId: "run-0",
            role: "cleaned",
            storedRelativePath: "assets/cleaned-1.png",
            sha256: "asset-hash-1",
            byteSize: 5000,
            mimeType: "image/png",
            createdAt: "2026-08-21T10:00:00.000Z"
          }
        ]
      }
    };

    const snapshot = decomposeProjectToChunks(project);

    // Verify Manifest
    expect(snapshot.manifest.metadata.title).toBe("Multi-page Comic");
    expect(snapshot.manifest.characters).toHaveLength(1);
    expect(snapshot.manifest.dictionaryTerms).toHaveLength(1);
    expect(snapshot.manifest.pageIndex).toHaveLength(2);

    expect(snapshot.manifest.pageIndex[0]).toMatchObject({
      pageNumber: 1,
      pageImageId: "img-1",
      dialogueCount: 1,
      status: "auto_approved",
      hasInpainting: true,
      hasTypesetting: true
    });

    expect(snapshot.manifest.pageIndex[1]).toMatchObject({
      pageNumber: 2,
      pageImageId: "img-2",
      dialogueCount: 1,
      status: "needs_review",
      hasInpainting: false,
      hasTypesetting: false
    });

    // Verify Chunks
    expect(snapshot.chunks).toHaveLength(2);
    expect(snapshot.chunks[0]?.dialogueLines).toHaveLength(1);
    expect(snapshot.chunks[0]?.dialogueLines[0]?.id).toBe("line-1");
    expect(snapshot.chunks[0]?.assets).toHaveLength(1);

    expect(snapshot.chunks[1]?.dialogueLines).toHaveLength(1);
    expect(snapshot.chunks[1]?.dialogueLines[0]?.id).toBe("line-2");
    expect(snapshot.chunks[1]?.runs).toHaveLength(1);

    // Verify round-trip composition
    const recomposed = composeProjectFromChunks(snapshot);
    expect(recomposed).toEqual(project);
  });

  it("handles secret project security info correctly", () => {
    const project = normalizeProject(createEmptyProject("Secret Project", true));
    const security: SecretProjectSecurityV1 = {
      artifactKeyVersion: 1,
      artifactMasterKeyB64: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
    };

    const snapshot = decomposeProjectToChunks(project, security);
    expect(snapshot.manifest.security).toEqual(security);
  });

  it("computes deterministic chunk hashes", () => {
    const chunk1 = {
      pageNumber: 1,
      pageImageId: "img-1",
      dialogueLines: [],
      runs: [],
      assets: []
    };
    const hash1 = computeChunkHash(chunk1);
    const hash2 = computeChunkHash(chunk1);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(12);

    const chunkModified = {
      ...chunk1,
      pageImageId: "img-modified"
    };
    const hashModified = computeChunkHash(chunkModified);
    expect(hashModified).not.toBe(hash1);
  });
});
