import { createCipheriv, createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  PageChunk,
  PageSummaryIndex,
  ProjectManifest
} from "../shared/projectChunkTypes.js";
import { computeChunkHash } from "../shared/projectChunkAdapter.js";
import {
  artifactKeyFromSecurity,
  createSecretProtection,
  securityFromArtifactKey,
  zeroizeProtection,
  type SecretProjectProtection
} from "./projectProtection.js";

export type SqliteProjectStoreOptions = {
  filePath: string;
  password?: string;
  protection?: SecretProjectProtection;
};

export type SqliteProjectStore = {
  getManifest: () => ProjectManifest;
  loadChunk: (pageNumber: number) => PageChunk | undefined;
  listPageNumbers: () => number[];
  saveIncremental: (
    manifest: ProjectManifest,
    dirtyChunks: PageChunk[],
    allPageNumbers: number[]
  ) => void;
  recordJournal: (entry: {
    projectSessionId: string;
    pageNumber?: number;
    mutationType: string;
    payload: unknown;
    createdAt?: string;
  }) => number;
  getJournalEntries: (projectSessionId?: string) => Array<{
    seq: number;
    projectSessionId: string;
    pageNumber: number | null;
    mutationType: string;
    payload: unknown;
    createdAt: string;
  }>;
  isEncrypted: () => boolean;
  close: () => void;
};

export function createSqliteProjectStore(options: SqliteProjectStoreOptions): SqliteProjectStore {
  const db = new DatabaseSync(options.filePath);

  // Configure high-performance WAL mode and integrity constraints
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_manifest (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      secret INTEGER NOT NULL,
      encrypted INTEGER NOT NULL,
      salt TEXT,
      payload TEXT NOT NULL,
      security TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS page_index (
      page_number INTEGER PRIMARY KEY,
      page_image_id TEXT NOT NULL,
      status TEXT NOT NULL,
      dialogue_count INTEGER NOT NULL DEFAULT 0,
      has_inpainting INTEGER NOT NULL DEFAULT 0,
      has_typesetting INTEGER NOT NULL DEFAULT 0,
      chunk_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS page_chunks (
      page_number INTEGER PRIMARY KEY,
      page_image_id TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      chunk_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mutation_journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_session_id TEXT NOT NULL,
      page_number INTEGER,
      mutation_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  let protection = options.protection;

  function ensureProtection(manifest: ProjectManifest): SecretProjectProtection | undefined {
    if (!manifest.metadata.secret) return undefined;
    if (protection) return protection;

    if (!options.password) {
      throw new Error("A password is required for secret projects");
    }

    const masterKey = manifest.security ? artifactKeyFromSecurity(manifest.security) : undefined;
    protection = createSecretProtection(options.password, masterKey);
    manifest.security ??= securityFromArtifactKey(protection.artifactMasterKey);
    return protection;
  }

  function getManifest(): ProjectManifest {
    const query = db.prepare("SELECT * FROM project_manifest WHERE id = 'manifest'");
    const row = query.get() as
      | {
          title: string;
          secret: number;
          encrypted: number;
          salt: string | null;
          payload: string;
          security: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      throw new Error("Project manifest not found in database");
    }

    if (!row.encrypted) {
      return JSON.parse(row.payload) as ProjectManifest;
    }

    if (!protection) {
      if (!options.password) throw new Error("A password is required for secret projects");
      const secObj = row.security ? JSON.parse(row.security) : undefined;
      const masterKey = secObj ? artifactKeyFromSecurity(secObj) : undefined;
      const salt = row.salt ? Buffer.from(row.salt, "base64") : undefined;
      protection = createSecretProtection(options.password, masterKey, salt);
    }

    const decrypted = decryptJson(row.payload, protection.containerKey);
    return decrypted as ProjectManifest;
  }

  function loadChunk(pageNumber: number): PageChunk | undefined {
    const query = db.prepare("SELECT * FROM page_chunks WHERE page_number = ?");
    const row = query.get(pageNumber) as
      | {
          page_number: number;
          page_image_id: string;
          encrypted: number;
          payload: string;
          chunk_hash: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    if (!row.encrypted) {
      return JSON.parse(row.payload) as PageChunk;
    }

    if (!protection) {
      // Trigger protection initialization via getManifest if not yet done
      getManifest();
    }

    if (!protection) {
      throw new Error("Protection key is required to decrypt chunk");
    }

    return decryptJson(row.payload, protection.containerKey) as PageChunk;
  }

  function listPageNumbers(): number[] {
    const query = db.prepare("SELECT page_number FROM page_index ORDER BY page_number ASC");
    const rows = query.all() as Array<{ page_number: number }>;
    return rows.map((r) => r.page_number);
  }

  function saveIncremental(
    manifest: ProjectManifest,
    dirtyChunks: PageChunk[],
    allPageNumbers: number[]
  ): void {
    const activeProtection = ensureProtection(manifest);
    const isSecret = manifest.metadata.secret;
    const now = new Date().toISOString();

    db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      // 1. Upsert Manifest
      const manifestPayload = isSecret
        ? encryptJson(manifest, activeProtection!.containerKey)
        : JSON.stringify(manifest);

      const upsertManifest = db.prepare(`
        INSERT INTO project_manifest (id, title, secret, encrypted, salt, payload, security, updated_at)
        VALUES ('manifest', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          secret = excluded.secret,
          encrypted = excluded.encrypted,
          salt = excluded.salt,
          payload = excluded.payload,
          security = excluded.security,
          updated_at = excluded.updated_at
      `);

      upsertManifest.run(
        manifest.metadata.title,
        isSecret ? 1 : 0,
        isSecret ? 1 : 0,
        activeProtection?.containerSalt ? activeProtection.containerSalt.toString("base64") : null,
        manifestPayload,
        manifest.security ? JSON.stringify(manifest.security) : null,
        manifest.metadata.updatedAt
      );

      // 2. Synchronize page_index table
      const upsertIndex = db.prepare(`
        INSERT INTO page_index (
          page_number, page_image_id, status, dialogue_count,
          has_inpainting, has_typesetting, chunk_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_number) DO UPDATE SET
          page_image_id = excluded.page_image_id,
          status = excluded.status,
          dialogue_count = excluded.dialogue_count,
          has_inpainting = excluded.has_inpainting,
          has_typesetting = excluded.has_typesetting,
          chunk_hash = excluded.chunk_hash,
          updated_at = excluded.updated_at
      `);

      for (const entry of manifest.pageIndex) {
        upsertIndex.run(
          entry.pageNumber,
          entry.pageImageId,
          entry.status,
          entry.dialogueCount,
          entry.hasInpainting ? 1 : 0,
          entry.hasTypesetting ? 1 : 0,
          entry.chunkHash,
          entry.updatedAt
        );
      }

      // Delete removed pages from page_index and page_chunks
      const validPageSet = new Set(allPageNumbers);
      const existingPages = listPageNumbers();
      const deleteIndex = db.prepare("DELETE FROM page_index WHERE page_number = ?");
      const deleteChunk = db.prepare("DELETE FROM page_chunks WHERE page_number = ?");

      for (const pageNum of existingPages) {
        if (!validPageSet.has(pageNum)) {
          deleteIndex.run(pageNum);
          deleteChunk.run(pageNum);
        }
      }

      // 3. Upsert Dirty Chunks
      const upsertChunk = db.prepare(`
        INSERT INTO page_chunks (
          page_number, page_image_id, encrypted, payload, chunk_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_number) DO UPDATE SET
          page_image_id = excluded.page_image_id,
          encrypted = excluded.encrypted,
          payload = excluded.payload,
          chunk_hash = excluded.chunk_hash,
          updated_at = excluded.updated_at
      `);

      for (const chunk of dirtyChunks) {
        const chunkPayload = isSecret
          ? encryptJson(chunk, activeProtection!.containerKey)
          : JSON.stringify(chunk);

        upsertChunk.run(
          chunk.pageNumber,
          chunk.pageImageId,
          isSecret ? 1 : 0,
          chunkPayload,
          computeChunkHash(chunk),
          now
        );
      }

      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  function recordJournal(entry: {
    projectSessionId: string;
    pageNumber?: number;
    mutationType: string;
    payload: unknown;
    createdAt?: string;
  }): number {
    const insert = db.prepare(`
      INSERT INTO mutation_journal (project_session_id, page_number, mutation_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      entry.projectSessionId,
      entry.pageNumber ?? null,
      entry.mutationType,
      JSON.stringify(entry.payload),
      entry.createdAt ?? new Date().toISOString()
    );

    return Number(result.lastInsertRowid);
  }

  function getJournalEntries(projectSessionId?: string) {
    const query = projectSessionId
      ? db.prepare("SELECT * FROM mutation_journal WHERE project_session_id = ? ORDER BY seq ASC")
      : db.prepare("SELECT * FROM mutation_journal ORDER BY seq ASC");

    const rows = (projectSessionId ? query.all(projectSessionId) : query.all()) as Array<{
      seq: number;
      project_session_id: string;
      page_number: number | null;
      mutation_type: string;
      payload: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      seq: r.seq,
      projectSessionId: r.project_session_id,
      pageNumber: r.page_number,
      mutationType: r.mutation_type,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at
    }));
  }

  function isEncrypted(): boolean {
    const query = db.prepare("SELECT encrypted FROM project_manifest WHERE id = 'manifest'");
    const row = query.get() as { encrypted: number } | undefined;
    return Boolean(row?.encrypted);
  }

  function close(): void {
    try {
      db.close();
    } catch {
      // Ignored
    }
  }

  return {
    getManifest,
    loadChunk,
    listPageNumbers,
    saveIncremental,
    recordJournal,
    getJournalEntries,
    isEncrypted,
    close
  };
}

function encryptJson(value: unknown, containerKey: Buffer): string {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv("aes-256-gcm", containerKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const envelope = {
    iv: Buffer.from(iv).toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    payload: encrypted.toString("base64")
  };
  return JSON.stringify(envelope);
}

function decryptJson(rawEnvelope: string, containerKey: Buffer): unknown {
  try {
    const envelope = JSON.parse(rawEnvelope) as { iv: string; authTag: string; payload: string };
    const iv = Buffer.from(envelope.iv, "base64");
    const authTag = Buffer.from(envelope.authTag, "base64");
    const payload = Buffer.from(envelope.payload, "base64");
    const decipher = createDecipheriv("aes-256-gcm", containerKey, iv);
    decipher.setAuthTag(authTag);
    return JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("Unable to decrypt SQLite project payload");
  }
}
