import pg from 'pg';
import { createHash } from 'node:crypto';
import { migrations } from './migrations';
import { log } from '../log';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

// Keep timestamps as ISO strings and bigint counts as numbers for JSON DTOs.
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v: string) => new Date(v + 'Z').toISOString());
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  // A dropped connection must not crash the process; the pool reconnects on next use.
  pool.on('error', err => log.warn('db.pool_error', { error: err.message }));
  return pool;
}

export async function waitForDb(pool: Db, { attempts = 60, delayMs = 1000 } = {}): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try { await pool.query('SELECT 1'); return; } catch (e) {
      log.warn('db.waiting', { attempt: i, error: (e as Error).message });
      await new Promise(r => setTimeout(r, Math.min(delayMs * i, 5000)));
    }
  }
  throw new Error('database not reachable');
}

export async function withTx<T>(pool: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const MIGRATION_LOCK = 724_201_001;

export async function runMigrations(pool: Db): Promise<{ applied: number[]; current: number }> {
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    // Session-level advisory lock: concurrent migrators wait, then see nothing left to do.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const done = new Map(rows.map(r => [r.version, r.checksum]));
    for (const m of migrations) {
      const sum = createHash('sha256').update(m.sql).digest('hex');
      if (done.has(m.version)) {
        if (done.get(m.version) !== sum) throw new Error(`migration ${m.version} checksum changed after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations(version, name, checksum) VALUES ($1,$2,$3)', [m.version, m.name, sum]);
        await client.query('COMMIT');
        applied.push(m.version);
        log.info('db.migration_applied', { version: m.version, name: m.name });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    return { applied, current: migrations[migrations.length - 1].version };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

export const SCHEMA_VERSION = migrations[migrations.length - 1].version;
