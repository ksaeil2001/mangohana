import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT = Object.freeze({
  resourceId: "trio-production-ocr-win32-x64",
  role: "ocr_production",
  version: "1.0.0",
  pipelineVersion: "1.0.0",
  detector: Object.freeze({
    modelId: "PaddlePaddle/PP-OCRv6_medium_det",
    revision: "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
    files: Object.freeze([
      "detector/inference.json",
      "detector/inference.pdiparams",
      "detector/inference.yml"
    ])
  }),
  recognizer: Object.freeze({
    modelId: "genshiai-daichi/baberu-ocr",
    revision: "d9cc13153e9a1cd8fdfa3b7b1cc329da2020aeae",
    files: Object.freeze([
      "recognizer/onnx/vision_fp16.onnx",
      "recognizer/onnx/decoder_prefill_int8.onnx",
      "recognizer/onnx/decoder_step_int8.onnx",
      "recognizer/tokenizer/vocab.json"
    ])
  }),
  pythonVersion: "3.10.10",
  packages: Object.freeze({
    paddlepaddle: "3.3.1",
    paddleocr: "3.7.0",
    onnxruntime: "1.23.2",
    numpy: "2.2.6",
    pillow: "12.1.0"
  })
});

const metadataNames = new Set(["resource-manifest.json", "resource-manifest.p7s"]);

export async function buildProductionOcrResourceManifest(packRootInput) {
  const packRoot = resolve(packRootInput);
  await assertDirectory(packRoot);
  const runtime = await readJson(resolve(packRoot, "production-ocr-runtime.json"));
  assertRuntimeManifest(runtime);
  const sourceLock = await readJson(resolve(packRoot, "production-ocr-source-lock.json"));
  assertSourceLock(sourceLock);

  const filePaths = await walkPackFiles(packRoot);
  const entries = [];
  for (const relativePath of filePaths) {
    const bytes = await readFile(resolvePackPath(packRoot, relativePath));
    entries.push({
      relativePath,
      byteSize: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }
  const entriesByPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  for (const requiredPath of [
    "production-ocr-runtime.json",
    "production-ocr-source-lock.json",
    "runtime/python.exe",
    "sidecar/trio_ocr_sidecar.py",
    ...CONTRACT.detector.files,
    ...CONTRACT.recognizer.files,
    ...sourceLock.licenseFiles
  ]) {
    if (!entriesByPath.has(requiredPath)) throw new Error(`Production OCR pack is missing ${requiredPath}`);
  }
  for (const model of [sourceLock.detector, sourceLock.recognizer]) {
    for (const sourceFile of model.files) {
      const entry = entriesByPath.get(sourceFile.relativePath);
      if (
        !entry || entry.byteSize !== sourceFile.byteSize || entry.sha256 !== sourceFile.sha256 ||
        sourceFile.lfsOidSha256 !== sourceFile.sha256
      ) {
        throw new Error(`Production OCR upstream object mismatch: ${sourceFile.relativePath}`);
      }
    }
  }
  for (const distribution of sourceLock.runtimeDistributions) {
    for (const licenseFile of distribution.licenseFiles) {
      if (!entriesByPath.has(licenseFile)) {
        throw new Error(`Production OCR dependency license is missing: ${distribution.name}`);
      }
    }
  }

  const manifest = {
    schemaVersion: 1,
    resourceId: CONTRACT.resourceId,
    role: CONTRACT.role,
    version: CONTRACT.version,
    compatiblePipelineVersions: [CONTRACT.pipelineVersion],
    files: entries,
    licenseFiles: [...sourceLock.licenseFiles].sort()
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(packRoot, "resource-manifest.json"), manifestBytes);
  return { manifest, manifestSha256: sha256(manifestBytes) };
}

function assertRuntimeManifest(value) {
  if (!isRecord(value)) throw new Error("Production OCR runtime manifest is invalid");
  const expected = {
    schemaVersion: 1,
    contractVersion: 1,
    platform: "win32-x64",
    protocolVersion: 1,
    pythonVersion: CONTRACT.pythonVersion,
    packages: CONTRACT.packages,
    detector: {
      modelId: CONTRACT.detector.modelId,
      revision: CONTRACT.detector.revision,
      device: "cpu"
    },
    recognizer: {
      modelId: CONTRACT.recognizer.modelId,
      revision: CONTRACT.recognizer.revision,
      executionProvider: "CPUExecutionProvider"
    },
    pythonExecutable: "runtime/python.exe",
    sidecarEntrypoint: "sidecar/trio_ocr_sidecar.py"
  };
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("Production OCR runtime manifest does not match the frozen contract");
  }
}

function assertSourceLock(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.licenseFiles)) {
    throw new Error("Production OCR source lock is invalid");
  }
  assertLockedModel(value.detector, CONTRACT.detector);
  assertLockedModel(value.recognizer, CONTRACT.recognizer);
  if (!Array.isArray(value.runtimeDistributions) || value.runtimeDistributions.length === 0) {
    throw new Error("Production OCR runtime distribution lock is missing");
  }
  const distributions = new Map();
  for (const distribution of value.runtimeDistributions) {
    if (
      !isRecord(distribution) || typeof distribution.name !== "string" || !distribution.name ||
      typeof distribution.version !== "string" || !distribution.version ||
      !Array.isArray(distribution.licenseFiles) ||
      !distribution.licenseFiles.every(isSafeRelativePath) || distributions.has(distribution.name.toLowerCase())
    ) throw new Error("Production OCR runtime distribution lock is invalid");
    distributions.set(distribution.name.toLowerCase(), distribution);
  }
  for (const [name, version] of Object.entries(CONTRACT.packages)) {
    if (distributions.get(name)?.version !== version) {
      throw new Error(`Production OCR package version is not frozen: ${name}`);
    }
  }
  if (!value.licenseFiles.every(isSafeRelativePath) || new Set(value.licenseFiles).size !== value.licenseFiles.length) {
    throw new Error("Production OCR license file list is invalid");
  }
}

function assertLockedModel(value, expected) {
  if (
    !isRecord(value) || value.modelId !== expected.modelId || value.revision !== expected.revision ||
    !Array.isArray(value.files) || value.files.length !== expected.files.length
  ) throw new Error("Production OCR model source lock does not match the frozen contract");
  const byPath = new Map(value.files.map((entry) => [entry?.relativePath, entry]));
  for (const relativePath of expected.files) {
    const entry = byPath.get(relativePath);
    if (
      !isRecord(entry) || entry.relativePath !== relativePath ||
      typeof entry.byteSize !== "number" || !Number.isInteger(entry.byteSize) || entry.byteSize < 1 ||
      typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      typeof entry.lfsOidSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.lfsOidSha256)
    ) throw new Error(`Production OCR model object lock is invalid: ${relativePath}`);
  }
}

async function walkPackFiles(root, directory = root) {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const absolutePath = resolve(directory, name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error("Production OCR pack must not contain symbolic links");
    if (metadata.isDirectory()) {
      result.push(...await walkPackFiles(root, absolutePath));
      continue;
    }
    if (!metadata.isFile()) throw new Error("Production OCR pack contains an unsupported filesystem entry");
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (!metadataNames.has(relativePath)) result.push(relativePath);
  }
  return result.sort();
}

async function assertDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Production OCR pack root is invalid");
}

async function readJson(path) {
  return JSON.parse((await readFile(path)).toString("utf8"));
}

function resolvePackPath(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) throw new Error("Production OCR pack path is invalid");
  const path = resolve(root, ...relativePath.split("/"));
  if (relative(root, path).startsWith("..")) throw new Error("Production OCR pack path escapes its root");
  return path;
}

function isSafeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePackRoot(argv) {
  const index = argv.indexOf("--pack-root");
  if (index < 0 || !argv[index + 1]) throw new Error("Usage: --pack-root <absolute pack directory>");
  return argv[index + 1];
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const { manifestSha256 } = await buildProductionOcrResourceManifest(parsePackRoot(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ manifestSha256 })}\n`);
}
