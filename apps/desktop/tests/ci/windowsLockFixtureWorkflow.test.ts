import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

type YamlParser = {
  load(source: string): unknown;
};

type UnknownRecord = Record<string, unknown>;

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as YamlParser;
const WORKFLOW_PATH = resolve(
  process.cwd(),
  ".github/workflows/windows-lock-fixture.yml",
);
const PRODUCT_PATH = "src/main/resourcePackInstaller.ts";
const FIXTURE_PATH = "tests/main/resourcePackInstaller.test.ts";
const WORKFLOW_SOURCE_PATH = ".github/workflows/windows-lock-fixture.yml";
const FOCUSED_COMMAND =
  "npm.cmd test -- tests/main/resourcePackInstaller.test.ts --reporter=dot";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown): UnknownRecord {
  expect(isRecord(value)).toBe(true);
  return value as UnknownRecord;
}

async function readWorkflow(): Promise<{
  document: UnknownRecord;
  source: string;
}> {
  const source = await readFile(WORKFLOW_PATH, "utf8");
  return {
    document: expectRecord(yaml.load(source)),
    source,
  };
}

describe("Windows lock fixture workflow policy", () => {
  test("validates relevant pull requests and supports manual dispatch", async () => {
    const { document } = await readWorkflow();
    const triggers = expectRecord(document.on);
    const pullRequest = expectRecord(triggers.pull_request);
    const paths = pullRequest.paths;

    expect(triggers.workflow_dispatch).toBeDefined();
    expect(Array.isArray(paths)).toBe(true);
    expect(paths).toEqual(
      expect.arrayContaining([
        PRODUCT_PATH,
        FIXTURE_PATH,
        WORKFLOW_SOURCE_PATH,
      ]),
    );
  });

  test("runs the focused fixture before the required full suite on Node 22", async () => {
    const { document, source } = await readWorkflow();
    const jobs = expectRecord(document.jobs);
    const jobNames = Object.keys(jobs);
    expect(jobNames).toHaveLength(1);

    const job = expectRecord(jobs[jobNames[0]]);
    expect(job["runs-on"]).toBe("windows-latest");
    const steps = job.steps;
    expect(Array.isArray(steps)).toBe(true);

    const stepRecords = (steps as unknown[]).map(expectRecord);
    const setupNodeStep = stepRecords.find((step) =>
      typeof step.uses === "string" &&
      (step.uses as string).startsWith("actions/setup-node@"),
    );
    expect(setupNodeStep).toBeDefined();
    const setupNodeWith = expectRecord(setupNodeStep?.with);
    expect(String(setupNodeWith["node-version"])).toMatch(/^22(?:\.|$)/);

    const commandSteps = stepRecords.filter((step) => typeof step.run === "string");
    const installIndex = commandSteps.findIndex((step) => step.run === "npm.cmd ci");
    const focusedIndex = commandSteps.findIndex(
      (step) => step.run === FOCUSED_COMMAND,
    );
    const fullSuiteIndex = commandSteps.findIndex(
      (step) => step.run === "npm.cmd test",
    );

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(focusedIndex).toBeGreaterThan(installIndex);
    expect(fullSuiteIndex).toBeGreaterThan(focusedIndex);
    expect(commandSteps[focusedIndex].shell).toBe("pwsh");
    expect(commandSteps[fullSuiteIndex].shell).toBe("pwsh");
    expect(commandSteps[focusedIndex]["continue-on-error"]).toBeUndefined();
    expect(commandSteps[fullSuiteIndex]["continue-on-error"]).toBeUndefined();

    expect(source).not.toMatch(/\bsecrets\./i);
    expect(source).not.toMatch(/[A-Za-z]:\\Users\\|\/Users\//i);
  });
});
