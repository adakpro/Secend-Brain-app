import type { FastifyPluginAsync } from 'fastify';
import { ScheduleBody } from '@sb/contracts';
import { QUEUES, lintReport, graphMetrics, validateCron, nextSlot, audit, skillById, SKILLS } from '@sb/core';
import { type Deps, parse, requireWs, HttpError } from '../context';
import { modelAvailability } from './system';

export const knowledgeRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  // ---------------- Graph ----------------
  app.get('/graph', async req => {
    const ws = requireWs(req);
    const q = req.query as { focus?: string; kinds?: string; limit?: string; tags?: string };
    const kinds = (q.kinds ?? 'source,concept,entity,synthesis,note').split(',').filter(k => ['source', 'concept', 'entity', 'synthesis', 'note', 'project', 'output'].includes(k));
    const limit = Math.min(Number(q.limit ?? 150) || 150, 400);
    let ids: string[] | null = null;
    if (q.focus && /^[0-9a-f-]{36}$/.test(q.focus)) {
      const nb = await deps.db.query(`SELECT $2::uuid AS id UNION SELECT to_document_id FROM links WHERE workspace_id=$1 AND from_document_id=$2 AND to_document_id IS NOT NULL UNION SELECT from_document_id FROM links WHERE workspace_id=$1 AND to_document_id=$2`, [ws.id, q.focus]);
      ids = nb.rows.map(r => r.id);
    }
    const nodes = (await deps.db.query(
      `SELECT d.id, d.title, d.kind, d.path, d.tags, (SELECT count(*)::int FROM links l WHERE l.to_document_id=d.id OR l.from_document_id=d.id AND l.status='resolved') AS degree
       FROM documents d WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND d.kind = ANY($2) AND ($3::uuid[] IS NULL OR d.id = ANY($3)) ORDER BY degree DESC, d.updated_at DESC LIMIT $4`, [ws.id, kinds, ids, limit])).rows;
    const nodeIds = nodes.map(n => n.id);
    const links = (await deps.db.query(`SELECT DISTINCT from_document_id AS source, to_document_id AS target, link_kind FROM links WHERE workspace_id=$1 AND status='resolved' AND from_document_id = ANY($2) AND to_document_id = ANY($2) AND from_document_id <> to_document_id`, [ws.id, nodeIds])).rows;
    const edges: { source: string; target: string; type: 'link' | 'accepted_relation' | 'shared_tag'; label?: string }[] = links.map(l => ({ source: l.source, target: l.target, type: l.link_kind === 'accepted_relation' ? 'accepted_relation' : 'link' }));
    if (q.tags === 'true') {
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const shared = (nodes[i].tags as string[]).filter(t => (nodes[j].tags as string[]).includes(t));
        if (shared.length) edges.push({ source: nodes[i].id, target: nodes[j].id, type: 'shared_tag', label: shared.slice(0, 3).join(', ') });
        if (edges.length > 2000) break;
      }
    }
    const total = (await deps.db.query(`SELECT count(*)::int n FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL AND kind = ANY($2)`, [ws.id, kinds])).rows[0].n;
    return { nodes, edges, total, truncated: total > nodes.length, semanticSuggestions: { available: false, reason: 'پیشنهاد ارتباط معنایی (embedding) در نسخهٔ ۱ پیاده نشده است؛ خطوط فقط لینک واقعی یا برچسب مشترک‌اند.' } };
  });

  // ---------------- Learning ----------------
  app.get('/learning/items', async req => {
    const ws = requireWs(req);
    const r = await deps.db.query(
      `SELECT q.id, q.question, q.choices, q.explanation, q.document_id, q.revision_id, q.excerpt, q.created_at, d.title AS doc_title,
         CASE WHEN q.status <> 'active' THEN q.status WHEN d.id IS NULL OR d.deleted_at IS NOT NULL OR d.current_revision_id <> q.revision_id THEN 'stale' ELSE 'active' END AS status,
         (SELECT row_to_json(a) FROM (SELECT correct, chosen, next_review_at, created_at FROM quiz_attempts WHERE quiz_item_id=q.id AND user_id=$2 ORDER BY created_at DESC LIMIT 1) a) AS last_attempt
       FROM quiz_items q LEFT JOIN documents d ON d.id=q.document_id WHERE q.workspace_id=$1 ORDER BY q.created_at DESC LIMIT 200`, [ws.id, req.session!.userId]);
    const done = (await deps.db.query(`SELECT count(*)::int n FROM quiz_attempts WHERE workspace_id=$1 AND user_id=$2`, [ws.id, req.session!.userId])).rows[0].n;
    return { items: r.rows, attempts: done };
  });

  app.post('/learning/generate', async req => {
    const ws = requireWs(req, 'member');
    const { documentIds, count } = req.body as { documentIds?: string[]; count?: number };
    if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > 20) throw new HttpError(422, 'validation_failed', 'یک تا بیست صفحه انتخاب کنید.');
    const n = (await deps.db.query(`SELECT count(*)::int n FROM documents WHERE workspace_id=$1 AND id = ANY($2) AND deleted_at IS NULL`, [ws.id, documentIds])).rows[0].n;
    if (n !== new Set(documentIds).size) throw new HttpError(403, 'forbidden_scope', 'بخشی از صفحات در این فضا نیست.');
    const avail = await modelAvailability(deps);
    if (!avail.available) throw new HttpError(409, 'model_not_connected', avail.reason);
    const run = await deps.runs.create(deps.db, { workspaceId: ws.id, kind: 'quiz', skillId: 'quiz', input: { documentIds, count: Math.min(Number(count ?? 5), 10) }, requestedBy: req.session!.userId });
    await deps.boss!.send(QUEUES.run, { runId: run.id }, { singletonKey: run.id });
    return { runId: run.id };
  });

  app.post('/learning/items/:id/attempt', async req => {
    const ws = requireWs(req);
    const { chosen } = req.body as { chosen: number };
    const q = (await deps.db.query(`SELECT * FROM quiz_items WHERE workspace_id=$1 AND id=$2`, [ws.id, (req.params as { id: string }).id])).rows[0];
    if (!q) throw new HttpError(404, 'not_found', 'سؤال پیدا نشد.');
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= q.choices.length) throw new HttpError(422, 'validation_failed', 'گزینه نامعتبر است.');
    const correct = chosen === q.answer_index;
    // Simple, explainable spacing: right answers double the interval (from the last one), wrong answers reset to 1 day.
    const prev = (await deps.db.query(`SELECT correct, created_at, next_review_at FROM quiz_attempts WHERE quiz_item_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`, [q.id, req.session!.userId])).rows[0];
    const prevDays = prev?.correct && prev.next_review_at ? Math.max(1, Math.round((Date.parse(prev.next_review_at) - Date.parse(prev.created_at)) / 86400000)) : 1;
    const days = correct ? Math.min(prevDays * 2, 60) : 1;
    await deps.db.query(`INSERT INTO quiz_attempts(workspace_id, quiz_item_id, user_id, chosen, correct, next_review_at) VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6))`, [ws.id, q.id, req.session!.userId, chosen, correct, days]);
    const doc = q.document_id ? (await deps.db.query(`SELECT id, title, current_revision_id FROM documents WHERE id=$1`, [q.document_id])).rows[0] : null;
    return { correct, answerIndex: q.answer_index, explanation: q.explanation, excerpt: q.excerpt, document: doc ? { id: doc.id, title: doc.title, stale: doc.current_revision_id !== q.revision_id } : null, nextReviewInDays: days };
  });

  // ---------------- Activity & health ----------------
  app.get('/activity', async req => {
    const ws = requireWs(req);
    const runs = (await deps.db.query(`SELECT r.id, r.kind, r.skill_id, r.status, r.provider, r.error_code, r.error_message, r.usage, r.cost_estimate_usd, r.created_at, r.finished_at, s.title AS source_title FROM agent_runs r LEFT JOIN sources s ON s.id=r.source_id WHERE r.workspace_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [ws.id])).rows;
    const events = (await deps.db.query(`SELECT a.id, a.action, a.result, a.target_type, a.target_id, a.created_at, u.display_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [ws.id])).rows;
    const stats = (await deps.db.query(`SELECT
        (SELECT count(*)::int FROM agent_runs WHERE workspace_id=$1 AND status IN ('queued','running')) AS active_runs,
        (SELECT count(*)::int FROM agent_runs WHERE workspace_id=$1 AND status='failed' AND created_at > now() - interval '7 days') AS failed_7d,
        (SELECT count(*)::int FROM changesets WHERE workspace_id=$1 AND status='conflict') AS conflicts,
        (SELECT coalesce(sum((usage->>'input_tokens')::bigint),0) FROM agent_runs WHERE workspace_id=$1 AND provider='anthropic' AND created_at > now() - interval '30 days') AS input_tokens_30d,
        (SELECT coalesce(sum((usage->>'output_tokens')::bigint),0) FROM agent_runs WHERE workspace_id=$1 AND provider='anthropic' AND created_at > now() - interval '30 days') AS output_tokens_30d,
        (SELECT coalesce(sum(cost_estimate_usd),0)::float FROM agent_runs WHERE workspace_id=$1 AND provider='anthropic' AND created_at > now() - interval '30 days') AS cost_estimate_30d,
        (SELECT avg(extract(epoch FROM finished_at - started_at))::float FROM agent_runs WHERE workspace_id=$1 AND finished_at IS NOT NULL AND started_at IS NOT NULL AND created_at > now() - interval '30 days') AS avg_run_s`, [ws.id])).rows[0];
    return { runs, events, stats };
  });

  app.get('/health/knowledge', async req => {
    const ws = requireWs(req);
    return { lint: await lintReport(deps.db, ws.id), graph: await graphMetrics(deps.db, ws.id) };
  });

  app.get('/skills', async req => {
    requireWs(req);
    return { skills: SKILLS.map(s => ({ id: s.id, title: s.title, version: s.version, mode: s.mode, status: s.status, upstreamFile: s.upstreamFile, note: s.note ?? null })) };
  });

  // ---------------- Schedules ----------------
  app.get('/schedules', async req => {
    const ws = requireWs(req);
    const r = await deps.db.query(`SELECT s.*, r.status AS last_run_status FROM schedules s LEFT JOIN agent_runs r ON r.id=s.last_run_id WHERE s.workspace_id=$1 ORDER BY s.created_at`, [ws.id]);
    return { items: r.rows.map(s => { let next: string | null = null; try { next = s.enabled ? nextSlot(s.cron, s.timezone).toISOString() : null; } catch { next = null; } return { ...s, next_run_at: next }; }) };
  });

  app.post('/schedules', async req => {
    const ws = requireWs(req, 'admin');
    const b = parse(ScheduleBody, req.body);
    try { validateCron(b.cron, b.timezone); } catch { throw new HttpError(422, 'invalid_cron', 'عبارت زمان‌بندی یا منطقهٔ زمانی معتبر نیست.'); }
    if (!skillById(b.skillId)) throw new HttpError(422, 'invalid_skill', 'مهارت نامعتبر.');
    const r = await deps.db.query(`INSERT INTO schedules(workspace_id, name, skill_id, cron, timezone, enabled, missed_policy, budget_usd, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [ws.id, b.name, b.skillId, b.cron, b.timezone, b.enabled, b.missedPolicy, b.budgetUsd ?? null, req.session!.userId]);
    await audit(deps.db, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'schedule.created', targetType: 'schedule', targetId: r.rows[0].id, result: 'success', meta: { skill: b.skillId } });
    return { id: r.rows[0].id };
  });

  app.patch('/schedules/:id', async req => {
    const ws = requireWs(req, 'admin');
    const b = req.body as { enabled?: boolean };
    const r = await deps.db.query(`UPDATE schedules SET enabled=coalesce($3,enabled), paused_reason=CASE WHEN $3 THEN NULL ELSE 'paused_by_user' END, updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`, [ws.id, (req.params as { id: string }).id, typeof b.enabled === 'boolean' ? b.enabled : null]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'زمان‌بندی پیدا نشد.');
    return { ok: true };
  });

  app.delete('/schedules/:id', async req => {
    const ws = requireWs(req, 'admin');
    await deps.db.query(`DELETE FROM schedules WHERE workspace_id=$1 AND id=$2`, [ws.id, (req.params as { id: string }).id]);
    return { ok: true };
  });
};
