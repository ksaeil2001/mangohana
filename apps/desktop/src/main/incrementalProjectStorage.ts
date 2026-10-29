import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageChunk, ProjectManifest } from "../shared/projectChunkTypes.js";
import {
  artifactKeyFromSecurity,
  createSecretProtection,
  securityFromArtifactKey,
  zeroizeProtection,
  type SecretProjectProtection
} from "./projectProtection.js";
import { replaceProjectFileAtomically } from "./projectSaveTransaction.js";

export type StoredManifestWrapper =
  | { format: "ctp-manifest"; schemaVersion: 2; encrypted: false; payload: ProjectManifest }
  | {
      format: "ctp-manifest";
      schemaVersion: 2;
      encrypted: true;
      kdf: "scrypt";
      salt: string;
      iv: string;
      authTag: string;
      payload: string;
    };

export type StoredChunkWrapper =
  | { format: "ctp-chunk"; pageNumber: number; encrypted: false; payload: PageChunk }
  | {
      format: "ctp-chunk";
      pageNumber: number;
      encrypted: true;
      kdf: "scrypt";
      salt: string;
      iv: string;
      authTag: string;
      payload: string;
    };

export type SaveIncrementalProjectArgs = {
  targetDirectory: string;
  manifest: ProjectManifest;
  dirtyChunks: PageChunk[];
  allPageNumbers: number[];
  password?: string;
  protection?: SecretProjectProtection;
};

export type LoadIncrementalProjectArgs = {
  targetDirectory: string;
  password?: string;
  protection?: SecretProjectProtection;
};

export type LoadedIncrementalProject = {
  manifest: ProjectManifest;
  encrypted: boolean;
  protection?: SecretProjectProtection;
  chunkLoader: (pageNumber: number) => Promise<PageChunk | undefined>;
  listAvailablePageNumbers: () => Promise<number[]>;
};

export async function saveIncrementalProject(args: SaveIncrementalProjectArgs): Promise<void> {
  const { targetDirectory, manifest, dirtyChunks, allPageNumbers } = args;
  const isSecret = manifest.metadata.secret;

  let ownedProtection: SecretProjectProtection | undefined;
  let protection = args.protection;

  if (isSecret) {
    if (!protection) {
      if (!args.password) throw new Error("A password is required for secret projects");
      ownedProtection = createSecretProtection(
        args.password,
        manifest.security ? artifactKeyFromSecurity(manifest.security) : undefined
      );
      protection = ownedProtection;
    }
    manifest.security ??= securityFromArtifactKey(protection.artifactMasterKey);
  }

  try {
    const chunksDir = join(targetDirectory, "chunks");
    await mkdir(chunksDir, { recursive: true });

    // 1. Atomically save manifest
    const manifestPath = join(targetDirectory, "manifest.ctp-manifest");
    await replaceProjectFileAtomically({
      filePath: manifestPath,
      writeCandidate: async (candidatePath) => {
        const wrapper = createStoredManifestWrapper(manifest, protection);
        await writeFile(candidatePath, JSON.stringify(wrapper, null, 2), "utf8");
      },
      validateFile: async (filePath) => {
        const raw = await readFile(filePath, "utf8");
        parseStoredManifestWrapper(raw);
      }
    });

    // 2. Atomically save dirty chunks
    for (const chunk of dirtyChunks) {
      const chunkPath = join(chunksDir, `page_${chunk.pageNumber}.chunk`);
      await replaceProjectFileAtomically({
        filePath: chunkPath,
        writeCandidate: async (candidatePath) => {
          const wrapper = createStoredChunkWrapper(chunk, protection);
          await writeFile(candidatePath, JSON.stringify(wrapper, null, 2), "utf8");
        },
        validateFile: async (filePath) => {
          const raw = await readFile(filePath, "utf8");
          parseStoredChunkWrapper(raw);
        }
      });
    }

    // 3. Clean up removed chunks
    const validPageSet = new Set(allPageNumbers);
    try {
      const existingFiles = await readdir(chunksDir);
      for (const file of existingFiles) {
        const match = /^page_(\d+)\.chunk$/.exec(file);
        if (match && match[1]) {
          const pageNum = Number.parseInt(match[1], 10);
          if (!validPageSet.has(pageNum)) {
            await rm(join(chunksDir, file), { force: true });
          }
        }
      }
    } catch {
      // Ignored if chunks dir read fails
    }
  } finally {
    if (ownedProtection) {
      zeroizeProtection(ownedProtection);
    }
  }
}

export async function loadIncrementalProject(
  args: LoadIncrementalProjectArgs
): Promise<LoadedIncrementalProject> {
  const { targetDirectory } = args;
  const manifestPath = join(targetDirectory, "manifest.ctp-manifest");
  const rawManifest = await readFile(manifestPath, "utf8");
  const parsedManifest = parseStoredManifestWrapper(rawManifest);

  let protection = args.protection;
  let ownsProtection = false;
  let manifest: ProjectManifest;

  if (!parsedManifest.encrypted) {
    manifest = parsedManifest.payload;
  } else {
    const salt = Buffer.from(parsedManifest.salt, "base64");
    if (!protection) {
      if (!args.password) throw new Error("A password is required for secret projects");
      protection = createSecretProtection(args.password, undefined, salt);
      ownsProtection = true;
    }
    const decryptedPayload = decryptPayload(parsedManifest, protection.containerKey);
    manifest = decryptedPayload as ProjectManifest;
  }

  const chunksDir = join(targetDirectory, "chunks");

  async function chunkLoader(pageNumber: number): Promise<PageChunk | undefined> {
    const chunkPath = join(chunksDir, `page_${pageNumber}.chunk`);
    let rawChunk: string;
    try {
      rawChunk = await readFile(chunkPath, "utf8");
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }

    const parsedChunk = parseStoredChunkWrapper(rawChunk);
    if (!parsedChunk.encrypted) {
      return parsedChunk.payload;
    }

    if (!protection) {
      throw new Error("Protection key is required to decrypt chunk");
    }

    return decryptPayload(parsedChunk, protection.containerKey) as PageChunk;
  }

  async function listAvailablePageNumbers(): Promise<number[]> {
    try {
      const files = await readdir(chunksDir);
      const pageNumbers: number[] = [];
      for (const file of files) {
        const match = /^page_(\d+)\.chunk$/.exec(file);
        if (match && match[1]) {
          pageNumbers.push(Number.parseInt(match[1], 10));
        }
      }
      return pageNumbers.sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  return {
    manifest,
    encrypted: parsedManifest.encrypted,
    protection: ownsProtection ? undefined : protection,
    chunkLoader,
    listAvailablePageNumbers
  };
}

function createStoredManifestWrapper(
  manifest: ProjectManifest,
  protection?: SecretProjectProtection
): StoredManifestWrapper {
  if (!manifest.metadata.secret) {
    return { format: "ctp-manifest", schemaVersion: 2, encrypted: false, payload: manifest };
  }
  if (!protection) throw new Error("Protection is required for secret project manifest");

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv("aes-256-gcm", protection.containerKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(manifest), "utf8"), cipher.final()]);

  return {
    format: "ctp-manifest",
    schemaVersion: 2,
    encrypted: true,
    kdf: "scrypt",
    salt: protection.containerSalt.toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    payload: encrypted.toString("base64")
  };
}

function createStoredChunkWrapper(
  chunk: PageChunk,
  protection?: SecretProjectProtection
): StoredChunkWrapper {
  if (!protection) {
    return { format: "ctp-chunk", pageNumber: chunk.pageNumber, encrypted: false, payload: chunk };
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv("aes-256-gcm", protection.containerKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(chunk), "utf8"), cipher.final()]);

  return {
    format: "ctp-chunk",
    pageNumber: chunk.pageNumber,
    encrypted: true,
    kdf: "scrypt",
    salt: protection.containerSalt.toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    payload: encrypted.toString("base64")
  };
}

function parseStoredManifestWrapper(raw: string): StoredManifestWrapper {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid project manifest: malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid manifest");
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== "ctp-manifest" || obj.schemaVersion !== 2) {
    throw new Error("Invalid project manifest format");
  }
  return parsed as StoredManifestWrapper;
}

function parseStoredChunkWrapper(raw: string): StoredChunkWrapper {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid chunk file: malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid chunk");
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== "ctp-chunk" || typeof obj.pageNumber !== "number") {
    throw new Error("Invalid chunk file format");
  }
  return parsed as StoredChunkWrapper;
}

function decryptPayload(
  wrapper: { iv: string; authTag: string; payload: string },
  containerKey: Buffer
): unknown {
  try {
    const iv = Buffer.from(wrapper.iv, "base64");
    const authTag = Buffer.from(wrapper.authTag, "base64");
    const payload = Buffer.from(wrapper.payload, "base64");
    const decipher = createDecipheriv("aes-256-gcm", containerKey, iv);
    decipher.setAuthTag(authTag);
    return JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("Unable to decrypt project chunk. Check password or file integrity.");
  }
}
