export type ImageViewMode = "fit" | "width" | "actual";

export type ImageLayerVisibility = {
  original: boolean;
  ocr: boolean;
  sourceText: boolean;
  translation: boolean;
  final: boolean;
};

export type ImageViewportState = {
  viewMode: ImageViewMode;
  zoom: number;
  pan: { x: number; y: number };
  layers: ImageLayerVisibility;
};

export type ImageViewportAction =
  | { type: "set-view"; viewMode: ImageViewMode; zoom?: number }
  | { type: "set-zoom"; zoom: number }
  | { type: "set-pan"; pan: ImageViewportState["pan"] }
  | { type: "set-layer"; layer: keyof ImageLayerVisibility; visible: boolean }
  | { type: "restore"; viewport: ImageViewportState }
  | { type: "restore-zoom"; zoom: number }
  | { type: "reset-view" }
  | { type: "page-changed" }
  | { type: "focus-mode-changed" };

export const MIN_IMAGE_ZOOM = 0.25;
export const MAX_IMAGE_ZOOM = 4;
export const IMAGE_ZOOM_STEP = 0.25;

export function createImageViewportState(): ImageViewportState {
  return {
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
  };
}

export function clampImageZoom(zoom: number): number {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, zoom));
}

export function imageViewportReducer(state: ImageViewportState, action: ImageViewportAction): ImageViewportState {
  switch (action.type) {
    case "set-view":
      return {
        ...state,
        viewMode: action.viewMode,
        zoom: clampImageZoom(action.zoom ?? 1),
        pan: { x: 0, y: 0 }
      };
    case "set-zoom":
      return { ...state, viewMode: "actual", zoom: clampImageZoom(action.zoom) };
    case "set-pan":
      return { ...state, pan: action.pan };
    case "set-layer":
      return { ...state, layers: { ...state.layers, [action.layer]: action.visible } };
    case "restore":
      return {
        viewMode: action.viewport.viewMode,
        zoom: clampImageZoom(action.viewport.zoom),
        pan: { ...action.viewport.pan },
        layers: { ...action.viewport.layers }
      };
    case "restore-zoom": {
      const zoom = clampImageZoom(action.zoom);
      return { ...state, viewMode: zoom === 1 ? "fit" : "actual", zoom, pan: { x: 0, y: 0 } };
    }
    case "reset-view":
    case "page-changed":
      return { ...createImageViewportState(), layers: state.layers };
    case "focus-mode-changed":
      return state;
  }
}
