import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { NormalizedBbox } from "../../shared/speechBubbleExtraction";
import { isValidTypesettingBbox, TYPESETTING_MIN_SIZE } from "../../shared/typesettingGeometry";
import { Button } from "./Ui";
import "../manual-typesetting-box.css";

export type ManualTypesettingBoxEditorProps = {
  draft: NormalizedBbox | null;
  onDraftChange: (next: NormalizedBbox | null) => void;
  initialFields?: ManualTypesettingBoxFields;
  onFieldsChange?: (fields: ManualTypesettingBoxFields) => void;
  controlsTarget?: HTMLElement | null;
  previewText?: string;
  onApply: (bbox: NormalizedBbox) => void;
  disabled?: boolean;
  disabledReason?: string;
};

type BoxKey = keyof NormalizedBbox;
export type ManualTypesettingBoxFields = Record<BoxKey, string>;
type Fields = ManualTypesettingBoxFields;
type Point = { x: number; y: number };
type SurfaceRect = { left: number; top: number; width: number; height: number };
type Corner = "nw" | "ne" | "sw" | "se";
type Drag = { pointerId: number; start: Point; surface: HTMLDivElement; changed: boolean } & (
  | { mode: "create" }
  | { mode: "move"; box: NormalizedBbox }
  | { mode: "resize"; box: NormalizedBbox; corner: Corner }
);

const FIELDS: Array<{ key: BoxKey; label: string }> = [
  { key: "x", label: "X (%)" },
  { key: "y", label: "Y (%)" },
  { key: "width", label: "너비 (%)" },
  { key: "height", label: "높이 (%)" }
];
const CORNERS: Array<{ key: Corner; label: string }> = [
  { key: "nw", label: "왼쪽 위 모서리 크기 조절" },
  { key: "ne", label: "오른쪽 위 모서리 크기 조절" },
  { key: "sw", label: "왼쪽 아래 모서리 크기 조절" },
  { key: "se", label: "오른쪽 아래 모서리 크기 조절" }
];
const DRAG_INSTRUCTIONS = "상자 끌기: 이동 · 모서리 끌기: 크기 조절 · 빈 곳 끌기: 새 영역";
const EMPTY_MESSAGE = "변경 후 영역 적용";

/** 이미지 미디어 컨테이너의 자식으로 배치한다. 숨김 및 대상별 draft 보존은 부모가 소유한다. */
export function ManualTypesettingBoxEditor({ draft, onDraftChange, initialFields, onFieldsChange, controlsTarget, previewText, onApply, disabled = false, disabledReason }: ManualTypesettingBoxEditorProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const reportedDraft = useRef(draft);
  const [fields, setFields] = useState<Fields>(() => initialFields ?? toFields(draft));
  const [dragMode, setDragMode] = useState<Drag["mode"] | null>(null);
  // 이미지 표면의 위치이며, 사용자가 정하는 식자 초안의 기본값이 아니다.
  const [imageFrame, setImageFrame] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const descriptionId = useId();
  const instructionsId = `${descriptionId}-instructions`;
  const describedBy = `${instructionsId} ${descriptionId}`;
  const validation = validateFields(fields);
  const validDraft = isValidBox(draft);
  const hasInput = FIELDS.some(({ key }) => fields[key] !== "");
  const canApply = !disabled && validDraft && isValidTypesettingBbox(draft) && validation.bbox !== null && sameBox(draft, validation.bbox);
  const description = disabled
    ? disabledReason?.trim() || "지금은 식자 영역을 지정할 수 없습니다. 편집할 수 있을 때 다시 시도하세요."
    : !hasInput && !validDraft ? "이미지에서 끌어 영역 지정"
    : validation.error || (validDraft && !isValidTypesettingBbox(draft) ? "너비와 높이는 각각 이미지의 2% 이상이어야 합니다." : EMPTY_MESSAGE);

  const releaseDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) setDragMode(null);
    if (drag?.surface.hasPointerCapture?.(drag.pointerId)) drag.surface.releasePointerCapture(drag.pointerId);
  }, []);

  useEffect(() => {
    // onDraftChange의 echo는 미완성 숫자 입력을 지우지 않는다.
    if (sameBox(draft, reportedDraft.current)) return;
    reportedDraft.current = draft;
    setFields(toFields(draft));
    releaseDrag();
  }, [draft, releaseDrag]);

  useEffect(() => { if (disabled) releaseDrag(); }, [disabled, releaseDrag]);

  useEffect(() => {
    window.addEventListener("blur", releaseDrag);
    return () => {
      window.removeEventListener("blur", releaseDrag);
      releaseDrag();
    };
  }, [releaseDrag]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const image = findImage(surface);
    const measure = () => {
      const outer = surface.getBoundingClientRect();
      const inner = measureImageSurface(surface);
      if (!isValidRect(outer) || !inner) return;
      const next = { x: (inner.left - outer.left) / outer.width, y: (inner.top - outer.top) / outer.height,
        width: inner.width / outer.width, height: inner.height / outer.height };
      setImageFrame((current) => sameBox(current, next) ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(surface);
    if (image) observer?.observe(image);
    image?.addEventListener("load", measure);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      image?.removeEventListener("load", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  function publish(next: NormalizedBbox | null, nextFields = toFields(next)) {
    reportedDraft.current = next;
    setFields(nextFields);
    onDraftChange(next);
    onFieldsChange?.(nextFields);
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || dragRef.current || event.button !== 0 || event.isPrimary === false) return;
    const start = pointOnImage(event, measureImageSurface(event.currentTarget));
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    const cornerKey = target?.closest<HTMLElement>("[data-resize-corner]")?.dataset.resizeCorner;
    const corner = CORNERS.find(({ key }) => key === cornerKey)?.key;
    const operation = validDraft && target?.closest(".manual-typesetting-box-preview")
      ? corner ? { mode: "resize" as const, box: { ...draft }, corner } : { mode: "move" as const, box: { ...draft } }
      : { mode: "create" as const };
    dragRef.current = { pointerId: event.pointerId, start, surface: event.currentTarget, changed: false, ...operation };
    setDragMode(operation.mode);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function updateDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (disabled || !drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const end = pointOnImage(event, measureImageSurface(event.currentTarget));
    if (!end) return;
    const delta = { x: end.x - drag.start.x, y: end.y - drag.start.y };
    if (drag.mode !== "create" && !drag.changed && delta.x === 0 && delta.y === 0) return;
    const next = drag.mode === "move"
      ? { ...drag.box, x: clamp(drag.box.x + delta.x, 0, 1 - drag.box.width), y: clamp(drag.box.y + delta.y, 0, 1 - drag.box.height) }
      : drag.mode === "resize" ? resizeBox(drag.box, drag.corner, delta)
      : { x: Math.min(drag.start.x, end.x), y: Math.min(drag.start.y, end.y),
        width: Math.abs(delta.x), height: Math.abs(delta.y) };
    if (isValidBox(next)) {
      drag.changed = true;
      if (!sameBox(next, reportedDraft.current)) publish(next);
    } else if (drag.changed) {
      publish(null);
    }
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerId !== dragRef.current?.pointerId) return;
    updateDrag(event);
    releaseDrag();
  }

  function cancelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerId !== dragRef.current?.pointerId) return;
    event.stopPropagation();
    releaseDrag();
  }

  const controls = (
      <div className={`manual-typesetting-box-controls${controlsTarget ? " is-docked" : ""}`} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
        <p id={instructionsId} className="manual-typesetting-box-instructions">{DRAG_INSTRUCTIONS}</p>
        <p id={descriptionId} role="status" aria-live="polite">{description}</p>
        <Button variant="primary" disabled={!canApply} aria-describedby={describedBy} onClick={() => {
          if (canApply && isValidBox(draft)) {
            releaseDrag();
            onApply({ ...draft });
          }
        }}>영역 적용</Button>
        <details className="manual-typesetting-box-precision">
          <summary>숫자로 정밀 조정</summary>
          <fieldset disabled={disabled} aria-describedby={describedBy}>
          <legend className="sr-only">위치·크기 정밀 조정</legend>
          <div className="manual-typesetting-box-fields">
            {FIELDS.map(({ key, label }) => <label key={key}>
              <span>{label}</span>
              <input
                type="number" inputMode="decimal" min="0" max="100" step="any" value={fields[key]}
                aria-describedby={describedBy} aria-invalid={hasInput && validation.error !== null}
                onChange={(event) => {
                  if (disabled) return;
                  releaseDrag();
                  const nextFields = { ...fields, [key]: event.currentTarget.value };
                  publish(validateFields(nextFields).bbox, nextFields);
                }}
              />
            </label>)}
          </div>
          </fieldset>
        </details>
      </div>
  );

  return (
    <div className="manual-typesetting-box-editor" data-coordinate-space="image">
      <div
        ref={surfaceRef}
        className="manual-typesetting-box-surface"
        role="region"
        aria-label="이미지에서 수동 식자 영역 지정"
        aria-describedby={describedBy}
        aria-disabled={disabled}
        data-drag-mode={dragMode ?? undefined}
        onPointerDown={beginDrag}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
      >
        {validDraft ? <div
          aria-hidden="true"
          className="manual-typesetting-box-preview"
          data-testid="manual-typesetting-box-preview"
          style={{ left: `${(imageFrame.x + draft.x * imageFrame.width) * 100}%`, top: `${(imageFrame.y + draft.y * imageFrame.height) * 100}%`,
            width: `${draft.width * imageFrame.width * 100}%`, height: `${draft.height * imageFrame.height * 100}%` }}
        >
          <div className="manual-typesetting-box-preview-content">
            <span className="manual-typesetting-box-preview-label">배치 미리보기</span>
            <span className="manual-typesetting-box-preview-text">{previewText?.trim() || "상자 안을 잡아 이동"}</span>
          </div>
          {CORNERS.map(({ key, label }) => <span key={key} className="manual-typesetting-box-handle"
            data-resize-corner={key} data-testid={`manual-typesetting-box-handle-${key}`} title={label} />)}
        </div> : null}
      </div>
      {controlsTarget ? createPortal(controls, controlsTarget) : controls}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resizeBox(box: NormalizedBbox, corner: Corner, delta: Point): NormalizedBbox {
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const right = clamp(box.x + box.width, TYPESETTING_MIN_SIZE, 1);
  const bottom = clamp(box.y + box.height, TYPESETTING_MIN_SIZE, 1);
  const x = west ? clamp(box.x + delta.x, 0, right - TYPESETTING_MIN_SIZE) : Math.min(box.x, 1 - TYPESETTING_MIN_SIZE);
  const y = north ? clamp(box.y + delta.y, 0, bottom - TYPESETTING_MIN_SIZE) : Math.min(box.y, 1 - TYPESETTING_MIN_SIZE);
  const width = west ? Math.max(TYPESETTING_MIN_SIZE, right - x) : clamp(box.width + delta.x, TYPESETTING_MIN_SIZE, 1 - x);
  const height = north ? Math.max(TYPESETTING_MIN_SIZE, bottom - y) : clamp(box.height + delta.y, TYPESETTING_MIN_SIZE, 1 - y);
  return { x, y, width, height };
}

function toFields(bbox: NormalizedBbox | null): Fields {
  const percent = (key: BoxKey) => bbox && Number.isFinite(bbox[key]) ? String(bbox[key] * 100) : "";
  return { x: percent("x"), y: percent("y"), width: percent("width"), height: percent("height") };
}

function validateFields(fields: Fields): { bbox: NormalizedBbox | null; error: string | null } {
  if (FIELDS.some(({ key }) => fields[key].trim() === "")) return { bbox: null, error: "X, Y, 너비, 높이를 모두 입력하세요." };
  const x = Number(fields.x), y = Number(fields.y), width = Number(fields.width), height = Number(fields.height);
  if (![x, y, width, height].every(Number.isFinite)) return { bbox: null, error: "유효한 숫자를 입력하세요." };
  if ([x, y, width, height].some((value) => value < 0 || value > 100)) return { bbox: null, error: "각 값은 0~100% 범위로 입력하세요." };
  if (width <= 0 || height <= 0) return { bbox: null, error: "너비와 높이는 0%보다 커야 합니다." };
  const normalizedX = x / 100, normalizedY = y / 100, normalizedWidth = width / 100, normalizedHeight = height / 100;
  // 퍼센트 왕복 변환의 기계 오차만 허용하고, 반환 영역은 항상 이미지 경계 안으로 자른다.
  const roundingError = Number.EPSILON * 4;
  if (normalizedX + normalizedWidth > 1 + roundingError || normalizedY + normalizedHeight > 1 + roundingError) {
    return { bbox: null, error: "영역이 이미지 범위를 초과합니다. 위치나 크기를 줄이세요." };
  }
  const bbox = { x: normalizedX, y: normalizedY, width: Math.min(normalizedWidth, 1 - normalizedX), height: Math.min(normalizedHeight, 1 - normalizedY) };
  return isValidBox(bbox) ? { bbox, error: null } : { bbox: null, error: "이미지 안의 유효한 영역을 입력하세요." };
}

function isValidBox(bbox: NormalizedBbox | null): bbox is NormalizedBbox {
  return bbox !== null && [bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)
    && bbox.x >= 0 && bbox.y >= 0 && bbox.width > 0 && bbox.height > 0
    && bbox.x + bbox.width <= 1 && bbox.y + bbox.height <= 1;
}

function sameBox(a: NormalizedBbox | null, b: NormalizedBbox | null): boolean {
  return a === b || (a !== null && b !== null && FIELDS.every(({ key }) => Math.abs(a[key] - b[key]) <= Number.EPSILON * 4));
}

function isValidRect(rect: SurfaceRect): boolean {
  return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

function findImage(surface: HTMLElement): HTMLImageElement | null {
  return surface.parentElement?.parentElement?.querySelector<HTMLImageElement>("img:not([hidden])") ?? null;
}

function measureImageSurface(surface: HTMLElement): SurfaceRect | null {
  const image = findImage(surface);
  const rect = (image ?? surface).getBoundingClientRect();
  if (!isValidRect(rect)) return null;
  if (!image || getComputedStyle(image).objectFit !== "contain") return rect;
  if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) return null;
  // PageImagePanel의 기존 계약: contain + object-position: center.
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}

function pointOnImage(point: { clientX: number; clientY: number }, rect: SurfaceRect | null): Point | null {
  if (!rect || ![point.clientX, point.clientY].every(Number.isFinite)) return null;
  return { x: Math.max(0, Math.min(1, (point.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (point.clientY - rect.top) / rect.height)) };
}
