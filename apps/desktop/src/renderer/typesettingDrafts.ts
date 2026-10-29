import { isValidTypesettingBbox, type TypesettingDraft } from "./typesettingGeometry";

export const TYPESETTING_DRAFT_STORAGE_KEY = "trio.typesetting-drafts.v1";
const TYPESETTING_DRAFT_SCHEMA = "trio-typesetting-drafts";
const TYPESETTING_DRAFT_VERSION = 1;

export type TypesettingDraftScope = {
  projectId: string;
  pageImageId: string;
  sourceOcrId: string;
};

type StoredTypesettingEntry = TypesettingDraftScope & {
  draft: TypesettingDraft;
};

type TypesettingDraftEnvelope = {
  schema: typeof TYPESETTING_DRAFT_SCHEMA;
  version: typeof TYPESETTING_DRAFT_VERSION;
  entries: Record<string, StoredTypesettingEntry>;
};

export function loadTypesettingDraft(
  storage: Storage | null | undefined,
  scope: TypesettingDraftScope
): TypesettingDraft | null {
  if (!isScope(scope)) return null;
  const envelope = readEnvelope(storage);
  if (!envelope) return null;
  const entry = envelope.entries[scopeKey(scope)];
  if (!entry || !sameScope(entry, scope) || !isTypesettingDraft(entry.draft, scope.sourceOcrId)) return null;
  return cloneDraft(entry.draft);
}

export function saveTypesettingDraft(
  storage: Storage | null | undefined,
  scope: TypesettingDraftScope,
  draft: TypesettingDraft
): void {
  if (!storage || !isScope(scope) || !isTypesettingDraft(draft, scope.sourceOcrId)) return;
  const envelope = readEnvelope(storage) ?? createEnvelope();
  const key = scopeKey(scope);
  envelope.entries[key] = {
    ...scope,
    draft: cloneDraft(draft)
  };
  try {
    storage.setItem(TYPESETTING_DRAFT_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Renderer preferences are best-effort when storage is unavailable or full.
  }
}

export function clearTypesettingDraft(storage: Storage | null | undefined, scope: TypesettingDraftScope): void {
  if (!storage || !isScope(scope)) return;
  const envelope = readEnvelope(storage);
  if (!envelope) return;
  delete envelope.entries[scopeKey(scope)];
  try {
    storage.setItem(TYPESETTING_DRAFT_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Ignore preference storage failures; no project content is affected.
  }
}

export function typesettingDraftScopeKey(scope: TypesettingDraftScope): string {
  return scopeKey(scope);
}

function readEnvelope(storage: Storage | null | undefined): TypesettingDraftEnvelope | null {
  if (!storage) return null;
  let serialized: string | null;
  try {
    serialized = storage.getItem(TYPESETTING_DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isEnvelope(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function createEnvelope(): TypesettingDraftEnvelope {
  return {
    schema: TYPESETTING_DRAFT_SCHEMA,
    version: TYPESETTING_DRAFT_VERSION,
    entries: {}
  };
}

function isEnvelope(value: unknown): value is TypesettingDraftEnvelope {
  if (!isRecord(value) || value.schema !== TYPESETTING_DRAFT_SCHEMA || value.version !== TYPESETTING_DRAFT_VERSION || !isRecord(value.entries)) {
    return false;
  }
  return Object.values(value.entries).every((entry) => isRecord(entry));
}

function isScope(value: unknown): value is TypesettingDraftScope {
  return Boolean(
    isRecord(value) &&
    isSafeIdentity(value.projectId) &&
    isSafeIdentity(value.pageImageId) &&
    isSafeIdentity(value.sourceOcrId)
  );
}

function sameScope(left: TypesettingDraftScope, right: TypesettingDraftScope): boolean {
  return left.projectId === right.projectId && left.pageImageId === right.pageImageId && left.sourceOcrId === right.sourceOcrId;
}

function isTypesettingDraft(value: unknown, sourceOcrId: string): value is TypesettingDraft {
  if (!isRecord(value) || value.sourceOcrId !== sourceOcrId || !isSafeIdentity(value.id)) return false;
  if (value.writingMode !== "horizontal-tb" && value.writingMode !== "vertical-rl") return false;
  if (typeof value.rotationDegrees !== "number" || !Number.isFinite(value.rotationDegrees)) return false;
  if ("shape" in value && typeof value.shape === "string" && !["rectangle", "ellipse", "rounded_rectangle", "cloud", "spiky"].includes(value.shape)) {
    return false;
  }
  return isValidTypesettingBbox(value.bbox);
}

function isSafeIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000\r\n]/.test(value) && !/^[A-Za-z]:[\\/]/.test(value) && !/^\/{1,2}/.test(value);
}

function scopeKey(scope: TypesettingDraftScope): string {
  return [scope.projectId, scope.pageImageId, scope.sourceOcrId].map((part) => encodeURIComponent(part)).join("|");
}

function cloneDraft(draft: TypesettingDraft): TypesettingDraft {
  return {
    ...draft,
    bbox: { ...draft.bbox },
    rotationDegrees: Number.isFinite(draft.rotationDegrees) ? draft.rotationDegrees : 0,
    shape: draft.shape
  };
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
