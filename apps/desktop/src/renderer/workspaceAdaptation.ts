import { useEffect, useMemo, useState } from "react";
import type { WorkspacePanelState } from "./focusDeck";

/** The responsive tiers are intentionally kept in one place so CSS and React
 * controls can share the same 1440/1200/1024 boundaries. */
export type WorkspaceViewportTier = "wide" | "compact" | "narrow" | "precision-limited";

export type WorkspaceAdaptation = {
  width: number;
  tier: WorkspaceViewportTier;
  /** Supporting panels are laid out beside the image, never as a surprise overlay. */
  suppressPanelOverlay: true;
  /** A resize must not write a derived collapsed state over the user's preference. */
  preservePanelState: true;
  allowExplicitPanelToggle: true;
  precisionEditingDisabled: boolean;
  showPrecisionNotice: boolean;
  imageViewingEnabled: true;
  pageNavigationEnabled: true;
  ocrEnabled: true;
  manualTranslationEnabled: true;
  saveEnabled: true;
};

export type WorkspaceAuxiliaryPanel = "pages" | "inspector" | "results";

export type DerivedWorkspacePanels = Pick<WorkspacePanelState, "pagesOpen" | "inspectorOpen" | "resultsOpen"> & {
  activePanel: WorkspaceAuxiliaryPanel | null;
};

export type WorkspacePanelOverrides = {
  pagesExpanded?: boolean;
  activePanel?: WorkspaceAuxiliaryPanel | null;
};

export function classifyWorkspaceViewport(width: number): WorkspaceViewportTier {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1440;
  if (safeWidth >= 1440) return "wide";
  if (safeWidth >= 1200) return "compact";
  if (safeWidth >= 1024) return "narrow";
  return "precision-limited";
}

export function deriveWorkspaceAdaptation(width: number): WorkspaceAdaptation {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1440;
  const tier = classifyWorkspaceViewport(safeWidth);
  const precisionEditingDisabled = tier === "precision-limited";
  return {
    width: safeWidth,
    tier,
    suppressPanelOverlay: true,
    preservePanelState: true,
    allowExplicitPanelToggle: true,
    precisionEditingDisabled,
    showPrecisionNotice: precisionEditingDisabled,
    imageViewingEnabled: true,
    pageNavigationEnabled: true,
    ocrEnabled: true,
    manualTranslationEnabled: true,
    saveEnabled: true
  };
}

/**
 * Derive a safe presentation without writing to the versioned panel
 * preference. Explicit toggles are supplied by FocusDeckShell and therefore
 * win over the automatic compact/narrow policy for the current viewport.
 */
export function deriveVisibleWorkspacePanels(
  panelState: WorkspacePanelState,
  adaptation: WorkspaceAdaptation,
  overrides: WorkspacePanelOverrides = {}
): DerivedWorkspacePanels {
  if (panelState.focusMode || adaptation.tier === "wide") {
    return {
      pagesOpen: panelState.pagesOpen,
      inspectorOpen: panelState.inspectorOpen,
      resultsOpen: panelState.resultsOpen,
      activePanel: null
    };
  }

  if (adaptation.tier === "compact") {
    const pagesOpen = overrides.pagesExpanded === true && panelState.pagesOpen;
    return {
      pagesOpen,
      inspectorOpen: panelState.inspectorOpen,
      resultsOpen: panelState.resultsOpen,
      activePanel: pagesOpen ? "pages" : null
    };
  }

  const preferredPanel = overrides.activePanel ?? null;
  const panelCandidates: WorkspaceAuxiliaryPanel[] = ["inspector", "results", "pages"];
  const selectedPanel = preferredPanel && panelState[`${preferredPanel}Open`]
    ? preferredPanel
    : panelCandidates.find((panel) => panelState[`${panel}Open`]) ?? null;
  return {
    pagesOpen: selectedPanel === "pages",
    inspectorOpen: selectedPanel === "inspector",
    resultsOpen: selectedPanel === "results",
    activePanel: selectedPanel
  };
}

function readViewportWidth(): number {
  if (typeof window === "undefined") return 1440;
  return Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1440;
}

/** Subscribe to resize without leaking a listener when a workspace is closed. */
export function useWorkspaceAdaptation(): WorkspaceAdaptation {
  const [width, setWidth] = useState(readViewportWidth);
  useEffect(() => {
    const update = () => setWidth(readViewportWidth());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return useMemo(() => deriveWorkspaceAdaptation(width), [width]);
}
