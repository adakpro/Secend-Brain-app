import type { FastifyPluginAsync } from 'fastify';
import { SCHEMA_VERSION } from '@sb/core';
import type { Deps } from '../context';

/** Whether model-dependent features may start a run right now (API card or explicit test mock). */
export async function modelAvailability(deps: Deps): Promise<{ available: boolean; reason: string; provider: 'anthropic' | 'mock' | null }> {
  if (deps.cfg.modelProviderMode === 'mock') return { available: true, reason: 'test/development mock provider', provider: 'mock' };
  const c = await deps.creds.active();
  if (!c) return { available: false, reason: 'اتصال API مدل تنظیم نشده است؛ مدیر باید از «تنظیمات › اتصال Claude» کلید API ثبت کند.', provider: null };
  if (c.status === 'invalid') return { available: false, reason: 'کلید API ثبت‌شده در آخرین آزمون نامعتبر بود.', provider: null };
  if (!c.settings.model) return { available: false, reason: 'مدل پیش‌فرض انتخاب نشده است.', provider: null };
  return { available: true, reason: '', provider: 'anthropic' };
}

export async function nativeStatus(deps: Deps): Promise<Record<string, unknown>> {
  if (!deps.cfg.nativeUrl) return { enabled: false, serviceUp: false, reason: 'پروفایل native فعال نیست (docker compose --profile native).' };
  try {
    const ctl = AbortSignal.timeout(20000);
    const r = await fetch(`${deps.cfg.nativeUrl}/status`, { headers: { authorization: `Bearer ${deps.internalToken}` }, signal: ctl });
    if (!r.ok) return { enabled: true, serviceUp: false, reason: `native service responded ${r.status}` };
    return { enabled: true, serviceUp: true, ...(await r.json()) };
  } catch { return { enabled: true, serviceUp: false, reason: 'سرویس native در دسترس نیست.' }; }
}

export const systemRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  app.get('/health/live', async () => ({ ok: true }));
  // Readiness = this service can serve requests (DB + schema). Model connectivity is NOT part of it.
  app.get('/health/ready', async (_req, reply) => {
    try {
      const v = (await deps.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0].v;
      if (v < SCHEMA_VERSION) return reply.code(503).send({ ok: false, reason: 'schema_outdated' });
      return { ok: true, schema: v };
    } catch { return reply.code(503).send({ ok: false, reason: 'database_unreachable' }); }
  });

  /** Three separate models: service readiness, provider status, user-visible capabilities. */
  app.get('/api/v1/system/status', async (req) => {
    let db = false; let queue: Record<string, unknown> = {};
    try { await deps.db.query('SELECT 1'); db = true; } catch { db = false; }
    try {
      const q = await deps.db.query(`SELECT name, count(*) FILTER (WHERE state IN ('created','retry'))::int AS waiting, count(*) FILTER (WHERE state='active')::int AS active, count(*) FILTER (WHERE state='failed' AND completed_on > now() - interval '1 day')::int AS failed_24h FROM pgboss.job GROUP BY name`);
      queue = Object.fromEntries(q.rows.map(r => [r.name, { waiting: r.waiting, active: r.active, failed24h: r.failed_24h }]));
    } catch { queue = { error: 'unavailable' }; }
    const avail = await modelAvailability(deps);
    const cred = req.session ? await deps.creds.active() : null;
    const native = req.session ? await nativeStatus(deps) : { hidden: true };
    const stuck = db ? (await deps.db.query(`SELECT count(*)::int n FROM agent_runs WHERE status='running' AND heartbeat_at < now() - interval '2 minutes'`)).rows[0].n : null;
    return {
      readiness: { api: true, database: db, queue, stuckRuns: stuck },
      providers: {
        claudeApi: req.session ? { configured: !!cred, status: cred?.status ?? 'not_configured', model: cred?.settings.model ?? null, lastTestedAt: cred?.lastTestedAt ?? null, mode: deps.cfg.modelProviderMode } : { hidden: true },
        nativeClaude: native,
      },
      capabilities: {
        modelFeatures: avail.available, modelFeaturesReason: avail.reason, provider: avail.provider,
        textSearch: db, manualEditing: db, exportMarkdown: true, exportHtml: true, exportPdf: false, exportDocx: false, ocr: false, semanticSearch: false, webBrowsingInAnswers: false,
      },
      profile: deps.cfg.profile,
      version: deps.cfg.appVersion,
    };
  });
};
