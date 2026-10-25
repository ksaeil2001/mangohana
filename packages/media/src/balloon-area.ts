// Reuse the reviewed cleanup-pixel probe without changing source geometry or masks.
export const SETTINGS = Object.freeze({
  thresholdPerRgb: 245, alpha: 255, connectivity: 4, windowSideFactor: 3,
  windowRounding: 'ceil(side); floor(center-side/2); clip-to-page-and-record',
  anchorRounding: 'floor(source-bbox-center)', paddingPx: 3,
  minimumSourceBlankCoverage: 0.95, minimumSourceIntersectionRatio: 0.5,
  rectangleMustContainAnchor: true,
  rectangleTieBreak: 'largest-area; shortest-center-shift; top; left; width',
  rejectWindowBoundary: true, rejectPageBoundary: true, rejectSharedComponent: true,
} as const);
export const MAX_PIXELS = 1_420_000;

export interface BalloonPoint {x: number; y: number}
export interface BalloonBox {left: number; top: number; width: number; height: number}
export type BalloonPolygon = readonly BalloonPoint[];
interface BalloonWindow extends BalloonBox {requested: BalloonBox; clipped: boolean}
export interface AnchoredRectangle extends BalloonBox {
  area: number;
  centerShiftSquared: number;
  sourceIntersectionPixels: number;
  rectangleChecks: number;
}
export interface BalloonCandidate extends BalloonBox {
  area: number;
  sourceIntersectionPixels: number;
  sourceIntersectionRatio: number;
  sourceBoundsIntersectionArea: number;
  sourceBoundsIntersectionRatio: number;
  areaToSourceBoundsRatio: number;
  centerShiftPx: number;
  collisionPixels: number;
  rectangleChecks: number;
  maximumHistogramChecks: number;
}
export interface BalloonReport {
  sourceBounds: BalloonBox;
  sourcePixelCount: number | null;
  sourceCenter: BalloonPoint;
  anchor: BalloonPoint;
  window: BalloonWindow;
  inputBasis: 'EXISTING_CLEANUP_RGBA';
  status: 'CANDIDATE_REQUIRES_REVIEW' | 'HOLD';
  reason: string | null;
  rejectionReasons: string[];
  componentPixelCount: number | null;
  sourceBlankCoverage: number | null;
  candidate: BalloonCandidate | null;
  rawBlankPixelCount?: number;
  excludedObstacleComponentPixels?: number;
  paddingValidPixelCount?: number;
  touchesPageBoundary?: boolean;
  touchesWindowBoundary?: boolean;
  sharedSourceCenters?: BalloonPoint[];
}
export interface BalloonMasks {
  rawBlank: Uint8Array;
  component: Uint8Array;
  sourceMask: Uint8Array;
  obstacles: Uint8Array;
  userMask: Uint8Array;
  automaticMask: Uint8Array;
  protectedMask: Uint8Array;
  paddingValid: Uint8Array;
}
export interface BalloonCandidateResult {report: BalloonReport; masks: BalloonMasks | null}
export interface BalloonCandidateInput {
  rgba: Uint8Array;
  width: number;
  height: number;
  sourcePolygon: BalloonPolygon;
  otherSourcePolygons?: readonly BalloonPolygon[];
  userTypesetBoxes?: readonly BalloonBox[];
  acceptedAutomaticBoxes?: readonly BalloonBox[];
  protectedBoxes?: readonly BalloonBox[];
  settings?: Readonly<Record<string, unknown>>;
}

function insist(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function validateSettings(settings: Readonly<Record<string, unknown>>) {
  insist(Object.keys(settings).length === Object.keys(SETTINGS).length, 'SETTINGS_KEYS_MISMATCH');
  for (const [key, value] of Object.entries(SETTINGS)) insist(settings[key] === value, `SETTINGS_MISMATCH:${key}`);
}
function validatePolygon(polygon: BalloonPolygon, width: number, height: number) {
  insist(Array.isArray(polygon) && polygon.length >= 3 && polygon.length <= 256, 'INVALID_POLYGON_SIZE');
  for (const point of polygon) insist(point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height, 'INVALID_POLYGON_COORDINATE');
  const bounds = polygonBounds(polygon);
  insist(bounds.width > 0 && bounds.height > 0, 'EMPTY_POLYGON_BOUNDS');
  return bounds;
}
function validateBox(box: BalloonBox, width: number, height: number) {
  insist(box && [box.left, box.top, box.width, box.height].every(Number.isFinite), 'INVALID_BOX_COORDINATE');
  insist(box.left >= 0 && box.top >= 0 && box.width > 0 && box.height > 0
    && box.left + box.width <= width && box.top + box.height <= height, 'BOX_OUTSIDE_PAGE');
}
export function polygonBounds(polygon: BalloonPolygon): BalloonBox {
  const left = Math.min(...polygon.map(point => point.x)), top = Math.min(...polygon.map(point => point.y));
  return {left, top, width: Math.max(...polygon.map(point => point.x)) - left,
    height: Math.max(...polygon.map(point => point.y)) - top};
}
export function boxPolygon(box: BalloonBox): [BalloonPoint, BalloonPoint, BalloonPoint, ...BalloonPoint[]] {
  return [{x: box.left, y: box.top}, {x: box.left + box.width, y: box.top},
    {x: box.left + box.width, y: box.top + box.height}, {x: box.left, y: box.top + box.height}];
}

// Clip inward around the renderer's floor/ceil source box; preserve its half-pixel parity.
export function centeredBalloonBox(candidateBox: BalloonBox, sourceBounds: BalloonBox): BalloonBox | null {
  for (const box of [candidateBox, sourceBounds]) insist(box && [box.left, box.top, box.width, box.height]
    .every(Number.isFinite) && box.left >= 0 && box.top >= 0 && box.width > 0 && box.height > 0,
  'INVALID_CENTERED_BOX');
  const sourceLeft = Math.floor(sourceBounds.left), sourceTop = Math.floor(sourceBounds.top);
  const sourceRight = Math.ceil(sourceBounds.left + sourceBounds.width);
  const sourceBottom = Math.ceil(sourceBounds.top + sourceBounds.height);
  const leftLimit = Math.ceil(candidateBox.left), topLimit = Math.ceil(candidateBox.top);
  const rightLimit = Math.floor(candidateBox.left + candidateBox.width);
  const bottomLimit = Math.floor(candidateBox.top + candidateBox.height);
  const twiceCenterX = sourceLeft + sourceRight, twiceCenterY = sourceTop + sourceBottom;
  insist([sourceLeft, sourceTop, sourceRight, sourceBottom, leftLimit, topLimit, rightLimit,
    bottomLimit, twiceCenterX, twiceCenterY].every(Number.isSafeInteger), 'INVALID_CENTERED_BOX');
  const width = Math.min(twiceCenterX - 2 * leftLimit, 2 * rightLimit - twiceCenterX);
  const height = Math.min(twiceCenterY - 2 * topLimit, 2 * bottomLimit - twiceCenterY);
  const sourceWidth = sourceRight - sourceLeft, sourceHeight = sourceBottom - sourceTop;
  if (width < sourceWidth || height < sourceHeight || width * height <= sourceWidth * sourceHeight) return null;
  return {left: (twiceCenterX - width) / 2, top: (twiceCenterY - height) / 2, width, height};
}

// Use inward dimensions with source parity and the smallest necessary move.
function inwardBalloonBox(candidate: BalloonBox, sourceBounds: BalloonBox): BalloonBox | null {
  const sourceLeft = Math.floor(sourceBounds.left), sourceTop = Math.floor(sourceBounds.top);
  const sourceRight = Math.ceil(sourceBounds.left + sourceBounds.width);
  const sourceBottom = Math.ceil(sourceBounds.top + sourceBounds.height);
  const left = Math.ceil(candidate.left), top = Math.ceil(candidate.top);
  const right = Math.floor(candidate.left + candidate.width);
  const bottom = Math.floor(candidate.top + candidate.height);
  const sourceWidth = sourceRight - sourceLeft, sourceHeight = sourceBottom - sourceTop;
  // Integer edges retain the source's integer or half-pixel center parity.
  const width = right - left - Math.abs(right - left - sourceWidth) % 2;
  const height = bottom - top - Math.abs(bottom - top - sourceHeight) % 2;
  // Preserve the original width and an area gain; horizontal text may also
  // use a wider, shorter rectangle without changing its source geometry.
  if (width < sourceWidth || height <= 0 || width * height <= sourceWidth * sourceHeight) return null;
  return {left: Math.max(left, Math.min(right - width, (sourceLeft + sourceRight - width) / 2)),
    top: Math.max(top, Math.min(bottom - height, (sourceTop + sourceBottom - height) / 2)), width, height};
}
// Keep the source center when possible. If that would discard a usable safe
// rectangle, retain its available size and move only the automatic layout.
// The source geometry and user typeset boxes are never changed.
export function balloonTypesetBox({report, masks}: BalloonCandidateResult): BalloonBox | null {
  const {candidate, sourceBounds, sourcePixelCount, window} = report;
  if (!candidate || !masks || !sourcePixelCount) return null;
  const box = centeredBalloonBox(candidate, sourceBounds) ?? inwardBalloonBox(candidate, sourceBounds);
  if (!box) return null;
  const local = {...box, left: box.left - window.left, top: box.top - window.top};
  insist(Number.isSafeInteger(local.left) && Number.isSafeInteger(local.top)
    && local.left >= 0 && local.top >= 0 && local.left + local.width <= window.width
    && local.top + local.height <= window.height && masks.sourceMask.length === window.width * window.height,
  'INVALID_TYPESET_CANDIDATE');
  const intersection = countRect(prefix(masks.sourceMask, window.width, window.height), window.width, local);
  if (intersection / sourcePixelCount < SETTINGS.minimumSourceIntersectionRatio) return null;
  return box;
}

// A second geometry-only choice for a word layout that needs more height.
// Reuse the same safe component, source pixels and anchor; never replace
// the maximum-area primary or change any captured geometry or masks.
export function tallerBalloonTypesetBox({report, masks}: BalloonCandidateResult, primary: BalloonBox): BalloonBox | null {
  const {candidate, sourceBounds, sourcePixelCount, sourceCenter, window} = report;
  if (!candidate || !masks || !sourcePixelCount) return null;
  insist(primary && [primary.left, primary.top, primary.width, primary.height].every(Number.isSafeInteger)
    && primary.left >= 0 && primary.top >= 0 && primary.width > 0 && primary.height > 0, 'INVALID_TYPESET_PRIMARY');
  validateRectangleMasks(masks.paddingValid, masks.sourceMask, window.width, window.height);
  insist(masks.obstacles instanceof Uint8Array && masks.obstacles.length === window.width * window.height,
    'INVALID_TYPESET_CANDIDATE');
  const anchor = {x: report.anchor.x - window.left, y: report.anchor.y - window.top};
  const obstacleSums = prefix(masks.obstacles, window.width, window.height);
  let best: RankedRectangle | null = null;
  visitAnchoredRectangles(masks.paddingValid, masks.sourceMask, window.width, window.height, anchor,
    {x: sourceCenter.x - window.left, y: sourceCenter.y - window.top}, SETTINGS.minimumSourceIntersectionRatio,
    (rectangle, sourceSums) => {
      const box = inwardBalloonBox({...rectangle, left: rectangle.left + window.left,
        top: rectangle.top + window.top}, sourceBounds);
      if (!box || box.height <= primary.height) return;
      const local = {...box, left: box.left - window.left, top: box.top - window.top};
      if (anchor.x < local.left || anchor.x >= local.left + local.width || anchor.y < local.top
        || anchor.y >= local.top + local.height) return;
      const sourceIntersectionPixels = countRect(sourceSums, window.width, local);
      if (sourceIntersectionPixels / sourcePixelCount < SETTINGS.minimumSourceIntersectionRatio
        || countRect(obstacleSums, window.width, local) !== 0) return;
      const ranked = {...box, area: box.width * box.height, sourceIntersectionPixels,
        centerShiftSquared: (box.left + box.width / 2 - sourceCenter.x) ** 2
          + (box.top + box.height / 2 - sourceCenter.y) ** 2};
      if (!best || ranked.height > best.height || ranked.height === best.height && preferable(ranked, best)) best = ranked;
    });
  const selected = best as RankedRectangle | null;
  return selected && {left: selected.left, top: selected.top, width: selected.width, height: selected.height};
}

// Pixel-center, even-odd scan conversion matches the original source and obstacle rule.
function rasterPolygon(polygon: BalloonPolygon, window: BalloonBox, mask: Uint8Array) {
  const bounds = polygonBounds(polygon);
  const first = Math.max(0, Math.ceil(bounds.top - window.top - 0.5));
  const last = Math.min(window.height - 1, Math.ceil(bounds.top + bounds.height - window.top - 0.5) - 1);
  for (let y = first; y <= last; y++) {
    const py = window.top + y + 0.5, intersections: number[] = [];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[j], b = polygon[i];
      if ((a.y > py) !== (b.y > py)) intersections.push(a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(intersections[i] - window.left - 0.5));
      const x1 = Math.min(window.width, Math.ceil(intersections[i + 1] - window.left - 0.5));
      mask.fill(1, y * window.width + x0, y * window.width + Math.max(x0, x1));
    }
  }
}
function prefix(mask: Uint8Array, width: number, height: number) {
  const stride = width + 1, sums = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += mask[y * width + x];
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + row;
    }
  }
  return sums;
}
function countRect(sums: Uint32Array, width: number, rect: BalloonBox) {
  const stride = width + 1, x0 = rect.left, y0 = rect.top, x1 = x0 + rect.width, y1 = y0 + rect.height;
  return sums[y1 * stride + x1] - sums[y0 * stride + x1] - sums[y1 * stride + x0] + sums[y0 * stride + x0];
}
type RankedRectangle = Omit<AnchoredRectangle, 'rectangleChecks'>;
function preferable(a: RankedRectangle, b: RankedRectangle | null) {
  if (!b) return true;
  for (const key of ['area', 'centerShiftSquared', 'top', 'left', 'width'] as const) {
    if (a[key] === b[key]) continue;
    return key === 'area' ? a[key] > b[key] : a[key] < b[key];
  }
  return false;
}

// Each histogram bar enters/leaves the stack once per row: O(window pixels).
// Build source sums once and share the traversal between the two rankings.
function validateRectangleMasks(valid: Uint8Array, sourceMask: Uint8Array, width: number, height: number) {
  insist(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width * height <= MAX_PIXELS && valid instanceof Uint8Array && sourceMask instanceof Uint8Array
    && valid.length === width * height && sourceMask.length === valid.length, 'INVALID_RECTANGLE_MASK');
}
function visitAnchoredRectangles(valid: Uint8Array, sourceMask: Uint8Array, width: number,
  height: number, anchor: BalloonPoint, sourceCenter: BalloonPoint,
  minimumIntersectionRatio: number, visit: (rectangle: RankedRectangle, sourceSums: Uint32Array) => void): number {
  validateRectangleMasks(valid, sourceMask, width, height);
  insist(anchor && Number.isInteger(anchor.x) && Number.isInteger(anchor.y) && anchor.x >= 0
    && anchor.y >= 0 && anchor.x < width && anchor.y < height && sourceCenter
    && Number.isFinite(sourceCenter.x) && Number.isFinite(sourceCenter.y), 'INVALID_RECTANGLE_ANCHOR');
  insist(Number.isFinite(minimumIntersectionRatio) && minimumIntersectionRatio >= 0 && minimumIntersectionRatio <= 1,
    'INVALID_INTERSECTION_RATIO');
  const sourceSums = prefix(sourceMask, width, height), sourcePixels = sourceSums[sourceSums.length - 1];
  if (!sourcePixels || !valid[anchor.y * width + anchor.x]) return 0;
  const heights = new Uint32Array(width), stack = new Int32Array(width + 1);
  let rectangleChecks = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) heights[x] = valid[y * width + x] ? heights[x] + 1 : 0;
    let stackSize = 0;
    for (let x = 0; x <= width; x++) {
      const nextHeight = x < width ? heights[x] : 0;
      while (stackSize && heights[stack[stackSize - 1]] > nextHeight) {
        const bar = stack[--stackSize], rectHeight = heights[bar];
        const left = stackSize ? stack[stackSize - 1] + 1 : 0;
        const rect = {left, top: y - rectHeight + 1, width: x - left, height: rectHeight};
        rectangleChecks++;
        if (anchor.x < rect.left || anchor.x >= rect.left + rect.width || anchor.y < rect.top
          || anchor.y >= rect.top + rect.height) continue;
        const sourceIntersectionPixels = countRect(sourceSums, width, rect);
        if (sourceIntersectionPixels / sourcePixels < minimumIntersectionRatio) continue;
        const centerShiftSquared = (rect.left + rect.width / 2 - sourceCenter.x) ** 2
          + (rect.top + rect.height / 2 - sourceCenter.y) ** 2;
        visit({...rect, area: rect.width * rect.height, centerShiftSquared, sourceIntersectionPixels}, sourceSums);
      }
      if (x < width) stack[stackSize++] = x;
    }
  }
  return rectangleChecks;
}
export function largestAnchoredRectangle(valid: Uint8Array, sourceMask: Uint8Array, width: number,
  height: number, anchor: BalloonPoint, sourceCenter: BalloonPoint,
  minimumIntersectionRatio: number = SETTINGS.minimumSourceIntersectionRatio): AnchoredRectangle | null {
  let best: RankedRectangle | null = null;
  const rectangleChecks = visitAnchoredRectangles(valid, sourceMask, width, height, anchor, sourceCenter,
    minimumIntersectionRatio, candidate => {if (preferable(candidate, best)) best = candidate;});
  const selected = best as RankedRectangle | null;
  return selected && {...selected, rectangleChecks};
}
function erodeSquare(mask: Uint8Array, width: number, height: number, radius: number) {
  const sums = prefix(mask, width, height), output = new Uint8Array(mask.length), side = radius * 2 + 1;
  for (let y = radius; y < height - radius; y++) for (let x = radius; x < width - radius; x++) {
    const rectangle = {left: x - radius, top: y - radius, width: side, height: side};
    if (countRect(sums, width, rectangle) === side * side) output[y * width + x] = 1;
  }
  return output;
}
function count(mask: Uint8Array) {let result = 0; for (const pixel of mask) result += pixel; return result;}

export function findBalloonCandidate({rgba, width, height, sourcePolygon, otherSourcePolygons = [],
  userTypesetBoxes = [], acceptedAutomaticBoxes = [], protectedBoxes = [],
  settings = SETTINGS}: BalloonCandidateInput): BalloonCandidateResult {
  validateSettings(settings);
  const pageBytes = width * height * 4;
  insist(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && Number.isSafeInteger(pageBytes) && rgba instanceof Uint8Array && rgba.length === pageBytes, 'INVALID_RAW_RGBA');
  const sourceBounds = validatePolygon(sourcePolygon, width, height);
  for (const polygon of otherSourcePolygons) validatePolygon(polygon, width, height);
  for (const box of [...userTypesetBoxes, ...acceptedAutomaticBoxes, ...protectedBoxes]) validateBox(box, width, height);
  const center = {x: sourceBounds.left + sourceBounds.width / 2, y: sourceBounds.top + sourceBounds.height / 2};
  const side = Math.ceil(SETTINGS.windowSideFactor * Math.max(sourceBounds.width, sourceBounds.height));
  const requested = {left: Math.floor(center.x - side / 2), top: Math.floor(center.y - side / 2), width: side, height: side};
  const left = Math.max(0, requested.left), top = Math.max(0, requested.top);
  const right = Math.min(width, requested.left + side), bottom = Math.min(height, requested.top + side);
  const window = {left, top, width: right - left, height: bottom - top};
  insist(window.width * window.height > 0, 'EMPTY_SEARCH_WINDOW');
  const anchorPage = {x: Math.floor(center.x), y: Math.floor(center.y)};
  const anchor = {x: anchorPage.x - left, y: anchorPage.y - top};
  const windowPixels = window.width * window.height;
  const base = {sourceBounds, sourceCenter: center, anchor: anchorPage,
    window: {...window, requested, clipped: left !== requested.left || top !== requested.top
      || right !== requested.left + side || bottom !== requested.top + side},
    inputBasis: 'EXISTING_CLEANUP_RGBA' as const};
  // The limit bounds per-block work, not the already validated product image size.
  if (windowPixels > MAX_PIXELS) return {report: {...base, sourcePixelCount: null, status: 'HOLD',
    reason: 'WINDOW_PIXEL_LIMIT', rejectionReasons: ['WINDOW_PIXEL_LIMIT'], componentPixelCount: null,
    sourceBlankCoverage: null, candidate: null}, masks: null};
  const rawBlank = new Uint8Array(windowPixels), component = new Uint8Array(windowPixels);
  const sourceMask = new Uint8Array(windowPixels), obstacles = new Uint8Array(windowPixels);
  const userMask = new Uint8Array(windowPixels), automaticMask = new Uint8Array(windowPixels);
  const protectedMask = new Uint8Array(windowPixels);
  rasterPolygon(sourcePolygon, window, sourceMask);
  const sourcePixels = count(sourceMask);
  if (!sourcePixels) return {report: {...base, sourcePixelCount: 0, status: 'HOLD',
    reason: 'NO_SOURCE_PIXEL_CENTERS', rejectionReasons: ['NO_SOURCE_PIXEL_CENTERS'],
    componentPixelCount: null, sourceBlankCoverage: null, candidate: null}, masks: null};
  for (const polygon of otherSourcePolygons) rasterPolygon(polygon, window, obstacles);
  for (const box of userTypesetBoxes) rasterPolygon(boxPolygon(box), window, userMask);
  for (const box of acceptedAutomaticBoxes) rasterPolygon(boxPolygon(box), window, automaticMask);
  for (const box of protectedBoxes) rasterPolygon(boxPolygon(box), window, protectedMask);
  for (let i = 0; i < windowPixels; i++) obstacles[i] |= userMask[i] | automaticMask[i] | protectedMask[i];
  for (let y = 0; y < window.height; y++) for (let x = 0; x < window.width; x++) {
    const i = y * window.width + x, p = ((top + y) * width + left + x) * 4;
    if (rgba[p] >= SETTINGS.thresholdPerRgb && rgba[p + 1] >= SETTINGS.thresholdPerRgb
      && rgba[p + 2] >= SETTINGS.thresholdPerRgb && rgba[p + 3] === SETTINGS.alpha) rawBlank[i] = 1;
  }
  const masks = {rawBlank, component, sourceMask, obstacles, userMask, automaticMask, protectedMask,
    paddingValid: new Uint8Array(windowPixels)};
  const anchorIndex = anchor.y * window.width + anchor.x;
  if (!rawBlank[anchorIndex]) return {report: {...base, sourcePixelCount: sourcePixels, status: 'HOLD',
    reason: 'ANCHOR_NOT_IN_BLANK_COMPONENT', rejectionReasons: ['ANCHOR_NOT_IN_BLANK_COMPONENT'],
    componentPixelCount: 0, sourceBlankCoverage: 0, candidate: null}, masks};
  const queue = new Int32Array(windowPixels); let start = 0, end = 1;
  queue[0] = anchorIndex; component[anchorIndex] = 1;
  let touchesWindow = false, touchesPage = false;
  while (start < end) {
    const i = queue[start++], x = i % window.width, y = Math.floor(i / window.width);
    if (x === 0 || y === 0 || x === window.width - 1 || y === window.height - 1) touchesWindow = true;
    if (left + x === 0 || top + y === 0 || left + x === width - 1 || top + y === height - 1) touchesPage = true;
    const neighbors = [x ? i - 1 : -1, x + 1 < window.width ? i + 1 : -1,
      y ? i - window.width : -1, y + 1 < window.height ? i + window.width : -1];
    for (const next of neighbors) if (next >= 0 && rawBlank[next] && !component[next]) {
      component[next] = 1; queue[end++] = next;
    }
  }
  let coveredSource = 0, excludedComponent = 0;
  const unpaddedValid = new Uint8Array(windowPixels);
  for (let i = 0; i < windowPixels; i++) {
    coveredSource += sourceMask[i] && component[i] ? 1 : 0;
    if (component[i] && obstacles[i]) excludedComponent++;
    unpaddedValid[i] = component[i] && !obstacles[i] ? 1 : 0;
  }
  masks.paddingValid = erodeSquare(unpaddedValid, window.width, window.height, SETTINGS.paddingPx);
  const sharedCenters = otherSourcePolygons.map(polygon => {
    const bounds = polygonBounds(polygon);
    return {x: Math.floor(bounds.left + bounds.width / 2), y: Math.floor(bounds.top + bounds.height / 2)};
  }).filter(point => point.x >= left && point.y >= top && point.x < right && point.y < bottom
    && component[(point.y - top) * window.width + point.x - left]);
  const coverage = coveredSource / sourcePixels, reasons: string[] = [];
  if (touchesPage) reasons.push('COMPONENT_TOUCHES_PAGE_BOUNDARY');
  if (touchesWindow) reasons.push('COMPONENT_TOUCHES_WINDOW_BOUNDARY');
  if (sharedCenters.length) reasons.push('SHARED_COMPONENT');
  if (coverage < SETTINGS.minimumSourceBlankCoverage) reasons.push('INSUFFICIENT_SOURCE_BLANK_COVERAGE');
  if (!masks.paddingValid[anchorIndex]) reasons.push('ANCHOR_EXCLUDED_OR_PADDING_UNSAFE');
  let candidate: BalloonCandidate | null = null;
  if (!reasons.length) {
    const local = largestAnchoredRectangle(masks.paddingValid, sourceMask, window.width, window.height, anchor,
      {x: center.x - left, y: center.y - top}, SETTINGS.minimumSourceIntersectionRatio);
    if (!local) reasons.push('NO_ANCHORED_RECTANGLE_WITH_SOURCE_INTERSECTION');
    else {
      const rectangle = {left: local.left + left, top: local.top + top, width: local.width, height: local.height};
      const overlapWidth = Math.max(0, Math.min(rectangle.left + rectangle.width, sourceBounds.left + sourceBounds.width)
        - Math.max(rectangle.left, sourceBounds.left));
      const overlapHeight = Math.max(0, Math.min(rectangle.top + rectangle.height, sourceBounds.top + sourceBounds.height)
        - Math.max(rectangle.top, sourceBounds.top));
      const obstacleSums = prefix(obstacles, window.width, window.height);
      const collisionPixels = countRect(obstacleSums, window.width, local);
      insist(collisionPixels === 0, 'CANDIDATE_COLLISION');
      candidate = {...rectangle, area: local.area, sourceIntersectionPixels: local.sourceIntersectionPixels,
        sourceIntersectionRatio: local.sourceIntersectionPixels / sourcePixels,
        sourceBoundsIntersectionArea: overlapWidth * overlapHeight,
        sourceBoundsIntersectionRatio: overlapWidth * overlapHeight / (sourceBounds.width * sourceBounds.height),
        areaToSourceBoundsRatio: local.area / (sourceBounds.width * sourceBounds.height),
        centerShiftPx: Math.sqrt(local.centerShiftSquared), collisionPixels,
        rectangleChecks: local.rectangleChecks, maximumHistogramChecks: windowPixels};
    }
  }
  return {report: {...base, sourcePixelCount: sourcePixels, status: candidate ? 'CANDIDATE_REQUIRES_REVIEW' : 'HOLD',
    reason: reasons[0] ?? null, rejectionReasons: reasons, componentPixelCount: end,
    rawBlankPixelCount: count(rawBlank), sourceBlankCoverage: coverage,
    excludedObstacleComponentPixels: excludedComponent, paddingValidPixelCount: count(masks.paddingValid),
    touchesPageBoundary: touchesPage, touchesWindowBoundary: touchesWindow, sharedSourceCenters: sharedCenters, candidate}, masks};
}
