import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { sha256Buf, type Db, type CredentialService, type AppConfig, log } from '@sb/core';
import { mockPlan, mockSse } from './mock-anthropic';

const FORWARD_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept'];

/**
 * Private inference proxy (ADR-0003). Reachable only on the internal `agent` network. The
 * runner authenticates with a per-run token; the real API key is decrypted here and sent only
 * to api.anthropic.com. Model, max_tokens, request count and body size are enforced per run.
 */
export function buildProxy(db: Db, creds: CredentialService, cfg: AppConfig) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  app.get('/health', async () => ({ ok: true }));

  app.post('/inference/v1/messages', async (req, reply) => {
    const token = String(req.headers['x-api-key'] ?? '');
    if (!token.startsWith('sb_')) return reply.code(401).send({ type: 'error', error: { type: 'authentication_error', message: 'invalid run token' } });
    const t = (await db.query(
      `UPDATE run_tokens t SET used_requests = used_requests + 1
       FROM agent_runs r WHERE t.token_hash=$1 AND r.id=t.run_id AND t.revoked_at IS NULL AND t.expires_at > now() AND t.used_requests < t.max_requests AND r.status='running'
       RETURNING t.run_id, t.model, t.max_output_tokens, t.credential_id, r.workspace_id`, [sha256Buf(token)])).rows[0];
    if (!t) return reply.code(401).send({ type: 'error', error: { type: 'authentication_error', message: 'run token expired, revoked or exhausted' } });
    const body = req.body as Record<string, any>;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return reply.code(400).send({ type: 'error', error: { type: 'invalid_request_error', message: 'bad body' } });
    if (body.model !== t.model) return reply.code(403).send({ type: 'error', error: { type: 'permission_error', message: `model ${String(body.model).slice(0, 60)} is not allowed for this run` } });
    if (typeof body.max_tokens === 'number' && body.max_tokens > t.max_output_tokens) body.max_tokens = t.max_output_tokens;

    const addUsage = async (u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) => {
      await db.query(
        `UPDATE agent_runs SET usage = jsonb_build_object(
           'requests', coalesce((usage->>'requests')::int,0) + 1,
           'input_tokens', coalesce((usage->>'input_tokens')::int,0) + $2,
           'output_tokens', coalesce((usage->>'output_tokens')::int,0) + $3,
           'cache_read_input_tokens', coalesce((usage->>'cache_read_input_tokens')::int,0) + $4,
           'cache_creation_input_tokens', coalesce((usage->>'cache_creation_input_tokens')::int,0) + $5), heartbeat_at=now() WHERE id=$1`,
        [t.run_id, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0]);
    };

    if (cfg.modelProviderMode === 'mock') {
      const plan = mockPlan(body as never);
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
      for (const chunk of mockSse(plan, body.model)) reply.raw.write(chunk);
      reply.raw.end();
      await addUsage({});
      return reply;
    }

    const cred = await creds.decryptActive();
    if (!cred || cred.id !== t.credential_id) return reply.code(401).send({ type: 'error', error: { type: 'authentication_error', message: 'API connection was replaced or disconnected' } });
    const headers: Record<string, string> = { 'x-api-key': cred.key };
    for (const h of FORWARD_HEADERS) { const v = req.headers[h]; if (typeof v === 'string') headers[h] = v; }
    const ctl = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ctl.abort(); });
    let upstream: Response;
    try {
      upstream = await fetch(`${cfg.anthropicBaseUrl}/v1/messages${(req.url.includes('beta=true') ? '?beta=true' : '')}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      log.warn('proxy.upstream_error', { runId: t.run_id, error: (e as Error).name });
      return reply.code(502).send({ type: 'error', error: { type: 'api_error', message: 'upstream unreachable' } });
    }
    const outHeaders: Record<string, string> = { 'content-type': upstream.headers.get('content-type') ?? 'application/json' };
    for (const h of ['retry-after', 'request-id', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-tokens-remaining']) { const v = upstream.headers.get(h); if (v) outHeaders[h] = v; }
    reply.raw.writeHead(upstream.status, outHeaders);
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let buf = '';
    if (upstream.body) {
      for await (const chunk of Readable.fromWeb(upstream.body as never)) {
        reply.raw.write(chunk);
        // Usage accounting only; message text is not stored or logged.
        buf += (chunk as Buffer).toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(ev)?.[1];
          if (!data) continue;
          try {
            const j = JSON.parse(data);
            if (j.type === 'message_start' && j.message?.usage) Object.assign(usage, { input_tokens: j.message.usage.input_tokens ?? 0, cache_read_input_tokens: j.message.usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: j.message.usage.cache_creation_input_tokens ?? 0 });
            if (j.type === 'message_delta' && j.usage) usage.output_tokens = j.usage.output_tokens ?? usage.output_tokens;
            if (j.usage && !j.type) Object.assign(usage, j.usage);
          } catch { /* partial or non-JSON line */ }
        }
      }
    }
    reply.raw.end();
    await addUsage(usage).catch(() => undefined);
    return reply;
  });
  return app;
}
