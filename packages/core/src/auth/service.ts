import type { Db, Queryable } from '../database/pool';
import { withTx } from '../database/pool';
import { randomToken, sha256Buf, Keyring, seal, open } from '../crypto/envelope';
import { hashPassword, verifyPassword, burnPasswordTime, validatePasswordPolicy } from './password';
import { verifyTotp, generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode, newTotpSecret, totpUri } from './totp';
import { audit } from '../vault/service';

export const SESSION_ABSOLUTE_S = 7 * 24 * 3600;
export const SESSION_IDLE_S = 12 * 3600;
export const STEP_UP_WINDOW_S = 10 * 60;
const LOGIN_WINDOW_MIN = 15;
const MAX_FAILS_PER_ACCOUNT = 8;
const MAX_FAILS_PER_IP = 30;

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export interface SessionInfo {
  sessionId: string; userId: string; email: string; displayName: string; csrfToken: string;
  isInstallationOwner: boolean; totpEnabled: boolean; stepUpAt: string | null; createdAt: string;
}

export class AuthError extends Error { constructor(public code: string, msg = code) { super(msg); } }

export class AuthService {
  constructor(private db: Db, private ring: () => Keyring) {}

  async userCount(): Promise<number> {
    const r = await this.db.query('SELECT count(*)::int AS n FROM users');
    return r.rows[0].n;
  }

  /** Creates the first owner (CLI only). Refuses if any owner exists. */
  async createOwner(email: string, displayName: string, password: string, workspace: { slug: string; name: string }) {
    validatePasswordPolicy(password);
    const hash = await hashPassword(password);
    return withTx(this.db, async tx => {
      await tx.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const exists = await tx.query('SELECT 1 FROM users WHERE is_installation_owner');
      if (exists.rowCount) throw new AuthError('owner_exists', 'an owner already exists; use reset-password instead');
      const u = await tx.query(`INSERT INTO users(email, display_name, password_hash, is_installation_owner) VALUES ($1,$2,$3,true) RETURNING id`, [email.toLowerCase().trim(), displayName, hash]);
      const userId = u.rows[0].id as string;
      const ws = await tx.query(`INSERT INTO workspaces(slug, name) VALUES ($1,$2) RETURNING id`, [workspace.slug, workspace.name]);
      await tx.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.rows[0].id, userId]);
      await tx.query(`INSERT INTO user_preferences(user_id, active_workspace_id) VALUES ($1,$2)`, [userId, ws.rows[0].id]);
      await audit(tx, { actorUserId: userId, action: 'auth.owner_created', targetType: 'user', targetId: userId, result: 'success' });
      return { userId, workspaceId: ws.rows[0].id as string };
    });
  }

  async createUser(actorId: string, workspaceId: string, email: string, displayName: string, password: string, role: Exclude<Role, 'owner'>) {
    const hash = await hashPassword(password);
    return withTx(this.db, async tx => {
      const u = await tx.query(`INSERT INTO users(email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id`, [email.toLowerCase().trim(), displayName, hash]);
      await tx.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,$3)`, [workspaceId, u.rows[0].id, role]);
      await tx.query(`INSERT INTO user_preferences(user_id, active_workspace_id) VALUES ($1,$2)`, [u.rows[0].id, workspaceId]);
      await audit(tx, { workspaceId, actorUserId: actorId, action: 'admin.user_created', targetType: 'user', targetId: u.rows[0].id, result: 'success', meta: { role } });
      return u.rows[0].id as string;
    });
  }

  private async tooManyFailures(email: string, ip: string): Promise<boolean> {
    const r = await this.db.query(
      `SELECT bucket, count(*)::int AS n FROM login_attempts WHERE bucket = ANY($1) AND NOT success AND at > now() - make_interval(mins => $2) GROUP BY bucket`,
      [[`acct:${email}`, `ip:${ip}`], LOGIN_WINDOW_MIN]);
    const m = new Map(r.rows.map(x => [x.bucket, x.n]));
    return (m.get(`acct:${email}`) ?? 0) >= MAX_FAILS_PER_ACCOUNT || (m.get(`ip:${ip}`) ?? 0) >= MAX_FAILS_PER_IP;
  }

  private async recordAttempt(email: string, ip: string, success: boolean) {
    await this.db.query(`INSERT INTO login_attempts(bucket, success) VALUES ($1,$3),($2,$3)`, [`acct:${email}`, `ip:${ip}`, success]);
    await this.db.query(`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`);
  }

  /**
   * Password (+ TOTP when enabled) login. Every failure returns the same error code so the
   * response does not reveal whether the account exists, is locked, or needs a second factor.
   */
  async login(input: { email: string; password: string; totp?: string; recoveryCode?: string; ip: string; userAgent?: string }) {
    const email = String(input.email ?? '').toLowerCase().trim().slice(0, 320);
    if (await this.tooManyFailures(email, input.ip)) {
      await burnPasswordTime(input.password ?? '');
      await audit(this.db, { action: 'auth.login', result: 'denied', ip: input.ip, meta: { reason: 'rate_limited' } });
      throw new AuthError('rate_limited');
    }
    const u = await this.db.query('SELECT * FROM users WHERE email=$1 AND disabled_at IS NULL', [email]);
    const user = u.rows[0];
    const fail = async (reason: string) => {
      await this.recordAttempt(email, input.ip, false);
      await audit(this.db, { actorUserId: user?.id ?? null, action: 'auth.login', result: 'failure', ip: input.ip, meta: { reason } });
      return new AuthError('invalid_credentials');
    };
    if (!user) { await burnPasswordTime(input.password ?? ''); throw await fail('unknown_or_bad'); }
    if (!(await verifyPassword(user.password_hash, input.password ?? ''))) throw await fail('unknown_or_bad');
    if (user.totp_enabled) {
      if (input.recoveryCode) {
        if (!(await this.consumeRecoveryCode(user.id, input.recoveryCode))) throw await fail('second_factor');
      } else {
        if (!input.totp) { throw new AuthError('second_factor_required'); }
        const secret = this.totpSecret(user);
        const step = verifyTotp(secret, input.totp, user.totp_last_step === null ? null : Number(user.totp_last_step));
        if (step === null) throw await fail('second_factor');
        const upd = await this.db.query('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2)', [user.id, step]);
        if (!upd.rowCount) throw await fail('second_factor_replay');
      }
    }
    await this.recordAttempt(email, input.ip, true);
    const s = await this.createSession(user.id, input.ip, input.userAgent);
    await audit(this.db, { actorUserId: user.id, action: 'auth.login', result: 'success', ip: input.ip });
    return s;
  }

  async createSession(userId: string, ip?: string, userAgent?: string) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    const r = await this.db.query(
      `INSERT INTO sessions(user_id, token_hash, csrf_token, expires_at, idle_timeout_s, ip, user_agent, step_up_at)
       VALUES ($1,$2,$3, now() + make_interval(secs => $4), $5, $6, $7, now()) RETURNING id`,
      [userId, sha256Buf(token), csrf, SESSION_ABSOLUTE_S, SESSION_IDLE_S, ip ?? null, (userAgent ?? '').slice(0, 300)]);
    return { token, csrfToken: csrf, sessionId: r.rows[0].id as string };
  }

  async resolveSession(token: string | undefined): Promise<SessionInfo | null> {
    if (!token || token.length > 100) return null;
    const r = await this.db.query(
      `UPDATE sessions s SET last_seen_at = now()
       FROM users u
       WHERE s.token_hash = $1 AND u.id = s.user_id AND s.revoked_at IS NULL AND u.disabled_at IS NULL
         AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(secs => s.idle_timeout_s)
       RETURNING s.id, s.user_id, s.csrf_token, s.step_up_at, s.created_at, u.email, u.display_name, u.is_installation_owner, u.totp_enabled`,
      [sha256Buf(token)]);
    const row = r.rows[0];
    if (!row) return null;
    return { sessionId: row.id, userId: row.user_id, email: row.email, displayName: row.display_name, csrfToken: row.csrf_token, isInstallationOwner: row.is_installation_owner, totpEnabled: row.totp_enabled, stepUpAt: row.step_up_at, createdAt: row.created_at };
  }

  async logout(sessionId: string, reason = 'logout') {
    await this.db.query('UPDATE sessions SET revoked_at=now(), revoke_reason=$2 WHERE id=$1 AND revoked_at IS NULL', [sessionId, reason]);
  }

  async logoutAll(userId: string, exceptSessionId?: string, reason = 'logout_all') {
    const r = await this.db.query('UPDATE sessions SET revoked_at=now(), revoke_reason=$3 WHERE user_id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)', [userId, exceptSessionId ?? null, reason]);
    return r.rowCount ?? 0;
  }

  async revokeAllSessions(reason: string) {
    const r = await this.db.query('UPDATE sessions SET revoked_at=now(), revoke_reason=$1 WHERE revoked_at IS NULL', [reason]);
    return r.rowCount ?? 0;
  }

  /** Re-verifies identity for sensitive operations; stamps step_up_at on the session. */
  async stepUp(session: SessionInfo, input: { password?: string; totp?: string }, ip: string) {
    const u = (await this.db.query('SELECT * FROM users WHERE id=$1', [session.userId])).rows[0];
    let ok = !!input.password && (await verifyPassword(u.password_hash, input.password));
    if (ok && u.totp_enabled) {
      const secret = this.totpSecret(u);
      const step = input.totp ? verifyTotp(secret, input.totp, u.totp_last_step === null ? null : Number(u.totp_last_step)) : null;
      ok = step !== null && !!(await this.db.query('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2)', [u.id, step])).rowCount;
    }
    await audit(this.db, { actorUserId: u.id, action: 'auth.step_up', result: ok ? 'success' : 'failure', ip });
    if (!ok) throw new AuthError('step_up_failed');
    await this.db.query('UPDATE sessions SET step_up_at=now() WHERE id=$1', [session.sessionId]);
  }

  static hasRecentStepUp(s: SessionInfo): boolean {
    return !!s.stepUpAt && Date.now() - Date.parse(s.stepUpAt) < STEP_UP_WINDOW_S * 1000;
  }

  async changePassword(userId: string, current: string, next: string, keepSessionId: string) {
    const u = (await this.db.query('SELECT password_hash FROM users WHERE id=$1', [userId])).rows[0];
    if (!(await verifyPassword(u.password_hash, current))) throw new AuthError('invalid_credentials');
    await this.setPassword(userId, next, keepSessionId);
  }

  /** Used by the CLI reset path and by changePassword. Revokes all sessions. */
  async setPassword(userId: string, next: string, keepSessionId?: string) {
    const hash = await hashPassword(next);
    await this.db.query('UPDATE users SET password_hash=$2, password_changed_at=now(), updated_at=now() WHERE id=$1', [userId, hash]);
    await this.db.query(`UPDATE sessions SET revoked_at=now(), revoke_reason='password_changed' WHERE user_id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [userId, keepSessionId ?? null]);
    await audit(this.db, { actorUserId: userId, action: 'auth.password_set', targetType: 'user', targetId: userId, result: 'success' });
  }

  async beginTotpEnrollment(userId: string, email: string) {
    const secret = newTotpSecret();
    const s = seal(this.ring(), secret, `totp:${userId}`);
    await this.db.query('UPDATE users SET totp_secret_enc=$2, totp_key_version=$3, totp_enabled=false, totp_last_step=NULL WHERE id=$1', [userId, Buffer.concat([s.nonce, s.ciphertext]), s.keyVersion]);
    return { secret, uri: totpUri(secret, email) };
  }

  async confirmTotpEnrollment(userId: string, code: string): Promise<string[]> {
    const u = (await this.db.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
    if (!u?.totp_secret_enc) throw new AuthError('totp_not_started');
    const secret = this.totpSecret(u);
    const step = verifyTotp(secret, code, null);
    if (step === null) throw new AuthError('invalid_code');
    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    await withTx(this.db, async tx => {
      await tx.query('UPDATE users SET totp_enabled=true, totp_last_step=$2 WHERE id=$1', [userId, step]);
      await tx.query('DELETE FROM recovery_codes WHERE user_id=$1', [userId]);
      for (const h of hashes) await tx.query('INSERT INTO recovery_codes(user_id, code_hash) VALUES ($1,$2)', [userId, h]);
      await audit(tx, { actorUserId: userId, action: 'auth.totp_enabled', result: 'success' });
    });
    return codes; // shown once; only hashes are stored
  }

  async disableTotp(userId: string) {
    await this.db.query('UPDATE users SET totp_enabled=false, totp_secret_enc=NULL, totp_last_step=NULL WHERE id=$1', [userId]);
    await this.db.query('DELETE FROM recovery_codes WHERE user_id=$1', [userId]);
    await audit(this.db, { actorUserId: userId, action: 'auth.totp_disabled', result: 'success' });
  }

  private totpSecret(u: { id: string; totp_secret_enc: Buffer; totp_key_version: string }): string {
    return open(this.ring(), { ciphertext: u.totp_secret_enc.subarray(12), nonce: u.totp_secret_enc.subarray(0, 12), keyVersion: u.totp_key_version }, `totp:${u.id}`);
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const rows = (await this.db.query('SELECT id, code_hash FROM recovery_codes WHERE user_id=$1 AND used_at IS NULL', [userId])).rows;
    for (const r of rows) {
      if (await verifyRecoveryCode(r.code_hash, code)) {
        const upd = await this.db.query('UPDATE recovery_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL', [r.id]);
        return !!upd.rowCount;
      }
    }
    return false;
  }

  async memberships(q: Queryable, userId: string) {
    const r = await q.query(
      `SELECT w.id, w.slug, w.name, w.is_demo, m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 ORDER BY w.created_at`, [userId]);
    return r.rows as { id: string; slug: string; name: string; is_demo: boolean; role: Role }[];
  }
}
