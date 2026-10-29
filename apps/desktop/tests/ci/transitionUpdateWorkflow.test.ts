import { createRequire } from "node:module";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

type UnknownRecord = Record<string, unknown>;
type YamlParser = { load(source: string): unknown };

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlParser;
const WORKFLOW_PATH = resolve(process.cwd(), ".github/workflows/transition-update-qa.yml");
const execFile = promisify(execFileCallback);
const pwshCmd = process.env.POWERSHELL_BIN || "pwsh";

async function readWorkflowSource(): Promise<string> {
  return (await readFile(WORKFLOW_PATH, "utf8")).replace(/\r\n/g, "\n");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown): UnknownRecord {
  expect(isRecord(value)).toBe(true);
  return value as UnknownRecord;
}

async function readWorkflow(): Promise<UnknownRecord> {
  return expectRecord(yaml.load(await readWorkflowSource()));
}

function getWorkflowOn(workflow: UnknownRecord): UnknownRecord {
  return expectRecord(workflow.on ?? workflow["true"]);
}

async function readPrivateEvidenceValidationRun(): Promise<string> {
  const workflow = await readWorkflow();
  const jobs = expectRecord(workflow.jobs);
  const transitionJob = expectRecord(jobs["transition-package"]);
  const steps = transitionJob.steps;
  expect(Array.isArray(steps)).toBe(true);
  const evidenceStep = (steps as Array<UnknownRecord>).find((step) =>
    String(step.name).includes("Verify private preview evidence sidecar")
  );
  expect(evidenceStep).toBeDefined();
  return String(expectRecord(evidenceStep).run);
}

function extractAssetSizePolicy(run: string): string {
  const match = run.match(/(foreach \(\$asset in \$privateAssets\) \{[\s\S]*?\n\s*\})\s*\$toolingRecords/u);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

async function readPublicAssetValidationRun(): Promise<string> {
  const workflow = await readWorkflow();
  const jobs = expectRecord(workflow.jobs);
  const transitionJob = expectRecord(jobs["transition-package"]);
  const steps = transitionJob.steps;
  expect(Array.isArray(steps)).toBe(true);
  const candidateStep = (steps as Array<UnknownRecord>).find((step) =>
    String(step.name).includes("Verify the fixed preview Release, latest.yml, bytes and publisher")
  );
  expect(candidateStep).toBeDefined();
  return String(expectRecord(candidateStep).run);
}

function extractPublicAssetPolicy(run: string): string {
  const match = run.match(/(function Get-Sha512Base64[\s\S]*?function Assert-PublicAssetMatchesPrivate[\s\S]*?)\n\s*\$publicAssetPaths/u);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

async function executePublicAssetPolicy(
  policy: string,
  publicPath: string,
  record: { name: string; size: number; sha256: string; sha512: string }
) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop",
    policy,
    "$privateRecords = @([pscustomobject]@{ name = $env:TRIO_TEST_ASSET_NAME; size = [int64]$env:TRIO_TEST_ASSET_SIZE; sha256 = $env:TRIO_TEST_ASSET_SHA256; sha512 = $env:TRIO_TEST_ASSET_SHA512 })",
    "Assert-PublicAssetMatchesPrivate -AssetName 'asset.bin' -PublicPath $env:TRIO_TEST_PUBLIC_PATH -PrivateRecords $privateRecords",
    "Write-Output 'public-policy-ok'"
  ].join("\n");
  return execFile(pwshCmd, ["-NoLogo", "-NoProfile", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      TRIO_TEST_PUBLIC_PATH: publicPath,
      TRIO_TEST_ASSET_NAME: record.name,
      TRIO_TEST_ASSET_SIZE: String(record.size),
      TRIO_TEST_ASSET_SHA256: record.sha256,
      TRIO_TEST_ASSET_SHA512: record.sha512
    }
  });
}

describe("private transition update QA workflow", () => {
  test("packages the v0.1.3 transition baseline against the fixed preview candidate", async () => {
    const source = await readWorkflowSource();

    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("v0.1.3-transition.1");
    expect(source).toContain("v0.1.4-preview.1");
    expect(source).toContain("baseline_source_sha");
    expect(source).toContain("transition_source_sha");
    expect(source).toContain("scripts/release-channel-policy.mjs");
    expect(source).toContain("setup-esigner-cka.ps1");
    expect(source).toContain("trio-transition-qa-");
    expect(source).toContain("TRIO_TRANSITION_QA_FEED_URL");
  });

  test("never mutates a public delivery repository or creates a tag", async () => {
    const source = await readWorkflowSource();

    expect(source).toContain("permissions:\n  actions: read\n  contents: read");
    expect(source).not.toContain("contents: write");
    expect(source).not.toMatch(/gh\s+release\s+(?:create|upload|edit)/u);
    expect(source).not.toMatch(/git\s+(?:push|tag)\b/u);
    expect(source).not.toContain("create-release");
    expect(source).not.toMatch(/repository:\s*ksaeil2001\/trio-releases/u);
  });

  test("binds the baseline and transition source to full commit SHAs", async () => {
    const source = await readWorkflowSource();

    expect(source).toContain("^[0-9a-fA-F]{40}$");
    expect(source).toContain("git merge-base --is-ancestor");
    expect(source).toContain('git rev-parse "refs/tags/v0.1.3^{commit}"');
    expect(source).toContain("The v0.1.3 baseline tag does not match baseline_source_sha.");
    expect(source).toContain("git rev-parse HEAD");
    expect(source).toContain("refs/tags/v0.1.3-transition.1");
    expect(source).toContain("git rev-parse \"refs/tags/");
    expect(source).toContain("The transition tag ref does not match transition_source_sha.");
    expect(source).toContain("transition_candidate_confirmation");
  });

  test("uses a separate immutable release-tooling checkout without replacing the package source", async () => {
    const source = await readWorkflowSource();

    expect(source).toContain("release_tooling_sha");
    expect(source).toContain("path: .trio-release-tooling");
    expect(source).toContain("RELEASE_TOOLING_SHA");
    expect(source).toContain("git -C .trio-release-tooling rev-parse HEAD");
    expect(source).toContain("releaseToolingSha");
    expect(source).toContain("releaseToolingPath");
    expect(source).toContain("The pinned release tooling checkout does not match release_tooling_sha.");
    expect(source).toContain("The pinned release tooling checkout is incomplete.");
    expect(source).toContain("The pinned js-yaml dependency is missing.");
    expect(source).toContain("Push-Location $toolingPath");
    expect(source).toContain("Pop-Location");
    expect(source).toContain("node $toolingPath/scripts/release-channel-policy.mjs");
    expect(source).toContain("$toolingPath/scripts/verify-windows-signing.ps1");
    expect(source).toContain("$toolingPath/scripts/verify-packaged-pretendard.mjs");
    expect(source).not.toMatch(/ref:\s+main\b/u);
  });

  test("fails closed at the dual-checkout provenance boundary", async () => {
    const source = await readWorkflowSource();

    expect(source).toContain("if ($env:RELEASE_TOOLING_SHA -notmatch '^[0-9a-fA-F]{40}$')");
    expect(source).toContain("if ($toolingHead -cne $env:RELEASE_TOOLING_SHA.ToLowerInvariant())");
    expect(source).toContain("if (-not (Test-Path -LiteralPath $toolingYamlModule -PathType Leaf)) { throw 'The pinned js-yaml dependency is missing.' }");
    expect(source).toContain("if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw 'The pinned release tooling checkout is incomplete.' }");
    expect(source).toContain("Push-Location $env:GITHUB_WORKSPACE");
    expect(source).toContain("releaseToolingSha = $env:RELEASE_TOOLING_SHA");
    expect(source).toContain("releaseToolingPath = '.trio-release-tooling'");

    expect(source).not.toMatch(/\n\s*run:\s+\.\/scripts\/setup-esigner-cka\.ps1\s*$/mu);
    expect(source).not.toMatch(/\n\s*node scripts\/verify-packaged-pretendard\.mjs\b/mu);
    expect(source).not.toMatch(/\n\s*\.\/scripts\/verify-windows-signing\.ps1\b/mu);
    expect(source).not.toMatch(/path:\s*\.\s*\r?\n/u);
    expect(source).not.toMatch(/ref:\s+main\b/u);
  });

  test("fails closed when the fixed candidate release or metadata is missing or mismatched", async () => {
    const source = await readWorkflowSource();

    expect(source).toContain("Invoke-RestMethod");
    expect(source).toContain("Invoke-WebRequest");
    expect(source).toContain("latest.yml");
    expect(source).toContain("yaml.load");
    expect(source).toContain("json: false");
    expect(source).toContain("schema: yaml.JSON_SCHEMA");
    expect(source).toContain("Object.keys(root)");
    expect(source).toContain("root.files.length !== 1");
    expect(source).toContain("packages");
    expect(source).toContain("Get-FileHash -LiteralPath");
    expect(source).toContain("-Algorithm SHA256");
    expect(source).toContain("-Algorithm SHA512");
    expect(source).toContain("scripts/verify-windows-signing.ps1");
    expect(source).toContain("-NsisInstaller $installerPath");
    expect(source).toContain("-ExpectedPublisherSubject");
    expect(source).not.toContain("Get-AuthenticodeSignature");
    expect(source).toContain("release.tag_name");
    expect(source).toContain("release.draft");
    expect(source).toContain("release.prerelease");
    expect(source).toContain("The transition candidate metadata version does not match v0.1.4-preview.1.");
    expect(source).toContain("The transition candidate installer digest does not match latest.yml.");
    expect(source).toContain("The transition candidate signing evidence is incomplete.");
    expect(source).toContain("candidateMetadataSha256");
    expect(source).toContain("candidateMetadataSize");
    expect(source).toContain("candidateInstallerSha256");
    expect(source).toContain("candidateBlockmapSha256");
    expect(source).toContain("candidateBlockmapSha512");
    expect(source).toContain("candidateBlockmapSize");
    expect(source).toContain("candidateAuthenticodeChainValid");
  });

  test("passes publish never at the electron-builder boundary", async () => {
    const source = await readWorkflowSource();

    expect(source).toContain("npx --no-install electron-builder --win nsis --x64 --publish never");
    expect(source).not.toContain("npm.cmd run dist:win");
  });

  test("requires the exact preview candidate run and private evidence digest", async () => {
    const workflow = await readWorkflow();
    const on = getWorkflowOn(workflow);
    const dispatch = expectRecord(on.workflow_dispatch);
    const inputs = expectRecord(dispatch.inputs);
    const transitionJob = expectRecord(expectRecord(workflow.jobs)["transition-package"]);
    const jobPermissions = expectRecord(transitionJob.permissions);
    const source = await readWorkflowSource();

    expect(expectRecord(inputs.preview_candidate_run_id).required).toBe(true);
    expect(expectRecord(inputs.preview_evidence_sha256).required).toBe(true);
    expect(expectRecord(inputs.release_tooling_sha).required).toBe(true);
    expect(jobPermissions).toEqual({ actions: "read", contents: "read" });
    expect(source).toContain("preview_candidate_run_id");
    expect(source).toContain("preview_evidence_sha256");
    expect(source).toContain("TRIO_APPROVED_RELEASE_TOOLING_SHA");
    expect(source).toContain("actions: read");
    expect(source).toContain("The approved release tooling SHA is not configured.");
    expect(source).toContain("The preview candidate run ID must be a positive integer.");
    expect(source).toContain("workflow_dispatch");
    expect(source).toContain("conclusion");
    expect(source).toContain("head_sha");
    expect(source).toContain(".github/workflows/package-release.yml");
    expect(source).toContain("expired");
    expect(source).toContain("workflow_run.id");
    expect(source).toContain("artifact-ids");
    expect(source).toContain("preview_evidence_sha256");
    expect(source).toContain("transition-candidate-evidence.sha256");
    expect(source).toContain("transition-candidate-evidence.json");
    expect(source).toContain("before reading private candidate evidence");
    expect(source).not.toMatch(/download-artifact[\s\S]*pattern:/u);
    expect(source).not.toMatch(/actions\/runs\/(?:\$\{\{|\$env:).*artifacts.*latest/iu);
  });

  test("downloads the exact artifact by ID without mutually exclusive name or pattern inputs", async () => {
    const workflow = await readWorkflow();
    const jobs = expectRecord(workflow.jobs);
    const transitionJob = expectRecord(jobs["transition-package"]);
    const steps = transitionJob.steps;
    expect(Array.isArray(steps)).toBe(true);
    const downloadStep = (steps as Array<UnknownRecord>).find((step) =>
      String(step.name).includes("Download the exact preview candidate artifact by ID")
    );
    expect(downloadStep).toBeDefined();
    const downloadWith = expectRecord(expectRecord(downloadStep).with);

    expect(downloadWith["artifact-ids"]).toBe("${{ env.PREVIEW_ARTIFACT_ID }}");
    expect(downloadWith.name).toBeUndefined();
    expect(downloadWith.pattern).toBeUndefined();
  });

  test("rejects a zero-size updater asset in the executable private-evidence policy", async () => {
    const policy = extractAssetSizePolicy(await readPrivateEvidenceValidationRun());
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$expectedAssetNames = @('latest.yml', 'Trio-Setup-0.1.4-preview.1.exe', 'Trio-Setup-0.1.4-preview.1.exe.blockmap')",
      "$privateAssets = @([pscustomobject]@{ name = 'latest.yml'; size = 0; sha256 = ('a' * 64); sha512 = ('b' * 88) })",
      policy,
      "Write-Output 'zero-size-accepted'"
    ].join("\n");

    await expect(
      execFile(pwshCmd, ["-NoLogo", "-NoProfile", "-Command", script], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      })
    ).rejects.toThrow(/invalid updater asset record/i);
  });

  test("binds release-tooling SHA to approval, run head, and private evidence source", async () => {
    const source = await readWorkflowSource();

    expect(source).toContain("if ($env:RELEASE_TOOLING_SHA -cne $env:APPROVED_RELEASE_TOOLING_SHA.ToLowerInvariant())");
    expect(source).toContain("if ($run.head_sha -cne $env:RELEASE_TOOLING_SHA.ToLowerInvariant())");
    expect(source).toContain("if ($privateEvidence.sourceSha -cne $env:RELEASE_TOOLING_SHA.ToLowerInvariant())");
    expect(source).toContain("if ($env:PREVIEW_EVIDENCE_SHA256 -cne $sidecarDigest)");
    expect(source).toContain("The private preview evidence digest does not match preview_evidence_sha256.");
    expect(source).toContain("The private preview evidence source SHA does not match release_tooling_sha.");
  });

  test("executes public/private asset byte policy for matching and each mismatch", async () => {
    const policy = extractPublicAssetPolicy(await readPublicAssetValidationRun());
    const directory = await mkdtemp(join(tmpdir(), "trio-public-asset-policy-"));
    const publicPath = join(directory, "asset.bin");
    const bytes = Buffer.from("public downloaded updater bytes\n", "utf8");
    await writeFile(publicPath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex").toLowerCase();
    const sha512 = createHash("sha512").update(bytes).digest("base64");
    const matchingRecord = { name: "asset.bin", size: bytes.byteLength, sha256, sha512 };

    try {
      const matchingResult = await executePublicAssetPolicy(policy, publicPath, matchingRecord);
      expect(matchingResult.stdout).toContain("public-policy-ok");

      const mismatches = [
        { label: "name", ...matchingRecord, name: "other.bin" },
        { label: "positive size", ...matchingRecord, size: 0 },
        { label: "positive unequal size", ...matchingRecord, size: bytes.byteLength + 1 },
        { label: "SHA-256", ...matchingRecord, sha256: `${sha256.slice(0, -1)}${sha256.endsWith("0") ? "1" : "0"}` },
        { label: "SHA-512", ...matchingRecord, sha512: `${sha512.slice(0, -1)}${sha512.endsWith("A") ? "B" : "A"}` }
      ];
      for (const mismatch of mismatches) {
        await expect(executePublicAssetPolicy(policy, publicPath, mismatch)).rejects.toThrow(/public preview asset|asset/i);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  test("orders source/tooling integrity around install, build, signing, smoke and evidence upload", async () => {
    const workflow = await readWorkflow();
    const jobs = expectRecord(workflow.jobs);
    const transitionJob = expectRecord(jobs["transition-package"]);
    const steps = transitionJob.steps;
    expect(Array.isArray(steps)).toBe(true);
    const parsedSteps = steps as Array<UnknownRecord>;
    const stepIndex = (name: string): number => parsedSteps.findIndex((step) => String(step.name) === name);
    const baselineIndex = stepIndex("Verify transition source and tooling integrity before install/build");
    const candidateIndex = stepIndex("Verify the fixed preview Release, latest.yml, bytes and publisher");
    const installIndex = stepIndex("Install dependencies and run updater policy regression");
    const buildIndex = stepIndex("Build the signed transition NSIS package without publishing");
    const signingIndex = stepIndex("Verify Authenticode and packaged transition resources");
    const smokeIndex = stepIndex("Run packaged smoke test");
    const finalIndex = stepIndex("Verify source and tooling integrity after build/signing/Pretendard/package smoke");
    const evidenceIndex = stepIndex("Write sanitized transition evidence");
    const uploadIndex = stepIndex("Upload private transition QA evidence and signed installer");
    for (const index of [baselineIndex, candidateIndex, installIndex, buildIndex, signingIndex, smokeIndex, finalIndex, evidenceIndex, uploadIndex]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(baselineIndex).toBeLessThan(candidateIndex);
    expect(baselineIndex).toBeLessThan(installIndex);
    expect(installIndex).toBeLessThan(buildIndex);
    expect(installIndex).toBeLessThan(candidateIndex);
    expect(candidateIndex).toBeLessThan(buildIndex);
    expect(buildIndex).toBeLessThan(signingIndex);
    expect(signingIndex).toBeLessThan(smokeIndex);
    expect(smokeIndex).toBeLessThan(finalIndex);
    expect(finalIndex).toBeLessThan(evidenceIndex);
    expect(evidenceIndex).toBeLessThan(uploadIndex);

    const baselineRun = String(expectRecord(parsedSteps[baselineIndex]).run);
    const finalRun = String(expectRecord(parsedSteps[finalIndex]).run);
    expect(baselineRun).toContain("scripts/verify-git-source-integrity.mjs");
    expect(baselineRun).toContain("source-integrity-before.json");
    expect(baselineRun).toContain("tooling-integrity-before.json");
    expect(finalRun).toContain("scripts/verify-git-source-integrity.mjs");
    expect(finalRun).toContain("source-integrity-after.json");
    expect(finalRun).toContain("tooling-integrity-after.json");
  });
});
