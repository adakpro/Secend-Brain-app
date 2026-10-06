import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
import { freshDb, tmpDir, seedOwner, TEMPLATE_DIR } from './helpers';
import { VaultService } from '../../src/vault/service';
import { ChangeSetEngine, validateAgentOps } from '../../src/changesets/engine';
import { BackupService } from '../../src/backup/backup';
import { SourceService } from '../../src/ingest/sources';

const drops: (() => Promise<void>)[] = [];
afterAll(async () => { for (const d of drops) await d(); });

describe('H01–H03 backup and restore to an empty installation', () => {
  it('restores DB rows and files exactly, revokes sessions, pauses schedules, does not re-send runs', async () => {
    // Installation A with real content.
    const A = await freshDb(); drops.push(A.drop);
    const dirsA = { vault: tmpDir('va-'), sources: tmpDir('sa-'), backups: tmpDir('ba-') };
    const vaultA = new VaultService(A.db, dirsA.vault, TEMPLATE_DIR);
    const ws = await seedOwner(A.db); await vaultA.initWorkspace(ws.workspaceId, ws.slug);
    const engine = new ChangeSetEngine(A.db, vaultA);
    const { ops } = validateAgentOps([{ op: 'create', path: 'wiki/concepts/بازیابی.md', content: '---\ntitle: بازیابی\ntype: concept\ncreated: 2026-10-06\nupdated: 2026-10-06\n---\n# بازیابی\n\nمتن فارسی برای آزمون بازیابی.\n' }], { allowedSourceRefs: new Set() });
    const cs = await engine.propose({ workspaceId: ws.workspaceId, runId: null, origin: 'manual', title: 'r', summary: '', ops, sourceRefs: [], report: {} });
    await engine.apply({ workspaceId: ws.workspaceId, slug: ws.slug, changesetId: cs, acceptedSeqs: 'all', userId: ws.userId, applyKey: 'bk-1' });
    await new SourceService(A.db, dirsA.sources).createFromBytes({ workspaceId: ws.workspaceId, userId: ws.userId, title: 'منبع', kind: 'text', sensitivity: 'private_model', tags: [], buf: Buffer.from('متن منبع خام'), mime: 'text/plain', ext: '.txt' });
    await A.db.query(`INSERT INTO sessions(user_id, token_hash, csrf_token, expires_at, idle_timeout_s) VALUES ($1, '\\x01', 'c', now() + interval '1 day', 3600)`, [ws.userId]);
    await A.db.query(`INSERT INTO schedules(workspace_id, name, skill_id, cron, timezone) VALUES ($1,'lint','lint','0 3 * * *','UTC')`, [ws.workspaceId]);
    await A.db.query(`INSERT INTO agent_runs(workspace_id, kind, skill_id, skill_version, status) VALUES ($1,'query','query','1','queued')`, [ws.workspaceId]);
    const bk = new BackupService(A.db, dirsA, '0.1.0', 'd6861cc');
    const { file, manifest } = await bk.create({ passphrase: 'a-long-backup-passphrase' });
    expect(file.endsWith('.zip.enc')).toBe(true);
    expect(manifest.excluded).toContain('sessions');
    expect(fs.readFileSync(file).includes(Buffer.from('متن فارسی'))).toBe(false); // encrypted at rest

    // Installation B: empty.
    const B = await freshDb(); drops.push(B.drop);
    const dirsB = { vault: tmpDir('vb-'), sources: tmpDir('sb-'), backups: tmpDir('bb-') };
    const bkB = new BackupService(B.db, dirsB, '0.1.0', 'd6861cc');
    await expect(bkB.verify(file, 'wrong-passphrase-123')).rejects.toThrow();
    const v = await bkB.verify(file, 'a-long-backup-passphrase');
    expect(v.ok).toBe(true);
    await bkB.restore(file, 'a-long-backup-passphrase');

    const count = async (db: typeof A.db, t: string) => (await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
    for (const t of ['users', 'workspaces', 'documents', 'document_revisions', 'changesets', 'sources', 'source_versions', 'search_chunks', 'audit_events']) expect({ t, n: await count(B.db, t) }).toEqual({ t, n: await count(A.db, t) });
    expect(await count(B.db, 'sessions')).toBe(0);
    expect((await B.db.query(`SELECT enabled, paused_reason FROM schedules`)).rows[0]).toEqual({ enabled: false, paused_reason: 'restored_from_backup' });
    expect((await B.db.query(`SELECT status FROM agent_runs`)).rows[0].status).toBe('interrupted');
    const f = path.join(dirsB.vault, ws.slug, 'wiki/concepts/بازیابی.md');
    expect(fs.readFileSync(f, 'utf8')).toBe(fs.readFileSync(path.join(dirsA.vault, ws.slug, 'wiki/concepts/بازیابی.md'), 'utf8'));
    // Search index keeps working after restore (Persian normalization).
    const { search } = await import('../../src/search/search');
    const hits = await search(B.db, { workspaceId: ws.workspaceId }, 'بازيابي');
    expect(hits.length).toBeGreaterThan(0);
    // Tampering is detected.
    const plain = await new BackupService(A.db, { ...dirsA, backups: tmpDir('bp-') }, '0.1.0', null).create();
    const buf = fs.readFileSync(plain.file); const i = buf.indexOf(Buffer.from('متن فارسی'));
    if (i > 0) { buf[i + 2] ^= 1; const t = plain.file + '.tampered.zip'; fs.writeFileSync(t, buf); const tv = await bkB.verify(t).catch(e => ({ ok: false, problems: [String(e)] })); expect(tv.ok).toBe(false); }
  });
});
