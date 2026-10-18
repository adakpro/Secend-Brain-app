import type { FastifyInstance } from 'fastify';
import { sha256Buf, openAICall, ProviderError, type Db, type CredentialService, type AppConfig } from '@sb/core';

export function registerOpenAIProxy(app: FastifyInstance, db: Db, creds: CredentialService, cfg: AppConfig) {
  app.post('/inference/v1/responses', async (req, reply) => {
    if (cfg.modelProviderMode !== 'openai') return reply.code(403).send({ error: { code: 'provider_not_allowed' } });
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer sb_') ? auth.slice(7) : '';
    if (!token) return reply.code(401).send({ error: { code: 'invalid_run_token' } });
    const tx = await db.connect();
    try {
      await tx.query('BEGIN');
      // Serialize this provider's requests: budget checks include other in-flight runs.
      await tx.query(`SELECT pg_advisory_xact_lock(7420192)`);
      const t = (await tx.query(`UPDATE run_tokens t SET used_requests=used_requests+1 FROM agent_runs r
        WHERE t.token_hash=$1 AND r.id=t.run_id AND t.revoked_at IS NULL AND t.expires_at>now()
        AND t.used_requests<t.max_requests AND r.status='running' AND r.provider='openai'
        RETURNING t.*, r.cost_estimate_usd`, [sha256Buf(token)])).rows[0];
      if (!t) { await tx.query('ROLLBACK'); return reply.code(401).send({ error: { code: 'invalid_run_token' } }); }
      const cred = await creds.decryptActive();
      if (!cred || cred.id !== t.credential_id) { await tx.query('ROLLBACK'); return reply.code(401).send({ error: { code: 'connection_disconnected' } }); }
      const b = req.body as Record<string, any>;
      if (!b || b.model !== t.model || !Array.isArray(b.input) || !Array.isArray(b.tools)) {
        await tx.query('ROLLBACK'); return reply.code(403).send({ error: { code: 'bad_request' } });
      }
      const allowed = new Set(['search_wiki', 'read_note', 'get_backlinks', 'list_index', 'read_source', 'propose_change', 'StructuredOutput']);
      if (b.tools.some((f: any) => f.type !== 'function' || !allowed.has(f.name))) {
        await tx.query('ROLLBACK'); return reply.code(403).send({ error: { code: 'tool_not_allowed' } });
      }
      const inputRate = cred.settings.inputPricePerMillion, outputRate = cred.settings.outputPricePerMillion;
      if (!inputRate || !outputRate) {
        await tx.query('ROLLBACK'); return reply.code(409).send({ error: { code: 'pricing_required' } });
      }
      const body = { model: t.model, instructions: typeof b.instructions === 'string' ? b.instructions : '', input: b.input,
        tools: b.tools, parallel_tool_calls: false, store: false, include: ['reasoning.encrypted_content'],
        max_output_tokens: Math.min(Number.isInteger(b.max_output_tokens) && b.max_output_tokens > 0 ? b.max_output_tokens : t.max_output_tokens, t.max_output_tokens) };
      // UTF-8 bytes bound text token count conservatively; no cached-input discount assumed.
      const reserve = (Buffer.byteLength(JSON.stringify(body), 'utf8') * inputRate + body.max_output_tokens * outputRate) / 1_000_000;
      const daily = Number((await tx.query(`SELECT coalesce(sum(cost_estimate_usd),0) AS cost FROM agent_runs WHERE provider='openai' AND created_at>date_trunc('day',now())`)).rows[0].cost);
      if (Number(t.cost_estimate_usd ?? 0) + reserve > (cred.settings.perRunBudgetUsd ?? 0.5) || daily + reserve > (cred.settings.dailyBudgetUsd ?? 5)) {
        await tx.query('COMMIT'); return reply.code(409).send({ error: { code: 'budget_exceeded' } });
      }
      // Reserve before the remote call. Keep the reservation if the response is lost.
      await tx.query(`UPDATE agent_runs SET cost_estimate_usd=coalesce(cost_estimate_usd,0)+$2 WHERE id=$1`, [t.run_id, reserve]);
      await tx.query('COMMIT');
      const out = await openAICall('/v1/responses', cred.key, body, cfg.openaiBaseUrl);
      const u = out.usage ?? {};
      const cost = ((u.input_tokens ?? 0) * inputRate + (u.output_tokens ?? 0) * outputRate) / 1_000_000;
      await db.query(`UPDATE agent_runs SET cost_estimate_usd=greatest(0,coalesce(cost_estimate_usd,0)-$4+$5),
        usage=jsonb_build_object('requests',coalesce((usage->>'requests')::int,0)+1,
        'input_tokens',coalesce((usage->>'input_tokens')::bigint,0)+$2,
        'output_tokens',coalesce((usage->>'output_tokens')::bigint,0)+$3), heartbeat_at=now() WHERE id=$1`,
        [t.run_id, u.input_tokens ?? 0, u.output_tokens ?? 0, reserve, cost]);
      return out;
    } catch (e) {
      await tx.query('ROLLBACK').catch(() => undefined);
      const err = e instanceof ProviderError ? e : new ProviderError('server_error', 'خطای سرویس مدل', true);
      return reply.code(err.status ?? 502).send({ error: { code: err.code, message: err.message } });
    } finally { tx.release(); }
  });
}
