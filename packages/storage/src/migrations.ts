import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export async function migrate(pool: Pool): Promise<string[]> {
  const directory = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(847103031)');
    await client.query('CREATE SCHEMA IF NOT EXISTS trio_migrations');
    await client.query('CREATE TABLE IF NOT EXISTS trio_migrations.applied(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    for (const name of names) {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const prior = (await client.query<{ sha256: string }>('SELECT sha256 FROM trio_migrations.applied WHERE name=$1', [name])).rows[0];
      if (prior) {
        if (prior.sha256 !== digest) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO trio_migrations.applied(name,sha256) VALUES($1,$2)', [name, digest]);
      applied.push(name);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  return applied;
}
