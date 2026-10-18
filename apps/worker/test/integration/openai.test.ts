import { afterEach, expect, it, vi } from 'vitest';
import { CredentialService, Keyring, generateMasterKey, loadConfig, RunService } from '@sb/core';
import { freshDb, seedOwner } from '../../../../packages/core/test/integration/helpers';
import { buildProxy } from '../../src/proxy';

afterEach(() => vi.unstubAllGlobals());
it('isolates provider credentials and enforces run authorization, model and OpenAI budget', async () => {
  const f = await freshDb(); const { userId, workspaceId } = await seedOwner(f.db);
  const ring = Keyring.parse(generateMasterKey());
  const anthropic = new CredentialService(f.db, () => ring);
  const creds = new CredentialService(f.db, () => ring, 'https://api.openai.com', 'openai');
  const app = buildProxy(f.db, creds, loadConfig({ profile: 'test', modelProviderMode: 'openai' }));
  try {
    await anthropic.store(userId, 'Claude', 'a'.repeat(30));
    const c = await creds.store(userId, 'OpenAI', 'b'.repeat(30));
    expect((await anthropic.decryptActive())?.key).toBe('a'.repeat(30));
    expect((await creds.decryptActive())?.key).toBe('b'.repeat(30));
    await creds.updateSettings(userId, { model: 'test-model', perRunBudgetUsd: 1, dailyBudgetUsd: 2, inputPricePerMillion: 1, outputPricePerMillion: 2 });
    const runs = new RunService(f.db);
    const run = await runs.create(f.db, { workspaceId, kind: 'query', skillId: 'query', input: {}, requestedBy: userId });
    await runs.transition(f.db, run.id, 'running', { provider: 'openai', model: 'test-model' });
    const token = await runs.issueToken(run.id, c.id, 'test-model', 256, 60);
    const send = (body: object, bearer = token) => app.inject({ method: 'POST', url: '/inference/v1/responses', headers: { authorization: `Bearer ${bearer}` }, payload: body });
    const body = { model: 'test-model', input: [{ role: 'user', content: 'hello' }], tools: [], max_output_tokens: 90000, store: true };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 20 } }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await send(body, 'sb_invalid')).statusCode).toBe(401);
    expect((await send({ ...body, model: 'other-model' })).statusCode).toBe(403);
    expect((await send({ ...body, tools: [{ type: 'web_search' }] })).statusCode).toBe(403);
    expect((await send(body)).statusCode).toBe(200);
    const forwarded = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(forwarded.store).toBe(false);
    expect(forwarded.max_output_tokens).toBe(256);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer ' + 'b'.repeat(30));
    const usage = (await f.db.query('SELECT usage, cost_estimate_usd FROM agent_runs WHERE id=$1', [run.id])).rows[0];
    expect(usage.usage.input_tokens).toBe(10);
    expect(Number(usage.cost_estimate_usd)).toBeCloseTo(0.00005, 6);
    await f.db.query('UPDATE agent_runs SET cost_estimate_usd=1 WHERE id=$1', [run.id]);
    expect((await send(body)).statusCode).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await creds.disconnect(userId, false);
    expect((await anthropic.decryptActive())?.key).toBe('a'.repeat(30));
    expect((await send(body)).statusCode).toBe(401);
  } finally { await app.close(); await f.drop(); }
});
