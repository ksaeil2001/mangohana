import { describe, expect, it } from "vitest";

import {
  COMPARISON_MODES,
  OVERLAY_KINDS,
  OWNERSHIP_STATES,
  RESULT_LAYERS,
  canApplyAiProposal,
  createTrioUiState,
  trioUiReducer
} from "../../src/renderer/trioState";

describe("TRIO UI state contract", () => {
  it("defines the result layers, comparison modes, overlays, and ownership states", () => {
    expect(RESULT_LAYERS).toEqual(["original", "inpainted", "translated"]);
    expect(COMPARISON_MODES).toEqual(["single", "split", "reveal", "opacity"]);
    expect(OVERLAY_KINDS).toEqual([
      "ocr",
      "balloon",
      "safe-area",
      "typeset",
      "inpainting-mask",
      "preserve",
      "issue"
    ]);
    expect(OWNERSHIP_STATES).toEqual([
      "ai-proposed",
      "user-edited",
      "user-confirmed",
      "stale-confirmed"
    ]);
  });

  it("starts in the original single-layer view with no visible overlays", () => {
    expect(createTrioUiState()).toEqual({
      resultLayer: "original",
      comparisonMode: "single",
      visibleOverlays: [],
      ownership: "ai-proposed"
    });
  });

  it("changes the result layer and comparison mode without changing other state", () => {
    const initial = createTrioUiState();
    const withOverlay = trioUiReducer(initial, {
      type: "toggle-overlay",
      kind: "ocr"
    });

    const changed = trioUiReducer(
      trioUiReducer(withOverlay, {
        type: "set-result-layer",
        layer: "translated"
      }),
      {
        type: "set-comparison-mode",
        mode: "opacity"
      }
    );

    expect(changed).toEqual({
      resultLayer: "translated",
      comparisonMode: "opacity",
      visibleOverlays: ["ocr"],
      ownership: "ai-proposed"
    });
    expect(initial).toEqual(createTrioUiState());
  });

  it("toggles overlays without duplicating or mutating the source list", () => {
    const initial = createTrioUiState();
    const withOcr = trioUiReducer(initial, {
      type: "toggle-overlay",
      kind: "ocr"
    });
    const withOcrAndIssue = trioUiReducer(withOcr, {
      type: "toggle-overlay",
      kind: "issue"
    });
    const withoutOcr = trioUiReducer(withOcrAndIssue, {
      type: "toggle-overlay",
      kind: "ocr"
    });

    expect(withOcr.visibleOverlays).toEqual(["ocr"]);
    expect(withOcrAndIssue.visibleOverlays).toEqual(["ocr", "issue"]);
    expect(withoutOcr.visibleOverlays).toEqual(["issue"]);
    expect(initial.visibleOverlays).toEqual([]);
  });

  it("protects user edits and confirmations from AI proposals", () => {
    const initial = createTrioUiState();
    const edited = trioUiReducer(initial, { type: "user-edited" });
    const confirmed = trioUiReducer(edited, { type: "user-confirmed" });
    const proposalAfterEdit = trioUiReducer(edited, { type: "ai-proposed" });
    const proposalAfterConfirmation = trioUiReducer(confirmed, {
      type: "ai-proposed"
    });

    expect(edited.ownership).toBe("user-edited");
    expect(confirmed.ownership).toBe("user-confirmed");
    expect(proposalAfterEdit).toBe(edited);
    expect(proposalAfterConfirmation).toBe(confirmed);
    expect(canApplyAiProposal("ai-proposed")).toBe(true);
    expect(canApplyAiProposal("user-edited")).toBe(false);
    expect(canApplyAiProposal("user-confirmed")).toBe(false);
    expect(canApplyAiProposal("stale-confirmed")).toBe(false);
  });

  it("marks a confirmed value for review when its source changes", () => {
    const confirmed = trioUiReducer(createTrioUiState(), {
      type: "user-confirmed"
    });

    expect(
      trioUiReducer(confirmed, { type: "source-changed" }).ownership
    ).toBe("stale-confirmed");
    expect(
      trioUiReducer(
        trioUiReducer(createTrioUiState(), { type: "user-edited" }),
        { type: "source-changed" }
      ).ownership
    ).toBe("user-edited");
  });
});
