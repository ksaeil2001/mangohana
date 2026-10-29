import { describe, expect, it } from "vitest";
import {
  clampImageZoom,
  createImageViewportState,
  imageViewportReducer
} from "../../src/renderer/imageViewport";

describe("image viewport state", () => {
  it("starts in fit mode with the original and OCR layers available independently", () => {
    expect(createImageViewportState()).toEqual({
      viewMode: "fit",
      zoom: 1,
      pan: { x: 0, y: 0 },
      layers: {
        original: true,
        ocr: true,
        sourceText: false,
        translation: false,
        final: false
      }
    });
  });

  it("clamps zoom to the explicit 25%-400% range", () => {
    expect(clampImageZoom(0.1)).toBe(0.25);
    expect(clampImageZoom(2.25)).toBe(2.25);
    expect(clampImageZoom(5)).toBe(4);
  });

  it("resets view and pan on page switch while preserving layer visibility", () => {
    const changed = imageViewportReducer(createImageViewportState(), { type: "set-layer", layer: "ocr", visible: false });
    const zoomed = imageViewportReducer(changed, { type: "set-view", viewMode: "actual", zoom: 2 });
    const panned = imageViewportReducer(zoomed, { type: "set-pan", pan: { x: 80, y: 120 } });

    expect(imageViewportReducer(panned, { type: "page-changed" })).toEqual({
      ...createImageViewportState(),
      layers: { ...createImageViewportState().layers, ocr: false }
    });
  });

  it("does not alter viewport state during focus-mode transitions", () => {
    const state = imageViewportReducer(createImageViewportState(), { type: "set-view", viewMode: "width", zoom: 1.5 });
    expect(imageViewportReducer(state, { type: "focus-mode-changed" })).toBe(state);
  });

  it("restores an exact persisted zoom on workspace entry without changing layers", () => {
    const state = imageViewportReducer(createImageViewportState(), {
      type: "set-layer",
      layer: "ocr",
      visible: false
    });

    expect(imageViewportReducer(state, { type: "restore-zoom", zoom: 1.75 })).toEqual({
      ...state,
      viewMode: "actual",
      zoom: 1.75,
      pan: { x: 0, y: 0 }
    });
  });

  it("restores view mode, zoom, pan, and layer visibility as one workspace snapshot", () => {
    const state = createImageViewportState();
    const restored = imageViewportReducer(state, {
      type: "restore",
      viewport: {
        viewMode: "actual",
        zoom: 1.75,
        pan: { x: 42, y: 18 },
        layers: {
          original: true,
          ocr: false,
          sourceText: true,
          translation: false,
          final: true
        }
      }
    });

    expect(restored).toEqual({
      viewMode: "actual",
      zoom: 1.75,
      pan: { x: 42, y: 18 },
      layers: {
        original: true,
        ocr: false,
        sourceText: true,
        translation: false,
        final: true
      }
    });
  });
});
