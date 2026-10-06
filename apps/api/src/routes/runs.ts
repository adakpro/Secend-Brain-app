import type { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import { log, QUEUES } from '@sb/core';
import { type Deps, requireWs, requireSession, HttpError } from '../context';

/** One LISTEN connection per API process fans run_events notifications out to SSE subscribers. */
export class RunEventHub {
  private subs = new Map<string, Set<() => void>>();
  private client: pg.Client | null = null;
  constructor(private url: string) {}
  async start() {
    const connect = async () => {
      try {
        const c = new pg.Client({ connectionString: this.url });
        c.on('error', () => { this.client = null; setTimeout(connect, 2000); });
        await c.connect();
        await c.query('LISTEN run_events');
        c.on('notification', n => { try { const { runId } = JSON.parse(n.payload ?? '{}'); this.subs.get(runId)?.forEach(f => f()); } catch { /* ignore */ } });
        this.client = c;
        // After a reconnect, nudge everyone so they re-query anything missed while disconnected.
        this.subs.forEach(set => set.forEach(f => f()));
      } catch (e) { log.warn('sse.listen_failed', { error: (e as Error).message }); setTimeout(connect, 2000); }
    };
    await connect();
  }
  subscribe(runId: string, f: () => void) { const s = this.subs.get(runId) ?? new Set(); s.add(f); this.subs.set(runId, s); return () => { s.delete(f); if (!s.size) this.subs.delete(runId); }; }
  async stop() { await this.client?.end().catch(() => undefined); }
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_review']);

export const runRoutes = (deps: Deps, hub?: RunEventHub): FastifyPluginAsync => async app => {
  app.get('/runs', async req => {
    const ws = requireWs(req);
    const q = req.query as { limit?: string; status?: string };
    const r = await deps.db.query(
      `SELECT r.id, r.kind, r.skill_id, r.status, r.provider, r.model, r.error_code, r.error_message, r.usage, r.cost_estimate_usd, r.attempt, r.created_at, r.started_at, r.finished_at, r.source_id, s.title AS source_title, r.schedule_id
       FROM agent_runs r LEFT JOIN sources s ON s.id=r.source_id WHERE r.workspace_id=$1 AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC LIMIT $3`,
      [ws.id, q.status ?? null, Math.min(Number(q.limit ?? 50) || 50, 200)]);
    return { items: r.rows };
  });

  app.get('/runs/:id', async req => {
    const ws = requireWs(req);
    const r = (await deps.db.query(`SELECT * FROM agent_runs WHERE workspace_id=$1 AND id=$2`, [ws.id, (req.params as { id: string }).id])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'اجرا پیدا نشد.');
    delete r.input?.apiKey;
    return { run: r };
  });

  app.post('/runs/:id/cancel', async req => {
    const ws = requireWs(req, 'member');
    const st = await deps.runs.requestCancel(ws.id, (req.params as { id: string }).id, req.session!.userId);
    if (!st) throw new HttpError(404, 'not_found', 'اجرا پیدا نشد.');
    return { status: st, notice: 'لغو، هزینهٔ درخواست‌هایی را که پیش‌تر به ارائه‌دهنده رسیده‌اند صفر نمی‌کند.' };
  });

  /** Explicit retry of a failed/interrupted run: a NEW queued attempt on the same run record. */
  app.post('/runs/:id/retry', async req => {
    const ws = requireWs(req, 'member');
    const id = (req.params as { id: string }).id;
    const r = (await deps.db.query(`SELECT status FROM agent_runs WHERE workspace_id=$1 AND id=$2`, [ws.id, id])).rows[0];
    if (!r || !['failed', 'interrupted'].includes(r.status)) throw new HttpError(409, 'not_retryable', 'فقط اجرای ناموفق یا قطع‌شده قابل تکرار است.');
    await deps.runs.transition(deps.db, id, 'queued', { error_code: null, error_message: null, finished_at: null });
    await deps.boss!.send(QUEUES.run, { runId: id }, { singletonKey: id });
    return { ok: true };
  });

  /**
   * SSE stream of one run. Authorization: session cookie + membership of the run's workspace.
   * Resume: Last-Event-ID (or ?after=) returns only later events of THIS run.
   */
  app.get('/runs/:id/events', async (req, reply) => {
    const s = requireSession(req);
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'not_found', 'اجرا پیدا نشد.');
    const run = (await deps.db.query(`SELECT r.workspace_id FROM agent_runs r JOIN memberships m ON m.workspace_id=r.workspace_id AND m.user_id=$2 WHERE r.id=$1`, [id, s.userId])).rows[0];
    if (!run) throw new HttpError(404, 'not_found', 'اجرا پیدا نشد.');
    let last = Number(req.headers['last-event-id'] ?? (req.query as { after?: string }).after ?? 0) || 0;
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-request-id': req.id });
    let busy = false; let again = false; let closed = false;
    const pump = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false;
          const ev = await deps.db.query(`SELECT id, seq, type, data, created_at FROM run_events WHERE run_id=$1 AND workspace_id=$2 AND id > $3 ORDER BY id LIMIT 500`, [id, run.workspace_id, last]);
          for (const e of ev.rows) { reply.raw.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, ...e.data, at: e.created_at })}\n\n`); last = e.id; }
          const st = (await deps.db.query(`SELECT status FROM agent_runs WHERE id=$1`, [id])).rows[0]?.status;
          if (TERMINAL.has(st) && ev.rows.length < 500) { reply.raw.write(`event: end\ndata: ${JSON.stringify({ status: st })}\n\n`); cleanup(); reply.raw.end(); return; }
        } while (again);
      } catch (e) { log.warn('sse.pump_error', { error: (e as Error).message }); } finally { busy = false; }
    };
    const unsub = hub ? hub.subscribe(id, () => void pump()) : () => undefined;
    const ping = setInterval(() => { reply.raw.write(': ping\n\n'); void pump(); }, 15_000);
    const cleanup = () => { if (closed) return; closed = true; clearInterval(ping); unsub(); };
    reply.raw.on('close', cleanup);
    await pump();
    return reply;
  });
};
