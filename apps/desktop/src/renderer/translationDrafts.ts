export type TranslationDraftScope = {
  projectId: string;
  projectRevision: number;
  lineId: string;
  sourceIdentity: string;
  lineStatus?: string;
};

type TranslationDraftEntry = TranslationDraftScope & { text: string };
type TranslationDraftEnvelope = { version: 1; entries: Record<string, TranslationDraftEntry> };

export const TRANSLATION_DRAFT_STORAGE_KEY = "trio.translation-drafts.v1";

export function saveTranslationDraft(storage: Storage, scope: TranslationDraftScope, text: string): void {
  if (!isValidScope(scope) || scope.lineStatus === "complete" || text.length === 0) return;
  try {
    const envelope = readEnvelope(storage);
    const entries = envelope?.entries ?? {};
    const key = scopeKey(scope);
    entries[key] = { ...scope, text };
    storage.setItem(TRANSLATION_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries } satisfies TranslationDraftEnvelope));
  } catch {
    // Renderer preferences are best effort and must not block editing.
  }
}

export function loadTranslationDraft(storage: Storage, scope: TranslationDraftScope): string | null {
  if (!isValidScope(scope) || scope.lineStatus === "complete") return null;
  try {
    const envelope = readEnvelope(storage);
    const entry = envelope?.entries[scopeKey(scope)];
    if (!entry || !isValidEntry(entry) || entry.lineStatus === "complete") return null;
    if (
      entry.projectId !== scope.projectId ||
      entry.projectRevision !== scope.projectRevision ||
      entry.lineId !== scope.lineId ||
      entry.sourceIdentity !== scope.sourceIdentity ||
      entry.text.length === 0
    ) return null;
    return entry.text;
  } catch {
    return null;
  }
}

export function clearTranslationDraft(storage: Storage, scope: TranslationDraftScope): void {
  if (!isValidScope(scope)) return;
  try {
    const envelope = readEnvelope(storage);
    if (!envelope) return;
    const key = scopeKey(scope);
    if (!Object.hasOwn(envelope.entries, key)) return;
    const entries = { ...envelope.entries };
    delete entries[key];
    if (Object.keys(entries).length === 0) storage.removeItem(TRANSLATION_DRAFT_STORAGE_KEY);
    else storage.setItem(TRANSLATION_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, entries } satisfies TranslationDraftEnvelope));
  } catch {
    // Renderer preferences are best effort.
  }
}

export function createTranslationSourceIdentity(sourceText: string): string {
  // A stable non-reversible identity avoids putting source text in localStorage.
  let hash = 2166136261;
  for (let index = 0; index < sourceText.length; index += 1) {
    hash ^= sourceText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `source-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function scopeKey(scope: Pick<TranslationDraftScope, "projectId" | "lineId">): string {
  return `${scope.projectId}|${scope.lineId}`;
}

function readEnvelope(storage: Storage): TranslationDraftEnvelope | null {
  const serialized = storage.getItem(TRANSLATION_DRAFT_STORAGE_KEY);
  if (!serialized) return { version: 1, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) return null;
  const entries: Record<string, TranslationDraftEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (isValidEntry(value) && key === scopeKey(value)) entries[key] = value;
  }
  return { version: 1, entries };
}

function isValidScope(scope: TranslationDraftScope): boolean {
  return Boolean(
    scope &&
    typeof scope.projectId === "string" && scope.projectId.length > 0 &&
    Number.isInteger(scope.projectRevision) && scope.projectRevision >= 0 &&
    typeof scope.lineId === "string" && scope.lineId.length > 0 &&
    typeof scope.sourceIdentity === "string" && scope.sourceIdentity.length > 0
  );
}

function isValidEntry(value: unknown): value is TranslationDraftEntry {
  return Boolean(
    isRecord(value) &&
    typeof value.projectId === "string" && value.projectId.length > 0 &&
    Number.isInteger(value.projectRevision) && (value.projectRevision as number) >= 0 &&
    typeof value.lineId === "string" && value.lineId.length > 0 &&
    typeof value.sourceIdentity === "string" && value.sourceIdentity.length > 0 &&
    typeof value.text === "string" && value.text.length > 0 &&
    (value.lineStatus === undefined || typeof value.lineStatus === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
