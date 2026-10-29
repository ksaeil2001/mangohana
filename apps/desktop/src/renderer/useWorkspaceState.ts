import { useState } from "react";
import {
  DEFAULT_WORKSPACE_PANELS,
  type WorkspacePanelState
} from "./focusDeck.js";
import { OVERLAY_KIND_ORDER } from "./semanticOverlays.js";
import type { OverlayKind } from "./trioState.js";
import type { GuidanceDensity } from "./guidedWorkflow.js";

export type BottomPanel = "dialogue" | "ocr-candidates" | "issues";

export function useWorkspaceState() {
  const [bottomPanel, setBottomPanel] = useState<BottomPanel>("dialogue");
  const [selectedPageNumber, setSelectedPageNumber] = useState<number>(1);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [visibleOverlayKinds, setVisibleOverlayKinds] = useState<OverlayKind[]>(() => [...OVERLAY_KIND_ORDER]);
  const [guidanceDensity, setGuidanceDensity] = useState<GuidanceDensity>("guided");
  const [focusDeckPreferences, setFocusDeckPreferences] = useState<WorkspacePanelState>(DEFAULT_WORKSPACE_PANELS);

  function resetWorkspaceState() {
    setBottomPanel("dialogue");
    setSelectedPageNumber(1);
    setSelectedLineId(null);
    setVisibleOverlayKinds([...OVERLAY_KIND_ORDER]);
    setGuidanceDensity("guided");
    setFocusDeckPreferences(DEFAULT_WORKSPACE_PANELS);
  }

  return {
    bottomPanel,
    setBottomPanel,
    selectedPageNumber,
    setSelectedPageNumber,
    selectedLineId,
    setSelectedLineId,
    visibleOverlayKinds,
    setVisibleOverlayKinds,
    guidanceDensity,
    setGuidanceDensity,
    focusDeckPreferences,
    setFocusDeckPreferences,
    resetWorkspaceState
  };
}
