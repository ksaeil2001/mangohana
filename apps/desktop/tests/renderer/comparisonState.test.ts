import { describe, expect, it } from "vitest";
import {
  clampComparisonOpacity,
  clampRevealPosition,
  comparisonStateReducer,
  createComparisonState,
  isEditableComparisonTarget
} from "../../src/renderer/comparisonState";

describe("comparisonState", () => {
  it("keeps reveal and opacity values inside their visual ranges", () => {
    expect(clampRevealPosition(-10)).toBe(0);
    expect(clampRevealPosition(120)).toBe(100);
    expect(clampComparisonOpacity(-0.5)).toBe(0);
    expect(clampComparisonOpacity(1.5)).toBe(1);
  });

  it("updates one comparison control without changing the other controls", () => {
    const state = createComparisonState();
    const modeState = comparisonStateReducer(state, { type: "set-mode", mode: "split" });
    const revealState = comparisonStateReducer(modeState, { type: "set-reveal-position", position: 72 });
    const opacityState = comparisonStateReducer(revealState, { type: "set-opacity", opacity: 0.35 });

    expect(opacityState).toEqual({
      mode: "split",
      revealPosition: 72,
      opacity: 0.35,
      holdingOriginal: false
    });
  });

  it("recognizes editable targets for global comparison shortcuts", () => {
    expect(isEditableComparisonTarget(document.createElement("input"))).toBe(true);
    expect(isEditableComparisonTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableComparisonTarget(document.createElement("select"))).toBe(true);
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    expect(isEditableComparisonTarget(editable)).toBe(true);
    expect(isEditableComparisonTarget(document.createElement("button"))).toBe(false);
    expect(isEditableComparisonTarget(null)).toBe(false);
  });

  it("treats descendants of an editable ancestor as editable targets", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const child = document.createElement("span");
    editable.appendChild(child);
    document.body.appendChild(editable);

    expect(isEditableComparisonTarget(child)).toBe(true);

    editable.remove();
  });
});
