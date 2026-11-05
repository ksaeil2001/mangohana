import type { DialogueLine, DialogueTypesetting } from "../../src/shared/projectTypes.js";
import type { ExtractedSpeechBubble, NormalizedBbox, PolygonPoint, SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction.js";
import type { TranslationQaReport } from "../../src/shared/translation/translationQa.js";
import type {} from "../../src/renderer/electronApi.js";
import { buildTranslationContextPayload, computeTranslationPayloadFingerprint } from "../../src/shared/translation/translationPayload.js";
import { calculateAdaptiveDilationRadius } from "../../src/shared/maskMorphology.js";
import { PRODUCTION_TYPESET_FONT_CSS_FAMILY } from "../../src/shared/productionTypesetFontResource.js";
import { autoFitFontSizeForBubbleShape, getRecommendedFontFallbackChain, layoutTextForBubbleShape } from "../../src/shared/typesettingGeometry.js";
import { burnTypesettingFromUrl } from "../../src/renderer/imageBurnInRenderer.js";
import { ensureProductionTypesetFontLoaded } from "../../src/renderer/productionTypesetFont.js";

export type PreviewTranslationRecord = {
  id: string;
  requestId: string;
  engine: "local_ai";
  usedExactTm: false;
  requestedContextFingerprint: string;
  returnedContextFingerprint: string;
  qaReport: TranslationQaReport | null;
  durationMs: number;
};

export type PreviewMaskRegion = {
  id: string;
  radius: number;
  geometrySource: "sourceQuadsPx" | "polygon";
  polygonsPx: PolygonPoint[][];
  bboxPx: NormalizedBbox;
};

export type PreviewLayoutReport = {
  id: string;
  sourceBbox: NormalizedBbox;
  bbox: NormalizedBbox;
  bboxInferred: boolean;
  fontFamily: string;
  fontSizeRatio: number;
  fontSizePx: number;
  productionFontLoaded: boolean;
  glyphFontLoaded: boolean;
  qaStatus: "pending";
  reviewReasons: string[];
};

/** OCR 확인·번역 채택·프로젝트 저장을 수행하지 않는 메모리 전용 후보다. */
export function draftLines(ocr: SpeechBubbleExtractionResult, pageNumber = 1): DialogueLine[] {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("페이지 번호가 올바르지 않습니다.");
  return orderedCandidates(ocr).map((candidate) => ({
    id: candidate.id,
    order: candidate.readingOrder,
    pageNumber,
    sourceText: candidate.text,
    sourceLanguage: candidate.language === "ja" || candidate.language === "en" ? candidate.language : "unknown",
    dialogueType: candidate.type === "thought_bubble" ? "thought" : "speech",
    parseConfidence: candidate.confidence,
    parseWarnings: [...ocr.warnings],
    notes: candidate.notes,
    ocrEditStatus: "ai_proposed",
    ocrGroupId: candidate.productionOcrProvenance?.groupId,
    polygon: candidate.polygon ? structuredClone(candidate.polygon) : undefined,
    ocrSourceInfo: {
      rawMangaOcrText: candidate.rawMangaOcrText,
      rawPaddleOcrText: candidate.rawPaddleOcrText,
      isCrossValidated: candidate.isCrossValidated,
      confidence: candidate.confidence,
      orientation: candidate.orientation,
      productionOcrProvenance: candidate.productionOcrProvenance ? structuredClone(candidate.productionOcrProvenance) : undefined
    },
    typesetting: { bbox: { ...candidate.bbox }, writingMode: "horizontal-tb" }
  }));
}

export async function translateDrafts(
  lines: readonly DialogueLine[],
  options: { endpoint: string; model: string }
): Promise<{ lines: DialogueLine[]; records: PreviewTranslationRecord[] }> {
  validateLineIds(lines);
  if (!options.endpoint?.trim() || !options.model?.trim()) throw new Error("로컬 번역 endpoint와 model이 필요합니다.");
  const execute = window.projectApi?.executeTranslation;
  if (!execute) throw new Error("기존 번역 IPC를 사용할 수 없습니다.");
  const drafts = structuredClone([...lines]);
  const records: PreviewTranslationRecord[] = [];
  const completed = new Set<string>();
  const requestIds = new Set<string>();

  for (const line of drafts) {
    const payload = buildTranslationContextPayload({ dialogueLines: drafts, targetLineId: line.id });
    const fingerprint = computeTranslationPayloadFingerprint(payload);
    const requestId = crypto.randomUUID();
    if (requestIds.has(requestId)) throw new Error("번역 요청 ID가 중복되었습니다.");
    requestIds.add(requestId);
    const started = performance.now();
    const result = await execute({
      payload,
      targetLineId: line.id,
      requestId,
      options: {
        engineType: "local_ai",
        localAiRuntime: "custom",
        localAiEndpoint: options.endpoint,
        localAiModel: options.model
      }
    });
    if (!result || result.engine !== "local_ai" || result.usedExactTm ||
        typeof result.translatedText !== "string" || !result.translatedText.trim()) {
      throw new Error(`영역 ${line.id}: 비어 있거나 로컬 AI가 아닌 번역 응답입니다.`);
    }
    if (result.contextFingerprint !== fingerprint) throw new Error(`영역 ${line.id}: 반환 문맥 지문이 요청과 다릅니다.`);
    // IPC 응답에는 ID가 없다. 요청의 ID·지문을 검사한 직후 해당 사본에 결합한다.
    if (payload.source.id !== line.id || completed.has(line.id)) throw new Error("번역 영역 ID 대응이 올바르지 않습니다.");
    line.aiTranslation = result.translatedText.trim();
    completed.add(line.id);
    records.push({
      id: line.id,
      requestId,
      engine: "local_ai",
      usedExactTm: false,
      requestedContextFingerprint: fingerprint,
      returnedContextFingerprint: result.contextFingerprint,
      qaReport: result.qaReport ? structuredClone(result.qaReport) : null,
      durationMs: performance.now() - started
    });
  }
  if (completed.size !== drafts.length || lines.some((line) => !completed.has(line.id))) {
    throw new Error("일부 영역의 번역 응답이 누락되었습니다.");
  }
  return { lines: drafts, records };
}

/** 모든 번역 요청이 성공한 뒤 호출하는 순서는 상위 실행기가 소유한다. */
export function createRemovalMask(
  ocr: SpeechBubbleExtractionResult, width: number, height: number
): { maskPngBase64: string; maskedPixels: number; regions: PreviewMaskRegion[] } {
  validateDimensions(width, height);
  const candidates = orderedCandidates(ocr);
  if (!candidates.length) throw new Error("제거 마스크를 만들 OCR 후보가 없습니다.");
  const { canvas, context } = createCanvas(width, height);
  const regions = candidates.map((candidate): PreviewMaskRegion => {
    const provenance = candidate.productionOcrProvenance;
    let polygonsPx: PolygonPoint[][];
    let geometrySource: PreviewMaskRegion["geometrySource"];
    if (provenance?.sourceQuadsPx.length) {
      const { imageWidth, imageHeight } = provenance.cropTransform;
      validateDimensions(imageWidth, imageHeight);
      geometrySource = "sourceQuadsPx";
      polygonsPx = provenance.sourceQuadsPx.map((quad) => quad.map((point) => ({
        x: point.x * width / imageWidth, y: point.y * height / imageHeight
      })));
    } else {
      geometrySource = "polygon";
      if (!candidate.polygon?.length) throw new Error(`영역 ${candidate.id}: 실제 제거 polygon이 없습니다.`);
      polygonsPx = [candidate.polygon.map((point) => ({ x: point.x * width, y: point.y * height }))];
    }
    const radii = polygonsPx.map((polygon) => {
      const bounds = polygonBounds(polygon);
      if (bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0 || bounds.x >= width || bounds.y >= height) {
        throw new Error(`영역 ${candidate.id}: 제거 좌표가 이미지 밖에 있습니다.`);
      }
      return calculateAdaptiveDilationRadius({
        bboxWidth: bounds.width / width, bboxHeight: bounds.height / height, canvasWidth: width, canvasHeight: height
      });
    });
    const radius = Math.min(...radii);
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#ffffff";
    context.lineJoin = "round";
    context.lineCap = "round";
    context.lineWidth = radius * 2;
    for (const polygon of polygonsPx) {
      context.beginPath();
      context.moveTo(polygon[0]!.x, polygon[0]!.y);
      for (const point of polygon.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      // Canvas 자체의 이미지 경계 clip을 사용해 경계 밖 polygon과 stroke를 자른다.
      context.fill();
      context.stroke();
    }
    const bounds = polygonBounds(polygonsPx.flat());
    const left = Math.max(0, bounds.x - radius), top = Math.max(0, bounds.y - radius);
    return {
      id: candidate.id, radius, geometrySource, polygonsPx,
      bboxPx: { x: left, y: top, width: Math.min(width, bounds.x + bounds.width + radius) - left, height: Math.min(height, bounds.y + bounds.height + radius) - top }
    };
  });
  const pixels = context.getImageData(0, 0, width, height);
  let maskedPixels = 0;
  for (let index = 0; index < pixels.data.length; index += 4) {
    const remove = pixels.data[index + 3]! >= 128;
    if (remove) maskedPixels++;
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = 255;
    pixels.data[index + 3] = remove ? 0 : 255;
  }
  if (!maskedPixels) throw new Error("제거 마스크에 실제 픽셀이 없습니다.");
  context.putImageData(pixels, 0, 0);
  return { maskPngBase64: canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""), maskedPixels, regions };
}

export async function renderCandidate(
  cleanedUrl: string, lines: readonly DialogueLine[]
): Promise<{ pngBase64: string; width: number; height: number; layoutReport: PreviewLayoutReport[] }> {
  validateLineIds(lines);
  if (new Set(lines.map((line) => line.pageNumber)).size > 1) throw new Error("한 이미지에는 같은 페이지의 대사만 식자할 수 있습니다.");
  for (const line of lines) requireBbox(line.typesetting?.bbox, line.id);
  const candidates = structuredClone([...lines]);
  const sourceBoxes = candidates.map((line) => ({ id: line.id, bbox: { ...line.typesetting!.bbox } }));
  if (!await ensureProductionTypesetFontLoaded()) throw new Error("제품 한글 식자 글꼴을 불러오지 못했습니다.");
  const image = await loadImage(cleanedUrl);
  const width = image.naturalWidth, height = image.naturalHeight;
  validateDimensions(width, height);
  const { context } = createCanvas(width, height);
  context.drawImage(image, 0, 0);
  const layoutReport: PreviewLayoutReport[] = [];
  for (const line of candidates) {
    const style = line.typesetting!;
    const sourceBbox = { ...style.bbox };
    const inferred = inferCandidateBox(context, line, sourceBoxes, width, height);
    style.bbox = inferred.bbox;
    const text = candidateText(line);
    const fontFamily = style.fontFamily || PRODUCTION_TYPESET_FONT_CSS_FAMILY;
    const font = `bold 16px ${getRecommendedFontFallbackChain("ko", fontFamily)}`;
    await document.fonts.load(font, `한글${text}`);
    const glyphFontLoaded = document.fonts.check(font, `한글${text}`);
    if (!glyphFontLoaded) throw new Error(`영역 ${line.id}: 한글 식자 글꼴 확인에 실패했습니다.`);
    const layoutOptions = {
      shape: style.shape ?? "ellipse",
      boxAspectRatio: style.writingMode === "vertical-rl" ? 1 : style.bbox.width * width / (style.bbox.height * height)
    };
    const layout = style.fontSizeRatio
      ? layoutTextForBubbleShape(text, { ...layoutOptions, fontSizeRatio: style.fontSizeRatio })
      : autoFitFontSizeForBubbleShape(text, layoutOptions);
    if (style.fontSizeRatio === undefined) style.fontSizeRatio = layout.fontSizeRatio;
    layoutReport.push({
      id: line.id, sourceBbox, bbox: { ...style.bbox }, bboxInferred: inferred.expanded,
      fontFamily, fontSizeRatio: layout.fontSizeRatio,
      fontSizePx: Math.max(10, Math.round(layout.fontSizeRatio * style.bbox.height * height)),
      productionFontLoaded: true, glyphFontLoaded, qaStatus: "pending", reviewReasons: inferred.reasons
    });
  }
  const blob = await burnTypesettingFromUrl(cleanedUrl, candidates, "image/png", 0.95, 15000, { textResolver: candidateText });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { pngBase64: btoa(binary), width, height, layoutReport };
}

function candidateText(line: DialogueLine): string {
  return line.userTranslation !== undefined ? line.userTranslation.trim() : (line.aiTranslation?.trim() ?? "");
}

function orderedCandidates(ocr: SpeechBubbleExtractionResult): ExtractedSpeechBubble[] {
  validateLineIds(ocr.speechBubbles.map((candidate) => ({ id: candidate.id, order: candidate.readingOrder, pageNumber: 1 })));
  for (const candidate of ocr.speechBubbles) {
    requireBbox(candidate.bbox, candidate.id);
    if (typeof candidate.text !== "string" || !candidate.text.trim()) throw new Error(`영역 ${candidate.id}: OCR 원문이 비어 있습니다.`);
  }
  return [...ocr.speechBubbles].sort((left, right) => left.readingOrder - right.readingOrder);
}

function validateLineIds(lines: readonly Pick<DialogueLine, "id" | "order" | "pageNumber">[]): void {
  const ids = new Set<string>(), orders = new Set<string>();
  for (const line of lines) {
    if (typeof line.id !== "string" || !line.id.trim() || ids.has(line.id)) throw new Error("영역 ID가 비어 있거나 중복되었습니다.");
    const orderKey = `${line.pageNumber}:${line.order}`;
    if (!Number.isInteger(line.pageNumber) || line.pageNumber < 1 || !Number.isInteger(line.order) || line.order < 1 || orders.has(orderKey)) {
      throw new Error("페이지 또는 읽기 순서가 올바르지 않거나 중복되었습니다.");
    }
    ids.add(line.id);
    orders.add(orderKey);
  }
}

function requireBbox(bbox: NormalizedBbox | undefined, id: string): asserts bbox is NormalizedBbox {
  if (!bbox || ![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite) || bbox.x < 0 || bbox.y < 0 ||
      bbox.width <= 0 || bbox.height <= 0 || bbox.x + bbox.width > 1 + 1e-9 || bbox.y + bbox.height > 1 + 1e-9) {
    throw new Error(`영역 ${id}: 실제 정규화 bbox가 필요합니다.`);
  }
}

function polygonBounds(polygon: readonly PolygonPoint[]): NormalizedBbox {
  if (polygon.length < 3 || polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error("실제 polygon 좌표가 올바르지 않습니다.");
  const xs = polygon.map((point) => point.x), ys = polygon.map((point) => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  if (width <= 0 || height <= 0) throw new Error("실제 polygon 면적이 없습니다.");
  return { x, y, width, height };
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error("이미지 크기가 올바르지 않습니다.");
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("브라우저 2D Canvas를 사용할 수 없습니다.");
  return { canvas, context };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const timeout = setTimeout(() => finish(new Error("후보 이미지 로드 시간이 초과되었습니다.")), 15000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      if (error) reject(error); else resolve(image);
    };
    image.onload = () => finish();
    image.onerror = () => finish(new Error("후보 이미지를 불러오지 못했습니다."));
    image.src = url;
  });
}

/** 닫힌 흰 영역만 추정한다. 실패·모호성은 원래 bbox와 검토 사유로 남긴다. */
function inferCandidateBox(
  context: CanvasRenderingContext2D, line: DialogueLine,
  sourceBoxes: readonly { id: string; bbox: NormalizedBbox }[], width: number, height: number
): { bbox: DialogueTypesetting["bbox"]; expanded: boolean; reasons: string[] } {
  const source = line.typesetting!.bbox;
  const retain = (reason: string) => ({ bbox: { ...source }, expanded: false, reasons: [reason] });
  if (line.ocrUserOwnedFields?.includes("geometry") || line.typesetting?.rotationDegrees) return retain("사용자 소유 또는 회전된 배치의 실제 bbox를 유지했습니다.");
  const center = (bbox: NormalizedBbox) => ({ x: Math.min(width - 1, Math.floor((bbox.x + bbox.width / 2) * width)), y: Math.min(height - 1, Math.floor((bbox.y + bbox.height / 2) * height)) });
  const anchor = center(source);
  const halfWidth = Math.ceil(Math.max(source.width * width * 2, Math.min(width, height) * 0.15));
  const halfHeight = Math.ceil(Math.max(source.height * height * 2, Math.min(width, height) * 0.15));
  const left = Math.max(0, anchor.x - halfWidth), top = Math.max(0, anchor.y - halfHeight);
  const right = Math.min(width, anchor.x + halfWidth + 1), bottom = Math.min(height, anchor.y + halfHeight + 1);
  const roiWidth = right - left, roiHeight = bottom - top;
  const pixels = context.getImageData(left, top, roiWidth, roiHeight).data;
  const white = (index: number) => pixels[index * 4 + 3]! >= 250 && Math.min(pixels[index * 4]!, pixels[index * 4 + 1]!, pixels[index * 4 + 2]!) >= 240;
  const start = (anchor.y - top) * roiWidth + anchor.x - left;
  if (!white(start)) return retain("원문 중심이 흰 영역이 아니므로 실제 bbox를 유지했습니다.");
  const seen = new Uint8Array(roiWidth * roiHeight), queue = new Int32Array(seen.length);
  let head = 0, tail = 1, minX = roiWidth, minY = roiHeight, maxX = 0, maxY = 0;
  queue[0] = start;
  seen[start] = 1;
  while (head < tail) {
    const index = queue[head++]!, x = index % roiWidth, y = Math.floor(index / roiWidth);
    if (x === 0 || y === 0 || x === roiWidth - 1 || y === roiHeight - 1) return retain("흰 영역이 페이지 또는 탐색 경계에 닿아 확장을 보류했습니다.");
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    for (const next of [index - 1, index + 1, index - roiWidth, index + roiWidth]) {
      if (!seen[next] && white(next)) { seen[next] = 1; queue[tail++] = next; }
    }
  }
  for (const other of sourceBoxes) {
    if (other.id === line.id) continue;
    const point = center(other.bbox);
    if (point.x >= left && point.x < right && point.y >= top && point.y < bottom && seen[(point.y - top) * roiWidth + point.x - left]) {
      return retain("다른 원문 중심과 같은 흰 영역이므로 확장을 보류했습니다.");
    }
  }
  const padding = Math.max(2, Math.ceil(Math.min(maxX - minX + 1, maxY - minY + 1) * 0.08));
  const bbox = { x: (left + minX + padding) / width, y: (top + minY + padding) / height, width: (maxX - minX + 1 - 2 * padding) / width, height: (maxY - minY + 1 - 2 * padding) / height };
  if (bbox.x > source.x || bbox.y > source.y || bbox.x + bbox.width < source.x + source.width || bbox.y + bbox.height < source.y + source.height) {
    return retain("안전 여백을 둔 흰 영역이 원문 bbox를 포함하지 않아 실제 bbox를 유지했습니다.");
  }
  return { bbox, expanded: true, reasons: ["닫힌 흰 영역의 안전 여백으로 추정한 후보 배치이며 시각 검토가 필요합니다."] };
}
