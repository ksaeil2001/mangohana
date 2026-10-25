import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIsolatedPostgres } from './isolated-postgres.js';

const filters=process.argv.slice(2);if(filters.some(value=>!/^tests\/postgres\/[a-z0-9-]+\.test\.ts$/.test(value)))throw new Error('Use explicit PostgreSQL test file paths only.');
const namePattern=process.env.TRIO_TEST_NAME_PATTERN;if(namePattern!==undefined){if(!namePattern.length||namePattern.length>256||/[\r\n\0]/.test(namePattern)||!filters.length)throw new Error('Use a bounded test-name pattern with explicit test files only.');new RegExp(namePattern);}
const artifacts = await mkdtemp(join(tmpdir(), 'trio-manga-web-postgres-'));
const runtime = await startIsolatedPostgres();
let result: number;
try {
  console.log(JSON.stringify({ database: runtime.version, isolatedData: runtime.directory, host: '127.0.0.1', artifacts }));
  result = await new Promise<number>((accept, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...(filters.length?filters:['tests/postgres']),...(namePattern?['--testNamePattern',namePattern]:[])], {
      env: { ...process.env, TRIO_TEST_DATABASE_URL: runtime.connectionString }, stdio: 'inherit', windowsHide: true,
    });
    child.on('error', reject); child.on('exit', (code) => accept(code ?? 1));
  });
} finally { runtime.stop(); }
await writeFile(join(artifacts, 'environment.json'), JSON.stringify({ version: runtime.version, isolatedData: runtime.directory,
  loopback: true, credentials: 'random ephemeral test credential; omitted', files:filters.length?filters:['tests/postgres'],testNamePattern:namePattern??null,exitCode: result, realProviderCalls: 0 }, null, 2) + '\n', { flag: 'wx' });
process.exitCode = result;
