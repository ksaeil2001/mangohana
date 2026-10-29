import { describe, expect, it } from "vitest";
import {
  applyMainProjectPatch,
  applyNormalizedProjectMutation,
  replayPendingUserMutations
} from "../../src/main/projectReplay";
import { createEmptyProject, normalizeProject } from "../../src/shared/projectValidation";
import type { PendingUserMutation } from "../../src/shared/projectChanges";

describe("project mutation replay", () => {
  it("marks field-level OCR ownership for source, geometry, and reading-order user mutations", () => {
    const source = normalizeProject(createEmptyProject("OCR ownership", false));
    source.dialogueLines = [
      { ...line("pipeline-1", 1, "원문 1"), origin: pipelineOrigin("region-1", 1), ocrEditStatus: "ai_proposed" },
      { ...line("pipeline-2", 2, "원문 2"), origin: pipelineOrigin("region-2", 2), ocrEditStatus: "ai_proposed" }
    ];

    let updated = applyNormalizedProjectMutation(source, {
      type: "update_dialogue_line",
      lineId: "pipeline-1",
      patch: { sourceText: "사용자 수정" }
    });
    updated = applyNormalizedProjectMutation(updated, {
      type: "update_dialogue_typesetting",
      lineId: "pipeline-1",
      typesetting: {
        bbox: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        writingMode: "vertical-rl"
      }
    });
    updated = applyNormalizedProjectMutation(updated, {
      type: "reorder_dialogue_lines",
      orderedLineIds: ["pipeline-2", "pipeline-1"]
    });

    const edited = updated.dialogueLines.find((candidate) => candidate.id === "pipeline-1")!;
    expect(edited.ocrEditStatus).toBe("user_modified");
    expect(edited.ocrUserOwnedFields).toEqual(expect.arrayContaining([
      "source_text",
      "geometry",
      "reading_order"
    ]));
  });
  it("replaces a page image as one graph transaction and preserves pipeline dialogue as orphaned", () => {
    const persisted = normalizeProject(createEmptyProject("Replacement", false));
    persisted.pageImages = [pageImage("old-page", 1)];
    persisted.processing = {
      pages: [{
        pageImageId: "old-page",
        activeRunId: "run-1",
        latestCompletedRunId: "run-1",
        approvedCleanedAssetId: "asset-1",
        finalStatus: "auto_approved",
        updatedAt: "2026-09-01T00:00:00.000Z"
      }],
      runs: [{
        runId: "run-1",
        pageImageId: "old-page",
        source: "manual_openai",
        status: "completed",
        sourceSha256: "a".repeat(64),
        appVersion: "0.1.4",
        queuedAt: "2026-09-01T00:00:00.000Z"
      }],
      assets: [{
        assetId: "asset-1",
        source: "manual_openai",
        sourcePageImageId: "old-page",
        runId: "run-1",
        role: "cleaned",
        storedRelativePath: "Replacement-assets/derived/asset.png",
        sha256: "b".repeat(64),
        byteSize: 10,
        mimeType: "image/png",
        createdAt: "2026-09-01T00:00:00.000Z"
      }],
      queue: {
        schemaVersion: 1,
        queueId: "queue-1",
        projectSessionId: "session-1",
        status: "paused",
        pageImageIds: ["old-page"],
        pages: [{
          pageImageId: "old-page",
          status: "paused",
          stage: "inpainting",
          revision: 1,
          updatedAt: "2026-09-01T00:00:00.000Z"
        }],
        currentPageIndex: 0,
        lastUpdatedAt: "2026-09-01T00:00:00.000Z"
      }
    };
    persisted.dialogueLines = [{
      ...line("pipeline-1", 1, "edited source"),
      userTranslation: "사용자 번역",
      origin: { ...pipelineOrigin("region-1", 1), pageImageId: "old-page" }
    }];

    const replaced = replayPendingUserMutations(persisted, [entry(1, {
      type: "register_page_images",
      pageImages: [pageImage("new-page", 1)]
    })]);

    expect(replaced.pageImages.map((image) => image.id)).toEqual(["new-page"]);
    expect(replaced.processing).toEqual({ pages: [], runs: [], assets: [] });
    expect(replaced.dialogueLines[0]).toMatchObject({
      userTranslation: "사용자 번역",
      orphanedFromPipeline: true,
      origin: { pageImageId: "old-page" }
    });
  });

  it("replays add, update, reorder, and remove deterministically from the persisted snapshot", () => {
    const persisted = normalizeProject(createEmptyProject("Replay", false));
    const pending: PendingUserMutation[] = [
      entry(1, {
        type: "add_dialogue_line",
        line: line("line-a", 1, "A")
      }),
      entry(2, {
        type: "add_dialogue_line",
        line: line("line-b", 2, "B")
      }),
      entry(3, {
        type: "update_dialogue_line",
        lineId: "line-a",
        patch: { sourceText: "A edited" }
      }),
      entry(4, {
        type: "reorder_dialogue_lines",
        orderedLineIds: ["line-b", "line-a"]
      }),
      entry(5, {
        type: "remove_dialogue_line",
        lineId: "line-b"
      })
    ];

    const first = replayPendingUserMutations(persisted, pending);
    const second = replayPendingUserMutations(persisted, pending);

    expect(first).toEqual(second);
    expect(first.metadata.updatedAt).toBe("2026-07-27T00:00:00.000Z");
    expect(first.dialogueLines).toEqual([{ ...line("line-a", 1, "A edited"), order: 1 }]);
    expect(persisted.dialogueLines).toEqual([]);
  });

  it("replays a pageNumber update onto the persisted snapshot", () => {
    const persisted = normalizeProject(createEmptyProject("Replay page", false));
    persisted.dialogueLines = [line("line-a", 1, "A")];

    const result = replayPendingUserMutations(persisted, [
      entry(1, {
        type: "update_dialogue_line",
        lineId: "line-a",
        patch: { pageNumber: 2 }
      })
    ]);

    expect(result.dialogueLines[0]).toMatchObject({ id: "line-a", pageNumber: 2, sourceText: "A" });
    expect(persisted.dialogueLines[0]?.pageNumber).toBe(1);
  });

  it("places new pipeline lines after pending reorder using readingIndex without deleting manual lines", () => {
    const persisted = normalizeProject(createEmptyProject("Replay", false));
    persisted.dialogueLines = [
      line("manual", 1, "manual"),
      {
        ...line("pipeline-2", 2, "two"),
        origin: pipelineOrigin("region-2", 2)
      },
      {
        ...line("pipeline-1", 3, "one"),
        origin: pipelineOrigin("region-1", 1)
      }
    ];

    const replayed = replayPendingUserMutations(persisted, [
      entry(1, {
        type: "reorder_dialogue_lines",
        orderedLineIds: ["manual"]
      })
    ]);

    expect(replayed.dialogueLines.map((line) => line.id)).toEqual(["manual", "pipeline-1", "pipeline-2"]);
  });

  it("preserves saved user-authored fields when a later pipeline run updates the same region", () => {
    const persisted = normalizeProject(createEmptyProject("Replay", false));
    persisted.dialogueLines = [{
      ...line("pipeline-1", 1, "user corrected source"),
      speaker: "Saved speaker",
      userTranslation: "Saved translation",
      lineStatus: "complete",
      notes: "Saved note",
      origin: pipelineOrigin("region-1", 1)
    }];

    const merged = applyMainProjectPatch(persisted, {
      type: "merge_pipeline_dialogues",
      pageImageId: "page-1",
      orphanedPersistentRegionIds: [],
      lines: [{
        ...line("pipeline-replacement", 1, "new OCR source"),
        speaker: "Pipeline speaker",
        userTranslation: "Pipeline translation",
        aiTranslation: "Fresh AI proposal",
        lineStatus: "draft",
        notes: "Pipeline note",
        origin: {
          ...pipelineOrigin("region-1", 1),
          latestRunId: "run-2",
          latestRegionId: "region-2"
        }
      }]
    });

    expect(merged.dialogueLines[0]).toMatchObject({
      id: "pipeline-replacement",
      sourceText: "new OCR source",
      speaker: "Saved speaker",
      userTranslation: "Saved translation",
      lineStatus: "complete",
      aiTranslation: "Fresh AI proposal",
      notes: "Saved note",
      origin: {
        latestRunId: "run-2",
        latestRegionId: "region-2"
      }
    });
  });

  it("applies commit_batch_result to update aiTranslation, typesetting, and processing.queue", () => {
    const persisted = normalizeProject(createEmptyProject("Replay", false));
    persisted.dialogueLines = [line("line-1", 1, "test")];

    const patched = applyMainProjectPatch(persisted, {
      type: "commit_batch_result",
      dialogueUpdates: [
        {
          id: "line-1",
          aiTranslation: "배치 AI 번역",
          typesetting: {
            bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 },
            writingMode: "horizontal-tb"
          },
          lineStatus: "complete"
        }
      ],
      queue: {
        schemaVersion: 1,
        queueId: "q-1",
        projectSessionId: "sess-1",
        status: "completed",
        pageImageIds: ["p1"],
        pages: [],
        currentPageIndex: 0,
        lastUpdatedAt: "2026-08-27T00:00:00.000Z"
      }
    });

    expect(patched.dialogueLines[0]?.aiTranslation).toBe("배치 AI 번역");
    expect(patched.dialogueLines[0]?.typesetting?.bbox).toEqual({ x: 0.1, y: 0.1, width: 0.4, height: 0.2 });
    expect(patched.dialogueLines[0]?.lineStatus).toBe("complete");
    expect(patched.processing.queue?.queueId).toBe("q-1");
  });
});

function entry(revision: number, mutation: PendingUserMutation["mutation"]): PendingUserMutation {
  return {
    mutationId: `mutation-${revision}`,
    acceptedRevision: revision,
    mutation,
    changedPaths: ["dialogueLines"],
    createdAt: "2026-07-27T00:00:00.000Z"
  };
}

function line(id: string, order: number, sourceText: string) {
  return {
    id,
    order,
    pageNumber: 1,
    dialogueType: "speech" as const,
    lineStatus: "untranslated" as const,
    sourceLanguage: "ja" as const,
    sourceText,
    parseConfidence: 1,
    parseWarnings: [],
    origin: { kind: "manual" as const }
  };
}

function pipelineOrigin(persistentRegionId: string, readingIndex: number) {
  return {
    kind: "pipeline" as const,
    persistentRegionId,
    latestRunId: "run-1",
    latestRegionId: persistentRegionId,
    pageImageId: "page-1",
    candidateIds: [],
    readingIndex,
    sourceFingerprint: `fingerprint-${persistentRegionId}`
  };
}

function pageImage(id: string, pageNumber: number) {
  return {
    id,
    pageNumber,
    storedRelativePath: `Replacement-assets/images/${id}.png`,
    originalFileName: `${id}.png`,
    sha256: "a".repeat(64),
    byteSize: 4,
    mimeType: "image/png",
    copiedAt: "2026-09-01T00:00:00.000Z"
  };
}
