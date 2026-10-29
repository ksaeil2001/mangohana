import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

type UnknownRecord = Record<string, unknown>;
type YamlParser = { load(source: string): unknown };

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlParser;
const WORKFLOW_PATH = resolve(process.cwd(), ".github/workflows/promote-stable.yml");
const TEMPLATE_PATH = resolve(process.cwd(), "docs/workflow-examples/trio-releases-attest.yml");
const ENVIRONMENT_DOC_PATH = resolve(process.cwd(), "docs/operations/github-app-and-stable-environment-setup.md");

async function readWorkflowSource(): Promise<string> {
  return (await readFile(WORKFLOW_PATH, "utf8")).replace(/\r\n/g, "\n");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): UnknownRecord {
  expect(isRecord(value)).toBe(true);
  return value as UnknownRecord;
}

function getOn(workflow: UnknownRecord): UnknownRecord {
  return record(workflow.on ?? workflow["true"]);
}

const ANONYMOUS_STEP_NAME = "Anonymous release verification and rollback published release to draft in the same step";

function getPromotionStepRun(source: string, stepName: string): string {
  const workflow = record(yaml.load(source));
  const jobs = record(workflow.jobs);
  const promotion = record(jobs["stable-promotion"]);
  const steps = promotion.steps;
  expect(Array.isArray(steps)).toBe(true);
  const step = (steps as unknown[]).map(record).find((candidate) => candidate.name === stepName);
  expect(step).toBeDefined();
  expect(typeof step?.run).toBe("string");
  return String(step?.run ?? "");
}

function getPromotionStepIndex(source: string, stepName: string): number {
  const workflow = record(yaml.load(source));
  const jobs = record(workflow.jobs);
  const promotion = record(jobs["stable-promotion"]);
  const steps = promotion.steps;
  expect(Array.isArray(steps)).toBe(true);
  const index = (steps as unknown[]).findIndex((value) => record(value).name === stepName);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function assertAnonymousPromotionOrder(source: string): void {
  const run = getPromotionStepRun(source, ANONYMOUS_STEP_NAME);
  const metadataPolicyIndex = run.indexOf("node scripts/stable-promotion-policy.mjs release-metadata");
  const assetRecordIndex = run.indexOf("validateReleaseAssetRecords", metadataPolicyIndex);
  const anonymousDownloadIndex = run.indexOf(
    "while IFS=$'\\t' read -r name expected_size browser_download_url; do",
    assetRecordIndex
  );
  const downloadCompleteIndex = run.indexOf("done < anonymous-asset-map.tsv", anonymousDownloadIndex);
  const byteLengthIndex = run.indexOf(
    "Anonymous asset byte length does not match candidate/API size:",
    downloadCompleteIndex
  );
  const candidateEvidenceIndex = run.indexOf(
    "node scripts/release-candidate-evidence.mjs verify",
    byteLengthIndex
  );
  const stablePolicyIndex = run.indexOf(
    "node scripts/stable-promotion-policy.mjs assets",
    candidateEvidenceIndex
  );
  const promotionOkMatches = run.match(/PROMOTION_OK=1/g) ?? [];
  const promotionOkIndex = run.indexOf("PROMOTION_OK=1");
  const indexes = [
    metadataPolicyIndex,
    assetRecordIndex,
    anonymousDownloadIndex,
    downloadCompleteIndex,
    byteLengthIndex,
    candidateEvidenceIndex,
    stablePolicyIndex,
    promotionOkIndex
  ];
  expect(indexes.every((index) => index >= 0)).toBe(true);
  expect(promotionOkMatches).toHaveLength(1);
  expect(indexes).toEqual([...indexes].sort((left, right) => left - right));

  const anonymousStepIndex = getPromotionStepIndex(source, ANONYMOUS_STEP_NAME);
  const provenanceStepName = "Dispatch public provenance workflow with the exact payload";
  const provenanceStepIndex = getPromotionStepIndex(source, provenanceStepName);
  expect(provenanceStepIndex).toBeGreaterThan(anonymousStepIndex);
  expect(getPromotionStepRun(source, provenanceStepName)).toContain(
    "gh api --method POST \"repos/$DELIVERY_REPOSITORY/dispatches\""
  );
}

function assertAnonymousRollbackContract(source: string): void {
  const run = getPromotionStepRun(source, ANONYMOUS_STEP_NAME);
  const trapMatches = run.match(/^\s*trap rollback_published_release EXIT\s*$/gmu) ?? [];
  expect(trapMatches).toHaveLength(1);
  const handlerStart = run.indexOf("rollback_published_release() {");
  const trapIndex = run.indexOf("trap rollback_published_release EXIT");
  const anonymousFetchIndex = run.indexOf(
    "https://api.github.com/repos/$DELIVERY_REPOSITORY/releases/tags/$PROMOTION_TAG"
  );
  const metadataPolicyIndex = run.indexOf("node scripts/stable-promotion-policy.mjs release-metadata");
  expect(handlerStart).toBeGreaterThanOrEqual(0);
  expect(trapIndex).toBeGreaterThan(handlerStart);
  expect(trapIndex).toBeGreaterThanOrEqual(0);
  expect(trapIndex).toBeLessThan(anonymousFetchIndex);
  expect(trapIndex).toBeLessThan(metadataPolicyIndex);
  const handler = run.slice(handlerStart, trapIndex);
  expect(handler).toContain('local status="$?"');
  expect(handler).toContain(
    'gh api --method PATCH "repos/$DELIVERY_REPOSITORY/releases/$RELEASE_ID" -F draft=true > /dev/null'
  );
  expect(handler).toContain("manual intervention is required.");
  expect(handler).toContain('exit "$status"');
}

describe("stable promotion workflow contract", () => {
  test("is manual-only and has read-only source permissions", async () => {
    const source = await readWorkflowSource();
    const workflow = record(yaml.load(source));
    const on = getOn(workflow);
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    const dispatch = record(on.workflow_dispatch);
    const inputs = record(dispatch.inputs);
    for (const name of ["candidate_run_id", "tag", "evidence_sha256", "confirmation"]) {
      expect(record(inputs[name]).required).toBe(true);
    }
    expect(record(inputs.tag).default).toBe("v0.1.4");
    expect(record(inputs.confirmation).default).toBe("PUBLISH v0.1.4");
    expect(record(workflow.permissions)).toEqual({ contents: "read", actions: "read" });
  });

  test("validates before the stable environment and App token, then follows draft/verify/publish/anonymous/rollback order", async () => {
    const source = await readWorkflowSource();
    const workflow = record(yaml.load(source));
    const jobs = record(workflow.jobs);
    expect(jobs.preflight).toBeDefined();
    const promotion = record(jobs["stable-promotion"]);
    expect(promotion.needs).toEqual("preflight");
    expect(promotion.environment).toBe("stable-release");
    const indices = [
      source.indexOf("stable-promotion-policy.mjs inputs"),
      source.indexOf("stable-promotion-policy.mjs run"),
      source.indexOf("stable-promotion-policy.mjs artifacts"),
      source.indexOf("release-candidate-evidence.mjs verify"),
      source.indexOf("actions/create-github-app-token@"),
      source.indexOf("Create draft release"),
      source.indexOf("Upload exact validated assets"),
      source.indexOf("Authenticated re-query and re-download"),
      source.indexOf("Publish exact draft release"),
      source.indexOf("Anonymous release verification"),
      source.indexOf("Rollback published release to draft")
    ];
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(source).not.toContain("continue-on-error");
    expect(source).not.toMatch(/release-assets[\\/*]/u);
    expect(source).not.toMatch(/generate_release_notes:\s*true/u);
    expect(source).toContain("-F draft=false");
    expect(source).toContain("-F draft=true");
    expect(source).not.toMatch(/-f\s+draft=/u);
    expect(source).toContain("assetRecords");
    expect(source).toContain("browser_download_url");
    expect(source).toContain("byte length");
    expect(source).toContain("validateReleaseMetadata");
    expect((source.match(/validateReleaseMetadata/gu) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("expectedBody");
    expect(source).toContain('readFile("candidate-assets/RELEASE_NOTES.md", "utf8")');
    expect(source).not.toContain("cat candidate-assets/RELEASE_NOTES.md");
    const authenticatedMapStart = source.indexOf("const orderedRecords = expectedRecords");
    const authenticatedMapEnd = source.indexOf('await writeFile("authenticated-api-asset-records.json"', authenticatedMapStart);
    expect(authenticatedMapStart).toBeGreaterThanOrEqual(0);
    expect(authenticatedMapEnd).toBeGreaterThan(authenticatedMapStart);
    const authenticatedMapBlock = source.slice(authenticatedMapStart, authenticatedMapEnd);
    expect(authenticatedMapBlock.match(/\.map\(/gu) ?? []).toHaveLength(1);
    expect(authenticatedMapBlock).toContain("const assetLines = orderedRecords.map(({ name, size }) => {");
    expect(authenticatedMapBlock).toContain("return `${name}\\t${asset.id}\\t${size}`;");
    expect(authenticatedMapBlock).toContain("if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0)");
    expect(authenticatedMapBlock).not.toMatch(/\.map\([\s\S]*?\)\s*\.map\(/u);
    expect((source.match(/echo "### Stable promotion preflight"/gu) ?? []).length).toBe(1);
  });

  test("validates exact anonymous metadata through the reusable policy before anonymous assets", async () => {
    const source = await readWorkflowSource();
    const anonymousStart = source.indexOf("Anonymous release verification and rollback published release to draft");
    const provenanceStart = source.indexOf("Dispatch public provenance workflow", anonymousStart);
    expect(anonymousStart).toBeGreaterThanOrEqual(0);
    expect(provenanceStart).toBeGreaterThan(anonymousStart);
    const anonymousBlock = source.slice(anonymousStart, provenanceStart);
    const metadataPolicyIndex = anonymousBlock.indexOf("stable-promotion-policy.mjs release-metadata");
    const assetRecordIndex = anonymousBlock.indexOf("validateReleaseAssetRecords");
    const anonymousDownloadIndex = anonymousBlock.indexOf("anonymous-assets");
    const promotionOkIndex = anonymousBlock.indexOf("PROMOTION_OK=1");
    expect(metadataPolicyIndex).toBeGreaterThanOrEqual(0);
    expect(assetRecordIndex).toBeGreaterThan(metadataPolicyIndex);
    expect(anonymousDownloadIndex).toBeGreaterThan(assetRecordIndex);
    expect(promotionOkIndex).toBeGreaterThan(anonymousDownloadIndex);
    expect(anonymousBlock).toContain("--metadata anonymous-release.json");
    expect(anonymousBlock).toContain("--expected-body-path candidate-assets/RELEASE_NOTES.md");
    expect(anonymousBlock).toContain("--tag \"$PROMOTION_TAG\"");
    expect(anonymousBlock).toContain("--version \"$STABLE_VERSION\"");
    expect(anonymousBlock).toContain("--expected-draft false");
    expect(anonymousBlock).not.toContain("Anonymous Release metadata is not exact.");
  });

  test("rejects anonymous promotion-order and rollback-trap mutations", async () => {
    const source = await readWorkflowSource();
    expect(() => assertAnonymousPromotionOrder(source)).not.toThrow();
    expect(() => assertAnonymousRollbackContract(source)).not.toThrow();

    const earlyPromotion = source.replace(
      "          mkdir -p anonymous-assets\n",
      "          mkdir -p anonymous-assets\n          PROMOTION_OK=1\n"
    );
    expect(earlyPromotion).not.toBe(source);
    expect(() => assertAnonymousPromotionOrder(earlyPromotion)).toThrow();

    const trapRemoved = source.replace("          trap rollback_published_release EXIT\n", "");
    expect(trapRemoved).not.toBe(source);
    expect(() => assertAnonymousRollbackContract(trapRemoved)).toThrow();

    const trapLate = source
      .replace("          trap rollback_published_release EXIT\n", "")
      .replace("          PROMOTION_OK=1\n", "          trap rollback_published_release EXIT\n          PROMOTION_OK=1\n");
    expect(trapLate).not.toBe(source);
    expect(() => assertAnonymousRollbackContract(trapLate)).toThrow();

    const patchRemoved = source.replace(
      '              if ! gh api --method PATCH "repos/$DELIVERY_REPOSITORY/releases/$RELEASE_ID" -F draft=true > /dev/null; then\n',
      "              if ! echo moved; then\n"
    );
    expect(patchRemoved).not.toBe(source);
    expect(() => assertAnonymousRollbackContract(patchRemoved)).toThrow();
  });

  test("pins every action and scopes the App token to contents write in the delivery repository", async () => {
    const source = await readWorkflowSource();
    expect(source).not.toMatch(/uses:\s+[^\s@]+@(?![0-9a-f]{40}\b)/giu);
    expect(source).toMatch(/actions\/create-github-app-token@[0-9a-f]{40}/u);
    expect(source).toContain("owner: ksaeil2001");
    expect(source).toContain("repositories: trio-releases");
    expect(source).toContain("permission-contents: write");
    expect(source).not.toContain("permission-actions:");
    expect(source).not.toContain("permission-workflows:");
    expect(source).not.toContain("permission-secrets:");
  });

  test("has an exact dispatch allowlist and states the draft anonymous-download limitation", async () => {
    const source = await readWorkflowSource();
    expect(source).toContain("trio-release-published");
    expect(source).toContain("client_payload");
    expect(source).toContain("evidence_sha256");
    expect(source).toContain("source_sha");
    expect(source).toContain("Draft release assets are not anonymously downloadable");
    expect(source).toContain("may be briefly public");
  });
});

describe("public delivery attestation template contract", () => {
  test("uses repository dispatch, minimal public permissions, immutable pins, and explicit subjects", async () => {
    const source = await readFile(TEMPLATE_PATH, "utf8");
    const workflow = record(yaml.load(source));
    const on = getOn(workflow);
    expect(record(on).repository_dispatch).toBeDefined();
    expect(source).toContain("types:");
    expect(source).toContain("trio-release-published");
    expect(source).toContain("id-token: write");
    expect(source).toContain("attestations: write");
    expect(source).toContain("create-storage-record: false");
    expect(source).not.toContain("subject-checksums");
    expect(source).not.toMatch(/subject-path:[^\n]*[*?]/u);
    expect(source).not.toContain("attest-build-provenance");
    expect(source).toMatch(/actions\/attest@[0-9a-f]{40}/u);
    expect(source).not.toMatch(/uses:\s+[^\s@]+@(?![0-9a-f]{40}\b)/giu);
  });

  test("validates the published evidence sidecar and uses exact asset basenames", async () => {
    const source = await readFile(TEMPLATE_PATH, "utf8");
    expect(source).toContain("release-evidence.sha256");
    expect(source).toContain("SHA256SUMS");
    expect(source).toContain("latest.yml");
    expect(source).not.toContain("latest-mac.yml");
    expect(source).toContain("gh attestation verify");
    expect(source).toContain("Trio-Setup-0.1.4.exe");
    expect(source).not.toContain("Trio-0.1.4.dmg");
    expect(source).not.toContain("Trio-0.1.4.zip");
    expect(source).toContain("Trio-0.1.4.AppImage");
    expect(source).not.toMatch(/release-assets[\\/*]/u);
  });

  test("pins setup-node before any Node validation call and binds public API assets", async () => {
    const source = await readFile(TEMPLATE_PATH, "utf8");
    const setupIndex = source.indexOf("actions/setup-node@");
    const firstNodeIndex = source.indexOf("node --input-type=module");
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeLessThan(firstNodeIndex);
    expect(source).toMatch(/actions\/setup-node@[0-9a-f]{40}/u);
    expect(source).toContain("browser_download_url");
    expect(source).toContain("API asset size does not match downloaded byte length");
    expect(source).toContain("canonical release download URL");
    expect(source).toContain('if test "$EXPECTED_TAG" != "v0.1.4" || test "$EXPECTED_VERSION" != "0.1.4"; then');
    const acceptsOtherStableVersion = (tag: string, version: string) =>
      tag === "v0.1.4" && version === "0.1.4";
    expect(acceptsOtherStableVersion("v0.1.3", "0.1.3")).toBe(false);
  });

  test("documents the current one-person two-stage environment contract without reviewer gates", async () => {
    const source = await readFile(ENVIRONMENT_DOC_PATH, "utf8");
    expect(source).toContain("1인 2단계");
    expect(source).toContain("secret scoping");
    expect(source).toContain("현재 v0.1.4 gate가 아님");
    expect(source).toContain("Required reviewers | **현재 사용하지 않음**");
    expect(source).toContain("Prevent self-review | **현재 요구하지 않음**");
    expect(source).not.toMatch(/Prevent self-review.*(?:켜기|활성화|필수)/iu);
    expect(source).not.toMatch(/(?:Required reviewers|required reviewer)[^\n]*(?:필수|차단|Waiting for review|Approve and deploy)/iu);
    expect(source).not.toContain("environment rule | independent reviewer");
  });
});
