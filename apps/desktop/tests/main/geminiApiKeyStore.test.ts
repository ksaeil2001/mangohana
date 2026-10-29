import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createGeminiApiKeyStore,
  type EncryptionAdapter,
  type KeyFileOps
} from "../../src/main/geminiApiKeyStore.js";

const defaultFileOps: KeyFileOps = { mkdir, readFile, rename, rm, writeFile };
let tempDir: string;
let keyPath: string;
let env: NodeJS.ProcessEnv;
let encryptedPlainText: string;
let encryption: {
  isEncryptionAvailable: ReturnType<typeof vi.fn>;
  encryptString: ReturnType<typeof vi.fn>;
  decryptString: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "gemini-key-store-"));
  keyPath = join(tempDir, "settings", "gemini-api-key.enc");
  env = {};
  encryptedPlainText = "";
  encryption = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plainText: string) => {
      encryptedPlainText = plainText;
      return Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    }),
    decryptString: vi.fn(() => encryptedPlainText)
  };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function createStore(fileOpsOverrides: Partial<KeyFileOps> = {}) {
  return createGeminiApiKeyStore({
    encryption: encryption as EncryptionAdapter,
    filePath: keyPath,
    env,
    fileOps: { ...defaultFileOps, ...fileOpsOverrides }
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

it("writes only encrypted bytes and restores the key in a new store", async () => {
  const first = createStore();
  await first.initialize();
  expect(await first.set("test-secret-key")).toMatchObject({
    source: "encrypted",
    persistence: "encrypted"
  });
  expect((await readFile(keyPath)).includes(Buffer.from("test-secret-key"))).toBe(false);

  delete env.GEMINI_API_KEY;
  const restarted = createStore();
  expect(await restarted.initialize()).toMatchObject({ source: "encrypted" });
  expect(env.GEMINI_API_KEY).toBe("test-secret-key");
});

it("prefers but never persists an existing environment key", async () => {
  env.GEMINI_API_KEY = "environment-secret";
  const status = await createStore().initialize();
  expect(status).toMatchObject({ configured: true, source: "environment" });
  await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps an entered key session-only when encryption is unavailable", async () => {
  encryption.isEncryptionAvailable.mockReturnValue(false);
  const store = createStore();
  await store.initialize();
  expect(await store.set("session-secret")).toEqual({
    configured: true,
    source: "session",
    persistence: "unavailable",
    requiresReentry: false
  });
  await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes corrupt ciphertext and requires re-entry without applying it", async () => {
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, Buffer.from([1, 2, 3]));
  encryption.decryptString.mockImplementation(() => { throw new Error("sensitive internal failure"); });
  const status = await createStore().initialize();
  expect(status).toEqual({
    configured: false,
    source: "none",
    persistence: "encrypted",
    requiresReentry: true
  });
  expect(env.GEMINI_API_KEY).toBeUndefined();
  await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not report deletion success when removing ciphertext fails", async () => {
  const store = createStore({ rm: vi.fn().mockRejectedValue(new Error("private path")) });
  await store.initialize();
  await store.set("test-secret-key");
  await expect(store.clear()).rejects.toThrow("저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요");
  expect(store.getStatus().configured).toBe(true);
  expect(env.GEMINI_API_KEY).toBe("test-secret-key");
});

it("keeps the key session-only when encrypted file writing fails", async () => {
  const store = createStore({
    writeFile: vi.fn().mockRejectedValue(new Error("internal write failure"))
  });
  await store.initialize();
  expect(await store.set("test-secret-key")).toEqual({
    configured: true,
    source: "session",
    persistence: "session-only",
    requiresReentry: false
  });
  expect(env.GEMINI_API_KEY).toBe("test-secret-key");
});

it("does not restore a successfully cleared encrypted key", async () => {
  const store = createStore();
  await store.initialize();
  await store.set("test-secret-key");
  expect(await store.clear()).toMatchObject({ configured: false, source: "none" });
  const restarted = createStore();
  expect(await restarted.initialize()).toMatchObject({ configured: false, source: "none" });
});

it("does not expose secrets or storage details in status and public errors", async () => {
  const store = createStore({
    rm: vi.fn().mockRejectedValue(new Error(`internal ${keyPath} test-secret-key`))
  });
  await store.initialize();
  await store.set("test-secret-key");
  const serializedStatus = JSON.stringify(store.getStatus());
  expect(serializedStatus).not.toContain("test-secret-key");
  expect(serializedStatus).not.toContain(keyPath);
  await expect(store.clear()).rejects.toThrow(
    "저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요"
  );
});

it("serializes overlapping key updates so the latest key is restored", async () => {
  const releaseFirstRename = deferred();
  const firstRenameStarted = deferred();
  let renameCount = 0;
  encryption.encryptString.mockImplementation((plainText: string) =>
    Buffer.from(plainText === "first-key" ? [1] : [2])
  );
  encryption.decryptString.mockImplementation((encrypted: Buffer) =>
    encrypted.equals(Buffer.from([1])) ? "first-key" : "second-key"
  );
  const store = createStore({
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      renameCount += 1;
      if (renameCount === 1) {
        firstRenameStarted.resolve();
        await releaseFirstRename.promise;
      }
      await rename(oldPath, newPath);
    }) as KeyFileOps["rename"]
  });
  await store.initialize();

  const firstSet = store.set("first-key");
  await firstRenameStarted.promise;
  const secondSet = store.set("second-key");
  expect(env.GEMINI_API_KEY).toBe("second-key");
  await Promise.race([secondSet, new Promise((resolve) => setTimeout(resolve, 50))]);
  releaseFirstRename.resolve();
  await Promise.all([firstSet, secondSet]);

  delete env.GEMINI_API_KEY;
  const restarted = createStore();
  await restarted.initialize();
  expect(env.GEMINI_API_KEY).toBe("second-key");
});

it("serializes an overlapping clear so an in-flight save cannot revive ciphertext", async () => {
  const releaseRename = deferred();
  const renameStarted = deferred();
  const store = createStore({
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      renameStarted.resolve();
      await releaseRename.promise;
      await rename(oldPath, newPath);
    }) as KeyFileOps["rename"]
  });
  await store.initialize();

  const setKey = store.set("test-secret-key");
  await renameStarted.promise;
  const clearKey = store.clear();
  await Promise.race([clearKey, new Promise((resolve) => setTimeout(resolve, 50))]);
  releaseRename.resolve();
  await Promise.all([setKey, clearKey]);

  expect(store.getStatus()).toMatchObject({ configured: false, source: "none" });
  expect(env.GEMINI_API_KEY).toBeUndefined();
  await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not let a waiting clear remove a newer runtime key", async () => {
  const releaseClear = deferred();
  const clearStarted = deferred();
  const store = createStore({
    rm: vi.fn(async (path: Parameters<KeyFileOps["rm"]>[0], options) => {
      if (path === keyPath) {
        clearStarted.resolve();
        await releaseClear.promise;
      }
      await rm(path, options);
    }) as KeyFileOps["rm"]
  });
  await store.initialize();
  await store.set("old-key");

  const clearKey = store.clear();
  await clearStarted.promise;
  const setKey = store.set("new-key");
  expect(env.GEMINI_API_KEY).toBe("new-key");
  releaseClear.resolve();
  await Promise.all([clearKey, setKey]);

  expect(env.GEMINI_API_KEY).toBe("new-key");
  expect(store.getStatus()).toMatchObject({ configured: true, source: "encrypted" });
});

it("retains encrypted status when a queued clear fails after the save succeeds", async () => {
  const releaseRename = deferred();
  const renameStarted = deferred();
  const store = createStore({
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      renameStarted.resolve();
      await releaseRename.promise;
      await rename(oldPath, newPath);
    }) as KeyFileOps["rename"],
    rm: vi.fn(async (path: Parameters<KeyFileOps["rm"]>[0], options) => {
      if (path === keyPath) {
        throw new Error("private path");
      }
      await rm(path, options);
    }) as KeyFileOps["rm"]
  });
  await store.initialize();

  const setKey = store.set("test-secret-key");
  await renameStarted.promise;
  const clearKey = store.clear();
  releaseRename.resolve();
  await setKey;
  await expect(clearKey).rejects.toThrow("저장된 키를 삭제하지 못했습니다. 다시 시도해 주세요");

  expect(store.getStatus()).toEqual({
    configured: true,
    source: "encrypted",
    persistence: "encrypted",
    requiresReentry: false
  });
  expect(env.GEMINI_API_KEY).toBe("test-secret-key");
});
