import type { ComparisonMode } from "./trioState";
export type { ComparisonMode } from "./trioState";

export const COMPARISON_POSITION_STEP = 5;
export const COMPARISON_OPACITY_STEP = 0.05;

export type ComparisonState = {
  mode: ComparisonMode;
  revealPosition: number;
  opacity: number;
  holdingOriginal: boolean;
};

export type ComparisonAction =
  | { type: "set-mode"; mode: ComparisonMode }
  | { type: "set-reveal-position"; position: number }
  | { type: "set-opacity"; opacity: number }
  | { type: "hold-original" }
  | { type: "release-original" };

export function createComparisonState(): ComparisonState {
  return {
    mode: "single",
    revealPosition: 50,
    opacity: 0.5,
    holdingOriginal: false
  };
}

export function comparisonStateReducer(
  state: ComparisonState,
  action: ComparisonAction
): ComparisonState {
  switch (action.type) {
    case "set-mode":
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case "set-reveal-position": {
      const revealPosition = clampRevealPosition(action.position);
      return state.revealPosition === revealPosition ? state : { ...state, revealPosition };
    }
    case "set-opacity": {
      const opacity = clampComparisonOpacity(action.opacity);
      return state.opacity === opacity ? state : { ...state, opacity };
    }
    case "hold-original":
      return state.holdingOriginal ? state : { ...state, holdingOriginal: true };
    case "release-original":
      return state.holdingOriginal ? { ...state, holdingOriginal: false } : state;
  }
}

export function clampRevealPosition(position: number): number {
  if (!Number.isFinite(position)) return 50;
  return Math.min(100, Math.max(0, position));
}

export function clampComparisonOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return 0.5;
  return Math.min(1, Math.max(0, opacity));
}

export function stepRevealPosition(position: number, direction: -1 | 1): number {
  return clampRevealPosition(position + direction * COMPARISON_POSITION_STEP);
}

export function stepComparisonOpacity(opacity: number, direction: -1 | 1): number {
  return clampComparisonOpacity(opacity + direction * COMPARISON_OPACITY_STEP);
}

export function isEditableComparisonTarget(target: EventTarget | null): boolean {
  let current: HTMLElement | null = target instanceof HTMLElement
    ? target
    : typeof Node !== "undefined" && target instanceof Node
      ? target.parentElement
      : null;
  while (current) {
    if (
      current.isContentEditable ||
      current.contentEditable === "true" ||
      current.getAttribute("contenteditable") === "true"
    ) return true;
    const tagName = current.tagName.toLowerCase();
    if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
    current = current.parentElement;
  }
  return false;
}
