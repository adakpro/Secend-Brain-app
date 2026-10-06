import type { FastifyPluginAsync } from 'fastify';
import { LoginBody, StepUpBody, ChangePasswordBody, TotpConfirmBody, PreferencesBody } from '@sb/contracts';
import { SESSION_ABSOLUTE_S, STEP_UP_WINDOW_S, audit } from '@sb/core';
import { type Deps, parse, requireSession, requireStepUp, COOKIE, HttpError } from '../context';

export const authRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  const cookieName = COOKIE(deps.cfg.cookieSecure);
  const setCookie = (reply: import('fastify').FastifyReply, token: string) =>
    reply.setCookie(cookieName, token, { httpOnly: true, sameSite: 'lax', secure: deps.cfg.cookieSecure, path: '/', maxAge: SESSION_ABSOLUTE_S });

  app.post('/auth/login', async (req, reply) => {
    const body = parse(LoginBody, req.body);
    // Rotate: any session cookie presented with the login is revoked first.
    if (req.session) await deps.auth.logout(req.session.sessionId, 'rotated_on_login');
    const s = await deps.auth.login({ ...body, ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(reply, s.token);
    return { ok: true, csrfToken: s.csrfToken };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.session) { await deps.auth.logout(req.session.sessionId); await audit(deps.db, { actorUserId: req.session.userId, action: 'auth.logout', result: 'success', ip: req.ip }); }
    reply.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  });

  app.post('/auth/logout-all', async (req, reply) => {
    const s = requireSession(req);
    const n = await deps.auth.logoutAll(s.userId);
    await audit(deps.db, { actorUserId: s.userId, action: 'auth.logout_all', result: 'success', ip: req.ip, meta: { revoked: n } });
    reply.clearCookie(cookieName, { path: '/' });
    return { ok: true, revoked: n };
  });

  app.get('/me', async req => {
    const s = requireSession(req);
    const prefs = (await deps.db.query('SELECT theme, locale, timezone, calendar, digits, active_workspace_id, recent_document_ids FROM user_preferences WHERE user_id=$1', [s.userId])).rows[0] ?? {};
    const workspaces = await deps.auth.memberships(deps.db, s.userId);
    const admin = s.isInstallationOwner || workspaces.some(w => w.role === 'owner' || w.role === 'admin');
    return {
      user: { id: s.userId, email: s.email, displayName: s.displayName, isInstallationOwner: s.isInstallationOwner, totpEnabled: s.totpEnabled, isAdmin: admin },
      csrfToken: s.csrfToken,
      stepUpValidUntil: s.stepUpAt ? new Date(Date.parse(s.stepUpAt) + STEP_UP_WINDOW_S * 1000).toISOString() : null,
      preferences: { theme: prefs.theme ?? 'system', locale: prefs.locale ?? 'fa', timezone: prefs.timezone ?? 'Asia/Tehran', calendar: prefs.calendar ?? 'persian', digits: prefs.digits ?? 'fa', recentDocumentIds: prefs.recent_document_ids ?? [] },
      workspaces: workspaces.map(w => ({ id: w.id, slug: w.slug, name: w.name, role: w.role, isDemo: w.is_demo })),
      activeWorkspaceId: req.space?.id ?? null,
      profile: deps.cfg.profile,
      providerMode: deps.cfg.modelProviderMode,
    };
  });

  app.patch('/me/preferences', async req => {
    const s = requireSession(req);
    const b = parse(PreferencesBody, req.body);
    if (b.timezone && !Intl.supportedValuesOf('timeZone').includes(b.timezone) && b.timezone !== 'UTC') throw new HttpError(422, 'invalid_timezone', 'منطقهٔ زمانی نامعتبر است.');
    await deps.db.query(
      `INSERT INTO user_preferences(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [s.userId]);
    await deps.db.query(
      `UPDATE user_preferences SET theme=coalesce($2,theme), locale=coalesce($3,locale), timezone=coalesce($4,timezone), calendar=coalesce($5,calendar), digits=coalesce($6,digits), updated_at=now() WHERE user_id=$1`,
      [s.userId, b.theme ?? null, b.locale ?? null, b.timezone ?? null, b.calendar ?? null, b.digits ?? null]);
    if (b.displayName) await deps.db.query('UPDATE users SET display_name=$2, updated_at=now() WHERE id=$1', [s.userId, b.displayName]);
    return { ok: true };
  });

  app.post('/me/active-workspace', async req => {
    const s = requireSession(req);
    const { workspaceId } = req.body as { workspaceId: string };
    const ok = await deps.db.query('SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2', [s.userId, workspaceId]);
    if (!ok.rowCount) throw new HttpError(403, 'forbidden_workspace', 'به این فضای دانش دسترسی ندارید.');
    await deps.db.query('UPDATE user_preferences SET active_workspace_id=$2 WHERE user_id=$1', [s.userId, workspaceId]);
    return { ok: true };
  });

  app.post('/auth/step-up', async req => {
    const s = requireSession(req);
    await deps.auth.stepUp(s, parse(StepUpBody, req.body), req.ip);
    return { ok: true, validUntil: new Date(Date.now() + STEP_UP_WINDOW_S * 1000).toISOString() };
  });

  app.post('/auth/password', async req => {
    const s = requireSession(req);
    const b = parse(ChangePasswordBody, req.body);
    await deps.auth.changePassword(s.userId, b.current, b.next, s.sessionId);
    return { ok: true };
  });

  app.get('/auth/sessions', async req => {
    const s = requireSession(req);
    const r = await deps.db.query(`SELECT id, created_at, last_seen_at, expires_at, ip, user_agent, (id=$2) AS current FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [s.userId, s.sessionId]);
    return { sessions: r.rows };
  });

  app.delete('/auth/sessions/:id', async req => {
    const s = requireSession(req);
    const r = await deps.db.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='revoked_by_user' WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [(req.params as { id: string }).id, s.userId]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'نشست پیدا نشد.');
    return { ok: true };
  });

  app.post('/auth/totp/begin', async req => {
    const s = requireSession(req); requireStepUp(req);
    const { secret, uri } = await deps.auth.beginTotpEnrollment(s.userId, s.email);
    return { secret, uri };
  });
  app.post('/auth/totp/confirm', async req => {
    const s = requireSession(req); requireStepUp(req);
    const codes = await deps.auth.confirmTotpEnrollment(s.userId, parse(TotpConfirmBody, req.body).code);
    return { recoveryCodes: codes, notice: 'این کدها فقط همین یک بار نمایش داده می‌شوند.' };
  });
  app.post('/auth/totp/disable', async req => {
    const s = requireSession(req); requireStepUp(req);
    await deps.auth.disableTotp(s.userId);
    return { ok: true };
  });
};
