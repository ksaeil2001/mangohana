// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftLines, translateDrafts, createRemovalMask, renderCandidate } from "../../scripts/local-preview/renderer.ts";
import { computeTranslationPayloadFingerprint } from "../../src/shared/translation/translationPayload.js";
import { resetProductionTypesetFontLoaderForTests } from "../../src/renderer/productionTypesetFont.js";
import { burnTypesettingFromUrl } from "../../src/renderer/imageBurnInRenderer.js";

vi.mock("../../src/renderer/imageBurnInRenderer.js", () => ({ burnTypesettingFromUrl: vi.fn() }));

const options = { endpoint: "http://127.0.0.1:9876/v1", model: "synthetic-model-no-server" };
const box = { x: 0.45, y: 0.37, width: 0.03, height: 0.1 };
const candidate = (id = "region-a", order = 1) => ({
  id, readingOrder: order, type: "speech_bubble", text: `合成原文 ${id}`,
  language: "ja", bbox: { ...box }, confidence: 0.85, notes: "합성 OCR 후보",
  speakerCandidates: [], polygon: [{ x: 0.45, y: 0.37 }, { x: 0.48, y: 0.37 }, { x: 0.48, y: 0.47 }, { x: 0.45, y: 0.47 }]
});
const extraction = (...speechBubbles) => ({ pageNumber: 9, speechBubbles, nonSpeechText: [], warnings: ["합성 검토 경고"] });
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const response = (request) => ({
  engine: "local_ai", usedExactTm: false, translatedText: `후보 ${request.payload.source.id}`,
  contextFingerprint: computeTranslationPayloadFingerprint(request.payload), qaReport: { passed: true, score: 100, issues: [] }
});

// 픽셀 입력/출력과 경로 좌표만 검사하는 double이다. native Canvas raster 검증은 아니다.
function canvasDocument(sample = () => [0, 0, 0, 0]) {
  const canvases = [];
  const fonts = { add: vi.fn(), load: vi.fn(async () => []), check: vi.fn(() => true) };
  const document = {
    fonts,
    createElement: (tag) => {
      if (tag !== "canvas") throw new Error("합성 Canvas 이외 DOM 사용");
      const context = {
        beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
        drawImage: vi.fn((image) => { if (!image.loaded) throw new Error("이미지 로드 전 그리기"); }),
        getImageData: vi.fn((left, top, width, height) => {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(sample(left + x, top + y), (y * width + x) * 4);
          return { data, width, height };
        }),
        putImageData: vi.fn()
      };
      const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => "data:image/png;base64,c3ludGhldGlj" };
      canvases.push({ canvas, context });
      return canvas;
    }
  };
  vi.stubGlobal("document", document);
  return { canvases, fonts };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProductionTypesetFontLoaderForTests();
  let sequence = 0;
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`) });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("모델·네트워크 실행 금지"); }));
  vi.stubGlobal("window", { projectApi: { executeTranslation: vi.fn(async (request) => response(request)) } });
  vi.stubGlobal("Image", class {
    naturalWidth = 120;
    naturalHeight = 100;
    loaded = false;
    set src(_value) { queueMicrotask(() => { this.loaded = true; this.onload?.(); }); }
  });
  vi.stubGlobal("FontFace", class {
    status = "unloaded";
    async load() { this.status = "loaded"; return this; }
  });
  burnTypesettingFromUrl.mockResolvedValue(new Blob(["합성 PNG double"]));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("메모리 OCR 초안", () => {
  it("읽기 순서로 모든 ID와 실제 bbox를 보존하고 원본을 공유하지 않는다", () => {
    const first = candidate("region-a", 3), second = candidate("region-b", 1);
    first.productionOcrProvenance = { groupId: "합성 그룹", sourceQuadsPx: [[{ x: 1, y: 2 }]] };
    const ocr = freeze(extraction(first, second));
    const before = structuredClone(ocr);

    const lines = draftLines(ocr, 2);

    expect(lines.map((line) => [line.id, line.order, line.pageNumber])).toEqual([["region-b", 1, 2], ["region-a", 3, 2]]);
    expect(lines[1]).toMatchObject({ sourceText: first.text, sourceLanguage: "ja", ocrEditStatus: "ai_proposed", typesetting: { bbox: first.bbox } });
    expect(lines.every((line) => line.userTranslation === undefined && line.aiTranslation === undefined)).toBe(true);
    lines[1].typesetting.bbox.x = 0;
    lines[1].ocrSourceInfo.productionOcrProvenance.sourceQuadsPx[0][0].x = 99;
    expect(ocr).toEqual(before);
  });

  it.each([
    ["중복 ID", () => extraction(candidate("same", 1), candidate("same", 2)), /ID/],
    ["빈 ID", () => extraction(candidate("", 1)), /ID/],
    ["중복 순서", () => extraction(candidate("a", 1), candidate("b", 1)), /순서/],
    ["bbox 누락", () => extraction({ ...candidate(), bbox: undefined }), /bbox/]
  ])("%s를 임의 보정하지 않고 중단한다", (_name, fixture, message) => {
    expect(() => draftLines(fixture())).toThrow(message);
  });
});

describe("기존 preload 번역 IPC", () => {
  it("이웃 문맥과 고유 요청 ID를 보내고 응답을 즉시 해당 ID의 제안에 결합한다", async () => {
    const lines = freeze(draftLines(extraction(candidate("a", 1), candidate("b", 2))));
    const before = structuredClone(lines);

    const result = await translateDrafts(lines, options);

    const requests = window.projectApi.executeTranslation.mock.calls.map(([request]) => request);
    expect(requests[0]).toMatchObject({ targetLineId: "a", options: { engineType: "local_ai", localAiRuntime: "custom", localAiEndpoint: options.endpoint, localAiModel: options.model } });
    expect(requests[0].payload.contextWindow.nextTurns[0].sourceText).toBe(lines[1].sourceText);
    expect(requests[1].payload.contextWindow.previousTurns[0].resolvedTranslation).toBe("후보 a");
    expect(requests.every((request) => request.payload.entities.fuzzyTmMatches.length === 0)).toBe(true);
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(2);
    expect(result.lines.map((line) => [line.id, line.aiTranslation, line.userTranslation])).toEqual([["a", "후보 a", undefined], ["b", "후보 b", undefined]]);
    expect(result.records.map((record) => record.id)).toEqual(["a", "b"]);
    for (const record of result.records) {
      expect(record).toMatchObject({ engine: "local_ai", usedExactTm: false, qaReport: { passed: true } });
      expect(record.returnedContextFingerprint).toBe(record.requestedContextFingerprint);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(lines).toEqual(before);
  });

  it.each(["", "   ", "기존 사용자 번역"])("정의된 사용자 값 %j를 그대로 보존한다", async (userTranslation) => {
    const lines = draftLines(extraction(candidate()));
    lines[0].userTranslation = userTranslation;
    lines[0].ocrEditStatus = "user_modified";
    freeze(lines);

    const result = await translateDrafts(lines, options);

    expect(result.lines[0]).toMatchObject({ userTranslation, aiTranslation: "후보 region-a", ocrEditStatus: "user_modified" });
    expect(lines[0].aiTranslation).toBeUndefined();
  });

  it("중복 입력 ID를 IPC 호출 전에 거절한다", async () => {
    const lines = draftLines(extraction(candidate()));

    await expect(translateDrafts([...lines, { ...lines[0], order: 2 }], options)).rejects.toThrow(/ID/);

    expect(window.projectApi.executeTranslation).not.toHaveBeenCalled();
  });

  it.each([
    ["다른 엔진", { engine: "gemini" }], ["TM 직접 응답", { usedExactTm: true }],
    ["빈 번역", { translatedText: " \n " }], ["문자열 아님", { translatedText: 3 }],
    ["다른 문맥 지문", { contextFingerprint: "다른 요청" }]
  ])("%s이면 재시도 없이 실패한다", async (_name, patch) => {
    window.projectApi.executeTranslation.mockImplementation(async (request) => ({ ...response(request), ...patch }));
    const lines = freeze(draftLines(extraction(candidate("a", 1), candidate("b", 2))));

    await expect(translateDrafts(lines, options)).rejects.toThrow();

    expect(window.projectApi.executeTranslation).toHaveBeenCalledTimes(1);
    expect(lines.every((line) => line.aiTranslation === undefined)).toBe(true);
  });

  it("요청 ID 대응이 변조되면 알 수 없는 영역에 응답을 붙이지 않는다", async () => {
    window.projectApi.executeTranslation.mockImplementation(async (request) => {
      const result = response(request);
      request.payload.source.id = "알 수 없는 영역";
      return result;
    });

    await expect(translateDrafts(draftLines(extraction(candidate())), options)).rejects.toThrow(/ID 대응/);
  });
});

describe("제품 규약의 제거 마스크", () => {
  it("비대칭 픽셀을 직접 반전·이진화하고 원본 quad를 원본 Canvas 크기로 변환한다", () => {
    const { canvases } = canvasDocument((x, y) => [17, 43, 91, y === 1 ? ({ 1: 128, 2: 255, 3: 127 }[x] ?? 0) : 0]);
    const region = candidate();
    region.productionOcrProvenance = {
      sourceQuadsPx: [[{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 6 }, { x: 2, y: 6 }]],
      cropTransform: { imageWidth: 14, imageHeight: 10 }
    };
    const ocr = freeze(extraction(region));
    const before = structuredClone(ocr);

    const result = createRemovalMask(ocr, 7, 5);

    const { canvas, context } = canvases[0];
    expect([canvas.width, canvas.height]).toEqual([7, 5]);
    expect(context.moveTo).toHaveBeenCalledWith(1, 1);
    expect(context.lineTo.mock.calls).toEqual([[4, 1], [4, 3], [1, 3]]);
    expect(context.fill).toHaveBeenCalledOnce();
    expect(context.stroke).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ maskPngBase64: "c3ludGhldGlj", maskedPixels: 2, regions: [{ id: region.id, radius: 3, geometrySource: "sourceQuadsPx", bboxPx: { x: 0, y: 0, width: 7, height: 5 } }] });
    expect(context.lineWidth).toBe(result.regions[0].radius * 2);
    const pixels = context.putImageData.mock.calls[0][0].data;
    for (let index = 0; index < pixels.length; index += 4) expect(Array.from(pixels.slice(index, index + 3))).toEqual([255, 255, 255]);
    const alpha = (x, y) => pixels[(y * 7 + x) * 4 + 3];
    expect([alpha(1, 1), alpha(2, 1), alpha(3, 1), alpha(1, 3), alpha(0, 0)]).toEqual([0, 0, 255, 255, 255]);
    expect(ocr).toEqual(before);
  });

  it("provenance가 없으면 실제 정규화 polygon을 쓰고 모든 후보를 유지한다", () => {
    const { canvases } = canvasDocument(() => [255, 255, 255, 255]);
    const ocr = extraction(candidate("b", 2), candidate("a", 1));

    const result = createRemovalMask(ocr, 200, 100);

    expect(result.regions.map((region) => [region.id, region.geometrySource])).toEqual([["a", "polygon"], ["b", "polygon"]]);
    expect(canvases[0].context.moveTo).toHaveBeenCalledWith(90, 37);
  });

  it("실제 polygon도 없으면 bbox로 가짜 제거 영역을 만들지 않는다", () => {
    canvasDocument();
    expect(() => createRemovalMask(extraction({ ...candidate(), polygon: undefined }), 120, 100)).toThrow(/polygon/);
  });
});

describe("메모리 식자 후보", () => {
  it("빈 사용자 번역을 AI로 대체하지 않고 기존 스타일과 원본 상태를 보존한다", async () => {
    const { fonts, canvases } = canvasDocument();
    const lines = draftLines(extraction(candidate("a", 1), candidate("b", 2), candidate("c", 3)));
    lines[0].userTranslation = "";
    lines[1].userTranslation = " 사용자 번역 ";
    lines.forEach((line) => { line.aiTranslation = " AI 제안 "; line.typesetting.fontFamily = "Pretendard"; line.typesetting.strokeWidth = 4; });
    const before = structuredClone(lines);
    freeze(lines);

    const result = await renderCandidate("trio-project://synthetic/cleaned", lines);

    const [url, drafts, mime, , , renderOptions] = burnTypesettingFromUrl.mock.calls[0];
    expect(url).toBe("trio-project://synthetic/cleaned");
    expect(mime).toBe("image/png");
    expect(drafts.map(renderOptions.textResolver)).toEqual(["", "사용자 번역", "AI 제안"]);
    expect(drafts[0].typesetting).toMatchObject({ fontFamily: "Pretendard", strokeWidth: 4 });
    expect(drafts[0].typesetting).not.toBe(lines[0].typesetting);
    expect(canvases[0].context.drawImage).toHaveBeenCalledOnce();
    expect(fonts.add).toHaveBeenCalledOnce();
    expect(fonts.load).toHaveBeenCalledTimes(3);
    expect(fonts.check.mock.calls.some(([, text]) => text?.includes("한글"))).toBe(true);
    expect(result).toMatchObject({ width: 120, height: 100 });
    expect(result.layoutReport.every((row) => row.qaStatus === "pending" && row.glyphFontLoaded && row.productionFontLoaded)).toBe(true);
    expect(lines).toEqual(before);
  });

  it("닫힌 흰 영역에만 안전 여백을 두고 후보 bbox를 확장한다", async () => {
    canvasDocument((x, y) => x >= 43 && x <= 67 && y >= 27 && y <= 57 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const lines = freeze(draftLines(extraction(candidate())));

    const result = await renderCandidate("trio-project://synthetic/cleaned", lines);

    const report = result.layoutReport[0];
    expect(report.bboxInferred).toBe(true);
    expect(report.bbox.width).toBeGreaterThan(box.width);
    expect(report.bbox.height).toBeGreaterThan(box.height);
    expect(report.qaStatus).toBe("pending");
    expect(lines[0].typesetting.bbox).toEqual(box);
  });

  it("페이지·탐색 경계에 닿은 흰 영역은 확장하지 않고 검토 사유를 남긴다", async () => {
    canvasDocument(() => [255, 255, 255, 255]);

    const result = await renderCandidate("trio-project://synthetic/cleaned", draftLines(extraction(candidate())));

    expect(result.layoutReport[0]).toMatchObject({ bboxInferred: false, bbox: box });
    expect(result.layoutReport[0].reviewReasons.join()).toMatch(/경계/);
  });

  it("다른 원문 중심이 같은 흰 영역이면 확장을 거부한다", async () => {
    canvasDocument((x, y) => x >= 43 && x <= 67 && y >= 27 && y <= 57 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    const lines = draftLines(extraction(candidate("a", 1), candidate("b", 2)));
    lines[1].typesetting.bbox = { x: 0.49, y: 0.4, width: 0.02, height: 0.04 };

    const result = await renderCandidate("trio-project://synthetic/cleaned", lines);

    expect(result.layoutReport.every((report) => !report.bboxInferred)).toBe(true);
    expect(result.layoutReport[0].reviewReasons.join()).toMatch(/다른 원문 중심/);
  });

  it("bbox가 누락되면 제품 renderer의 중앙 fallback을 호출하지 않는다", async () => {
    const lines = draftLines(extraction(candidate()));
    lines[0].typesetting = undefined;

    await expect(renderCandidate("trio-project://synthetic/cleaned", lines)).rejects.toThrow(/bbox/);

    expect(burnTypesettingFromUrl).not.toHaveBeenCalled();
  });
});
