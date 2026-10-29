import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  lstat,
  readdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const RELEASE_EVIDENCE_SCHEMA_VERSION = "trio.release-evidence.v1";
export const STABLE_EVIDENCE_VERSION = "0.1.4";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const VERIFICATION_FIELDS = {
  windows: [
    "expectedPublisherMatched",
    "authenticodeChainValid",
    "digestAlgorithm",
    "timestampValid",
    "appExecutableVerified",
    "nsisInstallerVerified"
  ],
  linux: ["updaterDisabled"],
  pretendard: [
    "cmsValid",
    "hashValid",
    "publisherAllowed",
    "identityMatched",
    "glyphCoverageValid"
  ]
};

const VERIFICATION_BOOLEAN_FIELDS = new Set(
  Object.values(VERIFICATION_FIELDS)
    .flat()
    .filter((field) => field !== "digestAlgorithm")
);

const IGNORED_UPDATER_KEYS = new Set([
  "releaseDate",
  "stagingPercentage",
  "minimumSystemVersion",
  "electronVersion"
]);

const SUPPORTED_UPDATER_KEYS = new Set([
  "version",
  "files",
  "url",
  "path",
  "sha512",
  "size",
  "blockmap",
  "blockMap",
  "blockmapUrl",
  "blockMapUrl",
  "blockMapSize",
  ...IGNORED_UPDATER_KEYS
]);

const UPDATER_KEY_ALIASES = new Map([
  ["version", "version"],
  ["files", "files"],
  ["url", "url"],
  ["path", "path"],
  ["sha512", "sha512"],
  ["size", "size"],
  ["blockmap", "blockmap"],
  ["blockmapurl", "blockmapUrl"],
  ["blockmapsize", "blockMapSize"],
  ["releasedate", "releaseDate"],
  ["stagingpercentage", "stagingPercentage"],
  ["minimumsystemversion", "minimumSystemVersion"],
  ["electronversion", "electronVersion"]
]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureRecord(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function ensureStableVersion(version) {
  if (typeof version !== "string" || !STABLE_VERSION_PATTERN.test(version)) {
    fail(`Package version must be a stable semantic version without a leading v: ${String(version)}.`);
  }
  return version;
}

function ensureSourceSha(sourceSha) {
  if (typeof sourceSha !== "string" || !SOURCE_SHA_PATTERN.test(sourceSha)) {
    fail("Source SHA must be exactly 40 hexadecimal characters.");
  }
  return sourceSha.toLowerCase();
}

function ensureSafeFilename(name, label = "asset filename") {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name !== basename(name) ||
    name === "." ||
    name === ".." ||
    name.includes("\\") ||
    name.includes("/") ||
    name.includes("\0") ||
    name.includes("..") ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    fail(`Unsafe ${label}: ${String(name)}.`);
  }
  return name;
}

function ensureUpdaterReference(name, label = "updater reference") {
  ensureSafeFilename(name, label);
  if (
    name.includes("://") ||
    name.startsWith("/") ||
    name.startsWith("~") ||
    name.includes("%")
  ) {
    fail(`Remote or traversal ${label} is not allowed: ${name}.`);
  }
  return name;
}

export function buildStablePublicAssetPolicy(packageVersion) {
  const version = ensureStableVersion(packageVersion);

  return {
    windows: {
      installer: `Trio-Setup-${version}.exe`,
      blockmap: `Trio-Setup-${version}.exe.blockmap`,
      metadata: "latest.yml"
    },
    linux: {
      appImage: `Trio-${version}.AppImage`
    },
    ancillary: {
      checksums: "SHA256SUMS",
      sbom: `trio-${version}.cdx.json`,
      notices: "THIRD_PARTY_NOTICES.md",
      releaseNotes: "RELEASE_NOTES.md"
    },
    evidence: {
      file: "release-evidence.json",
      digest: "release-evidence.sha256"
    }
  };
}

function sortedObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortedObject);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortedObject(value[key])])
  );
}

export function canonicalJsonStringify(value) {
  return `${JSON.stringify(sortedObject(value))}\n`;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512Base64Bytes(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

async function readAssetBytes(assetsDir, name) {
  return readFile(join(assetsDir, ensureSafeFilename(name)));
}

async function listFlatAssets(assetsDir) {
  const directory = resolve(assetsDir);
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("Assets directory must be a real directory, not a symlink.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const assets = [];

  for (const entry of entries) {
    const name = entry.name;
    ensureSafeFilename(name);
    if (entry.isSymbolicLink()) {
      fail(`Symlink assets are not allowed: ${name}.`);
    }
    if (!entry.isFile()) {
      fail(`Nested directories or non-file assets are not allowed: ${name}.`);
    }
    const file = await lstat(join(directory, name));
    if (!file.isFile() || file.isSymbolicLink()) {
      fail(`Asset is not a regular file: ${name}.`);
    }
    assets.push({ name, path: join(directory, name), size: file.size });
  }

  return { directory, assets };
}

function expectedAssetNames(policy) {
  return new Set([
    policy.windows.installer,
    policy.windows.blockmap,
    policy.windows.metadata,
    policy.linux.appImage,
    policy.ancillary.checksums,
    policy.ancillary.sbom,
    policy.ancillary.notices,
    policy.ancillary.releaseNotes,
    policy.evidence.file,
    policy.evidence.digest
  ]);
}

function validateAssetNames(names, policy, { allowGenerated }) {
  const expected = expectedAssetNames(policy);
  const actual = new Set(names);
  for (const name of names) {
    ensureSafeFilename(name);
    if (!expected.has(name)) {
      fail(`Unexpected asset outside the exact public allowlist for this package version: ${name}.`);
    }
  }

  const generated = new Set([
    policy.ancillary.checksums,
    policy.evidence.file,
    policy.evidence.digest
  ]);
  const required = [...expected].filter((name) => !generated.has(name));
  for (const name of required) {
    if (!actual.has(name)) {
      fail(`Missing required stable release asset: ${name}.`);
    }
  }

  const generatedPresent = [...generated].filter((name) => actual.has(name));
  if (allowGenerated) {
    if (actual.has(policy.evidence.file) !== actual.has(policy.evidence.digest)) {
      fail("Evidence JSON and evidence digest must be created together.");
    }
  } else {
    for (const name of generated) {
      if (!actual.has(name)) {
        fail(`Missing generated evidence asset: ${name}.`);
      }
    }
  }

  return { expected, generatedPresent };
}

function parseYamlScalar(raw, lineNumber) {
  const value = raw.trim();
  if (value === "" || value === "null" || value === "~") {
    return null;
  }
  if (value === "|" || value === ">" || value.startsWith("|") || value.startsWith(">")) {
    fail(`Multiline updater YAML values are not allowed at line ${lineNumber}.`);
  }
  if (value.startsWith("{") || value.startsWith("[") || value.startsWith("&") || value.startsWith("*")) {
    fail(`Ambiguous updater YAML scalar at line ${lineNumber}.`);
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      fail(`Malformed quoted updater YAML scalar at line ${lineNumber}.`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      fail(`Malformed quoted updater YAML scalar at line ${lineNumber}.`);
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value.replace(/\s+#.*$/u, "").trim();
}

function canonicalUpdaterKey(key) {
  return UPDATER_KEY_ALIASES.get(key.toLowerCase());
}

function addUniqueField(target, key, value, lineNumber, seenFields) {
  const semanticKey = canonicalUpdaterKey(key) ?? key.toLowerCase();
  if (seenFields.has(semanticKey)) {
    fail(`Duplicate updater YAML field ${key} at line ${lineNumber}.`);
  }
  seenFields.add(semanticKey);
  target[semanticKey] = value;
  return semanticKey;
}

export function parseUpdaterYaml(source, metadataName = "updater metadata") {
  if (typeof source !== "string" || source.includes("\0")) {
    fail(`${metadataName} is not valid text.`);
  }

  const version = { value: undefined };
  const root = {};
  const rootFields = new Set();
  const records = [];
  const metadataReferences = [];
  let sawFiles = false;
  let currentRecord;
  let currentRecordFields;

  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (line.includes("\t")) {
      fail(`Tabs are not allowed in updater YAML at line ${lineNumber}.`);
    }

    const listMatch = /^(\s*)-\s*(.*)$/u.exec(line);
    if (listMatch) {
      const body = listMatch[2];
      if (body === "") {
        currentRecord = {};
        currentRecordFields = new Set();
        records.push(currentRecord);
        continue;
      }
      const inlineMatch = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(body);
      if (!inlineMatch || canonicalUpdaterKey(inlineMatch[1]) !== "url") {
        fail(`Only file-list URL entries are supported at line ${lineNumber}.`);
      }
      currentRecord = {};
      currentRecordFields = new Set();
      records.push(currentRecord);
      addUniqueField(
        currentRecord,
        inlineMatch[1],
        parseYamlScalar(inlineMatch[2] ?? "", lineNumber),
        lineNumber,
        currentRecordFields
      );
      continue;
    }

    const fieldMatch = /^(\s*)([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
    if (!fieldMatch) {
      fail(`Unsupported or malformed updater YAML at line ${lineNumber}.`);
    }
    const indent = fieldMatch[1].length;
    const originalKey = fieldMatch[2];
    const key = canonicalUpdaterKey(originalKey);
    const rawValue = fieldMatch[3] ?? "";
    if (!key || !SUPPORTED_UPDATER_KEYS.has(key)) {
      fail(`Unsupported updater YAML field ${originalKey} at line ${lineNumber}.`);
    }
    if (key === "files") {
      if (indent > 0) {
        fail(`Updater YAML files field must be at the root at line ${lineNumber}.`);
      }
      addUniqueField(root, key, null, lineNumber, rootFields);
      sawFiles = true;
      continue;
    }

    const value = parseYamlScalar(rawValue, lineNumber);
    const inFileRecord = currentRecord && indent > 0;
    if (key === "version") {
      if (inFileRecord) {
        fail(`Updater YAML version must be at the root at line ${lineNumber}.`);
      }
      addUniqueField(root, key, value, lineNumber, rootFields);
      version.value = value;
    } else if (key === "url") {
      if (!inFileRecord) {
        fail(`Updater YAML URL must be inside a file entry at line ${lineNumber}.`);
      }
      addUniqueField(currentRecord, key, value, lineNumber, currentRecordFields);
    } else if (key === "sha512" || key === "size") {
      if (inFileRecord) {
        addUniqueField(currentRecord, key, value, lineNumber, currentRecordFields);
      } else {
        addUniqueField(root, key, value, lineNumber, rootFields);
      }
    } else if (key === "path") {
      if (inFileRecord) {
        fail(`Updater YAML path must be at the root at line ${lineNumber}.`);
      }
      addUniqueField(root, key, value, lineNumber, rootFields);
    } else if (key === "blockmap" || key === "blockmapUrl") {
      if (inFileRecord) {
        addUniqueField(currentRecord, key, value, lineNumber, currentRecordFields);
      } else {
        const semanticKey = addUniqueField(root, key, value, lineNumber, rootFields);
        metadataReferences.push({ field: semanticKey, value });
      }
    } else if (IGNORED_UPDATER_KEYS.has(key) || key === "blockMapSize") {
      if (inFileRecord) {
        addUniqueField(currentRecord, key, value, lineNumber, currentRecordFields);
      } else {
        addUniqueField(root, key, value, lineNumber, rootFields);
      }
    }
  }

  if (!sawFiles || records.length === 0) {
    fail(`${metadataName} must contain a non-empty files list.`);
  }
  if (typeof version.value !== "string" || version.value.length === 0) {
    fail(`${metadataName} must contain a scalar version.`);
  }

  const fileUrls = new Set();
  for (const record of records) {
    if (typeof record.url !== "string") {
      fail(`${metadataName} contains a file entry without a URL.`);
    }
    ensureUpdaterReference(record.url, `${metadataName} file reference`);
    if (fileUrls.has(record.url)) {
      fail(`${metadataName} contains a duplicate file reference: ${record.url}.`);
    }
    fileUrls.add(record.url);
    for (const key of ["blockmap", "blockmapUrl"]) {
      if (Object.hasOwn(record, key)) {
        ensureUpdaterReference(record[key], `${metadataName} ${key} reference`);
      }
    }
    if (Object.hasOwn(record, "size")) {
      if (!/^\d+$/u.test(String(record.size))) {
        fail(`${metadataName} has a non-integer size for ${record.url}.`);
      }
      record.size = Number(record.size);
    }
    if (Object.hasOwn(record, "sha512")) {
      if (typeof record.sha512 !== "string" || !SHA512_BASE64_PATTERN.test(record.sha512)) {
        fail(`${metadataName} has an invalid SHA-512 for ${record.url}.`);
      }
      const decoded = Buffer.from(record.sha512, "base64");
      if (decoded.length !== 64) {
        fail(`${metadataName} SHA-512 must decode to 64 bytes for ${record.url}.`);
      }
    }
  }

  const references = [];
  for (const record of records) {
    references.push({
      filename: record.url,
      size: Object.hasOwn(record, "size") ? record.size : null,
      sha512: Object.hasOwn(record, "sha512") ? record.sha512 : null,
      source: "files"
    });
    for (const key of ["blockmap", "blockmapUrl"]) {
      if (Object.hasOwn(record, key)) {
        references.push({
          filename: record[key],
          size: null,
          sha512: null,
          source: key
        });
      }
    }
  }
  if (typeof root.path === "string") {
    ensureUpdaterReference(root.path, `${metadataName} path reference`);
    references.push({
      filename: root.path,
      size: Object.hasOwn(root, "size") ? Number(root.size) : null,
      sha512: Object.hasOwn(root, "sha512") ? root.sha512 : null,
      source: "root"
    });
  }
  for (const reference of metadataReferences) {
    if (typeof reference.value !== "string") {
      fail(`${metadataName} has an empty blockmap reference.`);
    }
    ensureUpdaterReference(reference.value, `${metadataName} ${reference.field} reference`);
    references.push({
      filename: reference.value,
      size: null,
      sha512: null,
      source: reference.field
    });
  }

  return {
    metadataName,
    version: version.value,
    root,
    records,
    references
  };
}

function mergeUpdaterReferences(parsed) {
  const merged = new Map();
  for (const reference of parsed.references) {
    const existing = merged.get(reference.filename);
    if (!existing) {
      merged.set(reference.filename, { ...reference });
      continue;
    }
    if (reference.size !== null) {
      if (existing.size !== null && existing.size !== reference.size) {
        fail(`Ambiguous size metadata for ${reference.filename} in ${parsed.metadataName}.`);
      }
      existing.size = reference.size;
    }
    if (reference.sha512 !== null) {
      if (existing.sha512 !== null && existing.sha512 !== reference.sha512) {
        fail(`Ambiguous SHA-512 metadata for ${reference.filename} in ${parsed.metadataName}.`);
      }
      existing.sha512 = reference.sha512;
    }
  }
  return [...merged.values()];
}

async function validateMetadataFile({ assetsDir, policy, metadataName, packageVersion, assetNames }) {
  const bytes = await readAssetBytes(assetsDir, metadataName);
  const parsed = parseUpdaterYaml(bytes.toString("utf8"), metadataName);
  if (parsed.version !== packageVersion) {
    fail(`${metadataName} version does not match package version ${packageVersion}.`);
  }

  const references = mergeUpdaterReferences(parsed);
  const allowedReferences = new Set([policy.windows.installer, policy.windows.blockmap]);
  for (const reference of references) {
    if (!allowedReferences.has(reference.filename)) {
      fail(`${metadataName} references an unexpected or unsupported file: ${reference.filename}.`);
    }
    if (!assetNames.has(reference.filename)) {
      fail(`${metadataName} references missing asset: ${reference.filename}.`);
    }
    const actual = await readAssetBytes(assetsDir, reference.filename);
    const actualSize = actual.byteLength;
    const actualSha512 = sha512Base64Bytes(actual);
    if (reference.size !== null && reference.size !== actualSize) {
      fail(`${metadataName} size mismatch for ${reference.filename}.`);
    }
    if (reference.sha512 !== null && reference.sha512 !== actualSha512) {
      fail(`${metadataName} SHA-512 mismatch for ${reference.filename}.`);
    }
    reference.actualSize = actualSize;
    reference.actualSha512 = actualSha512;
  }

  const required = [policy.windows.installer];
  for (const filename of required) {
    const reference = references.find((candidate) => candidate.filename === filename);
    if (!reference) {
      fail(`${metadataName} does not reference required asset ${filename}.`);
    }
    if (reference.size === null || reference.sha512 === null) {
      fail(`${metadataName} metadata must declare size and SHA-512 for ${filename}.`);
    }
  }

  return references
    .map((reference) => ({
      metadata: metadataName,
      filename: reference.filename,
      metadataDeclaredSize: reference.size,
      metadataDeclaredSha512: reference.sha512,
      size: reference.actualSize,
      sha512: reference.actualSha512
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename));
}

async function validateAncillaryFiles({ assetsDir, policy }) {
  const sbomBytes = await readAssetBytes(assetsDir, policy.ancillary.sbom);
  let sbom;
  try {
    sbom = JSON.parse(sbomBytes.toString("utf8"));
  } catch {
    fail("CycloneDX SBOM is not valid JSON.");
  }
  if (!isRecord(sbom) || sbom.bomFormat !== "CycloneDX" || typeof sbom.specVersion !== "string") {
    fail("SBOM must be a CycloneDX JSON document.");
  }
  for (const name of [policy.ancillary.notices, policy.ancillary.releaseNotes]) {
    const bytes = await readAssetBytes(assetsDir, name);
    if (bytes.byteLength === 0 || bytes.toString("utf8").trim().length === 0) {
      fail(`Required release document is empty: ${name}.`);
    }
  }
}

function sanitizeVerification(verification) {
  const input = ensureRecord(verification, "Platform verification summary");
  const output = {};
  for (const [platform, fields] of Object.entries(VERIFICATION_FIELDS)) {
    const platformValue = ensureRecord(input[platform], `${platform} verification summary`);
    const actualKeys = Object.keys(platformValue).sort();
    const expectedKeys = [...fields].sort();
    if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
      fail(`${platform} verification summary contains missing or unsupported fields.`);
    }
    output[platform] = {};
    for (const field of fields) {
      const value = platformValue[field];
      if (VERIFICATION_BOOLEAN_FIELDS.has(field)) {
        if (value !== true) {
          fail(`${platform} verification field ${field} must be true for stable release.`);
        }
      } else if (field === "digestAlgorithm") {
        if (value !== "SHA-256") {
          fail("Windows verification must use the SHA-256 digest algorithm.");
        }
      }
      output[platform][field] = value;
    }
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(VERIFICATION_FIELDS, key)) {
      fail(`Unsupported platform verification section: ${key}.`);
    }
  }
  const serialized = JSON.stringify(output);
  if (
    /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private)\/)/u.test(serialized) ||
    /(?:raw|log|credential|secret|token|password|privateKey|pfx|pem)/iu.test(serialized)
  ) {
    fail("Verification summary must be sanitized and cannot contain paths, secrets, or raw logs.");
  }
  return sortedObject(output);
}

function publicAssetExclusions(policy) {
  return new Set([policy.evidence.file, policy.evidence.digest]);
}

async function collectAssetRecords(assetsDir, assets, policy) {
  const excluded = publicAssetExclusions(policy);
  const records = [];
  for (const asset of assets) {
    if (excluded.has(asset.name)) {
      continue;
    }
    const bytes = await readFile(asset.path);
    records.push({
      name: asset.name,
      size: bytes.byteLength,
      sha256: sha256Bytes(bytes)
    });
  }
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

function canonicalChecksumLines(records) {
  return `${records
    .map((record) => `${record.sha256}  ${record.name}`)
    .sort((left, right) => left.slice(66).localeCompare(right.slice(66)))
    .join("\n")}\n`;
}

async function validateChecksumFile({ assetsDir, assets, policy, records }) {
  const checksumName = policy.ancillary.checksums;
  const bytes = await readAssetBytes(assetsDir, checksumName);
  const source = bytes.toString("utf8");
  const lines = source.split("\n");
  if (!source.endsWith("\n") || lines.at(-1) !== "") {
    fail("SHA256SUMS checksum is not canonical; it must end with exactly one LF newline.");
  }
  const parsed = [];
  for (const line of lines.slice(0, -1)) {
    const match = /^([a-f0-9]{64}) {2}([^\s]+)$/u.exec(line);
    if (!match) {
      fail("SHA256SUMS is not canonical; each line must be lowercase digest, two spaces, and basename.");
    }
    ensureSafeFilename(match[2], "checksum filename");
    parsed.push({ sha256: match[1], name: match[2] });
  }
  const expected = canonicalChecksumLines(
    records.filter((record) => record.name !== checksumName)
  );
  if (source !== expected) {
    fail("SHA256SUMS is missing assets, contains extra assets, is unsorted, or has a digest mismatch.");
  }
  const actualNames = new Set(assets.map((asset) => asset.name));
  for (const record of parsed) {
    if (!actualNames.has(record.name)) {
      fail(`SHA256SUMS references missing asset ${record.name}.`);
    }
  }
  return parsed;
}

function buildEvidenceObject({
  sourceSha,
  packageVersion,
  policy,
  publicAssets,
  updaterReferences,
  verification
}) {
  return sortedObject({
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    sourceSha,
    packageVersion,
    publicAssets,
    updaterReferences,
    verification,
    supportingFiles: {
      sbom: policy.ancillary.sbom,
      thirdPartyNotices: policy.ancillary.notices,
      releaseNotes: policy.ancillary.releaseNotes
    },
    candidateEvidence: {
      algorithm: "SHA-256",
      digestFile: policy.evidence.digest,
      digestFormat: "lowercase-hex-two-spaces-basename-lf",
      evidenceFile: policy.evidence.file,
      checksumFile: policy.ancillary.checksums,
      checksumExcludes: [policy.ancillary.checksums, policy.evidence.file, policy.evidence.digest],
      evidenceDigestIsExternal: true
    }
  });
}

function parseEvidenceJson(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("release-evidence.json is not valid JSON.");
  }
  const canonical = canonicalJsonStringify(value);
  if (source !== canonical) {
    fail("release-evidence.json is not canonical JSON with sorted keys and one trailing LF.");
  }
  return value;
}

async function validateBundleInputs({ assetsDir, packageVersion, allowGenerated }) {
  const listed = await listFlatAssets(assetsDir);
  const names = listed.assets.map((asset) => asset.name);
  const policy = buildStablePublicAssetPolicy(packageVersion);
  validateAssetNames(names, policy, { allowGenerated });
  const assetNames = new Set(names);
  await validateAncillaryFiles({ assetsDir: listed.directory, policy });
  const windowsReferences = await validateMetadataFile({
    assetsDir: listed.directory,
    policy,
    metadataName: policy.windows.metadata,
    packageVersion,
    assetNames
  });
  return {
    ...listed,
    policy,
    windowsReferences
  };
}

export async function createCandidateEvidence({ assetsDir, sourceSha, packageVersion, verification }) {
  const normalizedSourceSha = ensureSourceSha(sourceSha);
  const version = ensureStableVersion(packageVersion);
  const sanitizedVerification = sanitizeVerification(verification);
  const bundle = await validateBundleInputs({
    assetsDir,
    packageVersion: version,
    allowGenerated: true
  });
  const evidenceFileExists = bundle.assets.some((asset) => asset.name === bundle.policy.evidence.file);
  if (evidenceFileExists) {
    fail("Candidate creation refuses to overwrite an existing release-evidence.json; use verify mode.");
  }

  const recordsBeforeChecksum = await collectAssetRecords(bundle.directory, bundle.assets, bundle.policy);
  const checksumExists = bundle.assets.some((asset) => asset.name === bundle.policy.ancillary.checksums);
  if (!checksumExists) {
    await writeFile(
      join(bundle.directory, bundle.policy.ancillary.checksums),
      canonicalChecksumLines(recordsBeforeChecksum)
    );
  }

  const afterChecksum = await listFlatAssets(bundle.directory);
  const publicAssets = await collectAssetRecords(bundle.directory, afterChecksum.assets, bundle.policy);
  await validateChecksumFile({
    assetsDir: bundle.directory,
    assets: afterChecksum.assets,
    policy: bundle.policy,
    records: publicAssets
  });

  const evidence = buildEvidenceObject({
    sourceSha: normalizedSourceSha,
    packageVersion: version,
    policy: bundle.policy,
    publicAssets,
    updaterReferences: [...bundle.windowsReferences].sort((left, right) =>
      `${left.metadata}\0${left.filename}`.localeCompare(`${right.metadata}\0${right.filename}`)
    ),
    verification: sanitizedVerification
  });
  const evidenceBytes = Buffer.from(canonicalJsonStringify(evidence), "utf8");
  await writeFile(join(bundle.directory, bundle.policy.evidence.file), evidenceBytes);
  const evidenceSha256 = sha256Bytes(evidenceBytes);
  await writeFile(
    join(bundle.directory, bundle.policy.evidence.digest),
    `${evidenceSha256}  ${bundle.policy.evidence.file}\n`
  );

  return {
    evidence,
    evidenceSha256,
    policy: bundle.policy,
    assetNames: publicAssets.map((asset) => asset.name)
  };
}

export async function verifyCandidateEvidence({ assetsDir, sourceSha, packageVersion }) {
  const normalizedSourceSha = ensureSourceSha(sourceSha);
  const version = ensureStableVersion(packageVersion);
  const bundle = await validateBundleInputs({
    assetsDir,
    packageVersion: version,
    allowGenerated: false
  });
  const publicAssets = await collectAssetRecords(bundle.directory, bundle.assets, bundle.policy);
  await validateChecksumFile({
    assetsDir: bundle.directory,
    assets: bundle.assets,
    policy: bundle.policy,
    records: publicAssets
  });

  const evidenceBytes = await readAssetBytes(bundle.directory, bundle.policy.evidence.file);
  const evidenceSource = evidenceBytes.toString("utf8");
  const evidence = parseEvidenceJson(evidenceSource);
  const evidenceVerification = sanitizeVerification(evidence.verification);
  const expectedEvidence = buildEvidenceObject({
    sourceSha: normalizedSourceSha,
    packageVersion: version,
    policy: bundle.policy,
    publicAssets,
    updaterReferences: [...bundle.windowsReferences].sort((left, right) =>
      `${left.metadata}\0${left.filename}`.localeCompare(`${right.metadata}\0${right.filename}`)
    ),
    verification: evidenceVerification
  });
  if (!isDeepStrictEqual(evidence, expectedEvidence)) {
    fail("release-evidence.json does not match the current candidate assets, metadata, source, or version.");
  }

  const digestBytes = await readAssetBytes(bundle.directory, bundle.policy.evidence.digest);
  const digestSource = digestBytes.toString("utf8");
  const expectedDigest = `${sha256Bytes(evidenceBytes)}  ${bundle.policy.evidence.file}\n`;
  if (digestSource !== expectedDigest) {
    fail("release-evidence.sha256 does not match the canonical evidence bytes.");
  }

  return {
    evidence,
    evidenceSha256: sha256Bytes(evidenceBytes),
    policy: bundle.policy,
    assetNames: publicAssets.map((asset) => asset.name)
  };
}

function parseCliArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      if (result.command === undefined) {
        result.command = argument;
        continue;
      }
      fail(`Unexpected CLI argument: ${argument}.`);
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}.`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

async function cliMain() {
  const argumentsObject = parseCliArguments(process.argv.slice(2));
  const command = argumentsObject.command;
  if (command !== "create" && command !== "verify") {
    fail("Use `create` or `verify`.");
  }
  if (!argumentsObject["assets-dir"] || !argumentsObject.version || !argumentsObject["source-sha"]) {
    fail("Required arguments: --assets-dir DIR --source-sha SHA --version X.Y.Z.");
  }
  let result;
  if (command === "create") {
    if (!argumentsObject["verification-file"]) {
      fail("Create mode requires --verification-file JSON.");
    }
    const verification = JSON.parse(await readFile(resolve(argumentsObject["verification-file"]), "utf8"));
    result = await createCandidateEvidence({
      assetsDir: argumentsObject["assets-dir"],
      sourceSha: argumentsObject["source-sha"],
      packageVersion: argumentsObject.version,
      verification
    });
  } else {
    result = await verifyCandidateEvidence({
      assetsDir: argumentsObject["assets-dir"],
      sourceSha: argumentsObject["source-sha"],
      packageVersion: argumentsObject.version
    });
  }
  console.log(
    JSON.stringify({
      command,
      packageVersion: result.evidence.packageVersion,
      sourceSha: result.evidence.sourceSha,
      evidenceSha256: result.evidenceSha256,
      assetNames: result.assetNames
    })
  );
}

if (process.argv[1]?.endsWith("release-candidate-evidence.mjs")) {
  cliMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
