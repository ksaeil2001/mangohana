import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runCommand = promisify(execFile);
async function withDeadline(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
const hasExited = child => child.exitCode !== null || child.signalCode !== null;
async function observeExit(child, timeoutMs) {
  if (hasExited(child)) return;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
  });
}

// Playwright가 직접 시작한 자식 PID만 정리한다. 명령 응답과 실제 종료는 별개다.
export async function closeOwnedPreviewApp(app, {
  closeTimeoutMs = 7500, killTimeoutMs = 4000, exitTimeoutMs = 2500, runTaskkill = runCommand,
} = {}) {
  const child = app.process();
  let forceRequested = false;
  let commandError;
  try {
    await withDeadline(() => app.close(), closeTimeoutMs, 'owned app close deadline');
  } catch {
    if (!hasExited(child)) {
      forceRequested = true;
      try {
        await withDeadline(() => runTaskkill('C:\\Windows\\System32\\taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: killTimeoutMs }),
        killTimeoutMs, 'owned taskkill deadline');
      } catch (error) { commandError = error.message; }
    }
  }
  await observeExit(child, exitTimeoutMs);
  const result = { appClosed: hasExited(child), forceRequested, forcedOwnedPid: forceRequested ? child.pid : null };
  if (commandError) result.commandError = commandError;
  if (!result.appClosed) result.error = '소유 앱 종료를 확인하지 못했습니다.';
  return result;
}
