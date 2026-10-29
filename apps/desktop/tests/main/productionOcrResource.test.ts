import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeProductionOcrResource } from "../../src/main/ocr/runtime/productionOcrResource.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Production OCR resource probe", () => {
  it("returns only an exact frozen Windows CPU runtime binding", async () => {
    const root = await createPack();

    await expect(probeProductionOcrResource({
      role: "ocr_production",
      resourceId: "trio-production-ocr-win32-x64",
      version: "1.0.0",
      distribution: "download",
      absolutePath: root
    })).resolves.toEqual({
      packRoot: root,
      pythonExecutable: join(root, "runtime", "python.exe"),
      sidecarEntrypoint: join(root, "sidecar", "trio_ocr_sidecar.py")
    });
  });

  it("rejects a pack whose manifest tries to select a GPU provider", async () => {
    const root = await createPack({ executionProvider: "CUDAExecutionProvider" });
    await expect(probeProductionOcrResource(binding(root))).rejects.toThrow("Production OCR resource is incompatible");
  });

  it("rejects a pack missing any frozen model artifact", async () => {
    const root = await createPack();
    await rm(join(root, "recognizer", "onnx", "decoder_step_int8.onnx"));
    await expect(probeProductionOcrResource(binding(root))).rejects.toThrow("Production OCR resource is incomplete");
  });
});

function binding(root: string) {
  return {
    role: "ocr_production" as const,
    resourceId: "trio-production-ocr-win32-x64",
    version: "1.0.0",
    distribution: "download" as const,
    absolutePath: root
  };
}

async function createPack(overrides: { executionProvider?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".production-ocr-pack-"));
  temporaryRoots.push(root);
  const paths = [
    "runtime/python.exe",
    "sidecar/trio_ocr_sidecar.py",
    "detector/inference.json",
    "detector/inference.pdiparams",
    "detector/inference.yml",
    "recognizer/onnx/vision_fp16.onnx",
    "recognizer/onnx/decoder_prefill_int8.onnx",
    "recognizer/onnx/decoder_step_int8.onnx",
    "recognizer/tokenizer/vocab.json"
  ];
  for (const relativePath of paths) {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "fixture");
  }
  await writeFile(join(root, "production-ocr-runtime.json"), JSON.stringify({
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
      executionProvider: overrides.executionProvider ?? "CPUExecutionProvider"
    },
    pythonExecutable: "runtime/python.exe",
    sidecarEntrypoint: "sidecar/trio_ocr_sidecar.py"
  }));
  return root;
}
