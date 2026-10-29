import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GeminiApiKeyStatus } from "../shared/geminiApiKey.js";

export type EncryptionAdapter = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type KeyFileOps = {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

export type GeminiApiKeyStore = {
  initialize(): Promise<GeminiApiKeyStatus>;
  getStatus(): GeminiApiKeyStatus;
  set(apiKey: string): Promise<GeminiApiKeyStatus>;
  clear(): Promise<GeminiApiKeyStatus>;
};

const defaultFileOps: KeyFileOps = { mkdir, readFile, rename, rm, writeFile };

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function createGeminiApiKeyStore(deps: {
  encryption: EncryptionAdapter;
  filePath: string;
  env: NodeJS.ProcessEnv;
  fileOps?: KeyFileOps;
}): GeminiApiKeyStore {
  const fileOps = deps.fileOps ?? defaultFileOps;
  const startupEnvironmentKey = deps.env.GEMINI_API_KEY?.trim() || undefined;
  let status: GeminiApiKeyStatus = {
    configured: false,
    source: "none",
    persistence: "encrypted",
    requiresReentry: false
  };

  function updateStatus(nextStatus: GeminiApiKeyStatus): GeminiApiKeyStatus {
    status = nextStatus;
    return { ...status };
  }

  function environmentStatus(): GeminiApiKeyStatus {
    return {
      configured: true,
      source: "environment",
      persistence: deps.encryption.isEncryptionAvailable() ? "encrypted" : "unavailable",
      requiresReentry: false
    };
  }

  let mutationGeneration = 0;
  let operationTail: Promise<void> | undefined;

  function completeStatus(
    generation: number,
    nextStatus: GeminiApiKeyStatus
  ): GeminiApiKeyStatus {
    return generation === mutationGeneration ? updateStatus(nextStatus) : { ...status };
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail ? operationTail.then(operation) : operation();
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    operationTail = settled;
    void settled.then(() => {
      if (operationTail === settled) {
        operationTail = undefined;
      }
    });
    return result;
  }

  return {
    async initialize() {
      const generation = ++mutationGeneration;
      return serialize(async () => {
        if (startupEnvironmentKey) {
          return completeStatus(generation, environmentStatus());
        }

        if (!deps.encryption.isEncryptionAvailable()) {
          return completeStatus(generation, {
            configured: false,
            source: "none",
            persistence: "unavailable",
            requiresReentry: false
          });
        }

        try {
          const encrypted = await fileOps.readFile(deps.filePath);
          const apiKey = deps.encryption.decryptString(encrypted).trim();
          if (!apiKey) {
            throw new Error("Invalid encrypted key");
          }
          if (generation === mutationGeneration) {
            deps.env.GEMINI_API_KEY = apiKey;
          }
          return completeStatus(generation, {
            configured: true,
            source: "encrypted",
            persistence: "encrypted",
            requiresReentry: false
          });
        } catch (error) {
          if (isMissingFile(error)) {
            return completeStatus(generation, {
              configured: false,
              source: "none",
              persistence: "encrypted",
              requiresReentry: false
            });
          }

          try {
            await fileOps.rm(deps.filePath, { force: true });
          } catch {
            // A storage failure must not expose the path or underlying error.
          }
          return completeStatus(generation, {
            configured: false,
            source: "none",
            persistence: "encrypted",
            requiresReentry: true
          });
        }
      });
    },

    getStatus() {
      return { ...status };
    },

    async set(apiKey: string) {
      const normalizedKey = apiKey.trim();
      const generation = ++mutationGeneration;
      const encryptionAvailable = deps.encryption.isEncryptionAvailable();
      const activeStatus: GeminiApiKeyStatus = {
        configured: true,
        source: "session",
        persistence: encryptionAvailable ? "session-only" : "unavailable",
        requiresReentry: false
      };
      deps.env.GEMINI_API_KEY = normalizedKey;
      updateStatus(activeStatus);

      return serialize(async () => {
        if (!encryptionAvailable) {
          return completeStatus(generation, activeStatus);
        }

        const temporaryPath = `${deps.filePath}.${randomUUID()}.tmp`;
        try {
          const encrypted = deps.encryption.encryptString(normalizedKey);
          await fileOps.mkdir(dirname(deps.filePath), { recursive: true });
          await fileOps.writeFile(temporaryPath, encrypted);
          await fileOps.rename(temporaryPath, deps.filePath);

          return completeStatus(generation, {
            configured: true,
            source: "encrypted",
            persistence: "encrypted",
            requiresReentry: false
          });
        } catch {
          return completeStatus(generation, {
            configured: true,
            source: "session",
            persistence: "session-only",
            requiresReentry: false
          });
        } finally {
          try {
            await fileOps.rm(temporaryPath, { force: true });
          } catch {
            // Temporary file cleanup is best effort.
          }
        }
      });
    },

    async clear() {
      const generation = mutationGeneration;
      return serialize(async () => {
        try {
          await fileOps.rm(deps.filePath, { force: true });
        } catch {
          throw new Error("저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요");
        }

        if (generation !== mutationGeneration) {
          return { ...status };
        }

        if (startupEnvironmentKey) {
          deps.env.GEMINI_API_KEY = startupEnvironmentKey;
          return updateStatus(environmentStatus());
        }

        delete deps.env.GEMINI_API_KEY;
        return updateStatus({
          configured: false,
          source: "none",
          persistence: deps.encryption.isEncryptionAvailable() ? "encrypted" : "unavailable",
          requiresReentry: false
        });
      });
    }
  };
}
