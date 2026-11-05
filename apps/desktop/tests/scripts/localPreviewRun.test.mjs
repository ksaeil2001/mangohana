// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

describe('로컬 후보 실행기의 실패 전달', () => {
  for (const [label, pages, status, code] of [
    ['전체 저장', [{ completed: true }, { completed: true }], 'complete', 0],
    ['부분 실패', [{ completed: true }, { completed: false, failure: { stage: 'OCR' } }], 'partial_failure', 2],
    ['전부 실패', [{ completed: false }, { completed: false }], 'failed', 2],
    ['미실행 페이지', [{ completed: true }], 'partial_failure', 2],
  ]) {
    it(label, () => {
      const directory = mkdtempSync(join(tmpdir(), 'mangohana-outcome-'));
      try {
        const file = join(directory, 'report.json');
        writeFileSync(file, JSON.stringify({ expectedInputs: 2, pages }));
        const result = spawnSync(process.execPath, [resolve('scripts/local-preview/run.mjs'), '--check-report', file], { encoding: 'utf8', windowsHide: true });
        expect(result.status, result.stderr).toBe(code);
        expect(JSON.parse(result.stdout).executionStatus).toBe(status);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
  it('does not report success when candidate files exist but app exit is unconfirmed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mangohana-outcome-'));
    try {
      const file = join(directory, 'report.json');
      writeFileSync(file, JSON.stringify({ expectedInputs: 1, pages: [{ completed: true }], cleanup: { appClosed: false } }));
      const result = spawnSync(process.execPath, [resolve('scripts/local-preview/run.mjs'), '--check-report', file], { encoding: 'utf8', windowsHide: true });
      expect(result.status, result.stderr).toBe(2);
      expect(JSON.parse(result.stdout).executionStatus).toBe('partial_failure');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
