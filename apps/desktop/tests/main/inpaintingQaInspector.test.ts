import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectInpaintingQa } from "../../src/main/inpaintingQaInspector.js";
import { evaluateInpaintingQuality } from "../../src/shared/inpaintingQa.js";

const residual = {
  bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
  detectedText: "残",
  residualConfidence: 0.95,
  severity: "severe"
};

function mockGeminiResponse(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockGeminiText(text: string) {
  return mockGeminiResponse({ candidates: [{ content: { parts: [{ text }] } }] });
}

function expectUnmeasured(result: Awaited<ReturnType<typeof inspectInpaintingQa>>) {
  expect(result.qaStatus).toBe("manual_review");
  expect(result.cleanlinessScore).toBe(0);
  expect(result.residualRegions).toEqual([]);
  expect(result.reason).toContain("미측정");
  expect(result.recommendedAction ?? "none").toBe("none");
  expect(result.recommendedDilation ?? 0).toBe(0);
}

describe("inpaintingQaInspector", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["```json\n%s\n```", "검사 결과:\n%s\n끝"])("preserves wrapped QA JSON parsing after removing glossary extraction: %s", async (wrapper) => {
    const text = wrapper.replace("%s", JSON.stringify({ residualRegions: [residual] }));
    const fetchMock = mockGeminiText(text);

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.residualRegions).toEqual([expect.objectContaining(residual)]);
    expect(result.qaStatus).not.toBe("pass");
  });

  it("requires manual review without running residual detection when no key is available", async () => {
    const dummyImage = Buffer.alloc(128, 0xff);
    const dummyMask = Buffer.alloc(128, 0x00);

    const result = await inspectInpaintingQa({
      inpaintedImageBytes: dummyImage,
      maskBytes: dummyMask,
      attemptCount: 1,
      maxRetryAttempts: 2
    });

    expectUnmeasured(result);
    expect(result.attemptCount).toBe(1);
    expect(result.maxRetryAttempts).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles empty or invalid image buffer gracefully by marking manual review", async () => {
    const invalidImage = Buffer.alloc(0);

    const result = await inspectInpaintingQa({
      inpaintedImageBytes: invalidImage,
      attemptCount: 1
    });

    expect(result.qaStatus).toBe("manual_review");
    expect(result.cleanlinessScore).toBe(0.0);
    expect(result.reason).toContain("올바르지 않습니다");
    expectUnmeasured(result);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["%s", "```json\n%s\n```", "검사 결과:\n%s\n끝"])("passes an explicitly empty residualRegions list: %s", async (wrapper) => {
    const fetchMock = mockGeminiText(wrapper.replace("%s", '{"residualRegions":[]}'));

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expect(result.qaStatus).toBe("pass");
    expect(result.cleanlinessScore).toBe(1);
    expect(result.residualRegions).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves residual evaluation and trims optional text fields", async () => {
    mockGeminiText(JSON.stringify({ residualRegions: [{ ...residual, detectedText: " 残 ", notes: " 흔적 " }] }));

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expect(result.qaStatus).toBe("retry");
    expect(result.cleanlinessScore).toBeLessThan(1);
    expect(result.residualRegions).toEqual([{ ...residual, notes: "흔적" }]);
    expect(result.recommendedAction).toBe("auto_retry_dilate");
  });

  it("accepts confidence one with a full-image bbox and absent optional text", async () => {
    mockGeminiText(JSON.stringify({ residualRegions: [{
      bbox: { x: 0, y: 0, width: 1, height: 1 }, residualConfidence: 1, severity: "minor"
    }] }));

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expect(result.qaStatus).toBe("retry");
    expect(result.reason).not.toContain("미측정");
  });

  it("preserves all low-confidence candidates for manual review instead of passing", async () => {
    for (const confidences of [[0], [0.1], [0.24999999999999997], [0, 0.1, 0.24999999999999997]]) {
      const regions = confidences.map((residualConfidence, index) => ({
        ...residual, bbox: { ...residual.bbox, x: 0.1 + index * 0.2 }, residualConfidence,
        severity: index % 2 === 0 ? "minor" : "severe", notes: "검토 후보"
      }));
      const fetchMock = mockGeminiText(JSON.stringify({ residualRegions: regions }));

      const result = await inspectInpaintingQa({
        inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key", attemptCount: 2, maxRetryAttempts: 4
      });

      expect.soft(result, JSON.stringify(confidences)).toMatchObject({
        qaStatus: "manual_review", cleanlinessScore: 0, residualRegions: regions, attemptCount: 2, maxRetryAttempts: 4,
        reason: "낮은 신뢰도 후보로 잔여 여부를 확정하지 못함, 청결도 미측정",
        recommendedAction: "none", recommendedDilation: 0
      });
      expect.soft(result.residualRegions).toEqual(regions);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves shared retry and manual review exactly at confidence 0.25", async () => {
    const region = { ...residual, residualConfidence: 0.25, severity: "minor" as const };
    for (const attemptCount of [1, 2]) {
      mockGeminiText(JSON.stringify({ residualRegions: [region] }));

      const result = await inspectInpaintingQa({
        inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key", attemptCount, maxRetryAttempts: 2
      });

      const expected = evaluateInpaintingQuality({ residualRegions: [region], attemptCount, maxRetryAttempts: 2 });
      expect(result).toEqual({ ...expected, evaluatedAt: expect.any(String) });
      expect(result.qaStatus).toBe(attemptCount === 1 ? "retry" : "manual_review");
      expect(result.reason).not.toContain("미측정");
    }
  });

  it("preserves shared evaluation when low and qualifying confidence candidates are mixed", async () => {
    const low = { ...residual, residualConfidence: 0.1, severity: "minor" as const };
    for (const residualConfidence of [0.25, 0.95]) {
      const qualifying = { ...residual, residualConfidence, severity: "severe" as const };
      for (const attemptCount of [1, 2]) {
        const regions = [low, qualifying];
        mockGeminiText(JSON.stringify({ residualRegions: regions }));

        const result = await inspectInpaintingQa({
          inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key", attemptCount, maxRetryAttempts: 2
        });

        const expected = evaluateInpaintingQuality({ residualRegions: regions, attemptCount, maxRetryAttempts: 2 });
        expect(result).toEqual({ ...expected, evaluatedAt: expect.any(String) });
        expect(result.residualRegions).toEqual([qualifying]);
        expect(result.reason).not.toContain("미측정");
      }
    }
  });

  it.each([
    ["null payload", null],
    ["missing candidates", {}],
    ["null candidates", { candidates: null }],
    ["empty candidates", { candidates: [] }],
    ["object candidates", { candidates: { 0: { content: { parts: [{ text: '{"residualRegions":[]}' }] } } } }],
    ["missing content", { candidates: [{}] }],
    ["missing parts", { candidates: [{ content: {} }] }],
    ["object parts", { candidates: [{ content: { parts: { 0: { text: '{"residualRegions":[]}' } } } }] }],
    ["empty parts", { candidates: [{ content: { parts: [] } }] }],
    ["missing text", { candidates: [{ content: { parts: [{}] } }] }],
    ["null text", { candidates: [{ content: { parts: [{ text: null }] } }] }],
    ["object text", { candidates: [{ content: { parts: [{ text: {} }] } }] }]
  ])("requires manual review for an invalid Gemini response: %s", async (_name, payload) => {
    const fetchMock = mockGeminiResponse(payload);

    const result = await inspectInpaintingQa({
      inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key", attemptCount: 2, maxRetryAttempts: 4
    });

    expectUnmeasured(result);
    expect(result.attemptCount).toBe(2);
    expect(result.maxRetryAttempts).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing residualRegions", "{}"],
    ["null root", "null"],
    ["array root", '[{"residualRegions":[]}]'],
    ["string root", '"no residuals"'],
    ["null residualRegions", '{"residualRegions":null}'],
    ["object residualRegions", '{"residualRegions":{}}'],
    ["string residualRegions", '{"residualRegions":""}'],
    ["boolean residualRegions", '{"residualRegions":false}'],
    ["numeric residualRegions", '{"residualRegions":0}'],
    ["empty text", ""],
    ["whitespace text", " \n "],
    ["non-JSON text", "검사를 완료하지 못했습니다."],
    ["broken JSON", '{"residualRegions":[}'],
    ["truncated JSON", '{"residualRegions":[]']
  ])("requires manual review for invalid QA JSON: %s", async (_name, text) => {
    const fetchMock = mockGeminiText(text);

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expectUnmeasured(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["null region", null],
    ["array region", []],
    ["string region", "residue"],
    ["empty region", {}],
    ["missing bbox", { ...residual, bbox: undefined }],
    ["null bbox", { ...residual, bbox: null }],
    ["array bbox", { ...residual, bbox: [] }],
    ["missing confidence", { ...residual, residualConfidence: undefined }],
    ["null confidence", { ...residual, residualConfidence: null }],
    ["string confidence", { ...residual, residualConfidence: "0.95" }],
    ["non-numeric confidence", { ...residual, residualConfidence: "NaN" }],
    ["boolean confidence", { ...residual, residualConfidence: true }],
    ["negative confidence", { ...residual, residualConfidence: -0.1 }],
    ["excessive confidence", { ...residual, residualConfidence: 1.1 }],
    ["missing severity", { ...residual, severity: undefined }],
    ["null severity", { ...residual, severity: null }],
    ["unknown severity", { ...residual, severity: "critical" }],
    ["numeric severity", { ...residual, severity: 1 }],
    ["null detectedText", { ...residual, detectedText: null }],
    ["object detectedText", { ...residual, detectedText: {} }],
    ["numeric notes", { ...residual, notes: 1 }],
    ["null notes", { ...residual, notes: null }]
  ])("rejects an invalid residual region without inventing detections: %s", async (_name, region) => {
    mockGeminiText(JSON.stringify({ residualRegions: [residual, region] }));

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expectUnmeasured(result);
  });

  it.each([
    ["missing x", { ...residual.bbox, x: undefined }],
    ["missing y", { ...residual.bbox, y: undefined }],
    ["missing width", { ...residual.bbox, width: undefined }],
    ["missing height", { ...residual.bbox, height: undefined }],
    ["string x", { ...residual.bbox, x: "0.1" }],
    ["null y", { ...residual.bbox, y: null }],
    ["string width", { ...residual.bbox, width: "0.3" }],
    ["boolean height", { ...residual.bbox, height: false }],
    ["negative x", { ...residual.bbox, x: -0.1 }],
    ["negative y", { ...residual.bbox, y: -0.1 }],
    ["x above one", { ...residual.bbox, x: 1.1 }],
    ["y above one", { ...residual.bbox, y: 1.1 }],
    ["zero width", { ...residual.bbox, width: 0 }],
    ["zero height", { ...residual.bbox, height: 0 }],
    ["negative width", { ...residual.bbox, width: -0.1 }],
    ["negative height", { ...residual.bbox, height: -0.1 }],
    ["width above one", { ...residual.bbox, width: 1.1 }],
    ["height above one", { ...residual.bbox, height: 1.1 }],
    ["horizontal sum above one", { ...residual.bbox, x: 0.8, width: 0.3 }],
    ["vertical sum above one", { ...residual.bbox, y: 0.95, height: 0.1 }]
  ])("rejects invalid normalized coordinates: %s", async (_name, bbox) => {
    mockGeminiText(JSON.stringify({ residualRegions: [{ ...residual, bbox }] }));

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expectUnmeasured(result);
  });

  it.each([
    ["NaN confidence", '{"residualRegions":[{"bbox":{"x":0,"y":0,"width":1,"height":1},"residualConfidence":NaN,"severity":"minor"}]}'],
    ["infinite confidence", '{"residualRegions":[{"bbox":{"x":0,"y":0,"width":1,"height":1},"residualConfidence":1e309,"severity":"minor"}]}'],
    ["infinite coordinate", '{"residualRegions":[{"bbox":{"x":1e309,"y":0,"width":1,"height":1},"residualConfidence":0.95,"severity":"minor"}]}']
  ])("requires manual review for non-finite JSON numbers: %s", async (_name, text) => {
    mockGeminiText(text);

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expectUnmeasured(result);
  });

  it("requires manual review when the HTTP response body is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("private-response-content", { status: 200 }));

    const result = await inspectInpaintingQa({ inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key" });

    expectUnmeasured(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["request", "http"])("does not expose response content or credentials after a %s failure", async (failure) => {
    const privateContent = "fake-qa-key private-response-content";
    if (failure === "request") {
      vi.mocked(fetch).mockRejectedValue(new Error(privateContent));
    } else {
      vi.mocked(fetch).mockResolvedValue(new Response(privateContent, { status: 403 }));
    }

    const result = await inspectInpaintingQa({
      inpaintedImageBytes: Buffer.alloc(128), apiKey: "fake-qa-key", attemptCount: 2, maxRetryAttempts: 4
    });

    expectUnmeasured(result);
    expect(result.attemptCount).toBe(2);
    expect(result.maxRetryAttempts).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const warning = vi.mocked(console.warn).mock.calls[0];
    expect(warning).toHaveLength(1);
    expect(typeof warning[0]).toBe("string");
    expect(warning[0]).not.toContain("private-response-content");
    expect(warning[0]).not.toContain("fake-qa-key");
    expect(result.reason).not.toContain("private-response-content");
    expect(result.reason).not.toContain("fake-qa-key");
  });
});
