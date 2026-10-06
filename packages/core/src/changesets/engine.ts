import { createTwoFilesPatch, applyPatch, structuredPatch } from 'diff';
import type { Db, Tx } from '../database/pool';
import { withTx } from '../database/pool';
import { sha256Hex } from '../crypto/envelope';
import { normalizeRelPath, atomicWrite, PathError, fsyncDir } from '../vault/paths';
import { VaultService, ConflictError, audit, isManagedPath, kindFromPath } from '../vault/service';
import { parseMarkdown, titleFrom } from '../markdown/frontmatter';
import { extractWikiLinks, buildResolver } from '../markdown/links';
import fsp from 'node:fs/promises';
import { log } from '../log';

export interface ProposedOp {
  op: 'create' | 'update';
  path: string;
  content: string;
  baseRevisionId?: string | null;
  rationale?: string;
  sourceRefs?: string[];
}

export class ValidationError extends Error { constructor(public issues: string[]) { super(issues.join('; ')); } }

const AGENT_WRITABLE = /^wiki\/(sources|concepts|entities|synthesis)\/[^/]+\.md$/;
const MAX_OPS = 40;
const MAX_CONTENT = 200_000;

/** Server-side validation of model output. Anything outside the rules is rejected, not fixed. */
export function validateAgentOps(ops: ProposedOp[], opts: { allowedSourceRefs: Set<string> }): { ops: ProposedOp[]; issues: string[] } {
  const issues: string[] = [];
  const out: ProposedOp[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(ops)) return { ops: [], issues: ['operations must be an array'] };
  if (ops.length > MAX_OPS) issues.push(`too many operations (${ops.length} > ${MAX_OPS})`);
  for (const [i, op] of ops.slice(0, MAX_OPS).entries()) {
    let p: string;
    try { p = normalizeRelPath(op.path); } catch (e) { issues.push(`op ${i}: ${(e as Error).message}`); continue; }
    if (!AGENT_WRITABLE.test(p)) { issues.push(`op ${i}: path ${p} is outside the writable wiki folders (raw/, index, log and config are never agent-writable)`); continue; }
    if (op.op !== 'create' && op.op !== 'update') { issues.push(`op ${i}: operation ${String(op.op)} is not allowed for this skill`); continue; }
    if (typeof op.content !== 'string' || !op.content.trim()) { issues.push(`op ${i}: empty content`); continue; }
    if (op.content.length > MAX_CONTENT) { issues.push(`op ${i}: content too large`); continue; }
    if (seen.has(p)) { issues.push(`op ${i}: duplicate path ${p}`); continue; }
    const parsed = parseMarkdown(op.content);
    if (parsed.errors.length) { issues.push(`op ${i}: invalid frontmatter (${parsed.errors[0]})`); continue; }
    const folderType = p.split('/')[1].replace(/s$/, '').replace('synthesi', 'synthesis').replace('entitie', 'entity');
    if (parsed.data.type && parsed.data.type !== folderType) { issues.push(`op ${i}: frontmatter type ${String(parsed.data.type)} does not match folder ${folderType}`); continue; }
    const refs = (op.sourceRefs ?? []).filter(r => opts.allowedSourceRefs.has(r));
    seen.add(p);
    out.push({ ...op, path: p, sourceRefs: refs });
  }
  return { ops: out, issues };
}

export function unifiedDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 });
}

interface ItemDraft { seq: number; op: 'create' | 'update'; path: string; documentId: string | null; baseSha: string | null; baseRevisionId: string | null; before: string | null; after: string; rationale: string; sourceRefs: string[]; dependsOn: number[] }

export class ChangeSetEngine {
  constructor(private db: Db, private vault: VaultService) {}

  /**
   * Builds a proposed ChangeSet from validated ops. Nothing on disk changes here.
   * Dependencies: an item that links to a page created in the same set depends on it;
   * index/log maintenance is NOT taken from the agent: it is recomputed by trusted code at
   * apply time from the accepted items.
   */
  async propose(args: { workspaceId: string; runId: string | null; origin: 'agent' | 'native_import' | 'manual' | 'vault_import'; title: string; summary: string; ops: ProposedOp[]; sourceRefs: unknown[]; report: Record<string, unknown> }): Promise<string> {
    return withTx(this.db, async tx => {
      const drafts: ItemDraft[] = [];
      for (const [i, op] of args.ops.entries()) {
        const cur = await this.vault.getDocumentByPath(tx, args.workspaceId, op.path);
        if (op.op === 'create' && cur) {
          // The page appeared since the run read the vault: turn into an update against current.
          drafts.push({ seq: i + 1, op: 'update', path: op.path, documentId: cur.id, baseSha: cur.sha256, baseRevisionId: cur.current_revision_id, before: cur.content, after: op.content, rationale: (op.rationale ?? '') + ' [page already existed; shown as update]', sourceRefs: op.sourceRefs ?? [], dependsOn: [] });
          continue;
        }
        if (op.op === 'update' && !cur) throw new ValidationError([`update of missing page ${op.path}`]);
        if (op.op === 'update' && op.baseRevisionId && cur && op.baseRevisionId !== cur.current_revision_id) {
          // Stale base: keep the item but record the real base so the reviewer sees the true diff.
          log.warn('changeset.stale_base', { path: op.path });
        }
        drafts.push({ seq: i + 1, op: op.op, path: op.path, documentId: cur?.id ?? null, baseSha: cur?.sha256 ?? null, baseRevisionId: cur?.current_revision_id ?? null, before: cur?.content ?? null, after: op.content, rationale: op.rationale ?? '', sourceRefs: op.sourceRefs ?? [], dependsOn: [] });
      }
      computeDependencies(drafts, await this.liveTargets(tx, args.workspaceId));
      const cs = await tx.query(
        `INSERT INTO changesets(workspace_id, run_id, origin, title, summary, status, source_refs, report) VALUES ($1,$2,$3,$4,$5,'proposed',$6,$7) RETURNING id`,
        [args.workspaceId, args.runId, args.origin, args.title.slice(0, 300), args.summary.slice(0, 4000), JSON.stringify(args.sourceRefs), JSON.stringify(args.report)]);
      const id = cs.rows[0].id as string;
      for (const d of drafts) {
        await tx.query(
          `INSERT INTO changeset_items(workspace_id, changeset_id, seq, op, path, document_id, base_sha256, base_revision_id, before_content, after_content, after_sha256, diff, depends_on, rationale, source_refs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [args.workspaceId, id, d.seq, d.op, d.path, d.documentId, d.baseSha, d.baseRevisionId, d.before, d.after, sha256Hex(d.after), unifiedDiff(d.path, d.before ?? '', d.after), d.dependsOn, d.rationale.slice(0, 2000), JSON.stringify(d.sourceRefs)]);
      }
      await audit(tx, { workspaceId: args.workspaceId, action: 'changeset.proposed', targetType: 'changeset', targetId: id, result: 'success', meta: { items: drafts.length, origin: args.origin, runId: args.runId } });
      return id;
    });
  }

  private async liveTargets(tx: Tx, workspaceId: string) {
    const r = await tx.query('SELECT id, path, title, aliases FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL', [workspaceId]);
    return r.rows.map(x => ({ id: x.id as string, path: x.path as string, title: x.title as string, aliases: x.aliases as string[] }));
  }

  /** Lets the reviewer edit the proposed text of one item before accepting it. */
  async editItem(workspaceId: string, changesetId: string, seq: number, content: string, userId: string) {
    return withTx(this.db, async tx => {
      const cs = await tx.query(`SELECT status FROM changesets WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE`, [workspaceId, changesetId]);
      if (!cs.rows[0]) throw new PathError('changeset not found', 'not_found');
      if (cs.rows[0].status !== 'proposed') throw new ValidationError(['only proposed changesets can be edited']);
      const it = (await tx.query(`SELECT * FROM changeset_items WHERE changeset_id=$1 AND seq=$2`, [changesetId, seq])).rows[0];
      if (!it) throw new PathError('item not found', 'not_found');
      const parsed = parseMarkdown(content);
      if (parsed.errors.length) throw new ValidationError(['invalid frontmatter: ' + parsed.errors[0]]);
      await tx.query(`UPDATE changeset_items SET after_content=$3, after_sha256=$4, diff=$5, edited_by_user=true WHERE changeset_id=$1 AND seq=$2`,
        [changesetId, seq, content, sha256Hex(content), unifiedDiff(it.path, it.before_content ?? '', content)]);
      await audit(tx, { workspaceId, actorUserId: userId, action: 'changeset.item_edited', targetType: 'changeset', targetId: changesetId, result: 'success', meta: { seq } });
    });
  }

  async reject(workspaceId: string, changesetId: string, userId: string) {
    const r = await this.db.query(`UPDATE changesets SET status='rejected', decided_by=$3, decided_at=now(), updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status IN ('proposed','conflict') RETURNING id, run_id`, [workspaceId, changesetId, userId]);
    if (!r.rowCount) throw new ValidationError(['changeset is not open for decision']);
    await this.db.query(`UPDATE changeset_items SET status='rejected' WHERE changeset_id=$1 AND status='pending'`, [changesetId]);
    await this.db.query(`UPDATE sources SET status='ready_for_analysis', status_detail='پیشنهاد رد شد', updated_at=now() WHERE id IN (SELECT source_id FROM agent_runs WHERE id=$1) AND status='awaiting_review'`, [r.rows[0].run_id]);
    await audit(this.db, { workspaceId, actorUserId: userId, action: 'changeset.rejected', targetType: 'changeset', targetId: changesetId, result: 'success' });
  }

  /**
   * Applies the accepted items. Idempotent per applyKey; serialized per workspace; checks
   * every base revision and the disk hash before writing anything; journaled for crash recovery.
   */
  async apply(args: { workspaceId: string; slug: string; changesetId: string; acceptedSeqs: number[] | 'all'; userId: string; applyKey: string; crashAfterFiles?: number }) {
    const { workspaceId, slug, changesetId } = args;
    // Fast idempotent path.
    const prior = await this.db.query(`SELECT id, status FROM changesets WHERE apply_key=$1`, [args.applyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].id !== changesetId) throw new ValidationError(['apply key already used for a different changeset']);
      return { status: prior.rows[0].status as string, idempotent: true, applied: [] as string[] };
    }
    const client = await this.db.connect();
    let journalId: string | null = null;
    const written: { abs: string; before: string | null }[] = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ws:' + workspaceId]);
      const cs = (await client.query(`SELECT * FROM changesets WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE`, [workspaceId, changesetId])).rows[0];
      if (!cs) throw new PathError('changeset not found', 'not_found');
      if (cs.status === 'applied' || cs.status === 'partially_applied') { await client.query('ROLLBACK'); return { status: cs.status as string, idempotent: true, applied: [] as string[] }; }
      if (cs.status !== 'proposed' && cs.status !== 'conflict') throw new ValidationError([`changeset is ${cs.status}`]);
      const items = (await client.query(`SELECT * FROM changeset_items WHERE changeset_id=$1 ORDER BY seq`, [changesetId])).rows;
      const accepted = new Set(args.acceptedSeqs === 'all' ? items.map(i => i.seq as number) : args.acceptedSeqs);
      const missingDeps: string[] = [];
      for (const it of items) if (accepted.has(it.seq)) for (const d of it.depends_on as number[]) if (!accepted.has(d)) missingDeps.push(`item ${it.seq} (${it.path}) depends on item ${d}`);
      if (missingDeps.length) throw new ValidationError(['partial accept breaks dependencies: ' + missingDeps.join(', ')]);
      if (!accepted.size) throw new ValidationError(['no items accepted']);

      // Conflict detection against DB revision AND disk content.
      const conflicts: { path: string; reason: string }[] = [];
      const plan: { item: Record<string, any>; abs: string; rel: string }[] = [];
      for (const it of items.filter(i => accepted.has(i.seq))) {
        const { abs, rel } = await this.vault.absPath(slug, it.path);
        const cur = await this.vault.getDocumentByPath(client, workspaceId, rel);
        const disk = await this.vault.readDisk(slug, rel);
        if (it.op === 'create') {
          if (cur || disk !== null) conflicts.push({ path: rel, reason: 'page now exists' });
        } else {
          if (!cur) conflicts.push({ path: rel, reason: 'page was deleted' });
          else if (cur.sha256 !== it.base_sha256) conflicts.push({ path: rel, reason: 'page changed after the proposal was made' });
          else if (disk !== null && sha256Hex(disk) !== cur.sha256) conflicts.push({ path: rel, reason: 'file changed on disk outside the app' });
        }
        plan.push({ item: it, abs, rel });
      }
      if (conflicts.length) {
        await client.query(`UPDATE changesets SET status='conflict', report = report || $2::jsonb, updated_at=now() WHERE id=$1`, [changesetId, JSON.stringify({ conflicts })]);
        await audit(client, { workspaceId, actorUserId: args.userId, action: 'changeset.apply', targetType: 'changeset', targetId: changesetId, result: 'failure', meta: { conflicts } });
        await client.query('COMMIT');
        throw new ConflictError({ path: conflicts.map(c => c.path).join(', '), reason: conflicts.map(c => `${c.path}: ${c.reason}`).join('; ') });
      }

      // Trusted index/log maintenance, recomputed from what was actually accepted.
      const maintenance = await this.buildIndexAndLog(client, workspaceId, slug, plan.map(p => p.item), cs);
      for (const m of maintenance) plan.push(m);

      const entries = plan.map(p => ({ rel: p.rel, abs: p.abs, before: p.item.op === 'create' ? null : (p.item.before_content ?? null), after: p.item.op === 'delete' ? null : (p.item.after_content as string), afterSha: p.item.op === 'delete' ? null : sha256Hex(p.item.after_content) }));
      const j = await this.db.query(`INSERT INTO apply_journal(workspace_id, changeset_id, status, entries) VALUES ($1,$2,'prepared',$3) RETURNING id`, [workspaceId, changesetId, JSON.stringify(entries)]);
      journalId = j.rows[0].id;
      await client.query(`UPDATE changesets SET status='applying' WHERE id=$1`, [changesetId]);

      let n = 0;
      for (const e of entries) {
        if (e.after === null) await fsp.rm(e.abs, { force: true }); else await atomicWrite(e.abs, e.after);
        written.push({ abs: e.abs, before: e.before });
        n++;
        if (args.crashAfterFiles && n >= args.crashAfterFiles) throw new Error('SIMULATED_CRASH');
      }

      const applied: string[] = [];
      for (const p of plan) {
        if (p.item.op === 'delete') {
          await client.query(`UPDATE documents SET deleted_at=now(), updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, p.item.document_id]);
          await client.query('DELETE FROM search_chunks WHERE workspace_id=$1 AND document_id=$2', [workspaceId, p.item.document_id]);
          await client.query(`UPDATE changeset_items SET status='applied' WHERE changeset_id=$1 AND seq=$2`, [changesetId, p.item.seq]);
          applied.push(p.rel);
          continue;
        }
        const rec = await this.vault.recordRevision(client, { workspaceId, path: p.rel, content: p.item.after_content, authorKind: cs.origin === 'rollback' ? 'rollback' : cs.origin === 'native_import' ? 'native_import' : 'agent', authorUserId: args.userId, changesetId, documentId: p.item.document_id ?? undefined });
        if (p.item.seq > 0) await client.query(`UPDATE changeset_items SET status='applied', document_id=$3 WHERE changeset_id=$1 AND seq=$2`, [changesetId, p.item.seq, rec.documentId]);
        applied.push(p.rel);
      }
      await client.query(`UPDATE changeset_items SET status='rejected' WHERE changeset_id=$1 AND status='pending'`, [changesetId]);
      await this.vault.resolveLinks(client, workspaceId);
      const finalStatus = accepted.size === items.length ? 'applied' : 'partially_applied';
      await client.query(`UPDATE changesets SET status=$2, apply_key=$3, decided_by=$4, decided_at=now(), applied_at=now(), updated_at=now() WHERE id=$1`, [changesetId, finalStatus, args.applyKey, args.userId]);
      await client.query(`UPDATE apply_journal SET status='committed', updated_at=now() WHERE id=$1`, [journalId]);
      if (cs.run_id) {
        await client.query(`UPDATE sources SET status='applied', updated_at=now() WHERE id=(SELECT source_id FROM agent_runs WHERE id=$1)`, [cs.run_id]);
      }
      if (cs.rollback_of) await client.query(`UPDATE changesets SET status='rolled_back', rolled_back_by=$2, updated_at=now() WHERE id=$1`, [cs.rollback_of, changesetId]);
      await audit(client, { workspaceId, actorUserId: args.userId, action: 'changeset.applied', targetType: 'changeset', targetId: changesetId, result: 'success', meta: { files: applied.length, status: finalStatus } });
      await client.query('COMMIT');
      return { status: finalStatus, idempotent: false, applied };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((e as Error).message === 'SIMULATED_CRASH') throw e; // test hook: leave files + journal as a real crash would
      if (journalId) {
        // Roll back any files already renamed into place, then mark the journal.
        for (const w of written.reverse()) {
          try { if (w.before === null) await fsp.rm(w.abs, { force: true }); else await atomicWrite(w.abs, w.before); } catch (re) { log.error('apply.rollback_file_failed', { error: (re as Error).message }); }
        }
        await this.db.query(`UPDATE apply_journal SET status='rolled_back', updated_at=now() WHERE id=$1`, [journalId]).catch(() => undefined);
        await this.db.query(`UPDATE changesets SET status='proposed' WHERE id=$1 AND status='applying'`, [changesetId]).catch(() => undefined);
      }
      throw e;
    } finally { client.release(); }
  }

  /** Builds index.md and log.md updates for the accepted items (trusted code, not agent text). */
  private async buildIndexAndLog(q: Tx, workspaceId: string, slug: string, items: Record<string, any>[], cs: Record<string, any>) {
    const out: { item: Record<string, any>; abs: string; rel: string }[] = [];
    const created = items.filter(i => i.op === 'create');
    const today = new Date().toISOString().slice(0, 10);
    const sections: Record<string, string> = { concept: 'Concepts', entity: 'Entities', synthesis: 'Synthesis', source: 'Sources' };
    const index = await this.vault.getDocumentByPath(q, workspaceId, 'wiki/index.md');
    if (index && created.length) {
      let txt = index.content;
      for (const c of created) {
        const kind = kindFromPath(c.path);
        const sec = sections[kind];
        if (!sec) continue;
        const title = titleFrom(parseMarkdown(c.after_content), c.path);
        const line = `- [[${title}]]`;
        if (txt.includes(line)) continue;
        txt = insertUnderHeading(txt, sec, line);
      }
      // Gaps: links in accepted pages that resolve nowhere (after accounting for created pages).
      const targets = (await q.query('SELECT id, path, title, aliases FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL', [workspaceId])).rows
        .map(r => ({ id: r.id, path: r.path, title: r.title, aliases: r.aliases }))
        .concat(created.map((c, i) => ({ id: `new-${i}`, path: c.path, title: titleFrom(parseMarkdown(c.after_content), c.path), aliases: [] })));
      const resolve = buildResolver(targets);
      const gaps = new Set<string>();
      for (const it of items) for (const l of extractWikiLinks(parseMarkdown(it.after_content).body)) if (resolve(l.target).status === 'missing') gaps.add(l.target);
      for (const g of gaps) { const line = `- [[${g}]]`; if (!txt.includes(line)) txt = insertUnderHeading(txt, 'Gaps', line); }
      txt = txt.replace(/^updated: .*$/m, `updated: ${today}`);
      if (txt !== index.content) {
        const { abs, rel } = await this.vault.absPath(slug, 'wiki/index.md');
        out.push({ rel, abs, item: { seq: -1, op: 'update', path: rel, document_id: index.id, before_content: index.content, after_content: txt } });
      }
    }
    const logDoc = await this.vault.getDocumentByPath(q, workspaceId, 'wiki/log.md');
    if (logDoc && items.length) {
      const report = cs.report ?? {};
      const what = cs.origin === 'rollback' ? 'rollback' : cs.origin === 'native_import' ? 'native-import' : cs.origin === 'manual' ? 'note' : 'ingest';
      const line = `${today} ${what} ${String(report.sourceLabel ?? cs.title).replace(/\n/g, ' ').slice(0, 120)} -> ${created.length} new, ${items.length - created.length} updated (changeset ${String(cs.id).slice(0, 8)})`;
      const after = logDoc.content.replace(/\s*$/, '\n') + line + '\n';
      const { abs, rel } = await this.vault.absPath(slug, 'wiki/log.md');
      out.push({ rel, abs, item: { seq: -2, op: 'update', path: rel, document_id: logDoc.id, before_content: logDoc.content, after_content: after } });
    }
    return out;
  }

  /**
   * Rollback = a new inverse ChangeSet. Each file's inverse patch (after→before of the
   * original change) is applied to the CURRENT content, so later independent edits by the
   * user survive. If the patch no longer applies, the item is a conflict.
   */
  async proposeRollback(workspaceId: string, changesetId: string, userId: string): Promise<string> {
    const cs = (await this.db.query(`SELECT * FROM changesets WHERE workspace_id=$1 AND id=$2`, [workspaceId, changesetId])).rows[0];
    if (!cs || !['applied', 'partially_applied'].includes(cs.status)) throw new ValidationError(['only applied changesets can be rolled back']);
    const revs = (await this.db.query(
      `SELECT r.document_id, r.content AS after, d.path, prev.content AS before
       FROM document_revisions r JOIN documents d ON d.id=r.document_id
       LEFT JOIN document_revisions prev ON prev.document_id=r.document_id AND prev.revision=r.revision-1
       WHERE r.changeset_id=$1 AND d.path NOT IN ('wiki/index.md','wiki/log.md')`, [changesetId])).rows;
    const ops: { op: 'update'; path: string; content: string; documentId: string; current: Record<string, any> }[] = [];
    const conflicts: string[] = [];
    for (const r of revs) {
      const current = await this.vault.getDocument(this.db, workspaceId, r.document_id);
      if (!current) { conflicts.push(`${r.path}: deleted since`); continue; }
      if (r.before === null) {
        // Page was created by the changeset: rollback = delete only if untouched since; else keep and report.
        if (current.content === r.after) ops.push({ op: 'update', path: r.path, content: '', documentId: r.document_id, current });
        else conflicts.push(`${r.path}: created by this change but edited afterwards; not deleted`);
        continue;
      }
      const inverse = structuredPatch(r.path, r.path, r.after, r.before, '', '', { context: 2 });
      const result = applyPatch(current.content, inverse, { fuzzFactor: 0 });
      if (result === false) conflicts.push(`${r.path}: later edits overlap the changed lines`);
      else if (result !== current.content) ops.push({ op: 'update', path: r.path, content: result, documentId: r.document_id, current });
    }
    return withTx(this.db, async tx => {
      const ins = await tx.query(
        `INSERT INTO changesets(workspace_id, origin, title, summary, status, rollback_of, report) VALUES ($1,'rollback',$2,$3,$4,$5,$6) RETURNING id`,
        [workspaceId, `بازگردانی: ${cs.title}`.slice(0, 300), 'بستهٔ معکوس؛ ویرایش‌های مستقل بعدی حفظ می‌شوند.', conflicts.length && !ops.length ? 'conflict' : 'proposed', changesetId, JSON.stringify({ conflicts, sourceLabel: `rollback of ${String(changesetId).slice(0, 8)}` })]);
      const id = ins.rows[0].id as string;
      let seq = 0;
      for (const o of ops) {
        seq++;
        const isDelete = o.content === '';
        await tx.query(
          `INSERT INTO changeset_items(workspace_id, changeset_id, seq, op, path, document_id, base_sha256, base_revision_id, before_content, after_content, after_sha256, diff, rationale)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [workspaceId, id, seq, isDelete ? 'delete' : 'update', o.path, o.documentId, o.current.sha256, o.current.current_revision_id, o.current.content, o.content, sha256Hex(o.content), unifiedDiff(o.path, o.current.content, o.content), isDelete ? 'صفحه توسط همین تغییر ساخته شده بود' : 'وصلهٔ معکوس روی متن فعلی']);
      }
      await audit(tx, { workspaceId, actorUserId: userId, action: 'changeset.rollback_proposed', targetType: 'changeset', targetId: id, result: 'success', meta: { of: changesetId, items: ops.length, conflicts: conflicts.length } });
      return id;
    });
  }

  /** Crash recovery: undo files of journals that never committed. Run at API startup. */
  async recoverJournals(slugOf: (workspaceId: string) => Promise<string | null>) {
    const rows = (await this.db.query(`SELECT * FROM apply_journal WHERE status='prepared' ORDER BY created_at`)).rows;
    let recovered = 0;
    for (const j of rows) {
      const committed = (await this.db.query(`SELECT status FROM changesets WHERE id=$1`, [j.changeset_id])).rows[0]?.status;
      if (committed === 'applied' || committed === 'partially_applied') {
        await this.db.query(`UPDATE apply_journal SET status='committed', updated_at=now() WHERE id=$1`, [j.id]);
        continue;
      }
      const slug = await slugOf(j.workspace_id);
      if (!slug) continue;
      for (const e of j.entries as { rel: string; before: string | null; afterSha: string | null }[]) {
        const { abs } = await this.vault.absPath(slug, e.rel);
        let disk: string | null = null;
        try { disk = await fsp.readFile(abs, 'utf8'); } catch { disk = null; }
        if (e.afterSha === null) { if (disk === null && e.before !== null) await atomicWrite(abs, e.before); }
        else if (disk !== null && sha256Hex(disk) === e.afterSha) {
          if (e.before === null) await fsp.rm(abs, { force: true }); else await atomicWrite(abs, e.before);
        }
        await fsyncDir(abs.slice(0, abs.lastIndexOf('/')));
      }
      await this.db.query(`UPDATE apply_journal SET status='rolled_back', updated_at=now() WHERE id=$1`, [j.id]);
      await this.db.query(`UPDATE changesets SET status='proposed', report = report || '{"recoveredFromCrash":true}'::jsonb, updated_at=now() WHERE id=$1 AND status='applying'`, [j.changeset_id]);
      await audit(this.db, { workspaceId: j.workspace_id, action: 'changeset.crash_recovered', targetType: 'changeset', targetId: j.changeset_id, result: 'success' });
      recovered++;
    }
    return recovered;
  }
}

export function computeDependencies(drafts: { seq: number; op: string; path: string; after: string; dependsOn: number[] }[], live: { id: string; path: string; title: string; aliases: string[] }[]) {
  const createdTargets = drafts.filter(d => d.op === 'create').map(d => ({ id: `seq:${d.seq}`, path: d.path, title: titleFrom(parseMarkdown(d.after), d.path), aliases: [] as string[] }));
  const resolveNew = buildResolver(createdTargets);
  const resolveLive = buildResolver(live);
  for (const d of drafts) {
    const deps = new Set<number>();
    for (const l of extractWikiLinks(parseMarkdown(d.after).body)) {
      if (resolveLive(l.target).status === 'resolved') continue;
      const r = resolveNew(l.target);
      if (r.status === 'resolved') { const s = Number(r.id.slice(4)); if (s !== d.seq) deps.add(s); }
    }
    d.dependsOn = [...deps].sort((a, b) => a - b);
  }
}

function insertUnderHeading(txt: string, heading: string, line: string): string {
  const re = new RegExp(`(^## ${heading}\\s*\\n)([\\s\\S]*?)(?=\\n## |$(?![\\s\\S]))`, 'm');
  const m = re.exec(txt);
  if (!m) return txt.replace(/\s*$/, '\n') + `\n## ${heading}\n\n${line}\n`;
  let body = m[2].replace(/^\s*_Nothing yet\._\s*$/m, '').replace(/\s+$/, '');
  body = (body ? body + '\n' : '\n') + line + '\n';
  return txt.slice(0, m.index) + m[1] + body + txt.slice(m.index + m[0].length);
}

export { isManagedPath };
