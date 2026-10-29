import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProductionOcrResourceManifest } from "../../scripts/build-production-ocr-resource-manifest.mjs";

const roots = [];
const detectorFiles = [
  "detector/inference.json",
  "detector/inference.pdiparams",
  "detector/inference.yml"
];
const recognizerFiles = [
  "recognizer/onnx/vision_fp16.onnx",
  "recognizer/onnx/decoder_prefill_int8.onnx",
  "recognizer/onnx/decoder_step_int8.onnx",
  "recognizer/tokenizer/vocab.json"
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Production OCR resource manifest builder", () => {
  it("hashes every staged runtime file after verifying frozen revisions and LFS object hashes", async () => {
    const root = await createPackFixture();
    const result = await buildProductionOcrResourceManifest(root);
    const manifestBytes = await readFile(join(root, "resource-manifest.json"));

    expect(result.manifest).toMatchObject({
      resourceId: "trio-production-ocr-win32-x64",
      role: "ocr_production",
      version: "1.0.0",
      compatiblePipelineVersions: ["1.0.0"]
    });
    expect(result.manifest.files.map((file) => file.relativePath)).toEqual(
      [...result.manifest.files.map((file) => file.relativePath)].sort()
    );
    expect(result.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "runtime/python.exe", byteSize: 6 }),
      expect.objectContaining({ relativePath: "recognizer/onnx/vision_fp16.onnx" }),
      expect.objectContaining({ relativePath: "licenses/THIRD_PARTY_NOTICES.txt" })
    ]));
    expect(result.manifestSha256).toBe(sha256(manifestBytes));
  });

  it("fails closed when a staged model no longer matches the upstream LFS object lock", async () => {
    const root = await createPackFixture();
    await writeFile(join(root, "recognizer", "onnx", "vision_fp16.onnx"), "tampered");
    await expect(buildProductionOcrResourceManifest(root)).rejects.toThrow("upstream object mismatch");
  });
});

async function createPackFixture() {
  const root = await mkdtemp(join(tmpdir(), "trio-production-ocr-manifest-"));
  roots.push(root);
  const fileContents = new Map([
    ["runtime/python.exe", "python"],
    ["sidecar/trio_ocr_sidecar.py", "print('sidecar')"],
    ["licenses/PP-OCRv6_medium_det-LICENSE.txt", "Apache-2.0 detector"],
    ["licenses/baberu-ocr-LICENSE.txt", "Apache-2.0 recognizer"],
    ["licenses/python-LICENSE.txt", "Python license"],
    ["licenses/THIRD_PARTY_NOTICES.txt", "All installed distribution notices"],
    ...detectorFiles.map((path) => [path, `detector:${path}`]),
    ...recognizerFiles.map((path) => [path, `recognizer:${path}`])
  ]);
  for (const [relativePath, contents] of fileContents) await write(root, relativePath, contents);

  await write(root, "production-ocr-runtime.json", JSON.stringify({
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
  }));

  const lockedFiles = async (paths) => await Promise.all(paths.map(async (relativePath) => {
    const bytes = await readFile(join(root, ...relativePath.split("/")));
    const digest = sha256(bytes);
    return { relativePath, byteSize: bytes.byteLength, sha256: digest, lfsOidSha256: digest };
  }));
  const licenseFiles = [
    "licenses/PP-OCRv6_medium_det-LICENSE.txt",
    "licenses/baberu-ocr-LICENSE.txt",
    "licenses/python-LICENSE.txt",
    "licenses/THIRD_PARTY_NOTICES.txt"
  ];
  await write(root, "production-ocr-source-lock.json", JSON.stringify({
    schemaVersion: 1,
    detector: {
      modelId: "PaddlePaddle/PP-OCRv6_medium_det",
      revision: "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
      files: await lockedFiles(detectorFiles)
    },
    recognizer: {
      modelId: "genshiai-daichi/baberu-ocr",
      revision: "d9cc13153e9a1cd8fdfa3b7b1cc329da2020aeae",
      files: await lockedFiles(recognizerFiles)
    },
    runtimeDistributions: [
      { name: "paddlepaddle", version: "3.3.1", licenseFiles: [licenseFiles[3]] },
      { name: "paddleocr", version: "3.7.0", licenseFiles: [licenseFiles[3]] },
      { name: "onnxruntime", version: "1.23.2", licenseFiles: [licenseFiles[3]] },
      { name: "numpy", version: "2.2.6", licenseFiles: [licenseFiles[3]] },
      { name: "pillow", version: "12.1.0", licenseFiles: [licenseFiles[3]] }
    ],
    licenseFiles
  }));
  return root;
}

async function write(root, relativePath, contents) {
  const absolutePath = join(root, ...relativePath.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
