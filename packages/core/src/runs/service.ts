import type { Db, Queryable } from '../database/pool';
import { randomToken, sha256Buf } from '../crypto/envelope';
import { skillById } from '../agents/registry';
import { audit } from '../vault/service';

export type RunStatus = 'queued' | 'running' | 'waiting_for_review' | 'succeeded' | 'failed' | 'cancel_requested' | 'canceled' | 'interrupted';
const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_review'];
const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['running', 'cancel_requested', 'canceled', 'failed'],
  running: ['waiting_for_review', 'succeeded', 'failed', 'cancel_requested', 'interrupted', 'queued'],
  cancel_requested: ['canceled', 'failed', 'succeeded', 'waiting_for_review'],
  waiting_for_review: ['succeeded'],
  succeeded: [], failed: ['queued'], canceled: [], interrupted: ['queued'],
};
export const canTransition = (from: RunStatus, to: RunStatus) => TRANSITIONS[from]?.includes(to) ?? false;
export const isTerminal = (s: RunStatus) => TERMINAL.includes(s);

export class RunService {
  constructor(private db: Db) {}

  async create(q: Queryable, args: { workspaceId: string; kind: string; skillId: string; input: Record<string, unknown>; scope?: Record<string, unknown>; requestedBy: string | null; idempotencyKey?: string; sourceId?: string; conversationId?: string; scheduleId?: string }) {
    const skill = skillById(args.skillId);
    if (!skill) throw new Error('unknown skill');
    if (args.idempotencyKey) {
      const ex = await q.query('SELECT id, status FROM agent_runs WHERE workspace_id=$1 AND idempotency_key=$2', [args.workspaceId, args.idempotencyKey]);
      if (ex.rows[0]) return { id: ex.rows[0].id as string, existing: true };
    }
    const r = await q.query(
      `INSERT INTO agent_runs(workspace_id, kind, skill_id, skill_version, status, input, scope, requested_by, idempotency_key, source_id, conversation_id, schedule_id)
       VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [args.workspaceId, args.kind, skill.id, skill.version, args.input, args.scope ?? {}, args.requestedBy, args.idempotencyKey ?? null, args.sourceId ?? null, args.conversationId ?? null, args.scheduleId ?? null]);
    await this.event(q, args.workspaceId, r.rows[0].id, 'status', { status: 'queued' });
    return { id: r.rows[0].id as string, existing: false };
  }

  async transition(q: Queryable, runId: string, to: RunStatus, patch: Record<string, unknown> = {}) {
    const cur = (await q.query('SELECT workspace_id, status FROM agent_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
    if (!cur) throw new Error('run not found');
    if (cur.status === to) return cur.workspace_id as string;
    if (!canTransition(cur.status, to)) throw new Error(`invalid run transition ${cur.status} -> ${to}`);
    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c}=$${i + 3}`).join(', ');
    await q.query(`UPDATE agent_runs SET status=$2, updated_at=now()${sets ? ', ' + sets : ''} WHERE id=$1`, [runId, to, ...cols.map(c => patch[c])]);
    await this.event(q, cur.workspace_id, runId, 'status', { status: to, ...(patch.error_code ? { error: patch.error_code } : {}) });
    return cur.workspace_id as string;
  }

  async event(q: Queryable, workspaceId: string, runId: string, type: string, data: Record<string, unknown>) {
    const r = await q.query(
      `INSERT INTO run_events(workspace_id, run_id, seq, type, data)
       SELECT $1, $2, coalesce(max(seq),0)+1, $3, $4 FROM run_events WHERE run_id=$2 RETURNING id, seq`,
      [workspaceId, runId, type, data]);
    await q.query(`SELECT pg_notify('run_events', $1)`, [JSON.stringify({ runId, workspaceId, id: r.rows[0].id })]);
    return r.rows[0] as { id: number; seq: number };
  }

  /** Short-lived, single-run inference token for the runner. Only its hash is stored. */
  async issueToken(runId: string, credentialId: string | null, model: string, maxOutputTokens: number, ttlS: number, maxRequests = 60) {
    const token = 'sb_' + randomToken(32);
    await this.db.query(
      `INSERT INTO run_tokens(token_hash, run_id, credential_id, model, max_output_tokens, max_requests, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7))`,
      [sha256Buf(token), runId, credentialId, model, maxOutputTokens, maxRequests, ttlS]);
    return token;
  }

  async revokeTokens(runId: string) { await this.db.query('UPDATE run_tokens SET revoked_at=now() WHERE run_id=$1 AND revoked_at IS NULL', [runId]); }

  /** Cancel: queued runs end immediately; running runs get cancel_requested and the worker aborts the runner. */
  async requestCancel(workspaceId: string, runId: string, userId: string) {
    const r = (await this.db.query('SELECT status FROM agent_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, runId])).rows[0];
    if (!r) return null;
    if (r.status === 'queued') await this.transition(this.db, runId, 'canceled', { finished_at: new Date().toISOString() });
    else if (r.status === 'running') await this.transition(this.db, runId, 'cancel_requested');
    else return r.status as RunStatus;
    await this.revokeTokens(runId);
    await this.db.query(`UPDATE sources SET status='canceled', updated_at=now() WHERE id=(SELECT source_id FROM agent_runs WHERE id=$1) AND status='analyzing'`, [runId]);
    await audit(this.db, { workspaceId, actorUserId: userId, action: 'run.cancel', targetType: 'run', targetId: runId, result: 'success' });
    return (await this.db.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status as RunStatus;
  }

  /** Marks runs whose worker died (stale heartbeat) as interrupted. Paid runs are never auto-restarted. */
  async markInterrupted(staleSeconds = 90) {
    const r = await this.db.query(`SELECT id FROM agent_runs WHERE status IN ('running','cancel_requested') AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1))`, [staleSeconds]);
    for (const row of r.rows) {
      await this.transition(this.db, row.id, 'interrupted', { finished_at: new Date().toISOString(), error_code: 'worker_lost', error_message: 'اجرای قبلی با توقف worker قطع شد؛ برای جلوگیری از هزینهٔ تکراری خودکار تکرار نمی‌شود.' }).catch(() => undefined);
      await this.revokeTokens(row.id);
      await this.db.query(`UPDATE sources SET status='analysis_failed', status_detail='interrupted', updated_at=now() WHERE id=(SELECT source_id FROM agent_runs WHERE id=$1) AND status='analyzing'`, [row.id]);
    }
    return r.rowCount ?? 0;
  }

  async todaysSpend(): Promise<number> {
    const r = await this.db.query(`SELECT coalesce(sum(cost_estimate_usd),0)::float AS s FROM agent_runs WHERE provider='anthropic' AND created_at > date_trunc('day', now())`);
    return Number(r.rows[0].s);
  }
}
