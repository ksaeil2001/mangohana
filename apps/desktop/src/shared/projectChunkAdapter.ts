import type {
  ChunkedProjectSnapshot,
  PageChunk,
  PageSummaryIndex,
  PageSummaryStatus,
  ProjectManifest
} from "./projectChunkTypes.js";
import type {
  DerivedImageAsset,
  DialogueLineV2,
  PageImage,
  PageProcessingRecord,
  ProcessingRunRecord,
  SecretProjectSecurityV1,
  TranslationProjectV2
} from "./projectTypes.js";

/**
 * Computes a fast deterministic 64-bit hex hash for a page chunk.
 */
export function computeChunkHash(chunk: PageChunk): string {
  const serialized = JSON.stringify({
    pageNumber: chunk.pageNumber,
    pageImageId: chunk.pageImageId,
    dialogueLines: chunk.dialogueLines,
    pageProcessing: chunk.pageProcessing,
    runs: chunk.runs,
    assets: chunk.assets
  });

  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < serialized.length; i += 1) {
    const ch = serialized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const hashNum = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return hashNum.toString(16).padStart(12, "0");
}

/**
 * Decomposes a monolithic TranslationProjectV2 into a lightweight ProjectManifest
 * and page-level PageChunk collection.
 */
export function decomposeProjectToChunks(
  project: TranslationProjectV2,
  security?: SecretProjectSecurityV1
): ChunkedProjectSnapshot {
  const pageImageMap = new Map<number, PageImage>();
  const imageIdToPageNum = new Map<string, number>();
  for (const pageImage of project.pageImages) {
    pageImageMap.set(pageImage.pageNumber, pageImage);
    imageIdToPageNum.set(pageImage.id, pageImage.pageNumber);
  }

  // Collect all known page numbers from pageImages, dialogueLines, and processing records
  const allPageNumbers = new Set<number>();
  for (const pageImage of project.pageImages) {
    allPageNumbers.add(pageImage.pageNumber);
  }
  for (const line of project.dialogueLines) {
    allPageNumbers.add(line.pageNumber);
  }
  for (const pageRecord of project.processing.pages) {
    const pageNum = imageIdToPageNum.get(pageRecord.pageImageId);
    if (pageNum !== undefined) allPageNumbers.add(pageNum);
  }
  for (const run of project.processing.runs) {
    const pageNum = imageIdToPageNum.get(run.pageImageId);
    if (pageNum !== undefined) allPageNumbers.add(pageNum);
  }
  for (const asset of project.processing.assets) {
    const pageNum = imageIdToPageNum.get(asset.sourcePageImageId);
    if (pageNum !== undefined) allPageNumbers.add(pageNum);
  }

  const sortedPageNumbers = [...allPageNumbers].sort((a, b) => a - b);

  // Group dialogues by pageNumber
  const dialoguesByPage = new Map<number, DialogueLineV2[]>();
  for (const line of project.dialogueLines) {
    const list = dialoguesByPage.get(line.pageNumber) ?? [];
    list.push(structuredClone(line));
    dialoguesByPage.set(line.pageNumber, list);
  }

  // Group processing pages, runs, assets by pageImageId
  const processingPageMap = new Map<string, PageProcessingRecord>();
  for (const pageRecord of project.processing.pages) {
    processingPageMap.set(pageRecord.pageImageId, structuredClone(pageRecord));
  }

  const runsByImageId = new Map<string, ProcessingRunRecord[]>();
  for (const run of project.processing.runs) {
    const list = runsByImageId.get(run.pageImageId) ?? [];
    list.push(structuredClone(run));
    runsByImageId.set(run.pageImageId, list);
  }

  const assetsByImageId = new Map<string, DerivedImageAsset[]>();
  for (const asset of project.processing.assets) {
    const list = assetsByImageId.get(asset.sourcePageImageId) ?? [];
    list.push(structuredClone(asset));
    assetsByImageId.set(asset.sourcePageImageId, list);
  }

  // Keep track of which processing items were assigned to a page
  const assignedImageIds = new Set<string>();

  const chunks: PageChunk[] = [];
  const pageIndex: PageSummaryIndex[] = [];

  for (const pageNumber of sortedPageNumbers) {
    const pageImage = pageImageMap.get(pageNumber);
    const pageImageId = pageImage?.id ?? `virtual-page-${pageNumber}`;
    assignedImageIds.add(pageImageId);

    const dialogueLines = dialoguesByPage.get(pageNumber) ?? [];
    const pageProcessing = processingPageMap.get(pageImageId);
    const runs = runsByImageId.get(pageImageId) ?? [];
    const assets = assetsByImageId.get(pageImageId) ?? [];

    const chunk: PageChunk = {
      pageNumber,
      pageImageId,
      dialogueLines,
      ...(pageProcessing ? { pageProcessing } : {}),
      runs,
      assets
    };

    const chunkHash = computeChunkHash(chunk);
    const status = resolvePageSummaryStatus(chunk);
    const hasInpainting =
      assets.some((a) => a.role === "cleaned" || a.role === "translated" || a.role === "mask") ||
      pageProcessing?.approvedCleanedAssetId !== undefined ||
      pageProcessing?.approvedTranslatedAssetId !== undefined;
    const hasTypesetting = dialogueLines.some((l) => l.typesetting !== undefined);
    const updatedAt = pageProcessing?.updatedAt ?? project.metadata.updatedAt;

    pageIndex.push({
      pageNumber,
      pageImageId,
      dialogueCount: dialogueLines.length,
      status,
      hasInpainting,
      hasTypesetting,
      updatedAt,
      chunkHash
    });

    chunks.push(chunk);
  }

  // Handle unassigned runs/assets/page processing records (e.g. if image ID was unlinked)
  // Store them in an unassigned fallback chunk to guarantee 100% lossless round-trip
  const unassignedPageProcessing: PageProcessingRecord[] = [];
  for (const [imageId, record] of processingPageMap) {
    if (!assignedImageIds.has(imageId)) unassignedPageProcessing.push(record);
  }
  const unassignedRuns: ProcessingRunRecord[] = [];
  for (const [imageId, runs] of runsByImageId) {
    if (!assignedImageIds.has(imageId)) unassignedRuns.push(...runs);
  }
  const unassignedAssets: DerivedImageAsset[] = [];
  for (const [imageId, assets] of assetsByImageId) {
    if (!assignedImageIds.has(imageId)) unassignedAssets.push(...assets);
  }

  if (unassignedPageProcessing.length > 0 || unassignedRuns.length > 0 || unassignedAssets.length > 0) {
    const unassignedChunk: PageChunk = {
      pageNumber: 0,
      pageImageId: "__unassigned__",
      dialogueLines: [],
      ...(unassignedPageProcessing[0] ? { pageProcessing: unassignedPageProcessing[0] } : {}),
      runs: unassignedRuns,
      assets: unassignedAssets
    };
    chunks.push(unassignedChunk);
  }

  const manifest: ProjectManifest = {
    schemaVersion: 2,
    metadata: structuredClone(project.metadata),
    characters: structuredClone(project.characters),
    dictionaryTerms: structuredClone(project.dictionaryTerms),
    pageImages: structuredClone(project.pageImages),
    settings: structuredClone(project.settings),
    pageIndex,
    ...(security ? { security: structuredClone(security) } : {})
  };

  return { manifest, chunks };
}

/**
 * Reconstructs a full TranslationProjectV2 from a ProjectManifest and PageChunk collection.
 */
export function composeProjectFromChunks(snapshot: ChunkedProjectSnapshot): TranslationProjectV2 {
  const { manifest, chunks } = snapshot;

  const allDialogueLines: DialogueLineV2[] = [];
  const allPageProcessing: PageProcessingRecord[] = [];
  const allRuns: ProcessingRunRecord[] = [];
  const allAssets: DerivedImageAsset[] = [];

  for (const chunk of chunks) {
    for (const line of chunk.dialogueLines) {
      allDialogueLines.push(structuredClone(line));
    }
    if (chunk.pageProcessing) {
      allPageProcessing.push(structuredClone(chunk.pageProcessing));
    }
    for (const run of chunk.runs) {
      allRuns.push(structuredClone(run));
    }
    for (const asset of chunk.assets) {
      allAssets.push(structuredClone(asset));
    }
  }

  // Preserve dialogue line original ordering
  allDialogueLines.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  return {
    schemaVersion: 2,
    metadata: structuredClone(manifest.metadata),
    characters: structuredClone(manifest.characters),
    dictionaryTerms: structuredClone(manifest.dictionaryTerms),
    pageImages: structuredClone(manifest.pageImages),
    settings: structuredClone(manifest.settings),
    dialogueLines: allDialogueLines,
    processing: {
      pages: allPageProcessing,
      runs: allRuns,
      assets: allAssets
    }
  };
}

function resolvePageSummaryStatus(chunk: PageChunk): PageSummaryStatus {
  if (chunk.pageProcessing?.finalStatus) {
    return chunk.pageProcessing.finalStatus;
  }
  if (chunk.dialogueLines.length === 0) {
    return "untranslated";
  }
  const statuses = new Set(chunk.dialogueLines.map((l) => l.lineStatus ?? "untranslated"));
  if (statuses.has("review")) return "review";
  if (statuses.has("draft")) return "draft";
  if (statuses.size === 1 && statuses.has("complete")) return "complete";
  return "untranslated";
}
