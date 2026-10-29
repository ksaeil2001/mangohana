import { describe, expect, it } from "vitest";
import {
  classifyWorkspaceViewport,
  deriveWorkspaceAdaptation,
  deriveVisibleWorkspacePanels,
  type WorkspaceViewportTier
} from "../../src/renderer/workspaceAdaptation";

const allPanels = {
  pagesOpen: true,
  inspectorOpen: true,
  resultsOpen: true,
  focusMode: false,
  inspectorWidth: 392
} as const;

describe("workspaceAdaptation", () => {
  it.each<[number, WorkspaceViewportTier]>([
    [1440, "wide"],
    [1920, "wide"],
    [1439.99, "compact"],
    [1200, "compact"],
    [1199.99, "narrow"],
    [1024, "narrow"],
    [1023.99, "precision-limited"],
    [640, "precision-limited"]
  ])(
    "classifies exact viewport boundary %s as %s",
    (width, tier) => {
      expect(classifyWorkspaceViewport(width)).toBe(tier);
    }
  );

  it("uses an inline panel policy that never places panels over the image", () => {
    for (const width of [1440, 1280, 1100, 1024, 900]) {
      const adaptation = deriveWorkspaceAdaptation(width);
      expect(adaptation.suppressPanelOverlay).toBe(true);
      expect(adaptation.preservePanelState).toBe(true);
      expect(adaptation.allowExplicitPanelToggle).toBe(true);
    }
  });

  it("limits only precision editing below 1024px while keeping image work available", () => {
    expect(deriveWorkspaceAdaptation(1024).precisionEditingDisabled).toBe(false);
    expect(deriveWorkspaceAdaptation(1023).precisionEditingDisabled).toBe(true);
    expect(deriveWorkspaceAdaptation(800)).toMatchObject({
      precisionEditingDisabled: true,
      imageViewingEnabled: true,
      pageNavigationEnabled: true,
      ocrEnabled: true,
      manualTranslationEnabled: true,
      saveEnabled: true,
      showPrecisionNotice: true
    });
  });

  it("collapses pages first in compact mode without changing the saved preference", () => {
    const derived = deriveVisibleWorkspacePanels(allPanels, deriveWorkspaceAdaptation(1280));
    expect(derived).toMatchObject({ pagesOpen: false, inspectorOpen: true, resultsOpen: true });
    expect(allPanels.pagesOpen).toBe(true);
    expect(deriveVisibleWorkspacePanels(allPanels, deriveWorkspaceAdaptation(1280), { pagesExpanded: true }).pagesOpen).toBe(true);
  });

  it("shows at most one auxiliary panel in narrow and precision-limited modes", () => {
    expect(deriveVisibleWorkspacePanels(allPanels, deriveWorkspaceAdaptation(1100))).toMatchObject({
      pagesOpen: false,
      inspectorOpen: true,
      resultsOpen: false
    });
    expect(deriveVisibleWorkspacePanels(allPanels, deriveWorkspaceAdaptation(900), { activePanel: "results" })).toMatchObject({
      pagesOpen: false,
      inspectorOpen: false,
      resultsOpen: true
    });
  });
});
