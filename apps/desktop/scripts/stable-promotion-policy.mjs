import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  buildStablePublicAssetPolicy,
  verifyCandidateEvidence
} from "./release-candidate-evidence.mjs";

export const STABLE_PROMOTION_VERSION = "0.1.4";
export const STABLE_PROMOTION_TAG = "v0.1.4";
export const PROMOTION_CONFIRMATION = "PUBLISH v0.1.4";
export const CANDIDATE_WORKFLOW_NAME = "Trio private candidate package and evidence";
export const CANDIDATE_WORKFLOW_PATH = ".github/workflows/package-release.yml";
export const CANDIDATE_ARTIFACT_PREFIX = "trio-stable-candidate-";
export const DELIVERY_OWNER = "ksaeil2001";
export const DELIVERY_REPOSITORY = "trio-releases";
export const PUBLIC_DISPATCH_EVENT = "trio-release-published";

const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const EVIDENCE_SHA_PATTERN = /^[a-f0-9]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/u;
const SAFE_FILENAME_PATTERN = /^[^\\/\0\u0000-\u001f\u007f]+$/u;

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

function ensureSourceSha(value, label = "source SHA") {
  if (typeof value !== "string" || !SOURCE_SHA_PATTERN.test(value)) {
    fail(`${label} must be exactly 40 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

function ensureEvidenceSha(value, label = "evidence SHA-256") {
  if (typeof value !== "string" || !EVIDENCE_SHA_PATTERN.test(value)) {
    fail(`${label} must be lowercase 64-hex.`);
  }
  return value;
}

function ensureVersion(value) {
  if (value !== STABLE_PROMOTION_VERSION) {
    fail(`Stable promotion package version must be ${STABLE_PROMOTION_VERSION}.`);
  }
  return value;
}

function ensureTag(value) {
  if (value !== STABLE_PROMOTION_TAG) {
    fail(`Stable promotion tag must be ${STABLE_PROMOTION_TAG}.`);
  }
  return value;
}

export function validateReleaseMetadata(
  metadata,
  { tag = STABLE_PROMOTION_TAG, version = STABLE_PROMOTION_VERSION, expectedBody, expectedDraft } = {}
) {
  const value = ensureRecord(metadata, "Release metadata");
  const expectedTag = ensureTag(tag);
  const expectedVersion = ensureVersion(version);
  if (typeof expectedBody !== "string") {
    fail("Expected Release body must be the candidate UTF-8 string.");
  }
  if (typeof expectedDraft !== "boolean") {
    fail("Expected Release draft state must be boolean.");
  }
  const expectedName = `Trio v${expectedVersion}`;
  if (!Object.hasOwn(value, "tag_name") || value.tag_name !== expectedTag) {
    fail("Release tag_name does not match the exact stable promotion tag.");
  }
  if (!Object.hasOwn(value, "name") || value.name !== expectedName) {
    fail("Release name does not match the exact stable promotion title.");
  }
  if (!Object.hasOwn(value, "body") || typeof value.body !== "string" || value.body !== expectedBody) {
    fail("Release body does not exactly match the verified candidate release notes.");
  }
  if (!Object.hasOwn(value, "prerelease") || value.prerelease !== false) {
    fail("Stable Release must explicitly have prerelease=false.");
  }
  if (!Object.hasOwn(value, "draft") || value.draft !== expectedDraft) {
    fail("Release draft state does not match the expected promotion stage.");
  }
  return {
    tag_name: value.tag_name,
    name: value.name,
    body: value.body,
    prerelease: value.prerelease,
    draft: value.draft
  };
}

function ensureRunId(value, label = "candidate run ID") {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(`${label} must be a positive decimal integer.`);
    }
    return String(value);
  }
  if (typeof value !== "string" || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    fail(`${label} must be a positive decimal integer without whitespace or leading zeroes.`);
  }
  return value;
}

function readAlias(record, aliases, label) {
  const present = aliases.filter((key) => Object.hasOwn(record, key));
  if (present.length === 0) {
    fail(`Missing ${label}.`);
  }
  const first = record[present[0]];
  for (const key of present.slice(1)) {
    if (record[key] !== first) {
      fail(`${label} aliases do not agree.`);
    }
  }
  return first;
}

export function normalizePromotionInputs(input) {
  const record = ensureRecord(input, "Promotion inputs");
  const allowed = new Set([
    "candidate_run_id",
    "candidateRunId",
    "tag",
    "evidence_sha256",
    "evidenceSha256",
    "confirmation"
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(`Unsupported promotion input: ${key}.`);
    }
  }

  const candidateRunId = ensureRunId(
    readAlias(record, ["candidate_run_id", "candidateRunId"], "candidate run ID")
  );
  const tag = ensureTag(readAlias(record, ["tag"], "tag"));
  const evidenceSha256 = ensureEvidenceSha(
    readAlias(record, ["evidence_sha256", "evidenceSha256"], "evidence SHA-256")
  );
  const confirmation = readAlias(record, ["confirmation"], "confirmation");
  if (confirmation !== PROMOTION_CONFIRMATION) {
    fail(`Promotion confirmation must be exactly ${PROMOTION_CONFIRMATION}.`);
  }

  return { candidateRunId, tag, evidenceSha256, confirmation };
}

export function expectedCandidateArtifactName(sourceSha, candidateRunId) {
  const normalizedSourceSha = ensureSourceSha(sourceSha);
  const normalizedRunId = ensureRunId(candidateRunId);
  return `${CANDIDATE_ARTIFACT_PREFIX}${normalizedSourceSha}-${normalizedRunId}`;
}

export function validateTagSource({ tag, tagSha, sourceSha, packageVersion = STABLE_PROMOTION_VERSION }) {
  const normalizedTag = ensureTag(tag);
  const normalizedTagSha = ensureSourceSha(tagSha, "tag SHA");
  const normalizedSourceSha = ensureSourceSha(sourceSha);
  ensureVersion(packageVersion);
  if (normalizedTagSha !== normalizedSourceSha) {
    fail(`${normalizedTag} SHA does not match the candidate source SHA.`);
  }
  return {
    tag: normalizedTag,
    tagSha: normalizedTagSha,
    sourceSha: normalizedSourceSha,
    packageVersion
  };
}

function identityValue(metadata, aliases) {
  for (const key of aliases) {
    if (Object.hasOwn(metadata, key)) {
      return metadata[key];
    }
  }
  return undefined;
}

export function validateCandidateRunMetadata(metadata, expected) {
  const value = ensureRecord(metadata, "Candidate run metadata");
  const expectedRecord = ensureRecord(expected, "Candidate run expectations");
  const candidateRunId = ensureRunId(expectedRecord.candidateRunId ?? expectedRecord.candidate_run_id);
  const sourceSha = ensureSourceSha(expectedRecord.sourceSha ?? expectedRecord.source_sha);
  const packageVersion = ensureVersion(expectedRecord.packageVersion ?? expectedRecord.version);

  const actualId = ensureRunId(identityValue(value, ["id", "run_id", "runId"]), "candidate run metadata ID");
  if (actualId !== candidateRunId) {
    fail("Candidate run ID does not match the manual promotion input.");
  }

  const actualHeadSha = ensureSourceSha(
    identityValue(value, ["head_sha", "headSha"]),
    "candidate run head SHA"
  );
  if (actualHeadSha !== sourceSha) {
    fail("Candidate run head SHA does not match the checked-out tag SHA.");
  }

  const event = identityValue(value, ["event", "event_name", "eventName"]);
  if (event !== "workflow_dispatch") {
    fail("Candidate run must have workflow_dispatch event identity.");
  }
  if (value.status !== "completed" || value.conclusion !== "success") {
    fail("Candidate run must be completed successfully.");
  }

  const workflowName = value.name;
  const workflowPath = value.path;
  if (workflowName !== CANDIDATE_WORKFLOW_NAME) {
    fail("Candidate run workflow name is not the exact candidate workflow.");
  }
  if (workflowPath !== CANDIDATE_WORKFLOW_PATH) {
    fail("Candidate run workflow path is not the exact candidate workflow.");
  }

  for (const key of ["version", "package_version", "packageVersion"]) {
    if (Object.hasOwn(value, key) && value[key] !== packageVersion) {
      fail("Candidate run package version does not match stable promotion version.");
    }
  }

  return {
    id: Number(candidateRunId),
    runId: candidateRunId,
    headSha: actualHeadSha,
    event,
    status: value.status,
    conclusion: value.conclusion,
    workflowName,
    workflowPath,
    packageVersion
  };
}

export function validateCandidateArtifacts(metadata, expected) {
  const value = ensureRecord(metadata, "Candidate artifact metadata");
  const expectedRecord = ensureRecord(expected, "Candidate artifact expectations");
  const sourceSha = ensureSourceSha(expectedRecord.sourceSha ?? expectedRecord.source_sha);
  const candidateRunId = ensureRunId(expectedRecord.candidateRunId ?? expectedRecord.candidate_run_id);
  const expectedName = expectedCandidateArtifactName(sourceSha, candidateRunId);
  if (!Array.isArray(value.artifacts)) {
    fail("Candidate artifact metadata must contain an artifacts array.");
  }

  const matches = value.artifacts.filter((artifact) => isRecord(artifact) && artifact.name === expectedName);
  if (matches.length !== 1) {
    fail(`Candidate artifact list must contain exactly one ${expectedName}.`);
  }
  const artifact = matches[0];
  if (artifact.expired !== false) {
    fail("Candidate artifact must not be expired.");
  }
  if (!Number.isInteger(artifact.id) || artifact.id <= 0) {
    fail("Candidate artifact ID is invalid.");
  }
  if (!Number.isInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) {
    fail("Candidate artifact must have a positive byte size.");
  }
  if (!isRecord(artifact.workflow_run)) {
    fail("Candidate artifact must include workflow_run ownership metadata.");
  }
  const expectedWorkflowRunId = Number(candidateRunId);
  if (!Number.isSafeInteger(expectedWorkflowRunId)) {
    fail("Candidate workflow run ID is outside the safe numeric range.");
  }
  if (
    !Number.isSafeInteger(artifact.workflow_run.id) ||
    artifact.workflow_run.id <= 0 ||
    artifact.workflow_run.id !== expectedWorkflowRunId
  ) {
    fail("Candidate artifact workflow run ID does not exactly match the candidate run.");
  }
  const artifactHeadSha = ensureSourceSha(
    artifact.workflow_run.head_sha,
    "candidate artifact head SHA"
  );
  if (artifactHeadSha !== sourceSha) {
    fail("Candidate artifact workflow head SHA does not match the tag source SHA.");
  }

  if (artifact.expires_at !== undefined) {
    const expiresAt = Date.parse(String(artifact.expires_at));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      fail("Candidate artifact has expired or an invalid expiry timestamp.");
    }
  }

  return { expectedName, artifact };
}

export function validateEvidenceSidecar(source, expectedEvidenceSha) {
  const evidenceSha = ensureEvidenceSha(expectedEvidenceSha);
  const text = Buffer.isBuffer(source) ? source.toString("utf8") : source;
  if (typeof text !== "string") {
    fail("Evidence sidecar must be UTF-8 text.");
  }
  const match = /^([a-f0-9]{64}) {2}release-evidence\.json\n$/u.exec(text);
  if (!match || match[1] !== evidenceSha) {
    fail("release-evidence.sha256 does not match the manual evidence digest.");
  }
  return match[1];
}

function expectedAssetNames(policy) {
  return [
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
  ];
}

function ensureSafeAssetName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name !== basename(name) ||
    name === "." ||
    name === ".." ||
    name.includes("..") ||
    !SAFE_FILENAME_PATTERN.test(name)
  ) {
    fail(`Unsafe stable publication asset name: ${String(name)}.`);
  }
  return name;
}

export function validateExactAssetNames(names, { packageVersion = STABLE_PROMOTION_VERSION } = {}) {
  ensureVersion(packageVersion);
  if (!Array.isArray(names)) {
    fail("Stable publication assets must be an array.");
  }
  const normalizedNames = names.map(ensureSafeAssetName);
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    fail("Stable publication asset names must be unique.");
  }
  const policy = buildStablePublicAssetPolicy(packageVersion);
  const expected = expectedAssetNames(policy).sort((left, right) => left.localeCompare(right));
  const actual = [...normalizedNames].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("Stable publication asset list does not exactly match the Task 5A allowlist.");
  }
  return { policy, assetNames: expected };
}

function normalizePromotionAssetRecords(records, label = "promotion asset records") {
  if (!Array.isArray(records)) {
    fail(`${label} must be an array.`);
  }
  const normalized = records.map((record) => {
    const value = ensureRecord(record, label);
    const name = ensureSafeAssetName(value.name);
    if (!Number.isSafeInteger(value.size) || value.size < 0) {
      fail(`${label} must contain a non-negative integer size for ${name}.`);
    }
    return { name, size: value.size };
  });
  if (new Set(normalized.map(({ name }) => name)).size !== normalized.length) {
    fail(`${label} must contain unique names.`);
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Compare GitHub Release API assets with the exact candidate records. When a
 * repository and tag are supplied, the API's browser URL is also required to
 * be the canonical download URL for that name.
 */
export function validateReleaseAssetRecords(
  assets,
  expectedRecords,
  { repository, tag } = {}
) {
  const expected = normalizePromotionAssetRecords(expectedRecords, "expected promotion asset records");
  if (!Array.isArray(assets)) {
    fail("Release API assets must be an array.");
  }
  const actual = assets.map((asset) => {
    const value = ensureRecord(asset, "Release API asset");
    const name = ensureSafeAssetName(value.name);
    if (!Number.isSafeInteger(value.size) || value.size < 0) {
      fail(`Release API asset ${name} must have a non-negative integer size.`);
    }
    if (!Number.isSafeInteger(value.id) || value.id <= 0) {
      fail(`Release API asset ${name} must have a positive numeric ID.`);
    }
    if (repository !== undefined || tag !== undefined) {
      if (typeof repository !== "string" || repository.length === 0) {
        fail("Release API asset URL validation requires a repository.");
      }
      const normalizedTag = ensureTag(tag);
      const expectedUrl = `https://github.com/${repository}/releases/download/${normalizedTag}/${name}`;
      if (value.browser_download_url !== expectedUrl) {
        fail(`Release API asset ${name} has a non-canonical browser download URL.`);
      }
    }
    return { name, size: value.size };
  });
  const normalizedActual = normalizePromotionAssetRecords(actual, "Release API assets");
  if (JSON.stringify(normalizedActual) !== JSON.stringify(expected)) {
    fail("Release API asset names and sizes do not exactly match the candidate records.");
  }
  return expected;
}

async function collectPromotionAssetRecords(assetsDir, result) {
  const evidenceNames = [result.policy.evidence.file, result.policy.evidence.digest];
  const records = [...result.publicAssets.map(({ name, size }) => ({ name, size }))];
  for (const name of evidenceNames) {
    const path = resolve(assetsDir, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`Promotion evidence asset is not a regular file: ${name}.`);
    }
    records.push({ name, size: stat.size });
  }
  return normalizePromotionAssetRecords(records);
}

export async function validatePromotionAssets({ assetsDir, sourceSha, packageVersion = STABLE_PROMOTION_VERSION, evidenceSha256 }) {
  const normalizedSourceSha = ensureSourceSha(sourceSha);
  const version = ensureVersion(packageVersion);
  const normalizedEvidenceSha = ensureEvidenceSha(evidenceSha256);
  const result = await verifyCandidateEvidence({
    assetsDir: resolve(assetsDir),
    sourceSha: normalizedSourceSha,
    packageVersion: version
  });
  if (result.evidenceSha256 !== normalizedEvidenceSha) {
    fail("Verified candidate evidence digest does not match the manual promotion input.");
  }
  const names = [
    ...result.assetNames,
    result.policy.evidence.file,
    result.policy.evidence.digest
  ];
  validateExactAssetNames(names, {
    packageVersion: version
  });
  const assetRecords = await collectPromotionAssetRecords(assetsDir, result);
  return {
    ...result,
    evidenceSha256: normalizedEvidenceSha,
    assetNames: names.sort((left, right) => left.localeCompare(right)),
    assetRecords
  };
}

export function buildRepositoryDispatchPayload({ tag, version, sourceSha, evidenceSha256 }) {
  const normalizedTag = ensureTag(tag);
  const normalizedVersion = ensureVersion(version);
  const normalizedSourceSha = ensureSourceSha(sourceSha);
  const normalizedEvidenceSha = ensureEvidenceSha(evidenceSha256);
  return {
    event_type: PUBLIC_DISPATCH_EVENT,
    client_payload: {
      tag: normalizedTag,
      version: normalizedVersion,
      source_sha: normalizedSourceSha,
      evidence_sha256: normalizedEvidenceSha
    }
  };
}

function parseCliArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    fail("A stable-promotion-policy command is required.");
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      fail(`Unexpected CLI argument: ${argument}.`);
    }
    const key = argument.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}.`);
    }
    if (Object.hasOwn(values, key)) {
      fail(`Duplicate CLI argument: --${key}.`);
    }
    values[key] = value;
    index += 1;
  }
  return { command, values };
}

function requiredCli(values, key) {
  if (!Object.hasOwn(values, key)) {
    fail(`Missing required --${key}.`);
  }
  return values[key];
}

function ensureCliKeys(values, allowed, command) {
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) {
      fail(`Unsupported ${command} argument: --${key}.`);
    }
  }
}

function parseBooleanCli(value, label) {
  if (value !== "true" && value !== "false") {
    fail(`${label} must be exactly true or false.`);
  }
  return value === "true";
}

async function readJson(path) {
  let value;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    fail(`Cannot read JSON input: ${error instanceof Error ? error.message : String(error)}.`);
  }
  return value;
}

async function cliMain() {
  const { command, values } = parseCliArguments(process.argv.slice(2));
  if (command === "inputs") {
    const normalized = normalizePromotionInputs({
      candidate_run_id: requiredCli(values, "candidate-run-id"),
      tag: requiredCli(values, "tag"),
      evidence_sha256: requiredCli(values, "evidence-sha256"),
      confirmation: requiredCli(values, "confirmation")
    });
    console.log(JSON.stringify(normalized));
    return;
  }

  if (command === "release-metadata") {
    ensureCliKeys(
      values,
      ["metadata", "expected-body-path", "tag", "version", "expected-draft"],
      command
    );
    const metadata = await readJson(requiredCli(values, "metadata"));
    const expectedBody = await readFile(resolve(requiredCli(values, "expected-body-path")), "utf8");
    const normalized = validateReleaseMetadata(metadata, {
      tag: requiredCli(values, "tag"),
      version: requiredCli(values, "version"),
      expectedBody,
      expectedDraft: parseBooleanCli(requiredCli(values, "expected-draft"), "--expected-draft")
    });
    console.log(JSON.stringify(normalized));
    return;
  }

  if (command === "run") {
    const normalized = validateCandidateRunMetadata(await readJson(requiredCli(values, "metadata")), {
      candidateRunId: requiredCli(values, "candidate-run-id"),
      sourceSha: requiredCli(values, "source-sha"),
      packageVersion: values.version ?? STABLE_PROMOTION_VERSION
    });
    console.log(JSON.stringify(normalized));
    return;
  }

  if (command === "artifacts") {
    const result = validateCandidateArtifacts(await readJson(requiredCli(values, "metadata")), {
      candidateRunId: requiredCli(values, "candidate-run-id"),
      sourceSha: requiredCli(values, "source-sha")
    });
    console.log(JSON.stringify({ expectedName: result.expectedName, artifactId: result.artifact.id }));
    return;
  }

  if (command === "sidecar") {
    const sidecar = await readFile(resolve(requiredCli(values, "path")));
    console.log(validateEvidenceSidecar(sidecar, requiredCli(values, "evidence-sha256")));
    return;
  }

  if (command === "assets") {
    const result = await validatePromotionAssets({
      assetsDir: requiredCli(values, "assets-dir"),
      sourceSha: requiredCli(values, "source-sha"),
      packageVersion: values.version ?? STABLE_PROMOTION_VERSION,
      evidenceSha256: requiredCli(values, "evidence-sha256")
    });
    console.log(JSON.stringify({
      evidenceSha256: result.evidenceSha256,
      assetNames: result.assetNames,
      assetRecords: result.assetRecords
    }));
    return;
  }

  if (command === "dispatch") {
    console.log(JSON.stringify(buildRepositoryDispatchPayload({
      tag: requiredCli(values, "tag"),
      version: values.version ?? STABLE_PROMOTION_VERSION,
      sourceSha: requiredCli(values, "source-sha"),
      evidenceSha256: requiredCli(values, "evidence-sha256")
    })));
    return;
  }

  fail(`Unsupported stable-promotion-policy command: ${command}.`);
}

if (process.argv[1]?.endsWith("stable-promotion-policy.mjs")) {
  cliMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
