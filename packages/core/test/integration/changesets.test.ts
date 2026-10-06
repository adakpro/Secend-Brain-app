import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
import { freshDb, tmpDir, seedOwner, TEMPLATE_DIR } from './helpers';
import { VaultService, ConflictError } from '../../src/vault/service';
import { ChangeSetEngine, ValidationError, validateAgentOps } from '../../src/changesets/engine';
import type { Db } from '../../src/database/pool';

let db: Db; let drop: () => Promise<void>; let root: string; let vault: VaultService; let engine: ChangeSetEngine;
let ws: { userId: string; workspaceId: string; slug: string };

const page = (type: string, title: string, body: string) => `---\ntitle: ${title}\ntype: ${type}\ncreated: 2026-10-06\nupdated: 2026-10-06\naliases: []\ntags: [test]\n---\n# ${title}\n\n${body}\n`;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  root = tmpDir('vault-');
  vault = new VaultService(db, root, TEMPLATE_DIR);
  engine = new ChangeSetEngine(db, vault);
  ws = await seedOwner(db);
  await vault.initWorkspace(ws.workspaceId, ws.slug);
});
afterAll(async () => { await drop(); });

async function proposeIngest() {
  const { ops, issues } = validateAgentOps([
    { op: 'create', path: 'wiki/sources/مقاله نمونه.md', content: page('source', 'مقاله نمونه', 'این منبع دربارهٔ [[ویکی شخصی]] است.'), sourceRefs: ['S1'] },
    { op: 'create', path: 'wiki/concepts/ویکی شخصی.md', content: page('concept', 'ویکی شخصی', 'مفهومی که در [[مقاله نمونه]] آمده.'), sourceRefs: ['S1'] },
  ], { allowedSourceRefs: new Set(['S1']) });
  expect(issues).toEqual([]);
  return engine.propose({ workspaceId: ws.workspaceId, runId: null, origin: 'agent', title: 'ingest', summary: '', ops, sourceRefs: [], report: { sourceLabel: 'raw/sample.md' } });
}

describe('ChangeSet engine', () => {
  it('rejects agent writes to raw/, index, config and absolute paths', () => {
    const { ops, issues } = validateAgentOps([
      { op: 'create', path: 'raw/x.md', content: 'x' },
      { op: 'update', path: 'wiki/index.md', content: 'x' },
      { op: 'create', path: '.claude/settings.json', content: '{}' },
      { op: 'create', path: '/etc/passwd', content: 'x' },
      { op: 'create', path: 'wiki/concepts/../../raw/a.md', content: 'x' },
    ], { allowedSourceRefs: new Set() });
    expect(ops).toHaveLength(0); expect(issues).toHaveLength(5);
  });

  it('does not touch canonical files before approval (F02)', async () => {
    const before = fs.readdirSync(path.join(root, ws.slug, 'wiki/concepts'));
    await proposeIngest();
    expect(fs.readdirSync(path.join(root, ws.slug, 'wiki/concepts'))).toEqual(before);
  });

  it('blocks partial accept that breaks link dependencies (F04)', async () => {
    const id = await proposeIngest();
    const items = (await db.query('SELECT seq, depends_on FROM changeset_items WHERE changeset_id=$1 ORDER BY seq', [id])).rows;
    expect(items[0].depends_on).toEqual([2]); expect(items[1].depends_on).toEqual([1]);
    await expect(engine.apply({ workspaceId: ws.workspaceId, slug: ws.slug, changesetId: id, acceptedSeqs: [1], userId: ws.userId, applyKey: 'k-partial' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('applies once under concurrent identical requests and updates index/log (F05)', async () => {
    const id = await proposeIngest();
    const results = await Promise.allSettled([1, 2, 3].map(() => engine.apply({ workspaceId: ws.workspaceId, slug: ws.slug, changesetId: id, acceptedSeqs: 'all', userId: ws.userId, applyKey: 'apply-' + id })));
    const ok = results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<any>).value);
    expect(ok.filter(r => !r.idempotent)).toHaveLength(1);
    const idx = fs.readFileSync(path.join(root, ws.slug, 'wiki/index.md'), 'utf8');
    expect(idx).toContain('- [[ویکی شخصی]]'); expect(idx).toContain('- [[مقاله نمونه]]');
    const logTxt = fs.readFileSync(path.join(root, ws.slug, 'wiki/log.md'), 'utf8');
    expect(logTxt.match(/ingest raw\/sample\.md/g)).toHaveLength(1);
    const revs = (await db.query(`SELECT count(*)::int n FROM document_revisions WHERE changeset_id=$1`, [id])).rows[0].n;
    expect(revs).toBe(4); // 2 pages + index + log
  });

  it('turns a stale proposal into a conflict when the file changed outside the app (F06/E12)', async () => {
    const doc = await vault.getDocumentByPath(db, ws.workspaceId, 'wiki/concepts/ویکی شخصی.md');
    const { ops } = validateAgentOps([{ op: 'update', path: 'wiki/concepts/ویکی شخصی.md', content: doc!.content + '\nافزودهٔ عامل\n', baseRevisionId: doc!.current_revision_id }], { allowedSourceRefs: new Set() });
    const id = await engine.propose({ workspaceId: ws.workspaceId, runId: null, origin: 'agent', title: 'update', summary: '', ops, sourceRefs: [], report: {} });
    fs.appendFileSync(path.join(root, ws.slug, 'wiki/concepts/ویکی شخصی.md'), '\nویرایش Obsidian\n');
    await expect(engine.apply({ workspaceId: ws.workspaceId, slug: ws.slug, changesetId: id, acceptedSeqs: 'all', userId: ws.userId, applyKey: 'k-conf' })).rejects.toBeInstanceOf(ConflictError);
    expect(fs.readFileSync(path.join(root, ws.slug, 'wiki/concepts/ویکی شخصی.md'), 'utf8')).toContain('ویرایش Obsidian');
    expect((await db.query('SELECT status FROM changesets WHERE id=$1', [id])).rows[0].status).toBe('conflict');
    const rep = await vault.reconcile(ws.workspaceId, ws.slug);
    expect(rep.updated).toBe(1);
  });

  it('recovers from a crash between file writes and DB commit (F07)', async () => {
    const { ops } = validateAgentOps([
      { op: 'create', path: 'wiki/entities/ابزار الف.md', content: page('entity', 'ابزار الف', 'متن') },
      { op: 'create', path: 'wiki/entities/ابزار ب.md', content: page('entity', 'ابزار ب', 'متن') },
    ], { allowedSourceRefs: new Set() });
    const id = await engine.propose({ workspaceId: ws.workspaceId, runId: null, origin: 'agent', title: 'crash', summary: '', ops, sourceRefs: [], report: {} });
    const indexBefore = fs.readFileSync(path.join(root, ws.slug, 'wiki/index.md'), 'utf8');
    await expect(engine.apply({ workspaceId: ws.workspaceId, slug: ws.slug, changesetId: id, acceptedSeqs: 'all', userId: ws.userId, applyKey: 'k-crash', crashAfterFiles: 1 })).rejects.toThrow('SIMULATED_CRASH');
    expect(fs.existsSync(path.join(root, ws.slug, 'wiki/entities/ابزار الف.md'))).toBe(true); // half-applied on disk
    expect(await vault.getDocumentByPath(db, ws.workspaceId, 'wiki/entities/ابزار الف.md')).toBeUndefined(); // app readers never saw it
    const n = await engine.recoverJournals(async () => ws.slug);
    expect(n).toBe(1);
    expect(fs.existsSync(path.join(root, ws.slug, 'wiki/entities/ابزار الف.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, ws.slug, 'wiki/index.md'), 'utf8')).toBe(indexBefore);
    expect((await db.query('SELECT status FROM changesets WHERE id=$1', [id])).rows[0].status).toBe('proposed');
    const again = await engine.apply({ workspaceId: ws.workspaceId, slug: ws.slug, changesetId: id, acceptedSeqs: 'all', userId: ws.userId, applyKey: 'k-crash-2' });
    expect(again.status).toBe('applied');
  });

  it('rolls back a changeset without removing a later independent user edit (F08)', async () => {
    const doc = await vault.getDocumentByPath(db, ws.workspaceId, 'wiki/sources/مقاله نمونه.md');
    const lines = doc!.content.split('\n');
    const agentVersion = doc!.content.replace('است.', 'است.\n\nادعای افزودهٔ عامل.');
    const { ops } = validateAgentOps([{ op: 'update', path: 'wiki/sources/مقاله نمونه.md', content: agentVersion }], { allowedSourceRefs: new Set() });
    const id = await engine.propose({ workspaceId: ws.workspaceId, runId: null, origin: 'agent', title: 'agent edit', summary: '', ops, sourceRefs: [], report: {} });
    await engine.apply({ workspaceId: ws.workspaceId, slug: ws.slug, changesetId: id, acceptedSeqs: 'all', userId: ws.userId, applyKey: 'k-rb' });
    // Independent user edit on a different part of the page.
    const cur = await vault.getDocumentByPath(db, ws.workspaceId, 'wiki/sources/مقاله نمونه.md');
    const userEdited = cur!.content.replace(`# ${'مقاله نمونه'}`, `# مقاله نمونه\n\nیادداشت شخصی من.`);
    await vault.saveDocument({ workspaceId: ws.workspaceId, slug: ws.slug, documentId: cur!.id, content: userEdited, baseRevisionId: cur!.current_revision_id, userId: ws.userId });
    const rb = await engine.proposeRollback(ws.workspaceId, id, ws.userId);
    await engine.apply({ workspaceId: ws.workspaceId, slug: ws.slug, changesetId: rb, acceptedSeqs: 'all', userId: ws.userId, applyKey: 'k-rb-apply' });
    const final = fs.readFileSync(path.join(root, ws.slug, 'wiki/sources/مقاله نمونه.md'), 'utf8');
    expect(final).toContain('یادداشت شخصی من.');
    expect(final).not.toContain('ادعای افزودهٔ عامل.');
    expect((await db.query('SELECT status FROM changesets WHERE id=$1', [id])).rows[0].status).toBe('rolled_back');
    expect(lines.length).toBeGreaterThan(3);
  });

  it('rejects stale manual saves with a conflict (optimistic concurrency)', async () => {
    const cur = await vault.getDocumentByPath(db, ws.workspaceId, 'wiki/sources/مقاله نمونه.md');
    await expect(vault.saveDocument({ workspaceId: ws.workspaceId, slug: ws.slug, documentId: cur!.id, content: 'x', baseRevisionId: '00000000-0000-0000-0000-000000000000', userId: ws.userId })).rejects.toBeInstanceOf(ConflictError);
  });
});
