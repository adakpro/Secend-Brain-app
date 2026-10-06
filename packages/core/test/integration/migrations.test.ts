import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { ADMIN_URL } from './helpers';
import { createPool, runMigrations, SCHEMA_VERSION } from '../../src/database/pool';

describe('A09 migrations', () => {
  it('concurrent migrators on an empty database apply each migration exactly once', async () => {
    const name = 'sbt_mig_' + Math.random().toString(36).slice(2, 8);
    const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect(); await a.query(`CREATE DATABASE ${name}`); await a.end();
    const url = ADMIN_URL.replace(/\/[^/]+$/, '/' + name);
    const pools = [1, 2, 3].map(() => createPool(url, 2));
    const results = await Promise.all(pools.map(p => runMigrations(p)));
    const applied = results.flatMap(r => r.applied);
    expect(applied.sort()).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
    const rows = (await pools[0].query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r => r.version);
    expect(rows).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
    // Re-running is a no-op and keeps data.
    await pools[0].query(`INSERT INTO workspaces(slug,name) VALUES ('keep','Keep')`);
    expect((await runMigrations(pools[1])).applied).toEqual([]);
    expect((await pools[0].query(`SELECT count(*)::int n FROM workspaces`)).rows[0].n).toBe(1);
    for (const p of pools) await p.end();
    const b = new pg.Client({ connectionString: ADMIN_URL }); await b.connect(); await b.query(`DROP DATABASE ${name} WITH (FORCE)`); await b.end();
  });
});
