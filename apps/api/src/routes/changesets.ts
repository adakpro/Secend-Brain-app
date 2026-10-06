import type { FastifyPluginAsync } from 'fastify';
import { ApplyChangeSetBody, EditItemBody } from '@sb/contracts';
import { type Deps, parse, requireWs, HttpError } from '../context';

export const changesetRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  app.get('/changesets', async req => {
    const ws = requireWs(req);
    const { status } = req.query as { status?: string };
    const statuses = status === 'open' ? ['proposed', 'conflict'] : status ? status.split(',') : null;
    const r = await deps.db.query(
      `SELECT c.id, c.title, c.summary, c.status, c.origin, c.created_at, c.applied_at, c.rollback_of, c.rolled_back_by, c.report, c.run_id,
         (SELECT count(*)::int FROM changeset_items i WHERE i.changeset_id=c.id) AS items,
         (SELECT json_agg(json_build_object('op', i.op, 'path', i.path) ORDER BY i.seq) FROM changeset_items i WHERE i.changeset_id=c.id) AS item_summary,
         r.provider, s.title AS source_title, s.id AS source_id
       FROM changesets c LEFT JOIN agent_runs r ON r.id=c.run_id LEFT JOIN sources s ON s.id=r.source_id
       WHERE c.workspace_id=$1 AND ($2::text[] IS NULL OR c.status = ANY($2)) ORDER BY c.created_at DESC LIMIT 100`, [ws.id, statuses]);
    return { items: r.rows };
  });

  app.get('/changesets/:id', async req => {
    const ws = requireWs(req);
    const { id } = req.params as { id: string };
    const c = (await deps.db.query(`SELECT c.*, r.provider, r.model, r.source_id, s.title AS source_title FROM changesets c LEFT JOIN agent_runs r ON r.id=c.run_id LEFT JOIN sources s ON s.id=r.source_id WHERE c.workspace_id=$1 AND c.id=$2`, [ws.id, id])).rows[0];
    if (!c) throw new HttpError(404, 'not_found', 'بسته پیدا نشد.');
    const items = (await deps.db.query(`SELECT seq, op, path, new_path, document_id, base_sha256, base_revision_id, diff, depends_on, status, rationale, source_refs, edited_by_user, before_content, after_content FROM changeset_items WHERE changeset_id=$1 ORDER BY seq`, [id])).rows;
    // Live conflict preview: compare each item's base with the current revision now.
    for (const it of items) {
      if (!it.document_id || it.status !== 'pending') continue;
      const cur = (await deps.db.query(`SELECT r.sha256 FROM documents d JOIN document_revisions r ON r.id=d.current_revision_id WHERE d.id=$1`, [it.document_id])).rows[0];
      it.stale = cur ? cur.sha256 !== it.base_sha256 : true;
    }
    return { changeset: c, items, maintenanceNote: 'به‌روزرسانی wiki/index.md و wiki/log.md را برنامه هنگام اعمال، فقط براساس موارد پذیرفته‌شده می‌سازد.' };
  });

  app.put('/changesets/:id/items/:seq', async req => {
    const ws = requireWs(req, 'member');
    const { id, seq } = req.params as { id: string; seq: string };
    const b = parse(EditItemBody, req.body);
    await deps.engine.editItem(ws.id, id, Number(seq), b.content, req.session!.userId);
    return { ok: true };
  });

  app.post('/changesets/:id/apply', async req => {
    const ws = requireWs(req, 'member');
    const { id } = req.params as { id: string };
    const b = parse(ApplyChangeSetBody, req.body);
    const r = await deps.engine.apply({ workspaceId: ws.id, slug: ws.slug, changesetId: id, acceptedSeqs: b.accepted, userId: req.session!.userId, applyKey: b.applyKey });
    if (!r.idempotent) {
      const run = (await deps.db.query(`SELECT run_id FROM changesets WHERE id=$1`, [id])).rows[0]?.run_id;
      if (run) await deps.runs.transition(deps.db, run, 'succeeded', {}).catch(() => undefined);
    }
    return r;
  });

  app.post('/changesets/:id/reject', async req => {
    const ws = requireWs(req, 'member');
    const { id } = req.params as { id: string };
    await deps.engine.reject(ws.id, id, req.session!.userId);
    const run = (await deps.db.query(`SELECT run_id FROM changesets WHERE id=$1`, [id])).rows[0]?.run_id;
    if (run) await deps.runs.transition(deps.db, run, 'succeeded', {}).catch(() => undefined);
    return { ok: true };
  });

  app.post('/changesets/:id/reopen', async req => {
    const ws = requireWs(req, 'member');
    const r = await deps.db.query(`UPDATE changesets SET status='proposed', updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status IN ('rejected','conflict') RETURNING id`, [ws.id, (req.params as { id: string }).id]);
    if (!r.rowCount) throw new HttpError(409, 'not_reopenable', 'این بسته قابل بازگشایی نیست.');
    await deps.db.query(`UPDATE changeset_items SET status='pending' WHERE changeset_id=$1 AND status IN ('rejected','conflict')`, [(req.params as { id: string }).id]);
    return { ok: true };
  });

  app.post('/changesets/:id/rollback', async req => {
    const ws = requireWs(req, 'member');
    const id = await deps.engine.proposeRollback(ws.id, (req.params as { id: string }).id, req.session!.userId);
    return { rollbackChangesetId: id };
  });
};
