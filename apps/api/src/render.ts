import { Marked } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Server-side Markdown → HTML for exports. Raw HTML in the Markdown is escaped (never passed
 * through), links are limited to http(s)/mailto, images are dropped, so the exported file
 * cannot carry script, iframe or SVG payloads.
 */
const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      return /^(https?:|mailto:)/i.test(href) ? `<a href="${esc(href)}" rel="noopener noreferrer nofollow">${label}</a>` : label;
    },
    image({ text }) { return esc(text ?? ''); },
  },
});

export function markdownToSafeHtml(md: string, title: string, lang = 'fa'): string {
  const body = (marked.parse(md.replace(/^---\n[\s\S]*?\n---\n/, ''), { async: false }) as string).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, a) => esc(a ?? t));
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'fa' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>body{font-family:Vazirmatn,Tahoma,sans-serif;max-width:780px;margin:40px auto;padding:0 16px;line-height:2;color:#152033}code,pre{direction:ltr;unicode-bidi:isolate}pre{background:#f0f2f5;padding:12px;border-radius:8px;overflow:auto}blockquote{border-inline-start:3px solid #2168ff;margin:0;padding:6px 14px;background:#eaf2ff;border-radius:8px}table{border-collapse:collapse}td,th{border:1px solid #e9edf2;padding:4px 8px}</style>
</head><body><h1>${esc(title)}</h1>
${body}
</body></html>`;
}
