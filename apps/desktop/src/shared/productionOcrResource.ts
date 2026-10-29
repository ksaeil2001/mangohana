import { PRODUCTION_OCR_CONTRACT } from "./productionOcr.js";

export const PRODUCTION_OCR_RUNTIME = Object.freeze({
  pythonVersion: "3.10.10",
  packages: Object.freeze({
    paddlepaddle: "3.3.1",
    paddleocr: "3.7.0",
    onnxruntime: "1.23.2",
    numpy: "2.2.6",
    pillow: "12.1.0"
  })
} as const);

export type ProductionOcrRuntimeManifestV1 = Readonly<{
  schemaVersion: 1;
  contractVersion: 1;
  platform: "win32-x64";
  protocolVersion: 1;
  pythonVersion: typeof PRODUCTION_OCR_RUNTIME.pythonVersion;
  packages: typeof PRODUCTION_OCR_RUNTIME.packages;
  detector: Readonly<{
    modelId: typeof PRODUCTION_OCR_CONTRACT.detector.modelId;
    revision: typeof PRODUCTION_OCR_CONTRACT.detector.revision;
    device: "cpu";
  }>;
  recognizer: Readonly<{
    modelId: typeof PRODUCTION_OCR_CONTRACT.recognizer.modelId;
    revision: typeof PRODUCTION_OCR_CONTRACT.recognizer.revision;
    executionProvider: "CPUExecutionProvider";
  }>;
  pythonExecutable: "runtime/python.exe";
  sidecarEntrypoint: "sidecar/trio_ocr_sidecar.py";
}>;

export function parseProductionOcrRuntimeManifest(input: unknown): ProductionOcrRuntimeManifestV1 {
  if (!isRecord(input) || !hasExactKeys(input, [
    "schemaVersion",
    "contractVersion",
    "platform",
    "protocolVersion",
    "pythonVersion",
    "packages",
    "detector",
    "recognizer",
    "pythonExecutable",
    "sidecarEntrypoint"
  ])) throwInvalid();
  if (!isRecord(input.packages) || !hasExactKeys(input.packages, [
    "paddlepaddle", "paddleocr", "onnxruntime", "numpy", "pillow"
  ])) throwInvalid();
  if (!isRecord(input.detector) || !hasExactKeys(input.detector, ["modelId", "revision", "device"])) {
    throwInvalid();
  }
  if (!isRecord(input.recognizer) || !hasExactKeys(input.recognizer, [
    "modelId", "revision", "executionProvider"
  ])) throwInvalid();

  if (
    input.schemaVersion !== 1
    || input.contractVersion !== PRODUCTION_OCR_CONTRACT.contractVersion
    || input.platform !== PRODUCTION_OCR_CONTRACT.platform
    || input.protocolVersion !== 1
    || input.pythonVersion !== PRODUCTION_OCR_RUNTIME.pythonVersion
    || input.packages.paddlepaddle !== PRODUCTION_OCR_RUNTIME.packages.paddlepaddle
    || input.packages.paddleocr !== PRODUCTION_OCR_RUNTIME.packages.paddleocr
    || input.packages.onnxruntime !== PRODUCTION_OCR_RUNTIME.packages.onnxruntime
    || input.packages.numpy !== PRODUCTION_OCR_RUNTIME.packages.numpy
    || input.packages.pillow !== PRODUCTION_OCR_RUNTIME.packages.pillow
    || input.detector.modelId !== PRODUCTION_OCR_CONTRACT.detector.modelId
    || input.detector.revision !== PRODUCTION_OCR_CONTRACT.detector.revision
    || input.detector.device !== PRODUCTION_OCR_CONTRACT.detector.device
    || input.recognizer.modelId !== PRODUCTION_OCR_CONTRACT.recognizer.modelId
    || input.recognizer.revision !== PRODUCTION_OCR_CONTRACT.recognizer.revision
    || input.recognizer.executionProvider !== PRODUCTION_OCR_CONTRACT.recognizer.executionProvider
    || input.pythonExecutable !== "runtime/python.exe"
    || input.sidecarEntrypoint !== "sidecar/trio_ocr_sidecar.py"
  ) throwInvalid();

  return {
    schemaVersion: 1,
    contractVersion: 1,
    platform: "win32-x64",
    protocolVersion: 1,
    pythonVersion: PRODUCTION_OCR_RUNTIME.pythonVersion,
    packages: { ...PRODUCTION_OCR_RUNTIME.packages },
    detector: {
      modelId: PRODUCTION_OCR_CONTRACT.detector.modelId,
      revision: PRODUCTION_OCR_CONTRACT.detector.revision,
      device: "cpu"
    },
    recognizer: {
      modelId: PRODUCTION_OCR_CONTRACT.recognizer.modelId,
      revision: PRODUCTION_OCR_CONTRACT.recognizer.revision,
      executionProvider: "CPUExecutionProvider"
    },
    pythonExecutable: "runtime/python.exe",
    sidecarEntrypoint: "sidecar/trio_ocr_sidecar.py"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function throwInvalid(): never {
  throw new Error("Invalid Production OCR runtime manifest");
}
