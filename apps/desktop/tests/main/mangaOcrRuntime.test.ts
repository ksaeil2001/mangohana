// @vitest-environment node
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANGA_OCR_MODELS, type ProductionOcrGroup } from "../../src/shared/productionOcr.js";
import { HAYAI_CPU_RUNTIME_MANIFEST, HAYAI_MODEL_FILES, MANGA_DETECTOR_FILE,
  MANGA_TEXT_EVIDENCE_REC_FILE, MANGA_TEXT_EVIDENCE_DICT_FILE } from "../../src/main/ocr/runtime/mangaOcrManifest.js";
import { createMangaOcrRuntime, type MangaTextVerifierInput } from "../../src/main/ocr/runtime/mangaOcrRuntime.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

type Request = {
  requestId: string;
  operation: string;
  protocolVersion: number;
  configuration: Record<string, unknown> & { profile: "manga-detection" | "hayai" };
  imageBase64?: string;
  candidateId?: string;
  sourceQuadPx?: MangaTextVerifierInput["sourceQuadPx"];
  cropBboxPx?: MangaTextVerifierInput["cropBboxPx"];
};
type Reply = Record<string, unknown> | undefined;
type Handler = (request: Request, child: FakeChild) => Reply;
type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  requests: Request[];
};

const binding = {
  packRoot: resolve("test-signed-pack"),
  pythonExecutable: resolve("test-signed-pack/runtime/python.exe"),
  sidecarEntrypoint: resolve("test-signed-pack/sidecar/trio_ocr_sidecar.py")
};
const options = {
  assetsRoot: resolve("test-local-assets"),
  detectorModelPath: resolve("test-detector/manga_det_v0.2.onnx"),
  resourcesPath: resolve("resources")
};
const runtimes: ReturnType<typeof createMangaOcrRuntime>[] = [];
let children: FakeChild[];
let handle: Handler;

beforeEach(() => {
  children = [];
  handle = success;
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
});
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); });

function runtime() {
  const value = createMangaOcrRuntime(binding, options);
  runtimes.push(value);
  return value;
}

describe("fixed Manga/Hayai offline runtime", () => {
  it("probes two separate children through the app script without changing the signed binding", async () => {
    const original = { ...binding };
    await runtime().probe();
    expect(children).toHaveLength(2);
    expect(binding).toEqual(original);
    expect(mocks.spawn).toHaveBeenCalledWith(binding.pythonExecutable,
      ["-I", "-X", "utf8", "-B", join(options.resourcesPath, "managed-ocr", "manga_ocr.py"), "--pack-root", binding.packRoot],
      expect.objectContaining({ cwd: binding.packRoot, shell: false, windowsHide: true,
        env: expect.objectContaining({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }) }));
    expect(children[0].requests[0]).toMatchObject({ protocolVersion: 1, operation: "probe", configuration: {
      profile: "manga-detection", ...MANGA_OCR_MODELS.detector, modelPath: options.detectorModelPath, modelFile: MANGA_DETECTOR_FILE,
      textEvidence: { ruleVersion: 1, component: "rec", ...MANGA_OCR_MODELS.detector,
        modelRoot: join(options.assetsRoot, "manga-c94f4a20"), modelFile: MANGA_TEXT_EVIDENCE_REC_FILE,
        dictionaryFile: MANGA_TEXT_EVIDENCE_DICT_FILE }
    } });
    expect(children[1].requests[0]).toMatchObject({ operation: "probe", configuration: {
      profile: "hayai", ...MANGA_OCR_MODELS.recognizer,
      modelRoot: join(options.assetsRoot, "hayai-2803d0dc"), modelFiles: HAYAI_MODEL_FILES,
      wheelRoot: join(options.assetsRoot, "wheels", HAYAI_CPU_RUNTIME_MANIFEST.id),
      runtimeRoot: join(options.assetsRoot, "runtimes", HAYAI_CPU_RUNTIME_MANIFEST.id),
      runtimeFiles: HAYAI_CPU_RUNTIME_MANIFEST.files
    } });
  });

  it("parses source quads and orientation and labels only the actual Manga detector", async () => {
    const result = await runtime().detector.detect({ imageBytes: Buffer.from("synthetic-page") });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ detectionId: "manga:0001", sourceModel: MANGA_OCR_MODELS.detector,
      sourceQuadPx: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 90 }, { x: 10, y: 90 }],
      sourceBboxPx: { x: 10, y: 20, width: 20, height: 70 }, orientation: "vertical", score: 0.9,
      imageWidth: 200, imageHeight: 100 });
    expect(result[0]).not.toHaveProperty("balloonSupported");
    expect(children[0].requests[0].imageBase64).toBe(Buffer.from("synthetic-page").toString("base64"));
  });

  it("returns complete Hayai text unchanged without a provider or translation operation", async () => {
    await expect(runtime().recognizer.recognizeGroup({ cropBytes: Buffer.from("synthetic-crop"), group }))
      .resolves.toEqual({ text: "こんにちは𠮷" });
    expect(children[0].requests.map(request => request.operation)).toEqual(["recognize"]);
    expect(children[0].requests[0]).not.toHaveProperty("provider");
    expect(children[0].requests[0].configuration.profile).toBe("hayai");
  });

  it("keeps arbitrary crop coordinates local to the provided image", async () => {
    handle = request => ({ ...success(request), imageWidth: 80, imageHeight: 40,
      detections: [{ detectionId: "crop-1", quad: [[2, 4], [60, 4], [60, 16], [2, 16]], score: 0.8 }] });
    const result = await runtime().detector.detect({ imageBytes: Buffer.from("synthetic-crop") });
    expect(result[0]).toMatchObject({ detectionId: "manga:crop-1", imageWidth: 80, imageHeight: 40,
      sourceBboxPx: { x: 2, y: 4, width: 58, height: 12 }, orientation: "horizontal" });
    expect(children[0].requests[0]).not.toHaveProperty("crop");
  });

  it.each([false, undefined, "true", 1])("rejects incomplete recognition (%s) and stops both workers", async (complete) => {
    const value = runtime();
    await value.probe();
    handle = request => ({ ...success(request), complete });
    await expect(value.recognizer.recognizeGroup({ cropBytes: Buffer.from("crop"), group })).rejects.toThrow("완전하지");
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.each([42, "\u0000bad", "x".repeat(8193)])("rejects malformed recognizer text", async text => {
    handle = request => ({ ...success(request), text });
    await expect(runtime().recognizer.recognizeGroup({ cropBytes: Buffer.from("crop"), group })).rejects.toThrow();
    expect(children[0].kill).toHaveBeenCalled();
  });

  it.each([
    { modelId: "genshiai-daichi/baberu-ocr" }, { revision: "untrusted" }, { modelSha256: "0".repeat(64) },
    { profile: "other" }, { device: "cuda" }, { executionProvider: "CUDAExecutionProvider" },
    { protocolVersion: 2 }, { operation: "recognized" }
  ])("rejects untrusted response identity %j during probe and closes every child", async (change) => {
    handle = request => request.configuration.profile === "hayai" ? { ...success(request), ...change } : success(request);
    await expect(runtime().probe()).rejects.toThrow("identity");
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.each(["detect", "recognize"])("checks identity on each %s response after a successful probe", async operation => {
    const value = runtime();
    await value.probe();
    handle = request => ({ ...success(request), modelId: "wrong-model" });
    await expect(operation === "detect"
      ? value.detector.detect({ imageBytes: Buffer.from("page") })
      : value.recognizer.recognizeGroup({ cropBytes: Buffer.from("crop"), group })).rejects.toThrow("identity");
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.each([
    { imageWidth: 0 }, { imageHeight: Number.POSITIVE_INFINITY }, { complete: false }, { detections: null },
    { detections: [{ detectionId: "bad", quad: [[-1, 0], [2, 0], [2, 10], [0, 10]], score: 0.9 }] },
    { detections: [{ detectionId: "bad", quad: [[0, 0], [2, 0], [2, 10], [0, 10]], score: 1.1 }] },
    { detections: [{ detectionId: "same", quad: [[0, 0], [2, 0], [2, 10], [0, 10]], score: 0.9 },
      { detectionId: "same", quad: [[0, 0], [2, 0], [2, 10], [0, 10]], score: 0.9 }] }
  ])("rejects malformed detector output even with onWarning %j", async change => {
    const warning = vi.fn();
    handle = request => ({ ...success(request), ...change });
    await expect(runtime().detector.detect({ imageBytes: Buffer.from("page"), onWarning: warning })).rejects.toThrow();
    expect(warning).not.toHaveBeenCalled();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });

  it.each(["initialization-error", "invalid-json", "spawn-error"])("cleans up when %s prevents preparation", async failure => {
    if (failure === "spawn-error") mocks.spawn.mockImplementationOnce(() => { throw new Error("synthetic spawn failure"); });
    else handle = (request, child) => {
      if (failure === "invalid-json") { child.stdout.write("invalid JSON\n"); return; }
      return { operation: "error", code: "MANGA_OCR_RUNTIME_FAILED" };
    };
    await expect(runtime().probe()).rejects.toThrow();
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("resends fixed configuration to a replacement worker after recognition cancellation", async () => {
    const value = runtime();
    await value.probe();
    const original = children[1].requests[0].configuration;
    handle = request => request.operation === "recognize" ? undefined : success(request);
    const abort = new AbortController();
    const pending = value.recognizer.recognizeGroup({ cropBytes: Buffer.from("crop"), group, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
    handle = success;
    await expect(value.recognizer.recognizeGroup({ cropBytes: Buffer.from("retry"), group })).resolves.toEqual({ text: "こんにちは𠮷" });
    expect(children).toHaveLength(3);
    expect(children[2].requests).toHaveLength(1);
    expect(children[2].requests[0].configuration).toEqual(original);
  });

  it("reinitializes both profiles after a cancelled initial probe", async () => {
    const value = runtime();
    handle = request => request.configuration.profile === "hayai" ? undefined : success(request);
    const abort = new AbortController();
    const pending = value.probe(abort.signal);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    handle = success;
    await value.probe();
    expect(children).toHaveLength(4);
    expect(children[2].requests[0].configuration).toEqual(children[0].requests[0].configuration);
    expect(children[3].requests[0].configuration).toEqual(children[1].requests[0].configuration);
  });

  it("close is terminal and pre-aborted requests do not start a process", async () => {
    const value = runtime();
    const abort = new AbortController();
    abort.abort();
    await expect(value.probe(abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(children).toHaveLength(0);
    await value.probe();
    value.close();
    await expect(value.probe()).rejects.toThrow("종료");
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("fixed CTC text-presence evidence only", () => {
  it.each([
    { texts: ["霊体復元あ", "霊体復元い"], means: [0.909, 0.808], accepted: true, ratio: 4 / 5 },
    { texts: ["霊", "霊"], means: [0.979, 0.926], accepted: true, ratio: 1 },
    { texts: ["復元あ", "復元い"], means: [0.778, 0.605], accepted: true, ratio: 2 / 3 },
    { texts: ["カ", "ア"], means: [0.249, 0.411], accepted: false, ratio: 0 },
    { texts: ["文字", ""], means: [0.9, 0], accepted: false, ratio: 0 },
    { texts: ["𠮷あい", "𠮷うえ"], means: [0.9, 0.9], accepted: false, ratio: 1 / 3 },
    { texts: ["𠮷あい", "𠮷あう"], means: [0.6, 0.6], accepted: true, ratio: 2 / 3 },
    { texts: ["abcde", "abcXY"], means: [0.6, 0.6], accepted: true, ratio: 0.6 },
    { texts: ["abcde", "XXabcde"], means: [0.99, 0.99], accepted: false, ratio: 0 },
    { texts: ["字", "字"], means: [0.6, 0.599999], accepted: false, ratio: 1 }
  ])("validates the same two-decode rule: %j", async ({ texts, means, accepted, ratio }) => {
    handle = request => ({ ...success(request), ...gateEvidence(request, texts, means) });
    const result = await runtime().textVerifier.verify(gateInput());
    expect(result).toMatchObject({ accepted, commonPrefixRatio: ratio, role: "text-presence-gate", component: "rec",
      candidateId: "manga:synthetic-ctc", ruleVersion: 1, ...MANGA_OCR_MODELS.detector });
    expect(result.inputs.map(item => item.padding)).toEqual([0.08, 0.5]);
    expect(result.inputs.map(item => item.text)).toEqual(texts);
    expect(children).toHaveLength(1);
    expect(children[0].requests[0]).toMatchObject({ operation: "verify-text", sourceQuadPx: gateInput().sourceQuadPx,
      cropBboxPx: gateInput().cropBboxPx, candidateId: "manga:synthetic-ctc" });
    expect(children[0].requests[0].configuration.profile).toBe("manga-detection");
    expect(result).not.toHaveProperty("text");
  });

  it.each([{ recSha256: "0".repeat(64) }, { dictSha256: "0".repeat(64) }, { ruleVersion: 2 },
    { recSha256: undefined }, { dictSha256: undefined }, { ruleVersion: undefined }])(
    "requires fixed rec/dict identity on detector probe: %j", async change => {
      handle = request => ({ ...success(request), ...change });
      await expect(runtime().probe()).rejects.toThrow("identity");
      expect(children[0].kill).toHaveBeenCalledTimes(1);
    });

  it.each([
    (e: Record<string, unknown>) => ({ ...e, complete: false }),
    (e: Record<string, unknown>) => ({ ...e, candidateId: "other-candidate" }),
    (e: Record<string, unknown>) => ({ ...e, role: "recognizer" }),
    (e: Record<string, unknown>) => ({ ...e, component: "det" }),
    (e: Record<string, unknown>) => ({ ...e, inputContextPngSha256: "0".repeat(64) }),
    (e: Record<string, unknown>) => ({ ...e, cropBboxPx: { ...gateInput().cropBboxPx, x: 0 } }),
    (e: Record<string, unknown>) => ({ ...e, sourceQuadPx: [...gateInput().sourceQuadPx].reverse() }),
    (e: Record<string, unknown>) => ({ ...e, inputs: (e.inputs as unknown[]).slice(0, 1) }),
    (e: Record<string, unknown>) => ({ ...e, inputs: [...e.inputs as unknown[], (e.inputs as unknown[])[0]] }),
    (e: Record<string, unknown>) => ({ ...e, accepted: false }),
    (e: Record<string, unknown>) => ({ ...e, accepted: 1 }),
    (e: Record<string, unknown>) => ({ ...e, commonPrefixRatio: 0.6 }),
    (e: Record<string, unknown>) => ({ ...e, reason: "fallback" })
  ])("rejects malformed gate identity, geometry or decision #%#", async change => {
    handle = request => ({ ...success(request), ...change(gateEvidence(request)) });
    await expect(runtime().textVerifier.verify(gateInput())).rejects.toThrow("text-evidence");
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });

  it.each([
    { padding: 1 }, { padding: 0.5 }, { rotation: 270 }, { width: 132 }, { height: 49 },
    { rectifiedSize: { width: 20, height: 63 } }, { inputPngSha256: "x".repeat(64) }, { tensorSha256: undefined },
    { mean: -0.01 }, { mean: 1.01 }, { mean: Number.NaN }, { mean: "0.9" }, { text: "Ａ" },
    { text: " 字 " }, { text: "\u0000" }, { text: "\ud800" }
  ])("rejects malformed evidence input %j", async change => {
    handle = request => {
      const evidence = gateEvidence(request);
      const inputs = evidence.inputs as Record<string, unknown>[];
      return { ...success(request), ...evidence, inputs: [{ ...inputs[0], ...change }, inputs[1]] };
    };
    await expect(runtime().textVerifier.verify(gateInput())).rejects.toThrow("text-evidence");
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });

  it.each([
    { candidateId: "" }, { candidateId: "x".repeat(257) }, { candidateId: "bad\nidentity" },
    { imageBytes: Buffer.from("not PNG") },
    { cropBboxPx: { x: 100, y: 200, width: 99, height: 100 } },
    { cropBboxPx: { x: 100, y: 200, width: 0, height: 100 } },
    { cropBboxPx: { x: 100.5, y: 200, width: 100, height: 100 } },
    { sourceQuadPx: [{ x: 99, y: 220 }, { x: 140, y: 220 }, { x: 140, y: 280 }, { x: 120, y: 280 }] },
    { sourceQuadPx: [{ x: Number.NaN, y: 220 }, { x: 140, y: 220 }, { x: 140, y: 280 }, { x: 120, y: 280 }] },
    { sourceQuadPx: [{ x: 120, y: 220 }, { x: 120, y: 220 }, { x: 140, y: 280 }, { x: 120, y: 280 }] }
  ])("rejects malformed input before starting a child: %j", async change => {
    await expect(runtime().textVerifier.verify({ ...gateInput(), ...change } as MangaTextVerifierInput)).rejects.toThrow("text-evidence");
    expect(children).toHaveLength(0);
  });

  it("snapshots geometry and PNG bytes while the request is pending", async () => {
    const input = gateInput();
    const pending = runtime().textVerifier.verify(input);
    input.imageBytes.fill(0);
    input.cropBboxPx = { x: 0, y: 0, width: 1, height: 1 };
    input.sourceQuadPx = [...input.sourceQuadPx].reverse() as unknown as MangaTextVerifierInput["sourceQuadPx"];
    await expect(pending).resolves.toMatchObject({ accepted: true, cropBboxPx: gateInput().cropBboxPx,
      sourceQuadPx: gateInput().sourceQuadPx });
  });

  it("shares the detector child, cleans up cancellation, and resends pins on retry", async () => {
    const value = runtime();
    await value.probe();
    const original = children[0].requests[0].configuration;
    handle = request => request.operation === "verify-text" ? undefined : success(request);
    const abort = new AbortController();
    const pending = value.textVerifier.verify({ ...gateInput(), signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
    handle = success;
    await expect(value.textVerifier.verify(gateInput())).resolves.toMatchObject({ accepted: true });
    expect(children).toHaveLength(3);
    expect(children[2].requests[0].configuration).toEqual(original);
  });

  it("does not start a process on pre-aborted gate or after close", async () => {
    const value = runtime();
    const abort = new AbortController();
    abort.abort();
    await expect(value.textVerifier.verify({ ...gateInput(), signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    value.close();
    await expect(value.textVerifier.verify(gateInput())).rejects.toThrow("종료");
    expect(children).toHaveLength(0);
  });
});

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn().mockReturnValue(true);
  child.requests = [];
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString("utf8")) as Request;
    child.requests.push(request);
    queueMicrotask(() => {
      const response = handle(request, child);
      if (response) child.stdout.write(`${JSON.stringify({ ...response, requestId: request.requestId })}\n`);
    });
  });
  return child;
}

function success(request: Request): Reply {
  const detecting = request.configuration.profile === "manga-detection";
  return {
    protocolVersion: 1, operation: request.operation, profile: request.configuration.profile,
    ...(detecting ? MANGA_OCR_MODELS.detector : MANGA_OCR_MODELS.recognizer),
    modelSha256: detecting ? MANGA_DETECTOR_FILE.sha256 : HAYAI_MODEL_FILES[0].sha256,
    device: "cpu", executionProvider: detecting ? "CPUExecutionProvider" : "torch-cpu",
    ...(detecting ? { ruleVersion: 1, recSha256: MANGA_TEXT_EVIDENCE_REC_FILE.sha256,
      dictSha256: MANGA_TEXT_EVIDENCE_DICT_FILE.sha256 } : {}),
    ...(request.operation === "detect" ? { imageWidth: 200, imageHeight: 100, complete: true,
      detections: [{ detectionId: "0001", quad: [[10, 20], [30, 20], [30, 90], [10, 90]], score: 0.9 }] } : {}),
    ...(request.operation === "recognize" ? { text: "こんにちは𠮷", complete: true } : {}),
    ...(request.operation === "verify-text" ? gateEvidence(request) : {})
  };
}

function gateInput(): MangaTextVerifierInput {
  // Synthetic 100x100 white PNG. No project assets or provider execution.
  return { imageBytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAA5klEQVR4nO3SsREAIAwDMWD/ncMK+V6qXf35zsxh5y13iNV4ViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYg1tn7z/EDxbGcl84AAAAASUVORK5CYII=", "base64"),
    candidateId: "manga:synthetic-ctc", cropBboxPx: { x: 100, y: 200, width: 100, height: 100 },
    sourceQuadPx: [{ x: 120, y: 220 }, { x: 140, y: 220 }, { x: 140, y: 280 }, { x: 120, y: 280 }] };
}

function gateEvidence(request: Request, texts = ["復元", "復元"], means = [0.9, 0.9]): Record<string, unknown> {
  const letters = texts.map(text => Array.from(text));
  const shortest = Math.min(...letters.map(text => text.length));
  let prefix = 0;
  while (prefix < shortest && letters[0][prefix] === letters[1][prefix]) prefix++;
  const commonPrefixRatio = shortest ? prefix / shortest : 0;
  const reason = !shortest ? "empty-decode" : means.some(mean => mean < 0.6) ? "low-mean"
    : commonPrefixRatio < 0.6 ? "unstable-prefix" : "accepted";
  return { candidateId: request.candidateId, role: "text-presence-gate", component: "rec", complete: true,
    sourceQuadPx: request.sourceQuadPx, cropBboxPx: request.cropBboxPx,
    inputContextPngSha256: createHash("sha256").update(Buffer.from(request.imageBase64!, "base64")).digest("hex"),
    inputs: [0.08, 0.5].map((padding, index) => ({ padding, rectifiedSize: { width: 23, height: index ? 80 : 63 },
      rotation: 90, width: index ? 167 : 131, height: 48, inputPngSha256: "a".repeat(64), tensorSha256: "b".repeat(64),
      text: texts[index], mean: means[index] })), commonPrefixRatio, reason, accepted: reason === "accepted" };
}

const group: ProductionOcrGroup = {
  groupId: "synthetic-group", sourceDetectionIds: ["manga:0001"], memberQuadsPx: [], memberScores: [0.9],
  groupBboxPx: { x: 0, y: 0, width: 10, height: 20 }, bbox: { x: 0, y: 0, width: 0.1, height: 0.2 },
  polygon: [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.2 }, { x: 0, y: 0.2 }],
  orientation: "vertical", readingOrder: 1, confidence: 0.9, imageWidth: 100, imageHeight: 100
};
