import { describe, expect, it } from "vitest";
import { parseProductionOcrRuntimeManifest } from "../../src/shared/productionOcrResource.js";

const validManifest = {
  schemaVersion: 1,
  contractVersion: 1,
  platform: "win32-x64",
  protocolVersion: 1,
  pythonVersion: "3.10.10",
  packages: {
    paddlepaddle: "3.3.1",
    paddleocr: "3.7.0",
    onnxruntime: "1.23.2",
    numpy: "2.2.6",
    pillow: "12.1.0"
  },
  detector: {
    modelId: "PaddlePaddle/PP-OCRv6_medium_det",
    revision: "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
    device: "cpu"
  },
  recognizer: {
    modelId: "genshiai-daichi/baberu-ocr",
    revision: "d9cc13153e9a1cd8fdfa3b7b1cc329da2020aeae",
    executionProvider: "CPUExecutionProvider"
  },
  pythonExecutable: "runtime/python.exe",
  sidecarEntrypoint: "sidecar/trio_ocr_sidecar.py"
};

describe("Production OCR runtime manifest", () => {
  it("accepts only the frozen Windows CPU runtime contract", () => {
    expect(parseProductionOcrRuntimeManifest(validManifest)).toEqual(validManifest);
  });

  it.each([
    ["platform", "linux-x64"],
    ["pythonVersion", "3.11.0"],
    ["detector.device", "gpu"],
    ["recognizer.executionProvider", "CUDAExecutionProvider"],
    ["recognizer.modelId", "manga-ocr"]
  ])("rejects a runtime manifest that changes %s", (path, replacement) => {
    const changed = structuredClone(validManifest) as Record<string, unknown>;
    const [first, second] = path.split(".");
    if (second) {
      (changed[first] as Record<string, unknown>)[second] = replacement;
    } else {
      changed[first] = replacement;
    }
    expect(() => parseProductionOcrRuntimeManifest(changed)).toThrow("Invalid Production OCR runtime manifest");
  });
});
