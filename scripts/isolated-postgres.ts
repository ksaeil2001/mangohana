import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

export type IsolatedPostgres = { connectionString: string; directory: string; version: string; stop: () => void };
export async function startIsolatedPostgres(): Promise<IsolatedPostgres> {
  const bin = process.env.TRIO_TEST_PG_BIN ?? join(tmpdir(), 'codex-trio-web-pg18-01a1018a', 'pgsql', 'bin');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const execute = (name: string, args: string[]) => {
    // pg_ctl's server child must not inherit a captured pipe on Windows.
    const result = spawnSync(join(bin, `${name}${suffix}`), args, { encoding: 'utf8', windowsHide: true,
      stdio: name === 'pg_ctl' ? 'ignore' : 'pipe', timeout: name === 'initdb' ? 300000 : name === 'pg_ctl' ? 190000 : 120000 });
    if (result.status !== 0) throw new Error(`Isolated PG ${name} failed: ${result.error?.message ?? result.stderr}`);
    return (result.stdout ?? '').trim();
  };
  await stat(join(bin, `postgres${suffix}`));
  const version = execute('postgres', ['--version']);
  if (!/PostgreSQL\) 18\./.test(version)) throw new Error('PostgreSQL 18 is required; no substitute database.');
  const directory = await mkdtemp(join(tmpdir(), 'trio-manga-web-pg-'));
  if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error('Test data must be isolated under OS tmpdir.');
  const password = randomBytes(24).toString('base64url');
  const passwordFile = join(directory, 'temporary-test-password.txt');
  await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' });
  execute('initdb', ['-D', join(directory, 'data'), '-U', 'trio_test_admin', '--pwfile', passwordFile, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C']);
  const port = await new Promise<number>((accept, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('No isolated port')); server.close(() => accept(address.port)); });
  });
  execute('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
  let stopped = false;
  return { directory, version, connectionString: `postgresql://trio_test_admin:${password}@127.0.0.1:${port}/postgres`, stop: () => {
    if (stopped) return;
    // Windows can spend more than pg_ctl's default minute flushing this owned test cluster.
    // Wait for confirmed shutdown; this does not change any product or test operation deadline.
    execute('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', '-t', '180', 'stop']);
    stopped = true;
  } };
}
