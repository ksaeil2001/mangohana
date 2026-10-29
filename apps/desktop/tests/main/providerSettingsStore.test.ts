import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProviderSettingsStore } from "../../src/main/providerSettingsStore.js";
import { DEFAULT_PROVIDER_SETTINGS } from "../../src/shared/providerSettings.js";

describe("providerSettingsStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "trio-provider-settings-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns default settings in-memory when no storageFilePath is given", () => {
    const store = createProviderSettingsStore();
    expect(store.getSettings()).toEqual(DEFAULT_PROVIDER_SETTINGS);
  });

  it("persists settings to disk and reloads them upon initialization", async () => {
    const storageFilePath = join(tempDir, "settings", "provider-settings.json");

    const store1 = createProviderSettingsStore({ storageFilePath });
    expect(store1.getSettings().ocrEngine).toBe("gemini");

    store1.updateSettings({
      ocrEngine: "paddle-ocr",
      paddleOcrEndpoint: "http://localhost:5001/ocr",
      translationEngine: "local_ai",
      localAiModel: "qwen2.5:7b-instruct"
    });

    const fileContent = JSON.parse(await readFile(storageFilePath, "utf8"));
    expect(fileContent.ocrEngine).toBe("paddle-ocr");
    expect(fileContent.paddleOcrEndpoint).toBe("http://localhost:5001/ocr");

    // Initialize second store pointing to the same file
    const store2 = createProviderSettingsStore({ storageFilePath });
    const settings = store2.getSettings();
    expect(settings.ocrEngine).toBe("paddle-ocr");
    expect(settings.paddleOcrEndpoint).toBe("http://localhost:5001/ocr");
    expect(settings.translationEngine).toBe("local_ai");
    expect(settings.localAiModel).toBe("qwen2.5:7b-instruct");
  });

  it("gracefully merges initialSettings and disk settings with defaults", () => {
    const storageFilePath = join(tempDir, "non-existing.json");
    const store = createProviderSettingsStore({
      storageFilePath,
      initialSettings: { theme: "dark" }
    });

    expect(store.getSettings().theme).toBe("dark");
    expect(store.getSettings().geminiModel).toBe(DEFAULT_PROVIDER_SETTINGS.geminiModel);
  });

  it("throws an error when disk persistence fails and preserves in-memory state", async () => {
    // tempDir exists as a directory, trying to use it directly as a file path or in an invalid path will fail
    const invalidFilePath = join(tempDir, "directory-conflict");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(invalidFilePath); // create directory with this name
    // Using invalidFilePath as a directory path when writeFileSync expects a file or child causes failure

    const store = createProviderSettingsStore({
      storageFilePath: invalidFilePath, // writing file directly to directory path causes EISDIR
      initialSettings: { theme: "light" }
    });

    expect(() => {
      store.updateSettings({ theme: "dark" });
    }).toThrow("Provider 설정 저장 실패");

    // In-memory state should still be original, not mutated to dark
    expect(store.getSettings().theme).toBe("light");
  });

  it("rejects invalid patch values and throws descriptive validation errors", () => {
    const store = createProviderSettingsStore();

    expect(() => {
      store.updateSettings({ translationEngine: "abc" as any });
    }).toThrow("Invalid provider settings patch: translationEngine must be 'gemini' or 'local_ai'");

    expect(() => {
      store.updateSettings({ ocrEngine: "whatever" as any });
    }).toThrow("Invalid provider settings patch: ocrEngine must be one of");

    expect(() => {
      store.updateSettings({ ocrEngine: "local" as any });
    }).toThrow("Invalid provider settings patch: ocrEngine must be one of");

    // windows-ocr is a valid OcrEngine and must succeed
    expect(() => {
      store.updateSettings({ ocrEngine: "windows-ocr" });
    }).not.toThrow();
    expect(store.getSettings().ocrEngine).toBe("windows-ocr");

    expect(() => {
      store.updateSettings({ localAiEndpoint: 123 as any });
    }).toThrow("Invalid provider settings patch: localAiEndpoint must be a string");

    expect(() => {
      store.updateSettings({ theme: "neon" as any });
    }).toThrow("Invalid provider settings patch: theme must be 'system', 'light', or 'dark'");

    expect(() => {
      store.updateSettings({ smartWrap: "yes" as any });
    }).toThrow("Invalid provider settings patch: smartWrap must be a boolean");

    // Memory remains unchanged after failed validations
    expect(store.getSettings().translationEngine).toBe(DEFAULT_PROVIDER_SETTINGS.translationEngine);
  });
});
