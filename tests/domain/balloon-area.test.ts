import {it, expect} from 'vitest';
import {SETTINGS, MAX_PIXELS, boxPolygon, polygonBounds, centeredBalloonBox, balloonTypesetBox, findBalloonCandidate,
  largestAnchoredRectangle, tallerBalloonTypesetBox, type BalloonBox, type BalloonCandidateInput,
  type AnchoredRectangle, type BalloonCandidateResult} from '../../packages/media/src/balloon-area.js';

const polygon = (left: number, top: number, width: number, height: number) => boxPolygon({left, top, width, height});
function image(width = 80, height = 60, blank: BalloonBox | null = {left: 28, top: 18, width: 24, height: 24}) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba[i + 3] = 255;
  if (blank) for (let y = blank.top; y < blank.top + blank.height; y++)
    for (let x = blank.left; x < blank.left + blank.width; x++) rgba.set([255, 255, 255, 255], (y * width + x) * 4);
  return {rgba, width, height, sourcePolygon: polygon(35, 25, 10, 10)};
}
const reason = (input: BalloonCandidateInput, expected: string) => expect(findBalloonCandidate(input).report.reason).toBe(expected);
function candidate(input: BalloonCandidateInput) {
  const found = findBalloonCandidate(input).report.candidate;
  if (!found) throw new Error('Expected a synthetic geometry candidate');
  return found;
}

it('reuses the closed-component deterministic padded rectangle without modifying inputs', () => {
  const input = image(), beforeRaw = input.rgba.slice(), beforeGeometry = structuredClone(input.sourcePolygon);
  const first = findBalloonCandidate(input), second = findBalloonCandidate(input);
  expect(first).toEqual(second);
  expect(first.report.candidate).toMatchObject({left: 31, top: 21, width: 18, height: 18,
    sourceIntersectionRatio: 1, collisionPixels: 0});
  expect(first.report.sourceBlankCoverage).toBe(1);
  expect(input.rgba).toEqual(beforeRaw);
  expect(input.sourcePolygon).toEqual(beforeGeometry);
  expect(first.report).not.toHaveProperty('qualityPass');
  expect(first.report).not.toHaveProperty('humanGroundTruth');
});
it('uses empty obstacle lists when user and automatic boxes are not specified', () => {
  const input = image();
  expect(findBalloonCandidate(input)).toEqual(findBalloonCandidate({...input, otherSourcePolygons: [],
    userTypesetBoxes: [], acceptedAutomaticBoxes: [], protectedBoxes: []}));
});
it('holds a dark anchor without looking for another white seed', () => {
  const input = image(); input.rgba.set([0, 0, 0, 255], (30 * input.width + 40) * 4);
  const result = findBalloonCandidate(input);
  expect(result.report.reason).toBe('ANCHOR_NOT_IN_BLANK_COMPONENT');
  expect(result.report.componentPixelCount).toBe(0);
});
it('does not accept one RGB channel below the reviewed threshold', () => {
  const input = image(); input.rgba.set([245, 244, 245, 255], (30 * input.width + 40) * 4);
  reason(input, 'ANCHOR_NOT_IN_BLANK_COMPONENT');
});
it('keeps the inclusive 245 threshold for all RGB channels', () => {
  const input = image();
  for (let i = 0; i < input.rgba.length; i += 4) if (input.rgba[i] === 255) input.rgba.set([245, 245, 245, 255], i);
  expect(findBalloonCandidate(input).report.candidate).not.toBeNull();
});
it('excludes a nonopaque anchor', () => {
  const input = image(); input.rgba[(30 * input.width + 40) * 4 + 3] = 254;
  reason(input, 'ANCHOR_NOT_IN_BLANK_COMPONENT');
});
it('keeps 4-connectivity when a white neighbor only meets at a corner', () => {
  const input = image(20, 20, null); input.sourcePolygon = polygon(10, 10, 1, 1);
  input.rgba.set([255, 255, 255, 255], (10 * 20 + 10) * 4);
  input.rgba.set([255, 255, 255, 255], (11 * 20 + 11) * 4);
  const result = findBalloonCandidate(input);
  expect(result.report.componentPixelCount).toBe(1);
  expect(result.report.touchesWindowBoundary).toBe(false);
});
it('holds a component open at the window boundary away from the page boundary', () => {
  const input = image(100, 100, {left: 15, top: 5, width: 55, height: 55});
  const result = findBalloonCandidate(input);
  expect(result.report.reason).toBe('COMPONENT_TOUCHES_WINDOW_BOUNDARY');
  expect(result.report.touchesPageBoundary).toBe(false);
});
it('retains page-boundary and clipped-window reasons independently', () => {
  const input = image(40, 40, {left: 0, top: 0, width: 40, height: 40}); input.sourcePolygon = polygon(2, 2, 10, 10);
  const result = findBalloonCandidate(input);
  expect(result.report.reason).toBe('COMPONENT_TOUCHES_PAGE_BOUNDARY');
  expect(result.report.rejectionReasons).toContain('COMPONENT_TOUCHES_WINDOW_BOUNDARY');
  expect(result.report.window.clipped).toBe(true);
});
it('holds two source centers in one blank component before choosing geometry', () => {
  reason({...image(), otherSourcePolygons: [polygon(29, 19, 2, 2)]}, 'SHARED_COMPONENT');
});
it('holds blank coverage below 0.95 without declaring bright pixels to be quality ground truth', () => {
  const input = image();
  for (let i = 0; i < 6; i++) input.rgba.set([0, 0, 0, 255], ((25 + Math.floor(i / 2)) * 80 + 35 + i % 2) * 4);
  const result = findBalloonCandidate(input);
  expect(result.report.sourceBlankCoverage).toBe(0.94);
  expect(result.report.reason).toBe('INSUFFICIENT_SOURCE_BLANK_COVERAGE');
});
it('uses exactly 0.95 as the reviewed coverage boundary', () => {
  const input = image();
  for (let i = 0; i < 5; i++) input.rgba.set([0, 0, 0, 255], ((25 + Math.floor(i / 2)) * 80 + 35 + i % 2) * 4);
  const result = findBalloonCandidate(input);
  expect(result.report.sourceBlankCoverage).toBe(0.95);
  expect(result.report.rejectionReasons).not.toContain('INSUFFICIENT_SOURCE_BLANK_COVERAGE');
});
it('preserves protected boxes and holds their anchor pixels', () => {
  const input = {...image(), protectedBoxes: [{left: 39, top: 29, width: 2, height: 2}]};
  const before = structuredClone(input);
  reason(input, 'ANCHOR_EXCLUDED_OR_PADDING_UNSAFE');
  expect(input).toEqual(before);
});
it('excludes user boxes before applying the existing 3px padding', () => {
  const input = {...image(), userTypesetBoxes: [{left: 45, top: 25, width: 5, height: 10}]};
  const before = structuredClone(input);
  const result = findBalloonCandidate(input), box = candidate(input);
  expect(box.left + box.width).toBeLessThanOrEqual(42);
  expect(box.collisionPixels).toBe(0);
  expect(result.masks?.paddingValid[(30 - result.report.window.top) * result.report.window.width
    + 42 - result.report.window.left]).toBe(0);
  expect(input).toEqual(before);
});
it('protects previously accepted automatic boxes by the same obstacle and padding rule', () => {
  const box = {left: 45, top: 25, width: 5, height: 10};
  const input = {...image(), acceptedAutomaticBoxes: [box]}, before = structuredClone(input);
  const automatic = findBalloonCandidate(input), user = findBalloonCandidate({...image(), userTypesetBoxes: [box]});
  expect(automatic.report).toEqual(user.report);
  expect(automatic.masks?.obstacles).toEqual(user.masks?.obstacles);
  expect(automatic.report.candidate?.left).toBe(user.report.candidate?.left);
  expect(input).toEqual(before);
});
it('excludes another source polygon even if its center is outside the blank component', () => {
  const result = findBalloonCandidate({...image(), otherSourcePolygons: [polygon(50, 30, 8, 14)]});
  expect(result.report.sharedSourceCenters).toHaveLength(0);
  expect(result.report.candidate?.collisionPixels).toBe(0);
  expect(result.report.excludedObstacleComponentPixels).toBeGreaterThan(0);
});
it('accepts product-scale region lists without the old sample-only 32-region exception', () => {
  const input = image(), expected = findBalloonCandidate(input).report;
  const others = Array.from({length: 199}, () => polygon(1, 1, 1, 1));
  const boxes = Array.from({length: 199}, () => ({left: 1, top: 1, width: 1, height: 1}));
  const actual = findBalloonCandidate({...input, otherSourcePolygons: others,
    userTypesetBoxes: boxes, acceptedAutomaticBoxes: boxes, protectedBoxes: boxes}).report;
  expect(actual).toEqual(expected);
});
it('keeps the reviewed ceil/floor window and anchor rules for fractional geometry', () => {
  const result = findBalloonCandidate({...image(), sourcePolygon: polygon(35.1, 25.2, 9.7, 8.5)});
  expect(result.report.anchor).toEqual({x: 39, y: 29});
  expect(result.report.window.requested).toEqual({left: 24, top: 14, width: 30, height: 30});
});
it('does not turn invalid source geometry into a held candidate', () => {
  const input = image(); input.sourcePolygon[0].x = NaN;
  expect(() => findBalloonCandidate(input)).toThrow('INVALID_POLYGON_COORDINATE');
  expect(() => findBalloonCandidate({...image(), sourcePolygon: polygon(-1, 1, 2, 2)})).toThrow('INVALID_POLYGON_COORDINATE');
  expect(() => findBalloonCandidate({...image(), sourcePolygon: []})).toThrow('INVALID_POLYGON_SIZE');
});
it('rejects invalid raw dimensions and byte length before allocating a search mask', () => {
  expect(() => findBalloonCandidate({...image(), rgba: new Uint8Array(1)})).toThrow('INVALID_RAW_RGBA');
  expect(() => findBalloonCandidate({...image(), width: 0})).toThrow('INVALID_RAW_RGBA');
  expect(() => findBalloonCandidate({...image(), height: 1.5})).toThrow('INVALID_RAW_RGBA');
  expect(() => findBalloonCandidate({...image(), width: MAX_PIXELS + 1, height: 1,
    rgba: new Uint8Array(0)})).toThrow('INVALID_RAW_RGBA');
});
it('uses the same small search on a 2-million-pixel page instead of rejecting the page', () => {
  const expected = findBalloonCandidate(image()).report;
  const large = image(2000, 1000), beforeGeometry = structuredClone(large.sourcePolygon);
  expect(large.width * large.height).toBeGreaterThan(MAX_PIXELS);
  expect(findBalloonCandidate(large).report).toEqual(expected);
  expect(large.sourcePolygon).toEqual(beforeGeometry);
  expect(large.rgba[(30 * large.width + 40) * 4]).toBe(255);
});
it('holds an oversized search window without producing fake zero measurements or masks', () => {
  const input = image(1600, 1600, null); input.sourcePolygon = polygon(550, 550, 500, 500);
  const result = findBalloonCandidate(input);
  expect(result.report).toMatchObject({status: 'HOLD', reason: 'WINDOW_PIXEL_LIMIT',
    rejectionReasons: ['WINDOW_PIXEL_LIMIT'], candidate: null, sourcePixelCount: null,
    componentPixelCount: null, sourceBlankCoverage: null});
  expect(result.masks).toBeNull();
});
it('rejects malformed obstacle boxes and settings rather than swallowing errors', () => {
  expect(() => findBalloonCandidate({...image(), userTypesetBoxes: [{left: 79, top: 0, width: 2, height: 2}]})).toThrow('BOX_OUTSIDE_PAGE');
  expect(() => findBalloonCandidate({...image(), acceptedAutomaticBoxes: [{left: 1, top: 1, width: NaN, height: 2}]})).toThrow('INVALID_BOX_COORDINATE');
  expect(() => findBalloonCandidate({...image(), settings: {...SETTINGS, thresholdPerRgb: 240}})).toThrow('SETTINGS_MISMATCH');
  expect(() => findBalloonCandidate({...image(), settings: {...SETTINGS, newOption: true}})).toThrow('SETTINGS_KEYS_MISMATCH');
});
it('symmetrically clips an asymmetric rectangle without shifting the source-box center', () => {
  const source = {left: 35, top: 25, width: 10, height: 10};
  const found = {left: 20, top: 20, width: 35, height: 30}, before = structuredClone({source, found});
  expect(centeredBalloonBox(found, source)).toEqual({left: 25, top: 20, width: 30, height: 20});
  expect({source, found}).toEqual(before);
});
it('retains a 0.5 source-center parity with integer candidate edges', () => {
  const source = {left: 35, top: 25, width: 11, height: 9};
  const result = centeredBalloonBox({left: 22, top: 20, width: 34, height: 20}, source);
  expect(result).toEqual({left: 25, top: 20, width: 31, height: 19});
  expect(result && result.left + result.width / 2).toBe(40.5);
  expect(result && result.top + result.height / 2).toBe(29.5);
});
it('preserves the renderer floor/ceil source bounding box for fractional polygons', () => {
  const source = polygonBounds(polygon(35.1, 25.2, 9.7, 8.5));
  expect(centeredBalloonBox({left: 31.1, top: 21.1, width: 17.8, height: 17.8}, source))
    .toEqual({left: 32, top: 22, width: 16, height: 15});
});
it.each([
  {left: 35, top: 20, width: 9, height: 20},
  {left: 30, top: 25, width: 20, height: 9},
  {left: 35, top: 25, width: 10, height: 10},
  {left: 60, top: 60, width: 20, height: 20},
])('rejects a centered candidate that reduces an original dimension or adds no area: %j', found => {
  expect(centeredBalloonBox(found, {left: 35, top: 25, width: 10, height: 10})).toBeNull();
});
it('allows growth in one dimension while preserving both original dimensions', () => {
  expect(centeredBalloonBox({left: 35, top: 24, width: 10, height: 12},
    {left: 35, top: 25, width: 10, height: 10})).toEqual({left: 35, top: 24, width: 10, height: 12});
});
it('never moves a centered expansion beyond the padded candidate rectangle', () => {
  const input = image(), found = candidate(input), original = polygonBounds(input.sourcePolygon);
  const centered = centeredBalloonBox(found, original);
  expect(centered).toEqual({left: 31, top: 21, width: 18, height: 18});
  if (!centered) throw new Error('Expected a centered synthetic rectangle');
  expect(centered.left).toBeGreaterThanOrEqual(found.left);
  expect(centered.top).toBeGreaterThanOrEqual(found.top);
  expect(centered.left + centered.width).toBeLessThanOrEqual(found.left + found.width);
  expect(centered.top + centered.height).toBeLessThanOrEqual(found.top + found.height);
});
it('rejects invalid centered-box coordinates instead of inventing geometry', () => {
  expect(() => centeredBalloonBox({left: 0, top: 0, width: NaN, height: 4},
    {left: 1, top: 1, width: 1, height: 1})).toThrow('INVALID_CENTERED_BOX');
});
it('matches the original histogram result against an independent exhaustive small-mask oracle', () => {
  let seed = 101389;
  const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;};
  const width = 5, height = 4, anchor = {x: 2, y: 2}, center = {x: 2.2, y: 2.4};
  type Ranked = Omit<AnchoredRectangle, 'rectangleChecks'>;
  const rank = (item: Ranked) => [-item.area, item.centerShiftSquared, item.top, item.left, item.width];
  for (let sample = 0; sample < 160; sample++) {
    const valid = Uint8Array.from({length: width * height}, () => random() > 0.25 ? 1 : 0);
    const sourceMask = Uint8Array.from({length: width * height}, () => random() > 0.6 ? 1 : 0);
    sourceMask[anchor.y * width + anchor.x] = 1;
    const sourceCount = sourceMask.reduce((sum, pixel) => sum + pixel, 0);
    let best: Ranked | null = null;
    for (let top = 0; top <= anchor.y; top++) for (let left = 0; left <= anchor.x; left++)
      for (let bottom = anchor.y + 1; bottom <= height; bottom++) for (let right = anchor.x + 1; right <= width; right++) {
        let pixels = 0, allValid = true;
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
          allValid &&= Boolean(valid[y * width + x]); pixels += sourceMask[y * width + x];
        }
        if (!allValid || pixels / sourceCount < 0.5) continue;
        const checked: Ranked = {left, top, width: right - left, height: bottom - top,
          area: (right - left) * (bottom - top), sourceIntersectionPixels: pixels,
          centerShiftSquared: ((left + right) / 2 - center.x) ** 2 + ((top + bottom) / 2 - center.y) ** 2};
        const a = rank(checked), b = best && rank(best);
        let better = !best;
        if (b) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {better = a[i] < b[i]; break;}
        if (better) best = checked;
      }
    const actual = largestAnchoredRectangle(valid, sourceMask, width, height, anchor, center);
    if (!best) expect(actual, `sample ${sample}`).toBeNull();
    else {
      if (!actual) throw new Error(`Expected oracle rectangle in sample ${sample}`);
      const {rectangleChecks, ...geometry} = actual;
      expect(geometry, `sample ${sample}`).toEqual(best);
      expect(rectangleChecks).toBeLessThanOrEqual(width * height);
    }
  }
});
it('keeps histogram checks linear for a large synthetic window', () => {
  const width = 800, height = 600, valid = new Uint8Array(width * height).fill(1), sourceMask = new Uint8Array(valid.length);
  sourceMask[(height / 2) * width + width / 2] = 1;
  const result = largestAnchoredRectangle(valid, sourceMask, width, height,
    {x: width / 2, y: height / 2}, {x: width / 2, y: height / 2});
  expect(result?.area).toBe(width * height);
  expect(result?.rectangleChecks).toBeLessThanOrEqual(width * height);
});


it('holds an unsampled tiny positive polygon without treating it as an invalid page',()=>{
  const input=image(),result=findBalloonCandidate({...input,sourcePolygon:polygon(10.1,10.1,.1,.1)});
  expect(result.report).toMatchObject({status:'HOLD',reason:'NO_SOURCE_PIXEL_CENTERS',sourcePixelCount:0,componentPixelCount:null,sourceBlankCoverage:null,candidate:null});expect(result.masks).toBeNull();
});
it('distinguishes a tiny polygon that contains an actual pixel center',()=>{
  const input=image();input.rgba.fill(255);const result=findBalloonCandidate({...input,sourcePolygon:polygon(10.45,10.45,.1,.1)});
  expect(result.report.sourcePixelCount).toBe(1);expect(result.report.reason).not.toBe('NO_SOURCE_PIXEL_CENTERS');expect(result.report.candidate).toBeNull();
});

// A transparent synthetic report: sourceMask contains the actual source pixels,
// and the given rectangle alone is declared padding-safe. No image engine runs.
function typesetResult(found: BalloonBox, sourceBounds: BalloonBox): BalloonCandidateResult {
  const width = 100, height = 100, sourceMask = new Uint8Array(width * height);
  const paddingValid = new Uint8Array(sourceMask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    sourceMask[y * width + x] = Number(x + .5 >= sourceBounds.left && x + .5 < sourceBounds.left + sourceBounds.width
      && y + .5 >= sourceBounds.top && y + .5 < sourceBounds.top + sourceBounds.height);
    paddingValid[y * width + x] = Number(x >= Math.ceil(found.left) && x < Math.floor(found.left + found.width)
      && y >= Math.ceil(found.top) && y < Math.floor(found.top + found.height));
  }
  const sourcePixelCount = sourceMask.reduce((sum, pixel) => sum + pixel, 0);
  const sourceIntersectionPixels = sourceMask.reduce((sum, pixel, at) => sum + pixel * paddingValid[at], 0);
  const sourceCenter = {x: sourceBounds.left + sourceBounds.width / 2, y: sourceBounds.top + sourceBounds.height / 2};
  const window = {left: 0, top: 0, width, height};
  return {report: {sourceBounds, sourcePixelCount, sourceCenter,
    anchor: {x: Math.floor(sourceCenter.x), y: Math.floor(sourceCenter.y)}, window: {...window, requested: {...window}, clipped: false},
    inputBasis: 'EXISTING_CLEANUP_RGBA', status: 'CANDIDATE_REQUIRES_REVIEW', reason: null, rejectionReasons: [],
    componentPixelCount: paddingValid.reduce((sum, pixel) => sum + pixel, 0), sourceBlankCoverage: 1,
    candidate: {...found, area: found.width * found.height, sourceIntersectionPixels,
      sourceIntersectionRatio: sourceIntersectionPixels / sourcePixelCount, sourceBoundsIntersectionArea: sourceIntersectionPixels,
      sourceBoundsIntersectionRatio: sourceIntersectionPixels / sourcePixelCount,
      areaToSourceBoundsRatio: found.width * found.height / (sourceBounds.width * sourceBounds.height),
      centerShiftPx: Math.hypot(found.left + found.width / 2 - sourceCenter.x, found.top + found.height / 2 - sourceCenter.y),
      collisionPixels: 0, rectangleChecks: 1, maximumHistogramChecks: width * height}},
    masks: {sourceMask, paddingValid, rawBlank: paddingValid.slice(), component: paddingValid.slice(),
      obstacles: new Uint8Array(sourceMask.length), userMask: new Uint8Array(sourceMask.length),
      automaticMask: new Uint8Array(sourceMask.length), protectedMask: new Uint8Array(sourceMask.length)}};
}
it.each([
  {source: {left: 35, top: 25, width: 10, height: 10}, found: {left: 20, top: 20, width: 35, height: 30}},
  {source: {left: 35, top: 25, width: 11, height: 9}, found: {left: 22, top: 20, width: 34, height: 20}},
  {source: {left: 35.1, top: 25.2, width: 9.7, height: 8.5}, found: {left: 31.1, top: 21.1, width: 17.8, height: 17.8}},
])('keeps the existing centered result and all source/report/mask inputs: %j', ({source, found}) => {
  const result = typesetResult(found, source), before = structuredClone(result);
  expect(balloonTypesetBox(result)).toEqual(centeredBalloonBox(found, source));
  expect(result).toEqual(before);
});
it.each([
  {source: {left: 35, top: 25, width: 10, height: 10}, found: {left: 37, top: 20, width: 18, height: 20}, expected: {left: 37, top: 20, width: 18, height: 20}},
  {source: {left: 35, top: 25, width: 10, height: 10}, found: {left: 25, top: 20, width: 18, height: 20}, expected: {left: 25, top: 20, width: 18, height: 20}},
  {source: {left: 35, top: 25, width: 10, height: 10}, found: {left: 30, top: 27, width: 20, height: 18}, expected: {left: 30, top: 27, width: 20, height: 18}},
  {source: {left: 35, top: 25, width: 10, height: 10}, found: {left: 37, top: 27, width: 18, height: 18}, expected: {left: 37, top: 27, width: 18, height: 18}},
  {source: {left: 35, top: 25, width: 11, height: 9}, found: {left: 38, top: 20, width: 20, height: 20}, expected: {left: 38, top: 20, width: 19, height: 19}},
  {source: {left: 35.1, top: 25.2, width: 9.7, height: 8.5}, found: {left: 38.2, top: 20.2, width: 20.6, height: 20.6}, expected: {left: 39, top: 21, width: 18, height: 19}},
])('uses the maximum inward safe dimensions and the minimum center shift while preserving source parity: %j', ({source, found, expected}) => {
  const result = typesetResult(found, source), before = structuredClone(result);
  expect(centeredBalloonBox(found, source)).toBeNull();
  const box = balloonTypesetBox(result);
  expect(box).toEqual(expected);
  if (!box) throw new Error('Expected a shifted synthetic typeset box');
  const sourceWidth = Math.ceil(source.left + source.width) - Math.floor(source.left);
  const sourceHeight = Math.ceil(source.top + source.height) - Math.floor(source.top);
  const centerX = (Math.floor(source.left) + Math.ceil(source.left + source.width)) / 2;
  const centerY = (Math.floor(source.top) + Math.ceil(source.top + source.height)) / 2;
  expect(box.width).toBeGreaterThanOrEqual(sourceWidth); expect(box.height).toBeGreaterThanOrEqual(sourceHeight);
  expect(box.width * box.height).toBeGreaterThan(sourceWidth * sourceHeight);
  expect(box.width % 2).toBe(sourceWidth % 2); expect(box.height % 2).toBe(sourceHeight % 2);
  expect(box.left + box.width / 2).toBe(Math.max(Math.ceil(found.left) + box.width / 2,
    Math.min(Math.floor(found.left + found.width) - box.width / 2, centerX)));
  expect(box.top + box.height / 2).toBe(Math.max(Math.ceil(found.top) + box.height / 2,
    Math.min(Math.floor(found.top + found.height) - box.height / 2, centerY)));
  for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) {
    expect(result.masks!.paddingValid[y * result.report.window.width + x]).toBe(1);
  }
  expect(result).toEqual(before);
});
it.each([
  {left: 35, top: 20, width: 9, height: 20},
  {left: 30, top: 25, width: 12, height: 8},
  {left: 35, top: 25, width: 10, height: 10},
  {left: 35.2, top: 20, width: 10.5, height: 20},
])('does not shrink the original width or accept an inward box without added area: %j', found => {
  const result = typesetResult(found, {left: 35, top: 25, width: 10, height: 10}), before = structuredClone(result);
  expect(balloonTypesetBox(result)).toBeNull(); expect(result).toEqual(before);
});
it.each([
  {source: {left: 35, top: 25, width: 10, height: 10}, found: {left: 30, top: 25, width: 20, height: 9}, expected: {left: 30, top: 26, width: 20, height: 8}},
  {source: {left: 35, top: 25, width: 10, height: 20}, found: {left: 20, top: 30, width: 40, height: 14}, expected: {left: 20, top: 30, width: 40, height: 14}},
  {source: {left: 35.1, top: 25.2, width: 9.7, height: 18.5}, found: {left: 20.2, top: 29.2, width: 41.6, height: 15.6}, expected: {left: 21, top: 30, width: 40, height: 13}},
])('keeps a wider shorter fallback inside safe pixels with source parity and minimum center shift: %j', ({source, found, expected}) => {
  const result = typesetResult(found, source), before = structuredClone(result);
  expect(centeredBalloonBox(found, source)).toBeNull();
  const box = balloonTypesetBox(result);
  expect(box).toEqual(expected);
  if (!box) throw new Error('Expected a wider shorter synthetic fallback');
  const sourceWidth = Math.ceil(source.left + source.width) - Math.floor(source.left);
  const sourceHeight = Math.ceil(source.top + source.height) - Math.floor(source.top);
  expect(box.width).toBeGreaterThanOrEqual(sourceWidth); expect(box.height).toBeGreaterThan(0);
  expect(box.height).toBeLessThan(sourceHeight); expect(box.width * box.height).toBeGreaterThan(sourceWidth * sourceHeight);
  expect(box.width % 2).toBe(sourceWidth % 2); expect(box.height % 2).toBe(sourceHeight % 2);
  const centerX = (Math.floor(source.left) + Math.ceil(source.left + source.width)) / 2;
  const centerY = (Math.floor(source.top) + Math.ceil(source.top + source.height)) / 2;
  expect(box.left + box.width / 2).toBe(Math.max(Math.ceil(found.left) + box.width / 2,
    Math.min(Math.floor(found.left + found.width) - box.width / 2, centerX)));
  expect(box.top + box.height / 2).toBe(Math.max(Math.ceil(found.top) + box.height / 2,
    Math.min(Math.floor(found.top + found.height) - box.height / 2, centerY)));
  let intersection = 0;
  for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) {
    const at = y * result.report.window.width + x;
    expect(result.masks!.paddingValid[at]).toBe(1); intersection += result.masks!.sourceMask[at];
  }
  expect(intersection / result.report.sourcePixelCount!).toBeGreaterThanOrEqual(.5);
  expect(result).toEqual(before);
});
it('keeps the actual one-half source-pixel boundary for a wider shorter fallback', () => {
  const source = {left: 35, top: 25, width: 10, height: 20};
  const result = typesetResult({left: 20, top: 30, width: 40, height: 10}, source), before = structuredClone(result);
  expect(balloonTypesetBox(result)).toEqual({left: 20, top: 30, width: 40, height: 10});
  expect(result.report.candidate!.sourceIntersectionRatio).toBe(.5); expect(result).toEqual(before);
});
it.each([
  {found: {left: 35, top: 25, width: 9, height: 30}, reason: 'narrower width'},
  {found: {left: 20, top: 30, width: 20, height: 10}, reason: 'no area increase'},
  {found: {left: 20, top: 30, width: 40, height: 1}, reason: 'zero inward height after parity'},
  {found: {left: 20, top: 37, width: 40, height: 14}, reason: 'less than half the actual source pixels'},
])('rejects a shorter fallback with $reason without changing source evidence', ({found}) => {
  const result = typesetResult(found, {left: 35, top: 25, width: 10, height: 20}), before = structuredClone(result);
  expect(balloonTypesetBox(result)).toBeNull(); expect(result).toEqual(before);
});
it('checks actual source pixels rather than accepting a bounding-box intersection of one half', () => {
  const result = typesetResult({left: 20, top: 20, width: 20, height: 20}, {left: 35, top: 25, width: 10, height: 10});
  const sourceMask = result.masks!.sourceMask;
  // A triangular source leans right inside the same bounds. The raw rectangle
  // overlaps half of those bounds, but fewer than half of the actual pixels.
  for (let y = 25; y < 35; y++) for (let x = 35; x < 45; x++) {
    sourceMask[y * 100 + x] = Number(x + .5 >= 35 + Math.abs(y + .5 - 30) * 2);
  }
  result.report.sourcePixelCount = sourceMask.reduce((sum, pixel) => sum + pixel, 0);
  result.report.candidate!.sourceBoundsIntersectionRatio = .5;
  const actualIntersection = sourceMask.reduce((sum, pixel, at) => sum + pixel * result.masks!.paddingValid[at], 0);
  result.report.candidate!.sourceIntersectionPixels = actualIntersection;
  result.report.candidate!.sourceIntersectionRatio = actualIntersection / result.report.sourcePixelCount;
  expect(actualIntersection / result.report.sourcePixelCount).toBeLessThan(.5);
  const before = structuredClone(result);
  expect(balloonTypesetBox(result)).toBeNull(); expect(result).toEqual(before);
});
it.each(['candidate', 'masks', 'source-pixels'] as const)('keeps missing %s evidence as a null typeset candidate without filling unknown measurements', missing => {
  const result = typesetResult({left: 20, top: 20, width: 35, height: 30}, {left: 35, top: 25, width: 10, height: 10});
  if (missing === 'candidate') result.report.candidate = null;
  if (missing === 'masks') result.masks = null;
  if (missing === 'source-pixels') result.report.sourcePixelCount = null;
  const before = structuredClone(result);
  expect(balloonTypesetBox(result)).toBeNull(); expect(result).toEqual(before);
});

function addPaddingBoxes(result: BalloonCandidateResult, boxes: BalloonBox[]) {
  for (const box of boxes) for (let y = box.top; y < box.top + box.height; y++)
    for (let x = box.left; x < box.left + box.width; x++) result.masks!.paddingValid[y * 100 + x] = 1;
}
it('retains a taller safe rectangle when the maximum-area primary is too short', () => {
  const result = typesetResult({left: 20, top: 28, width: 45, height: 10}, {left: 35, top: 25, width: 10, height: 12});
  addPaddingBoxes(result, [{left: 35, top: 21, width: 10, height: 26}]);
  const before = structuredClone(result), primary = balloonTypesetBox(result);
  expect(primary).toEqual({left: 20, top: 28, width: 44, height: 10});
  expect(tallerBalloonTypesetBox(result, primary!)).toEqual({left: 35, top: 21, width: 10, height: 26});
  expect(balloonTypesetBox(result)).toEqual(primary);
  expect(result).toEqual(before);
});
it.each([
  {source: {left: 55, top: 45, width: 11, height: 13}, wide: {left: 40, top: 49, width: 44, height: 10},
    tall: {left: 55, top: 37, width: 11, height: 30}, primary: {left: 40, top: 49, width: 43, height: 9},
    expected: {left: 55, top: 37, width: 11, height: 29}},
  {source: {left: 35.1, top: 25.2, width: 9.7, height: 8.5}, wide: {left: 20, top: 27, width: 42, height: 6},
    tall: {left: 35, top: 17, width: 11, height: 24}, primary: {left: 20, top: 27, width: 42, height: 5},
    expected: {left: 35, top: 18, width: 10, height: 23}},
])('keeps inward source parity and the actual taller box after translation or fractional bounds: %j', ({source, wide, tall, primary, expected}) => {
  const result = typesetResult(wide, source); addPaddingBoxes(result, [tall]);
  const before = structuredClone(result);
  expect(balloonTypesetBox(result)).toEqual(primary);
  expect(tallerBalloonTypesetBox(result, primary)).toEqual(expected);
  expect(result).toEqual(before);
});
it.each([
  {source: {left: 35, top: 25, width: 10, height: 12}, wide: {left: 20, top: 28, width: 45, height: 10},
    tall: {left: 36, top: 15, width: 8, height: 50}, primary: {left: 20, top: 28, width: 44, height: 10}, reason: 'narrower than the original width'},
  {source: {left: 35, top: 25, width: 10, height: 20}, wide: {left: 20, top: 30, width: 40, height: 10},
    tall: {left: 35, top: 25, width: 10, height: 20}, primary: {left: 20, top: 30, width: 40, height: 10}, reason: 'no source-area gain'},
  {source: {left: 35, top: 25, width: 10, height: 10}, wide: {left: 20, top: 24, width: 40, height: 12},
    tall: {left: 35, top: 24, width: 10, height: 13}, primary: {left: 20, top: 24, width: 40, height: 12}, reason: 'no actual height gain after inward parity'},
])('does not offer a taller alternative with $reason', ({source, wide, tall, primary}) => {
  const result = typesetResult(wide, source); addPaddingBoxes(result, [tall]);
  const before = structuredClone(result);
  expect(balloonTypesetBox(result)).toEqual(primary);
  expect(tallerBalloonTypesetBox(result, primary)).toBeNull();
  expect(result).toEqual(before);
});
it('accepts exactly half the actual source pixels in a taller box', () => {
  const result = typesetResult({left: 20, top: 30, width: 40, height: 6}, {left: 35, top: 25, width: 10, height: 10});
  addPaddingBoxes(result, [{left: 35, top: 30, width: 10, height: 20}]);
  const primary = {left: 20, top: 30, width: 40, height: 6}, before = structuredClone(result);
  expect(balloonTypesetBox(result)).toEqual(primary);
  expect(tallerBalloonTypesetBox(result, primary)).toEqual({left: 35, top: 30, width: 10, height: 20});
  expect(result).toEqual(before);
});
it('rejects a tall box covering half the source bounds but less than half of its actual pixels', () => {
  const result = typesetResult({left: 20, top: 30, width: 40, height: 6}, {left: 35, top: 25, width: 10, height: 10});
  addPaddingBoxes(result, [{left: 40, top: 20, width: 10, height: 30}]);
  const mask = result.masks!.sourceMask;
  for (let y = 25; y < 35; y++) for (let x = 35; x < 45; x++) mask[y * 100 + x] = Number(x < 40 || y === 34);
  result.report.sourcePixelCount = 55;
  const primary = {left: 20, top: 30, width: 40, height: 6}, before = structuredClone(result);
  expect(balloonTypesetBox(result)).toEqual(primary);
  expect(tallerBalloonTypesetBox(result, primary)).toBeNull();
  expect(result).toEqual(before);
});
it('does not cross a hole in padding-valid pixels to obtain extra height', () => {
  const result = typesetResult({left: 20, top: 28, width: 45, height: 10}, {left: 35, top: 25, width: 10, height: 12});
  addPaddingBoxes(result, [{left: 35, top: 21, width: 10, height: 26}]);
  result.masks!.paddingValid[23 * 100 + 40] = 0;
  const before = structuredClone(result);
  expect(tallerBalloonTypesetBox(result, {left: 20, top: 28, width: 44, height: 10}))
    .toEqual({left: 35, top: 24, width: 10, height: 22});
  expect(result).toEqual(before);
});
it('checks actual collision pixels even when an inconsistent padding mask marks them safe', () => {
  const result = typesetResult({left: 20, top: 28, width: 45, height: 10}, {left: 35, top: 25, width: 10, height: 12});
  addPaddingBoxes(result, [{left: 35, top: 21, width: 10, height: 26}]);
  result.masks!.obstacles[23 * 100 + 40] = 1;
  const before = structuredClone(result);
  expect(tallerBalloonTypesetBox(result, {left: 20, top: 28, width: 44, height: 10})).toBeNull();
  expect(result).toEqual(before);
});
it.each([
  {a: {left: 24, top: 10, width: 12, height: 32}, b: {left: 34, top: 20, width: 16, height: 30},
    expected: {left: 24, top: 10, width: 12, height: 32}, reason: 'height before area'},
  {a: {left: 24, top: 10, width: 12, height: 30}, b: {left: 34, top: 20, width: 14, height: 30},
    expected: {left: 34, top: 20, width: 14, height: 30}, reason: 'area before center movement'},
  {a: {left: 23, top: 10, width: 12, height: 30}, b: {left: 34, top: 20, width: 12, height: 30},
    expected: {left: 34, top: 20, width: 12, height: 30}, reason: 'center movement before top'},
  {a: {left: 24, top: 10, width: 12, height: 30}, b: {left: 34, top: 20, width: 12, height: 30},
    expected: {left: 24, top: 10, width: 12, height: 30}, reason: 'top after equal height, area and center movement'},
])('chooses the actual taller box deterministically using $reason', ({a, b, expected}) => {
  const result = typesetResult({left: 10, top: 26, width: 60, height: 8}, {left: 30, top: 25, width: 10, height: 10});
  addPaddingBoxes(result, [a, b]);
  const primary = {left: 10, top: 26, width: 60, height: 8}, before = structuredClone(result);
  expect(balloonTypesetBox(result)).toEqual(primary);
  expect(tallerBalloonTypesetBox(result, primary)).toEqual(expected);
  expect(tallerBalloonTypesetBox(result, primary)).toEqual(expected);
  expect(result).toEqual(before);
});
it('uses the existing cleanup component, source anchor and padding for an actual candidate result', () => {
  const input = image(90, 80, {left: 18, top: 29, width: 50, height: 18});
  input.sourcePolygon = polygon(35, 25, 14, 20);
  for (let y = 15; y < 57; y++) for (let x = 32; x < 52; x++) input.rgba.set([255, 255, 255, 255], (y * 90 + x) * 4);
  const result = findBalloonCandidate(input), before = structuredClone(result), beforeInput = structuredClone(input);
  const primary = balloonTypesetBox(result);
  expect(primary).toEqual({left: 21, top: 32, width: 44, height: 12});
  expect(tallerBalloonTypesetBox(result, primary!)).toEqual({left: 35, top: 18, width: 14, height: 36});
  expect(result).toEqual(before); expect(input).toEqual(beforeInput);
});
it.each(['userTypesetBoxes', 'acceptedAutomaticBoxes', 'protectedBoxes'] as const)
('keeps existing %s exclusions and padding when considering extra height', key => {
  const input = image(90, 80, {left: 18, top: 29, width: 50, height: 18});
  input.sourcePolygon = polygon(35, 25, 14, 20);
  for (let y = 15; y < 57; y++) for (let x = 32; x < 52; x++) input.rgba.set([255, 255, 255, 255], (y * 90 + x) * 4);
  const obstacle = {left: 36, top: 48, width: 12, height: 8};
  const result = findBalloonCandidate({...input, [key]: [obstacle]}), before = structuredClone(result);
  const primary = balloonTypesetBox(result);
  expect(primary).toEqual({left: 21, top: 32, width: 44, height: 12});
  const box = tallerBalloonTypesetBox(result, primary!);
  expect(box).toEqual({left: 35, top: 19, width: 14, height: 26});
  for (let y = box!.top; y < box!.top + box!.height; y++) for (let x = box!.left; x < box!.left + box!.width; x++) {
    const at = (y - result.report.window.top) * result.report.window.width + x - result.report.window.left;
    expect(result.masks!.paddingValid[at]).toBe(1); expect(result.masks!.obstacles[at]).toBe(0);
  }
  expect(result).toEqual(before);
});
it.each(['candidate', 'masks', 'source-pixels'] as const)('does not invent a taller alternative without %s evidence', missing => {
  const result = typesetResult({left: 20, top: 20, width: 35, height: 30}, {left: 35, top: 25, width: 10, height: 10});
  if (missing === 'candidate') result.report.candidate = null;
  if (missing === 'masks') result.masks = null;
  if (missing === 'source-pixels') result.report.sourcePixelCount = null;
  const before = structuredClone(result);
  expect(tallerBalloonTypesetBox(result, {left: 25, top: 20, width: 30, height: 20})).toBeNull();
  expect(result).toEqual(before);
});
it('returns no taller alternative when the unchanged primary already uses the full safe height', () => {
  const result = findBalloonCandidate(image()), before = structuredClone(result);
  expect(tallerBalloonTypesetBox(result, {left: 31, top: 21, width: 18, height: 18})).toBeNull();
  expect(result).toEqual(before);
});
it('rejects malformed or oversized height-search masks before allocating prefix sums', () => {
  const result = typesetResult({left: 20, top: 20, width: 35, height: 30}, {left: 35, top: 25, width: 10, height: 10});
  const primary = {left: 25, top: 20, width: 30, height: 20};
  result.masks!.paddingValid = new Uint8Array(1);
  expect(() => tallerBalloonTypesetBox(result, primary)).toThrow('INVALID_RECTANGLE_MASK');
  result.report.window.width = MAX_PIXELS + 1; result.report.window.height = 1;
  expect(() => tallerBalloonTypesetBox(result, primary)).toThrow('INVALID_RECTANGLE_MASK');
});
it('matches the height-first result against an independent exhaustive small-mask oracle', () => {
  let seed = 209813;
  const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;};
  const width = 5, height = 4, source = {left: 2, top: 2, width: 1, height: 1};
  for (let sample = 0; sample < 120; sample++) {
    const result = typesetResult({left: 0, top: 0, width, height}, source);
    result.report.window = {left: 0, top: 0, width, height, requested: {left: 0, top: 0, width, height}, clipped: false};
    for (const key of Object.keys(result.masks!) as (keyof NonNullable<BalloonCandidateResult['masks']>)[]) {
      result.masks![key] = new Uint8Array(width * height);
    }
    result.masks!.sourceMask[2 * width + 2] = 1;
    result.masks!.paddingValid = Uint8Array.from({length: width * height}, () => Number(random() > .25));
    let expected: BalloonBox | null = null, expectedRank: number[] | null = null;
    for (let top = 0; top <= 2; top++) for (let left = 0; left <= 2; left++)
      for (let bottom = 3; bottom <= height; bottom++) for (let right = 3; right <= width; right++) {
        const w = right - left, h = bottom - top;
        if (w % 2 !== 1 || h % 2 !== 1 || h <= source.height) continue;
        let valid = true;
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) valid &&= result.masks!.paddingValid[y * width + x] === 1;
        if (!valid) continue;
        const rank = [-h, -w * h, ((left + right) / 2 - 2.5) ** 2 + ((top + bottom) / 2 - 2.5) ** 2, top, left, w];
        let better = !expectedRank;
        if (expectedRank) for (let i = 0; i < rank.length; i++) if (rank[i] !== expectedRank[i]) {better = rank[i] < expectedRank[i]; break;}
        if (better) {expected = {left, top, width: w, height: h}; expectedRank = rank;}
      }
    const before = structuredClone(result);
    expect(tallerBalloonTypesetBox(result, source), `sample ${sample}`).toEqual(expected);
    expect(result).toEqual(before);
  }
});
