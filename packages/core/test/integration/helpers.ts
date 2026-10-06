import pg from 'pg';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createPool, runMigrations, type Db } from '../../src/database/pool';

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://sbtest:sbtest@127.0.0.1:55499/sbtest';
export const TEMPLATE_DIR = path.resolve(__dirname, '../../../../vendor/second-brain-os/vault-template');

export async function freshDb(): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const name = 'sbt_' + Math.random().toString(36).slice(2, 10);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]+$/, '/' + name);
  const db = createPool(url, 5);
  await runMigrations(db);
  return { db, url, drop: async () => { await db.end(); const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end(); } };
}

export function tmpDir(prefix: string) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

export async function seedOwner(db: Db, slug = 'personal') {
  const u = await db.query(`INSERT INTO users(email, display_name, password_hash, is_installation_owner) VALUES ('owner@example.test','Owner','x',true) RETURNING id`);
  const w = await db.query(`INSERT INTO workspaces(slug, name) VALUES ($1,'Personal') RETURNING id`, [slug]);
  await db.query(`INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [w.rows[0].id, u.rows[0].id]);
  return { userId: u.rows[0].id as string, workspaceId: w.rows[0].id as string, slug };
}
