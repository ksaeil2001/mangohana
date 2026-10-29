import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InpaintingEditor } from "../../src/renderer/components/InpaintingEditor";

describe("InpaintingEditor mask bounds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports normalized alpha bounds after a stroke and clears them after erase", () => {
    let hasAlpha = true;
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 80 });
    HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      top: 0,
      right: 100,
      bottom: 80,
      left: 0,
      toJSON: () => ({})
    }));
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
    HTMLCanvasElement.prototype.hasPointerCapture = vi.fn(() => true);
    HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        if (hasAlpha) {
          for (let y = 20; y <= 39; y += 1) {
            for (let x = 10; x <= 29; x += 1) data[(y * width + x) * 4 + 3] = 255;
          }
        }
        return { data };
      })
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const onMaskBoundsChange = vi.fn();
    const onMaskDraftChange = vi.fn();
    render(
      <InpaintingEditor
        currentPage={1}
        imageSrc="/page.png"
        onCancel={vi.fn()}
        onRun={vi.fn().mockResolvedValue(undefined)}
        onMaskBoundsChange={onMaskBoundsChange}
        onMaskDraftChange={onMaskDraftChange}
      />
    );
    fireEvent.load(screen.getByAltText("1페이지 인페인팅 대상"));
    const canvas = screen.getByLabelText("인페인팅 마스크");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(onMaskBoundsChange).toHaveBeenLastCalledWith({ x: 0.1, y: 0.25, width: 0.2, height: 0.25 });
    expect(onMaskDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ width: 100, height: 80 }));

    hasAlpha = false;
    fireEvent.click(screen.getByRole("button", { name: "지우개" }));
    fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 20, clientY: 20 });
    expect(onMaskBoundsChange).toHaveBeenLastCalledWith(null);
    expect(onMaskDraftChange).toHaveBeenLastCalledWith(null);
  });

  it("restores a matching mask draft into the canvas and re-enables both providers", () => {
    const putImageData = vi.fn();
    const pixels = new Uint8ClampedArray(100 * 80 * 4);
    pixels[3] = 255;
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 80 });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
      putImageData,
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4)
      }))
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    render(
      <InpaintingEditor
        currentPage={1}
        imageSrc="/page.png"
        onCancel={vi.fn()}
        onRun={vi.fn().mockResolvedValue(undefined)}
        initialMaskDraft={{
          width: 100,
          height: 80,
          pixels,
          bounds: { x: 0, y: 0, width: 0.01, height: 0.0125 }
        }}
      />
    );

    fireEvent.load(screen.getByAltText("1페이지 인페인팅 대상"));

    expect(putImageData).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /OpenAI/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Gemini/ })).toBeEnabled();
  });

  it("restores a matching draft when the fresh canvas already has the browser default dimensions", () => {
    const putImageData = vi.fn();
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 150 });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
      putImageData,
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4)
      }))
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const pixels = new Uint8ClampedArray(300 * 150 * 4);
    pixels[3] = 255;
    render(
      <InpaintingEditor
        currentPage={1}
        imageSrc="/default-sized.png"
        onCancel={vi.fn()}
        onRun={vi.fn().mockResolvedValue(undefined)}
        initialMaskDraft={{
          width: 300,
          height: 150,
          pixels,
          bounds: { x: 0, y: 0, width: 1 / 300, height: 1 / 150 }
        }}
      />
    );

    fireEvent.load(screen.getByAltText("1페이지 인페인팅 대상"));

    expect(putImageData).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /OpenAI/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Gemini/ })).toBeEnabled();
  });

  it("ignores a size-mismatched draft and does not rehydrate it after an image change", () => {
    const putImageData = vi.fn();
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 80 });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
      putImageData,
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4)
      }))
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

    const { rerender } = render(
      <InpaintingEditor
        currentPage={1}
        imageSrc="/page.png"
        onCancel={vi.fn()}
        onRun={vi.fn().mockResolvedValue(undefined)}
        initialMaskDraft={{
          width: 50,
          height: 40,
          pixels: new Uint8ClampedArray(50 * 40 * 4),
          bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }
        }}
      />
    );
    fireEvent.load(screen.getByAltText("1페이지 인페인팅 대상"));
    expect(putImageData).not.toHaveBeenCalled();
    rerender(
      <InpaintingEditor
        currentPage={2}
        imageSrc="/page-2.png"
        onCancel={vi.fn()}
        onRun={vi.fn().mockResolvedValue(undefined)}
        initialMaskDraft={null}
      />
    );
    fireEvent.load(screen.getByAltText("2페이지 인페인팅 대상"));
    expect(putImageData).not.toHaveBeenCalled();
  });

  it("adjusts brush size with [ and ] keys and toggles tool with B and E keys", () => {
    render(
      <InpaintingEditor
        currentPage={1}
        imageSrc="/page.png"
        onCancel={vi.fn()}
        onRun={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const editor = screen.getByLabelText("1페이지 인페인팅 편집기");
    expect(screen.getByText("브러시 24px")).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "]" });
    expect(screen.getByText("브러시 28px")).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "[" });
    expect(screen.getByText("브러시 24px")).toBeInTheDocument();

    const eraserBtn = screen.getByRole("button", { name: "지우개" });
    const brushBtn = screen.getByRole("button", { name: "칠하기" });

    expect(brushBtn).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(editor, { key: "e" });
    expect(eraserBtn).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(editor, { key: "b" });
    expect(brushBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onCancel when Escape key is pressed in the editor or prompt input", () => {
    const onCancel = vi.fn();
    render(
      <InpaintingEditor
        currentPage={1}
        imageSrc="/page.png"
        onCancel={onCancel}
        onRun={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const editor = screen.getByLabelText("1페이지 인페인팅 편집기");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    const promptInput = screen.getByLabelText("추가 지시사항");
    fireEvent.keyDown(promptInput, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("passes conservative masking option to onRun by default and respects toggle", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
      putImageData: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        data[3] = 255;
        return { data };
      })
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,maskdata");

    render(
      <InpaintingEditor
        currentPage={1}
        imageSrc="/page.png"
        onCancel={vi.fn()}
        onRun={onRun}
        initialMaskDraft={{
          width: 100,
          height: 80,
          pixels: new Uint8ClampedArray(100 * 80 * 4),
          bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }
        }}
      />
    );

    fireEvent.load(screen.getByAltText("1페이지 인페인팅 대상"));
    const conservativeCheckbox = screen.getByLabelText("보수적 경계 보존 (PanelCleaner)");
    expect(conservativeCheckbox).toBeChecked();

    const openAiButton = screen.getByRole("button", { name: /OpenAI/ });
    fireEvent.click(openAiButton);
    await Promise.resolve();

    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        options: { conservative: true }
      })
    );

    fireEvent.click(conservativeCheckbox);
    expect(conservativeCheckbox).not.toBeChecked();

    fireEvent.click(openAiButton);
    await Promise.resolve();
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        options: { conservative: false }
      })
    );
  });

  it("offers an explicit run cancellation action without closing the editor", async () => {
    const onCancelRun = vi.fn();
    const onCancel = vi.fn();
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 80 });
    let resolveFirstRun: (() => void) | undefined;
    const onRun = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstRun = resolve;
      }))
      .mockImplementationOnce(() => new Promise<void>(() => undefined));
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
      putImageData: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        data[3] = 255;
        return { data };
      })
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,maskdata");

    render(
      <InpaintingEditor
        currentPage={1}
        imageSrc="/page.png"
        onCancel={onCancel}
        onCancelRun={onCancelRun}
        onRun={onRun}
        initialMaskDraft={{
          width: 100,
          height: 80,
          pixels: new Uint8ClampedArray(100 * 80 * 4),
          bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }
        }}
      />
    );
    fireEvent.load(screen.getByAltText("1페이지 인페인팅 대상"));
    fireEvent.keyDown(screen.getByLabelText("추가 지시사항"), { key: "Enter", isComposing: true });
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "OpenAI 실행" }));
    fireEvent.keyDown(screen.getByLabelText("1페이지 인페인팅 편집기"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "인페인팅 실행 취소" }));

    expect(onCancelRun).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("1페이지 인페인팅 편집기")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "OpenAI 실행" }));
    expect(onRun).toHaveBeenCalledTimes(2);
    await act(async () => resolveFirstRun?.());
    expect(await screen.findByRole("button", { name: "인페인팅 실행 취소" })).toBeInTheDocument();
  });
});
