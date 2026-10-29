import { shell } from "electron";
import { createRequire } from "node:module";
import {
  createAutoUpdateState,
  type AutoUpdateState,
  type AutoUpdateStatus
} from "../shared/autoUpdateStatus.js";

const require = createRequire(import.meta.url);

export type ReleaseChannel = "stable" | "preview" | "dev" | "transition";

/**
 * Immutable, Main-owned feed for the one-time v0.1.3 -> v0.1.4 transition QA.
 * It is deliberately not the stable release pointer and is never renderer-controlled.
 */
export const TRIO_TRANSITION_QA_FEED_URL =
  "https://github.com/ksaeil2001/trio-releases/releases/download/v0.1.4-preview.1/";

export type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  setFeedURL: (feedUrl: string) => void;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (value?: unknown) => void) => unknown;
};

export type AutoUpdaterOptions = {
  isPackaged: boolean;
  isSmokeTest: boolean;
  releaseChannel: ReleaseChannel;
  platform: NodeJS.Platform;
  updater?: AutoUpdaterLike;
  shellApi?: Pick<typeof shell, "openExternal">;
  onStateChange?: (state: AutoUpdateState) => void;
  logger?: Pick<Console, "info" | "warn">;
};

export type AutoUpdateController = Readonly<{
  getState: () => AutoUpdateState;
  start: () => boolean;
  checkForUpdates: () => Promise<AutoUpdateState>;
  downloadUpdate: () => Promise<AutoUpdateState>;
  installUpdate: () => AutoUpdateState;
  openRelease: () => Promise<void>;
}>;

/**
 * Derive the updater channel from the version embedded in the packaged app.
 * Unknown or malformed versions deliberately fall back to the development
 * channel so they cannot opt into a public stable or transition feed.
 */
export function deriveReleaseChannel(version: string): ReleaseChannel {
  if (/^\d+\.\d+\.\d+$/.test(version)) return "stable";

  const prereleaseMatch = /^(\d+\.\d+\.\d+)-(preview|dev|transition)\.\d+$/.exec(version);
  if (prereleaseMatch) return prereleaseMatch[2] as Exclude<ReleaseChannel, "stable">;

  return "dev";
}

/**
 * GitHub Release-backed updater for signed Windows and macOS builds.
 * Linux remains manual-download-only, and development/package smoke-test processes
 * intentionally never contact a release provider.
 */
export function createAutoUpdateController({
  isPackaged,
  isSmokeTest,
  releaseChannel,
  platform,
  updater,
  shellApi = shell,
  onStateChange,
  logger = console
}: AutoUpdaterOptions): AutoUpdateController {
  const resolvedUpdater = updater ?? loadAutoUpdater();
  const updatesAvailable = isPackaged
    && !isSmokeTest
    && process.env.TRIO_DISABLE_AUTO_UPDATE !== "true"
    && (platform === "win32" || platform === "darwin")
    && (releaseChannel === "stable" || releaseChannel === "transition");
  if (updatesAvailable) {
    resolvedUpdater.allowPrerelease = releaseChannel === "transition";
    if (releaseChannel === "transition") {
      resolvedUpdater.setFeedURL(TRIO_TRANSITION_QA_FEED_URL);
    }
  }
  let state = updatesAvailable
    ? createAutoUpdateState("idle")
    : createAutoUpdateState("unavailable", {
        message: "업데이트 확인은 설치된 망고하나 앱에서 사용할 수 있습니다."
      });

  const setState = (status: AutoUpdateStatus, overrides: Partial<Omit<AutoUpdateState, "status" | "releaseUrl">> = {}) => {
    state = createAutoUpdateState(status, { checkedAt: new Date().toISOString(), ...overrides });
    onStateChange?.(state);
    return state;
  };

  const checkForUpdates = async () => {
    if (!updatesAvailable) return state;
    setState("checking", { message: "최신 버전을 확인하고 있습니다." });
    try {
      await resolvedUpdater.checkForUpdates();
    } catch (error) {
      logger.warn(`Auto-update check failed: ${getErrorMessage(error)}`);
      setState("error", {
        message: "업데이트를 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요."
      });
    }
    return state;
  };

  const downloadUpdate = async () => {
    if (!updatesAvailable || state.status !== "available") return state;
    setState("downloading", {
      availableVersion: state.availableVersion,
      progress: 0,
      message: "업데이트를 다운로드하고 있습니다."
    });
    try {
      await resolvedUpdater.downloadUpdate();
    } catch (error) {
      logger.warn(`Auto-update download failed: ${getErrorMessage(error)}`);
      setState("error", {
        availableVersion: state.availableVersion,
        message: "업데이트를 다운로드하지 못했습니다. 잠시 후 다시 시도하세요."
      });
    }
    return state;
  };

  const installUpdate = () => {
    if (updatesAvailable && state.status === "ready-to-install") resolvedUpdater.quitAndInstall(false, true);
    return state;
  };

  const openRelease = async () => {
    await shellApi.openExternal(state.releaseUrl);
  };

  const start = () => {
    if (!updatesAvailable) return false;

    resolvedUpdater.autoDownload = false;
    resolvedUpdater.autoInstallOnAppQuit = false;

    resolvedUpdater.on("checking-for-update", () => {
      setState("checking", { message: "최신 버전을 확인하고 있습니다." });
    });
    resolvedUpdater.on("update-available", (info) => {
      const version = readVersion(info);
      setState("available", {
        availableVersion: version,
        message: `Trio ${version ?? "새"} 업데이트를 다운로드할 수 있습니다.`
      });
    });
    resolvedUpdater.on("update-not-available", () => {
      setState("up-to-date", { message: "현재 사용 중인 Trio가 최신 버전입니다." });
    });
    resolvedUpdater.on("download-progress", (progress) => {
      const percent = readProgress(progress);
      setState("downloading", {
        availableVersion: state.availableVersion,
        progress: percent,
        message: `업데이트를 다운로드하고 있습니다. ${percent}% 완료`
      });
    });
    resolvedUpdater.on("update-downloaded", (info) => {
      const version = readVersion(info) ?? state.availableVersion;
      setState("ready-to-install", {
        availableVersion: version,
        progress: 100,
        message: `Trio ${version ?? "업데이트"} 설치를 위한 준비가 완료되었습니다.`
      });
    });
    resolvedUpdater.on("error", (error) => {
      logger.warn(`Auto-update failed: ${getErrorMessage(error)}`);
      const downloading = state.status === "downloading";
      setState("error", {
        availableVersion: state.availableVersion,
        message: downloading
          ? "업데이트를 다운로드하지 못했습니다. 잠시 후 다시 시도하세요."
          : "업데이트를 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요."
      });
    });
    void checkForUpdates();
    logger.info("Auto-update check started");
    return true;
  };

  return { getState: () => state, start, checkForUpdates, downloadUpdate, installUpdate, openRelease };
}

export function startAutoUpdater(options: AutoUpdaterOptions): boolean {
  return createAutoUpdateController(options).start();
}

function loadAutoUpdater(): AutoUpdaterLike {
  const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
  return autoUpdater as unknown as AutoUpdaterLike;
}

function readVersion(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("version" in value)) return undefined;
  return typeof value.version === "string" ? value.version : undefined;
}

function readProgress(value: unknown): number {
  if (!value || typeof value !== "object" || !("percent" in value) || typeof value.percent !== "number") return 0;
  return Math.max(0, Math.min(100, Math.round(value.percent)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
