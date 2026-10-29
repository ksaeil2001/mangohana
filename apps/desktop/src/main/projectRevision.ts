import type { RevisionJournalEntry } from "../shared/projectChanges.js";

export type RevisionEvaluation =
  | { status: "accepted"; rebasedFrom?: number }
  | { status: "conflict"; conflictingPaths: string[] };

export function evaluateRevision(args: {
  baseRevision: number;
  currentRevision: number;
  requestedPaths: string[];
  revisionJournal: RevisionJournalEntry[];
}): RevisionEvaluation {
  if (!Number.isInteger(args.baseRevision) || args.baseRevision < 0 || args.baseRevision > args.currentRevision) {
    return { status: "conflict", conflictingPaths: [] };
  }
  if (args.baseRevision === args.currentRevision) return { status: "accepted" };

  const later = args.revisionJournal.filter(
    (entry) => entry.revision > args.baseRevision && entry.revision <= args.currentRevision
  );
  if (
    later.length !== args.currentRevision - args.baseRevision ||
    later[0]?.revision !== args.baseRevision + 1 ||
    later.at(-1)?.revision !== args.currentRevision
  ) {
    return { status: "conflict", conflictingPaths: [] };
  }

  const conflictingPaths = [
    ...new Set(
      later.flatMap((entry) =>
        entry.changedPaths.filter((changedPath) =>
          args.requestedPaths.some((requestedPath) => pathsOverlap(changedPath, requestedPath))
        )
      )
    )
  ];
  return conflictingPaths.length > 0
    ? { status: "conflict", conflictingPaths }
    : { status: "accepted", rebasedFrom: args.baseRevision };
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
