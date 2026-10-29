import type { NormalizedBbox } from "./speechBubbleExtraction.js";

export type BubbleShape =
  | "rectangle"
  | "ellipse"
  | "rounded_rectangle"
  | "cloud"
  | "spiky";

export type ShapePadding = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export const DEFAULT_SHAPE_PADDING: ShapePadding = {
  top: 0.08,
  bottom: 0.08,
  left: 0.08,
  right: 0.08
};

export type HorizontalSpan = {
  startX: number;
  width: number;
};

/**
 * Calculates the available horizontal width and start X at a given relative Y (0 to 1) inside a shape.
 * Coordinates are normalized to [0, 1] within the bounding box.
 */
export function getAvailableSpanAtY(
  shape: BubbleShape,
  relativeY: number,
  padding: ShapePadding = DEFAULT_SHAPE_PADDING
): HorizontalSpan {
  const clampedY = Math.max(0, Math.min(1, relativeY));

  // If outside vertical padding bounds, return zero span
  if (clampedY < padding.top || clampedY > 1 - padding.bottom) {
    return { startX: 0.5, width: 0 };
  }

  const usableHeight = 1 - padding.top - padding.bottom;
  if (usableHeight <= 0) return { startX: 0.5, width: 0 };

  const normY = (clampedY - padding.top) / usableHeight; // 0 to 1 within usable area
  const usableWidth = Math.max(0, 1 - padding.left - padding.right);
  const centerX = padding.left + usableWidth / 2;

  switch (shape) {
    case "ellipse":
    case "cloud": {
      // Ellipse formula: ((y - cy)/ry)^2 + ((x - cx)/rx)^2 <= 1
      // normY goes from 0 to 1, centered at 0.5
      const dy = normY - 0.5; // -0.5 to 0.5
      const ry = 0.5;
      const term = 1 - Math.pow(dy / ry, 2);
      if (term <= 0) return { startX: centerX, width: 0 };

      const halfWidth = (usableWidth / 2) * Math.sqrt(term);
      return {
        startX: Math.max(0, centerX - halfWidth),
        width: Math.max(0, halfWidth * 2)
      };
    }

    case "rounded_rectangle": {
      const cornerRadius = Math.min(0.25, usableWidth / 2); // Relative to usable height/width
      if (cornerRadius > 0 && normY < cornerRadius) {
        // Top rounded corner
        const dy = cornerRadius - normY;
        const halfWidth = (usableWidth / 2) - cornerRadius + Math.sqrt(Math.max(0, cornerRadius * cornerRadius - dy * dy));
        return {
          startX: Math.max(0, centerX - halfWidth),
          width: Math.max(0, halfWidth * 2)
        };
      } else if (cornerRadius > 0 && normY > 1 - cornerRadius) {
        // Bottom rounded corner
        const dy = normY - (1 - cornerRadius);
        const halfWidth = (usableWidth / 2) - cornerRadius + Math.sqrt(Math.max(0, cornerRadius * cornerRadius - dy * dy));
        return {
          startX: Math.max(0, centerX - halfWidth),
          width: Math.max(0, halfWidth * 2)
        };
      }
      // Straight middle
      return {
        startX: padding.left,
        width: usableWidth
      };
    }

    case "spiky": {
      // Spiky / explosion bubble: slight inset for safety
      const safetyMargin = 0.05;
      const spikyWidth = Math.max(0, usableWidth * (1 - safetyMargin * 2));
      return {
        startX: padding.left + (usableWidth - spikyWidth) / 2,
        width: spikyWidth
      };
    }

    case "rectangle":
    default:
      return {
        startX: padding.left,
        width: usableWidth
      };
  }
}

/**
 * Estimates bubble shape from aspect ratio or extraction hints
 */
export function inferBubbleShape(
  bbox: NormalizedBbox,
  hintType?: string
): BubbleShape {
  if (hintType === "thought_bubble") return "cloud";
  if (hintType === "filtered_speech") return "spiky";
  if (hintType === "narration_box") return "rectangle";

  const aspectRatio = bbox.width / Math.max(0.001, bbox.height);
  // Manga balloons are typically tall ellipses (aspect 0.6 - 1.4) or wide ellipses
  if (aspectRatio > 0.4 && aspectRatio < 2.5) {
    return "ellipse";
  }
  return "rounded_rectangle";
}
