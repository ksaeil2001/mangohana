import { Button } from "./Ui.js";
import { useEffect, useId, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { inpaintingModeLabels, inpaintingModes } from "../../shared/inpainting";
import type { InpaintingMode, InpaintingProvider } from "../../shared/inpainting";
import type { NormalizedBbox } from "../../shared/speechBubbleExtraction";
import { cloneMaskDraft, isMatchingMaskDraft, type InpaintingMaskDraft } from "../inpaintingMaskDraft";

type Props = {
  imageSrc: string;
  currentPage: number;
  disabled?: boolean;
  onCancel: () => void;
  onCancelRun?: () => void;
  onRun: (args: {
    maskPngBase64: string;
    mode: InpaintingMode;
    provider: InpaintingProvider;
    promptOverride?: string;
    options?: {
      conservative?: boolean;
      skipOnLowConfidence?: boolean;
      dilatePixels?: number;
    };
  }) => Promise<void>;
  onMaskBoundsChange?: (bbox: NormalizedBbox | null) => void;
  initialMaskDraft?: InpaintingMaskDraft | null;
  onMaskDraftChange?: (draft: InpaintingMaskDraft | null) => void;
};

type CanvasPoint = {
  x: number;
  y: number;
};

export function InpaintingEditor({
  imageSrc,
  currentPage,
  disabled = false,
  onCancel,
  onCancelRun,
  onRun,
  onMaskBoundsChange,
  initialMaskDraft,
  onMaskDraftChange
}: Props) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previousPointRef = useRef<CanvasPoint | null>(null);
  const submittingRef = useRef(false);
  const runGenerationRef = useRef(0);
  const [mode, setMode] = useState<InpaintingMode>("speech-bubble");
  const [selectedProvider, setSelectedProvider] = useState<InpaintingProvider>("openai");
  const [brushSize, setBrushSize] = useState(24);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [hasMask, setHasMask] = useState(false);
  const [conservativeMasking, setConservativeMasking] = useState(true);
  const [promptOverride, setPromptOverride] = useState("");
  const [running, setRunning] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const previousImageSrcRef = useRef(imageSrc);
  const restoredDraftSourceRef = useRef<string | null>(null);
  const isBlocked = disabled || running;
  const fieldPrefix = useId();

  useEffect(() => {
    if (imageRef.current?.complete) {
      syncCanvasSize();
    }
  }, []);

  useEffect(() => {
    if (previousImageSrcRef.current === imageSrc) return;
    previousImageSrcRef.current = imageSrc;
    runGenerationRef.current += 1;
    submittingRef.current = false;
    setRunning(false);
    const canvas = canvasRef.current;
    if (canvas && restoreMaskDraft(canvas.width, canvas.height)) return;
    clearMask(false);
  }, [imageSrc]);

  function restoreMaskDraft(width: number, height: number): boolean {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (
      !canvas ||
      !context ||
      !isMatchingMaskDraft(initialMaskDraft, width, height)
    ) {
      return false;
    }
    if (restoredDraftSourceRef.current === imageSrc) return true;
    const imageData = typeof context.createImageData === "function"
      ? context.createImageData(width, height)
      : ({ data: new Uint8ClampedArray(width * height * 4) } as ImageData);
    if (imageData.data.length !== initialMaskDraft.pixels.length) return false;
    imageData.data.set(initialMaskDraft.pixels);
    context.putImageData(imageData, 0, 0);
    restoredDraftSourceRef.current = imageSrc;
    setHasMask(true);
    onMaskBoundsChange?.(initialMaskDraft.bounds);
    return true;
  }

  function syncCanvasSize() {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas) return;

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width <= 0 || height <= 0) return;

    const resized = canvas.width !== width || canvas.height !== height;
    if (resized) {
      canvas.width = width;
      canvas.height = height;
      previousPointRef.current = null;
      restoredDraftSourceRef.current = null;
    }
    if (restoreMaskDraft(width, height)) return;
    if (resized) {
      setHasMask(false);
      onMaskBoundsChange?.(null);
      if (initialMaskDraft) onMaskDraftChange?.(null);
    }
  }

  function scanMaskDraft(): InpaintingMaskDraft | null {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || canvas.width === 0 || canvas.height === 0) {
      return null;
    }

    const pixels = new Uint8ClampedArray(context.getImageData(0, 0, canvas.width, canvas.height).data);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return {
      width: canvas.width,
      height: canvas.height,
      pixels,
      bounds: {
        x: minX / canvas.width,
        y: minY / canvas.height,
        width: (maxX - minX + 1) / canvas.width,
        height: (maxY - minY + 1) / canvas.height
      }
    };
  }

  function scanMaskBounds(): NormalizedBbox | null {
    restoredDraftSourceRef.current = imageSrc;
    const draft = scanMaskDraft();
    if (!draft) {
      setHasMask(false);
      onMaskBoundsChange?.(null);
      onMaskDraftChange?.(null);
      return null;
    }
    onMaskBoundsChange?.(draft.bounds);
    onMaskDraftChange?.(cloneMaskDraft(draft));
    setHasMask(true);
    return draft.bounds;
  }

  function clearMask(markDraftConsumed = true) {
    if (markDraftConsumed) restoredDraftSourceRef.current = imageSrc;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      previousPointRef.current = null;
      setHasMask(false);
      if (markDraftConsumed) {
        onMaskBoundsChange?.(null);
        onMaskDraftChange?.(null);
      }
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    previousPointRef.current = null;
    setHasMask(false);
    if (markDraftConsumed) {
      onMaskBoundsChange?.(null);
      onMaskDraftChange?.(null);
    }
  }

  function getCanvasPoint(event: PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  }

  function drawMask(event: PointerEvent<HTMLCanvasElement>) {
    if (isBlocked) return;

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || canvas.width === 0 || canvas.height === 0) return;

    const point = getCanvasPoint(event, canvas);
    if (!point) return;

    const previousPoint = previousPointRef.current;

    context.save();
    context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    context.fillStyle = "rgba(255, 0, 0, 0.5)";
    context.strokeStyle = "rgba(255, 0, 0, 0.5)";
    context.lineWidth = brushSize;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2);
    context.fill();
    if (previousPoint) {
      context.beginPath();
      context.moveTo(previousPoint.x, previousPoint.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.restore();

    previousPointRef.current = point;

    if (tool === "brush") {
      setHasMask(true);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (isBlocked) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignore capture errors on unsupported platforms/devices
    }
    previousPointRef.current = null;
    setDrawing(true);
    drawMask(event);
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing) return;
    drawMask(event);
  }

  function stopDrawing(event: PointerEvent<HTMLCanvasElement>) {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore capture errors
    }
    previousPointRef.current = null;
    setDrawing(false);
    const bounds = scanMaskBounds();
    // Keep the existing brush gate usable when a host canvas cannot expose
    // pixels (for example a headless canvas shim); real alpha bounds still
    // flow through the optional renderer-only callback above.
    if (tool === "brush" && !bounds) setHasMask(true);
  }

  function buildMaskPngBase64(canvas: HTMLCanvasElement) {
    const sourceContext = canvas.getContext("2d");
    if (!sourceContext || canvas.width === 0 || canvas.height === 0) return null;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const exportContext = exportCanvas.getContext("2d");
    if (!exportContext) return null;

    exportContext.fillStyle = "#ffffff";
    exportContext.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    const sourcePixels = sourceContext.getImageData(0, 0, canvas.width, canvas.height).data;
    const exportImageData = exportContext.getImageData(0, 0, exportCanvas.width, exportCanvas.height);
    const exportPixels = exportImageData.data;

    for (let index = 3; index < sourcePixels.length; index += 4) {
      exportPixels[index] = sourcePixels[index] > 0 ? 0 : 255;
    }

    exportContext.putImageData(exportImageData, 0, 0);
    return exportCanvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  }

  async function runInpainting(provider: InpaintingProvider) {
    const canvas = canvasRef.current;
    if (!canvas || isBlocked || !hasMask || submittingRef.current) return;

    const runGeneration = ++runGenerationRef.current;
    submittingRef.current = true;
    setRunning(true);
    try {
      const maskPngBase64 = buildMaskPngBase64(canvas);
      if (!maskPngBase64) return;
      const trimmedPrompt = promptOverride.trim();
      await onRun({
        maskPngBase64,
        mode,
        provider,
        promptOverride: trimmedPrompt || undefined,
        options: {
          conservative: conservativeMasking
        }
      });
    } finally {
      if (runGenerationRef.current === runGeneration) {
        submittingRef.current = false;
        setRunning(false);
      }
    }
  }

  function cancelRun() {
    runGenerationRef.current += 1;
    submittingRef.current = false;
    setRunning(false);
    onCancelRun?.();
  }

  function handleWheel(event: React.WheelEvent) {
    if (event.ctrlKey || event.altKey) {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 4 : -4;
      setBrushSize((prev) => Math.max(4, Math.min(80, prev + delta)));
    }
  }

  function handleEditorKeyDown(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target as HTMLElement | null;
    if (target) {
      const tagName = target.tagName.toLowerCase();
      if (target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select") {
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!running) onCancel();
      return;
    }
    if (event.key === "[") {
      event.preventDefault();
      event.stopPropagation();
      setBrushSize((prev) => Math.max(4, prev - 4));
    } else if (event.key === "]") {
      event.preventDefault();
      event.stopPropagation();
      setBrushSize((prev) => Math.min(80, prev + 4));
    } else if (event.key === "b" || event.key === "B") {
      event.preventDefault();
      event.stopPropagation();
      setTool("brush");
    } else if (event.key === "e" || event.key === "E") {
      event.preventDefault();
      event.stopPropagation();
      setTool("eraser");
    }
  }

  return (
    <section
      className="inpainting-editor stitch-workbench-inline stitch-inpainting-editor"
      aria-label={`${currentPage}페이지 인페인팅 편집기`}
      aria-busy={running}
      tabIndex={0}
      onKeyDown={handleEditorKeyDown}
    >
      <div className="inpainting-editor-header">
        <div>
          <strong>{currentPage}페이지 인페인팅</strong>
          <span>제거할 원문에 마스크를 칠하세요. 실행 결과의 품질 검사와 사용자 승인은 별도로 확인합니다.</span>
        </div>
        <button type="button" onClick={onCancel} disabled={running}>
          이미지로 돌아가기
        </button>
      </div>

      <ol className="stitch-inpainting-steps" aria-label="원문 제거 작업 순서"><li>01 마스크 편집</li><li>02 실행 요청</li><li>03 품질 검사 · 결과 승인</li></ol>
      <div className="stitch-inpainting-layout">
      <div className="inpainting-toolbar">
        <div className="inpainting-mode-tabs" aria-label="인페인팅 모드">
          {inpaintingModes.map((inpaintingMode) => (
            <button
              key={inpaintingMode}
              type="button"
              aria-pressed={mode === inpaintingMode}
              onClick={() => setMode(inpaintingMode)}
              disabled={isBlocked}
            >
              {inpaintingModeLabels[inpaintingMode]}
            </button>
          ))}
        </div>

        <label htmlFor={`${fieldPrefix}-brush`}>
          <span>브러시 {brushSize}px</span>
          <input
            id={`${fieldPrefix}-brush`}
            type="range"
            min="4"
            max="80"
            aria-label="브러시 크기"
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            disabled={isBlocked}
          />
        </label>

        <div className="inpainting-actions">
          <button type="button" aria-label="칠하기" aria-pressed={tool === "brush"} onClick={() => setTool("brush")} disabled={isBlocked} title="브러시 (B)">
            칠하기 (B)
          </button>
          <button type="button" aria-label="지우개" aria-pressed={tool === "eraser"} onClick={() => setTool("eraser")} disabled={isBlocked} title="지우개 (E)">
            지우개 (E)
          </button>
          <button type="button" onClick={() => clearMask()} disabled={isBlocked || !hasMask}>
            마스크 지우기
          </button>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: "var(--trio-space-1)", fontSize: "var(--trio-text-caption)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={conservativeMasking}
            onChange={(e) => setConservativeMasking(e.target.checked)}
            disabled={isBlocked}
          />
          <span>보수적 경계 보존 (PanelCleaner)</span>
        </label>


        <label className="inpainting-prompt" htmlFor={`${fieldPrefix}-prompt`}>
          추가 지시
          <input
            id={`${fieldPrefix}-prompt`}
            type="text"
            value={promptOverride}
            onChange={(event) => setPromptOverride(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (!running) onCancel();
              } else if (event.key === "Enter" && hasMask && !isBlocked) {
                event.preventDefault();
                runInpainting(selectedProvider);
              }
            }}
            disabled={isBlocked}
            placeholder="인페인팅 추가 프롬프트 지시사항 입력..."
            aria-label="추가 지시사항"
          />
        </label>
      </div>

      <div className="inpainting-canvas-wrap" onWheel={handleWheel}>
        <img
          ref={imageRef}
          src={imageSrc}
          alt={`${currentPage}페이지 인페인팅 대상`}
          onLoad={syncCanvasSize}
          draggable={false}
        />
        <canvas
          ref={canvasRef}
          aria-label="인페인팅 마스크"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
        />
      </div>
      </div>
      <footer className="inpainting-actions stitch-inpainting-footer">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--trio-space-2)" }}>
          <button type="button" onClick={onCancel} disabled={running}>
            이미지로 돌아가기
          </button>
          <label htmlFor={`${fieldPrefix}-engine`}>
            <span>엔진:</span>
            <select
              id={`${fieldPrefix}-engine`}
              className="trio-select-control"
              aria-label="인페인팅 엔진 선택"
              style={{ fontSize: "var(--trio-text-caption)", padding: "var(--trio-space-1) var(--trio-space-2)" }}
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value as InpaintingProvider)}
              disabled={isBlocked}
            >
              <option value="openai">OpenAI DALL-E</option>
              <option value="gemini">Gemini Vision</option>
              <option value="local-lama">로컬 LaMa (오프라인)</option>
              <option value="local-aot">로컬 AOT-GAN (오프라인)</option>
              <option value="sd-webui">Stable Diffusion WebUI</option>
              <option value="comfyui">ComfyUI</option>
            </select>
          </label>
        </div>

        <div style={{ display: "flex", gap: "var(--trio-space-2)" }}>
          {running ? (
            <Button type="button" variant="secondary" onClick={cancelRun}>
              인페인팅 실행 취소
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            onClick={() => runInpainting("openai")}
            disabled={isBlocked || !hasMask}
          >
            OpenAI 실행
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => runInpainting("gemini")}
            disabled={isBlocked || !hasMask}
          >
            Gemini 실행
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => runInpainting(selectedProvider)}
            disabled={isBlocked || !hasMask}
          >
            선택 엔진으로 실행
          </Button>
        </div>
      </footer>
    </section>
  );
}
