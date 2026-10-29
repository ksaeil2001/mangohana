import type { PageImage, TranslationProjectV2 } from "./projectTypes.js";

/**
 * Replaces page images by page number and invalidates processing state whose
 * authority came from the replaced image identity. Stored assets are retained;
 * storage and recovery own their lifecycle.
 */
export function replaceProjectPageImages(
  project: TranslationProjectV2,
  replacements: PageImage[]
): TranslationProjectV2 {
  const replacementByPageNumber = new Map<number, PageImage>();
  for (const replacement of replacements) {
    replacementByPageNumber.set(replacement.pageNumber, structuredClone(replacement));
  }

  const replacedPageImageIds = new Set<string>();
  for (const existing of project.pageImages) {
    const replacement = replacementByPageNumber.get(existing.pageNumber);
    if (replacement && replacement.id !== existing.id) {
      replacedPageImageIds.add(existing.id);
    }
  }

  const pageImageByNumber = new Map<number, PageImage>();
  for (const existing of project.pageImages) {
    pageImageByNumber.set(existing.pageNumber, structuredClone(existing));
  }
  for (const replacement of replacementByPageNumber.values()) {
    pageImageByNumber.set(replacement.pageNumber, replacement);
  }

  const next = structuredClone(project);
  for (const page of next.processing.pages) {
    const previous = project.pageImages.find((image) => image.id === page.pageImageId);
    const replacement = previous && replacementByPageNumber.get(previous.pageNumber);
    if (replacement && (
      replacement.id !== previous.id || replacement.sha256 !== previous.sha256 ||
      replacement.storedRelativePath !== previous.storedRelativePath ||
      replacement.byteSize !== previous.byteSize || replacement.mimeType !== previous.mimeType
    )) {
      delete page.userReviewedCleanedAssetId;
    }
  }
  next.pageImages = [...pageImageByNumber.values()].sort(
    (left, right) => left.pageNumber - right.pageNumber
  );
  if (replacedPageImageIds.size === 0) return next;

  const removedRunIds = new Set(
    next.processing.runs
      .filter((run) => replacedPageImageIds.has(run.pageImageId))
      .map((run) => run.runId)
  );
  next.processing.pages = next.processing.pages.filter(
    (page) => !replacedPageImageIds.has(page.pageImageId)
  );
  next.processing.runs = next.processing.runs.filter(
    (run) => !replacedPageImageIds.has(run.pageImageId)
  );
  next.processing.assets = next.processing.assets.filter(
    (asset) =>
      !replacedPageImageIds.has(asset.sourcePageImageId) &&
      !removedRunIds.has(asset.runId)
  );

  const queue = next.processing.queue;
  if (
    queue &&
    (
      queue.pageImageIds.some((pageImageId) => replacedPageImageIds.has(pageImageId)) ||
      queue.pages.some((page) => replacedPageImageIds.has(page.pageImageId))
    )
  ) {
    delete next.processing.queue;
  }

  next.dialogueLines = next.dialogueLines.map((line) =>
    line.origin.kind === "pipeline" &&
    replacedPageImageIds.has(line.origin.pageImageId)
      ? { ...line, orphanedFromPipeline: true }
      : line
  );
  return next;
}
