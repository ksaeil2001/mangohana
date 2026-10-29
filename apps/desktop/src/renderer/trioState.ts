/**
 * Renderer-local UI contract for the Trio workbench.
 *
 * This module deliberately contains no persistence, IPC, or UI wiring. It
 * gives later UI steps a small pure state boundary while existing flows keep
 * using their current state and handlers.
 */

export const RESULT_LAYERS = [
  "original",
  "inpainted",
  "translated"
] as const;

export type ResultLayer = (typeof RESULT_LAYERS)[number];

export const COMPARISON_MODES = [
  "single",
  "split",
  "reveal",
  "opacity"
] as const;

export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export const OVERLAY_KINDS = [
  "ocr",
  "balloon",
  "safe-area",
  "typeset",
  "inpainting-mask",
  "preserve",
  "issue"
] as const;

export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export const OWNERSHIP_STATES = [
  "ai-proposed",
  "user-edited",
  "user-confirmed",
  "stale-confirmed"
] as const;

export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

export type TrioUiState = {
  resultLayer: ResultLayer;
  comparisonMode: ComparisonMode;
  visibleOverlays: readonly OverlayKind[];
  ownership: OwnershipState;
};

export type TrioUiAction =
  | { type: "set-result-layer"; layer: ResultLayer }
  | { type: "set-comparison-mode"; mode: ComparisonMode }
  | { type: "toggle-overlay"; kind: OverlayKind }
  | { type: "ai-proposed" }
  | { type: "user-edited" }
  | { type: "user-confirmed" }
  | { type: "source-changed" };

export function createTrioUiState(): TrioUiState {
  return {
    resultLayer: "original",
    comparisonMode: "single",
    visibleOverlays: [],
    ownership: "ai-proposed"
  };
}

export function canApplyAiProposal(ownership: OwnershipState): boolean {
  return ownership === "ai-proposed";
}

export function trioUiReducer(
  state: TrioUiState,
  action: TrioUiAction
): TrioUiState {
  switch (action.type) {
    case "set-result-layer":
      return state.resultLayer === action.layer
        ? state
        : { ...state, resultLayer: action.layer };

    case "set-comparison-mode":
      return state.comparisonMode === action.mode
        ? state
        : { ...state, comparisonMode: action.mode };

    case "toggle-overlay": {
      const isVisible = state.visibleOverlays.includes(action.kind);

      return {
        ...state,
        visibleOverlays: isVisible
          ? state.visibleOverlays.filter((kind) => kind !== action.kind)
          : [...state.visibleOverlays, action.kind]
      };
    }

    case "ai-proposed":
      return canApplyAiProposal(state.ownership)
        ? { ...state, ownership: "ai-proposed" }
        : state;

    case "user-edited":
      return state.ownership === "user-edited"
        ? state
        : { ...state, ownership: "user-edited" };

    case "user-confirmed":
      return state.ownership === "user-confirmed"
        ? state
        : { ...state, ownership: "user-confirmed" };

    case "source-changed":
      return state.ownership === "user-confirmed"
        ? { ...state, ownership: "stale-confirmed" }
        : state;
  }
}
