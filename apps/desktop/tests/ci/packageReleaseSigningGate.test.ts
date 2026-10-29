import { createRequire } from "node:module";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

type UnknownRecord = Record<string, unknown>;
type YamlParser = { load(source: string): unknown };

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlParser;
const WORKFLOW_PATH = resolve(process.cwd(), ".github/workflows/package-release.yml");
const execFile = promisify(execFileCallback);
const POWERSHELL_TEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown): UnknownRecord {
  expect(isRecord(value)).toBe(true);
  return value as UnknownRecord;
}

async function readWorkflow(): Promise<UnknownRecord> {
  return expectRecord(yaml.load(await readFile(WORKFLOW_PATH, "utf8")));
}

async function readSource(): Promise<string> {
  return readFile(WORKFLOW_PATH, "utf8");
}

function dedent(value: string): string {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  const indentation = Math.min(
    ...lines
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^\s*/u)?.[0].length ?? 0)
  );
  return lines.map((line) => line.slice(indentation)).join("\n");
}

async function readPreviewEvidenceScript(): Promise<string> {
  const workflow = await readWorkflow();
  const jobs = expectRecord(workflow.jobs);
  const previewJob = expectRecord(jobs["preview-transition-candidate"]);
  const steps = previewJob.steps;
  expect(Array.isArray(steps)).toBe(true);
  const evidenceStep = (steps as Array<UnknownRecord>).find((step) =>
    String(step.name).includes("Verify exact latest.yml, installer and blockmap")
  );
  expect(evidenceStep).toBeDefined();
  const run = String(expectRecord(evidenceStep).run);
  const match = run.match(/\$evidenceScript = @'\n([\s\S]*?)\n\s*'@/u);
  expect(match).not.toBeNull();
  return dedent(match?.[1] ?? "");
}

async function executeEvidenceScript(
  evidenceScript: string,
  directory: string,
  outputName: string,
  sidecarName: string,
  metadataName = "latest.yml"
): Promise<void> {
  await execFile("node", [
    "--input-type=module",
    "-e",
    evidenceScript,
    "--",
    join(directory, outputName),
    join(directory, sidecarName),
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "0.1.4-preview.1",
    "v0.1.4-preview.1",
    join(directory, metadataName),
    join(directory, "installer.exe"),
    join(directory, "installer.exe.blockmap"),
    "tooling.txt"
  ], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
}

async function readPreviewDigestGuard(): Promise<string> {
  const workflow = await readWorkflow();
  const jobs = expectRecord(workflow.jobs);
  const previewJob = expectRecord(jobs["preview-transition-candidate"]);
  const steps = previewJob.steps;
  expect(Array.isArray(steps)).toBe(true);
  const evidenceStep = (steps as Array<UnknownRecord>).find((step) =>
    String(step.name).includes("Verify exact latest.yml, installer and blockmap")
  );
  expect(evidenceStep).toBeDefined();
  const run = String(expectRecord(evidenceStep).run);
  const match = run.match(/(foreach \(\$digest in @\([\s\S]*?\n\s*\}\s*)\n\s*\$toolingFiles/u);
  expect(match).not.toBeNull();
  return dedent(match?.[1] ?? "");
}

function getWorkflowOn(workflow: UnknownRecord): UnknownRecord {
  return expectRecord(workflow.on ?? workflow["true"]);
}

describe("private-source candidate workflow", () => {
  test("excludes macOS from current MVP QA and stable jobs", async () => {
    const jobs = expectRecord((await readWorkflow()).jobs);
    const matrix = expectRecord(expectRecord(expectRecord(jobs["qa-package"]).strategy).matrix);
    expect((matrix.include as UnknownRecord[]).map((entry) => entry.runner)).toEqual(["windows-latest", "ubuntu-latest"]);
    expect(jobs["stable-macos"]).toBeUndefined();
    expect(await readSource()).not.toMatch(/macos-|--mac|APPLE_|TRIO_MAC_|latest-mac/iu);
  });

  test("is manual-only for stable candidates and keeps read-only default permissions", async () => {
    const workflow = await readWorkflow();
    const on = getWorkflowOn(workflow);
    const dispatch = expectRecord(on.workflow_dispatch);
    const inputs = expectRecord(dispatch.inputs);
    const mode = expectRecord(inputs.mode);
    const expectedSourceSha = expectRecord(inputs.expected_source_sha);
    const confirmation = expectRecord(inputs.confirmation);

    expect(on.workflow_dispatch).toBeDefined();
    expect(mode.type).toBe("choice");
    expect(mode.options).toEqual([
      "qa",
      "stable-candidate",
      "preview-transition-candidate"
    ]);
    expect(expectedSourceSha.required).toBe(true);
    expect(confirmation.required).toBe(true);
    expect(confirmation.default).toBe("BUILD v0.1.4 CANDIDATE");
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("has QA and all stable platform/evidence dependencies", async () => {
    const workflow = await readWorkflow();
    const jobs = expectRecord(workflow.jobs);
    for (const jobName of [
      "qa-package",
      "stable-windows",
      "stable-linux",
      "assemble-candidate"
    ]) {
      expect(jobs[jobName]).toBeDefined();
    }

    const assembly = expectRecord(jobs["assemble-candidate"]);
    expect(assembly.needs).toEqual([
      "stable-windows",
      "stable-linux"
    ]);
    expect(assembly.if).toContain("stable-candidate");
  });

  test("contains no release mutation, public token, wildcard publication, or masked gate", async () => {
    const source = await readSource();
    expect(source).not.toMatch(/gh\s+release\s+(?:create|upload|edit)/u);
    expect(source).not.toContain("contents: write");
    expect(source).not.toContain("release-assets/*");
    expect(source).not.toContain("release-assets\\*");
    expect(source).not.toContain("continue-on-error");
    expect(source).not.toMatch(/uses:\s+[^\s@]+@(?![0-9a-f]{40}\b)/giu);
    expect(source).toContain("BUILD v0.1.4 CANDIDATE");
    expect(source).toContain("expected_source_sha");
    expect(source).toContain("stable-release");
  });

  test("does not upload Linux updater metadata and names private artifacts explicitly", async () => {
    const source = await readSource();
    const linuxSection = source.slice(source.indexOf("stable-linux:"), source.indexOf("assemble-candidate:"));
    expect(linuxSection).toContain("Trio-0.1.4.AppImage");
    expect(linuxSection).not.toContain("latest-linux.yml");
    expect(linuxSection).not.toContain(".blockmap");
    expect(source).toContain("if-no-files-found: error");
    const expectedCandidateArtifactName =
      "trio-stable-candidate-${{ github.sha }}-${{ github.run_id }}";
    expect(source).toContain(`name: ${expectedCandidateArtifactName}`);
    expect(source).toContain(`artifact name: ${expectedCandidateArtifactName}`);
    expect(source).not.toContain("name: candidate-${{ github.sha }}-${{ github.run_id }}");
    expect(source).not.toContain("artifact name: candidate-${{ github.sha }}-${{ github.run_id }}");
  });

  test("does not expose stable secrets to pull request or main QA jobs", async () => {
    const source = await readSource();
    const qaStart = source.indexOf("qa-package:");
    const previewStart = source.indexOf("preview-transition-candidate:");
    const windowsStart = source.indexOf("stable-windows:");
    expect(qaStart).toBeGreaterThanOrEqual(0);
    expect(previewStart).toBeGreaterThan(qaStart);
    expect(windowsStart).toBeGreaterThan(qaStart);
    const qaSection = source.slice(qaStart, previewStart);
    expect(qaSection).not.toContain("secrets.");
    expect(qaSection).not.toContain("stable-release");
    expect(qaSection).not.toContain("TRIO_ESIGNER");
    expect(qaSection).not.toContain("APPLE_");
  });

  test("assembles exact Windows assets while preserving the existing Linux policy", async () => {
    const source = await readSource();
    const assembly = source.slice(source.indexOf("assemble-candidate:"));
    expect(assembly).toContain("candidate-assets/Trio-Setup-0.1.4.exe.blockmap");
    expect(assembly).toContain("candidate-assets/Trio-0.1.4.AppImage");
    expect(assembly).not.toMatch(/incoming\/macos|latest-mac|Trio-0\.1\.4\.(?:dmg|zip)/u);
  });

  test("binds Pretendard glyph evidence to the packaged verifier", async () => {
    const source = await readSource();
    expect(source).not.toContain("TRIO_PRETENDARD_GLYPH_COVERAGE_VERIFIED");
    expect(source).toContain("verify-packaged-pretendard.mjs");
    expect(source).toContain("pretendard.json");
  });

  test("leaves Task 5A as the sole authoritative candidate file-digest step", async () => {
    const source = await readSource();
    const windowsStart = source.indexOf("stable-windows:");
    const assemblyStart = source.indexOf("assemble-candidate:");
    const uploadStart = source.indexOf("Upload one private candidate artifact");
    const assemblySection = source.slice(assemblyStart);
    expect(windowsStart).toBeGreaterThanOrEqual(0);
    expect(assemblyStart).toBeGreaterThan(windowsStart);
    expect(uploadStart).toBeGreaterThan(assemblyStart);
    expect(assemblySection).toContain("sole authoritative SHA-256");
    expect(assemblySection).toContain("scripts/release-candidate-evidence.mjs create");
    expect(assemblySection).toContain("scripts/release-candidate-evidence.mjs verify");
    expect(assemblySection.indexOf("release-candidate-evidence.mjs create"))
      .toBeLessThan(assemblySection.indexOf("release-candidate-evidence.mjs verify"));
    expect(assemblySection.indexOf("release-candidate-evidence.mjs verify"))
      .toBeLessThan(assemblySection.indexOf("Upload one private candidate artifact"));
    expect(assemblySection).not.toMatch(/\b(?:Get-FileHash|sha256sum|shasum\s+-a\s+256)\b/iu);
  });

  test("provides a private fixed-version preview transition candidate path", async () => {
    const workflow = await readWorkflow();
    const jobs = expectRecord(workflow.jobs);
    const previewJob = expectRecord(jobs["preview-transition-candidate"]);
    const source = await readSource();

    expect(previewJob.if).toContain("preview-transition-candidate");
    expect(source).toContain("preview_version");
    expect(source).toContain("preview_tag");
    expect(source).toContain("0.1.4-preview.1");
    expect(source).toContain("v0.1.4-preview.1");
    expect(source).toContain("Only 0.1.4-preview.1 is supported as the preview candidate version.");
    expect(source).toContain("Only v0.1.4-preview.1 is supported as the preview candidate tag.");
    expect(source).toContain("environment: transition-qa");
    expect(source).toContain("npx --no-install electron-builder --win nsis --x64 --publish never");
    expect(source).toContain("release/latest.yml");
    expect(source).toContain("Trio-Setup-0.1.4-preview.1.exe.blockmap");
  });

  test("records exact preview updater bytes and release-tooling digests in immutable evidence", async () => {
    const source = await readSource();
    const previewSection = source.slice(source.indexOf("preview-transition-candidate:"));

    expect(previewSection).toContain("trio.transition-candidate-evidence.v1");
    expect(previewSection).toContain("updaterAssets");
    expect(previewSection).toContain("releaseToolingFiles");
    expect(previewSection).toContain("transition-candidate-evidence.json");
    expect(previewSection).toContain("transition-candidate-evidence.sha256");
    expect(previewSection).toMatch(/Get-FileHash[\s\S]*-Algorithm SHA256/u);
    expect(previewSection).toMatch(/Get-FileHash[\s\S]*-Algorithm SHA512/u);
    expect(previewSection).toContain("name: trio-preview-transition-candidate-${{ github.sha }}-${{ github.run_id }}");
    expect(previewSection).toContain("retention-days: 30");
    expect(previewSection).not.toContain("gh release");
    expect(previewSection).not.toContain("contents: write");
  });

  test("executes the preview evidence generator and rejects an empty updater asset", async () => {
    const evidenceScript = await readPreviewEvidenceScript();
    const directory = await mkdtemp(join(tmpdir(), "trio-preview-evidence-"));
    await writeFile(join(directory, "latest.yml"), "version: 0.1.4-preview.1\n");
    await writeFile(join(directory, "installer.exe"), "installer bytes\n");
    await writeFile(join(directory, "installer.exe.blockmap"), "blockmap bytes\n");
    await writeFile(join(directory, "tooling.txt"), "tooling bytes\n");

    await executeEvidenceScript(
      evidenceScript,
      directory,
      "evidence.json",
      "evidence.sha256"
    );

    const evidence = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8")) as UnknownRecord;
    expect(evidence.schemaVersion).toBe("trio.transition-candidate-evidence.v1");
    expect(evidence.updaterAssets).toHaveLength(3);
    expect((evidence.updaterAssets as Array<UnknownRecord>).every((asset) => Number(asset.size) > 0)).toBe(true);

    await writeFile(join(directory, "empty-latest.yml"), "");
    await expect(
      executeEvidenceScript(
        evidenceScript,
        directory,
        "empty-evidence.json",
        "empty-evidence.sha256",
        "empty-latest.yml"
      )
    ).rejects.toThrow(/non-empty|empty|asset/i);
  });

  test("executes algorithm-specific SHA-256 and SHA-512 digest validation", async () => {
    const digestGuard = await readPreviewDigestGuard();
    const powershell = [
      "$ErrorActionPreference = 'Stop'",
      "$metadataSha256 = [string]::new('a', 64)",
      "$installerSha256 = [string]::new('b', 64)",
      "$blockmapSha256 = [string]::new('c', 64)",
      "$metadataSha512 = [string]::new('d', 128)",
      "$installerSha512 = [string]::new('e', 128)",
      "$blockmapSha512 = [string]::new('f', 128)",
      digestGuard,
      "Write-Output 'digest-policy-ok'"
    ].join("\n");

    const result = await execFile("pwsh", ["-NoLogo", "-NoProfile", "-Command", powershell], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    expect(result.stdout).toContain("digest-policy-ok");
  }, POWERSHELL_TEST_TIMEOUT_MS);
});
