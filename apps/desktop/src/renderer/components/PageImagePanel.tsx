import { Button } from "./Ui.js";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
// Inkline Production Bench: the image surface remains primary; inactive image tools recede until a page is connected.
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  UIEvent as ReactUIEvent
} from "react";
import type { InpaintingMode, InpaintingProvider } from "../../shared/inpainting";
import type { PageImage } from "../../shared/projectTypes";
import type { NormalizedBbox } from "../../shared/speechBubbleExtraction";
import {
  IMAGE_ZOOM_STEP,
  clampImageZoom,
  createImageViewportState,
  imageViewportReducer,
  type ImageViewMode,
  type ImageViewportState
} from "../imageViewport";
import { type OverlayKind, type ResultLayer } from "../trioState";
import {
  OVERLAY_KIND_ORDER,
  type SemanticOverlayBbox,
  type SemanticOverlayDescriptor
} from "../semanticOverlays";
import {
  COMPARISON_OPACITY_STEP,
  clampComparisonOpacity,
  clampRevealPosition,
  comparisonStateReducer,
  createComparisonState,
  isEditableComparisonTarget,
  stepComparisonOpacity,
  stepRevealPosition,
  type ComparisonMode
} from "../comparisonState";
import {
  createMissingResultLayer,
  createOriginalResultLayer,
  type ResultLayerDescriptor
} from "../resultLayers";
import type { InpaintingMaskDraft } from "../inpaintingMaskDraft";
import type { TypesettingDraft, TypesettingSafeArea } from "../typesettingGeometry";
import { InpaintingEditor } from "./InpaintingEditor";
import { InpaintingQaStatusBadge } from "./InpaintingQaStatusBadge";
import { SemanticOverlayLayer } from "./SemanticOverlayLayer";
import { SemanticOverlayLegend } from "./SemanticOverlayLayer";
import { TypesettingBoxEditor } from "./TypesettingBoxEditor";
import { ManualTypesettingBoxEditor, type ManualTypesettingBoxEditorProps } from "./ManualTypesettingBoxEditor";

type Props = {
  currentPage: number;
  currentFilePath: string | null;
  image: PageImage | null;
  resetKey?: string;
  renderRequestKey?: string;
  resultLayer?: ResultLayer;
  resultLayers?: Record<ResultLayer, ResultLayerDescriptor>;
  cleanedReview?: {
    assetId: string;
    assetSha256: string;
    sourceSha256: string;
    reviewed: boolean;
    disabledReason?: string;
    busy?: boolean;
    onConfirm: (assetId: string) => void;
  };
  onResultLayerChange?: (layer: ResultLayer) => void;
  onResultLayerRetry?: (layer: ResultLayer) => void;
  activeOcrBbox?: NormalizedBbox | null;
  stageHint?: string;
  semanticOverlays?: readonly SemanticOverlayDescriptor[];
  dialogueTargets?: readonly { id: string; order: number; bbox: SemanticOverlayBbox; selected: boolean }[];
  onSelectLine?: (lineId: string) => void;
  visibleOverlayKinds?: readonly OverlayKind[];
  onVisibleOverlayKindsChange?: (kinds: readonly OverlayKind[]) => void;
  overlayMaxUnselected?: number;
  onInpaintingMaskBoundsChange?: (bbox: SemanticOverlayBbox | null) => void;
  typesettingDraft?: TypesettingDraft | null;
  typesettingSafeArea?: TypesettingSafeArea | null;
  typesettingPreviewText?: string;
  onTypesettingDraftChange?: (draft: TypesettingDraft) => void;
  manualTypesetting?: ManualTypesettingBoxEditorProps & { key: string };

  initialMaskDraft?: InpaintingMaskDraft | null;
  onInpaintingMaskDraftChange?: (draft: InpaintingMaskDraft | null) => void;
  focusRequest?: PageImageFocusRequest;
  initialViewport?: {
    key: string;
    zoom: number;
    preserveInpainting?: boolean;
    viewMode?: ImageViewMode;
    pan?: ImageViewportState["pan"];
    layers?: ImageViewportState["layers"];
  };
  uploadDisabledReason?: string;
  ocrDisabledReason?: string;
  inpaintingDisabledReason?: string;
  precisionEditingDisabled?: boolean;
  onImportImages: () => Promise<void>;
  onInpaintImage: (args: {
    maskPngBase64: string;
    mode: InpaintingMode;
    provider: InpaintingProvider;
    promptOverride?: string;
    options?: {
      conservative?: boolean;
      skipOnLowConfidence?: boolean;
      dilatePixels?: number;
    };
  }) => Promise<boolean>;
  onCancelInpainting?: () => void;
  onExtractSpeechBubbles: () => Promise<void>;
  onImageLoadFailedChange?: (failed: boolean) => void;
  onRenderStateChange?: (state: PageImageRenderState) => void;
  onViewportZoomChange?: (zoom: number) => void;
  onViewportChange?: (viewport: ImageViewportState) => void;
  onViewportChangeWithIdentity?: (viewport: ImageViewportState, renderRequestKey: string, renderGeneration: number) => void;
  initialComparisonState?: {
    key: string;
    mode: ComparisonMode;
    revealPosition: number;
    opacity: number;
  };
  onComparisonStateChange?: (state: {
    mode: ComparisonMode;
    revealPosition: number;
    opacity: number;
  }) => void;
  isInpainting?: boolean;
  isExtractingSpeechBubbles?: boolean;
  inpaintingOpen?: boolean;
  onInpaintingOpenChange?: (open: boolean) => void;
  imageFit?: "fit" | "actual";
  onImageFitChange?: (fit: "fit" | "actual") => void;
};

export type PageImageRenderState = {
  status: "loading" | "ready" | "failed";
  currentPage: number;
  pageImageId: string | null;
  renderRequestKey: string;
  renderGeneration: number;
};

export type PageImageFocusRequest = {
  key: string;
  bbox?: SemanticOverlayBbox | null;
};

export type FocusPanInput = {
  stageWidth: number;
  stageHeight: number;
  mediaWidth: number;
  mediaHeight: number;
  bbox?: SemanticOverlayBbox | null;
};

/** Return the bounded scroll offset that places an overlay center in the viewport. */
export function getFocusPan({ stageWidth, stageHeight, mediaWidth, mediaHeight, bbox }: FocusPanInput) {
  const centerX = ((bbox?.x ?? 0.4) + (bbox?.width ?? 0.2) / 2) * mediaWidth;
  const centerY = ((bbox?.y ?? 0.4) + (bbox?.height ?? 0.2) / 2) * mediaHeight;
  return {
    x: Math.max(0, Math.min(Math.max(0, mediaWidth - stageWidth), centerX - stageWidth / 2)),
    y: Math.max(0, Math.min(Math.max(0, mediaHeight - stageHeight), centerY - stageHeight / 2))
  };
}

type ResolvedImageSource = {
  storedRelativePath: string;
  src: string;
  resolved?: boolean;
};

type ResultImageIdentity = {
  layer: ResultLayer;
  id: string;
  storedRelativePath: string;
};

export function PageImagePanel({
  currentPage,
  currentFilePath,
  image,
  resetKey,
  renderRequestKey: controlledRenderRequestKey,
  resultLayer: controlledResultLayer,
  resultLayers,
  cleanedReview,
  onResultLayerChange,
  onResultLayerRetry,
  activeOcrBbox,
  stageHint,
  semanticOverlays,
  dialogueTargets = [],
  onSelectLine,
  visibleOverlayKinds: controlledVisibleOverlayKinds,
  onVisibleOverlayKindsChange,
  overlayMaxUnselected,
  onInpaintingMaskBoundsChange,
  typesettingDraft,
  typesettingSafeArea,
  typesettingPreviewText,
  onTypesettingDraftChange,
  manualTypesetting,
  initialMaskDraft,

  onInpaintingMaskDraftChange,
  focusRequest,
  initialViewport,
  uploadDisabledReason,
  ocrDisabledReason,
  inpaintingDisabledReason,
  precisionEditingDisabled = false,
  onImportImages,
  onInpaintImage,
  onCancelInpainting = () => undefined,
  onExtractSpeechBubbles,
  onImageLoadFailedChange,
  onRenderStateChange,
  onViewportZoomChange,
  onViewportChange,
  onViewportChangeWithIdentity,
  initialComparisonState,
  onComparisonStateChange,
  isInpainting = false,
  isExtractingSpeechBubbles = false,
  inpaintingOpen,
  onInpaintingOpenChange,
  imageFit: controlledImageFit,
  onImageFitChange
}: Props) {
  const [viewport, dispatchViewport] = useReducer(imageViewportReducer, undefined, createImageViewportState);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const [uncontrolledResultLayer, setUncontrolledResultLayer] = useState<ResultLayer>("original");
  const [resultRenderFailedIdentity, setResultRenderFailedIdentity] = useState<ResultImageIdentity | null>(null);
  const [resultFailureDismissedIdentity, setResultFailureDismissedIdentity] = useState<ResultImageIdentity | null>(null);
  const [resultRetryNonce, setResultRetryNonce] = useState(0);
  const [imageNaturalSize, setImageNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [resolvedImageSource, setResolvedImageSource] = useState<ResolvedImageSource | null>(null);
  const [resolvedOriginalImageSource, setResolvedOriginalImageSource] = useState<ResolvedImageSource | null>(null);
  const [resolvedComparisonImageSource, setResolvedComparisonImageSource] = useState<ResolvedImageSource | null>(null);
  const [resolvedSourceImage, setResolvedSourceImage] = useState<ResolvedImageSource | null>(null);
  const [reviewLoads, setReviewLoads] = useState<{ identity: string; original: boolean; cleaned: boolean } | null>(null);
  const [uncontrolledEditorOpen, setUncontrolledEditorOpen] = useState(false);
  const [uncontrolledVisibleOverlayKinds, setUncontrolledVisibleOverlayKinds] = useState<OverlayKind[]>(() => [
    ...OVERLAY_KIND_ORDER
  ]);
  const [comparisonState, dispatchComparison] = useReducer(
    comparisonStateReducer,
    undefined,
    createComparisonState
  );
  const comparisonHydrationKeyRef = useRef<string | null>(null);
  const hasMountedRef = useRef(false);
  const previousProjectScopeRef = useRef<string | null>(null);
  const renderGenerationRef = useRef(0);
  const renderSeedRef = useRef("");
  const renderSeed = `${currentPage}:${image?.id ?? "none"}:${resetKey ?? ""}:${controlledRenderRequestKey ?? ""}`;
  if (renderSeedRef.current !== renderSeed) {
    renderSeedRef.current = renderSeed;
    renderGenerationRef.current += 1;
  }
  const renderRequestIdentity = `${renderSeed}:${renderGenerationRef.current}`;
  const renderCallbackKey = controlledRenderRequestKey ?? renderSeed;
  const notifyRenderState = (status: PageImageRenderState["status"]) => {
    onRenderStateChange?.({
      status,
      currentPage,
      pageImageId: image?.id ?? null,
      renderRequestKey: renderCallbackKey,
      renderGeneration: renderGenerationRef.current
    });
  };
  const stageRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    target: HTMLDivElement;
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const comparisonDragRef = useRef<{ pointerId: number; target: HTMLDivElement } | null>(null);
  const viewMode: ImageViewMode = controlledImageFit ?? viewport.viewMode;
  const selectedResultLayer = controlledResultLayer ?? uncontrolledResultLayer;
  const visibleOverlayKinds = controlledVisibleOverlayKinds ?? uncontrolledVisibleOverlayKinds;
  const semanticOverlayDescriptors = useMemo<SemanticOverlayDescriptor[]>(() => {
    const descriptors = [...(semanticOverlays ?? [])].filter((overlay) =>
      !(typesettingDraft && overlay.kind === "typeset" && overlay.id === `typeset:${typesettingDraft.sourceOcrId}`)
    );
    const activeOcrIndex = activeOcrBbox
      ? descriptors.findIndex((overlay) => overlay.kind === "ocr" && sameOverlayBbox(overlay.bbox, activeOcrBbox))
      : -1;
    if (activeOcrBbox && activeOcrIndex >= 0) {
      descriptors[activeOcrIndex] = {
        ...descriptors[activeOcrIndex],
        label: stageHint ?? descriptors[activeOcrIndex].label ?? "선택된 OCR 영역",
        accessibleLabel: "선택된 OCR 영역",
        className: "page-image-ocr-highlight",
        selected: true
      };
    } else if (activeOcrBbox) {
      descriptors.push({
        id: "active-ocr",
        kind: "ocr",
        bbox: activeOcrBbox,
        label: stageHint ?? "선택된 OCR 영역",
        accessibleLabel: "선택된 OCR 영역",
        className: "page-image-ocr-highlight",
        selected: true
      });
    }
    return descriptors;
  }, [activeOcrBbox, semanticOverlays, stageHint, typesettingDraft]);
  const semanticOverlayVisibleKinds = viewport.layers.ocr
    ? visibleOverlayKinds
    : visibleOverlayKinds.filter((kind) => kind !== "ocr");
  const resolvedResultLayers = useMemo<Record<ResultLayer, ResultLayerDescriptor>>(
    () => resultLayers ?? {
      original: createOriginalResultLayer(image),
      inpainted: createMissingResultLayer("inpainted", "인페인팅 결과가 아직 없습니다.", image),
      translated: createMissingResultLayer("translated", "번역 결과가 아직 생성되지 않았습니다.", image)
    },
    [image, resultLayers]
  );
  const selectedResultDescriptor = resolvedResultLayers[selectedResultLayer];
  const selectedResultImage = selectedResultLayer === "original"
    ? (selectedResultDescriptor.image ?? image)
    : selectedResultDescriptor.image;
  const selectedResultIdentity = selectedResultImage
    ? {
        layer: selectedResultLayer,
        id: selectedResultImage.id,
        storedRelativePath: selectedResultImage.storedRelativePath
      }
    : null;
  const selectedResultFailed = selectedResultLayer !== "original" && (
    matchesResultImageIdentity(resultRenderFailedIdentity, selectedResultIdentity) ||
    (selectedResultDescriptor.status === "render-failed" && !matchesResultImageIdentity(resultFailureDismissedIdentity, selectedResultIdentity))
  );
  const displayedImage = selectedResultFailed || !selectedResultImage
    ? (selectedResultLayer === "original" ? null : selectedResultDescriptor.fallbackImage ?? image)
    : selectedResultImage;
  const displayedImageIsFallback = selectedResultLayer !== "original" && displayedImage !== selectedResultImage;
  const originalImage = resolvedResultLayers.original.image ?? image;
  const comparisonResultImage = selectedResultLayer === "original"
    ? null
    : selectedResultFailed || !selectedResultImage
      ? selectedResultDescriptor.fallbackImage ?? originalImage
      : selectedResultImage;
  const effectiveComparisonMode: ComparisonMode = comparisonState.holdingOriginal && selectedResultLayer !== "original"
    ? "single"
    : comparisonState.mode;
  const showingHeldOriginal = comparisonState.holdingOriginal && selectedResultLayer !== "original";
  const singleImage = showingHeldOriginal ? originalImage : displayedImage;
  const resolvedImageSrc = resolvedImageSource && displayedImage && resolvedImageSource.storedRelativePath === displayedImage.storedRelativePath
    ? resolvedImageSource.src
    : null;
  const editorOpen = inpaintingOpen === undefined ? uncontrolledEditorOpen : inpaintingOpen || uncontrolledEditorOpen;
  const reviewedAsset = selectedResultDescriptor.asset;
  const reviewAssetMatches = Boolean(cleanedReview && image && selectedResultImage && reviewedAsset &&
    selectedResultLayer === "inpainted" && reviewedAsset.role === "cleaned" &&
    reviewedAsset.sourcePageImageId === image.id && image.sha256 === cleanedReview.sourceSha256 &&
    reviewedAsset.assetId === cleanedReview.assetId && reviewedAsset.sha256 === cleanedReview.assetSha256 &&
    selectedResultImage.id === reviewedAsset.assetId && selectedResultImage.sha256 === reviewedAsset.sha256 &&
    selectedResultImage.storedRelativePath === reviewedAsset.storedRelativePath);
  const reviewIdentity = JSON.stringify([
    renderRequestIdentity, currentFilePath, image?.id, image?.sha256, reviewedAsset?.assetId,
    reviewedAsset?.sha256, reviewedAsset?.storedRelativePath, selectedResultLayer, resultRetryNonce,
    effectiveComparisonMode, showingHeldOriginal, resolvedImageSource?.src, resolvedImageSource?.resolved,
    resolvedOriginalImageSource?.src, resolvedOriginalImageSource?.resolved,
    resolvedComparisonImageSource?.src, resolvedComparisonImageSource?.resolved
  ]);
  const reviewIdentityRef = useRef(reviewIdentity);
  reviewIdentityRef.current = reviewIdentity;
  const loadedReview = reviewLoads?.identity === reviewIdentity ? reviewLoads : null;
  const singleCleanedResolved = Boolean(resolvedImageSource?.resolved &&
    resolvedImageSource.storedRelativePath === reviewedAsset?.storedRelativePath);
  const originalResolved = Boolean(resolvedOriginalImageSource?.resolved && image && originalImage &&
    originalImage.id === image.id && originalImage.sha256 === image.sha256 &&
    resolvedOriginalImageSource.storedRelativePath === image.storedRelativePath);
  const comparisonCleanedResolved = Boolean(resolvedComparisonImageSource?.resolved &&
    resolvedComparisonImageSource.storedRelativePath === reviewedAsset?.storedRelativePath);
  const reviewReady = Boolean(reviewAssetMatches && !showingHeldOriginal && !editorOpen &&
    viewport.layers.original && !imageLoadFailed && !selectedResultFailed && !displayedImageIsFallback &&
    !selectedResultDescriptor.processing && !selectedResultDescriptor.stale &&
    (effectiveComparisonMode !== "opacity" || comparisonState.opacity > 0) &&
    (effectiveComparisonMode !== "reveal" || comparisonState.revealPosition < 100) &&
    (selectedResultDescriptor.status === "ready" || selectedResultDescriptor.status === "partial-failure") &&
    (effectiveComparisonMode === "single"
      ? singleCleanedResolved && loadedReview?.cleaned
      : originalResolved && comparisonCleanedResolved && loadedReview?.original && loadedReview.cleaned));
  const reviewDisabledReason = cleanedReview?.disabledReason ?? (cleanedReview?.busy
    ? "확인 기록을 저장하고 있습니다."
    : !reviewAssetMatches ? "현재 페이지의 확인 가능한 배경 정리 결과가 아닙니다."
      : !reviewReady ? "현재 배경 정리 결과를 화면에 표시한 뒤 확인할 수 있습니다."
        : undefined);

  function markReviewLoaded(identity: string, surface: "original" | "cleaned") {
    if (reviewIdentityRef.current !== identity) return;
    setReviewLoads((current) => ({
      identity,
      original: surface === "original" || (current?.identity === identity && current.original),
      cleaned: surface === "cleaned" || (current?.identity === identity && current.cleaned)
    }));
  }
  const imageStateLabel = displayedImage ? displayedImage.originalFileName : getEmptyImageHint(uploadDisabledReason, currentPage);
  const canImportImage = uploadDisabledReason === undefined;
  // The editor must operate on the same page image that App sends to IPC.
  // Result selection must not redirect a subsequent request to another layer.
  const editorSourceImage = image;
  const editorImageSrc = resolvedSourceImage && editorSourceImage && resolvedSourceImage.storedRelativePath === editorSourceImage.storedRelativePath
    ? resolvedSourceImage.src
    : editorSourceImage?.storedRelativePath ?? null;
  const editorDisabled = !editorSourceImage || imageLoadFailed || !currentFilePath || !canImportImage || isInpainting || inpaintingDisabledReason !== undefined || precisionEditingDisabled;
  const speechBubbleOcrDisabled = !image || !currentFilePath || isExtractingSpeechBubbles || ocrDisabledReason !== undefined;

  useLayoutEffect(() => {
    const preserveControlledEditor = !hasMountedRef.current && initialViewport?.preserveInpainting === true;
    const projectScope = `${currentFilePath ?? ""}:${resetKey ?? ""}`;
    const projectScopeChanged = previousProjectScopeRef.current !== projectScope;
    previousProjectScopeRef.current = projectScope;
    hasMountedRef.current = true;
    setImageLoadFailed(false);
    setResultRenderFailedIdentity(null);
    setResultFailureDismissedIdentity(null);
    setResultRetryNonce(0);
    setImageNaturalSize(null);
    setResolvedImageSource(null);
    resetStageInteraction();
    dispatchViewport({ type: "page-changed" });
    if (!preserveControlledEditor && (!onInpaintingOpenChange || projectScopeChanged)) closeEditor();
  }, [currentFilePath, currentPage, resetKey]);

  useLayoutEffect(() => {
    if (!initialViewport) return;
    resetStageInteraction();
    if (initialViewport.viewMode && initialViewport.pan && initialViewport.layers) {
      dispatchViewport({
        type: "restore",
        viewport: {
          viewMode: initialViewport.viewMode,
          zoom: initialViewport.zoom,
          pan: initialViewport.pan,
          layers: initialViewport.layers
        }
      });
      const stage = stageRef.current;
      if (stage) {
        stage.scrollLeft = initialViewport.pan.x;
        stage.scrollTop = initialViewport.pan.y;
      }
      return;
    }
    dispatchViewport({ type: "restore-zoom", zoom: initialViewport.zoom });
  }, [initialViewport?.key]);

  useLayoutEffect(() => {
    if (!initialComparisonState || comparisonHydrationKeyRef.current === initialComparisonState.key) return;
    comparisonHydrationKeyRef.current = initialComparisonState.key;
    dispatchComparison({ type: "set-mode", mode: initialComparisonState.mode });
    dispatchComparison({ type: "set-reveal-position", position: initialComparisonState.revealPosition });
    dispatchComparison({ type: "set-opacity", opacity: initialComparisonState.opacity });
    // Holding the original is a transient key gesture and is never persisted.
    dispatchComparison({ type: "release-original" });
  }, [initialComparisonState?.key]);

  useEffect(() => {
    if (!comparisonHydrationKeyRef.current) return;
    onComparisonStateChange?.({
      mode: comparisonState.mode,
      revealPosition: comparisonState.revealPosition,
      opacity: comparisonState.opacity
    });
  }, [comparisonState.mode, comparisonState.revealPosition, comparisonState.opacity, onComparisonStateChange]);

  useLayoutEffect(() => {
    if (!initialViewport?.pan) return;
    const stage = stageRef.current;
    if (!stage) return;
    stage.scrollLeft = initialViewport.pan.x;
    stage.scrollTop = initialViewport.pan.y;
  }, [initialViewport?.key, initialViewport?.pan?.x, initialViewport?.pan?.y, imageNaturalSize?.width, imageNaturalSize?.height]);

  useLayoutEffect(() => {
    if (!focusRequest || imageLoadFailed || !singleImage || !mediaRef.current || !stageRef.current) return;
    const stage = stageRef.current;
    const media = mediaRef.current;
    const nextPan = getFocusPan({
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
      mediaWidth: media.scrollWidth || media.clientWidth,
      mediaHeight: media.scrollHeight || media.clientHeight,
      bbox: focusRequest.bbox
    });
    stage.scrollLeft = nextPan.x;
    stage.scrollTop = nextPan.y;
    dispatchViewport({ type: "set-pan", pan: nextPan });
  }, [focusRequest?.key, focusRequest?.bbox, imageLoadFailed, imageNaturalSize?.width, imageNaturalSize?.height, singleImage]);

  useEffect(() => {
    notifyRenderState(imageLoadFailed ? "failed" : displayedImage ? "loading" : "ready");
  }, [currentPage, displayedImage?.id, image?.id, imageLoadFailed, renderRequestIdentity]);

  useEffect(() => {
    onViewportChange?.(viewport);
    onViewportChangeWithIdentity?.(viewport, renderCallbackKey, renderGenerationRef.current);
  }, [onViewportChange, onViewportChangeWithIdentity, viewport, renderCallbackKey]);

  useEffect(() => {
    setImageNaturalSize(null);
  }, [displayedImage?.id, displayedImage?.storedRelativePath]);

  useEffect(() => {
    if (effectiveComparisonMode !== "single" || showingHeldOriginal) {
      setResolvedImageSource(null);
      return;
    }
    if (!displayedImage) {
      setResolvedImageSource(null);
      return;
    }
    if (!currentFilePath || !window.projectApi?.resolvePageImageSrc) {
      setResolvedImageSource({
        storedRelativePath: displayedImage.storedRelativePath,
        src: displayedImage.storedRelativePath
      });
      return;
    }

    let canceled = false;
    window.projectApi
      .resolvePageImageSrc({
        ...(currentFilePath.startsWith("session:")
          ? { projectSessionId: currentFilePath.slice("session:".length) }
          : { projectFilePath: currentFilePath }),
        storedRelativePath: displayedImage.storedRelativePath
      })
      .then((src) => {
        if (!canceled) {
          setResolvedImageSource({ storedRelativePath: displayedImage.storedRelativePath, src, resolved: true });
        }
      })
      .catch(() => {
          if (!canceled) {
            setResolvedImageSource({
              storedRelativePath: displayedImage.storedRelativePath,
              src: displayedImage.storedRelativePath
            });
          if (selectedResultLayer === "original") {
            setImageLoadFailed(true);
            notifyRenderState("failed");
          }
          else if (selectedResultIdentity) setResultRenderFailedIdentity(selectedResultIdentity);
        }
      });

    return () => {
      canceled = true;
    };
  }, [currentFilePath, displayedImage, resultRetryNonce, selectedResultLayer, effectiveComparisonMode, showingHeldOriginal]);

  useEffect(() => {
    let canceled = false;
    if (effectiveComparisonMode === "single" && !showingHeldOriginal) {
      setResolvedOriginalImageSource(null);
      setResolvedComparisonImageSource(null);
      return;
    }
    const resolveComparisonSource = async (
      target: PageImage | null,
      setter: (source: ResolvedImageSource | null) => void
    ) => {
      if (!target) {
        setter(null);
        return;
      }
      if (!currentFilePath || !window.projectApi?.resolvePageImageSrc) {
        setter({ storedRelativePath: target.storedRelativePath, src: target.storedRelativePath });
        return;
      }
      try {
        const src = await window.projectApi.resolvePageImageSrc({
          ...(currentFilePath.startsWith("session:")
            ? { projectSessionId: currentFilePath.slice("session:".length) }
            : { projectFilePath: currentFilePath }),
          storedRelativePath: target.storedRelativePath
        });
        if (!canceled) setter({ storedRelativePath: target.storedRelativePath, src, resolved: true });
      } catch {
        if (!canceled) setter({ storedRelativePath: target.storedRelativePath, src: target.storedRelativePath });
      }
    };

    void resolveComparisonSource(originalImage, setResolvedOriginalImageSource);
    void resolveComparisonSource(comparisonResultImage, setResolvedComparisonImageSource);
    return () => {
      canceled = true;
    };
  }, [
    comparisonResultImage?.id,
    comparisonResultImage?.storedRelativePath,
    currentFilePath,
    originalImage?.id,
    originalImage?.storedRelativePath,
    resultRetryNonce,
    effectiveComparisonMode,
    showingHeldOriginal
  ]);

  useEffect(() => {
    if (!editorSourceImage) {
      setResolvedSourceImage(null);
      return;
    }
    if (!currentFilePath || !window.projectApi?.resolvePageImageSrc) {
      setResolvedSourceImage({
        storedRelativePath: editorSourceImage.storedRelativePath,
        src: editorSourceImage.storedRelativePath
      });
      return;
    }

    let canceled = false;
    window.projectApi
      .resolvePageImageSrc({
        ...(currentFilePath.startsWith("session:")
          ? { projectSessionId: currentFilePath.slice("session:".length) }
          : { projectFilePath: currentFilePath }),
        storedRelativePath: editorSourceImage.storedRelativePath
      })
      .then((src) => {
        if (!canceled) {
          setResolvedSourceImage({ storedRelativePath: editorSourceImage.storedRelativePath, src });
        }
      })
      .catch(() => {
        if (!canceled) {
          setResolvedSourceImage({
            storedRelativePath: editorSourceImage.storedRelativePath,
            src: editorSourceImage.storedRelativePath
          });
        }
      });

    return () => {
      canceled = true;
    };
  }, [currentFilePath, editorSourceImage]);

  useEffect(() => {
    if (inpaintingOpen === false) setUncontrolledEditorOpen(false);
  }, [inpaintingOpen]);

  useEffect(() => {
    onImageLoadFailedChange?.(imageLoadFailed);
  }, [imageLoadFailed, onImageLoadFailedChange]);

  const changeZoomRef = useRef(changeZoom);
  changeZoomRef.current = changeZoom;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleCtrlWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      changeZoomRef.current(event.deltaY < 0 ? IMAGE_ZOOM_STEP : -IMAGE_ZOOM_STEP);
    };
    stage.addEventListener("wheel", handleCtrlWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleCtrlWheel);
  }, [image]);

  useEffect(() => {
    const isBackslash = (event: KeyboardEvent) => event.key === "\\" || event.code === "Backslash";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isBackslash(event) || isEditableComparisonTarget(event.target)) return;
      event.preventDefault();
      dispatchComparison({ type: "hold-original" });
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isBackslash(event)) return;
      dispatchComparison({ type: "release-original" });
    };
    const handleWindowBlur = () => {
      dispatchComparison({ type: "release-original" });
      const comparisonDrag = comparisonDragRef.current;
      if (comparisonDrag) {
        try {
          comparisonDrag.target.releasePointerCapture?.(comparisonDrag.pointerId);
        } catch {
          // Pointer capture may already have been released by the browser.
        }
      }
      comparisonDragRef.current = null;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  useEffect(() => () => resetStageInteraction(), []);

  function closeEditor() {
    setUncontrolledEditorOpen(false);
    if (onInpaintingOpenChange) {
      onInpaintingOpenChange(false);
    } else {
      onInpaintingMaskBoundsChange?.(null);
    }
  }

  function changeView(view: ImageViewMode, zoom = 1) {
    resetStageInteraction();
    dispatchViewport({ type: "set-view", viewMode: view, zoom });
    onViewportZoomChange?.(zoom);
    if (view !== "width") onImageFitChange?.(view === "fit" ? "fit" : "actual");
  }

  function changeZoom(delta: number) {
    const zoom = clampImageZoom(viewport.zoom + delta);
    resetStageInteraction();
    dispatchViewport({ type: "set-zoom", zoom });
    onViewportZoomChange?.(zoom);
    onImageFitChange?.("actual");
  }

  function selectResultLayer(layer: ResultLayer) {
    setImageLoadFailed(false);
    if (layer !== selectedResultLayer) {
      setResultRenderFailedIdentity(null);
      setResultFailureDismissedIdentity(null);
    }
    setUncontrolledResultLayer(layer);
    onResultLayerChange?.(layer);
  }

  function retryResultLayer(layer: ResultLayer) {
    setResultRenderFailedIdentity(null);
    if (selectedResultIdentity?.layer === layer) setResultFailureDismissedIdentity(selectedResultIdentity);
    setResolvedImageSource(null);
    setResultRetryNonce((current) => current + 1);
    onResultLayerRetry?.(layer);
    if (layer !== selectedResultLayer) selectResultLayer(layer);
  }

  function setComparisonMode(mode: ComparisonMode) {
    dispatchComparison({ type: "set-mode", mode });
  }

  function toggleOverlayKind(kind: OverlayKind) {
    const nextKinds = visibleOverlayKinds.includes(kind)
      ? visibleOverlayKinds.filter((currentKind) => currentKind !== kind)
      : [...visibleOverlayKinds, kind];
    setUncontrolledVisibleOverlayKinds(nextKinds);
    onVisibleOverlayKindsChange?.(nextKinds);
  }

  function setRevealPositionFromPointer(clientX: number, target: HTMLElement) {
    const bounds = target.getBoundingClientRect();
    const width = bounds.width || target.clientWidth || 1;
    const position = ((clientX - bounds.left) / width) * 100;
    dispatchComparison({ type: "set-reveal-position", position: clampRevealPosition(position) });
  }

  function handleRevealPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    comparisonDragRef.current = { pointerId: event.pointerId, target: event.currentTarget };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setRevealPositionFromPointer(event.clientX, mediaRef.current ?? event.currentTarget);
  }

  function handleRevealKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      dispatchComparison({
        type: "set-reveal-position",
        position: stepRevealPosition(comparisonState.revealPosition, -1)
      });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      dispatchComparison({
        type: "set-reveal-position",
        position: stepRevealPosition(comparisonState.revealPosition, 1)
      });
    } else if (event.key === "Home") {
      event.preventDefault();
      dispatchComparison({ type: "set-reveal-position", position: 0 });
    } else if (event.key === "End") {
      event.preventDefault();
      dispatchComparison({ type: "set-reveal-position", position: 100 });
    }
  }

  function handleOpacityKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      dispatchComparison({
        type: "set-opacity",
        opacity: stepComparisonOpacity(comparisonState.opacity, -1)
      });
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      dispatchComparison({
        type: "set-opacity",
        opacity: stepComparisonOpacity(comparisonState.opacity, 1)
      });
    }
  }

  function resetStageInteraction() {
    const drag = dragRef.current;
    const stage = stageRef.current ?? drag?.target ?? null;
    if (stage && drag) {
      try {
        stage.releasePointerCapture?.(drag.pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    }
    dragRef.current = null;
    comparisonDragRef.current = null;
    if (stage) {
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage || (stage.scrollWidth <= stage.clientWidth && stage.scrollHeight <= stage.clientHeight)) return;
    dragRef.current = {
      target: stage,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: stage.scrollLeft,
      top: stage.scrollTop
    };
    stage.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    const comparisonDrag = comparisonDragRef.current;
    if (stage && comparisonDrag && comparisonDrag.pointerId === event.pointerId) {
      setRevealPositionFromPointer(event.clientX, mediaRef.current ?? stage);
      return;
    }
    const drag = dragRef.current;
    if (!stage || !drag || drag.pointerId !== event.pointerId) return;
    stage.scrollLeft = drag.left - (event.clientX - drag.x);
    stage.scrollTop = drag.top - (event.clientY - drag.y);
    dispatchViewport({ type: "set-pan", pan: { x: stage.scrollLeft, y: stage.scrollTop } });
  }

  function handleStageScroll(event: ReactUIEvent<HTMLDivElement>) {
    if (dragRef.current) return;
    const stage = event.currentTarget;
    dispatchViewport({ type: "set-pan", pan: { x: stage.scrollLeft, y: stage.scrollTop } });
  }

  function stopPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (comparisonDragRef.current?.pointerId === event.pointerId) {
      const comparisonDrag = comparisonDragRef.current;
      try {
        comparisonDrag.target.releasePointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
      comparisonDragRef.current = null;
      return;
    }
    if (dragRef.current?.pointerId !== event.pointerId) return;
    stageRef.current?.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  }

  const visibleResultStatus = selectedResultFailed ? "render-failed" : selectedResultDescriptor.status;
  const resultStatusMessage = selectedResultFailed
    ? "결과를 표시하지 못해 원본으로 전환했습니다. 다시 시도할 수 있습니다."
    : selectedResultDescriptor.message;

  return (
    <section
      className={`page-image-panel${editorOpen ? " editor-open" : ""}`}
      data-has-image={displayedImage ? "true" : "false"}
      aria-label="페이지 이미지"
    >
      <div className="page-image-toolbar">
        <div className="page-image-title">
          <strong>{currentPage}페이지</strong>
          <span>{imageStateLabel}</span>
        </div>
        <div className="page-image-tools" aria-label="이미지 보기 및 레이어 옵션">
          {imageLoadFailed ? <span className="image-error-badge">실패</span> : null}
          <div className="page-image-tool-group" role="group" aria-label="보기 모드">
            <button type="button" aria-label="화면 맞춤" aria-pressed={viewMode === "fit"} onClick={() => changeView("fit")} disabled={!displayedImage}>화면 맞춤</button>
            <button type="button" className="page-image-zoom-action" aria-label="축소" onClick={() => changeZoom(-IMAGE_ZOOM_STEP)} disabled={!displayedImage || viewport.zoom <= 0.25}>−</button>
            <span className="page-image-zoom" aria-live="polite">{Math.round(viewport.zoom * 100)}%</span>
            <button type="button" className="page-image-zoom-action" aria-label="확대" onClick={() => changeZoom(IMAGE_ZOOM_STEP)} disabled={!displayedImage || viewport.zoom >= 4}>+</button>
          </div>
        </div>
        <details className="page-image-advanced">
          <summary>보기·비교</summary>
          <div className="page-image-advanced-content">
          <div className="page-image-tool-group" role="group" aria-label="추가 보기 모드">
            <button type="button" aria-label="너비 맞춤" aria-pressed={viewMode === "width"} onClick={() => changeView("width")} disabled={!displayedImage}>너비 맞춤</button>
            <button type="button" aria-label="100%" aria-pressed={viewMode === "actual" && viewport.zoom === 1} onClick={() => changeView("actual")} disabled={!displayedImage}>100%</button>
            <button type="button" aria-label="보기 초기화" onClick={() => changeView("fit")} disabled={!displayedImage}>초기화</button>
          </div>
          {resultLayers ? (
            <div className="page-image-tool-group page-image-result-layer-group" role="group" aria-label="결과 레이어">
              {(["original", "inpainted", "translated"] as const).map((layer) => {
                const descriptor = resolvedResultLayers[layer];
                const label = layer === "original" ? "원본" : layer === "inpainted" ? "인페인팅" : "식자/번역";
                return (
                  <button
                    key={layer}
                    type="button"
                    aria-label={`${label} 결과`}
                    aria-pressed={selectedResultLayer === layer}
                    title={descriptor.message}
                    onClick={() => selectResultLayer(layer)}
                    disabled={!image}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="page-image-tool-group page-image-comparison-group" role="group" aria-label="비교 모드">
            {(["single", "split", "reveal", "opacity"] as const).map((mode) => {
              const label = mode === "single" ? "단일" : mode === "split" ? "분할" : mode === "reveal" ? "슬라이더" : "투명도";
              return (
                <button
                  key={mode}
                  type="button"
                  aria-label={`${label} 비교`}
                  aria-pressed={comparisonState.mode === mode}
                  onClick={() => setComparisonMode(mode)}
                  disabled={!image}
                >
                  {label}
                </button>
              );
            })}
            {comparisonState.mode === "opacity" ? (
              <>
                <input
                  type="range"
                  aria-label="비교 투명도"
                  min="0"
                  max="100"
                  step={COMPARISON_OPACITY_STEP * 100}
                  value={Math.round(comparisonState.opacity * 100)}
                  onChange={(event) => {
                    dispatchComparison({
                      type: "set-opacity",
                      opacity: clampComparisonOpacity(Number(event.currentTarget.value) / 100)
                    });
                  }}
                  onKeyDown={handleOpacityKeyDown}
                  aria-valuenow={Math.round(comparisonState.opacity * 100)}
                  aria-valuetext={`${Math.round(comparisonState.opacity * 100)}%`}
                />
                <span aria-live="polite">{Math.round(comparisonState.opacity * 100)}%</span>
              </>
            ) : null}
          </div>
          <div className="page-image-tool-group" role="group" aria-label="레이어">
            <button type="button" aria-label="원본 레이어" aria-pressed={viewport.layers.original} onClick={() => dispatchViewport({ type: "set-layer", layer: "original", visible: !viewport.layers.original })} disabled={!displayedImage}>원본</button>
            <button type="button" aria-label="OCR 레이어" aria-pressed={viewport.layers.ocr} onClick={() => dispatchViewport({ type: "set-layer", layer: "ocr", visible: !viewport.layers.ocr })} disabled={!displayedImage}>OCR</button>
            <button type="button" aria-label="원문 레이어 미지원" disabled title="원문 레이어를 사용할 수 없습니다.">원문 (미지원)</button>
            <button type="button" aria-label="번역 레이어 미지원" disabled title="번역 레이어를 사용할 수 없습니다.">번역 (미지원)</button>
            <button type="button" aria-label="최종 레이어 미지원" disabled title="최종 레이어를 사용할 수 없습니다.">최종 (미지원)</button>
          </div>
          <details className="page-image-overlay-dropdown" role="group" aria-label="오버레이 설정">
            <summary className="page-image-overlay-trigger" aria-label="오버레이 메뉴" title="오버레이 범례">
              오버레이
            </summary>
            <SemanticOverlayLegend
              visibleKinds={semanticOverlayVisibleKinds}
              onToggleKind={toggleOverlayKind}
            />
          </details>
          </div>
        </details>
          {resultLayers && selectedResultLayer !== "original" ? (
            <div className="page-image-result-status" aria-live="polite" data-result-status={visibleResultStatus}>
              <span>{resultStatusMessage}</span>
              {selectedResultLayer === "inpainted" && (selectedResultDescriptor.inpaintingQa || selectedResultDescriptor.asset?.inpaintingQa) ? (
                <InpaintingQaStatusBadge qaResult={selectedResultDescriptor.inpaintingQa || selectedResultDescriptor.asset?.inpaintingQa} />
              ) : null}
              {(selectedResultFailed || selectedResultDescriptor.status === "render-failed") ? (
                <button type="button" onClick={() => retryResultLayer(selectedResultLayer)}>
                  {selectedResultLayer === "inpainted" ? "인페인팅" : "번역"} 결과 다시 시도
                </button>
              ) : null}
            </div>
          ) : null}
          {selectedResultLayer === "inpainted" && cleanedReview ? (
            <div className="page-image-cleaned-review">
              <button type="button" disabled={cleanedReview.reviewed || Boolean(reviewDisabledReason)}
                onClick={() => { if (reviewReady && !cleanedReview.disabledReason && !cleanedReview.busy) cleanedReview.onConfirm(cleanedReview.assetId); }}>
                {cleanedReview.reviewed ? "배경 정리 확인됨" : "배경 정리 확인"}
              </button>
              {!cleanedReview.reviewed && reviewDisabledReason ? <span>{reviewDisabledReason}</span> : null}
            </div>
          ) : null}
      </div>
      {singleImage && displayedImage ? (
        <div
          ref={stageRef}
          data-testid="page-image-viewport"
          data-view-mode={viewMode}
          className={`page-image-stage page-image-stage-${viewMode}`}
          tabIndex={0}
          aria-label="이미지 뷰포트 (키보드: +/-로 확대/축소, 0으로 맞춤)"
          onScroll={handleStageScroll}
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest("button, textarea, input, select, .typesetting-box-handle")) return;
            if (viewMode === "fit") {
              changeView("actual");
            } else {
              changeView("fit");
            }
          }}
          onKeyDown={(event) => {
            if ((event.target as HTMLElement).closest("button, textarea, input, select, .typesetting-box-handle")) return;
            if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              changeZoom(IMAGE_ZOOM_STEP);
            } else if (event.key === "-" || event.key === "_") {
              event.preventDefault();
              changeZoom(-IMAGE_ZOOM_STEP);
            } else if (event.key === "0") {
              event.preventDefault();
              changeView("fit");
            }
          }}
          onPointerDown={handlePointerDown}


          onPointerMove={handlePointerMove}
          onPointerUp={stopPan}
          onPointerCancel={stopPan}
          onLostPointerCapture={() => {
            dragRef.current = null;
            comparisonDragRef.current = null;
          }}
        >
          {imageLoadFailed ? (
            <div className="page-image-empty page-image-error">
              <strong>이미지 파일을 불러오지 못했습니다.</strong>
              <span>{displayedImage.originalFileName} 파일을 다시 연결하세요.</span>
              {ocrDisabledReason ? (
                <p id="page-image-ocr-disabled-reason" className="page-image-capability-reason" role="status">
                  환경 준비에서 OCR 상태를 확인하세요. {ocrDisabledReason}
                </p>
              ) : null}
              <div className="page-image-error-actions">
                <button type="button" onClick={onImportImages} disabled={!canImportImage}>이미지 다시 연결</button>
                <button
                  type="button"
                  onClick={onExtractSpeechBubbles}
                  disabled={speechBubbleOcrDisabled}
                  aria-describedby={ocrDisabledReason ? "page-image-ocr-disabled-reason" : undefined}
                >
                  OCR 다시 실행
                </button>
              </div>
            </div>
          ) : null}
          <div
            ref={mediaRef}
            data-testid="page-image-media"
            className={`page-image-media${viewMode === "fit" && imageNaturalSize ? " has-image-aspect" : ""}${effectiveComparisonMode !== "single" ? ` page-image-comparison-media page-image-comparison-${effectiveComparisonMode}` : ""}`}
            style={
              viewMode === "fit" && imageNaturalSize
                ? ({
                    "--image-aspect": imageNaturalSize.width / imageNaturalSize.height,
                    "--image-natural-width": `${imageNaturalSize.width}px`,
                    "--image-natural-height": `${imageNaturalSize.height}px`
                  } as CSSProperties)
                : viewMode === "fit"
                  ? undefined
                  : { zoom: viewport.zoom }
            }
          >
            <img
              alt={`${currentPage}페이지 이미지`}
              aria-hidden={!viewport.layers.original}
              data-view-mode={viewMode}
              data-testid="comparison-surface-original"
              hidden={imageLoadFailed}
              key={`${singleImage.storedRelativePath}:${resultRetryNonce}:${controlledRenderRequestKey ?? "uncontrolled"}:${cleanedReview ? reviewIdentity : ""}`}
              className={viewport.layers.original ? undefined : "layer-hidden"}
              draggable={false}
              src={effectiveComparisonMode !== "single" || showingHeldOriginal
                ? resolvedOriginalImageSource?.src ?? singleImage.storedRelativePath
                : resolvedImageSrc ?? singleImage.storedRelativePath}
              onError={() => {
                if (effectiveComparisonMode === "single" && !showingHeldOriginal && selectedResultLayer !== "original" && !displayedImageIsFallback) {
                  if (selectedResultIdentity) setResultRenderFailedIdentity(selectedResultIdentity);
                  setResolvedImageSource(null);
                  return;
                }
                setImageLoadFailed(true);
                notifyRenderState("failed");
              }}
              onLoad={(event) => {
                if (effectiveComparisonMode !== "single" || showingHeldOriginal || selectedResultLayer === "original") setImageLoadFailed(false);
                else if (!displayedImageIsFallback) setResultRenderFailedIdentity(null);
                notifyRenderState("ready");
                if (event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0 &&
                  effectiveComparisonMode === "single" && !showingHeldOriginal && reviewAssetMatches && singleCleanedResolved) {
                  markReviewLoaded(reviewIdentity, "cleaned");
                } else if (event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0 &&
                  effectiveComparisonMode !== "single" && originalResolved) {
                  markReviewLoaded(reviewIdentity, "original");
                }
                if (event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0) {
                  setImageNaturalSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight
                  });
                }
              }}
            />
            {effectiveComparisonMode !== "single" && comparisonResultImage ? (
              <img
                alt=""
                aria-hidden="true"
                data-testid="comparison-surface-result"
                className="comparison-surface comparison-surface-result"
                key={cleanedReview ? reviewIdentity : undefined}
                draggable={false}
                src={resolvedComparisonImageSource?.src ?? comparisonResultImage.storedRelativePath}
                style={
                  effectiveComparisonMode === "split"
                    ? { clipPath: "inset(0 0 0 50%)" }
                    : effectiveComparisonMode === "reveal"
                      ? { clipPath: `inset(0 0 0 ${comparisonState.revealPosition}%)` }
                      : { opacity: comparisonState.opacity }
                }
                onError={() => {
                  if (selectedResultIdentity) setResultRenderFailedIdentity(selectedResultIdentity);
                  setResolvedComparisonImageSource(null);
                }}
                onLoad={(event) => {
                  if (event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0 &&
                    reviewAssetMatches && comparisonCleanedResolved && !selectedResultFailed) {
                    markReviewLoaded(reviewIdentity, "cleaned");
                  }
                }}
              />
            ) : null}
            {effectiveComparisonMode === "reveal" && comparisonResultImage ? (
              <div
                className="page-image-comparison-divider"
                data-testid="comparison-divider"
                style={{ left: `${comparisonState.revealPosition}%` }}
                onPointerDown={handleRevealPointerDown}
              >
                <div
                  className="page-image-comparison-handle"
                  role="slider"
                  aria-label="슬라이더 비교선"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={comparisonState.revealPosition}
                  tabIndex={0}
                  onPointerDown={handleRevealPointerDown}
                  onKeyDown={handleRevealKeyDown}
                  onLostPointerCapture={(event) => {
                    if (comparisonDragRef.current?.pointerId === event.pointerId) {
                      comparisonDragRef.current = null;
                    }
                  }}
                />
              </div>
            ) : null}
            {!imageLoadFailed ? (
              <div className="page-dialogue-targets" aria-label="이미지에서 대사 선택">
                {onSelectLine && !editorOpen && dialogueTargets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    className="page-dialogue-target"
                    aria-label={`이미지 대사 ${target.order} 선택`}
                    aria-pressed={target.selected}
                    style={{ left: `${target.bbox.x * 100}%`, top: `${target.bbox.y * 100}%`, width: `${target.bbox.width * 100}%`, height: `${target.bbox.height * 100}%` }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => { event.stopPropagation(); onSelectLine(target.id); }}
                  >
                    <span>{target.order}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {!imageLoadFailed ? (
              <SemanticOverlayLayer
                overlays={semanticOverlayDescriptors}
                visibleKinds={semanticOverlayVisibleKinds}
                maxUnselected={overlayMaxUnselected}
                onToggleKind={toggleOverlayKind}
              />
            ) : null}
            {!imageLoadFailed && typesettingDraft ? (
              <TypesettingBoxEditor
                draft={typesettingDraft}
                safeArea={typesettingSafeArea}
                mediaRef={mediaRef}
                disabled={precisionEditingDisabled}
                previewText={typesettingPreviewText}
                onChange={(nextDraft) => onTypesettingDraftChange?.(nextDraft)}
              />

            ) : null}
            {!imageLoadFailed && manualTypesetting && !editorOpen ? (
              <ManualTypesettingBoxEditor key={manualTypesetting.key} draft={manualTypesetting.draft}
                initialFields={manualTypesetting.initialFields} onFieldsChange={manualTypesetting.onFieldsChange}
                controlsTarget={manualTypesetting.controlsTarget}
                previewText={manualTypesetting.previewText}
                onDraftChange={manualTypesetting.onDraftChange} onApply={manualTypesetting.onApply}
                disabled={manualTypesetting.disabled} disabledReason={manualTypesetting.disabledReason} />
            ) : null}

          </div>
        </div>
      ) : (
        <div className="page-image-empty page-image-empty-muted">
          <span className="trio-section-kicker">빈 작업 공간</span>
          <strong>만화 원본 이미지를 여기에 드롭하세요</strong>
          <span>{getEmptyImageHint(uploadDisabledReason, currentPage)}</span>
        </div>
      )}
      {!displayedImage ? (
        <div className="page-quick-action-strip" aria-label="이미지 빠른 작업">
          <Button type="button" variant="primary" onClick={onImportImages} disabled={!canImportImage} aria-label="이미지 연결">
            이미지 추가
          </Button>
          <span>{canImportImage ? "현재 페이지부터 이미지를 연결합니다." : "프로젝트 저장 후 이미지 연결 가능"}</span>
        </div>
      ) : null}
      {editorOpen && editorSourceImage && editorImageSrc ? (
        <div className="page-image-editor-region">
          {inpaintingDisabledReason ? (
            <p id="page-image-inpainting-disabled-reason" className="page-image-capability-reason" role="status">
              환경 준비에서 인페인팅 상태를 확인하세요. {inpaintingDisabledReason}
            </p>
          ) : null}
          <InpaintingEditor
            key={`${editorSourceImage.id}:${editorSourceImage.sha256}`}
            currentPage={currentPage}
            imageSrc={editorImageSrc}
            disabled={editorDisabled}
            onCancel={closeEditor}
            onCancelRun={onCancelInpainting}
            onMaskBoundsChange={onInpaintingMaskBoundsChange}
            initialMaskDraft={initialMaskDraft}
            onMaskDraftChange={onInpaintingMaskDraftChange}
            onRun={async (args) => {
              const applied = await onInpaintImage(args);
              if (applied) closeEditor();
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

function getEmptyImageHint(uploadDisabledReason: string | undefined, currentPage: number): string {
  if (!uploadDisabledReason) return `${currentPage}페이지 연결 가능`;
  if (uploadDisabledReason.includes("시크릿")) return "시크릿 프로젝트는 이미지 연결 대기";
  if (uploadDisabledReason.includes("저장")) return "프로젝트 저장 후 이미지 연결 가능";
  return "이미지 연결 대기";
}

function matchesResultImageIdentity(
  left: ResultImageIdentity | null,
  right: ResultImageIdentity | null
): boolean {
  return Boolean(
    left &&
      right &&
      left.layer === right.layer &&
      left.id === right.id &&
      left.storedRelativePath === right.storedRelativePath
  );
}

function sameOverlayBbox(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return ["x", "y", "width", "height"].every((key) =>
    Math.abs(left[key as keyof typeof left] - right[key as keyof typeof right]) < 0.0001
  );
}
