import type {
  MainProjectPatch,
  NormalizedProjectMutation,
  PendingUserMutation
} from "../shared/projectChanges.js";
import type { DialogueLineV2, DialogueTypesetting, LineStatus, TranslationProjectV2 } from "../shared/projectTypes.js";
import { OCR_USER_OWNED_FIELDS, type OcrUserOwnedField } from "../shared/productionOcr.js";
import { replaceProjectPageImages } from "../shared/pageImageReplacement.js";

export function replayPendingUserMutations(
  persistedProjectSnapshot: TranslationProjectV2,
  pendingUserMutations: PendingUserMutation[]
): TranslationProjectV2 {
  let project = structuredClone(persistedProjectSnapshot);
  for (const entry of pendingUserMutations) {
    project = applyNormalizedProjectMutation(project, entry.mutation);
    project.metadata.updatedAt = entry.createdAt;
  }
  return project;
}

export function applyNormalizedProjectMutation(
  project: TranslationProjectV2,
  mutation: NormalizedProjectMutation
): TranslationProjectV2 {
  const next = structuredClone(project);
  switch (mutation.type) {
    case "set_project_title":
      next.metadata.title = mutation.title;
      break;
    case "add_dialogue_line":
      if (next.dialogueLines.some((line) => line.id === mutation.line.id)) {
        throw new Error("Mutation replay failed: duplicate dialogue line id");
      }
      next.dialogueLines.push(structuredClone(mutation.line));
      break;
    case "update_dialogue_line": {
      const line = next.dialogueLines.find((candidate) => candidate.id === mutation.lineId);
      if (!line) throw new Error("Mutation replay failed: dialogue line is missing");
      Object.assign(line, structuredClone(mutation.patch));
      if (mutation.patch.sourceText !== undefined) {
        markOcrUserOwnership(line, "source_text");
        if (line.origin.kind === "pipeline") {
          line.userOverrideSourceText = mutation.patch.sourceText;
        }
      }
      if (mutation.patch.typesetting !== undefined) {
        markOcrUserOwnership(line, "geometry");
      }
      break;
    }
    case "update_dialogue_typesetting": {
      const line = next.dialogueLines.find((candidate) => candidate.id === mutation.lineId);
      if (!line) throw new Error("Mutation replay failed: dialogue line is missing");
      line.typesetting = structuredClone(mutation.typesetting);
      markOcrUserOwnership(line, "geometry");
      break;
    }
    case "remove_dialogue_line":
      if (!next.dialogueLines.some((line) => line.id === mutation.lineId)) {
        throw new Error("Mutation replay failed: dialogue line is missing");
      }
      next.dialogueLines = next.dialogueLines
        .filter((line) => line.id !== mutation.lineId)
        .map((line, index) => ({ ...line, order: index + 1 }));
      break;
    case "reorder_dialogue_lines":
      next.dialogueLines = reorderLines(next.dialogueLines, mutation.orderedLineIds);
      for (const line of next.dialogueLines) markOcrUserOwnership(line, "reading_order");
      break;
    case "upsert_character":
      next.characters = upsert(next.characters, mutation.character);
      break;
    case "remove_character":
      next.characters = next.characters.filter((item) => item.id !== mutation.characterId);
      break;
    case "upsert_dictionary_term":
      next.dictionaryTerms = upsert(next.dictionaryTerms, mutation.term);
      break;
    case "remove_dictionary_term":
      next.dictionaryTerms = next.dictionaryTerms.filter((item) => item.id !== mutation.termId);
      break;
    case "remove_page_image":
      next.pageImages = next.pageImages.filter((item) => item.id !== mutation.pageImageId);
      for (const page of next.processing.pages) {
        if (page.pageImageId === mutation.pageImageId) delete page.userReviewedCleanedAssetId;
      }
      break;
    case "update_project_settings":
      next.settings = { ...next.settings, ...structuredClone(mutation.patch) };
      break;
    case "register_page_images":
      return replaceProjectPageImages(next, mutation.pageImages);
  }
  return next;
}

export type UnpersistedBatchUpdate = {
  id: string;
  aiTranslation?: string;
  typesetting?: DialogueTypesetting;
  lineStatus?: LineStatus;
};

/**
 * Merge batch results into pending `add_dialogue_line` mutations for lines
 * that exist only in pendingUserMutations (not in persistedProjectSnapshot).
 * Returns a new array of mutations — does not mutate the original.
 */
export function mergeBatchResultsIntoPendingMutations(
  pendingMutations: PendingUserMutation[],
  unpersistedUpdates: UnpersistedBatchUpdate[]
): PendingUserMutation[] {
  if (unpersistedUpdates.length === 0) return pendingMutations;
  const updateMap = new Map(unpersistedUpdates.map((u) => [u.id, u]));
  return pendingMutations.map((entry) => {
    if (entry.mutation.type !== "add_dialogue_line") return entry;
    const update = updateMap.get(entry.mutation.line.id);
    if (!update) return entry;
    const mergedLine = { ...entry.mutation.line };
    if (update.aiTranslation !== undefined) mergedLine.aiTranslation = update.aiTranslation;
    if (update.typesetting !== undefined) mergedLine.typesetting = structuredClone(update.typesetting);
    if (update.lineStatus !== undefined) mergedLine.lineStatus = update.lineStatus;
    return {
      ...entry,
      mutation: { ...entry.mutation, line: mergedLine }
    };
  });
}

export function applyMainProjectPatch(
  project: TranslationProjectV2,
  patch: MainProjectPatch
): TranslationProjectV2 {
  const next = structuredClone(project);
  if (patch.type === "commit_processing_run") {
    next.processing.runs = upsertBy(next.processing.runs, patch.run, "runId");
    const pageRecord = structuredClone(patch.pageRecord);
    delete pageRecord.userReviewedCleanedAssetId;
    next.processing.pages = upsertBy(next.processing.pages, pageRecord, "pageImageId");
    for (const asset of patch.assets) {
      next.processing.assets = upsertBy(next.processing.assets, asset, "assetId");
    }
  } else if (patch.type === "merge_pipeline_dialogues") {
    next.dialogueLines = next.dialogueLines
      .map((line) => {
        const regionId = pipelineRegionId(line);
        if (!regionId) return line;
        return patch.orphanedPersistentRegionIds.includes(regionId)
          ? { ...line, orphanedFromPipeline: true }
          : line;
      });
    for (const line of patch.lines) {
      const regionId = pipelineRegionId(line);
      const index = next.dialogueLines.findIndex(
        (candidate) => regionId !== undefined && pipelineRegionId(candidate) === regionId
      );
      if (index >= 0) {
        const existing = next.dialogueLines[index]!;
        const merged = structuredClone(line);
        preserveDialogueUserFields(merged, existing);
        next.dialogueLines[index] = merged;
      }
      else next.dialogueLines.push(structuredClone(line));
    }
  } else if (patch.type === "update_processing_queue") {
    next.processing.queue = structuredClone(patch.queue);
  } else if (patch.type === "commit_batch_result") {
    const updateMap = new Map(patch.dialogueUpdates.map((u) => [u.id, u]));
    next.dialogueLines = next.dialogueLines.map((line) => {
      const update = updateMap.get(line.id);
      if (!update) return line;
      return {
        ...line,
        ...(update.aiTranslation !== undefined ? { aiTranslation: update.aiTranslation } : {}),
        ...(update.typesetting !== undefined ? { typesetting: structuredClone(update.typesetting) } : {}),
        ...(update.lineStatus !== undefined ? { lineStatus: update.lineStatus } : {})
      };
    });
    if (patch.queue) {
      next.processing.queue = structuredClone(patch.queue);
    }
  } else {
    const page = next.processing.pages.find((candidate) => candidate.pageImageId === patch.pageImageId);
    if (!page) throw new Error("Main patch failed: page processing record is missing");
    if (patch.kind === "cleaned") {
      page.approvedCleanedAssetId = patch.assetId;
      delete page.userReviewedCleanedAssetId;
    }
    else page.approvedTranslatedAssetId = patch.assetId;
  }
  return next;
}

function reorderLines(lines: DialogueLineV2[], orderedLineIds: string[]): DialogueLineV2[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const requested = orderedLineIds.map((id) => {
    const line = byId.get(id);
    if (!line) throw new Error("Mutation replay failed: reordered dialogue line is missing");
    byId.delete(id);
    return line;
  });
  const remaining = [...byId.values()].sort((left, right) => {
    if (left.pageNumber !== right.pageNumber) return left.pageNumber - right.pageNumber;
    const leftIndex = left.origin.kind === "pipeline" ? left.origin.readingIndex : Number.MAX_SAFE_INTEGER;
    const rightIndex = right.origin.kind === "pipeline" ? right.origin.readingIndex : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.order - right.order || left.id.localeCompare(right.id);
  });
  return [...requested, ...remaining].map((line, index) => ({ ...line, order: index + 1 }));
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, structuredClone(item)];
  const next = [...items];
  next[index] = structuredClone(item);
  return next;
}

function upsertBy<T extends Record<K, string>, K extends keyof T>(items: T[], item: T, key: K): T[] {
  const index = items.findIndex((candidate) => candidate[key] === item[key]);
  if (index < 0) return [...items, structuredClone(item)];
  const next = [...items];
  next[index] = structuredClone(item);
  return next;
}

function pipelineRegionId(line: DialogueLineV2): string | undefined {
  return line.origin.kind === "pipeline" ? line.origin.persistentRegionId : undefined;
}

function preserveDialogueUserFields(target: DialogueLineV2, source: DialogueLineV2): void {
  const fields = [
    "speaker",
    "lineStatus",
    "referenceTranslation",
    "userTranslation",
    "notes"
  ] as const;
  for (const field of fields) {
    if (Object.hasOwn(source, field)) {
      Object.assign(target, { [field]: source[field] });
    } else {
      delete target[field];
    }
  }
  const ownedFields = getUserOwnedOcrFields(source);
  target.ocrUserOwnedFields = [...ownedFields];
  if (source.ocrEditStatus !== undefined) target.ocrEditStatus = source.ocrEditStatus;
  if (ownedFields.has("source_text")) {
    target.sourceText = source.sourceText;
    if (source.userOverrideSourceText !== undefined) {
      target.userOverrideSourceText = source.userOverrideSourceText;
    }
  }
  if (ownedFields.has("reading_order")) {
    target.order = source.order;
    if (target.origin.kind === "pipeline" && source.origin.kind === "pipeline") {
      target.origin.readingIndex = source.origin.readingIndex;
    }
  }
  if (ownedFields.has("geometry")) {
    if (source.typesetting !== undefined) target.typesetting = structuredClone(source.typesetting);
    else delete target.typesetting;
    if (source.polygon !== undefined) target.polygon = structuredClone(source.polygon);
    else delete target.polygon;
  }
  if (ownedFields.has("group_assignment")) {
    if (source.ocrGroupId !== undefined) target.ocrGroupId = source.ocrGroupId;
    else delete target.ocrGroupId;
  }
}

function getUserOwnedOcrFields(line: DialogueLineV2): Set<OcrUserOwnedField> {
  if (line.ocrUserOwnedFields) return new Set(line.ocrUserOwnedFields);
  if (line.ocrEditStatus === "user_confirmed" || line.ocrEditStatus === "user_modified") {
    return new Set(OCR_USER_OWNED_FIELDS);
  }
  return new Set();
}

function markOcrUserOwnership(line: DialogueLineV2, field: OcrUserOwnedField): void {
  if (line.origin.kind !== "pipeline") return;
  const fields = new Set(line.ocrUserOwnedFields ?? []);
  fields.add(field);
  line.ocrUserOwnedFields = OCR_USER_OWNED_FIELDS.filter((candidate) => fields.has(candidate));
  line.ocrEditStatus = "user_modified";
}
