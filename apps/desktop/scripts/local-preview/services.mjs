import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

// 검증 전용 supervisor. 모델·사용자 설정을 쓰지 않으며 자신이 시작한 트리만 종료한다.
const configPath = process.argv[2];
if (!configPath) throw new Error('services.mjs <config.json>');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const out = resolve(config.output);
mkdirSync(out, { recursive: true });
const env = {
  SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  WINDIR: process.env.WINDIR ?? 'C:\\Windows',
  PATH: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
  TEMP: join(out, 'temp'), TMP: join(out, 'temp'),
  OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', PYTHONUNBUFFERED: '1',
};
mkdirSync(env.TEMP, { recursive: true });
const children = [];
const record = { startedAt: new Date().toISOString(), services: [], finished: false };
const persist = () => writeFileSync(join(out, 'supervisor.json'), JSON.stringify(record, null, 2));
let stopping = false;
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  record.stopReason = reason;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        // Windows dispatcher의 worker도 자신이 시작한 PID 트리로 한정한다.
        await promisify(execFile)('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch { child.kill(); }
    }
  }
  await Promise.all(children.map(c => c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve() : new Promise(r => c.once('exit', r))));
  record.finished = true;
  record.finishedAt = new Date().toISOString();
  persist();
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
async function freePort(port) {
  await new Promise((ok, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => server.close(ok));
  });
}
async function launch(name, executable, args, healthUrl) {
  const stdout = createWriteStream(join(out, `${name}.stdout.log`), { flags: 'wx' });
  const stderr = createWriteStream(join(out, `${name}.stderr.log`), { flags: 'wx' });
  const child = spawn(executable, args, { env, cwd: out, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const item = { name, executable, args, pid: child.pid, healthUrl, exit: null };
  record.services.push(item);
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  child.once('error', error => { item.spawnError = error.code ?? error.name; persist(); });
  child.once('exit', (code, signal) => { item.exit = { code, signal, at: new Date().toISOString() }; persist(); });
  persist();
  const deadline = Date.now() + 90_000;
  while (!stopping && Date.now() < deadline) {
    if (item.exit || item.spawnError) throw new Error(`${name}: process exited`);
    try {
      const result = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
      if (result.ok) { item.readyAt = new Date().toISOString(); item.health = await result.json(); persist(); return; }
    } catch { /* 모델 적재가 끝날 때까지만 기다린다. */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${name}: startup timeout`);
}
try {
  await freePort(config.translationPort);
  await freePort(config.inpaintingPort);
  await launch('gemma', config.llamaServer, [
    '--model', config.gemmaModel, '--host', '127.0.0.1', '--port', String(config.translationPort),
    '--alias', config.modelAlias, '--ctx-size', '4096', '--parallel', '1',
    '--n-gpu-layers', '99', '--threads', '4', '--reasoning', 'off', '--no-webui',
  ], `http://127.0.0.1:${config.translationPort}/health`);
  await launch('lama', config.python, [config.lamaBridge, '--python', config.python,
    '--worker', config.lamaWorker, '--model', config.lamaModel,
    '--port', String(config.inpaintingPort), '--log-dir', join(out, 'lama-requests'),
    ...(config.lamaTileWrapper ? ['--tile-wrapper', config.lamaTileWrapper] : [])],
  `http://127.0.0.1:${config.inpaintingPort}/inpaint`);
  record.models = await (await fetch(`http://127.0.0.1:${config.translationPort}/v1/models`)).json();
  persist();
  console.log(JSON.stringify({ ready: true, output: out, services: record.services.map(x => ({ name: x.name, pid: x.pid })) }));
  const deadline = Date.now() + 45 * 60_000;
  while (!stopping && Date.now() < deadline && !existsSync(join(out, 'STOP'))) {
    if (record.services.some(x => x.exit)) throw new Error('owned service exited');
    await new Promise(r => setTimeout(r, 500));
  }
  await stop(stopping ? 'signal' : existsSync(join(out, 'STOP')) ? 'owned STOP file' : '45 minute deadline');
} catch (error) {
  record.failure = error.message;
  await stop('failure');
  console.error(error.message);
  process.exitCode = 1;
}
