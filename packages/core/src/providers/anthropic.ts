import type { Db } from '../database/pool';
import { Keyring, seal, open, sha256Hex } from '../crypto/envelope';
import { audit } from '../vault/service';

export const ANTHROPIC_API = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

export type ProviderErrorCode =
  | 'invalid_key' | 'permission_denied' | 'insufficient_credit' | 'rate_limited' | 'overloaded'
  | 'timeout' | 'model_not_found' | 'network' | 'bad_request' | 'server_error' | 'model_not_connected' | 'budget_exceeded';

export class ProviderError extends Error {
  constructor(public code: ProviderErrorCode, msg: string, public retryable: boolean, public status?: number, public retryAfterS?: number) { super(msg); }
}

export function mapProviderError(status: number, body: unknown, retryAfter?: string | null): ProviderError {
  const msg = typeof body === 'object' && body && 'error' in body ? String((body as { error: { message?: string } }).error?.message ?? '') : '';
  const ra = retryAfter ? Number(retryAfter) : undefined;
  if (status === 401) return new ProviderError('invalid_key', 'کلید API معتبر نیست یا ابطال شده است.', false, status);
  if (status === 403) return new ProviderError('permission_denied', 'این کلید به این عملیات یا مدل دسترسی ندارد.', false, status);
  if (status === 404) return new ProviderError('model_not_found', 'مدل انتخاب‌شده برای این کلید در دسترس نیست.', false, status);
  if (status === 400 && /credit|balance|billing/i.test(msg)) return new ProviderError('insufficient_credit', 'اعتبار حساب API کافی نیست.', false, status);
  if (status === 400 && /model/i.test(msg)) return new ProviderError('model_not_found', 'مدل انتخاب‌شده معتبر نیست.', false, status);
  if (status === 429) return new ProviderError('rate_limited', 'محدودیت نرخ یا مصرف ارائه‌دهنده.', true, status, ra);
  if (status === 529) return new ProviderError('overloaded', 'سرویس مدل موقتاً شلوغ است.', true, status, ra);
  if (status >= 500) return new ProviderError('server_error', 'خطای موقت سرویس مدل.', true, status, ra);
  return new ProviderError('bad_request', `درخواست رد شد (${status}).`, false, status);
}

async function call(path: string, key: string, init: RequestInit & { timeoutMs?: number }, baseUrl = ANTHROPIC_API) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(baseUrl + path, { ...init, signal: ctl.signal, headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw mapProviderError(res.status, body, res.headers.get('retry-after'));
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if ((e as Error).name === 'AbortError') throw new ProviderError('timeout', 'پاسخ سرویس مدل در زمان مجاز نرسید.', true);
    throw new ProviderError('network', 'اتصال به سرویس مدل برقرار نشد.', true);
  } finally { clearTimeout(t); }
}

/** No-cost credential check: lists models visible to this key. */
export async function listModels(key: string, baseUrl?: string): Promise<{ id: string; display_name?: string; created_at?: string }[]> {
  const out: { id: string; display_name?: string; created_at?: string }[] = [];
  let after: string | undefined;
  for (let i = 0; i < 5; i++) {
    const body = await call(`/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, key, { method: 'GET' }, baseUrl);
    const data = (body.data as { id: string; display_name?: string; created_at?: string }[]) ?? [];
    out.push(...data.map(d => ({ id: d.id, display_name: d.display_name, created_at: d.created_at })));
    if (!body.has_more) break;
    after = body.last_id as string;
  }
  return out;
}

/** Explicit, billable generation test with a tiny max_tokens. */
export async function testGeneration(key: string, model: string, baseUrl?: string) {
  const body = await call('/v1/messages', key, { method: 'POST', timeoutMs: 60_000, body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }) }, baseUrl);
  return { model: body.model as string, usage: body.usage as Record<string, number>, stopReason: body.stop_reason as string };
}

export interface CredentialSettings {
  model?: string; allowedModels?: string[]; perRunBudgetUsd?: number; dailyBudgetUsd?: number;
  timeoutS?: number; concurrency?: number; maxOutputTokens?: number; activeRunPolicy?: 'let_finish' | 'cancel';
}
export const DEFAULT_SETTINGS: Required<Omit<CredentialSettings, 'model' | 'allowedModels'>> = {
  perRunBudgetUsd: 0.5, dailyBudgetUsd: 5, timeoutS: 300, concurrency: 2, maxOutputTokens: 16000, activeRunPolicy: 'let_finish',
};

export interface CredentialPublic {
  id: string; label: string; last4: string; fingerprint: string; status: string; lastTestedAt: string | null; lastTestKind: string | null;
  lastErrorCode: string | null; lastErrorMessage: string | null; settings: CredentialSettings; availableModels: { id: string; display_name?: string }[]; createdAt: string;
}

export class CredentialService {
  constructor(private db: Db, private ring: () => Keyring, private baseUrl = ANTHROPIC_API) {}

  private toPublic(r: Record<string, any>): CredentialPublic {
    return { id: r.id, label: r.label, last4: r.last4, fingerprint: r.fingerprint, status: r.status, lastTestedAt: r.last_tested_at, lastTestKind: r.last_test_kind,
      lastErrorCode: r.last_error_code, lastErrorMessage: r.last_error_message, settings: { ...DEFAULT_SETTINGS, ...r.settings }, availableModels: r.available_models, createdAt: r.created_at };
  }

  async active(): Promise<CredentialPublic | null> {
    const r = await this.db.query(`SELECT * FROM provider_credentials WHERE provider='anthropic' AND disconnected_at IS NULL`);
    return r.rows[0] ? this.toPublic(r.rows[0]) : null;
  }

  /** Stores (or replaces) the installation API key. The plaintext never leaves this function except to the provider. */
  async store(actorId: string, label: string, apiKey: string, ip?: string): Promise<CredentialPublic> {
    const key = apiKey.trim();
    if (key.length < 20 || key.length > 400 || /\s/.test(key)) throw new ProviderError('bad_request', 'قالب کلید معتبر نیست.', false);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const prev = await client.query(`SELECT id, settings FROM provider_credentials WHERE provider='anthropic' AND disconnected_at IS NULL FOR UPDATE`);
      if (prev.rows[0]) {
        await client.query(`UPDATE provider_credentials SET disconnected_at=now(), status='disconnected', ciphertext='\\x00'::bytea, updated_at=now() WHERE id=$1`, [prev.rows[0].id]);
        await client.query(`UPDATE run_tokens SET revoked_at=now() WHERE revoked_at IS NULL AND credential_id=$1`, [prev.rows[0].id]);
      }
      const id = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      const sealed = seal(this.ring(), key, `cred:${id}`);
      const ins = await client.query(
        `INSERT INTO provider_credentials(id, provider, label, ciphertext, nonce, key_version, last4, fingerprint, settings, created_by)
         VALUES ($1,'anthropic',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, label.slice(0, 100) || 'Anthropic API', sealed.ciphertext, sealed.nonce, sealed.keyVersion, key.slice(-4), sha256Hex(key).slice(0, 16), prev.rows[0]?.settings ?? {}, actorId]);
      await audit(client, { actorUserId: actorId, action: prev.rows[0] ? 'integration.claude_api.key_replaced' : 'integration.claude_api.key_added', targetType: 'credential', targetId: id, result: 'success', ip, meta: { last4: key.slice(-4) } });
      await client.query('COMMIT');
      return this.toPublic(ins.rows[0]);
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  /** Decrypts the active key for trusted server-side use (worker proxy, connection test). */
  async decryptActive(): Promise<{ id: string; key: string; settings: CredentialSettings; status: string } | null> {
    const r = (await this.db.query(`SELECT * FROM provider_credentials WHERE provider='anthropic' AND disconnected_at IS NULL`)).rows[0];
    if (!r) return null;
    return { id: r.id, status: r.status, settings: { ...DEFAULT_SETTINGS, ...r.settings }, key: open(this.ring(), { ciphertext: r.ciphertext, nonce: r.nonce, keyVersion: r.key_version }, `cred:${r.id}`) };
  }

  async testConnection(actorId: string, kind: 'validate' | 'generate', ip?: string) {
    const cred = await this.decryptActive();
    if (!cred) throw new ProviderError('model_not_connected', 'هیچ کلید API ثبت نشده است.', false);
    try {
      let detail: Record<string, unknown> = {};
      if (kind === 'validate') {
        const models = await listModels(cred.key, this.baseUrl);
        await this.db.query(`UPDATE provider_credentials SET available_models=$2 WHERE id=$1`, [cred.id, JSON.stringify(models)]);
        detail = { modelCount: models.length };
        const chosen = cred.settings.model;
        if (chosen && !models.some(m => m.id === chosen)) throw new ProviderError('model_not_found', 'مدل انتخاب‌شده در فهرست مدل‌های این کلید نیست.', false);
      } else {
        const model = cred.settings.model;
        if (!model) throw new ProviderError('bad_request', 'ابتدا یک مدل انتخاب کنید.', false);
        detail = await testGeneration(cred.key, model, this.baseUrl);
      }
      await this.db.query(`UPDATE provider_credentials SET status='valid', last_tested_at=now(), last_test_kind=$2, last_error_code=NULL, last_error_message=NULL, updated_at=now() WHERE id=$1`, [cred.id, kind]);
      await audit(this.db, { actorUserId: actorId, action: `integration.claude_api.test_${kind}`, targetType: 'credential', targetId: cred.id, result: 'success', ip });
      return { ok: true as const, kind, detail };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError('network', 'خطای نامشخص', true);
      const status = pe.code === 'invalid_key' || pe.code === 'permission_denied' ? 'invalid' : undefined;
      await this.db.query(`UPDATE provider_credentials SET ${status ? `status='invalid',` : ''} last_tested_at=now(), last_test_kind=$2, last_error_code=$3, last_error_message=$4, updated_at=now() WHERE id=$1`, [cred.id, kind, pe.code, pe.message]);
      await audit(this.db, { actorUserId: actorId, action: `integration.claude_api.test_${kind}`, targetType: 'credential', targetId: cred.id, result: 'failure', ip, meta: { code: pe.code } });
      return { ok: false as const, kind, code: pe.code, message: pe.message, retryable: pe.retryable };
    }
  }

  async updateSettings(actorId: string, s: CredentialSettings) {
    const r = await this.db.query(`UPDATE provider_credentials SET settings = settings || $1::jsonb, updated_at=now() WHERE provider='anthropic' AND disconnected_at IS NULL RETURNING *`, [JSON.stringify(s)]);
    if (!r.rows[0]) throw new ProviderError('model_not_connected', 'هیچ کلید API ثبت نشده است.', false);
    await audit(this.db, { actorUserId: actorId, action: 'integration.claude_api.settings_updated', targetType: 'credential', targetId: r.rows[0].id, result: 'success', meta: { ...s } });
    return this.toPublic(r.rows[0]);
  }

  /**
   * Local disconnect: wipes ciphertext and revokes in-flight job tokens. This is NOT a
   * revocation at Anthropic; the owner must revoke the key in the Claude Console.
   */
  async disconnect(actorId: string, cancelActiveRuns: boolean, ip?: string) {
    const r = await this.db.query(`UPDATE provider_credentials SET disconnected_at=now(), status='disconnected', ciphertext='\\x00'::bytea, updated_at=now() WHERE provider='anthropic' AND disconnected_at IS NULL RETURNING id`);
    const tokens = await this.db.query(`UPDATE run_tokens SET revoked_at=now() WHERE revoked_at IS NULL`);
    let canceled = 0;
    if (cancelActiveRuns) {
      canceled = (await this.db.query(`UPDATE agent_runs SET status='cancel_requested', updated_at=now() WHERE status IN ('queued','running')`)).rowCount ?? 0;
    }
    await audit(this.db, { actorUserId: actorId, action: 'integration.claude_api.disconnected', targetType: 'credential', targetId: r.rows[0]?.id, result: 'success', ip, meta: { revokedTokens: tokens.rowCount, canceledRuns: canceled } });
    return { disconnected: !!r.rowCount, revokedTokens: tokens.rowCount ?? 0, canceledRuns: canceled };
  }

  /** Re-encrypts all live credentials and TOTP secrets with the active master key version. */
  async rotateToActiveKey(): Promise<{ credentials: number; totp: number }> {
    const ring = this.ring();
    let credentials = 0, totp = 0;
    const creds = (await this.db.query(`SELECT * FROM provider_credentials WHERE disconnected_at IS NULL AND key_version <> $1`, [ring.active])).rows;
    for (const r of creds) {
      const plain = open(ring, { ciphertext: r.ciphertext, nonce: r.nonce, keyVersion: r.key_version }, `cred:${r.id}`);
      const s = seal(ring, plain, `cred:${r.id}`);
      await this.db.query('UPDATE provider_credentials SET ciphertext=$2, nonce=$3, key_version=$4 WHERE id=$1', [r.id, s.ciphertext, s.nonce, s.keyVersion]);
      credentials++;
    }
    const users = (await this.db.query(`SELECT id, totp_secret_enc, totp_key_version FROM users WHERE totp_secret_enc IS NOT NULL AND totp_key_version <> $1`, [ring.active])).rows;
    for (const u of users) {
      const plain = open(ring, { ciphertext: u.totp_secret_enc.subarray(12), nonce: u.totp_secret_enc.subarray(0, 12), keyVersion: u.totp_key_version }, `totp:${u.id}`);
      const s = seal(ring, plain, `totp:${u.id}`);
      await this.db.query('UPDATE users SET totp_secret_enc=$2, totp_key_version=$3 WHERE id=$1', [u.id, Buffer.concat([s.nonce, s.ciphertext]), s.keyVersion]);
      totp++;
    }
    await audit(this.db, { action: 'security.master_key_rotated', result: 'success', meta: { credentials, totp, active: ring.active } });
    return { credentials, totp };
  }
}
