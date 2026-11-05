// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOwnedPreviewApp } from '../../scripts/local-preview/app-cleanup.mjs';

const createChild = () => Object.assign(new EventEmitter(), { pid: 1234, exitCode: null, signalCode: null });
const exited = child => { child.exitCode = 0; child.emit('exit', 0); };
const limits = { closeTimeoutMs: 20, killTimeoutMs: 15, exitTimeoutMs: 10 };
afterEach(() => vi.useRealTimers());

describe('검증 앱의 제한된 종료 확인', () => {
  it('records failure after an unresponsive taskkill instead of waiting forever', async () => {
    vi.useFakeTimers();
    const child = createChild();
    const runTaskkill = vi.fn(() => new Promise(() => {}));
    const pending = closeOwnedPreviewApp({ process: () => child, close: () => new Promise(() => {}) }, { ...limits, runTaskkill });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(runTaskkill).toHaveBeenCalledWith('C:\\Windows\\System32\\taskkill.exe', ['/PID', '1234', '/T', '/F'], { windowsHide: true, timeout: 15 });
    expect(result).toMatchObject({ appClosed: false, forceRequested: true, forcedOwnedPid: 1234, commandError: 'owned taskkill deadline', error: '소유 앱 종료를 확인하지 못했습니다.' });
    expect(child.listenerCount('exit')).toBe(0);
  });
  it('observes child exit even when the force command fails', async () => {
    vi.useFakeTimers();
    const child = createChild();
    const pending = closeOwnedPreviewApp({ process: () => child, close: async () => { throw new Error('close failed'); } }, {
      ...limits, runTaskkill: async () => { setTimeout(() => exited(child), 5); throw new Error('command failed'); },
    });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ appClosed: true, forceRequested: true, commandError: 'command failed' });
  });
  it('confirms normal child exit without requesting taskkill', async () => {
    const child = createChild();
    const runTaskkill = vi.fn();
    const result = await closeOwnedPreviewApp({ process: () => child, close: async () => exited(child) }, { ...limits, runTaskkill });
    expect(result).toEqual({ appClosed: true, forceRequested: false, forcedOwnedPid: null });
    expect(runTaskkill).not.toHaveBeenCalled();
  });
});
