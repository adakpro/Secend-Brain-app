import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export const EXTRACTOR_VERSION = '1';

export interface Extraction {
  quality: 'ok' | 'partial' | 'needs_ocr' | 'failed';
  extractor: string;
  text: string;
  title?: string;
  meta: Record<string, unknown>;
  coverage: { totalUnits: number; readUnits: number; unit: 'chars' | 'pages' | 'messages'; notes?: string[] };
  failureCode?: string;
  failureMessage?: string;
}

export type DetectedType = 'pdf' | 'zip' | 'json' | 'markdown' | 'text' | 'html' | 'binary';

/** Detects the real file type from magic bytes and content, then cross-checks the extension. */
export function detectType(buf: Buffer, filename = ''): { type: DetectedType; mismatch: boolean } {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  let type: DetectedType;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') type = 'pdf';
  else if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5)) type = 'zip';
  else {
    const text = decodeUtf8(buf);
    if (text === null) type = 'binary';
    else {
      const t = text.trimStart();
      if ((t.startsWith('{') || t.startsWith('[')) && isJson(t)) type = 'json';
      else if (/^<(!doctype html|html|head|body)/i.test(t)) type = 'html';
      else if (ext === 'md' || ext === 'markdown' || /^(---\n|#{1,6} )/m.test(t.slice(0, 2000))) type = 'markdown';
      else type = 'text';
    }
  }
  const expected: Record<string, DetectedType[]> = { pdf: ['pdf'], zip: ['zip'], json: ['json'], md: ['markdown', 'text'], markdown: ['markdown', 'text'], txt: ['text', 'markdown'], html: ['html'], htm: ['html'], vtt: ['text'], srt: ['text'] };
  const mismatch = !!ext && !!expected[ext] && !expected[ext].includes(type);
  return { type, mismatch };
}

export function decodeUtf8(buf: Buffer): string | null {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    // Reject NUL-heavy content that decodes but is really binary.
    if (/\u0000/.test(s.slice(0, 4096))) return null;
    return s.replace(/^﻿/, '');
  } catch { return null; }
}

function isJson(s: string): boolean { try { JSON.parse(s); return true; } catch { return false; } }

export function extractPlain(buf: Buffer, kind: 'text' | 'markdown'): Extraction {
  const text = decodeUtf8(buf);
  if (text === null) return { quality: 'failed', extractor: 'utf8', text: '', meta: {}, coverage: { totalUnits: 0, readUnits: 0, unit: 'chars' }, failureCode: 'not_utf8', failureMessage: 'فایل متن UTF-8 معتبر نیست.' };
  const title = kind === 'markdown' ? /^#\s+(.+)$/m.exec(text)?.[1]?.trim() : undefined;
  return { quality: text.trim() ? 'ok' : 'failed', extractor: kind === 'markdown' ? 'markdown' : 'utf8', text, title, meta: {}, coverage: { totalUnits: text.length, readUnits: text.length, unit: 'chars' }, ...(text.trim() ? {} : { failureCode: 'empty', failureMessage: 'متنی برای استخراج وجود ندارد.' }) };
}

const LOGIN_HINTS = /(sign in|log in|login|subscribe to (read|continue)|create an account|paywall|ورود به حساب|برای ادامه وارد شوید|اشتراک تهیه کنید)/i;

/**
 * Readability-based article extraction. The page's scripts are never executed (linkedom is a
 * DOM parser without a JS engine). Pages that look like a login wall or paywall are reported
 * as failures, not as successful short extractions.
 */
export function extractHtml(html: string, url: string, httpStatus = 200): Extraction {
  const base = { extractor: 'readability', meta: { httpStatus, url } as Record<string, unknown>, coverage: { totalUnits: html.length, readUnits: 0, unit: 'chars' as const } };
  if (httpStatus === 401 || httpStatus === 403) return { ...base, quality: 'failed', text: '', failureCode: 'requires_login', failureMessage: 'صفحه نیازمند ورود یا دسترسی خاص است.' };
  if (httpStatus >= 400) return { ...base, quality: 'failed', text: '', failureCode: 'http_error', failureMessage: `سرور پاسخ ${httpStatus} داد.` };
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll('script,style,noscript,iframe,svg,form')) el.remove();
  const pageTitle = document.querySelector('title')?.textContent?.trim();
  const hasPassword = /<input[^>]+type=["']?password/i.test(html);
  let article: { title?: string | null; textContent?: string | null; content?: string | null; byline?: string | null; siteName?: string | null; publishedTime?: string | null; lang?: string | null } | null = null;
  try { article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse(); } catch { article = null; }
  const text = (article?.textContent ?? document.body?.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if ((hasPassword && text.length < 1500) || (text.length < 600 && LOGIN_HINTS.test(text + ' ' + (pageTitle ?? '')))) {
    return { ...base, quality: 'failed', text: '', title: pageTitle, failureCode: 'requires_login', failureMessage: 'به نظر می‌رسد صفحه پشت ورود یا paywall است؛ متن کامل قابل استخراج نیست.' };
  }
  if (text.length < 80) return { ...base, quality: 'failed', text, title: pageTitle, failureCode: 'no_article', failureMessage: 'متن قابل استفاده‌ای در صفحه پیدا نشد (ممکن است محتوا با JavaScript بارگذاری شود).' };
  return {
    ...base, quality: 'ok', text, title: article?.title || pageTitle,
    meta: { ...base.meta, byline: article?.byline ?? null, siteName: article?.siteName ?? null, publishedTime: article?.publishedTime ?? null, lang: article?.lang ?? null, sanitizedHtml: undefined },
    coverage: { totalUnits: text.length, readUnits: text.length, unit: 'chars' },
  };
}

/** PDF text extraction with per-page form-feed separators so citations can carry page numbers. */
export async function extractPdf(buf: Buffer, { maxPages = 500, timeoutMs = 60_000 } = {}): Promise<Extraction> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, stopAtErrors: false });
  const timer = setTimeout(() => { void task.destroy(); }, timeoutMs);
  try {
    const doc = await task.promise;
    const total = doc.numPages;
    const pages: string[] = [];
    const n = Math.min(total, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let line = '';
      const parts: string[] = [];
      for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof it.str !== 'string') continue;
        line += it.str;
        if (it.hasEOL) { parts.push(line); line = ''; }
      }
      if (line) parts.push(line);
      pages.push(parts.join('\n').replace(/[ \t]+/g, ' ').trim());
      page.cleanup();
    }
    const info = await doc.getMetadata().catch(() => null);
    await task.destroy();
    const chars = pages.reduce((a, p) => a + p.replace(/\s/g, '').length, 0);
    const meta = { pageCount: total, title: (info?.info as Record<string, string> | undefined)?.Title || undefined };
    if (chars < Math.max(30, n * 15)) {
      return { quality: 'needs_ocr', extractor: 'pdfjs', text: '', meta, coverage: { totalUnits: total, readUnits: 0, unit: 'pages', notes: ['no text layer; OCR is not enabled'] }, failureCode: 'needs_ocr', failureMessage: 'این PDF لایهٔ متنی ندارد (احتمالاً اسکن‌شده است). OCR فعال نیست؛ می‌توانید متن جایگزین وارد کنید.' };
    }
    const partial = n < total;
    return { quality: partial ? 'partial' : 'ok', extractor: 'pdfjs', text: pages.join('\n\f'), title: meta.title, meta, coverage: { totalUnits: total, readUnits: n, unit: 'pages', ...(partial ? { notes: [`only the first ${n} of ${total} pages were read`] } : {}) } };
  } catch (e) {
    return { quality: 'failed', extractor: 'pdfjs', text: '', meta: {}, coverage: { totalUnits: 0, readUnits: 0, unit: 'pages' }, failureCode: 'pdf_error', failureMessage: 'خواندن PDF ناموفق بود: ' + (e as Error).message.slice(0, 200) };
  } finally { clearTimeout(timer); }
}
