import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_WORKSPACE_PANELS,
  clampEditorWidth,
  getFocusDeckPreferenceKey,
  loadFocusDeckPreferences,
  saveFocusDeckPreferences
} from "../../src/renderer/focusDeck";

describe("Focus Deck preferences", () => {
  it.each([[100, 320], [420, 420], [900, 520]])("clamps %s to %s", (value, expected) => {
    expect(clampEditorWidth(value)).toBe(expected);
  });

  it("uses a stable project-specific key", () => {
    expect(getFocusDeckPreferenceKey("C:/projects/story.txt")).toBe("focus-deck:C:/projects/story.txt");
  });

  it.each([null, "not-json", "null", "{}", '{"resultsOpen":"invalid","inspectorWidth":"invalid"}'])("uses the canvas-first defaults for missing or invalid preferences: %s", (stored) => {
    const storage = { getItem: vi.fn().mockReturnValue(stored), setItem: vi.fn() };
    expect(DEFAULT_INSPECTOR_WIDTH).toBe(320);
    expect(DEFAULT_WORKSPACE_PANELS.resultsOpen).toBe(false);
    expect(loadFocusDeckPreferences(storage, "story")).toEqual({
      pagesOpen: false,
      inspectorOpen: false,
      resultsOpen: false,
      focusMode: false,
      inspectorWidth: DEFAULT_INSPECTOR_WIDTH,
      zoom: 1
    });
  });

  it("loads and saves only the project-specific workspace UI state", () => {
    const values = new Map<string, string>([
      ["focus-deck:story-a", '{"pagesOpen":false,"inspectorOpen":true,"resultsOpen":false,"focusMode":true,"inspectorWidth":999,"zoom":1.25}'],
      ["focus-deck:story-b", '{"pagesOpen":true,"inspectorOpen":false,"resultsOpen":true,"focusMode":false,"inspectorWidth":360,"zoom":2}']
    ]);
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn()
    };

    expect(loadFocusDeckPreferences(storage, "story-a")).toEqual({
      pagesOpen: false,
      inspectorOpen: true,
      resultsOpen: false,
      focusMode: true,
      inspectorWidth: 520,
      zoom: 1.25
    });
    expect(loadFocusDeckPreferences(storage, "story-b")).toMatchObject({
      inspectorOpen: false,
      resultsOpen: true,
      inspectorWidth: 360
    });

    saveFocusDeckPreferences(storage, "story-a", {
      pagesOpen: true,
      inspectorOpen: false,
      resultsOpen: true,
      focusMode: false,
      inspectorWidth: 400,
      zoom: 1
    });
    expect(storage.setItem).toHaveBeenCalledWith(
      "focus-deck:story-a",
      '{"pagesOpen":true,"inspectorOpen":false,"resultsOpen":true,"focusMode":false,"inspectorWidth":400,"zoom":1}'
    );
  });

  it("migrates legacy editorWidth, drawer, and zoom preferences without coupling the new panels", () => {
    const storage = {
      getItem: vi.fn().mockReturnValue('{"editorWidth":444,"drawer":"context","zoom":1.5}'),
      setItem: vi.fn()
    };

    expect(loadFocusDeckPreferences(storage, "legacy-story")).toEqual({
      pagesOpen: false,
      inspectorOpen: false,
      resultsOpen: false,
      focusMode: false,
      inspectorWidth: 444,
      zoom: 1.5
    });
  });
});
