/**
 * Pure image mask morphology operations (Dilation, Adaptive Radius Calculation, Safe-Area Clipping).
 * Designed for text-mask expansion in comic inpainting pipelines.
 */

export type MaskDilationOptions = {
  radius: number;
};

export type AdaptiveRadiusOptions = {
  bboxWidth: number; // Normalized (0 to 1) or absolute pixel width
  bboxHeight: number; // Normalized (0 to 1) or absolute pixel height
  canvasWidth: number;
  canvasHeight: number;
  minRadius?: number; // Minimum pixel radius (default: 3)
  maxRadius?: number; // Maximum pixel radius (default: 24)
};

export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Calculates adaptive dilation radius in pixels based on text bounding box size and canvas resolution.
 * Smaller speech bubbles get 3-5px dilation to avoid leaking over bubble boundaries;
 * larger sound effects / title text get larger dilation (8-20px) to clear stroke anti-aliasing.
 */
export function calculateAdaptiveDilationRadius(options: AdaptiveRadiusOptions): number {
  const {
    bboxWidth,
    bboxHeight,
    canvasWidth,
    canvasHeight,
    minRadius = 3,
    maxRadius = 24
  } = options;

  // Convert normalized bbox to absolute pixel dimensions if values are <= 1
  const pixelWidth = bboxWidth <= 1.0 ? bboxWidth * canvasWidth : bboxWidth;
  const pixelHeight = bboxHeight <= 1.0 ? bboxHeight * canvasHeight : bboxHeight;

  // Reference characteristic dimension (e.g. estimated line height / character size)
  const charDimension = Math.min(pixelWidth, pixelHeight);
  const canvasDiagonal = Math.sqrt(canvasWidth * canvasWidth + canvasHeight * canvasHeight);

  // Dilation radius scales with character size: roughly 8% - 12% of character size
  const scaleFromChar = charDimension * 0.1;
  // Resolution scaling (base 1000px diagonal -> factor 1.0)
  const resolutionScale = Math.max(0.5, Math.min(3.0, canvasDiagonal / 1500));

  const estimatedRadius = Math.round(scaleFromChar * resolutionScale);
  return Math.max(minRadius, Math.min(maxRadius, estimatedRadius));
}

/**
 * Performs Euclidean morphological dilation on a 1-channel binary/grayscale mask.
 * Each pixel in mask is 0 (unmasked/background) or >0 (masked/text area).
 * Returns a new Uint8Array of the same dimensions with dilated mask values (255 for masked).
 */
export function dilateBinaryMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  if (width <= 0 || height <= 0 || mask.length !== width * height) {
    throw new Error(`Invalid mask buffer dimensions: ${width}x${height} vs length ${mask.length}`);
  }

  const r = Math.max(0, Math.floor(radius));
  if (r === 0) {
    return new Uint8Array(mask);
  }

  const output = new Uint8Array(width * height);
  const rSquared = r * r;

  // Precompute circle offsets for Euclidean dilation
  const offsets: Array<[number, number]> = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy <= rSquared) {
        offsets.push([dx, dy]);
      }
    }
  }

  // Iterate over foreground pixels and stamp circular brush
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[rowOffset + x]! > 0) {
        for (let i = 0; i < offsets.length; i += 1) {
          const [dx, dy] = offsets[i]!;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            output[ny * width + nx] = 255;
          }
        }
      }
    }
  }

  return output;
}

/**
 * Clips a 1-channel mask so that any pixels outside the normalized safe area rectangle are set to 0.
 * Prevents dilated text masks from expanding outside speech bubble borders or panel gutters.
 */
export function clipMaskToNormalizedBounds(
  mask: Uint8Array,
  width: number,
  height: number,
  safeArea: NormalizedRect
): Uint8Array {
  const minX = Math.max(0, Math.floor(safeArea.x * width));
  const minY = Math.max(0, Math.floor(safeArea.y * height));
  const maxX = Math.min(width, Math.ceil((safeArea.x + safeArea.width) * width));
  const maxY = Math.min(height, Math.ceil((safeArea.y + safeArea.height) * height));

  const output = new Uint8Array(mask.length);
  for (let y = minY; y < maxY; y += 1) {
    const rowOffset = y * width;
    for (let x = minX; x < maxX; x += 1) {
      output[rowOffset + x] = mask[rowOffset + x]!;
    }
  }

  return output;
}

/**
 * PanelCleaner 원칙: 보수적 마스크 팽창 함수.
 * 외곽선 침범을 억제하기 위해 보수적 반경(최대 6px 제한)을 적용하고 지정 시 안전 영역으로 클리핑합니다.
 */
export function applyConservativeMaskDilation(args: {
  mask: Uint8Array;
  width: number;
  height: number;
  radius?: number;
  safeArea?: NormalizedRect;
}): Uint8Array {
  const { mask, width, height, radius = 3, safeArea } = args;
  const conservativeRadius = Math.max(1, Math.min(6, Math.floor(radius)));
  const dilated = dilateBinaryMask(mask, width, height, conservativeRadius);
  if (safeArea) {
    return clipMaskToNormalizedBounds(dilated, width, height, safeArea);
  }
  return dilated;
}
