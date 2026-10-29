import type { DialogueLine } from "../shared/projectTypes";

export type ReviewStage = "ocr" | "speaker";
export type GuidedStage = ReviewStage | "translation" | "complete";
export type GuidanceDensity = "guided" | "compact";

export function getGuidedStage(args: {
  hasReview: boolean;
  reviewStage: ReviewStage;
  hasSelectedLine: boolean;
}): GuidedStage {
  if (args.hasReview) return args.reviewStage;
  if (args.hasSelectedLine) return "translation";
  return "complete";
}

export function getNextActionableLineId(
  lines: DialogueLine[],
  currentLineId: string | null,
  currentPage: number
): string | null {
  const pageLines = lines.filter((line) => line.pageNumber === currentPage).sort((left, right) => left.order - right.order);
  if (pageLines.length === 0) return null;

  const currentIndex = pageLines.findIndex((line) => line.id === currentLineId);
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const candidates = [...pageLines.slice(startIndex), ...pageLines.slice(0, startIndex)];
  return candidates.find((line) => line.id !== currentLineId && (line.lineStatus ?? "untranslated") !== "complete")?.id ?? null;
}

export function getQueueWindow(lines: DialogueLine[], selectedLineId: string | null, size = 5): DialogueLine[] {
  const orderedLines = lines
    .map((line, originalIndex) => ({ line, originalIndex }))
    .sort((left, right) => left.line.order - right.line.order || left.originalIndex - right.originalIndex)
    .map(({ line }) => line);

  if (orderedLines.length <= size) return orderedLines;

  const selectedIndex = orderedLines.findIndex((line) => line.id === selectedLineId);
  if (selectedIndex < 0) return orderedLines.slice(0, size);

  const centeredStart = selectedIndex - Math.floor(size / 2);
  const start = Math.max(0, Math.min(centeredStart, orderedLines.length - size));
  return orderedLines.slice(start, start + size);
}
