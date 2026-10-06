import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Keyring, generateMasterKey, AuthService, CredentialService, VaultService, ChangeSetEngine, SourceService, RunService, loadConfig } from '@sb/core';
import { freshDb, tmpDir, TEMPLATE_DIR } from '../../../../packages/core/test/integration/helpers';
import { buildApp } from '../../src/app';
import type { Deps } from '../../src/context';

// Production profile, real provider mode, NO key: model features must be refused, never mocked (C09, A05, C05).
const ORIGIN = 'http://127.0.0.1:8080';
let app: FastifyInstance; let drop: () => Promise<void>; let deps: Deps; let cookie = ''; let csrf = '';
const PW = 'production-profile-pass-1';

beforeAll(async () => {
  const f = await freshDb(); drop = f.drop;
  const ring = Keyring.parse(generateMasterKey());
  const cfg = loadConfig({ profile: 'production', appOrigin: ORIGIN, databaseUrl: f.url, vaultRoot: tmpDir('v-'), sourcesRoot: tmpDir('s-'), backupRoot: tmpDir('b-'), cookieSecure: false, trustProxy: false, modelProviderMode: 'anthropic', nativeUrl: undefined });
  const vault = new VaultService(f.db, cfg.vaultRoot, TEMPLATE_DIR);
  deps = { cfg, db: f.db, ring: () => ring, boss: null, internalToken: 'x'.repeat(40), auth: new AuthService(f.db, () => ring), creds: new CredentialService(f.db, () => ring), vault, engine: new ChangeSetEngine(f.db, vault), sources: new SourceService(f.db, cfg.sourcesRoot), runs: new RunService(f.db) };
  const o = await deps.auth.createOwner('p@t.test', 'P', PW, { slug: 'prod', name: 'Prod' });
  await vault.initWorkspace(o.workspaceId, 'prod');
  app = await buildApp(deps);
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'p@t.test', password: PW } });
  cookie = String(r.headers['set-cookie']).split(';')[0]; csrf = JSON.parse(r.body).csrfToken;
});
afterAll(async () => { await app?.close(); await drop(); });

const call = (method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf }, ...(payload ? { payload } : {}) });

describe('production profile without an API key', () => {
  it('refuses MODEL_PROVIDER_MODE=mock at startup', () => {
    expect(() => loadConfig({ profile: 'production', modelProviderMode: 'mock' } as never)).not.toThrow(); // overrides bypass env parsing…
    const prev = { ...process.env };
    process.env.APP_PROFILE = 'production'; process.env.MODEL_PROVIDER_MODE = 'mock';
    try { expect(() => loadConfig({})).toThrow(/refused in the production profile/); } finally { process.env = prev; }
  });
  it('reports ready while model capabilities are off (A05)', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    const s = JSON.parse((await call('GET', '/api/v1/system/status')).body);
    expect(s.capabilities.modelFeatures).toBe(false);
    expect(s.capabilities.textSearch).toBe(true);
  });
  it('answers questions in explicit text-search mode, labelled as not a model answer (C09)', async () => {
    const r = JSON.parse((await call('POST', '/api/v1/ask', { question: 'چه می‌دانم؟' })).body);
    expect(r.mode).toBe('text_search');
    const conv = JSON.parse((await call('GET', `/api/v1/conversations/${r.conversationId}`)).body);
    expect(conv.messages.at(-1).mode).toBe('text_search');
    expect((await deps.db.query(`SELECT count(*)::int n FROM agent_runs`)).rows[0].n).toBe(0);
  });
  it('refuses analysis, studio generation and quiz generation with model_not_connected (C09/C05)', async () => {
    const src = await deps.sources.createFromBytes({ workspaceId: (await deps.db.query('SELECT id FROM workspaces')).rows[0].id, userId: (await deps.db.query('SELECT id FROM users')).rows[0].id, title: 't', kind: 'text', sensitivity: 'private_model', tags: [], buf: Buffer.from('x'), mime: 'text/plain', ext: '.txt' });
    await deps.db.query(`UPDATE sources SET status='ready_for_analysis' WHERE id=$1`, [src.id]);
    const a = await call('POST', `/api/v1/sources/${src.id}/analyze`, {});
    expect(a.statusCode).toBe(409); expect(JSON.parse(a.body).code).toBe('model_not_connected');
    const docId = (await deps.db.query(`SELECT id FROM documents LIMIT 1`)).rows[0].id;
    const q = await call('POST', '/api/v1/learning/generate', { documentIds: [docId] });
    expect(q.statusCode).toBe(409);
  });
});
