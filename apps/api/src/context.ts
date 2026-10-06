import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  type AppConfig, type Db, type Keyring, AuthService, CredentialService, VaultService, ChangeSetEngine, SourceService, RunService, ROLE_RANK,
  type Role, type SessionInfo, AuthError,
} from '@sb/core';
import type { ZodType } from 'zod';

export interface Deps {
  cfg: AppConfig; db: Db; ring: () => Keyring; boss: PgBoss | null;
  auth: AuthService; creds: CredentialService; vault: VaultService; engine: ChangeSetEngine; sources: SourceService; runs: RunService;
  internalToken: string;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false, public details?: unknown) { super(message); }
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionInfo | null;
    space: { id: string; slug: string; name: string; role: Role; isDemo: boolean } | null;
  }
}

export const COOKIE = (secure: boolean) => (secure ? '__Host-sb_session' : 'sb_session');

export function requireSession(req: FastifyRequest): SessionInfo {
  if (!req.session) throw new HttpError(401, 'unauthenticated', 'ابتدا وارد شوید.');
  return req.session;
}

export function requireWs(req: FastifyRequest, min: Role = 'viewer') {
  requireSession(req);
  if (!req.space) throw new HttpError(400, 'workspace_required', 'فضای دانش انتخاب نشده یا دسترسی ندارید.');
  if (ROLE_RANK[req.space.role] < ROLE_RANK[min]) throw new HttpError(403, 'forbidden', 'نقش شما اجازهٔ این کار را ندارد.');
  return req.space;
}

/** Installation-level admin actions (credentials, users, backups, terminal): owner or admin of the first workspace. */
export function requireAdmin(req: FastifyRequest, deps: Deps): Promise<{ session: SessionInfo; role: Role }> {
  const s = requireSession(req);
  return deps.db.query(`SELECT max(CASE role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 ELSE 0 END) AS r FROM memberships WHERE user_id=$1`, [s.userId]).then(r => {
    const rank = Number(r.rows[0]?.r ?? 0);
    if (!s.isInstallationOwner && rank < 3) throw new HttpError(403, 'forbidden', 'فقط مدیر سامانه به این بخش دسترسی دارد.');
    return { session: s, role: (s.isInstallationOwner ? 'owner' : 'admin') as Role };
  });
}

export function requireStepUp(req: FastifyRequest) {
  const s = requireSession(req);
  if (!AuthService.hasRecentStepUp(s)) throw new HttpError(403, 'step_up_required', 'برای این عملیات دوباره هویت خود را تأیید کنید.');
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(422, 'validation_failed', 'ورودی نامعتبر است.', false, r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export function clientIp(req: FastifyRequest) { return req.ip; }

export function mapError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof AuthError) {
    const map: Record<string, [number, string]> = {
      invalid_credentials: [401, 'ایمیل، گذرواژه یا کد تأیید نادرست است.'],
      rate_limited: [429, 'تلاش‌های ناموفق زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید.'],
      second_factor_required: [401, 'کد تأیید دومرحله‌ای لازم است.'],
      step_up_failed: [401, 'تأیید هویت ناموفق بود.'],
      owner_exists: [409, 'مالک سامانه قبلاً ساخته شده است.'],
      invalid_code: [422, 'کد نادرست است.'],
      totp_not_started: [409, 'ابتدا راه‌اندازی تأیید دومرحله‌ای را شروع کنید.'],
    };
    const [st, msg] = map[e.code] ?? [400, e.message];
    // second_factor_required is indistinguishable in status from a wrong password, but the UI needs to know to show the field.
    return new HttpError(st, e.code === 'second_factor_required' ? 'second_factor_required' : e.code === 'rate_limited' ? 'rate_limited' : e.code === 'invalid_credentials' ? 'invalid_credentials' : e.code, msg, e.code === 'rate_limited');
  }
  const name = (e as Error)?.constructor?.name;
  const msg = (e as Error)?.message ?? 'error';
  if (name === 'ConflictError') return new HttpError(409, 'conflict', 'فایل یا صفحه از زمان باز شدن تغییر کرده است.', false, (e as { details?: unknown }).details);
  if (name === 'ValidationError') return new HttpError(422, 'validation_failed', msg, false, (e as { issues?: unknown }).issues);
  if (name === 'PathError') return new HttpError((e as { code?: string }).code === 'not_found' ? 404 : 400, (e as { code?: string }).code ?? 'invalid_path', msg);
  if (name === 'SourceError') return new HttpError((e as { status?: number }).status ?? 400, (e as { code?: string }).code ?? 'source_error', msg);
  if (name === 'ProviderError') return new HttpError(400, (e as { code?: string }).code ?? 'provider_error', msg, (e as { retryable?: boolean }).retryable ?? false);
  if (name === 'PolicyError') return new HttpError(422, 'password_policy', 'گذرواژه باید دست‌کم ۱۲ نویسه باشد.');
  if ((e as { code?: string })?.code === '23505') return new HttpError(409, 'duplicate', 'رکورد تکراری است.');
  if ((e as { statusCode?: number })?.statusCode === 413) return new HttpError(413, 'too_large', 'حجم درخواست بیش از حد مجاز است.');
  return new HttpError(500, 'internal_error', 'خطای داخلی؛ با شناسهٔ پیگیری گزارش دهید.', true);
}

export function sendFile(reply: FastifyReply, name: string, type: string, body: Buffer | string) {
  const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'download';
  return reply
    .header('content-type', type)
    .header('content-disposition', `attachment; filename="${encodeURIComponent(safe).replace(/%20/g, ' ').replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('cache-control', 'no-store')
    .send(body);
}
