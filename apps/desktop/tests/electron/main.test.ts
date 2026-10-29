import { describe, expect, it, vi } from "vitest";
import * as electronMainModule from "../../electron/main";
import { protocol } from "electron";
import {
  configureSecondInstanceFocus,
  registerConfirmedQuitCleanup,
  registerDirtyUnloadConfirmation,
  registerRendererProcessCleanup,
  getAllowedDevServerUrl,
  requestApplicationSingleInstance
} from "../../electron/main";
import { createProjectSessionManager } from "../../src/main/projectSessions";
import { createEmptyProject } from "../../src/shared/projectValidation";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => new Promise(() => undefined)),
    on: vi.fn(),
    quit: vi.fn()
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => [])
  }),
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBoxSync: vi.fn()
  },
  ipcMain: {
    handle: vi.fn()
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn()
  },
  net: {
    fetch: vi.fn()
  }
}));

describe("electron main dev server URL gate", () => {
  it("registers the fixed production font scheme before app readiness", () => {
    const registrations = vi.mocked(protocol.registerSchemesAsPrivileged).mock.calls;
    expect(registrations).toHaveLength(1);
    expect(registrations[0]![0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scheme: "trio-resource",
        privileges: expect.objectContaining({
          standard: true,
          secure: true,
          supportFetchAPI: true
        })
      })
    ]));
  });

  it("allows unpackaged loopback http and https URLs", () => {
    expect(getAllowedDevServerUrl("http://localhost:5173", false)).toBe("http://localhost:5173/");
    expect(getAllowedDevServerUrl("https://127.0.0.1:5173/app", false)).toBe("https://127.0.0.1:5173/app");
    expect(getAllowedDevServerUrl("http://[::1]:5173", false)).toBe("http://[::1]:5173/");
  });

  it("rejects packaged, invalid, non-http, and non-loopback URLs", () => {
    expect(getAllowedDevServerUrl("http://localhost:5173", true)).toBeNull();
    expect(getAllowedDevServerUrl(undefined, false)).toBeNull();
    expect(getAllowedDevServerUrl("not a url", false)).toBeNull();
    expect(getAllowedDevServerUrl("file:///tmp/index.html", false)).toBeNull();
    expect(getAllowedDevServerUrl("https://example.com", false)).toBeNull();
  });
});

describe("electron main updater policy inputs", () => {
  it("derives the channel from the app version and passes the explicit platform", () => {
    expect(electronMainModule).toHaveProperty("getAutoUpdaterPolicyInputs");

    if (!("getAutoUpdaterPolicyInputs" in electronMainModule)) return;
    const getAutoUpdaterPolicyInputs = (electronMainModule as unknown as {
      getAutoUpdaterPolicyInputs: (
        appLike: { getVersion: () => string },
        platform: NodeJS.Platform
      ) => { releaseChannel: string; platform: NodeJS.Platform };
    }).getAutoUpdaterPolicyInputs;

    expect(getAutoUpdaterPolicyInputs({ getVersion: () => "0.1.4-preview.1" }, "win32")).toEqual({
      releaseChannel: "preview",
      platform: "win32"
    });
  });
});

describe("electron single instance", () => {
  it("quits before creating Main state when the lock cannot be acquired", () => {
    const appLike = {
      requestSingleInstanceLock: vi.fn(() => false),
      quit: vi.fn()
    };

    expect(requestApplicationSingleInstance(appLike)).toBe(false);
    expect(appLike.quit).toHaveBeenCalledOnce();
  });

  it("restores and focuses only the existing window for a second instance", () => {
    const window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      focus: vi.fn()
    };
    let handler: (() => void) | undefined;
    const appLike = {
      on: vi.fn((_event: string, callback: () => void) => {
        handler = callback;
      })
    };

    configureSecondInstanceFocus(appLike, () => window);
    handler?.();

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});

describe("electron confirmed quit cleanup", () => {
  function createQuitAppLike() {
    const handlers = new Map<string, (event: { preventDefault: () => void }) => void>();
    const appLike = {
      on: vi.fn((event: string, handler: (event: { preventDefault: () => void }) => void) => {
        handlers.set(event, handler);
      }),
      exit: vi.fn()
    };
    return { handlers, appLike };
  }

  it("keeps project sessions alive before quit is confirmed and disposes once on will-quit", async () => {
    const { handlers, appLike } = createQuitAppLike();
    const manager = { disposeAll: vi.fn().mockResolvedValue(undefined) };
    let activeManager: typeof manager | null = manager;

    registerConfirmedQuitCleanup(appLike, () => {
      const current = activeManager;
      activeManager = null;
      return current;
    });

    handlers.get("before-quit")?.({ preventDefault: vi.fn() });
    expect(manager.disposeAll).not.toHaveBeenCalled();
    expect(activeManager).toBe(manager);

    const firstEvent = { preventDefault: vi.fn() };
    handlers.get("will-quit")?.(firstEvent);
    handlers.get("will-quit")?.({ preventDefault: vi.fn() });
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(manager.disposeAll).toHaveBeenCalledOnce();
    expect(activeManager).toBeNull();
    await vi.waitFor(() => expect(appLike.exit).toHaveBeenCalledWith(0));
  });

  it("preserves an actual project session until will-quit cleanup settles", async () => {
    const { handlers, appLike } = createQuitAppLike();
    const manager = createProjectSessionManager();
    const created = manager.createProjectSession({ project: createEmptyProject("Dirty", false) });
    let activeManager: typeof manager | null = manager;
    registerConfirmedQuitCleanup(appLike, () => {
      const current = activeManager;
      activeManager = null;
      return current;
    });

    handlers.get("before-quit")?.({ preventDefault: vi.fn() });
    expect(manager.getProject(created.projectSessionId).project.metadata.title).toBe("Dirty");

    handlers.get("will-quit")?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => {
      expect(() => manager.getProject(created.projectSessionId)).toThrow(/Unknown project session/);
    });
    expect(appLike.exit).toHaveBeenCalledWith(0);
  });

  it("does not wait indefinitely when shutdown disposal hangs", async () => {
    const { handlers, appLike } = createQuitAppLike();
    const manager = { disposeAll: vi.fn(() => new Promise<void>(() => undefined)) };
    registerConfirmedQuitCleanup(appLike, () => manager, { timeoutMs: 20 });

    handlers.get("will-quit")?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(appLike.exit).toHaveBeenCalledWith(0));
    expect(manager.disposeAll).toHaveBeenCalledOnce();
  });
});

describe("electron dirty unload confirmation", () => {
  function registerDecision(choice: number) {
    let handler: ((event: { preventDefault: () => void }) => void) | undefined;
    const webContents = {
      on: vi.fn((_event: "will-prevent-unload", callback: typeof handler) => {
        handler = callback;
      })
    };
    const showConfirmation = vi.fn(() => choice);
    registerDirtyUnloadConfirmation({ webContents }, showConfirmation);
    return { handler, showConfirmation, webContents };
  }

  it("does not show a dialog for a clean close that never prevents unload", () => {
    const { showConfirmation, webContents } = registerDecision(0);

    expect(webContents.on).toHaveBeenCalledOnce();
    expect(showConfirmation).not.toHaveBeenCalled();
  });

  it("keeps working when the user chooses Stay", () => {
    const { handler, showConfirmation } = registerDecision(0);
    const event = { preventDefault: vi.fn() };

    handler?.(event);

    expect(showConfirmation).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("allows renderer unload only when the user chooses Leave", () => {
    const { handler, showConfirmation } = registerDecision(1);
    const event = { preventDefault: vi.fn() };

    handler?.(event);

    expect(showConfirmation).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("registers one synchronous decision handler and remains consistent across repeated closes", () => {
    const { handler, showConfirmation, webContents } = registerDecision(0);
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    handler?.(firstEvent);
    handler?.(secondEvent);

    expect(webContents.on).toHaveBeenCalledOnce();
    expect(showConfirmation).toHaveBeenCalledTimes(2);
    expect(firstEvent.preventDefault).not.toHaveBeenCalled();
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
  });
});

describe("electron renderer process cleanup", () => {
  it("cleans a renderer once for process-gone or destroyed without binding navigation", async () => {
    const handlers = new Map<string, () => void>();
    const webContents = {
      id: 73,
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler))
    };
    const cleanupRenderer = vi.fn().mockResolvedValue(undefined);

    registerRendererProcessCleanup(webContents, cleanupRenderer);

    expect(webContents.on.mock.calls.map(([event]) => event)).toEqual([
      "render-process-gone",
      "destroyed"
    ]);
    expect(handlers.has("did-navigate")).toBe(false);
    handlers.get("render-process-gone")?.();
    handlers.get("destroyed")?.();
    await vi.waitFor(() => expect(cleanupRenderer).toHaveBeenCalledOnce());
    expect(cleanupRenderer).toHaveBeenCalledWith(73);
  });
});
