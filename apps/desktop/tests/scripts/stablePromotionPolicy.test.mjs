import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CANDIDATE_ARTIFACT_PREFIX,
  CANDIDATE_WORKFLOW_NAME,
  CANDIDATE_WORKFLOW_PATH,
  PROMOTION_CONFIRMATION,
  STABLE_PROMOTION_TAG,
  STABLE_PROMOTION_VERSION,
  buildRepositoryDispatchPayload,
  expectedCandidateArtifactName,
  normalizePromotionInputs,
  validateCandidateArtifacts,
  validateCandidateRunMetadata,
  validateEvidenceSidecar,
  validateReleaseAssetRecords,
  validateReleaseMetadata,
  validateTagSource
} from "../../scripts/stable-promotion-policy.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const EVIDENCE_SHA = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const RUN_ID = "123456789";
const RELEASE_NOTES_BODY = "# Trio v0.1.4\n\nStable candidate notes.\n";
const execFileAsync = promisify(execFile);

function validInputs() {
  return {
    candidate_run_id: RUN_ID,
    tag: STABLE_PROMOTION_TAG,
    evidence_sha256: EVIDENCE_SHA,
    confirmation: PROMOTION_CONFIRMATION
  };
}

function validRunMetadata(overrides = {}) {
  return {
    id: Number(RUN_ID),
    head_sha: SOURCE_SHA,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    name: CANDIDATE_WORKFLOW_NAME,
    path: CANDIDATE_WORKFLOW_PATH,
    ...overrides
  };
}

function validReleaseMetadata(overrides = {}) {
  return {
    tag_name: STABLE_PROMOTION_TAG,
    name: `Trio v${STABLE_PROMOTION_VERSION}`,
    body: RELEASE_NOTES_BODY,
    prerelease: false,
    draft: true,
    ...overrides
  };
}

async function runReleaseMetadataCli(directory, metadata, expectedBodyPath, expectedDraft = false) {
  const metadataPath = join(directory, "anonymous-release.json");
  await writeFile(metadataPath, JSON.stringify(metadata));
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      resolve(process.cwd(), "scripts/stable-promotion-policy.mjs"),
      "release-metadata",
      "--metadata",
      metadataPath,
      "--expected-body-path",
      expectedBodyPath,
      "--tag",
      "v0.1.4",
      "--version",
      "0.1.4",
      "--expected-draft",
      String(expectedDraft)
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  return JSON.parse(stdout);
}

describe("stable promotion policy", () => {
  it("normalizes only the exact manual promotion inputs", () => {
    expect(normalizePromotionInputs(validInputs())).toEqual({
      candidateRunId: RUN_ID,
      tag: STABLE_PROMOTION_TAG,
      evidenceSha256: EVIDENCE_SHA,
      confirmation: PROMOTION_CONFIRMATION
    });
  });

  it.each([
    ["candidate_run_id", "0"],
    ["candidate_run_id", "01"],
    ["candidate_run_id", "12.5"],
    ["candidate_run_id", " 123"],
    ["tag", "v0.1.4-preview.1"],
    ["evidence_sha256", EVIDENCE_SHA.toUpperCase()],
    ["confirmation", "PUBLISH v0.1.4 "]
  ])("rejects non-canonical %s input", (key, value) => {
    expect(() => normalizePromotionInputs({ ...validInputs(), [key]: value })).toThrow();
  });

  it("requires the candidate run to be a successful dispatch of the exact workflow", () => {
    expect(
      validateCandidateRunMetadata(validRunMetadata(), {
        candidateRunId: RUN_ID,
        sourceSha: SOURCE_SHA,
        packageVersion: STABLE_PROMOTION_VERSION
      })
    ).toMatchObject({ id: Number(RUN_ID), headSha: SOURCE_SHA });

    for (const overrides of [
      { head_sha: "f".repeat(40) },
      { event: "push" },
      { status: "in_progress" },
      { conclusion: "failure" },
      { name: "another workflow" },
      { path: ".github/workflows/other.yml" },
      { name: undefined },
      { path: undefined },
      { name: undefined, path: CANDIDATE_WORKFLOW_PATH },
      { name: CANDIDATE_WORKFLOW_NAME, path: undefined }
    ]) {
      expect(() =>
        validateCandidateRunMetadata(validRunMetadata(overrides), {
          candidateRunId: RUN_ID,
          sourceSha: SOURCE_SHA,
          packageVersion: STABLE_PROMOTION_VERSION
        })
      ).toThrow();
    }
  });

  it("requires exactly one non-expired candidate artifact with a derived name", () => {
    const name = expectedCandidateArtifactName(SOURCE_SHA, RUN_ID);
    expect(name).toBe(`${CANDIDATE_ARTIFACT_PREFIX}${SOURCE_SHA}-${RUN_ID}`);
    const metadata = {
      artifacts: [
        {
          id: 42,
          name,
          expired: false,
          size_in_bytes: 100,
          workflow_run: { id: Number(RUN_ID), head_sha: SOURCE_SHA }
        }
      ]
    };
    expect(
      validateCandidateArtifacts(metadata, { candidateRunId: RUN_ID, sourceSha: SOURCE_SHA })
    ).toMatchObject({ artifact: { id: 42, name } });

    for (const artifact of [
      { ...metadata.artifacts[0], name: "candidate.zip" },
      { ...metadata.artifacts[0], expired: true },
      { ...metadata.artifacts[0], workflow_run: { id: 999, head_sha: SOURCE_SHA } },
      { ...metadata.artifacts[0], workflow_run: undefined },
      { ...metadata.artifacts[0], workflow_run: { head_sha: SOURCE_SHA } },
      { ...metadata.artifacts[0], workflow_run: { id: Number(RUN_ID) } },
      { ...metadata.artifacts[0], workflow_run: { id: RUN_ID, head_sha: SOURCE_SHA } },
      { ...metadata.artifacts[0], workflow_run: { id: Number(RUN_ID), head_sha: "f".repeat(40) } }
    ]) {
      expect(() =>
        validateCandidateArtifacts({ artifacts: [artifact] }, {
          candidateRunId: RUN_ID,
          sourceSha: SOURCE_SHA
        })
      ).toThrow();
    }
    expect(() =>
      validateCandidateArtifacts({ artifacts: [...metadata.artifacts, metadata.artifacts[0]] }, {
        candidateRunId: RUN_ID,
        sourceSha: SOURCE_SHA
      })
    ).toThrow();
  });

  it("requires exact release API asset names and byte sizes", () => {
    const expected = [
      { name: "Trio-0.1.4.dmg", size: 101 },
      { name: "release-evidence.json", size: 202 }
    ];
    const actual = expected.map((asset, index) => ({
      ...asset,
      id: index + 1,
      browser_download_url: `https://github.com/ksaeil2001/trio-releases/releases/download/v0.1.4/${asset.name}`
    }));
    expect(validateReleaseAssetRecords(actual, expected, {
      repository: "ksaeil2001/trio-releases",
      tag: STABLE_PROMOTION_TAG
    })).toEqual(expected.slice().sort((left, right) => left.name.localeCompare(right.name)));

    for (const assets of [
      actual.map((asset) => ({ ...asset, size: asset.size + 1 })),
      actual.map((asset) => ({ ...asset, name: `${asset.name}.tampered` })),
      actual.map((asset) => ({ ...asset, browser_download_url: "https://example.invalid/asset" })),
      actual.map(({ browser_download_url: _url, ...asset }) => asset)
    ]) {
      expect(() => validateReleaseAssetRecords(assets, expected, {
        repository: "ksaeil2001/trio-releases",
        tag: STABLE_PROMOTION_TAG
      })).toThrow();
    }
  });

  it("requires exact stable Release metadata without normalizing the notes body", () => {
    expect(validateReleaseMetadata(validReleaseMetadata(), {
      tag: STABLE_PROMOTION_TAG,
      version: STABLE_PROMOTION_VERSION,
      expectedBody: RELEASE_NOTES_BODY,
      expectedDraft: true
    })).toMatchObject({
      tag_name: STABLE_PROMOTION_TAG,
      name: `Trio v${STABLE_PROMOTION_VERSION}`,
      body: RELEASE_NOTES_BODY,
      prerelease: false,
      draft: true
    });
    expect(validateReleaseMetadata(validReleaseMetadata({ draft: false }), {
      tag: STABLE_PROMOTION_TAG,
      version: STABLE_PROMOTION_VERSION,
      expectedBody: RELEASE_NOTES_BODY,
      expectedDraft: false
    })).toMatchObject({ draft: false });

    for (const overrides of [
      { tag_name: "v0.1.3" },
      { name: "Trio v0.1.3" },
      { body: "# Trio v0.1.4\r\n\r\nStable candidate notes.\r\n" },
      { body: `${RELEASE_NOTES_BODY} ` },
      { prerelease: true },
      { draft: false }
    ]) {
      expect(() => validateReleaseMetadata(validReleaseMetadata(overrides), {
        tag: STABLE_PROMOTION_TAG,
        version: STABLE_PROMOTION_VERSION,
        expectedBody: RELEASE_NOTES_BODY,
        expectedDraft: true
      })).toThrow();
    }

    for (const key of ["tag_name", "name", "body", "prerelease", "draft"]) {
      const metadata = validReleaseMetadata();
      delete metadata[key];
      expect(() => validateReleaseMetadata(metadata, {
        tag: STABLE_PROMOTION_TAG,
        version: STABLE_PROMOTION_VERSION,
        expectedBody: RELEASE_NOTES_BODY,
        expectedDraft: true
      })).toThrow();
    }
  });

  it("validates anonymous Release metadata through the executable CLI boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trio-promotion-release-metadata-"));
    const expectedBodyPath = join(directory, "RELEASE_NOTES.md");
    const metadataPath = join(directory, "anonymous-release.json");
    await writeFile(expectedBodyPath, "# Trio v0.1.4\n\nStable candidate notes.\n");
    const metadata = {
      tag_name: "v0.1.4",
      name: "Trio v0.1.4",
      body: "# Trio v0.1.4\n\nStable candidate notes.\n",
      prerelease: false,
      draft: false
    };

    await expect(runReleaseMetadataCli(directory, metadata, expectedBodyPath)).resolves.toEqual({
      tag_name: "v0.1.4",
      name: "Trio v0.1.4",
      body: "# Trio v0.1.4\n\nStable candidate notes.\n",
      prerelease: false,
      draft: false
    });

    for (const mutation of [
      { name: "wrong title", value: { name: "Trio v0.1.3" } },
      { name: "changed body", value: { body: "# Trio v0.1.4\n\nTampered candidate notes.\n" } },
      { name: "prerelease", value: { prerelease: true } },
      { name: "draft", value: { draft: true } },
      { name: "wrong tag", value: { tag_name: "v0.1.3" } },
      { name: "missing fields", value: { body: undefined, name: undefined } }
    ]) {
      const mutated = { ...metadata, ...mutation.value };
      if (mutation.name === "missing fields") {
        delete mutated.body;
        delete mutated.name;
      }
      await expect(runReleaseMetadataCli(directory, mutated, expectedBodyPath)).rejects.toThrow();
    }

    await writeFile(metadataPath, JSON.stringify(metadata));
    const scriptPath = resolve(process.cwd(), "scripts/stable-promotion-policy.mjs");
    await expect(
      execFileAsync(process.execPath, [
        scriptPath,
        "release-metadata",
        "--metadata",
        metadataPath,
        "--expected-body-path",
        expectedBodyPath,
        "--tag",
        "v0.1.4",
        "--version",
        "0.1.4",
        "--expected-draft",
        "maybe"
      ], { cwd: process.cwd(), encoding: "utf8" })
    ).rejects.toThrow();
    await expect(
      execFileAsync(process.execPath, [
        scriptPath,
        "release-metadata",
        "--metadata",
        metadataPath,
        "--expected-body-path",
        expectedBodyPath,
        "--tag",
        "v0.1.4",
        "--version",
        "0.1.4"
      ], { cwd: process.cwd(), encoding: "utf8" })
    ).rejects.toThrow();
  });

  it("binds the manual digest to the canonical evidence sidecar", () => {
    const sidecar = `${EVIDENCE_SHA}  release-evidence.json\n`;
    expect(validateEvidenceSidecar(sidecar, EVIDENCE_SHA)).toBe(EVIDENCE_SHA);
    expect(() => validateEvidenceSidecar(sidecar.replace("\n", "\r\n"), EVIDENCE_SHA)).toThrow();
    expect(() => validateEvidenceSidecar(`${"0".repeat(64)}  release-evidence.json\n`, EVIDENCE_SHA)).toThrow();
    expect(() => validateEvidenceSidecar(`${EVIDENCE_SHA}  other.json\n`, EVIDENCE_SHA)).toThrow();
  });

  it("builds an exact repository dispatch payload without extra caller data", () => {
    expect(buildRepositoryDispatchPayload({
      tag: STABLE_PROMOTION_TAG,
      version: STABLE_PROMOTION_VERSION,
      sourceSha: SOURCE_SHA,
      evidenceSha256: EVIDENCE_SHA
    })).toEqual({
      event_type: "trio-release-published",
      client_payload: {
        tag: STABLE_PROMOTION_TAG,
        version: STABLE_PROMOTION_VERSION,
        source_sha: SOURCE_SHA,
        evidence_sha256: EVIDENCE_SHA
      }
    });
  });

  it("does not accept filesystem or secret-shaped evidence input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trio-promotion-policy-"));
    const path = join(directory, "sidecar");
    await writeFile(path, `${EVIDENCE_SHA}  release-evidence.json\n`);
    expect(await readFile(path, "utf8")).toBe(`${EVIDENCE_SHA}  release-evidence.json\n`);
    expect(() => normalizePromotionInputs({ ...validInputs(), private_key: "secret" })).toThrow();
    expect(createHash("sha256").update("test").digest("hex")).toHaveLength(64);
  });
});
