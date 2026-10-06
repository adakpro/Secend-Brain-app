import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { log, safeEqual, type Role } from '@sb/core';
import { type Deps, HttpError, COOKIE, mapError } from './context';
import { authRoutes } from './routes/auth';
import { workspaceRoutes } from './routes/workspaces';
import { sourceRoutes } from './routes/sources';
import { documentRoutes } from './routes/documents';
import { changesetRoutes } from './routes/changesets';
import { runRoutes } from './routes/runs';
import { askRoutes } from './routes/ask';
import { projectRoutes } from './routes/projects';
import { studioRoutes } from './routes/studio';
import { knowledgeRoutes } from './routes/knowledge';
import { adminRoutes } from './routes/admin';
import { nativeRoutes } from './routes/native';
import { systemRoutes } from './routes/system';
import { backupRoutes } from './routes/backups';
import { transferRoutes } from './routes/transfer';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Never log query strings (terminal tickets, search terms), cookies or auth headers.
      serializers: { req: r => ({ method: r.method, url: r.url.split('?')[0], requestId: r.id }), res: r => ({ statusCode: r.statusCode }) },
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
    },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: deps.cfg.trustProxy,
    bodyLimit: 4 * 1024 * 1024,
    disableRequestLogging: false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 20, fieldSize: 100_000, parts: 30 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.decorateRequest('session', null);
  app.decorateRequest('space', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'no-store');
    const token = req.cookies[COOKIE(deps.cfg.cookieSecure)];
    req.session = await deps.auth.resolveSession(token);
    if (req.url.startsWith('/api/') && MUTATING.has(req.method)) {
      // Origin check for every state change (cookies are SameSite=Lax; this is defense in depth).
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      const okOrigin = origin ? origin === deps.cfg.appOrigin : site === 'same-origin' || site === undefined && deps.cfg.profile !== 'production';
      if (!okOrigin) throw new HttpError(403, 'bad_origin', 'درخواست از مبدأ نامعتبر.');
      if (req.session && !req.url.startsWith('/api/v1/auth/login')) {
        const csrf = String(req.headers['x-csrf-token'] ?? '');
        if (!csrf || !safeEqual(csrf, req.session.csrfToken)) throw new HttpError(403, 'csrf_failed', 'نشانهٔ امنیتی درخواست نامعتبر است؛ صفحه را تازه کنید.');
      }
    }
    if (req.session) {
      // Header for XHR; ?ws= only for GET navigations (downloads, EventSource) that cannot set headers.
      const wsHeader = req.headers['x-workspace-id'] ?? (req.method === 'GET' ? (req.query as { ws?: string })?.ws : undefined);
      const wsId = typeof wsHeader === 'string' && /^[0-9a-f-]{36}$/.test(wsHeader) ? wsHeader : null;
      const r = await deps.db.query(
        `SELECT w.id, w.slug, w.name, w.is_demo, m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
         WHERE m.user_id=$1 AND ($2::uuid IS NULL OR w.id=$2)
         ORDER BY (w.id = (SELECT active_workspace_id FROM user_preferences WHERE user_id=$1)) DESC, w.created_at LIMIT 1`, [req.session.userId, wsId]);
      if (wsId && !r.rows[0]) throw new HttpError(403, 'forbidden_workspace', 'به این فضای دانش دسترسی ندارید.');
      if (r.rows[0]) req.space = { id: r.rows[0].id, slug: r.rows[0].slug, name: r.rows[0].name, isDemo: r.rows[0].is_demo, role: r.rows[0].role as Role };
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const h = mapError(err);
    if (h.status >= 500) log.error('api.error', { requestId: req.id, url: req.url.split('?')[0], error: (err as Error).message?.slice(0, 300), stack: (err as Error).stack?.split('\n').slice(0, 4).join(' | ') });
    reply.code(h.status).send({ code: h.code, message: h.message, requestId: req.id, retryable: h.retryable, ...(h.details !== undefined ? { details: h.details } : {}) });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ code: 'not_found', message: 'مسیر پیدا نشد.', requestId: req.id, retryable: false }));

  await app.register(systemRoutes(deps));
  await app.register(authRoutes(deps), { prefix: '/api/v1' });
  await app.register(workspaceRoutes(deps), { prefix: '/api/v1' });
  await app.register(sourceRoutes(deps), { prefix: '/api/v1' });
  await app.register(documentRoutes(deps), { prefix: '/api/v1' });
  await app.register(changesetRoutes(deps), { prefix: '/api/v1' });
  await app.register(runRoutes(deps, (deps as Deps & { hub?: import('./routes/runs').RunEventHub }).hub), { prefix: '/api/v1' });
  await app.register(askRoutes(deps), { prefix: '/api/v1' });
  await app.register(projectRoutes(deps), { prefix: '/api/v1' });
  await app.register(studioRoutes(deps), { prefix: '/api/v1' });
  await app.register(knowledgeRoutes(deps), { prefix: '/api/v1' });
  await app.register(adminRoutes(deps), { prefix: '/api/v1' });
  await app.register(nativeRoutes(deps), { prefix: '/api/v1' });
  await app.register(backupRoutes(deps), { prefix: '/api/v1' });
  await app.register(transferRoutes(deps), { prefix: '/api/v1' });
  return app;
}
