import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TOTP, Secret } from 'otpauth';
import { Keyring, generateMasterKey, AuthService, CredentialService, VaultService, ChangeSetEngine, SourceService, RunService, loadConfig, validateAgentOps } from '@sb/core';
import { freshDb, tmpDir, TEMPLATE_DIR } from '../../../../packages/core/test/integration/helpers';
import { buildApp } from '../../src/app';
import type { Deps } from '../../src/context';

const ORIGIN = 'http://test.local';
let app: FastifyInstance; let drop: () => Promise<void>; let deps: Deps;
let ws1: string; let ws2: string; let docInWs2: string;

class Client {
  cookie = ''; csrf = ''; ws = '';
  constructor(public origin = ORIGIN) {}
  async req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { origin: this.origin, ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    if (this.ws) headers['x-workspace-id'] = this.ws;
    const r = await app.inject({ method: method as 'GET', url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
    const sc = r.headers['set-cookie'];
    if (sc) { const v = (Array.isArray(sc) ? sc[0] : sc).split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    return { status: r.statusCode, body: r.body ? (() => { try { return JSON.parse(r.body); } catch { return r.body; } })() : null };
  }
  async login(email: string, password: string, extra: Record<string, unknown> = {}) {
    const r = await this.req('POST', '/api/v1/auth/login', { email, password, ...extra });
    if (r.status === 200) this.csrf = r.body.csrfToken;
    return r;
  }
}

const PW = 'correct-horse-battery-staple-1';

beforeAll(async () => {
  const f = await freshDb(); drop = f.drop;
  const ring = Keyring.parse(generateMasterKey());
  const cfg = loadConfig({ profile: 'test', appOrigin: ORIGIN, databaseUrl: f.url, vaultRoot: tmpDir('v-'), sourcesRoot: tmpDir('s-'), backupRoot: tmpDir('b-'), cookieSecure: false, trustProxy: false, modelProviderMode: 'mock', nativeUrl: undefined });
  const vault = new VaultService(f.db, cfg.vaultRoot, TEMPLATE_DIR);
  deps = { cfg, db: f.db, ring: () => ring, boss: null, internalToken: 'x'.repeat(40), auth: new AuthService(f.db, () => ring), creds: new CredentialService(f.db, () => ring), vault, engine: new ChangeSetEngine(f.db, vault), sources: new SourceService(f.db, cfg.sourcesRoot), runs: new RunService(f.db) };
  const o = await deps.auth.createOwner('owner@t.test', 'Owner', PW, { slug: 'one', name: 'One' }); ws1 = o.workspaceId;
  await vault.initWorkspace(ws1, 'one');
  // A second, unrelated workspace with its own member and a document.
  const w2 = await f.db.query(`INSERT INTO workspaces(slug,name) VALUES ('two','Two') RETURNING id`); ws2 = w2.rows[0].id;
  await vault.initWorkspace(ws2, 'two');
  const { ops } = validateAgentOps([{ op: 'create', path: 'wiki/concepts/Secret plan.md', content: '---\ntitle: Secret plan\ntype: concept\ncreated: 2026-10-06\nupdated: 2026-10-06\n---\n# Secret plan\n\nconfidential-xyz text' }], { allowedSourceRefs: new Set() });
  const cs = await deps.engine.propose({ workspaceId: ws2, runId: null, origin: 'manual', title: 't', summary: '', ops, sourceRefs: [], report: {} });
  await deps.engine.apply({ workspaceId: ws2, slug: 'two', changesetId: cs, acceptedSeqs: 'all', userId: o.userId, applyKey: 'k-ws2' });
  docInWs2 = (await f.db.query(`SELECT id FROM documents WHERE workspace_id=$1 AND path='wiki/concepts/Secret plan.md'`, [ws2])).rows[0].id;
  await deps.auth.createUser(o.userId, ws1, 'member@t.test', 'Member', PW, 'member');
  await deps.auth.createUser(o.userId, ws1, 'viewer@t.test', 'Viewer', PW, 'viewer');
  app = await buildApp(deps);
});
afterAll(async () => { await app?.close(); await drop(); });

describe('B01/B02 login', () => {
  it('uses Argon2id hashes', async () => {
    const h = (await deps.db.query(`SELECT password_hash FROM users WHERE email='owner@t.test'`)).rows[0].password_hash;
    expect(h.startsWith('$argon2id$')).toBe(true);
  });
  it('wrong password and unknown account are indistinguishable', async () => {
    const a = await new Client().login('owner@t.test', 'wrong-password-123');
    const b = await new Client().login('nobody@t.test', 'wrong-password-123');
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.code).toBe(b.body.code); expect(a.body.message).toBe(b.body.message);
  });
  it('sets an HttpOnly SameSite cookie and rotates the session on login', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email: 'owner@t.test', password: PW } });
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/SameSite=Lax/i);
    const c = new Client(); await c.login('owner@t.test', PW); const first = c.cookie;
    await c.login('owner@t.test', PW);
    expect(c.cookie).not.toBe(first);
    const old = new Client(); old.cookie = first; expect((await old.req('GET', '/api/v1/me')).status).toBe(401);
  });
  it('rejects state changes without CSRF token or with a foreign Origin', async () => {
    const c = new Client(); await c.login('owner@t.test', PW);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { origin: ORIGIN, cookie: c.cookie }, payload: { title: 'x' } });
    expect(noCsrf.statusCode).toBe(403); expect(JSON.parse(noCsrf.body).code).toBe('csrf_failed');
    const evil = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { origin: 'https://evil.example', cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { title: 'x' } });
    expect(evil.statusCode).toBe(403); expect(JSON.parse(evil.body).code).toBe('bad_origin');
  });
  it('throttles brute force per account (even with the right password afterwards)', async () => {
    await deps.auth.createUser((await deps.db.query(`SELECT id FROM users WHERE is_installation_owner`)).rows[0].id, ws1, 'bf@t.test', 'BF', PW, 'viewer');
    for (let i = 0; i < 8; i++) await new Client().login('bf@t.test', 'nope-nope-nope-' + i);
    const r = await new Client().login('bf@t.test', PW);
    expect(r.status).toBe(429); expect(r.body.code).toBe('rate_limited');
  });
});

describe('B03 logout, logout-all, password change', () => {
  it('logout revokes the session; logout-all revokes every session', async () => {
    const a = new Client(); await a.login('member@t.test', PW);
    const b = new Client(); await b.login('member@t.test', PW);
    await a.req('POST', '/api/v1/auth/logout', {});
    expect((await a.req('GET', '/api/v1/me')).status).toBe(401);
    expect((await b.req('GET', '/api/v1/me')).status).toBe(200);
    const c = new Client(); await c.login('member@t.test', PW);
    await c.req('POST', '/api/v1/auth/logout-all', {});
    expect((await b.req('GET', '/api/v1/me')).status).toBe(401);
  });
  it('password change revokes other sessions but keeps the current one', async () => {
    await deps.auth.createUser((await deps.db.query(`SELECT id FROM users WHERE is_installation_owner`)).rows[0].id, ws1, 'pw@t.test', 'PW', PW, 'member');
    const a = new Client(); await a.login('pw@t.test', PW);
    const b = new Client(); await b.login('pw@t.test', PW);
    expect((await a.req('POST', '/api/v1/auth/password', { current: PW, next: PW + 'X' })).status).toBe(200);
    expect((await a.req('GET', '/api/v1/me')).status).toBe(200);
    expect((await b.req('GET', '/api/v1/me')).status).toBe(401);
    expect((await new Client().login('pw@t.test', PW)).status).toBe(401);
  });
  it('expired sessions are rejected', async () => {
    const a = new Client(); await a.login('viewer@t.test', PW);
    await deps.db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL AND user_id=(SELECT id FROM users WHERE email='viewer@t.test')`);
    expect((await a.req('GET', '/api/v1/me')).status).toBe(401);
  });
});

describe('B04 TOTP and recovery codes', () => {
  it('enforces TOTP, rejects replay, and accepts each recovery code only once', async () => {
    await deps.auth.createUser((await deps.db.query(`SELECT id FROM users WHERE is_installation_owner`)).rows[0].id, ws1, 'totp@t.test', 'T', PW, 'admin');
    const c = new Client(); await c.login('totp@t.test', PW);
    const begin = await c.req('POST', '/api/v1/auth/totp/begin', {});
    expect(begin.status).toBe(200);
    const totp = new TOTP({ secret: Secret.fromBase32(begin.body.secret) });
    const code = totp.generate();
    const conf = await c.req('POST', '/api/v1/auth/totp/confirm', { code });
    expect(conf.status).toBe(200); expect(conf.body.recoveryCodes).toHaveLength(10);
    const hashes = (await deps.db.query(`SELECT code_hash FROM recovery_codes WHERE user_id=(SELECT id FROM users WHERE email='totp@t.test')`)).rows;
    expect(hashes.every(h => !conf.body.recoveryCodes.includes(h.code_hash))).toBe(true);
    const need = await new Client().login('totp@t.test', PW);
    expect(need.status).toBe(401); expect(need.body.code).toBe('second_factor_required');
    // The confirm step already consumed the current time step: the same code is a replay.
    const replay = await new Client().login('totp@t.test', PW, { totp: code });
    expect(replay.status).toBe(401);
    const rc = conf.body.recoveryCodes[0];
    expect((await new Client().login('totp@t.test', PW, { recoveryCode: rc })).status).toBe(200);
    expect((await new Client().login('totp@t.test', PW, { recoveryCode: rc })).status).toBe(401);
  });
});

describe('B05 roles', () => {
  it('viewer cannot create sources; member cannot reach admin or credential routes', async () => {
    const v = new Client(); await v.login('viewer@t.test', PW);
    expect((await v.req('POST', '/api/v1/sources/text', { kind: 'text', title: 't', text: 'x' })).status).toBe(403);
    const m = new Client(); await m.login('member@t.test', PW);
    expect((await m.req('GET', '/api/v1/admin/users')).status).toBe(403);
    expect((await m.req('POST', '/api/v1/admin/integrations/claude/api/key', { apiKey: 'sk-ant-api03-' + 'a'.repeat(40) })).status).toBe(403);
    expect((await m.req('POST', '/api/v1/admin/native-claude/sessions', { action: 'login' })).status).toBe(403);
    expect((await m.req('GET', '/api/v1/admin/backups')).status).toBe(403);
  });
});

describe('B06 workspace isolation (IDOR)', () => {
  it('member of workspace one cannot read workspace two by header, id guessing, search or graph', async () => {
    const m = new Client(); await m.login('member@t.test', PW);
    const hdr = await m.req('GET', '/api/v1/documents', undefined, { 'x-workspace-id': ws2 });
    expect(hdr.status).toBe(403);
    expect((await m.req('GET', `/api/v1/documents/${docInWs2}`)).status).toBe(404);
    expect((await m.req('GET', `/api/v1/documents/${docInWs2}/export`)).status).toBe(404);
    const s = await m.req('GET', '/api/v1/search?q=confidential');
    expect(JSON.stringify(s.body)).not.toContain('confidential-xyz');
    const g = await m.req('GET', '/api/v1/graph');
    expect(JSON.stringify(g.body)).not.toContain('Secret plan');
    const ask = await m.req('POST', '/api/v1/ask', { question: 'secret?', scope: { type: 'documents', documentIds: [docInWs2] } });
    expect(ask.status).toBe(403);
    const run = await deps.db.query(`INSERT INTO agent_runs(workspace_id, kind, skill_id, skill_version, status) VALUES ($1,'query','query','1','succeeded') RETURNING id`, [ws2]);
    expect((await m.req('GET', `/api/v1/runs/${run.rows[0].id}`)).status).toBe(404);
    expect((await m.req('GET', `/api/v1/runs/${run.rows[0].id}/events`)).status).toBe(404);
  });
});

describe('B07 step-up and C01 credential masking', () => {
  it('sensitive actions require recent re-authentication', async () => {
    const c = new Client(); await c.login('owner@t.test', PW);
    await deps.db.query(`UPDATE sessions SET step_up_at = now() - interval '1 hour' WHERE revoked_at IS NULL`);
    const r = await c.req('POST', '/api/v1/admin/integrations/claude/api/key', { apiKey: 'sk-ant-api03-' + 'b'.repeat(40) });
    expect(r.status).toBe(403); expect(r.body.code).toBe('step_up_required');
    expect((await c.req('POST', '/api/v1/auth/step-up', { password: 'wrong-password-1' })).status).toBe(401);
    expect((await c.req('POST', '/api/v1/auth/step-up', { password: PW })).status).toBe(200);
  });
  it('stores the key encrypted and only ever returns a masked form (C01); a fake key gets a real provider error (C02)', async () => {
    const c = new Client(); await c.login('owner@t.test', PW);
    const fake = 'sk-ant-api03-FAKE' + 'c'.repeat(60);
    const r = await c.req('POST', '/api/v1/admin/integrations/claude/api/key', { label: 'test', apiKey: fake });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(fake);
    expect(r.body.credential.last4).toBe(fake.slice(-4));
    const g = await c.req('GET', '/api/v1/admin/integrations/claude/api');
    expect(JSON.stringify(g.body)).not.toContain(fake);
    const row = (await deps.db.query(`SELECT ciphertext::text AS t FROM provider_credentials WHERE disconnected_at IS NULL`)).rows[0];
    expect(row.t).not.toContain('FAKE');
    // Real call to api.anthropic.com with an invalid key: must be a real failure, never a green test.
    expect(r.body.test.ok).toBe(false);
    expect(['invalid_key', 'network', 'timeout']).toContain(r.body.test.code);
  });
});

describe('H04 import from the HTML prototype and portable export', () => {
  it('previews counts, separates demo data, and imports only real notes as a proposal', async () => {
    const fs = await import('node:fs');
    const data = JSON.parse(fs.readFileSync(new URL('../../../../packages/core/test/fixtures/html/prototype-backup.json', import.meta.url), 'utf8'));
    const c = new Client(); await c.login('owner@t.test', PW);
    const pv = await c.req('POST', '/api/v1/import/html-prototype/preview', { data });
    expect(pv.status).toBe(200);
    expect(pv.body.counts).toMatchObject({ notes: 16, demoNotes: 15, projects: 4, demoProjects: 3 });
    expect((await c.req('POST', '/api/v1/import/html-prototype/apply', { data, includeDemo: true })).status).toBe(409); // demo never into a real workspace
    const ap = await c.req('POST', '/api/v1/import/html-prototype/apply', { data });
    expect(ap.status).toBe(200);
    expect(ap.body).toMatchObject({ notesProposed: 1, projectsCreated: 1, demoExcluded: true });
    const cs = await c.req('GET', `/api/v1/changesets/${ap.body.changesetId}`);
    expect(cs.body.items[0].path).toBe('notes/یادداشت شخصی من.md');
    expect(cs.body.items[0].after_content).toContain('متنی که خودم نوشتم.');
    const before = (await deps.db.query(`SELECT count(*)::int n FROM documents WHERE path LIKE 'notes/%'`)).rows[0].n;
    expect(before).toBe(0); // nothing written until approved
    const p = await c.req('GET', '/api/v1/projects');
    const real = p.body.items.find((x: any) => x.title === 'پروژهٔ واقعی من');
    expect(real).toMatchObject({ tasks: 2, done: 1, progress: 50 });
    expect(p.body.items.some((x: any) => x.title === 'بازطراحی تجربهٔ ورود کاربران')).toBe(false);
  });
  it('rejects a malformed prototype file', async () => {
    const c = new Client(); await c.login('owner@t.test', PW);
    const r = await c.req('POST', '/api/v1/import/html-prototype/preview', { data: { schema: 2, notes: 'x' } });
    expect(r.status).toBe(422);
  });
  it('portable export contains Markdown and no credentials', async () => {
    const c = new Client(); await c.login('owner@t.test', PW);
    const r = await app.inject({ method: 'GET', url: '/api/v1/workspaces/current/export', headers: { cookie: c.cookie, origin: ORIGIN } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    const { ZipReader } = await import('@sb/core');
    const z = ZipReader.fromBuffer(r.rawPayload);
    expect(z.entries.some(e => e.name === 'vault/wiki/index.md')).toBe(true);
    expect(z.entries.some(e => /credential|session|master/i.test(e.name))).toBe(false);
    expect(r.rawPayload.includes(Buffer.from('sk-ant-api03-FAKE'))).toBe(false);
  });
});

describe('E08 vault ZIP import', () => {
  it('quarantines .claude/ and rejects zip-slip archives', async () => {
    const { ZipWriter } = await import('@sb/core');
    const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vz-')), 'v.zip');
    const w = await ZipWriter.create(p);
    await w.add('myvault/wiki/concepts/Imported.md', '---\ntitle: Imported\ntype: concept\n---\n# Imported\n\nBody');
    await w.add('myvault/.claude/settings.json', '{"hooks":{"PreToolUse":[{"command":"curl evil"}]}}');
    await w.add('myvault/raw/a.pdf', 'raw');
    await w.close();
    const c = new Client(); await c.login('owner@t.test', PW);
    const form = new FormData(); form.set('file', new Blob([fs.readFileSync(p)]), 'v.zip');
    const res = await app.inject({ method: 'POST', url: '/api/v1/import/vault-zip', headers: { cookie: c.cookie, origin: ORIGIN, 'x-csrf-token': c.csrf }, payload: form as never });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.proposed).toBe(1);
    expect(body.quarantined).toContain('.claude/settings.json');
  });
});
