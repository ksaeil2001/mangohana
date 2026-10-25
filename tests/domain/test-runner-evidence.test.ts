import { EventEmitter } from 'node:events';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  temporaryRoot: '',
  activeFile: '',
  collisionFile: '',
  collisionBytes: '',
  events: [] as string[],
  evidencePaths: [] as string[],
  childArguments: [] as string[][],
  fault: 'none' as 'none' | 'directory' | 'spawn' | 'write' | 'collision' | 'cleanup' | 'startup',
  testExit: 0,
  buildExit: 0,
}));

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  tmpdir: () => state.temporaryRoot,
}));

// 경로만 격리하며 파일 생성·충돌·쓰기 실패는 실제 파일 시스템에서 확인한다.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const isolatedPath = <T extends Parameters<typeof actual.writeFile>[0]>(file: T): T =>
    (typeof file === 'string' && !path.isAbsolute(file) ? path.join(state.temporaryRoot, file) : file) as T;
  return {
    ...actual,
    mkdir: ((file, options) => actual.mkdir(isolatedPath(file), options)) as typeof actual.mkdir,
    writeFile: (async (file, data, options) => {
      let target = isolatedPath(file);
      if (typeof target === 'string' && /(?:^|[\\/])(?:postgres-)?environment\.json$/.test(target)) {
        if (state.fault === 'write') {
          if (existsSync(target)) target += '.write-blocked';
          await actual.mkdir(target);
        }
        if (state.fault === 'collision') {
          state.collisionFile = target;
          if (!existsSync(target)) await actual.writeFile(target, '이전 실행 기록\n', { flag: 'wx' });
          state.collisionBytes = await actual.readFile(target, 'utf8');
        }
        state.evidencePaths.push(target);
        state.events.push('evidence');
      }
      return actual.writeFile(target, data, options);
    }) as typeof actual.writeFile,
  };
});

// 외부 프로세스만 대체한다. 실제 DB·빌드·브라우저·제공자를 실행하지 않는다.
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    const child = new EventEmitter();
    const build = args[0].includes('vite/bin/vite.js');
    state.childArguments.push([...args]);
    state.events.push(build ? 'build' : 'test');
    queueMicrotask(() => {
      if (!build && state.fault === 'spawn') child.emit('error', new Error('CHILD_SPAWN_FAILED'));
      else child.emit('exit', build ? state.buildExit : state.testExit);
    });
    return child;
  },
  spawnSync: () => ({ status: 0 }),
}));

vi.mock('../../scripts/isolated-postgres.js', () => ({
  startIsolatedPostgres: async () => {
    state.events.push('start');
    if (state.fault === 'startup') throw new Error('PG_START_FAILED');
    writeFileSync(state.activeFile, '실행기가 소유한 임시 DB');
    return {
      version: 'PostgreSQL 18 fixture',
      directory: path.join(state.root, 'owned-pg'),
      connectionString: 'postgresql://fixture:fake@127.0.0.1:1/fixture',
      stop: () => {
        state.events.push('stop');
        if (state.fault === 'cleanup') throw new Error('PG_STOP_FAILED');
        unlinkSync(state.activeFile);
      },
    };
  },
}));

const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const operatingSystem = await vi.importActual<typeof import('node:os')>('node:os');
const originalArguments = process.argv;
const originalExitCode = process.exitCode;
type Runner = 'postgres' | 'browser';

beforeEach(async () => {
  state.root = await filesystem.mkdtemp(path.join(operatingSystem.tmpdir(), 'trio-runner-test-'));
  state.temporaryRoot = state.root;
  state.activeFile = path.join(state.root, 'owned-postgres.running');
  state.collisionFile = '';
  state.collisionBytes = '';
  state.events = [];
  state.evidencePaths = [];
  state.childArguments = [];
  state.fault = 'none';
  state.testExit = 0;
  state.buildExit = 0;
  process.exitCode = undefined;
  vi.stubEnv('TRIO_TEST_NAME_PATTERN', undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const historical = path.join(state.root, 'docs', 'validation');
  await filesystem.mkdir(historical, { recursive: true });
  await filesystem.writeFile(path.join(historical, 'postgres-environment.json'), '보존할 과거 기록\n', { flag: 'wx' });
});

afterEach(async () => {
  process.argv = originalArguments;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  const relative = path.relative(operatingSystem.tmpdir(), state.root);
  if (!/^trio-runner-test-[A-Za-z0-9]+$/.test(relative)) throw new Error('TEST_DIRECTORY_UNCONFIRMED');
  await filesystem.rm(state.root, { recursive: true, force: true });
});

async function run(runner: Runner, args?: string[]) {
  vi.resetModules();
  process.exitCode = undefined;
  process.argv = [process.execPath, `scripts/test-${runner}.ts`, ...(args ?? (runner === 'postgres'
    ? ['tests/postgres/execution.test.ts']
    : ['tests/browser/workspace.spec.ts', '--project=windows-chrome']))];
  const evidenceStart = state.evidencePaths.length;
  let error: unknown;
  try {
    if (runner === 'postgres') await import('../../scripts/test-postgres.js');
    else await import('../../scripts/test-browser.js');
  } catch (failure) { error = failure; }
  return { error, exitCode: process.exitCode, evidence: state.evidencePaths.slice(evidenceStart) };
}

describe.each<Runner>(['postgres', 'browser'])('%s 실행기의 증거와 정리', runner => {
  it('실행마다 다른 증거를 저장하고 과거 기록을 그대로 보존한다', async () => {
    const historical = path.join(state.root, 'docs', 'validation', 'postgres-environment.json');
    const before = await filesystem.readFile(historical);
    const first = await run(runner);
    const second = await run(runner);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.evidence).toHaveLength(1);
    expect(second.evidence).toHaveLength(1);
    expect(first.evidence[0]).not.toBe(second.evidence[0]);
    expect(path.dirname(first.evidence[0])).not.toBe(path.dirname(second.evidence[0]));
    expect(await filesystem.readFile(historical)).toEqual(before);
    for (const file of [...first.evidence, ...second.evidence]) {
      const relative = path.relative(state.root, file);
      expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
      const evidence = JSON.parse(await filesystem.readFile(file, 'utf8'));
      expect(evidence.exitCode).toBe(0);
      expect(JSON.stringify(evidence)).not.toContain('postgresql://');
    }
    expect(existsSync(state.activeFile)).toBe(false);
    expect(state.events.filter(event => event === 'stop')).toHaveLength(2);
    expect(state.events.indexOf('stop')).toBeLessThan(state.events.indexOf('evidence'));
  });

  it('증거 폴더 준비 실패는 PostgreSQL 시작 전에 중단한다', async () => {
    state.fault = 'directory';
    state.temporaryRoot = path.join(state.root, 'blocked');
    await filesystem.writeFile(state.temporaryRoot, '디렉터리가 아닌 파일', { flag: 'wx' });
    const result = await run(runner);
    expect(result.error).toBeDefined();
    expect(result.exitCode).not.toBe(0);
    expect(state.events).not.toContain('start');
    expect(existsSync(state.activeFile)).toBe(false);
  });

  it('자식 시작 실패에도 소유한 PostgreSQL을 정리한다', async () => {
    state.fault = 'spawn';
    const result = await run(runner);
    expect(result.error).toMatchObject({ message: 'CHILD_SPAWN_FAILED' });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(state.activeFile)).toBe(false);
    expect(state.events).toContain('stop');
  });

  it('자식 exit 7을 보존하고 정리한 뒤 실패 증거를 남긴다', async () => {
    state.testExit = 7;
    const result = await run(runner);
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(7);
    expect(result.evidence).toHaveLength(1);
    expect(JSON.parse(await filesystem.readFile(result.evidence[0], 'utf8')).exitCode).toBe(7);
    expect(existsSync(state.activeFile)).toBe(false);
    expect(state.events.indexOf('stop')).toBeLessThan(state.events.indexOf('evidence'));
  });

  it('실제 기록 쓰기 실패에도 정리를 마치고 성공을 보고하지 않는다', async () => {
    state.fault = 'write';
    const result = await run(runner);
    expect(result.error).toBeDefined();
    expect(result.exitCode).not.toBe(0);
    expect(result.evidence).toHaveLength(1);
    expect((await filesystem.stat(result.evidence[0])).isDirectory()).toBe(true);
    expect(existsSync(state.activeFile)).toBe(false);
    expect(state.events).toContain('stop');
  });

  it('실제 기록 충돌은 오류로 끝나며 기존 bytes를 덮어쓰지 않는다', async () => {
    state.fault = 'collision';
    const result = await run(runner);
    expect(result.error).toMatchObject({ code: 'EEXIST' });
    expect(result.exitCode).not.toBe(0);
    expect(await filesystem.readFile(state.collisionFile, 'utf8')).toBe(state.collisionBytes);
    expect(existsSync(state.activeFile)).toBe(false);
  });

  it('정리 실패에는 exit 0이나 성공 증거를 확정하지 않는다', async () => {
    state.fault = 'cleanup';
    const result = await run(runner);
    expect(result.error).toMatchObject({ message: 'PG_STOP_FAILED' });
    expect(result.exitCode).not.toBe(0);
    expect(result.evidence).toHaveLength(0);
    expect(existsSync(state.activeFile)).toBe(true);
  });

  it('PG helper가 반환하지 못하면 실행을 성공으로 보고하지 않는다', async () => {
    state.fault = 'startup';
    const result = await run(runner);
    expect(result.error).toMatchObject({ message: 'PG_START_FAILED' });
    expect(result.exitCode).not.toBe(0);
    expect(result.evidence).toHaveLength(0);
    expect(state.events).not.toContain('test');
  });

  it('기존 파일 필터 제한을 유지한다', async () => {
    const result = await run(runner, ['../../운영-자료']);
    expect(result.error).toBeDefined();
    expect(result.exitCode).not.toBe(0);
    expect(state.events).not.toContain('start');
    expect(state.childArguments).toHaveLength(0);
  });
});

it('브라우저 build 실패는 PostgreSQL 시작 전에 중단한다', async () => {
  state.buildExit = 7;
  const result = await run('browser');
  expect(result.error).toMatchObject({ message: 'Browser test build failed.' });
  expect(result.exitCode).not.toBe(0);
  expect(state.events).not.toContain('start');
  expect(existsSync(state.activeFile)).toBe(false);
});

it('브라우저 명시 경로·프로젝트와 기존 이름 필터를 자식에게 전달한다', async () => {
  vi.stubEnv('TRIO_TEST_NAME_PATTERN', 'uses actual pointer/keyboard flow');
  const result = await run('browser');
  expect(result.error).toBeUndefined();
  expect(state.childArguments.at(-1)).toEqual([
    'node_modules/@playwright/test/cli.js', 'test', 'tests/browser/workspace.spec.ts',
    '--project=windows-chrome', '--grep', 'uses actual pointer/keyboard flow',
  ]);
});
