import type { DialogueLine } from "../shared/projectTypes.js";
import {
  autoFitFontSizeForBubbleShape,
  calculateContrastStroke,
  getRecommendedFontFallbackChain,
  layoutTextForBubbleShape
} from "./typesettingGeometry.js";

/**
 * Returns only the explicitly user-applied translation for a dialogue line.
 * AI/reference/source text is review material and must never be burned into a
 * render-ready image implicitly.
 */
export function getResolvedDialogueText(line: DialogueLine): string {
  const text = line.userTranslation?.trim() ?? "";
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

export type RenderBurnInOptions = {
  defaultFontFamily?: string;
  defaultTextColor?: string;
  enableStroke?: boolean;
  textResolver?: (line: DialogueLine) => string;
};

/**
 * Renders dialogue typesetting bubbles directly onto an HTML5 2D Canvas context.
 */
export function renderTypesettingToCanvas(
  ctx: CanvasRenderingContext2D,
  lines: readonly DialogueLine[],
  canvasWidth: number,
  canvasHeight: number,
  options: RenderBurnInOptions = {}
): void {
  const {
    defaultFontFamily = "Pretendard",
    defaultTextColor = "#000000",
    enableStroke = true,
    textResolver
  } = options;

  for (const line of lines) {
    const text = textResolver?.(line) ?? getResolvedDialogueText(line);
    if (!text) continue;

    const ts = line.typesetting;
    // Normalized bounding box (default to centered fallback if missing)
    const bbox = ts?.bbox ?? { x: 0.2, y: 0.2, width: 0.6, height: 0.15 };
    const shape = ts?.shape ?? "ellipse";
    const rotationDegrees = ts?.rotationDegrees ?? 0;
    const writingMode = ts?.writingMode ?? "horizontal-tb";
    const align = ts?.align ?? "center";
    const textColor = ts?.color || defaultTextColor;

    const pixelX = bbox.x * canvasWidth;
    const pixelY = bbox.y * canvasHeight;
    const pixelWidth = bbox.width * canvasWidth;
    const pixelHeight = bbox.height * canvasHeight;

    if (pixelWidth <= 0 || pixelHeight <= 0) continue;

    // Calculate layout using shape chords
    const layout = ts?.fontSizeRatio
      ? layoutTextForBubbleShape(text, {
          shape,
          fontSizeRatio: ts.fontSizeRatio
        })
      : autoFitFontSizeForBubbleShape(text, { shape });

    const fontPx = Math.max(10, Math.round(layout.fontSizeRatio * pixelHeight));
    const fontChain = getRecommendedFontFallbackChain("ko", ts?.fontFamily || defaultFontFamily);

    const contrast = calculateContrastStroke({
      textColor,
      isDarkBackground: false,
      fontSizeRatio: layout.fontSizeRatio
    });
    const strokeColor = ts?.strokeColor || contrast.strokeColor;
    const strokeWidth = ts?.strokeWidth ?? contrast.strokeWidth;

    ctx.save();

    // Bbox translation & rotation
    const centerX = pixelX + pixelWidth / 2;
    const centerY = pixelY + pixelHeight / 2;
    ctx.translate(centerX, centerY);
    if (rotationDegrees !== 0) {
      ctx.rotate((rotationDegrees * Math.PI) / 180);
    }

    ctx.font = `bold ${fontPx}px ${fontChain}`;
    ctx.textBaseline = "middle";

    if (writingMode === "vertical-rl") {
      ctx.textAlign = "center";
      const totalColumns = layout.lines.length;
      const colStep = fontPx * 1.3;
      const startX = ((totalColumns - 1) * colStep) / 2;

      layout.lines.forEach((lineLayout, colIndex) => {
        const colX = startX - colIndex * colStep;
        const chars = Array.from(lineLayout.text);
        const charStep = fontPx * 1.15;
        const startCharY = -((chars.length - 1) * charStep) / 2;

        chars.forEach((char, charIdx) => {
          const charY = startCharY + charIdx * charStep;
          if (enableStroke && strokeWidth > 0) {
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = strokeWidth * 2;
            ctx.lineJoin = "round";
            ctx.miterLimit = 2;
            ctx.strokeText(char, colX, charY);
          }
          ctx.fillStyle = textColor;
          ctx.fillText(char, colX, charY);
        });
      });
    } else {
      const totalHeight = layout.totalHeightRatio * pixelHeight;
      const startY = -totalHeight / 2;

      for (const lineLayout of layout.lines) {
        const currentY = startY + lineLayout.relativeY * pixelHeight;
        let drawX = 0;

        if (align === "center") {
          ctx.textAlign = "center";
          drawX = 0;
        } else if (align === "left") {
          ctx.textAlign = "left";
          drawX = -pixelWidth / 2 + (lineLayout.startX * pixelWidth);
        } else {
          ctx.textAlign = "right";
          drawX = pixelWidth / 2 - (pixelWidth - (lineLayout.startX + lineLayout.width) * pixelWidth);
        }

        if (enableStroke && strokeWidth > 0) {
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = strokeWidth * 2;
          ctx.lineJoin = "round";
          ctx.miterLimit = 2;
          ctx.strokeText(lineLayout.text, drawX, currentY);
        }

        ctx.fillStyle = textColor;
        ctx.fillText(lineLayout.text, drawX, currentY);
      }
    }

    ctx.restore();
  }
}

/**
 * Creates a high-resolution PNG/WebP Blob with typesetting burned into the base image.
 */
export async function burnTypesettingToBlob(
  imageSource: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width: number; height: number },
  lines: readonly DialogueLine[],
  mimeType: string = "image/png",
  quality: number = 0.95,
  options: RenderBurnInOptions = {}
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const width = imageSource.naturalWidth || imageSource.width;
  const height = imageSource.naturalHeight || imageSource.height;

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create 2D canvas context for typesetting export");
  }

  // Draw base image (Clean / Inpainted or Original)
  ctx.drawImage(imageSource, 0, 0, width, height);

  // Render dialogue typesetting
  renderTypesettingToCanvas(ctx, lines, width, height, options);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob serialization failed"));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Loads an image by URL/path and burns dialogue typesetting into a downloadable Blob.
 */
export async function burnTypesettingFromUrl(
  imageUrl: string,
  lines: readonly DialogueLine[],
  mimeType: string = "image/png",
  quality: number = 0.95,
  timeoutMs: number = 15000,
  options: RenderBurnInOptions = {}
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    const timeoutId = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      reject(new Error("이미지 로드 시간 초과로 식자 내보내기에 실패했습니다."));
    }, timeoutMs);

    img.onload = async () => {
      clearTimeout(timeoutId);
      try {
        const blob = await burnTypesettingToBlob(img, lines, mimeType, quality, options);
        resolve(blob);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      clearTimeout(timeoutId);
      reject(new Error("식자 내보내기용 이미지 로드에 실패했습니다."));
    };
    img.src = imageUrl;
  });
}
