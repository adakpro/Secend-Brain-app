import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Readable } from 'node:stream';

export class FetchPolicyError extends Error { constructor(public code: string, msg: string) { super(msg); } }

const BLOCKED_RANGES = new Set(['unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'private', 'reserved', 'carrierGradeNat', 'uniqueLocal', 'ipv4Mapped', 'rfc6145', 'rfc6052', '6to4', 'teredo', 'benchmarking', 'amt', 'as112', 'deprecated', 'orchid2']);

export function isForbiddenAddress(addr: string): boolean {
  let ip: ipaddr.IPv4 | ipaddr.IPv6;
  try { ip = ipaddr.parse(addr); } catch { return true; }
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
  const range = ip.range();
  if (BLOCKED_RANGES.has(range)) return true;
  // Cloud metadata endpoints and 0.0.0.0/8 regardless of library classification.
  const s = ip.toString();
  return s === '169.254.169.254' || s.startsWith('0.') || s === 'fd00:ec2::254' || s === '100.100.100.200';
}

async function resolveSafe(hostname: string): Promise<string> {
  if (net.isIP(hostname)) { if (isForbiddenAddress(hostname)) throw new FetchPolicyError('forbidden_address', 'مقصد شبکهٔ داخلی مجاز نیست.'); return hostname; }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(hostname)) throw new FetchPolicyError('forbidden_address', 'مقصد شبکهٔ داخلی مجاز نیست.');
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => { throw new FetchPolicyError('dns_failed', 'نام دامنه پیدا نشد.'); });
  if (!addrs.length) throw new FetchPolicyError('dns_failed', 'نام دامنه پیدا نشد.');
  for (const a of addrs) if (isForbiddenAddress(a.address)) throw new FetchPolicyError('forbidden_address', 'مقصد به شبکهٔ داخلی resolve می‌شود.');
  return addrs[0].address;
}

export interface SafeFetchResult { finalUrl: string; status: number; contentType: string; body: Buffer; headers: Record<string, string>; redirects: string[] }

/**
 * Fetches a public URL with SSRF protection. The address is validated at resolution time
 * AND the socket connects to exactly that validated address (no second DNS lookup), so a
 * rebinding answer cannot redirect the connection. Redirects are re-validated hop by hop.
 */
export async function safeFetch(rawUrl: string, opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; accept?: string } = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new FetchPolicyError('invalid_url', 'نشانی معتبر نیست.'); }
  const redirects: string[] = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new FetchPolicyError('protocol', 'فقط http و https مجازند.');
    if (url.username || url.password) throw new FetchPolicyError('credentials_in_url', 'نشانی حاوی نام کاربری/گذرواژه پذیرفته نمی‌شود.');
    if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new FetchPolicyError('port', 'پورت غیرمعمول مجاز نیست.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const pinned = await resolveSafe(host);
    const dispatcher = new Agent({
      connect: { lookup: (_h, _o, cb) => cb(null, [{ address: pinned, family: net.isIPv6(pinned) ? 6 : 4 }] as never), timeout: 10_000 },
      headersTimeout: opts.timeoutMs ?? 20_000, bodyTimeout: opts.timeoutMs ?? 20_000,
    });
    try {
      const res = await request(url, {
        method: 'GET', dispatcher,
        headers: { 'user-agent': 'SecondBrainOS/0.1 (+self-hosted; source import)', accept: opts.accept ?? 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
      });
      const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        await res.body.dump();
        const loc = headers['location'];
        if (!loc) throw new FetchPolicyError('bad_redirect', 'تغییر مسیر بدون مقصد.');
        url = new URL(loc, url); redirects.push(url.toString());
        continue;
      }
      const declared = Number(headers['content-length'] ?? '0');
      if (declared > maxBytes) { await res.body.dump(); throw new FetchPolicyError('too_large', 'حجم پاسخ بیش از حد مجاز است.'); }
      const enc = (headers['content-encoding'] ?? '').toLowerCase();
      let stream: Readable = res.body as unknown as Readable;
      if (enc === 'gzip') stream = stream.pipe(createGunzip()); else if (enc === 'deflate') stream = stream.pipe(createInflate()); else if (enc === 'br') stream = stream.pipe(createBrotliDecompress());
      const chunks: Buffer[] = []; let total = 0;
      for await (const c of stream) {
        total += (c as Buffer).length;
        if (total > maxBytes) { stream.destroy(); throw new FetchPolicyError('too_large', 'حجم پاسخ (پس از decompress) بیش از حد مجاز است.'); }
        chunks.push(c as Buffer);
      }
      return { finalUrl: url.toString(), status: res.statusCode, contentType: headers['content-type'] ?? '', body: Buffer.concat(chunks), headers, redirects };
    } finally { await dispatcher.close().catch(() => undefined); }
  }
  throw new FetchPolicyError('too_many_redirects', 'تعداد تغییر مسیرها بیش از حد است.');
}

/** Canonical URL for exact-duplicate detection: lowercase host, no fragment, no tracking params, sorted query. */
export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = ''; u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = params.length ? '?' + new URLSearchParams(params).toString() : '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}
