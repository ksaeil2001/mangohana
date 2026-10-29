import { describe, expect, it } from "vitest";
import { evaluateRevision } from "../../src/main/projectRevision";
import type { RevisionJournalEntry } from "../../src/shared/projectChanges";

describe("project revision journal", () => {
  const journal: RevisionJournalEntry[] = [
    entry(4, ["metadata/title"]),
    entry(5, ["dialogueLines/line-a/sourceText"])
  ];

  it("rebases a stale mutation only when later changed paths do not overlap", () => {
    expect(
      evaluateRevision({
        baseRevision: 3,
        currentRevision: 5,
        requestedPaths: ["dialogueLines/line-b/sourceText"],
        revisionJournal: journal
      })
    ).toEqual({ status: "accepted", rebasedFrom: 3 });
  });

  it("rejects overlapping paths and revisions older than the retained journal", () => {
    expect(
      evaluateRevision({
        baseRevision: 4,
        currentRevision: 5,
        requestedPaths: ["dialogueLines/line-a"],
        revisionJournal: journal
      })
    ).toEqual({
      status: "conflict",
      conflictingPaths: ["dialogueLines/line-a/sourceText"]
    });

    expect(
      evaluateRevision({
        baseRevision: 2,
        currentRevision: 5,
        requestedPaths: ["settings/defaultSourceLanguage"],
        revisionJournal: journal
      })
    ).toEqual({ status: "conflict", conflictingPaths: [] });
  });
});

function entry(revision: number, changedPaths: string[]): RevisionJournalEntry {
  return {
    revision,
    owner: "user",
    changedPaths,
    createdAt: "2026-07-27T00:00:00.000Z"
  };
}
