import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Db } from '../database/pool';
import { SCHEMA_VERSION } from '../database/pool';
import { sha256Hex } from '../crypto/envelope';
import { ZipWriter, ZipReader } from '../archive/zip';
import { atomicWrite } from '../vault/paths';
import { audit } from '../vault/service';
import { log } from '../log';

/** FK-safe order. Sessions, login attempts, run tokens and terminal tickets are deliberately excluded. */
export const BACKUP_TABLES = [
  'app_meta', 'users', 'recovery_codes', 'workspaces', 'memberships', 'user_preferences', 'projects', 'tasks', 'sources', 'source_versions',
  'documents', 'document_revisions', 'links', 'search_chunks', 'agent_runs', 'run_events', 'changesets', 'changeset_items', 'apply_journal',
  'conversations', 'messages', 'citations', 'outputs', 'output_versions', 'quiz_items', 'quiz_attempts', 'provider_credentials', 'schedules',
  'audit_events', 'backup_manifests',
];
const EXCLUDED = ['sessions', 'login_attempts', 'run_tokens', 'native_tickets'];

export interface BackupManifest {
  format: 'sb-backup-1'; appVersion: string; schemaVersion: number; upstreamCommit: string | null; createdAt: string;
  tables: Record<string, { rows: number; sha256: string }>; files: { path: string; sha256: string; size: number }[];
  excluded: string[]; activeRuns: number; schedules: { id: string; enabled: boolean }[]; notes: string[];
}

const MAGIC = Buffer.from('SBBK1ENC');

/** Optional passphrase encryption of the whole archive (scrypt + AES-256-GCM). The master key is never inside. */
export function encryptFile(src: string, dst: string, passphrase: string) {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(fs.readFileSync(src)), c.final()]);
  fs.writeFileSync(dst, Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]), { mode: 0o600, flag: 'wx' });
}
export function decryptToBuffer(file: string, passphrase: string): Buffer {
  const b = fs.readFileSync(file);
  if (!b.subarray(0, 8).equals(MAGIC)) throw new Error('not an encrypted backup');
  const salt = b.subarray(8, 24), iv = b.subarray(24, 36), tag = b.subarray(36, 52);
  const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(b.subarray(52)), d.final()]);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let ents: fs.Dirent[]; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!e.name.startsWith('.pre-restore')) await walk(p); }
      else if (e.isFile() && !e.name.endsWith('.sb-tmp')) out.push(p);
    }
  }
  await walk(root);
  return out;
}

export class BackupService {
  constructor(private db: Db, private dirs: { vault: string; sources: string; backups: string }, private appVersion: string, private upstreamCommit: string | null) {}

  /**
   * Consistent operational backup. The DB is read in one REPEATABLE READ snapshot while every
   * workspace write lock is held, so no apply/save can interleave with the file copy. Files
   * are hashed before and after copying; a concurrent EXTERNAL edit aborts with a retry hint.
   */
  async create(opts: { actorId?: string | null; passphrase?: string } = {}): Promise<{ file: string; manifest: BackupManifest }> {
    await fsp.mkdir(this.dirs.backups, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = path.join(this.dirs.backups, `sb-backup-${stamp}.zip`);
    const client = await this.db.connect();
    const zip = await ZipWriter.create(zipPath);
    const manifest: BackupManifest = { format: 'sb-backup-1', appVersion: this.appVersion, schemaVersion: SCHEMA_VERSION, upstreamCommit: this.upstreamCommit, createdAt: new Date().toISOString(), tables: {}, files: [], excluded: EXCLUDED, activeRuns: 0, schedules: [], notes: [] };
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const wss = (await client.query('SELECT id FROM workspaces ORDER BY id')).rows;
      // Same lock key as VaultService/ChangeSetEngine writers; read-only tx may still take advisory locks.
      for (const w of wss) await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', ['ws:' + w.id]).catch(async () => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ws:' + w.id]));
      for (const t of BACKUP_TABLES) {
        const rows = (await client.query(`SELECT to_jsonb(x) AS j FROM ${t} x`)).rows.map(r => JSON.stringify(r.j));
        const body = rows.join('\n') + (rows.length ? '\n' : '');
        manifest.tables[t] = { rows: rows.length, sha256: sha256Hex(body) };
        await zip.add(`db/${t}.jsonl`, body);
      }
      manifest.activeRuns = (await client.query(`SELECT count(*)::int n FROM agent_runs WHERE status IN ('queued','running','cancel_requested')`)).rows[0].n;
      manifest.schedules = (await client.query('SELECT id, enabled FROM schedules')).rows;
      for (const [prefix, root] of [['vault', this.dirs.vault], ['sources', this.dirs.sources]] as const) {
        for (const abs of await walkFiles(root)) {
          const rel = path.relative(root, abs).split(path.sep).join('/');
          const before = await fsp.readFile(abs);
          await zip.add(`${prefix}/${rel}`, before);
          const after = await fsp.readFile(abs);
          if (!after.equals(before)) throw new Error(`file changed during backup (external edit?): ${prefix}/${rel}; run the backup again`);
          manifest.files.push({ path: `${prefix}/${rel}`, sha256: sha256Hex(before), size: before.length });
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      await zip.close().catch(() => undefined); await fsp.rm(zipPath, { force: true });
      throw e;
    } finally { client.release(); }
    manifest.notes.push('Master key is NOT included; keep it (secrets/master_key) in a separate safe place or encrypted credentials cannot be decrypted after restore.');
    manifest.notes.push('Native Claude Code login is NOT included; sign in again after restore.');
    await zip.add('manifest.json', JSON.stringify(manifest, null, 2));
    await zip.close();
    let file = zipPath;
    if (opts.passphrase) { file = zipPath + '.enc'; encryptFile(zipPath, file, opts.passphrase); await fsp.rm(zipPath); }
    await fsp.chmod(file, 0o600);
    await this.db.query(`INSERT INTO backup_manifests(file_name, manifest, status, created_by) VALUES ($1,$2,'created',$3)`, [path.basename(file), { ...manifest, files: manifest.files.length, encrypted: !!opts.passphrase, sha256: sha256Hex(await fsp.readFile(file)) }, opts.actorId ?? null]);
    await audit(this.db, { actorUserId: opts.actorId ?? null, action: 'backup.created', result: 'success', meta: { file: path.basename(file), files: manifest.files.length, encrypted: !!opts.passphrase } });
    return { file, manifest };
  }

  /** Validation / dry-run: checksums, schema compatibility, path safety, free space. Writes nothing. */
  async verify(file: string, passphrase?: string) {
    const buf = file.endsWith('.enc') ? decryptToBuffer(file, passphrase ?? '') : await fsp.readFile(file);
    const zip = ZipReader.fromBuffer(buf);
    const m = zip.entries.find(e => e.name === 'manifest.json');
    if (!m) throw new Error('manifest.json missing');
    const manifest = JSON.parse(zip.read(m).toString('utf8')) as BackupManifest;
    const problems: string[] = [];
    if (manifest.format !== 'sb-backup-1') problems.push(`unknown format ${manifest.format}`);
    if (manifest.schemaVersion !== SCHEMA_VERSION) problems.push(`schema ${manifest.schemaVersion} != installed ${SCHEMA_VERSION} (restore into a matching version, then update)`);
    for (const [t, info] of Object.entries(manifest.tables)) {
      const e = zip.entries.find(x => x.name === `db/${t}.jsonl`);
      if (!e) { problems.push(`missing table ${t}`); continue; }
      if (sha256Hex(zip.read(e)) !== info.sha256) problems.push(`checksum mismatch: ${t}`);
    }
    for (const f of manifest.files) {
      const e = zip.entries.find(x => x.name === f.path);
      if (!e) { problems.push(`missing file ${f.path}`); continue; }
      if (sha256Hex(zip.read(e)) !== f.sha256) problems.push(`checksum mismatch: ${f.path}`);
    }
    const need = manifest.files.reduce((a, f) => a + f.size, 0) * 2;
    try { const s = await fsp.statfs(this.dirs.vault); if (s.bavail * s.bsize < need) problems.push(`not enough free disk space (need ~${need} bytes)`); } catch { /* statfs unsupported */ }
    return { ok: problems.length === 0, problems, manifest: { ...manifest, files: manifest.files.length }, zip };
  }

  /**
   * Restore into this installation. Runs only from the CLI with services stopped. Current files
   * are moved aside (never deleted); all sessions end; schedules are paused; unfinished runs are
   * marked interrupted and their queue jobs dropped so no paid request is silently re-sent.
   */
  async restore(file: string, passphrase?: string) {
    const v = await this.verify(file, passphrase);
    if (!v.ok) throw new Error('backup failed validation: ' + v.problems.join('; '));
    const zip = v.zip;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`TRUNCATE ${[...BACKUP_TABLES, ...EXCLUDED].join(', ')} CASCADE`);
      for (const t of BACKUP_TABLES) {
        const e = zip.entries.find(x => x.name === `db/${t}.jsonl`)!;
        const lines = zip.read(e).toString('utf8').split('\n').filter(Boolean);
        for (let i = 0; i < lines.length; i += 500) {
          const batch = lines.slice(i, i + 500);
          const cols = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [t])).rows.map(r => '"' + r.column_name + '"').join(', ');
          await client.query(`INSERT INTO ${t} (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb)`, [JSON.stringify(batch.map(l => JSON.parse(l)))]);
        }
        if (t === 'search_chunks' || t === 'links' || t === 'run_events' || t === 'login_attempts' || t === 'audit_events') {
          await client.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), coalesce((SELECT max(id) FROM ${t}),0)+1, false)`);
        }
      }
      await client.query(`UPDATE schedules SET enabled=false, paused_reason='restored_from_backup'`);
      await client.query(`UPDATE agent_runs SET status='interrupted', error_code='restored', error_message='اجرا در زمان پشتیبان‌گیری ناتمام بود؛ پس از بازیابی خودکار دوباره ارسال نمی‌شود.', updated_at=now() WHERE status IN ('queued','running','cancel_requested')`);
      await client.query(`UPDATE sources SET status='analysis_failed', status_detail='restored: analysis interrupted' WHERE status='analyzing'`);
      // Never swallow an error inside the transaction (it would turn COMMIT into a silent ROLLBACK).
      if ((await client.query(`SELECT to_regclass('pgboss.job') AS t`)).rows[0].t) await client.query(`DELETE FROM pgboss.job WHERE state IN ('created','retry','active')`);
      const c = await client.query('COMMIT');
      if ((c as { command?: string }).command === 'ROLLBACK') throw new Error('restore transaction was rolled back');
    } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const [prefix, root] of [['vault', this.dirs.vault], ['sources', this.dirs.sources]] as const) {
      await fsp.mkdir(root, { recursive: true });
      const aside = path.join(root, `.pre-restore-${stamp}`);
      await fsp.mkdir(aside, { recursive: true, mode: 0o700 });
      for (const ent of await fsp.readdir(root)) if (!ent.startsWith('.pre-restore-')) await fsp.rename(path.join(root, ent), path.join(aside, ent));
      for (const e of zip.entries.filter(x => x.name.startsWith(prefix + '/') && !x.isDir)) {
        const rel = e.name.slice(prefix.length + 1);
        const abs = path.join(root, rel);
        if (!abs.startsWith(root + path.sep)) throw new Error('path escape in backup');
        await atomicWrite(abs, zip.read(e));
      }
    }
    await audit(this.db, { action: 'backup.restored', result: 'success', meta: { file: path.basename(file) } });
    log.warn('backup.restored', { file: path.basename(file) });
    return { restored: true, manifest: v.manifest };
  }

  async list() {
    await fsp.mkdir(this.dirs.backups, { recursive: true });
    const files = (await fsp.readdir(this.dirs.backups)).filter(f => /^sb-backup-.*\.zip(\.enc)?$/.test(f));
    const rows = (await this.db.query('SELECT file_name, manifest, status, created_at FROM backup_manifests ORDER BY created_at DESC')).rows;
    return Promise.all(files.sort().reverse().map(async f => ({ file: f, size: (await fsp.stat(path.join(this.dirs.backups, f))).size, record: rows.find(r => r.file_name === f) ?? null })));
  }
}
