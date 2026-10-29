import { describe, expect, it } from "vitest";
import { entryFlowReducer, initialEntryFlowState, type EntryFlowState } from "../../src/renderer/entryFlow";

describe("entryFlowReducer", () => {
  it("moves explicitly through Home, Setup, and Workspace", () => {
    const setup = entryFlowReducer(initialEntryFlowState, { type: "new-project" });
    const workspace = entryFlowReducer(setup, { type: "project-installed", hasContent: true });

    expect(initialEntryFlowState.screen).toBe("home");
    expect(setup.screen).toBe("setup");
    expect(workspace.screen).toBe("workspace");
    expect(entryFlowReducer(setup, { type: "setup-canceled" }).screen).toBe("home");
    expect(entryFlowReducer(workspace, { type: "project-installed", hasContent: false }).screen).toBe("workspace");
  });

  it("keeps Setup when its own create flow is canceled", () => {
    const setup: EntryFlowState = { screen: "setup" };

    expect(entryFlowReducer(setup, { type: "create-canceled" })).toBe(setup);
  });

  it.each(["home", "workspace"] as const)(
    "does not replace the current %s screen when a stale create flow is canceled",
    (screen) => {
      const current: EntryFlowState = { screen };

      expect(entryFlowReducer(current, { type: "create-canceled" })).toBe(current);
    }
  );

  it("opens preparation as a resumable screen from home or workspace", () => {
    const homePreparation = entryFlowReducer(initialEntryFlowState, {
      type: "open-preparation",
      returnTo: "home"
    });
    const workspacePreparation = entryFlowReducer(
      { screen: "workspace" },
      { type: "open-preparation", returnTo: "workspace" }
    );

    expect(homePreparation).toEqual({ screen: "preparation", preparationReturnScreen: "home" });
    expect(workspacePreparation).toEqual({ screen: "preparation", preparationReturnScreen: "workspace" });
    expect(entryFlowReducer(homePreparation, { type: "preparation-closed" }).screen).toBe("home");
    expect(entryFlowReducer(workspacePreparation, { type: "preparation-closed" }).screen).toBe("workspace");
  });
});
