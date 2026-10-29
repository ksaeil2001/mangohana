import type {
  ProductionOcrDetection,
  ProductionOcrOrientation,
  ProductionOcrPoint
} from "../../../shared/productionOcr.js";

export function parseProductionOcrDetections(
  input: unknown,
  imageWidth: number,
  imageHeight: number,
  onInvalidDetection?: (index: number) => void
): readonly ProductionOcrDetection[] {
  if (!isPositiveDimension(imageWidth) || !isPositiveDimension(imageHeight) || !isRecord(input)) {
    throwInvalid();
  }
  if (!Array.isArray(input.detections)) throwInvalid();

  const seenIds = new Set<string>();
  return input.detections.flatMap((value, index): ProductionOcrDetection[] => {
    try {
      return [parseDetection(value, seenIds, imageWidth, imageHeight)];
    } catch (error) {
      if (!onInvalidDetection) throw error;
      onInvalidDetection(index + 1);
      return [];
    }
  });
}

function parseDetection(
  value: unknown,
  seenIds: Set<string>,
  imageWidth: number,
  imageHeight: number
): ProductionOcrDetection {
  if (!isRecord(value) || typeof value.detectionId !== "string" || value.detectionId.length === 0) {
    throwInvalid();
  }
  if (seenIds.has(value.detectionId)) throwInvalid();
  seenIds.add(value.detectionId);
  if (!Array.isArray(value.quad) || value.quad.length !== 4) throwInvalid();
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) {
    throwInvalid();
  }

  const sourceQuadPx = value.quad.map((point) => parsePoint(point, imageWidth, imageHeight)) as unknown as ProductionOcrDetection["sourceQuadPx"];
  const xs = sourceQuadPx.map((point) => point.x);
  const ys = sourceQuadPx.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX <= minX || maxY <= minY) throwInvalid();

  const sourceBboxPx = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
  const bbox = {
    x: minX / imageWidth,
    y: minY / imageHeight,
    width: (maxX - minX) / imageWidth,
    height: (maxY - minY) / imageHeight
  };
  const polygon = sourceQuadPx.map((point) => ({
    x: point.x / imageWidth,
    y: point.y / imageHeight
  })) as unknown as ProductionOcrDetection["polygon"];

  return {
    detectionId: value.detectionId,
    sourceQuadPx,
    sourceBboxPx,
    bbox,
    polygon,
    score: value.score,
    orientation: detectOrientation(sourceQuadPx),
    imageWidth,
    imageHeight
  };
}

function parsePoint(input: unknown, imageWidth: number, imageHeight: number): ProductionOcrPoint {
  if (!Array.isArray(input) || input.length !== 2) throwInvalid();
  const [x, y] = input;
  if (
    typeof x !== "number"
    || typeof y !== "number"
    || !Number.isFinite(x)
    || !Number.isFinite(y)
    || x < 0
    || x > imageWidth
    || y < 0
    || y > imageHeight
  ) {
    throwInvalid();
  }
  return { x, y };
}

function detectOrientation(quad: ProductionOcrDetection["sourceQuadPx"]): ProductionOcrOrientation {
  const firstEdge = vector(quad[0], quad[1]);
  const secondEdge = vector(quad[1], quad[2]);
  const shortestLength = Math.min(firstEdge.length, secondEdge.length);
  const longest = firstEdge.length >= secondEdge.length ? firstEdge : secondEdge;
  if (longest.length === 0) return "unknown";
  if (shortestLength / longest.length >= 0.8) return "unknown";
  const angle = Math.abs(Math.atan2(longest.dy, longest.dx) * 180 / Math.PI) % 180;
  if (angle <= 20 || angle >= 160) return "horizontal";
  if (angle >= 70 && angle <= 110) return "vertical";
  return "unknown";
}

function vector(from: ProductionOcrPoint, to: ProductionOcrPoint): { dx: number; dy: number; length: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { dx, dy, length: Math.hypot(dx, dy) };
}

function isPositiveDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwInvalid(): never {
  throw new Error("Invalid Production OCR detector output");
}
