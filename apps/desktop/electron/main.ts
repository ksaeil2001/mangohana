import { app, BrowserWindow, dialog, protocol, safeStorage } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGeminiApiKeyStore } from "../src/main/geminiApiKeyStore.js";
import {
  registerIpcHandlers,
  type IpcRendererLifecycleController
} from "../src/main/ipcHandlers.js";
import { createProjectSessionManager } from "../src/main/projectSessions.js";
import { createProviderSettingsStore } from "../src/main/providerSettingsStore.js";
import { createRecentProjectRegistry } from "../src/main/recentProjects.js";
import { initializeProductionTypesetFontResource } from "../src/main/productionTypesetFontResource.js";
import {
  createProductionOcrService,
  type ProductionOcrService
} from "../src/main/productionOcrService.js";
import { resolveDefaultEnvironmentResourceRoot } from "../src/main/environmentPreparation.js";
import {
  createAutoUpdateController,
  deriveReleaseChannel,
  type ReleaseChannel
} from "../src/main/autoUpdater.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const loopbackDevHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const productionTypesetFontScheme = "trio-resource";
let activeProjectSessionManager: ReturnType<typeof createProjectSessionManager> | null = null;
let activeRendererLifecycleController: IpcRendererLifecycleController | null = null;
let activeProductionOcrService: ProductionOcrService | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "translation-image",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  {
    scheme: productionTypesetFontScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

function createWindow(): void {
  const window = new BrowserWindow({
    title: "망고하나",
    icon: app.isPackaged
      ? join(__dirname, "../../dist-renderer/mangohana-icon.png")
      : join(__dirname, "../../public/mangohana-icon.png"),
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 720,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  registerDirtyUnloadConfirmation(window);
  if (activeRendererLifecycleController) {
    registerRendererProcessCleanup(
      window.webContents,
      activeRendererLifecycleController.cleanupRenderer
    );
  }

  const devServerUrl = getAllowedDevServerUrl(process.env.VITE_DEV_SERVER_URL, app.isPackaged);
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../../dist-renderer/index.html"));
  }
}

export function requestApplicationSingleInstance(appLike: {
  requestSingleInstanceLock: () => boolean;
  quit: () => void;
}): boolean {
  const acquired = appLike.requestSingleInstanceLock();
  if (!acquired) appLike.quit();
  return acquired;
}

export function configureSecondInstanceFocus(
  appLike: { on: (event: "second-instance", handler: () => void) => void },
  getWindow: () => { isMinimized: () => boolean; restore: () => void; focus: () => void } | undefined
): void {
  appLike.on("second-instance", () => {
    const window = getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}

export function getAllowedDevServerUrl(rawUrl: string | undefined, isPackaged: boolean): string | null {
  if (isPackaged || !rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!loopbackDevHosts.has(hostname)) return null;

  return url.toString();
}

export function getAutoUpdaterPolicyInputs(
  appLike: { getVersion: () => string },
  platform: NodeJS.Platform
): { releaseChannel: ReleaseChannel; platform: NodeJS.Platform } {
  return {
    releaseChannel: deriveReleaseChannel(appLike.getVersion()),
    platform
  };
}

const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 5_000;

export function registerConfirmedQuitCleanup<T extends { disposeAll: () => void | Promise<void> }>(
  appLike: {
    on: (event: "will-quit", handler: (event: { preventDefault: () => void }) => void) => void;
    exit?: (code?: number) => void;
  },
  takeActiveManager: () => T | null,
  options?: { timeoutMs?: number }
): void {
  let quitCleanupStarted = false;
  appLike.on("will-quit", (event) => {
    if (quitCleanupStarted) {
      event.preventDefault();
      return;
    }
    const manager = takeActiveManager();
    if (!manager) return;
    quitCleanupStarted = true;
    event.preventDefault();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_QUIT_CLEANUP_TIMEOUT_MS;
    const disposal = Promise.resolve(manager.disposeAll()).catch(() => undefined);
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    });
    void Promise.race([disposal, timeout]).finally(() => {
      appLike.exit?.(0);
    });
  });
}

export function registerDirtyUnloadConfirmation(
  windowLike: {
    webContents: {
      on: (
        event: "will-prevent-unload",
        handler: (event: { preventDefault: () => void }) => void
      ) => unknown;
    };
  },
  showConfirmation: () => number = () => dialog.showMessageBoxSync(
    windowLike as BrowserWindow,
    {
      type: "warning",
      title: "저장하지 않은 변경사항",
      message: "저장하지 않은 변경사항이 있습니다.",
      detail: "저장하지 않고 나가면 마지막 저장 이후의 변경사항이 사라집니다.",
      buttons: ["계속 작업", "저장하지 않고 나가기"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }
  )
): void {
  windowLike.webContents.on("will-prevent-unload", (event) => {
    const choice = showConfirmation();
    if (choice === 1) {
      event.preventDefault();
    }
  });
}

export function registerRendererProcessCleanup(
  webContents: { id: number },
  cleanupRenderer: (ownerId: number) => Promise<void>
): void {
  let cleanupStarted = false;
  const cleanup = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void cleanupRenderer(webContents.id).catch(() => {
      // Renderer teardown is best-effort here; confirmed app quit still
      // disposes every remaining project session.
    });
  };
  const eventSource = webContents as unknown as {
    on: (event: "render-process-gone" | "destroyed", handler: () => void) => unknown;
  };
  eventSource.on("render-process-gone", cleanup);
  eventSource.on("destroyed", cleanup);
}

if (requestApplicationSingleInstance(app)) {
  configureSecondInstanceFocus(app, () => BrowserWindow.getAllWindows()[0]);

  app.whenReady().then(async () => {
    const productionTypesetFontResource =
      await initializeProductionTypesetFontResource(process.resourcesPath);
    protocol.handle(
      productionTypesetFontScheme,
      productionTypesetFontResource.handleProtocolRequest
    );
    const geminiApiKeyStore = createGeminiApiKeyStore({
      encryption: safeStorage,
      filePath: join(app.getPath("userData"), "settings", "gemini-api-key.enc"),
      env: process.env
    });
    await geminiApiKeyStore.initialize();
    const projectSessionManager = createProjectSessionManager();
    activeProjectSessionManager = projectSessionManager;
    const recentProjectRegistry = createRecentProjectRegistry({
      storageFilePath: join(app.getPath("userData"), "recent-projects.json")
    });
    const providerSettingsStore = createProviderSettingsStore({
      storageFilePath: join(app.getPath("userData"), "settings", "provider-settings.json")
    });
    const productionOcrService = createProductionOcrService({
      resourcesPath: process.resourcesPath,
      initialResourceRoot: resolveDefaultEnvironmentResourceRoot({
        localAppData: process.env.LOCALAPPDATA,
        fallbackRoot: app.getPath("userData")
      })
    });
    activeProductionOcrService = productionOcrService;
    const autoUpdaterPolicyInputs = getAutoUpdaterPolicyInputs(app, process.platform);
    const autoUpdateController = createAutoUpdateController({
      isPackaged: app.isPackaged,
      isSmokeTest: process.env.CI_SMOKE_TEST === "true",
      ...autoUpdaterPolicyInputs,
      onStateChange: (state) => {
        for (const target of BrowserWindow.getAllWindows()) {
          if (!target.isDestroyed()) target.webContents.send("app-update:state", state);
        }
      }
    });
    activeRendererLifecycleController = registerIpcHandlers({
      geminiApiKeyStore,
      projectSessionManager,
      recentProjectRegistry,
      providerSettingsStore,
      productionOcrService,
      appVersion: app.getVersion(),
      defaultProjectDirectory: app.getPath("documents"),
      exampleProjectDirectory: join(__dirname,
        app.isPackaged ? "../../dist-renderer/mangohana-example" : "../../public/mangohana-example"),
      exampleTemporaryDirectory: app.getPath("temp"),
      autoUpdateController,
      verifyInstalledTypesetFontResource:
        productionTypesetFontResource.verifyInstalledTypesetFontResource
    });
    createWindow();
    autoUpdateController.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

registerConfirmedQuitCleanup(app, () => {
  const projectSessionManager = activeProjectSessionManager;
  const productionOcrService = activeProductionOcrService;
  activeProjectSessionManager = null;
  activeProductionOcrService = null;
  if (!projectSessionManager && !productionOcrService) return null;
  return {
    disposeAll: async () => {
      productionOcrService?.close();
      await projectSessionManager?.disposeAll();
    }
  };
});
