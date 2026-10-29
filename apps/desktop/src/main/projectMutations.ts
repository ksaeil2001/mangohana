import { randomUUID } from "node:crypto";
import type {
  CharacterProfile,
  DialogueLineV2,
  DialogueType,
  DialogueTypesetting,
  DictionaryTerm,
  DictionaryTermCategory,
  LineStatus,
  SourceLanguage,
  TermCondition,
  TranslationMode,
  TranslationProjectV2
} from "../shared/projectTypes.js";
import type {
  DialogueUserPatch,
  NormalizedProjectMutation,
  ProjectMutation
} from "../shared/projectChanges.js";

type NormalizationOptions = {
  createId?: () => string;
};

const inputFields = new Set([
  "pageNumber",
  "sourceLanguage",
  "sourceText",
  "dialogueType",
  "speaker",
  "position",
  "notes",
  "lineStatus",
  "referenceTranslation",
  "userTranslation",
  "typesetting"
]);
const patchFields = new Set([
  "speaker",
  "position",
  "dialogueType",
  "lineStatus",
  "sourceLanguage",
  "sourceText",
  "referenceTranslation",
  "userTranslation",
  "notes",
  "typesetting",
  "pageNumber"
]);
const dialogueTypes = new Set<DialogueType>(["speech", "thought", "narration", "unknown"]);
const sourceLanguages = new Set<SourceLanguage>(["ja", "en", "mixed", "unknown"]);
const lineStatuses = new Set<LineStatus>(["untranslated", "draft", "complete", "review"]);
const translationModes = new Set<TranslationMode>(["fast", "precise"]);
const characterFields = new Set([
  "id",
  "name",
  "aliases",
  "description",
  "speechStyle",
  "relationshipNotes"
]);
const dictionaryTermFields = new Set(["id", "source", "target", "note", "category", "condition", "priority"]);
const dictionaryTermCategories = new Set<DictionaryTermCategory>([
  "character",
  "skill",
  "location",
  "tone",
  "general"
]);
const termConditionFields = new Set(["speaker", "dialogueType", "targetContext"]);

export function validateAndNormalizeProjectMutation(
  project: TranslationProjectV2,
  value: unknown,
  options: NormalizationOptions = {}
): { mutation: NormalizedProjectMutation; changedPaths: string[] } {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid project mutation: expected typed object");
  }

  switch (value.type) {
    case "add_dialogue_line": {
      const input = normalizeNewLineInput(value.input);
      const id = (options.createId ?? randomUUID)();
      const line = createLine(project, input, id, nextOrder(project));
      return { mutation: { type: value.type, line }, changedPaths: [`dialogueLines/${id}`] };
    }
    case "update_dialogue_line": {
      const lineId = requireNonEmptyString(value.lineId, "lineId");
      const patch = normalizeDialoguePatch(value.patch);
      return {
        mutation: { type: value.type, lineId, patch },
        changedPaths: Object.keys(patch).map((field) => `dialogueLines/${lineId}/${field}`)
      };
    }
    case "update_dialogue_typesetting": {
      const lineId = requireNonEmptyString(value.lineId, "lineId");
      const typesetting = normalizeTypesetting(value.typesetting);
      return {
        mutation: { type: value.type, lineId, typesetting },
        changedPaths: [`dialogueLines/${lineId}/typesetting`]
      };
    }
    case "remove_dialogue_line": {
      const lineId = requireNonEmptyString(value.lineId, "lineId");
      return { mutation: { type: value.type, lineId }, changedPaths: [`dialogueLines/${lineId}`] };
    }
    case "reorder_dialogue_lines": {
      const orderedLineIds = requireUniqueStringArray(value.orderedLineIds, "orderedLineIds");
      return { mutation: { type: value.type, orderedLineIds }, changedPaths: ["dialogueLines/order"] };
    }
    case "set_project_title": {
      if (typeof value.title !== "string") throw new Error("Invalid project mutation: title must be a string");
      return { mutation: { type: value.type, title: value.title }, changedPaths: ["metadata/title"] };
    }
    case "update_project_settings": {
      if (!isRecord(value.patch)) throw new Error("Invalid project mutation: settings patch must be an object");
      const allowed = new Set(["defaultSourceLanguage", "translationMode", "allowExternalAi", "debugArtifactsEnabled"]);
      rejectUnsupportedFields(value.patch, allowed);
      const patch = normalizeSettingsPatch(value.patch);
      return {
        mutation: { type: value.type, patch },
        changedPaths: Object.keys(patch).map((field) => `settings/${field}`)
      };
    }
    case "upsert_character": {
      const character = normalizeCharacter(value.character);
      return {
        mutation: { type: value.type, character },
        changedPaths: [`characters/${character.id}`]
      };
    }
    case "upsert_dictionary_term": {
      const term = normalizeDictionaryTerm(value.term);
      return {
        mutation: { type: value.type, term },
        changedPaths: [`dictionaryTerms/${term.id}`]
      };
    }
    case "remove_character":
    case "remove_dictionary_term":
    case "remove_page_image":
      return normalizeSimpleMutation(value);
    default:
      throw new Error(`Invalid project mutation: unsupported type ${value.type}`);
  }
}

function normalizeSimpleMutation(
  value: Record<string, unknown>
): { mutation: NormalizedProjectMutation; changedPaths: string[] } {
  const field =
    value.type === "remove_character"
      ? "characterId"
      : value.type === "remove_dictionary_term"
        ? "termId"
        : "pageImageId";
  const id = requireNonEmptyString(value[field], field);
  const root =
    value.type === "remove_character"
      ? "characters"
      : value.type === "remove_dictionary_term"
        ? "dictionaryTerms"
        : "pageImages";
  return {
    mutation: { type: value.type, [field]: id } as NormalizedProjectMutation,
    changedPaths: [`${root}/${id}`]
  };
}

function normalizeSettingsPatch(
  value: Record<string, unknown>
): Partial<TranslationProjectV2["settings"]> {
  if (
    Object.hasOwn(value, "defaultSourceLanguage") &&
    !sourceLanguages.has(value.defaultSourceLanguage as SourceLanguage)
  ) {
    throw new Error("Invalid project mutation: defaultSourceLanguage is unsupported");
  }
  if (
    Object.hasOwn(value, "translationMode") &&
    !translationModes.has(value.translationMode as TranslationMode)
  ) {
    throw new Error("Invalid project mutation: translationMode is unsupported");
  }
  for (const field of ["allowExternalAi", "debugArtifactsEnabled"]) {
    if (Object.hasOwn(value, field) && typeof value[field] !== "boolean") {
      throw new Error(`Invalid project mutation: ${field} must be a boolean`);
    }
  }
  return structuredClone(value) as Partial<TranslationProjectV2["settings"]>;
}

function normalizeCharacter(value: unknown): CharacterProfile {
  if (!isRecord(value)) {
    throw new Error("Invalid project mutation: character must be an object");
  }
  rejectUnsupportedFields(value, characterFields);
  const character: CharacterProfile = {
    id: requireNonEmptyString(value.id, "character.id"),
    name: requireNonEmptyString(value.name, "character.name"),
    aliases: requireStringArray(value.aliases, "character.aliases")
  };
  copyOptionalStrings(value, character, ["description", "speechStyle", "relationshipNotes"], "character");
  return character;
}

function normalizeDictionaryTerm(value: unknown): DictionaryTerm {
  if (!isRecord(value)) {
    throw new Error("Invalid project mutation: term must be an object");
  }
  rejectUnsupportedFields(value, dictionaryTermFields);
  const term: DictionaryTerm = {
    id: requireNonEmptyString(value.id, "term.id"),
    source: requireNonEmptyString(value.source, "term.source"),
    target: requireNonEmptyString(value.target, "term.target")
  };
  copyOptionalStrings(value, term, ["note"], "term");
  if (Object.hasOwn(value, "category")) {
    if (!dictionaryTermCategories.has(value.category as DictionaryTermCategory)) {
      throw new Error("Invalid project mutation: term.category is unsupported");
    }
    term.category = value.category as DictionaryTermCategory;
  }
  if (Object.hasOwn(value, "priority")) {
    if (typeof value.priority !== "number" || !Number.isFinite(value.priority)) {
      throw new Error("Invalid project mutation: term.priority must be a finite number");
    }
    term.priority = value.priority;
  }
  if (Object.hasOwn(value, "condition")) {
    term.condition = normalizeTermCondition(value.condition);
  }
  return term;
}

function normalizeTermCondition(value: unknown): TermCondition {
  if (!isRecord(value)) {
    throw new Error("Invalid project mutation: term.condition must be an object");
  }
  rejectUnsupportedFields(value, termConditionFields);
  const condition: TermCondition = {};
  if (Object.hasOwn(value, "speaker")) {
    if (typeof value.speaker !== "string") {
      throw new Error("Invalid project mutation: term.condition.speaker must be a string");
    }
    condition.speaker = value.speaker;
  }
  if (Object.hasOwn(value, "dialogueType")) {
    if (!dialogueTypes.has(value.dialogueType as DialogueType)) {
      throw new Error("Invalid project mutation: term.condition.dialogueType is unsupported");
    }
    condition.dialogueType = value.dialogueType as DialogueType;
  }
  if (Object.hasOwn(value, "targetContext")) {
    if (typeof value.targetContext !== "string") {
      throw new Error("Invalid project mutation: term.condition.targetContext must be a string");
    }
    condition.targetContext = value.targetContext;
  }
  return condition;
}

function copyOptionalStrings<T extends object>(
  source: Record<string, unknown>,
  target: T,
  fields: string[],
  prefix: string
): void {
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) continue;
    if (typeof source[field] !== "string") {
      throw new Error(`Invalid project mutation: ${prefix}.${field} must be a string`);
    }
    Object.assign(target, { [field]: source[field] });
  }
}

function normalizeNewLineInput(value: unknown) {
  if (!isRecord(value)) throw new Error("Invalid project mutation: input must be an object");
  rejectUnsupportedFields(value, inputFields);
  const pageNumber = value.pageNumber;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error("Invalid project mutation: pageNumber must be a positive integer");
  }
  if (!sourceLanguages.has(value.sourceLanguage as SourceLanguage)) {
    throw new Error("Invalid project mutation: sourceLanguage is unsupported");
  }
  if (!dialogueTypes.has(value.dialogueType as DialogueType)) {
    throw new Error("Invalid project mutation: dialogueType is unsupported");
  }
  if (typeof value.sourceText !== "string") {
    throw new Error("Invalid project mutation: sourceText must be a string");
  }
  if (value.lineStatus !== undefined && !lineStatuses.has(value.lineStatus as LineStatus)) {
    throw new Error("Invalid project mutation: lineStatus is unsupported");
  }
  for (const field of ["speaker", "position", "notes", "referenceTranslation", "userTranslation"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Invalid project mutation: ${field} must be a string`);
    }
  }
  return value as {
    pageNumber: number;
    sourceLanguage: SourceLanguage;
    sourceText: string;
    dialogueType: DialogueType;
    speaker?: string;
    position?: string;
    notes?: string;
    lineStatus?: LineStatus;
    referenceTranslation?: string;
    userTranslation?: string;
    typesetting?: DialogueTypesetting;
  };
}

function normalizeTypesetting(value: unknown): DialogueTypesetting {
  if (!isRecord(value)) {
    throw new Error("Invalid project mutation: typesetting must be an object");
  }
  if (!isRecord(value.bbox)) {
    throw new Error("Invalid project mutation: typesetting.bbox must be an object");
  }
  const { x, y, width, height } = value.bbox;
  if (
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y) ||
    typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
    typeof height !== "number" || !Number.isFinite(height) || height <= 0
  ) {
    throw new Error("Invalid project mutation: typesetting.bbox coordinates must be finite positive numbers");
  }
  if (value.writingMode !== "horizontal-tb" && value.writingMode !== "vertical-rl") {
    throw new Error("Invalid project mutation: typesetting.writingMode is unsupported");
  }
  const typesetting: DialogueTypesetting = {
    bbox: { x, y, width, height },
    writingMode: value.writingMode
  };
  if (value.rotationDegrees !== undefined) {
    if (typeof value.rotationDegrees !== "number" || !Number.isFinite(value.rotationDegrees)) {
      throw new Error("Invalid project mutation: typesetting.rotationDegrees must be a number");
    }
    typesetting.rotationDegrees = value.rotationDegrees;
  }
  if (value.shape !== undefined) {
    if (!["rectangle", "ellipse", "rounded_rectangle", "cloud", "spiky"].includes(value.shape as string)) {
      throw new Error("Invalid project mutation: typesetting.shape is unsupported");
    }
    typesetting.shape = value.shape as DialogueTypesetting["shape"];
  }
  for (const strField of ["fontFamily", "color", "strokeColor"] as const) {
    if (value[strField] !== undefined) {
      if (typeof value[strField] !== "string") {
        throw new Error(`Invalid project mutation: typesetting.${strField} must be a string`);
      }
      typesetting[strField] = value[strField] as string;
    }
  }
  for (const numField of ["fontSizeRatio", "strokeWidth", "lineHeight"] as const) {
    if (value[numField] !== undefined) {
      if (typeof value[numField] !== "number" || !Number.isFinite(value[numField])) {
        throw new Error(`Invalid project mutation: typesetting.${numField} must be a number`);
      }
      typesetting[numField] = value[numField] as number;
    }
  }
  if (value.align !== undefined) {
    if (!["center", "left", "right"].includes(value.align as string)) {
      throw new Error("Invalid project mutation: typesetting.align is unsupported");
    }
    typesetting.align = value.align as DialogueTypesetting["align"];
  }
  return typesetting;
}

function normalizeDialoguePatch(value: unknown): DialogueUserPatch {
  if (!isRecord(value)) throw new Error("Invalid project mutation: patch must be an object");
  rejectUnsupportedFields(value, patchFields);
  if (value.dialogueType !== undefined && !dialogueTypes.has(value.dialogueType as DialogueType)) {
    throw new Error("Invalid project mutation: dialogueType is unsupported");
  }
  if (value.sourceLanguage !== undefined && !sourceLanguages.has(value.sourceLanguage as SourceLanguage)) {
    throw new Error("Invalid project mutation: sourceLanguage is unsupported");
  }
  if (value.lineStatus !== undefined && !lineStatuses.has(value.lineStatus as LineStatus)) {
    throw new Error("Invalid project mutation: lineStatus is unsupported");
  }
  const result: DialogueUserPatch = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === "typesetting") {
      result.typesetting = normalizeTypesetting(fieldValue);
    } else if (field === "pageNumber") {
      if (typeof fieldValue !== "number" || !Number.isInteger(fieldValue) || fieldValue < 1) {
        throw new Error("Invalid project mutation: pageNumber must be a positive integer");
      }
      result.pageNumber = fieldValue;
    } else {
      if (typeof fieldValue !== "string") {
        throw new Error(`Invalid project mutation: ${field} must be a string`);
      }
      (result as Record<string, unknown>)[field] = fieldValue;
    }
  }
  return result;
}

function createLine(
  _project: TranslationProjectV2,
  input: ReturnType<typeof normalizeNewLineInput>,
  id: string,
  order: number
): DialogueLineV2 {
  return {
    id,
    order,
    pageNumber: input.pageNumber,
    sourceLanguage: input.sourceLanguage,
    sourceText: input.sourceText,
    dialogueType: input.dialogueType,
    lineStatus: input.lineStatus ?? "untranslated",
    parseConfidence: 1,
    parseWarnings: [],
    origin: { kind: "manual" },
    ...(input.speaker === undefined ? {} : { speaker: input.speaker }),
    ...(input.position === undefined ? {} : { position: input.position }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.referenceTranslation === undefined ? {} : { referenceTranslation: input.referenceTranslation }),
    ...(input.userTranslation === undefined ? {} : { userTranslation: input.userTranslation }),
    ...(input.typesetting === undefined ? {} : { typesetting: normalizeTypesetting(input.typesetting) })
  };
}

function nextOrder(project: TranslationProjectV2): number {
  return Math.max(0, ...project.dialogueLines.map((line) => line.order)) + 1;
}

function rejectUnsupportedFields(value: Record<string, unknown>, allowed: Set<string>): void {
  const unsupported = Object.keys(value).find((field) => !allowed.has(field));
  if (unsupported) throw new Error(`Invalid project mutation: unsupported field ${unsupported}`);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid project mutation: ${field} must be a non-empty string`);
  }
  return value;
}

function requireUniqueStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid project mutation: ${field} must be a string array`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`Invalid project mutation: ${field} must not contain duplicates`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid project mutation: ${field} must be a string array`);
  }
  return [...value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
