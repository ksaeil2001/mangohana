// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { FatalPreviewError, waitForPreviewResponse } from '../../scripts/local-preview/request-guard.mjs';

function harness(timeoutMs = 20) {
  const controller = new AbortController();
  return { controller, request: operation => waitForPreviewResponse(operation, {
    label: 'synthetic request', timeoutMs, signal: controller.signal, onFatal: error => controller.abort(error),
  }) };
}

describe('검증 응답을 잃은 뒤의 전체 중단', () => {
  it('returns a completed response without cancelling the run', async () => {
    const run = harness();
    await expect(run.request(async () => 'done')).resolves.toBe('done');
    expect(run.controller.signal.aborted).toBe(false);
  });
  it('never starts a later page after an unresolved IPC reaches its deadline', async () => {
    const run = harness();
    await expect(run.request(() => new Promise(() => {}))).rejects.toBeInstanceOf(FatalPreviewError);
    const nextPage = vi.fn();
    await expect(run.request(nextPage)).rejects.toBeInstanceOf(FatalPreviewError);
    expect(nextPage).not.toHaveBeenCalled();
  });
  it('treats unconfirmed OCR release as fatal and blocks the next model', async () => {
    const run = harness();
    await expect(run.request(async () => { throw new Error('IPC: release_unconfirmed'); })).rejects.toBeInstanceOf(FatalPreviewError);
    const nextModel = vi.fn();
    await expect(run.request(nextModel)).rejects.toBeInstanceOf(FatalPreviewError);
    expect(nextModel).not.toHaveBeenCalled();
  });
  it('rejects a pending evaluation when renderer loss aborts the run', async () => {
    const run = harness(1000);
    let started = false;
    const pending = run.request(() => { started = true; return new Promise(() => {}); });
    await Promise.resolve();
    expect(started).toBe(true);
    run.controller.abort(new FatalPreviewError('renderer gone'));
    await expect(pending).rejects.toThrow('renderer gone');
  });
  it('allows later pages after an ordinary completed page failure', async () => {
    const run = harness();
    await expect(run.request(async () => { throw new Error('completed provider failure'); })).rejects.toThrow('completed provider failure');
    expect(run.controller.signal.aborted).toBe(false);
    await expect(run.request(async () => 'next page')).resolves.toBe('next page');
  });
});
