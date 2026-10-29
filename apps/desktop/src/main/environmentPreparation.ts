import { isAbsolute, resolve } from "node:path";
import {
  createInitialEnvironmentSnapshot,
  type EnvironmentPreparationSnapshot
} from "../shared/environmentPreparation.js";

export type EnvironmentPreparationService = Readonly<{
  getSnapshot: () => Promise<EnvironmentPreparationSnapshot> | EnvironmentPreparationSnapshot;
  setResourceRoot: (resourceRoot: string) => Promise<EnvironmentPreparationSnapshot> | EnvironmentPreparationSnapshot;
}>;

export type ProviderStatusReport = {
  ocrReady?: boolean;
  translationReady?: boolean;
  inpaintingReady?: boolean;
  ocrMessage?: string;
  translationMessage?: string;
  inpaintingMessage?: string;
  ocrDisabledReason?: string;
  translationDisabledReason?: string;
  inpaintingDisabledReason?: string;
};

export type EnvironmentPreparationServiceOptions = Readonly<{
  resourceRoot: string;
  appVersion: string;
  isProviderConfigured?: () => boolean;
  getProviderStatus?: () => Promise<ProviderStatusReport> | ProviderStatusReport;
}>;

export function createEnvironmentPreparationService(
  options: EnvironmentPreparationServiceOptions
): EnvironmentPreparationService {
  let resourceRoot = normalizeAbsolutePath(options.resourceRoot);

  async function getSnapshotOptions() {
    if (options.getProviderStatus) {
      return await options.getProviderStatus();
    }
    return {
      isProviderConfigured: options.isProviderConfigured ? options.isProviderConfigured() : false
    };
  }

  return {
    getSnapshot: async () =>
      createInitialEnvironmentSnapshot(resourceRoot, options.appVersion, await getSnapshotOptions()),
    setResourceRoot: async (nextResourceRoot) => {
      resourceRoot = normalizeAbsolutePath(nextResourceRoot);
      return createInitialEnvironmentSnapshot(resourceRoot, options.appVersion, await getSnapshotOptions());
    }
  };
}

export function resolveDefaultEnvironmentResourceRoot(args: {
  localAppData?: string;
  fallbackRoot?: string;
}): string {
  const baseRoot = args.localAppData?.trim() || args.fallbackRoot?.trim();
  if (!baseRoot) {
    throw new Error("A local application data root is required");
  }
  return normalizeAbsolutePath(resolve(baseRoot, "Trio", "resources"));
}

function normalizeAbsolutePath(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    throw new Error("Environment resource root must be an absolute path");
  }
  return resolve(value);
}
