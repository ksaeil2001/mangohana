import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { placeTypesettingToolbar } from "../typesettingToolbarPlacement";
import type { BubbleShape } from "../../shared/typesettingShape";
import {
  autoFitFontSizeForBubbleShape,
  clientPointToNormalized,
  layoutTextForBubbleShape,
  moveTypesettingDraft,
  resizeTypesettingDraft,
  rotateTypesettingDraft,
  type NormalizedPoint,
  type TypesettingDraft,
  type TypesettingResizeHandle,
  type TypesettingSafeArea
} from "../typesettingGeometry";

type Props = {
  draft: TypesettingDraft;
  safeArea?: TypesettingSafeArea | null;
  mediaRef?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  previewText?: string;
  onChange: (draft: TypesettingDraft) => void;
};

const SHAPE_OPTIONS: Array<{ shape: BubbleShape; label: string; icon: string }> = [
  { shape: "ellipse", label: "타원형 말풍선", icon: "⬭" },
  { shape: "rectangle", label: "직사각형 상자", icon: "▭" },
  { shape: "cloud", label: "생각/독백 구름", icon: "☁" },
  { shape: "spiky", label: "외침/강조 상자", icon: "🗯" }
];


type DragKind = "move" | TypesettingResizeHandle | "rotate";

type DragState = {
  pointerId: number;
  kind: DragKind;
  startClient: { x: number; y: number };
  startDraft: TypesettingDraft;
  media: HTMLElement;
  startRotationDegrees?: number;
};

const HANDLE_LABELS: Record<TypesettingResizeHandle, string> = {
  nw: "식자 상자 북서쪽 크기 조절",
  ne: "식자 상자 북동쪽 크기 조절",
  sw: "식자 상자 남서쪽 크기 조절",
  se: "식자 상자 남동쪽 크기 조절"
};

export function TypesettingBoxEditor({ draft, safeArea, mediaRef, disabled = false, previewText, onChange }: Props) {

  const editorRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const safeAreaRef = useRef(safeArea);
  safeAreaRef.current = safeArea;

  useLayoutEffect(() => {
    setToolbarHost(editorRef.current?.closest<HTMLElement>(".page-image-panel") ?? null);
  }, []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    const toolbar = toolbarRef.current;
    const stage = editor?.closest<HTMLElement>(".page-image-stage");
    const media = editor?.closest<HTMLElement>(".page-image-media");
    if (!toolbarHost || !editor || !toolbar || !stage) return;
    let frame = 0;
    const measure = () => {
      const host = toolbarHost.getBoundingClientRect();
      const view = stage.getBoundingClientRect();
      const bounds = { left: Math.max(host.left, view.left, 0) + 8, top: Math.max(host.top, view.top, 0) + 8,
        right: Math.min(host.right, view.right, window.innerWidth) - 8, bottom: Math.min(host.bottom, view.bottom, window.innerHeight) - 8 };
      // The host is outside image zoom/rotation, so tools retain their normal control size.
      const scaleX = host.width / (toolbarHost.offsetWidth || host.width || 1);
      const scaleY = host.height / (toolbarHost.offsetHeight || host.height || 1);
      toolbar.style.maxWidth = `${Math.max(0, bounds.right - bounds.left) / scaleX}px`;
      const size = toolbar.getBoundingClientRect();
      const obstacles = [...toolbarHost.querySelectorAll<HTMLElement>(".page-image-toolbar, .page-image-overlay-dropdown[open] .semantic-overlay-legend")]
        .map((element) => element.getBoundingClientRect());
      const placement = placeTypesettingToolbar(editor.getBoundingClientRect(), size, bounds, obstacles);
      toolbar.dataset.placement = placement ? "visible" : "space-limited";
      if (!placement) return;
      toolbar.style.left = `${(placement.left - host.left) / scaleX - toolbarHost.clientLeft + toolbarHost.scrollLeft}px`;
      toolbar.style.top = `${(placement.top - host.top) / scaleY - toolbarHost.clientTop + toolbarHost.scrollTop}px`;
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    [toolbarHost, stage, toolbar, media, toolbarHost.querySelector(".page-image-toolbar")].forEach((element) => { if (element) resize?.observe(element); });
    const mutations = new MutationObserver(schedule);
    if (media) mutations.observe(media, { attributes: true, attributeFilter: ["style", "class"] });
    toolbarHost.querySelectorAll("details").forEach((element) => mutations.observe(element, { attributes: true, attributeFilter: ["open"] }));
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => { cancelAnimationFrame(frame); resize?.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); };
  });

  useEffect(() => {
    const release = () => releaseDrag();
    window.addEventListener("blur", release);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("blur", release);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  const normalizedBbox = draft.bbox;
  const editorStyle = {
    left: `${normalizedBbox.x * 100}%`,
    top: `${normalizedBbox.y * 100}%`,
    width: `${normalizedBbox.width * 100}%`,
    height: `${normalizedBbox.height * 100}%`,
    transform: `rotate(${draft.rotationDegrees}deg)`
  };

  function getMediaElement(target: HTMLElement): HTMLElement | null {
    return mediaRef?.current ?? target.closest<HTMLElement>(".page-image-media");
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>, kind: DragKind) {
    if (disabled) return;
    const media = getMediaElement(event.currentTarget);
    if (!media) return;
    event.preventDefault();
    event.stopPropagation();
    const target = editorRef.current ?? event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      kind,
      startClient: { x: event.clientX, y: event.clientY },
      startDraft: cloneDraft(draft),
      media,
      startRotationDegrees: draft.rotationDegrees
    };
    target.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const start = clientPointToNormalized({ clientX: drag.startClient.x, clientY: drag.startClient.y }, drag.media.getBoundingClientRect());
    const current = clientPointToNormalized({ clientX: event.clientX, clientY: event.clientY }, drag.media.getBoundingClientRect());
    const delta = { x: current.x - start.x, y: current.y - start.y };
    const area = safeAreaRef.current ?? undefined;
    let next = drag.startDraft;
    if (drag.kind === "move") {
      next = moveTypesettingDraft(drag.startDraft, delta, area);
    } else if (drag.kind === "rotate") {
      const mediaRect = drag.media.getBoundingClientRect();
      const centerScreenX = mediaRect.left + (drag.startDraft.bbox.x + drag.startDraft.bbox.width / 2) * mediaRect.width;
      const centerScreenY = mediaRect.top + (drag.startDraft.bbox.y + drag.startDraft.bbox.height / 2) * mediaRect.height;
      const startAngle = Math.atan2(drag.startClient.y - centerScreenY, drag.startClient.x - centerScreenX);
      const currentAngle = Math.atan2(event.clientY - centerScreenY, event.clientX - centerScreenX);
      const deltaDegrees = ((currentAngle - startAngle) * 180) / Math.PI;
      next = rotateTypesettingDraft(drag.startDraft, deltaDegrees, area);
    } else {
      next = resizeTypesettingDraft(drag.startDraft, drag.kind, delta, area);
    }
    onChange(next);
  }

  function stopPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    releaseDrag(event.pointerId);
  }

  function releaseDrag(pointerId?: number) {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
    try {
      editorRef.current?.releasePointerCapture?.(drag.pointerId);
    } catch {
      // Capture may already be released by the browser.
    }
    dragRef.current = null;
  }

  function handleBodyKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    if (event.key === "1") {
      event.preventDefault();
      event.stopPropagation();
      onChange({ ...draft, shape: "ellipse" });
      return;
    }
    if (event.key === "2") {
      event.preventDefault();
      event.stopPropagation();
      onChange({ ...draft, shape: "rectangle" });
      return;
    }
    if (event.key === "3") {
      event.preventDefault();
      event.stopPropagation();
      onChange({ ...draft, shape: "cloud" });
      return;
    }
    if (event.key === "4") {
      event.preventDefault();
      event.stopPropagation();
      onChange({ ...draft, shape: "spiky" });
      return;
    }
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = keyDelta(event.key, step);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(moveTypesettingDraft(draft, delta, safeArea ?? undefined));
  }


  function handleResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>, handle: TypesettingResizeHandle) {
    if (disabled) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = keyDelta(event.key, step);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(resizeTypesettingDraft(draft, handle, delta, safeArea ?? undefined));
  }

  function handleRotateKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    onChange(rotateTypesettingDraft(draft, event.key === "ArrowLeft" ? -5 : 5, safeArea ?? undefined));
  }

  const currentShape = draft.shape ?? "ellipse";
  const layoutResult = previewText?.trim()
    ? autoFitFontSizeForBubbleShape(previewText.trim(), { shape: currentShape })
    : null;

  const shapeToolbar = (
      <div ref={toolbarRef} className={`typesetting-shape-toolbar${toolbarHost ? " typesetting-shape-toolbar-positioned" : ""}`} role="toolbar" aria-label="말풍선 형태 및 쓰기 방향 선택">
        {SHAPE_OPTIONS.map((opt) => (
          <button key={opt.shape} type="button" className={`typesetting-shape-btn${currentShape === opt.shape ? " active" : ""}`}
            title={opt.label} aria-label={opt.label} aria-pressed={currentShape === opt.shape} disabled={disabled}
            onPointerDown={(e) => e.stopPropagation()} onClick={() => onChange({ ...draft, shape: opt.shape })}>
            <span>{opt.icon}</span>
          </button>
        ))}
        <button type="button" className={`typesetting-shape-btn${draft.writingMode === "vertical-rl" ? " active" : ""}`}
          title={draft.writingMode === "vertical-rl" ? "가로쓰기로 전환" : "세로쓰기로 전환"}
          aria-label={draft.writingMode === "vertical-rl" ? "가로쓰기로 전환" : "세로쓰기로 전환"}
          aria-pressed={draft.writingMode === "vertical-rl"} disabled={disabled}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onChange({ ...draft, writingMode: draft.writingMode === "vertical-rl" ? "horizontal-tb" : "vertical-rl" })}>
          <span style={{ fontSize: "var(--trio-text-caption)", fontWeight: 700 }}>{draft.writingMode === "vertical-rl" ? "세" : "가"}</span>
        </button>
      </div>
  );

  return (
    <div
      ref={editorRef}
      className={`typesetting-box-editor typesetting-shape-${currentShape}${disabled ? " is-disabled" : ""}`}
      data-testid="typesetting-box-editor"
      data-coordinate-space="image"
      data-writing-mode={draft.writingMode}
      data-bubble-shape={currentShape}
      data-dragging={dragRef.current ? "true" : undefined}
      role="group"
      aria-label="한국어 식자 상자"
      style={editorStyle}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPointer}
      onPointerCancel={stopPointer}
      onLostPointerCapture={() => releaseDrag()}
    >
      {toolbarHost ? createPortal(shapeToolbar, toolbarHost) : shapeToolbar}

      <button
        type="button"
        className="typesetting-box-body"
        aria-label="식자 상자 이동"
        tabIndex={0}
        disabled={disabled}
        onPointerDown={(event) => beginDrag(event, "move")}
        onKeyDown={handleBodyKeyDown}
      >
        {layoutResult && layoutResult.lines.length > 0 ? (
          <div
            className="typesetting-preview-lines"
            style={{
              fontSize: `${Math.max(10, layoutResult.fontSizeRatio * 100)}%`,
              writingMode: draft.writingMode === "vertical-rl" ? "vertical-rl" : "horizontal-tb"
            }}
          >
            {layoutResult.lines.map((line, idx) => (
              <span key={idx} className="typesetting-preview-line">
                {line.text}
              </span>
            ))}
          </div>
        ) : (
          <span>{draft.writingMode === "vertical-rl" ? "한국어 세로쓰기" : "한국어 가로쓰기"}</span>
        )}

      </button>
      {(Object.keys(HANDLE_LABELS) as TypesettingResizeHandle[]).map((handle) => (
        <button
          key={handle}
          type="button"
          className={`typesetting-box-handle typesetting-box-handle-${handle}`}
          aria-label={HANDLE_LABELS[handle]}
          disabled={disabled}
          onPointerDown={(event) => beginDrag(event, handle)}
          onKeyDown={(event) => handleResizeKeyDown(event, handle)}
        />
      ))}
      <button
        type="button"
        className="typesetting-box-rotate-handle"
        aria-label="식자 상자 회전"
        disabled={disabled}
        onPointerDown={(event) => beginDrag(event, "rotate")}
        onKeyDown={handleRotateKeyDown}
      >
        ↻
      </button>
    </div>
  );
}

function keyDelta(key: string, step: number): NormalizedPoint | null {
  if (key === "ArrowLeft") return { x: -step, y: 0 };
  if (key === "ArrowRight") return { x: step, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -step };
  if (key === "ArrowDown") return { x: 0, y: step };
  return null;
}

function cloneDraft(draft: TypesettingDraft): TypesettingDraft {
  return { ...draft, bbox: { ...draft.bbox }, shape: draft.shape };
}
