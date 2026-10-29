import { describe, expect, it, vi } from "vitest";
import * as autoUpdaterModule from "../../src/main/autoUpdater.js";
import {
  createAutoUpdateController,
  TRIO_TRANSITION_QA_FEED_URL,
  type AutoUpdaterLike
} from "../../src/main/autoUpdater.js";
import { TRIO_RELEASE_URL } from "../../src/shared/autoUpdateStatus.js";

function createUpdater() {
  const listeners = new Map<string, (value?: unknown) => void>();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    setFeedURL: vi.fn(),
    on: vi.fn((event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener);
      return updater;
    }),
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn()
  } as unknown as AutoUpdaterLike;
  return { listeners, updater };
}

describe("createAutoUpdateController", () => {
  it("does not contact the update provider in development or CI package smoke tests", () => {
    const { updater } = createUpdater();
    expect(createAutoUpdateController({
      isPackaged: false,
      isSmokeTest: false,
      releaseChannel: "stable",
      platform: "win32",
      updater
    }).start()).toBe(false);
    expect(createAutoUpdateController({
      isPackaged: true,
      isSmokeTest: true,
      releaseChannel: "stable",
      platform: "win32",
      updater
    }).start()).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("enables stable Windows updates with prerelease downloads disabled", () => {
    const { updater } = createUpdater();
    const controller = createAutoUpdateController({
      isPackaged: true,
      isSmokeTest: false,
      releaseChannel: "stable",
      platform: "win32",
      updater
    });

    expect(controller.start()).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(updater).not.toHaveProperty("channel");
  });

  it("enables transition macOS updates with prerelease downloads enabled", () => {
    const { updater } = createUpdater();
    const controller = createAutoUpdateController({
      isPackaged: true,
      isSmokeTest: false,
      releaseChannel: "transition",
      platform: "darwin",
      updater
    });

    expect(controller.start()).toBe(true);
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.setFeedURL).toHaveBeenCalledWith(TRIO_TRANSITION_QA_FEED_URL);
  });

  it("checks transition updates only after Main configures the fixed preview QA feed", async () => {
    const { updater } = createUpdater();
    let configuredFeedUrl: string | undefined;
    updater.setFeedURL = vi.fn((feedUrl: string) => {
      configuredFeedUrl = feedUrl;
    });
    updater.checkForUpdates = vi.fn(async () => {
      expect(configuredFeedUrl).toBe(TRIO_TRANSITION_QA_FEED_URL);
    });
    const controller = createAutoUpdateController({
      isPackaged: true,
      isSmokeTest: false,
      releaseChannel: "transition",
      platform: "win32",
      updater
    });

    expect(controller.start()).toBe(true);
    await controller.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalled();
  });

  it.each([
    { releaseChannel: "preview" as const, platform: "win32" as const },
    { releaseChannel: "dev" as const, platform: "darwin" as const },
    { releaseChannel: "stable" as const, platform: "linux" as const },
    { releaseChannel: "transition" as const, platform: "linux" as const }
  ])("does not register listeners or check updates for $releaseChannel on $platform", ({ releaseChannel, platform }) => {
    const { updater } = createUpdater();
    const controller = createAutoUpdateController({
      isPackaged: true,
      isSmokeTest: false,
      releaseChannel,
      platform,
      updater
    });

    expect(controller.start()).toBe(false);
    expect(updater.on).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("reports an available update and downloads only after the renderer requests it", async () => {
    const { listeners, updater } = createUpdater();
    const states: string[] = [];
    const logger = { info: vi.fn(), warn: vi.fn() };
    const controller = createAutoUpdateController({
      isPackaged: true,
      isSmokeTest: false,
      releaseChannel: "stable",
      platform: "win32",
      updater,
      logger,
      onStateChange: (state) => states.push(state.status)
    });

    expect(controller.start()).toBe(true);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    listeners.get("update-available")?.({ version: "0.2.0" });
    expect(controller.getState()).toMatchObject({ status: "available", availableVersion: "0.2.0" });
    await controller.downloadUpdate();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(states).toContain("available");
  });

  it("reports download progress and installs only after an explicit renderer command", async () => {
    const { listeners, updater } = createUpdater();
    const controller = createAutoUpdateController({
      isPackaged: true,
      isSmokeTest: false,
      releaseChannel: "stable",
      platform: "win32",
      updater
    });
    controller.start();

    listeners.get("update-available")?.({ version: "0.2.0" });
    await controller.downloadUpdate();
    listeners.get("download-progress")?.({ percent: 57.4 });
    expect(controller.getState()).toMatchObject({ status: "downloading", progress: 57 });
    listeners.get("update-downloaded")?.({ version: "0.2.0" });
    controller.installUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("returns a safe error state when the update check fails", async () => {
    const { updater } = createUpdater();
    updater.checkForUpdates = vi.fn(async () => { throw new Error("network unavailable"); });
    const controller = createAutoUpdateController({
      isPackaged: true,
      isSmokeTest: false,
      releaseChannel: "stable",
      platform: "win32",
      updater
    });

    await controller.checkForUpdates();
    expect(controller.getState()).toMatchObject({ status: "error" });
  });

  it("opens the public delivery release URL for manual downloads", async () => {
    const { updater } = createUpdater();
    const openExternal = vi.fn(async () => undefined);
    const controller = createAutoUpdateController({
      isPackaged: false,
      isSmokeTest: false,
      releaseChannel: "dev",
      platform: "win32",
      updater,
      shellApi: { openExternal }
    });

    await controller.openRelease();

    expect(openExternal).toHaveBeenCalledWith(TRIO_RELEASE_URL);
    expect(TRIO_RELEASE_URL).toBe("https://github.com/ksaeil2001/trio-releases/releases/latest");
  });
});

describe("deriveReleaseChannel", () => {
  it("derives the fail-closed release channel from the app version", () => {
    expect(autoUpdaterModule).toHaveProperty("deriveReleaseChannel");

    if (!("deriveReleaseChannel" in autoUpdaterModule)) return;
    const deriveReleaseChannel = (autoUpdaterModule as unknown as {
      deriveReleaseChannel: (version: string) => string;
    }).deriveReleaseChannel;

    expect(deriveReleaseChannel("0.1.4")).toBe("stable");
    expect(deriveReleaseChannel("0.1.4-preview.2")).toBe("preview");
    expect(deriveReleaseChannel("0.1.4-dev.3")).toBe("dev");
    expect(deriveReleaseChannel("0.1.4-transition.1")).toBe("transition");
    expect(deriveReleaseChannel("0.1.4-canary.1")).toBe("dev");
    expect(deriveReleaseChannel("not-a-version")).toBe("dev");
  });
});
