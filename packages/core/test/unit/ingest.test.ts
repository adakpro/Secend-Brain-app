import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import path from 'node:path';
import { parseChatExport } from '../../src/ingest/chat-import';
import { detectType, extractHtml, extractPlain } from '../../src/ingest/extract';
import { isForbiddenAddress, canonicalizeUrl, safeFetch } from '../../src/net/safe-fetch';
import { validateCitations } from '../../src/runs/citations';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/chats', n), 'utf8'));

describe('E04 chat import', () => {
  it('chat_messages: orders by time and reads content arrays', () => {
    const r = parseChatExport(fx('claude-chat_messages.json'));
    expect(r.format).toBe('chat_messages');
    expect(r.conversations[0].messages.map(m => m.text)).toEqual(['سؤال اول', 'پاسخ دوم', 'سؤال سوم']);
    expect(r.conversations[0].messages[0].role).toBe('user');
  });
  it('mapping: follows the active branch and reports dropped branches', () => {
    const r = parseChatExport(fx('chatgpt-mapping.json'));
    expect(r.format).toBe('mapping');
    const c = r.conversations[0];
    expect(c.messages.map(m => m.text)).toEqual(['Q1', 'A1 edited branch', 'Q2', 'A2']);
    expect(c.droppedBranches).toBe(1);
  });
  it('messages: generic shape', () => {
    const r = parseChatExport(fx('generic-messages.json'));
    expect(r.format).toBe('messages');
    expect(r.conversations[0].messages).toHaveLength(2);
  });
  it('unknown shapes are reported, not passed through', () => {
    const r = parseChatExport(fx('unsupported.json'));
    expect(r.format).toBe('unsupported'); expect(r.conversations).toHaveLength(0);
  });
});

describe('extraction', () => {
  it('detects real types and extension mismatch', () => {
    expect(detectType(Buffer.from('%PDF-1.7\n...'), 'a.pdf').type).toBe('pdf');
    expect(detectType(Buffer.from('%PDF-1.7\n...'), 'a.md').mismatch).toBe(true);
    expect(detectType(Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), 'x.zip').type).toBe('zip');
    expect(detectType(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]), 'x.txt').type).toBe('binary');
    expect(detectType(Buffer.from('# عنوان\n\nمتن'), 'n.md').type).toBe('markdown');
  });
  it('keeps Persian text byte-exact (E01)', () => {
    const t = 'سلام دنیا — متن فارسی با نیم‌فاصله و ي/ك عربی';
    expect(extractPlain(Buffer.from(t), 'text').text).toBe(t);
  });
  it('recognises login walls and does not report them as success (E02)', () => {
    const html = '<html><head><title>Sign in</title></head><body><form><input type="password"></form><p>Please log in to continue reading.</p></body></html>';
    const r = extractHtml(html, 'https://x.test/a');
    expect(r.quality).toBe('failed'); expect(r.failureCode).toBe('requires_login');
    expect(extractHtml('<html></html>', 'https://x.test', 403).failureCode).toBe('requires_login');
  });
  it('extracts a readable article without executing scripts', () => {
    const body = '<p>' + 'This is a long paragraph about personal knowledge management and linked notes. '.repeat(12) + '</p>';
    const r = extractHtml(`<html><head><title>Article</title><script>globalThis.PWNED=1</script></head><body><article><h1>Article</h1>${body}${body}</article></body></html>`, 'https://x.test/a');
    expect(r.quality).toBe('ok'); expect(r.text).toContain('personal knowledge');
    expect((globalThis as Record<string, unknown>).PWNED).toBeUndefined();
  });
});

describe('SSRF protection', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '100.64.0.1'])
    it(`blocks ${a}`, () => expect(isForbiddenAddress(a)).toBe(true));
  it('allows a public address', () => expect(isForbiddenAddress('93.184.215.14')).toBe(false));
  it('refuses localhost, credentials, odd ports and non-http protocols before any connection', async () => {
    await expect(safeFetch('http://localhost/')).rejects.toMatchObject({ code: 'forbidden_address' });
    await expect(safeFetch('http://127.0.0.1:8080/')).rejects.toMatchObject({ code: 'forbidden_address' });
    await expect(safeFetch('http://user:pw@example.com/')).rejects.toMatchObject({ code: 'credentials_in_url' });
    await expect(safeFetch('file:///etc/passwd')).rejects.toMatchObject({ code: 'protocol' });
    await expect(safeFetch('http://example.com:22/')).rejects.toMatchObject({ code: 'port' });
    await expect(safeFetch('http://[::1]/')).rejects.toMatchObject({ code: 'forbidden_address' });
    await expect(safeFetch('http://metadata.google.internal/')).rejects.toMatchObject({ code: 'forbidden_address' });
  });
  it('canonicalizes URLs for duplicate detection', () => {
    expect(canonicalizeUrl('HTTPS://Example.com:443/a/?utm_source=x&b=2&a=1#frag')).toBe('https://example.com/a?a=1&b=2');
  });
});

describe('F10 citation validation', () => {
  const chunks = [{ key: 'C1', kind: 'document' as const, title: 'Doc', heading: null, start: 0, end: 50, page: null, text: 'مدیریت دانش شخصی یعنی تبدیل خوانده‌ها به دانش' }];
  it('accepts a real quote from an issued key', () => {
    const v = validateCitations('جمله [C1]', [{ key: 'C1', quote: 'تبدیل خوانده‌ها به دانش' }], chunks);
    expect(v.validCount).toBe(1); expect(v.unbacked).toEqual([]);
  });
  it('flags fabricated keys, mismatched quotes and unbacked markers', () => {
    const v = validateCitations('الف [C1] ب [C9] ج [C7]', [{ key: 'C1', quote: 'جملهٔ ساختگی که در متن نیست' }, { key: 'C9', quote: 'x y z w' }], chunks);
    expect(v.checks.find(c => c.key === 'C1')!.reasons).toContain('quote_not_in_passage');
    expect(v.checks.find(c => c.key === 'C9')!.reasons).toContain('unknown_key');
    expect(v.fabricated).toEqual(['C9', 'C7']); expect(v.unbacked).toEqual(['C7']);
  });
});
