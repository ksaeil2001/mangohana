import { createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type {
  SecretProjectSecurityV1,
  TranslationProjectPersistedV2,
  TranslationProjectV2
} from "../shared/projectTypes.js";
import { normalizeEditableProject, normalizeProject } from "../shared/projectValidation.js";
import {
  artifactKeyFromSecurity,
  createSecretProtection,
  securityFromArtifactKey,
  zeroizeProtection,
  type SecretProjectProtection
} from "./projectProtection.js";
import { replaceProjectFileAtomically } from "./projectSaveTransaction.js";
import { recoverProjectFile } from "./projectRecovery.js";

export type SaveProjectFileArgs = {
  filePath: string;
  project: unknown;
  password?: string;
  protection?: SecretProjectProtection;
  security?: SecretProjectSecurityV1;
  transactionHooks?: {
    afterCandidateValidated?: () => void | Promise<void>;
    beforeFinalRename?: () => void | Promise<void>;
    afterProjectReplaced?: () => void | Promise<void>;
  };
};

export type LoadProjectFileArgs = {
  filePath: string;
  password?: string;
  protection?: SecretProjectProtection;
};

export type LoadedProjectFile = {
  project: TranslationProjectV2;
  encrypted: boolean;
  artifactKeyPersisted: boolean;
  protection?: SecretProjectProtection;
  security?: SecretProjectSecurityV1;
};

export type StoredProjectFileV1 =
  | { format: "ctp-json"; schemaVersion: 1; encrypted: false; payload: unknown }
  | {
      format: "ctp-json";
      schemaVersion: 1;
      encrypted: true;
      kdf: "scrypt";
      salt: string;
      iv: string;
      authTag: string;
      payload: string;
    };

export async function saveProjectFile(args: SaveProjectFileArgs): Promise<void> {
  const project = normalizeEditableProject(args.project);
  let ownedProtection: SecretProjectProtection | undefined;
  let protection = args.protection;
  let security = args.security;

  if (project.metadata.secret) {
    if (!protection) {
      ownedProtection = createSecretProtection(
        requirePassword(args.password),
        security ? artifactKeyFromSecurity(security) : undefined
      );
      protection = ownedProtection;
    }
    security ??= securityFromArtifactKey(protection.artifactMasterKey);
  }

  try {
    await replaceProjectFileAtomically({
      filePath: args.filePath,
      writeCandidate: async (candidatePath) => {
        const file = createStoredProjectFile(project, protection, security);
        await writeFile(candidatePath, JSON.stringify(file, null, 2), "utf8");
      },
      validateFile: async (filePath) => {
        await loadProjectFile({
          filePath,
          password: args.password,
          protection
        });
      },
      afterCandidateValidated:
        args.transactionHooks?.afterCandidateValidated,
      beforeFinalRename: args.transactionHooks?.beforeFinalRename,
      afterProjectReplaced: args.transactionHooks?.afterProjectReplaced
    });
  } finally {
    if (ownedProtection) {
      ownedProtection.containerKey.fill(0);
      ownedProtection.containerSalt.fill(0);
      ownedProtection.artifactMasterKey.fill(0);
      ownedProtection.passwordBytes.fill(0);
    }
  }
}

export async function loadProjectFile(args: LoadProjectFileArgs): Promise<LoadedProjectFile> {
  return loadProjectFileDirect(args);
}

export async function projectFileRequiresPassword(filePath: string): Promise<boolean> {
  const encryptionModes = new Set<boolean>();
  for (const candidatePath of [filePath, `${filePath}.bak`, `${filePath}.candidate`]) {
    try {
      encryptionModes.add(parseStoredProjectFile(await readFile(candidatePath, "utf8")).encrypted);
    } catch {
      // Invalid or absent recovery files are assessed by the recovery validator.
    }
  }
  if (encryptionModes.size > 1) {
    throw new Error("Invalid project recovery state: protection modes do not match");
  }
  return encryptionModes.has(true);
}

export async function loadProjectFileWithRecovery(
  args: LoadProjectFileArgs
): Promise<LoadedProjectFile> {
  const expectedEncrypted = await projectFileRequiresPassword(args.filePath);
  await recoverProjectFile({
    filePath: args.filePath,
    validateFile: async (filePath) => {
      const validated = await loadProjectFileDirect({ ...args, filePath });
      try {
        if (validated.encrypted !== expectedEncrypted) {
          throw new Error("Invalid project recovery state: protection mode changed");
        }
      } finally {
        if (!args.protection && validated.protection) {
          zeroizeProtection(validated.protection);
        }
      }
    }
  });
  return loadProjectFileDirect(args);
}

async function loadProjectFileDirect(args: LoadProjectFileArgs): Promise<LoadedProjectFile> {
  const raw = await readFile(args.filePath, "utf8");
  const parsed = parseStoredProjectFile(raw);

  if (!parsed.encrypted) {
    if (isRecord(parsed.payload) && "security" in parsed.payload) throwInvalidProjectFile();
    const project = normalizeProject(parsed.payload);
    if (project.metadata.secret) {
      throw new Error("Invalid project file: secret payload must be encrypted");
    }
    return {
      project,
      encrypted: false,
      artifactKeyPersisted: true
    };
  }

  const salt = decodeFixedBase64(parsed.salt, 16, "salt");
  const ownsProtection = args.protection === undefined;
  const protection =
    args.protection ??
    createSecretProtection(requirePassword(args.password), undefined, salt);
  try {
    if (!protection.containerSalt.equals(salt)) {
      throw new Error("Unable to decrypt project. Check the password or project file.");
    }
    const payload = decryptProject(parsed, protection.containerKey);
    const { projectPayload, security } = extractSecurity(payload);
    const project = normalizeProject(projectPayload);
    if (!project.metadata.secret) {
      throw new Error("Invalid project file: encrypted payload must be secret");
    }
    const artifactKeyPersisted = security !== undefined;

    if (security) {
      const persistedArtifactKey = artifactKeyFromSecurity(security);
      try {
        if (args.protection && !protection.artifactMasterKey.equals(persistedArtifactKey)) {
          throw new Error("Invalid project file: artifact key mismatch");
        }
        if (!args.protection) {
          protection.artifactMasterKey.fill(0);
          persistedArtifactKey.copy(protection.artifactMasterKey);
        }
      } finally {
        persistedArtifactKey.fill(0);
      }
    }

    return {
      project,
      encrypted: true,
      artifactKeyPersisted,
      protection,
      security
    };
  } catch (error) {
    if (ownsProtection) zeroizeProtection(protection);
    throw error;
  }
}

function createStoredProjectFile(
  project: TranslationProjectV2,
  protection: SecretProjectProtection | undefined,
  security: SecretProjectSecurityV1 | undefined
): StoredProjectFileV1 {
  if (!project.metadata.secret) {
    return { format: "ctp-json", schemaVersion: 1, encrypted: false, payload: project };
  }
  if (!protection || !security) throw new Error("Secret project protection is required");

  const persisted: TranslationProjectPersistedV2 = {
    ...project,
    metadata: { ...project.metadata, secret: true },
    security
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv("aes-256-gcm", protection.containerKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(persisted), "utf8"), cipher.final()]);
  return {
    format: "ctp-json",
    schemaVersion: 1,
    encrypted: true,
    kdf: "scrypt",
    salt: protection.containerSalt.toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    payload: encrypted.toString("base64")
  };
}

function parseStoredProjectFile(raw: string): StoredProjectFileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throwInvalidProjectFile();
  }
  if (!isRecord(parsed) || parsed.format !== "ctp-json" || parsed.schemaVersion !== 1) {
    throwInvalidProjectFile();
  }
  if (typeof parsed.encrypted !== "boolean") throwInvalidProjectFile();
  if (!parsed.encrypted) {
    if (!isRecord(parsed.payload)) throwInvalidProjectFile();
    return { format: "ctp-json", schemaVersion: 1, encrypted: false, payload: parsed.payload };
  }
  if (
    parsed.kdf !== "scrypt" ||
    typeof parsed.salt !== "string" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.authTag !== "string" ||
    typeof parsed.payload !== "string"
  ) {
    throwInvalidProjectFile();
  }
  return {
    format: "ctp-json",
    schemaVersion: 1,
    encrypted: true,
    kdf: "scrypt",
    salt: parsed.salt,
    iv: parsed.iv,
    authTag: parsed.authTag,
    payload: parsed.payload
  };
}

function decryptProject(
  file: Extract<StoredProjectFileV1, { encrypted: true }>,
  containerKey: Buffer
): unknown {
  try {
    const iv = decodeFixedBase64(file.iv, 12, "iv");
    const authTag = decodeFixedBase64(file.authTag, 16, "authTag");
    const payload = Buffer.from(file.payload, "base64");
    const decipher = createDecipheriv("aes-256-gcm", containerKey, iv);
    decipher.setAuthTag(authTag);
    return JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error("Unable to decrypt project. Check the password or project file.");
  }
}

function extractSecurity(payload: unknown): {
  projectPayload: unknown;
  security?: SecretProjectSecurityV1;
} {
  if (!isRecord(payload)) throwInvalidProjectFile();
  const cloned = structuredClone(payload);
  if (!isRecord(cloned)) throwInvalidProjectFile();
  const security = cloned.security;
  delete cloned.security;
  if (security === undefined) return { projectPayload: cloned };
  if (
    !isRecord(security) ||
    security.artifactKeyVersion !== 1 ||
    typeof security.artifactMasterKeyB64 !== "string"
  ) {
    throwInvalidProjectFile();
  }
  return {
    projectPayload: cloned,
    security: {
      artifactKeyVersion: 1,
      artifactMasterKeyB64: security.artifactMasterKeyB64
    }
  };
}

function decodeFixedBase64(value: string, length: number, field: string): Buffer {
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== length) throw new Error(`Invalid project file: malformed ${field}`);
  return buffer;
}

function requirePassword(password: string | undefined): string {
  if (!password) throw new Error("A password is required for secret projects");
  return password;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwInvalidProjectFile(): never {
  throw new Error("Invalid project file");
}
