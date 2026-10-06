import type { FastifyPluginAsync } from 'fastify';
import { CreateUserBody, StoreApiKeyBody, ApiSettingsBody, DisconnectBody } from '@sb/contracts';
import { audit, listModels } from '@sb/core';
import { type Deps, parse, requireAdmin, requireStepUp, requireWs, HttpError } from '../context';

export const adminRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  // ---------------- Users & sessions ----------------
  app.get('/admin/users', async req => {
    await requireAdmin(req, deps);
    const r = await deps.db.query(`SELECT u.id, u.email, u.display_name, u.is_installation_owner, u.totp_enabled, u.disabled_at, u.created_at,
        (SELECT json_agg(json_build_object('workspaceId', m.workspace_id, 'workspace', w.name, 'role', m.role)) FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=u.id) AS memberships,
        (SELECT count(*)::int FROM sessions s WHERE s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
      FROM users u ORDER BY u.created_at`);
    return { items: r.rows };
  });

  app.post('/admin/users', async req => {
    const { session } = await requireAdmin(req, deps); requireStepUp(req);
    const ws = requireWs(req, 'admin');
    const b = parse(CreateUserBody, req.body);
    const id = await deps.auth.createUser(session.userId, ws.id, b.email, b.displayName, b.password, b.role);
    return { id };
  });

  app.patch('/admin/users/:id', async req => {
    const { session } = await requireAdmin(req, deps); requireStepUp(req);
    const ws = requireWs(req, 'admin');
    const id = (req.params as { id: string }).id;
    const b = req.body as { role?: string; disabled?: boolean };
    const target = (await deps.db.query('SELECT is_installation_owner FROM users WHERE id=$1', [id])).rows[0];
    if (!target) throw new HttpError(404, 'not_found', 'کاربر پیدا نشد.');
    if (target.is_installation_owner) throw new HttpError(403, 'owner_protected', 'نقش یا وضعیت مالک سامانه از این مسیر قابل تغییر نیست.');
    if (b.role && ['admin', 'member', 'viewer'].includes(b.role)) await deps.db.query(`UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2`, [ws.id, id, b.role]);
    if (typeof b.disabled === 'boolean') {
      await deps.db.query(`UPDATE users SET disabled_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1`, [id, b.disabled]);
      if (b.disabled) await deps.auth.logoutAll(id, undefined, 'user_disabled');
    }
    await audit(deps.db, { workspaceId: ws.id, actorUserId: session.userId, action: 'admin.user_updated', targetType: 'user', targetId: id, result: 'success', meta: b });
    return { ok: true };
  });

  app.post('/admin/users/:id/revoke-sessions', async req => {
    const { session } = await requireAdmin(req, deps); requireStepUp(req);
    const n = await deps.auth.logoutAll((req.params as { id: string }).id, undefined, 'revoked_by_admin');
    await audit(deps.db, { actorUserId: session.userId, action: 'admin.sessions_revoked', targetType: 'user', targetId: (req.params as { id: string }).id, result: 'success', meta: { n } });
    return { revoked: n };
  });

  app.get('/admin/audit', async req => {
    await requireAdmin(req, deps);
    const q = req.query as { action?: string; limit?: string; before?: string };
    const r = await deps.db.query(
      `SELECT a.id, a.workspace_id, a.action, a.target_type, a.target_id, a.result, a.ip, a.request_id, a.meta, a.created_at, u.email
       FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id WHERE ($1::text IS NULL OR a.action LIKE $1 || '%') AND ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3`,
      [q.action ?? null, q.before ? Number(q.before) : null, Math.min(Number(q.limit ?? 100) || 100, 500)]);
    return { items: r.rows };
  });

  // ---------------- Claude API card ----------------
  app.get('/admin/integrations/claude/api', async req => {
    await requireAdmin(req, deps);
    const c = await deps.creds.active();
    const today = (await deps.db.query(`SELECT coalesce(sum(cost_estimate_usd),0)::float AS cost, count(*)::int AS runs, coalesce(sum((usage->>'input_tokens')::bigint),0)::bigint AS input_tokens, coalesce(sum((usage->>'output_tokens')::bigint),0)::bigint AS output_tokens FROM agent_runs WHERE provider='anthropic' AND created_at > date_trunc('day', now())`)).rows[0];
    const active = (await deps.db.query(`SELECT count(*)::int n FROM agent_runs WHERE status IN ('queued','running')`)).rows[0].n;
    return {
      credential: c, mode: deps.cfg.modelProviderMode, usageToday: { ...today, costLabel: 'تخمین SDK سمت کلاینت؛ صورتحساب قطعی Anthropic نیست' }, activeRuns: active,
      revokeHelp: 'حذف یا قطع اتصال در این برنامه فقط نسخهٔ رمزشدهٔ محلی را پاک می‌کند. برای ابطال واقعی کلید، در Claude Console به بخش API Keys بروید و کلید را Disable/Delete کنید.',
    };
  });

  app.post('/admin/integrations/claude/api/key', async req => {
    const { session } = await requireAdmin(req, deps); requireStepUp(req);
    const b = parse(StoreApiKeyBody, req.body);
    const c = await deps.creds.store(session.userId, b.label, b.apiKey, req.ip);
    // Immediately run the no-cost validation so the card shows a real state.
    const test = await deps.creds.testConnection(session.userId, 'validate', req.ip);
    return { credential: await deps.creds.active() ?? c, test };
  });

  app.post('/admin/integrations/claude/api/test', async req => {
    const { session } = await requireAdmin(req, deps);
    const { kind } = (req.body ?? {}) as { kind?: 'validate' | 'generate' };
    if (kind === 'generate') requireStepUp(req);
    return deps.creds.testConnection(session.userId, kind === 'generate' ? 'generate' : 'validate', req.ip);
  });

  app.get('/admin/integrations/claude/api/models', async req => {
    await requireAdmin(req, deps);
    const c = await deps.creds.decryptActive();
    if (!c) throw new HttpError(409, 'model_not_connected', 'هیچ کلید API ثبت نشده است.');
    const models = await listModels(c.key, deps.cfg.anthropicBaseUrl);
    await deps.db.query(`UPDATE provider_credentials SET available_models=$2 WHERE id=$1`, [c.id, JSON.stringify(models)]);
    return { models };
  });

  app.patch('/admin/integrations/claude/api/settings', async req => {
    const { session } = await requireAdmin(req, deps); requireStepUp(req);
    const b = parse(ApiSettingsBody, req.body);
    const cur = await deps.creds.active();
    if (b.model && cur && cur.availableModels.length && !cur.availableModels.some(m => m.id === b.model)) throw new HttpError(422, 'model_not_found', 'این مدل در فهرست مدل‌های قابل استفادهٔ کلید نیست؛ ابتدا «آزمون اتصال» را اجرا کنید.');
    if (b.allowedModels?.length && b.model && !b.allowedModels.includes(b.model)) throw new HttpError(422, 'model_not_allowed', 'مدل پیش‌فرض باید در فهرست مدل‌های مجاز باشد.');
    return { credential: await deps.creds.updateSettings(session.userId, b) };
  });

  app.post('/admin/integrations/claude/api/disconnect', async req => {
    const { session } = await requireAdmin(req, deps); requireStepUp(req);
    const b = parse(DisconnectBody, req.body);
    return deps.creds.disconnect(session.userId, b.cancelActiveRuns, req.ip);
  });
};
