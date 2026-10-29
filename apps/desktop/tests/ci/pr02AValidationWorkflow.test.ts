import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

type YamlParser = {
  load(source: string): unknown;
};

type UnknownRecord = Record<string, unknown>;

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as YamlParser;

const WORKFLOW_PATH = resolve(
  process.cwd(),
  '.github/workflows/pr-02-a-validation.yml',
);

const CHECKOUT_ACTION =
  'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd';
const SETUP_NODE_ACTION =
  'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const EXPECTED_COMMANDS = [
  'npm.cmd ci',
  'npm.cmd run typecheck',
  'npm.cmd test',
  'git diff --check',
];
const ALLOWED_CONCURRENCY_EXPRESSION =
  'pr-02-a-${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}';

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown): UnknownRecord {
  expect(isRecord(value)).toBe(true);
  return value as UnknownRecord;
}

function expectExactKeys(record: UnknownRecord, keys: string[]): void {
  expect(Object.keys(record).sort()).toEqual([...keys].sort());
}

function visitRecursively(
  value: unknown,
  visitor: (key: string | undefined, value: unknown) => void,
  key?: string,
): void {
  visitor(key, value);

  if (Array.isArray(value)) {
    for (const item of value) {
      visitRecursively(item, visitor);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      visitRecursively(childValue, visitor, childKey);
    }
  }
}

async function readWorkflow(): Promise<{
  document: UnknownRecord;
  source: string;
}> {
  const source = await readFile(WORKFLOW_PATH, 'utf8');
  return {
    document: expectRecord(yaml.load(source)),
    source,
  };
}

describe('PR 2-A validation workflow policy', () => {
  test('limits execution to secret-free read-only validation', async () => {
    const { document } = await readWorkflow();
    expectExactKeys(document, [
      'name',
      'on',
      'permissions',
      'concurrency',
      'jobs',
    ]);

    const triggers = expectRecord(document.on);
    expectExactKeys(triggers, ['pull_request', 'workflow_dispatch']);

    const permissions = expectRecord(document.permissions);
    expect(permissions).toEqual({ contents: 'read' });

    const concurrency = expectRecord(document.concurrency);
    expectExactKeys(concurrency, ['group', 'cancel-in-progress']);
    expect(concurrency['cancel-in-progress']).toBe(true);
    expect(concurrency.group).toBe(ALLOWED_CONCURRENCY_EXPRESSION);

    visitRecursively(document, (key, value) => {
      expect([
        'env',
        'secrets',
        'if',
        'continue-on-error',
        'environment',
      ]).not.toContain(key);

      if (typeof value === 'string') {
        if (value.includes('${{')) {
          expect(value).toBe(ALLOWED_CONCURRENCY_EXPRESSION);
        }
        expect(value).not.toBe('write');
      }
    });
  });

  test('runs only the approved pinned actions and Windows validation commands', async () => {
    const { document, source } = await readWorkflow();
    const jobs = expectRecord(document.jobs);
    expectExactKeys(jobs, ['validation']);

    const validation = expectRecord(jobs.validation);
    expectExactKeys(validation, [
      'name',
      'runs-on',
      'timeout-minutes',
      'steps',
    ]);
    expect(validation['runs-on']).toBe('windows-latest');
    expect(validation['timeout-minutes']).toBe(30);

    expect(Array.isArray(validation.steps)).toBe(true);
    const steps = validation.steps as unknown[];
    expect(steps).toHaveLength(6);

    const actionSteps = steps.slice(0, 2).map(expectRecord);
    const commandSteps = steps.slice(2).map(expectRecord);

    expectExactKeys(actionSteps[0], ['name', 'uses', 'with']);
    expect(actionSteps[0].uses).toBe(CHECKOUT_ACTION);
    expect(actionSteps[0].with).toEqual({
      'persist-credentials': false,
    });

    expectExactKeys(actionSteps[1], ['name', 'uses', 'with']);
    expect(actionSteps[1].uses).toBe(SETUP_NODE_ACTION);
    expect(actionSteps[1].with).toEqual({
      'node-version': '24.11.1',
      'package-manager-cache': false,
    });

    const actionReferences: string[] = [];
    visitRecursively(document, (key, value) => {
      if (key === 'uses') {
        expect(typeof value).toBe('string');
        actionReferences.push(value as string);
      }
    });
    expect(actionReferences).toEqual([CHECKOUT_ACTION, SETUP_NODE_ACTION]);
    expect(actionReferences).toEqual(
      actionReferences.filter((reference) =>
        /^actions\/[a-z0-9-]+@[0-9a-f]{40}$/.test(reference),
      ),
    );

    for (const step of commandSteps) {
      expectExactKeys(step, ['name', 'run', 'shell']);
      expect(step.shell).toBe('pwsh');
    }
    expect(commandSteps.map((step) => step.run)).toEqual(EXPECTED_COMMANDS);

    expect(source).toMatch(
      /^\s*uses: actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6\.0\.2$/m,
    );
    expect(source).toMatch(
      /^\s*uses: actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6\.4\.0$/m,
    );
  });
});
