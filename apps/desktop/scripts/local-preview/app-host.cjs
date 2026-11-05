const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { createHash } = require('node:crypto');

// 실제 Main과 preload를 그대로 실행하는 격리된 검증 호스트다.
const config = JSON.parse(fs.readFileSync(process.env.TRIO_PREVIEW_HOST_CONFIG, 'utf8'));
for (const name of ['userData', 'sessionData', 'temp', 'documents', 'home']) {
  const target = path.join(config.profile, name);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(name, target);
}
Object.defineProperty(process, 'resourcesPath', { value: config.resources, configurable: true });
process.env.CI_SMOKE_TEST = 'true';
process.env.TRIO_DISABLE_AUTO_UPDATE = 'true';
delete process.env.VITE_DEV_SERVER_URL;
const state = { events: [], openQueue: [], saveQueue: [], denied: [], network: [] };
global.__localPreview = state;
let ownedOcrChild;
let activeOcrRequests = 0;
async function releaseIdleOcrForExperiment() {
  const owned = ownedOcrChild;
  if (activeOcrRequests !== 1 || !owned || owned.child.pid !== owned.pid
      || owned.parentPid !== process.pid || owned.child.spawnfile !== owned.command
      || JSON.stringify(owned.child.spawnargs.slice(1)) !== JSON.stringify(owned.args)) {
    throw new Error('release_unconfirmed: OCR 소유·동시 실행 확인 실패');
  }
  const record = { event: 'host-resource-release', pid: owned.pid, parentPid: process.pid,
    spawnedAt: owned.spawnedAt, completedOcrAt: new Date().toISOString() };
  state.events.push(record);
  if (owned.child.exitCode !== null || owned.child.signalCode !== null) throw new Error('release_unconfirmed: OCR child가 이미 종료됐습니다.');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('release_unconfirmed: 5초 안에 종료를 확인하지 못했습니다.')), 5000);
    owned.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      record.exitedAt = new Date().toISOString();
      record.exit = { code, signal };
      resolve();
    });
    record.killRequestedAt = new Date().toISOString();
    if (!owned.child.kill()) { clearTimeout(timer); reject(new Error('release_unconfirmed: 종료 요청 실패')); }
  });
  fs.writeFileSync(path.join(config.output, 'host-resource-release.json'), JSON.stringify(record, null, 2));
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_event, details) => {
    state.events.push({ event: 'render-process-gone', ...details, at: new Date().toISOString() });
    fs.writeFileSync(path.join(config.output, 'renderer-lifecycle.json'), JSON.stringify(state.events.filter(value => value.event === 'render-process-gone'), null, 2));
  });
});
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (args?.some(value => typeof value === 'string' && value.endsWith('trio_ocr_sidecar.py'))) {
    ownedOcrChild = { child, pid: child.pid, parentPid: process.pid, command,
      args: [...args], spawnedAt: new Date().toISOString() };
    const diagnostic = path.join(config.output, 'ocr-operations');
    fs.mkdirSync(diagnostic, { recursive: true });
    const log = value => fs.appendFileSync(path.join(diagnostic, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: child.pid, ...value }) + '\n');
    const actualWrite = child.stdin.write.bind(child.stdin);
    let ordinal = 0;
    child.stdin.write = (chunk, ...rest) => {
      try {
        const request = JSON.parse(chunk.toString().trim());
        const input = request.imageBase64 ? Buffer.from(request.imageBase64, 'base64') : null;
        ordinal++;
        const inputFile = input ? `${child.pid}-${String(ordinal).padStart(3, '0')}-${request.operation}.png` : null;
        if (input) fs.writeFileSync(path.join(diagnostic, inputFile), input, { flag: 'wx' });
        log({ event: 'request', ordinal, operation: request.operation, requestId: request.requestId,
          inputFile, inputSha256: input ? createHash('sha256').update(input).digest('hex') : null });
      } catch (error) { log({ event: 'observer_error', reason: error.code ?? error.name }); }
      return actualWrite(chunk, ...rest);
    };
    let pendingText = '';
    child.stdout.on('data', chunk => {
      pendingText += chunk.toString('utf8');
      const rows = pendingText.split('\n');
      pendingText = rows.pop();
      for (const row of rows) {
        try {
          const response = JSON.parse(row);
          log({ event: 'response', requestId: response.requestId, operation: response.operation,
            detections: response.detections?.length, text: response.text });
        } catch { log({ event: 'observer_unparsed_response' }); }
      }
    });
    child.once('exit', (code, signal) => log({ event: 'exit', code, signal }));
  }
  return child;
};
syncBuiltinESMExports();
const fsp = require('node:fs/promises');
for (const operation of ['rm', 'rmdir', 'rename']) {
  const original = fsp[operation].bind(fsp);
  fsp[operation] = async (...args) => {
    if (args.some(value => typeof value === 'string' && path.resolve(value).startsWith(path.resolve(config.output) + path.sep))) {
      fs.appendFileSync(path.join(config.output, 'host-filesystem.jsonl'), JSON.stringify({ operation, paths: args.filter(x => typeof x === 'string'), stack: new Error().stack, at: new Date().toISOString() }) + '\n');
    }
    return original(...args);
  };
}
dialog.showOpenDialog = async () => {
  const filePaths = state.openQueue.shift();
  if (!filePaths) throw new Error('검증 호스트에 예약되지 않은 열기 대화상자');
  return { canceled: false, filePaths };
};
dialog.showSaveDialog = async () => {
  const filePath = state.saveQueue.shift();
  if (!filePath) throw new Error('검증 호스트에 예약되지 않은 저장 대화상자');
  return { canceled: false, filePath };
};
const forbidden = new Set([
  'project:applyProductionOcrReview', 'translation:commitProposal', 'project:reviewCleanedAsset',
  'environment:installProductionOcr', 'project:setGeminiApiKey', 'project:clearGeminiApiKey',
  'app-update:check', 'app-update:download', 'app-update:install', 'app-update:openRelease',
]);
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => {
  if (forbidden.has(channel)) {
    state.denied.push(channel);
    throw new Error('이 검증은 사용자 확정·설치·업데이트를 수행하지 않습니다.');
  }
  const event = { channel, startedAt: new Date().toISOString() };
  const started = performance.now();
  state.events.push(event);
  if (channel === 'project:extractSpeechBubbles') activeOcrRequests++;
  try {
    const result = await handler(...args);
    if (config.releaseOcrAfterPage && channel === 'project:extractSpeechBubbles') await releaseIdleOcrForExperiment();
    event.ok = true;
    return result;
  }
  catch (error) { event.ok = false; event.error = error.message; throw error; }
  finally { event.durationMs = performance.now() - started; if (channel === 'project:extractSpeechBubbles') activeOcrRequests--; }
});
const originalFetch = global.fetch;
global.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !['8080', '11435'].includes(url.port)) {
    state.network.push({ allowed: false, origin: url.origin });
    return Promise.reject(new Error('검증 호스트는 지정된 로컬 모델 연결만 허용합니다.'));
  }
  state.network.push({ allowed: true, origin: url.origin, path: url.pathname });
  return originalFetch(input, init);
};
app.on('will-quit', () => fs.writeFileSync(path.join(config.output, 'host-final.json'), JSON.stringify(state, null, 2)));
// app.whenReady()를 기다리기 전에 실제 앱 모듈을 등록한다.
import(pathToFileURL(path.join(config.source, 'dist-electron/electron/main.js')).href)
  .catch(error => { fs.writeFileSync(path.join(config.output, 'host-start-error.txt'), error.stack); app.exit(1); });
