import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { MANGA_OCR_MODELS, type ProductionOcrDetection, type ProductionOcrPixelBbox } from "../../../shared/productionOcr.js";
import { parseProductionOcrDetections } from "../detection/productionDetectorParser.js";
import type { ProductionOcrDetector, ProductionOcrRecognizer } from "../pipeline/productionOcrPipeline.js";
import {
  HAYAI_CPU_RUNTIME_MANIFEST,
  HAYAI_MODEL_FILES,
  MANGA_DETECTOR_FILE,
  MANGA_TEXT_EVIDENCE_REC_FILE,
  MANGA_TEXT_EVIDENCE_DICT_FILE
} from "./mangaOcrManifest.js";
import type { ProductionOcrRuntimeBinding } from "./productionOcrResource.js";
import { ProductionOcrSidecarTransport } from "./productionOcrSidecarTransport.js";

export type MangaOcrRuntimeOptions = {
  assetsRoot: string;
  detectorModelPath: string;
  resourcesPath: string;
};

export type MangaTextVerifierInput = {
  imageBytes: Buffer;
  candidateId: string;
  sourceQuadPx: ProductionOcrDetection["sourceQuadPx"];
  cropBboxPx: ProductionOcrPixelBbox;
  signal?: AbortSignal;
};

export type MangaTextEvidenceInput = Readonly<{
  padding: 0.08 | 0.5;
  rectifiedSize: Readonly<{ width: number; height: number }>;
  rotation: 0 | 90;
  width: number;
  height: 48;
  inputPngSha256: string;
  tensorSha256: string;
  text: string;
  /** Mean of the first timestep of each selected nonblank CTC label; not text probability. */
  mean: number;
}>;

export type MangaTextEvidence = Readonly<{
  candidateId: string;
  role: "text-presence-gate";
  ruleVersion: 1;
  modelId: typeof MANGA_OCR_MODELS.detector.modelId;
  revision: typeof MANGA_OCR_MODELS.detector.revision;
  component: "rec";
  recSha256: string;
  dictSha256: string;
  sourceQuadPx: ProductionOcrDetection["sourceQuadPx"];
  cropBboxPx: ProductionOcrPixelBbox;
  inputContextPngSha256: string;
  inputs: readonly [MangaTextEvidenceInput, MangaTextEvidenceInput];
  commonPrefixRatio: number;
  accepted: boolean;
  reason: "accepted" | "empty-decode" | "low-mean" | "unstable-prefix";
}>;

/** Two fixed, offline profiles. The service owns combination with the PP detector. */
export function createMangaOcrRuntime(
  binding: ProductionOcrRuntimeBinding,
  options: MangaOcrRuntimeOptions
): {
  probe(signal?: AbortSignal): Promise<void>;
  detector: ProductionOcrDetector;
  recognizer: ProductionOcrRecognizer;
  textVerifier: { verify(input: MangaTextVerifierInput): Promise<MangaTextEvidence> };
  close(): void;
} {
  const assetsRoot = resolve(options.assetsRoot);
  const sidecarBinding = {
    ...binding,
    sidecarEntrypoint: join(resolve(options.resourcesPath), "managed-ocr", "manga_ocr.py")
  };
  const detectorTransport = new ProductionOcrSidecarTransport(sidecarBinding);
  const recognizerTransport = new ProductionOcrSidecarTransport(sidecarBinding);
  const detectorConfiguration = {
    profile: "manga-detection",
    ...MANGA_OCR_MODELS.detector,
    modelPath: resolve(options.detectorModelPath),
    modelFile: MANGA_DETECTOR_FILE,
    textEvidence: {
      ruleVersion: 1,
      component: "rec",
      ...MANGA_OCR_MODELS.detector,
      modelRoot: join(assetsRoot, `manga-${MANGA_OCR_MODELS.detector.revision.slice(0, 8)}`),
      modelFile: MANGA_TEXT_EVIDENCE_REC_FILE,
      dictionaryFile: MANGA_TEXT_EVIDENCE_DICT_FILE
    }
  };
  const recognizerConfiguration = {
    profile: "hayai",
    ...MANGA_OCR_MODELS.recognizer,
    modelRoot: join(assetsRoot, `hayai-${MANGA_OCR_MODELS.recognizer.revision.slice(0, 8)}`),
    modelFiles: HAYAI_MODEL_FILES,
    wheelRoot: join(assetsRoot, "wheels", HAYAI_CPU_RUNTIME_MANIFEST.id),
    runtimeRoot: join(assetsRoot, "runtimes", HAYAI_CPU_RUNTIME_MANIFEST.id),
    runtimeFiles: HAYAI_CPU_RUNTIME_MANIFEST.files
  };
  let closed = false;

  function stopWorkers(): void {
    // close() stops the current child; the existing transport can restart on retry.
    try { detectorTransport.close(); } finally { recognizerTransport.close(); }
  }

  async function request(
    profile: "manga-detection" | "hayai",
    operation: "probe" | "detect" | "recognize" | "verify-text",
    signal?: AbortSignal,
    imageBytes?: Buffer,
    payload: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    if (closed) throw new Error("만화 OCR 런타임이 종료되었습니다.");
    const detecting = profile === "manga-detection";
    const expected = detecting ? MANGA_OCR_MODELS.detector : MANGA_OCR_MODELS.recognizer;
    try {
      signal?.throwIfAborted();
      const response = await (detecting ? detectorTransport : recognizerTransport).invoke({
        protocolVersion: 1,
        operation,
        ...payload,
        // Every request carries the same configuration. A replacement Python child
        // must verify/init/probe it before it can process that request's image.
        configuration: detecting ? detectorConfiguration : recognizerConfiguration,
        ...(imageBytes ? { imageBase64: imageBytes.toString("base64") } : {})
      }, signal);
      signal?.throwIfAborted();
      if (closed) throw new Error("만화 OCR 런타임이 종료되었습니다.");
      if (
        !isRecord(response)
        || response.protocolVersion !== 1
        || response.operation !== operation
        || response.profile !== profile
        || response.modelId !== expected.modelId
        || response.revision !== expected.revision
        || response.modelSha256 !== (detecting ? MANGA_DETECTOR_FILE.sha256 : HAYAI_MODEL_FILES[0].sha256)
        || response.device !== "cpu"
        || response.executionProvider !== (detecting ? "CPUExecutionProvider" : "torch-cpu")
        || (detecting && (response.ruleVersion !== 1
          || response.recSha256 !== MANGA_TEXT_EVIDENCE_REC_FILE.sha256
          || response.dictSha256 !== MANGA_TEXT_EVIDENCE_DICT_FILE.sha256))
      ) throw new Error("만화 OCR 실행기의 응답 또는 모델 identity가 유효하지 않습니다.");
      return response;
    } catch (error) {
      // Preparation/probe failures must not leave the other profile alive either.
      stopWorkers();
      throw error;
    }
  }

  return {
    async probe(signal) {
      await request("manga-detection", "probe", signal);
      await request("hayai", "probe", signal);
    },
    detector: {
      async detect(input) {
        const response = await request("manga-detection", "detect", input.signal, input.imageBytes);
        try {
          if (response.complete !== true || typeof response.imageWidth !== "number" || typeof response.imageHeight !== "number") {
            throw new Error("만화 OCR 검출 응답이 완전하지 않습니다.");
          }
          // Strict parser: malformed scores/coordinates/duplicate IDs fail the
          // request. Never silently drop untrusted output or invent geometry.
          const detections = parseProductionOcrDetections(response, response.imageWidth, response.imageHeight);
          return detections.map((detection) => ({
            ...detection,
            detectionId: `manga:${detection.detectionId}`,
            sourceModel: MANGA_OCR_MODELS.detector
          }));
        } catch (error) {
          stopWorkers();
          throw error;
        }
      }
    },
    textVerifier: {
      async verify(input) {
        try {
          input.signal?.throwIfAborted();
          validateTextInput(input);
          // Snapshot caller-owned bytes and geometry before the asynchronous IPC.
          const context = {
            candidateId: input.candidateId,
            sourceQuadPx: input.sourceQuadPx.map(point => ({ x: point.x, y: point.y })) as unknown as ProductionOcrDetection["sourceQuadPx"],
            cropBboxPx: { ...input.cropBboxPx }
          };
          const imageBytes = Buffer.from(input.imageBytes);
          const response = await request("manga-detection", "verify-text", input.signal, imageBytes, context);
          return parseTextEvidence(response, context, sha256(imageBytes));
        } catch (error) {
          stopWorkers();
          throw error;
        }
      }
    },
    recognizer: {
      async recognizeGroup(input) {
        const response = await request("hayai", "recognize", input.signal, input.cropBytes);
        if (response.complete !== true || typeof response.text !== "string" || response.text.length > 8192
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(response.text)) {
          stopWorkers();
          throw new Error("Hayai OCR 인식 결과가 완전하지 않거나 유효하지 않습니다.");
        }
        return { text: response.text };
      }
    },
    close() {
      closed = true;
      stopWorkers();
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_TEXT_PIXELS = 16_000_000;
const INVALID_TEXT = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function invalidTextEvidence(): never {
  throw new Error("만화 CTC text-evidence 입력 또는 응답이 유효하지 않습니다.");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateTextInput(input: MangaTextVerifierInput): void {
  if (typeof input.candidateId !== "string" || Array.from(input.candidateId).length < 1
    || Array.from(input.candidateId).length > 256 || INVALID_TEXT.test(input.candidateId)) invalidTextEvidence();
  const bbox = input.cropBboxPx;
  if (!isRecord(bbox) || Object.keys(bbox).sort().join() !== "height,width,x,y"
    || ![bbox.x, bbox.y, bbox.width, bbox.height].every(value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TEXT_PIXELS)
    || bbox.width < 1 || bbox.height < 1 || bbox.width * bbox.height > MAX_TEXT_PIXELS) invalidTextEvidence();
  const quad = input.sourceQuadPx;
  if (!Array.isArray(quad) || quad.length !== 4) invalidTextEvidence();
  for (const point of quad) {
    if (!isRecord(point) || Object.keys(point).sort().join() !== "x,y"
      || typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < bbox.x || point.y < bbox.y || point.x > bbox.x + bbox.width || point.y > bbox.y + bbox.height) invalidTextEvidence();
  }
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) invalidTextEvidence();
  }
  expectedInputSize(quad, 0.08);
  expectedInputSize(quad, 0.5);
  const bytes = input.imageBytes;
  // Full PNG decoding is owned by signed Pillow. Check the transport's PNG
  // header/dimensions here as well, before starting a process or sending bytes.
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > 16 * 1024 * 1024
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== bbox.width || bytes.readUInt32BE(20) !== bbox.height) invalidTextEvidence();
}

// Match Python round(), including ties to even, in the fixed upstream recipe.
function roundEven(value: number): number {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + floor % 2 : Math.round(value);
}

function expectedInputSize(quad: ProductionOcrDetection["sourceQuadPx"], padding: 0.08 | 0.5):
Pick<MangaTextEvidenceInput, "rectifiedSize" | "rotation" | "width" | "height"> {
  const edge = (a: number, b: number) => Math.hypot(quad[a].x - quad[b].x, quad[a].y - quad[b].y);
  const w = Math.max(1, roundEven(Math.max(edge(0, 1), edge(2, 3))));
  const h = Math.max(1, roundEven(Math.max(edge(0, 3), edge(1, 2))));
  const rectifiedSize = { width: roundEven(w + 0.16 * w), height: roundEven(h + 2 * padding * Math.min(w, h)) };
  if (rectifiedSize.width * rectifiedSize.height > MAX_TEXT_PIXELS) invalidTextEvidence();
  const rotation = rectifiedSize.height > rectifiedSize.width ? 90 : 0;
  const natural = roundEven(rotation ? 48 * rectifiedSize.height / rectifiedSize.width : 48 * rectifiedSize.width / rectifiedSize.height);
  return { rectifiedSize, rotation, width: Math.max(16, Math.min(natural > 2000 ? 2400 : 640, natural)), height: 48 };
}

function parseTextEvidence(
  response: Record<string, unknown>,
  context: Pick<MangaTextVerifierInput, "candidateId" | "sourceQuadPx" | "cropBboxPx">,
  contextSha256: string
): MangaTextEvidence {
  const bbox = response.cropBboxPx;
  const quad = response.sourceQuadPx;
  if (response.complete !== true || response.role !== "text-presence-gate" || response.component !== "rec"
    || response.candidateId !== context.candidateId || response.inputContextPngSha256 !== contextSha256
    || !isRecord(bbox) || Object.keys(bbox).sort().join() !== "height,width,x,y"
    || Object.entries(context.cropBboxPx).some(([key, value]) => bbox[key] !== value)
    || !Array.isArray(quad) || quad.length !== 4
    || quad.some((point, index) => !isRecord(point) || Object.keys(point).sort().join() !== "x,y"
      || point.x !== context.sourceQuadPx[index].x || point.y !== context.sourceQuadPx[index].y)
    || !Array.isArray(response.inputs) || response.inputs.length !== 2) invalidTextEvidence();

  function parseInput(value: unknown, padding: 0.08 | 0.5): MangaTextEvidenceInput {
    const expected = expectedInputSize(context.sourceQuadPx, padding);
    if (!isRecord(value) || value.padding !== padding || !isRecord(value.rectifiedSize)
      || value.rectifiedSize.width !== expected.rectifiedSize.width || value.rectifiedSize.height !== expected.rectifiedSize.height
      || value.rotation !== expected.rotation || value.width !== expected.width || value.height !== expected.height
      || typeof value.inputPngSha256 !== "string" || !SHA256.test(value.inputPngSha256)
      || typeof value.tensorSha256 !== "string" || !SHA256.test(value.tensorSha256)
      || typeof value.text !== "string" || Array.from(value.text).length > 8192 || INVALID_TEXT.test(value.text)
      || value.text !== value.text.normalize("NFKC").trim()
      || typeof value.mean !== "number" || !Number.isFinite(value.mean) || value.mean < 0 || value.mean > 1) invalidTextEvidence();
    return { padding, ...expected, inputPngSha256: value.inputPngSha256, tensorSha256: value.tensorSha256,
      text: value.text, mean: value.mean };
  }
  const inputs = [parseInput(response.inputs[0], 0.08), parseInput(response.inputs[1], 0.5)] as const;
  const texts = inputs.map(input => Array.from(input.text));
  const shortest = Math.min(texts[0].length, texts[1].length);
  let prefix = 0;
  while (prefix < shortest && texts[0][prefix] === texts[1][prefix]) prefix++;
  const commonPrefixRatio = shortest ? prefix / shortest : 0;
  const reason = shortest === 0 ? "empty-decode"
    : inputs.some(input => input.mean < 0.6) ? "low-mean"
      : commonPrefixRatio < 0.6 ? "unstable-prefix" : "accepted";
  const accepted = reason === "accepted";
  if (response.commonPrefixRatio !== commonPrefixRatio || response.accepted !== accepted || response.reason !== reason) invalidTextEvidence();
  return { ...context, role: "text-presence-gate", ruleVersion: 1, ...MANGA_OCR_MODELS.detector, component: "rec",
    recSha256: MANGA_TEXT_EVIDENCE_REC_FILE.sha256, dictSha256: MANGA_TEXT_EVIDENCE_DICT_FILE.sha256,
    inputContextPngSha256: contextSha256, inputs, commonPrefixRatio, accepted, reason };
}
