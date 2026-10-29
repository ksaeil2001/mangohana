import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { clampEditorWidth, MAX_EDITOR_WIDTH, MIN_EDITOR_WIDTH } from "../focusDeck";

interface ResizableWorkspaceProps {
  editorWidth: number;
  onEditorWidthChange(width: number): void;
  canvas: ReactNode;
  editor: ReactNode;
  editorOpen?: boolean;
  /** Hide an open editor temporarily without discarding its draft or effects. */
  editorHidden?: boolean;
  onEditorClose?: () => void;
}

export function ResizableWorkspace({ editorWidth, onEditorWidthChange, canvas, editor, editorOpen = true, editorHidden = false, onEditorClose }: ResizableWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const activePointerId = useRef<number | null>(null);
  const [editorWasOpened, setEditorWasOpened] = useState(editorOpen);
  const width = clampEditorWidth(editorWidth);

  useEffect(() => {
    if (editorOpen) setEditorWasOpened(true);
  }, [editorOpen]);

  useEffect(() => {
    if (!editorHidden && editorOpen) return;
    const pointerId = activePointerId.current;
    const resizeHandle = resizeHandleRef.current;
    activePointerId.current = null;
    if (pointerId !== null && resizeHandle?.hasPointerCapture(pointerId)) {
      resizeHandle.releasePointerCapture(pointerId);
    }
    const activeElement = document.activeElement;
    if (activeElement && (editorRef.current?.contains(activeElement) || resizeHandleRef.current === activeElement)) {
      canvasRef.current?.focus({ preventScroll: true });
    }
  }, [editorHidden, editorOpen]);

  function resizeFromPointer(event: PointerEvent<HTMLDivElement>) {
    if (editorHidden) return;
    const right = workspaceRef.current?.getBoundingClientRect().right;
    if (right !== undefined) onEditorWidthChange(clampEditorWidth(right - event.clientX));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (editorHidden) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const increment = event.shiftKey ? 48 : 16;
    onEditorWidthChange(clampEditorWidth(width + (event.key === "ArrowLeft" ? increment : -increment)));
  }

  return (
    <div ref={workspaceRef} className={editorOpen && !editorHidden ? "resizable-workspace" : "resizable-workspace inspector-collapsed"} data-testid="resizable-workspace" style={{ "--focus-editor-width": `${width}px` } as CSSProperties}>
      <main ref={canvasRef} className="focus-deck-canvas" tabIndex={-1}>{canvas}</main>
      {editorOpen ? <div
        ref={resizeHandleRef}
        className="focus-deck-resize-handle"
        role="separator"
        hidden={editorHidden}
        inert={editorHidden}
        tabIndex={editorHidden ? -1 : 0}
        aria-orientation="vertical"
        aria-label="이미지와 편집기 너비 조절"
        aria-valuemin={MIN_EDITOR_WIDTH}
        aria-valuemax={MAX_EDITOR_WIDTH}
        aria-valuenow={width}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          if (editorHidden) return;
          activePointerId.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (activePointerId.current === event.pointerId) resizeFromPointer(event);
        }}
        onPointerUp={(event) => {
          if (activePointerId.current === event.pointerId) activePointerId.current = null;
        }}
        onPointerCancel={() => { activePointerId.current = null; }}
      /> : null}
      {editorOpen || editorWasOpened ? <aside ref={editorRef} id="focus-deck-inspector" className="focus-deck-editor" hidden={editorHidden || !editorOpen} inert={editorHidden || !editorOpen} style={{ width: "var(--focus-editor-width)", minWidth: 0 }} aria-label="현재 작업 편집기">
        {onEditorClose ? <button type="button" className="focus-deck-editor-close" aria-label="편집기 닫기" onClick={onEditorClose}>닫기</button> : null}
        {editor}
      </aside> : null}
    </div>
  );
}
