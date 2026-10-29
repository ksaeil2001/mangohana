import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_PROVIDER_SETTINGS,
  type ProviderSettings,
  validateProviderSettingsPatch
} from "../shared/providerSettings.js";

export type ProviderSettingsStore = {
  getSettings: () => ProviderSettings;
  updateSettings: (patch: Partial<ProviderSettings>) => ProviderSettings;
};

export type CreateProviderSettingsStoreOptions = {
  initialSettings?: Partial<ProviderSettings>;
  storageFilePath?: string;
};

export function createProviderSettingsStore(
  optionsOrInitial: CreateProviderSettingsStoreOptions | Partial<ProviderSettings> = {}
): ProviderSettingsStore {
  const isOptionsObject =
    optionsOrInitial &&
    typeof optionsOrInitial === "object" &&
    ("storageFilePath" in optionsOrInitial || "initialSettings" in optionsOrInitial);

  const initialSettings = isOptionsObject
    ? (optionsOrInitial as CreateProviderSettingsStoreOptions).initialSettings ?? {}
    : (optionsOrInitial as Partial<ProviderSettings>);

  const storageFilePath = isOptionsObject
    ? (optionsOrInitial as CreateProviderSettingsStoreOptions).storageFilePath
    : undefined;

  let loadedDiskSettings: Partial<ProviderSettings> = {};
  if (storageFilePath) {
    try {
      const raw = readFileSync(storageFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        try {
          loadedDiskSettings = validateProviderSettingsPatch(parsed);
        } catch {
          // In case of invalid disk settings, fallback gracefully
        }
      }
    } catch {
      // File does not exist yet or is invalid, fallback to defaults
    }
  }

  let currentSettings: ProviderSettings = {
    ...DEFAULT_PROVIDER_SETTINGS,
    ...loadedDiskSettings,
    ...initialSettings
  };

  function persist(settingsToPersist: ProviderSettings): void {
    if (!storageFilePath) return;
    const dir = dirname(storageFilePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${storageFilePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(settingsToPersist, null, 2), "utf8");
      renameSync(tmpPath, storageFilePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore tmp cleanup error
      }
      throw new Error(`Provider 설정 저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    getSettings(): ProviderSettings {
      return { ...currentSettings };
    },
    updateSettings(patch: Partial<ProviderSettings>): ProviderSettings {
      const validatedPatch = validateProviderSettingsPatch(patch);
      const nextSettings: ProviderSettings = {
        ...currentSettings,
        ...validatedPatch
      };
      persist(nextSettings);
      currentSettings = nextSettings;
      return { ...currentSettings };
    }
  };
}
