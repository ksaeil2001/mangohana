import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT = Object.freeze({
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
  python: Object.freeze({
    version: "3.10.10",
    archiveFile: "python-3.10.10-embed-amd64.zip",
    sha256: "b8c99a1bce379287eae580e7ecd0d8f4afdce0a27268d7f26db205f3362d7bab",
    sourceUrl: "https://www.python.org/ftp/python/3.10.10/python-3.10.10-embed-amd64.zip"
  }),
  sourceAvailabilityArchives: Object.freeze([
    Object.freeze({
      name: "certifi",
      version: "2026.7.22",
      file: "certifi-2026.7.22.tar.gz",
      sha256: "741e2c3b351ddf169a738da9f2c048608ff7f2c5cc02f1ebc6b118bb090d5d55",
      sourceUrl: "https://files.pythonhosted.org/packages/a3/c2/24167ea9858356b47a87a50d39908bfdb72ceeefe0041586e704e5376b3a/certifi-2026.7.22.tar.gz"
    }),
    Object.freeze({
      name: "crc32c",
      version: "2.9.post0",
      file: "crc32c-2.9.post0.tar.gz",
      sha256: "6a089e0340de8438e836a09e613c6b541675d0f3aa92b3fe34295aaba62f014f",
      sourceUrl: "https://files.pythonhosted.org/packages/f6/07/b5fabe88654f5eded3e4b6d84cde572dd0280a7362a6a5b698bbd77be5df/crc32c-2.9.post0.tar.gz"
    }),
    Object.freeze({
      name: "python-bidi",
      version: "0.6.11",
      file: "python_bidi-0.6.11.tar.gz",
      sha256: "034090c597af250d699299d7e7f1e83eb016f9e47b3b707bd89ab2bdec77bce0",
      sourceUrl: "https://files.pythonhosted.org/packages/ce/e7/f168f2c3151aa05b9f9c9b2f7767bc8e06a133ea822c231ab497d4f36833/python_bidi-0.6.11.tar.gz"
    })
  ])
});

const fallbackLicenseFiles = new Map([
  ["bce-python-sdk", ["licenses/Apache-2.0-LICENSE.txt"]],
  ["flatbuffers", ["licenses/Apache-2.0-LICENSE.txt"]]
]);

export async function generateProductionOcrSourceLock({ packRootInput, wheelhouseInput, copyleftSourceInput }) {
  const packRoot = resolve(packRootInput);
  const wheelhouse = resolve(wheelhouseInput);
  const copyleftSource = resolve(copyleftSourceInput);
  await assertDirectory(packRoot, "Production OCR pack root is invalid");
  await assertDirectory(wheelhouse, "Production OCR wheelhouse is invalid");
  await assertDirectory(copyleftSource, "Production OCR source archive directory is invalid");

  const runtimeSitePackages = resolve(packRoot, "runtime", "Lib", "site-packages");
  await assertDirectory(runtimeSitePackages, "Production OCR runtime site-packages is missing");
  for (const license of [
    "licenses/PP-OCRv6_medium_det-LICENSE.txt",
    "licenses/baberu-ocr-LICENSE.txt",
    "licenses/Python-3.10.10-LICENSE.txt",
    "licenses/Apache-2.0-LICENSE.txt"
  ]) await assertFile(resolvePackPath(packRoot, license), `Production OCR license is missing: ${license}`);
  await assertNoPrivateKeyMaterial(packRoot);

  const sourceArchives = await copyAndVerifySourceAvailabilityArchives(packRoot, copyleftSource);
  const distributions = await collectRuntimeDistributions(packRoot, runtimeSitePackages, wheelhouse, sourceArchives);
  const modelSources = await collectModelSources(packRoot);
  const licenseFiles = new Set([
    "licenses/PP-OCRv6_medium_det-LICENSE.txt",
    "licenses/baberu-ocr-LICENSE.txt",
    "licenses/Python-3.10.10-LICENSE.txt",
    "licenses/Apache-2.0-LICENSE.txt",
    ...sourceArchives.map((source) => source.relativePath),
    ...distributions.flatMap((distribution) => distribution.licenseFiles)
  ]);
  const sortedLicenseFiles = [...licenseFiles].sort();
  const noticesPath = "licenses/THIRD_PARTY_NOTICES.txt";
  await writeFile(resolvePackPath(packRoot, noticesPath), renderNotices({ distributions, sourceArchives }), "utf8");
  sortedLicenseFiles.push(noticesPath);
  sortedLicenseFiles.sort();

  const sourceLock = {
    schemaVersion: 1,
    detector: modelSources.detector,
    recognizer: modelSources.recognizer,
    runtime: {
      platform: "win32-x64",
      python: {
        version: CONTRACT.python.version,
        archiveFile: CONTRACT.python.archiveFile,
        archiveSha256: CONTRACT.python.sha256,
        sourceUrl: CONTRACT.python.sourceUrl,
        configurationChanges: [
          "runtime/python310._pth adds Lib/site-packages and enables import site; no Python binary is modified."
        ]
      },
      sourceArchives
    },
    runtimeDistributions: distributions,
    licenseFiles: sortedLicenseFiles
  };
  await writeFile(
    resolvePackPath(packRoot, "production-ocr-source-lock.json"),
    `${JSON.stringify(sourceLock, null, 2)}\n`,
    "utf8"
  );
  return sourceLock;
}

async function collectModelSources(packRoot) {
  return {
    detector: await collectModelSource(packRoot, CONTRACT.detector),
    recognizer: await collectModelSource(packRoot, CONTRACT.recognizer)
  };
}

async function collectModelSource(packRoot, model) {
  const files = [];
  for (const relativePath of model.files) {
    const bytes = await readFile(resolvePackPath(packRoot, relativePath));
    const sha256 = hash(bytes);
    files.push({
      relativePath,
      byteSize: bytes.byteLength,
      sha256,
      lfsOidSha256: sha256,
      sourceUrl: `https://huggingface.co/${model.modelId}/resolve/${model.revision}/${relativePath.replace(/^(detector\/|recognizer\/onnx\/|recognizer\/tokenizer\/)/u, "")}`
    });
  }
  return { modelId: model.modelId, revision: model.revision, files };
}

async function copyAndVerifySourceAvailabilityArchives(packRoot, sourceRoot) {
  const sourceDestination = resolvePackPath(packRoot, "licenses/source");
  await mkdir(sourceDestination, { recursive: true });
  const result = [];
  for (const source of CONTRACT.sourceAvailabilityArchives) {
    const sourcePath = resolve(sourceRoot, source.file);
    await assertFile(sourcePath, `Production OCR source archive is missing: ${source.file}`);
    const bytes = await readFile(sourcePath);
    if (hash(bytes) !== source.sha256) throw new Error(`Production OCR source archive hash mismatch: ${source.file}`);
    const relativePath = `licenses/source/${source.file}`;
    await copyFile(sourcePath, resolvePackPath(packRoot, relativePath));
    result.push({ ...source, relativePath });
  }
  return result;
}

async function collectRuntimeDistributions(packRoot, sitePackages, wheelhouse, sourceArchives) {
  const wheels = await collectWheels(wheelhouse);
  const distributions = [];
  for (const name of await readdir(sitePackages)) {
    if (!name.endsWith(".dist-info")) continue;
    const distInfo = resolve(sitePackages, name);
    const metadata = parseMetadata(await readFile(resolve(distInfo, "METADATA"), "utf8"));
    const distributionName = requiredHeader(metadata, "Name", name);
    const version = requiredHeader(metadata, "Version", name);
    const canonicalName = canonicalize(distributionName);
    const wheel = wheels.get(`${canonicalName}@${version}`);
    if (!wheel) throw new Error(`Production OCR wheel is missing for ${distributionName}==${version}`);
    const licenseFiles = await collectDistributionLicenseFiles(packRoot, sitePackages, distInfo, canonicalName);
    if (licenseFiles.length === 0) throw new Error(`Production OCR license file is missing for ${distributionName}==${version}`);
    const license = declaredLicense(metadata, distributionName, version);
    const sourceArchive = sourceArchives.find((source) => canonicalize(source.name) === canonicalName && source.version === version);
    distributions.push({
      name: distributionName,
      version,
      license,
      licenseFiles,
      wheel,
      pypiReleaseMetadataUrl: `https://pypi.org/pypi/${distributionName}/${version}/json`,
      ...(sourceArchive ? { sourceArchive } : {})
    });
  }
  distributions.sort((left, right) => canonicalize(left.name).localeCompare(canonicalize(right.name)));
  if (distributions.length !== wheels.size) {
    const installed = new Set(distributions.map((distribution) => `${canonicalize(distribution.name)}@${distribution.version}`));
    const unused = [...wheels.keys()].filter((key) => !installed.has(key));
    if (unused.length) throw new Error(`Production OCR wheelhouse contains an uninstalled distribution: ${unused.join(", ")}`);
  }
  return distributions;
}

async function collectWheels(wheelhouse) {
  const entries = new Map();
  for (const name of (await readdir(wheelhouse)).sort()) {
    if (!name.endsWith(".whl")) continue;
    const [rawName, version] = basename(name, ".whl").split("-");
    if (!rawName || !version) throw new Error(`Production OCR wheel filename is invalid: ${name}`);
    const bytes = await readFile(resolve(wheelhouse, name));
    const key = `${canonicalize(rawName)}@${version}`;
    if (entries.has(key)) throw new Error(`Production OCR wheelhouse has duplicate distribution: ${key}`);
    entries.set(key, { file: name, byteSize: bytes.byteLength, sha256: hash(bytes) });
  }
  if (entries.size === 0) throw new Error("Production OCR wheelhouse is empty");
  return entries;
}

async function collectDistributionLicenseFiles(packRoot, sitePackages, distInfo, canonicalName) {
  const licenseFiles = new Set();
  for (const path of await walkFiles(distInfo)) {
    const relativePath = relative(packRoot, path).split(sep).join("/");
    const segments = relativePath.split("/");
    if (segments.some((segment) => /^(licen[cs]e|copying|notice)/iu.test(segment)) || /thirdpartynotices\.txt$/iu.test(relativePath)) {
      licenseFiles.add(relativePath);
    }
  }
  if (canonicalName === "onnxruntime") {
    for (const name of ["LICENSE", "ThirdPartyNotices.txt"]) {
      const path = resolve(sitePackages, "onnxruntime", name);
      await assertFile(path, `Production OCR onnxruntime notice is missing: ${name}`);
      licenseFiles.add(relative(packRoot, path).split(sep).join("/"));
    }
  }
  for (const path of fallbackLicenseFiles.get(canonicalName) ?? []) licenseFiles.add(path);
  return [...licenseFiles].sort();
}

function renderNotices({ distributions, sourceArchives }) {
  const lines = [
    "TRIO Production OCR third-party notices",
    "",
    "This pack is a Windows x64 offline OCR runtime. Exact component versions, package-wheel hashes, model revisions, and every listed license file are integrity-bound in production-ocr-source-lock.json and resource-manifest.json.",
    "",
    "Runtime modification: runtime/python310._pth only adds Lib/site-packages and enables import site. No upstream Python binary or model weight is modified.",
    "",
    "Source-availability archives included in this pack:"
  ];
  for (const source of sourceArchives) {
    lines.push(`- ${source.name} ${source.version}: ${source.relativePath}; SHA-256 ${source.sha256}; ${source.sourceUrl}`);
  }
  lines.push("", "Python distributions:");
  for (const distribution of distributions) {
    lines.push(`- ${distribution.name} ${distribution.version}; declared license: ${distribution.license}; PyPI metadata: ${distribution.pypiReleaseMetadataUrl}`);
    lines.push(`  license files: ${distribution.licenseFiles.join(", ")}`);
    lines.push(`  wheel: ${distribution.wheel.file}; SHA-256 ${distribution.wheel.sha256}`);
  }
  lines.push("", "Model and runtime notices:");
  lines.push("- PP-OCRv6_medium_det: Apache-2.0; licenses/PP-OCRv6_medium_det-LICENSE.txt");
  lines.push("- Baberu OCR: Apache-2.0; licenses/baberu-ocr-LICENSE.txt");
  lines.push("- Python 3.10.10 embedded runtime: PSF-2.0; licenses/Python-3.10.10-LICENSE.txt");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function walkFiles(directory) {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("Production OCR runtime must not contain symbolic links");
    if (metadata.isDirectory()) {
      result.push(...await walkFiles(path));
    } else if (metadata.isFile()) {
      result.push(path);
    } else {
      throw new Error("Production OCR runtime contains an unsupported filesystem entry");
    }
  }
  return result;
}

async function assertNoPrivateKeyMaterial(packRoot) {
  for (const path of await walkFiles(packRoot)) {
    if (!/\.(pem|key|pfx)$/iu.test(path)) continue;
    if (path.toLowerCase().endsWith(".pfx")) {
      throw new Error(`Production OCR pack must not contain a PFX file: ${relative(packRoot, path)}`);
    }
    const contents = await readFile(path);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(contents.toString("ascii"))) {
      throw new Error(`Production OCR pack must not contain private key material: ${relative(packRoot, path)}`);
    }
  }
}

function parseMetadata(contents) {
  const headers = new Map();
  let lastName;
  for (const line of contents.replace(/\r\n/gu, "\n").split("\n")) {
    if (/^[ \t]/u.test(line) && lastName) {
      headers.set(lastName, `${headers.get(lastName).at(-1)} ${line.trim()}`);
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      lastName = undefined;
      continue;
    }
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    headers.set(name, [...(headers.get(name) ?? []), value]);
    lastName = name;
  }
  return headers;
}

function requiredHeader(headers, name, source) {
  const value = headers.get(name)?.at(0);
  if (!value) throw new Error(`Production OCR package metadata omits ${name}: ${source}`);
  return value;
}

function declaredLicense(headers, name, version) {
  const expression = headers.get("License-Expression")?.at(0);
  if (expression) return expression;
  const classifier = headers.get("Classifier")?.find((value) => value.startsWith("License ::"));
  if (classifier) return classifier.slice("License ::".length).trim();
  const license = headers.get("License")?.at(0);
  if (license && license !== "UNKNOWN") return license;
  throw new Error(`Production OCR package license is unclear: ${name}==${version}`);
}

async function assertDirectory(path, message) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(message);
}

async function assertFile(path, message) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(message);
}

function resolvePackPath(packRoot, relativePath) {
  const path = resolve(packRoot, ...relativePath.split("/"));
  if (relative(packRoot, path).startsWith("..")) throw new Error("Production OCR pack path escapes its root");
  return path;
}

function canonicalize(value) {
  return value.toLowerCase().replace(/[-_.]+/gu, "-");
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCli(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("Usage: --pack-root <path> --wheelhouse <path> --copyleft-source <path>");
    options.set(name, value);
  }
  return {
    packRootInput: requiredOption(options, "--pack-root"),
    wheelhouseInput: requiredOption(options, "--wheelhouse"),
    copyleftSourceInput: requiredOption(options, "--copyleft-source")
  };
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const sourceLock = await generateProductionOcrSourceLock(parseCli(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ runtimeDistributionCount: sourceLock.runtimeDistributions.length })}\n`);
}
