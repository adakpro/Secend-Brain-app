import { useMemo, useState } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { Icon, Modal, toast, errText } from './ui';

const marked = new Marked({ gfm: true, breaks: false });

// Strict allowlist: no SVG, iframe, script, style, form or event handlers; links limited to http(s)/mailto/app routes.
const PURIFY = {
  ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'sup', 'input'],
  ALLOWED_ATTR: ['href', 'title', 'class', 'data-wikilink', 'data-cite', 'dir', 'type', 'checked', 'disabled'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/(?!\/))/i,
  FORBID_TAGS: ['svg', 'math', 'iframe', 'script', 'style', 'form', 'img', 'video', 'audio', 'object', 'embed'],
  RETURN_TRUSTED_TYPE: false,
};
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') { node.setAttribute('rel', 'noopener noreferrer nofollow'); if (/^https?:/.test(node.getAttribute('href') ?? '')) node.setAttribute('target', '_blank'); }
  if (node.tagName === 'INPUT' && node.getAttribute('type') !== 'checkbox') node.remove();
  if (node.tagName === 'CODE' || node.tagName === 'PRE') node.setAttribute('dir', 'ltr');
});

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderMarkdown(md: string, opts: { citations?: boolean } = {}): string {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  let html = marked.parse(body, { async: false }) as string;
  html = html.replace(/\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g, (_m, t, _h, a) => `<a href="#" class="wikilink" data-wikilink="${escapeHtml(t.trim())}">${escapeHtml((a ?? t).trim())}</a>`);
  if (opts.citations) html = html.replace(/\[((?:C|S)\d+)\]/g, (_m, k) => `<sup><a href="#" class="cite-ref" data-cite="${k}">${k}</a></sup>`);
  return DOMPurify.sanitize(html, PURIFY) as unknown as string;
}

/** Renders untrusted Markdown safely. Wikilinks resolve via the given map, otherwise through search. */
export function Markdown({ text, links, onCite, citations }: { text: string; links?: Record<string, string | null>; onCite?: (key: string) => void; citations?: boolean }) {
  const html = useMemo(() => renderMarkdown(text, { citations }), [text, citations]);
  const nav = useNavigate();
  return (
    <div className="note-prose" dir="auto" dangerouslySetInnerHTML={{ __html: html }} onClick={async e => {
      const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
      if (!a) return;
      const wl = a.dataset.wikilink; const ck = a.dataset.cite;
      if (ck) { e.preventDefault(); onCite?.(ck); return; }
      if (wl) {
        e.preventDefault();
        const id = links?.[wl];
        if (id) { nav(`/library/${id}`); return; }
        if (links && wl in links) { toast(`صفحهٔ «${wl}» هنوز وجود ندارد (خلأ).`, 'error'); return; }
        try { const r = await api(`/search?q=${encodeURIComponent(wl)}&limit=1`); const h = r.hits.find((x: any) => x.documentId); if (h) nav(`/library/${h.documentId}`); else toast(`صفحهٔ «${wl}» پیدا نشد.`, 'error'); } catch (err) { toast(errText(err), 'error'); }
      } else if (a.getAttribute('href')?.startsWith('/')) { e.preventDefault(); nav(a.getAttribute('href')!); }
    }} />
  );
}

/** Unified-diff viewer; long lines wrap inside the panel so the page never overflows horizontally. */
export function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split('\n').filter((l, i) => !(i < 4 && (l.startsWith('====') || l.startsWith('---') || l.startsWith('+++') || l.startsWith('Index:'))));
  return (
    <div className="diff-view" role="region" aria-label="تفاوت نسخه‌ها">
      {lines.map((l, i) => {
        const t = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
        return <div key={i} className={`diff-line ${t}`}><span className="diff-sign" aria-hidden="true">{t === 'add' ? '+' : t === 'del' ? '−' : ' '}</span><span className="diff-text" dir="auto">{t === 'hunk' ? l : l.slice(1) || ' '}</span></div>;
      })}
    </div>
  );
}

export function StepUpDialog({ open, onClose, onDone, totp }: { open: boolean; onClose: () => void; onDone: () => void; totp: boolean }) {
  const [pw, setPw] = useState(''); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} title="تأیید دوبارهٔ هویت" onClose={onClose}>
      <form onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api('/auth/step-up', { json: { password: pw, ...(totp ? { totp: code } : {}) } }); setPw(''); setCode(''); onDone(); } catch (err) { toast(errText(err), 'error'); } finally { setBusy(false); } }}>
        <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>این عملیات حساس است؛ برای ادامه گذرواژهٔ حساب برنامه{totp ? ' و کد تأیید دومرحله‌ای' : ''} را وارد کن. اعتبار این تأیید ۱۰ دقیقه است.</p>
        <div className="form-group"><label className="field-label" htmlFor="su-pw">گذرواژهٔ برنامه</label><input id="su-pw" className="field" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} required /></div>
        {totp ? <div className="form-group"><label className="field-label" htmlFor="su-code">کد ۶ رقمی</label><input id="su-code" className="field ltr" inputMode="numeric" pattern="\d{6}" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required /></div> : null}
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>انصراف</button><button className="btn primary" disabled={busy}><Icon name="shield" size="sm" />{busy ? 'در حال بررسی…' : 'تأیید'}</button></div>
      </form>
    </Modal>
  );
}

/** Runs an action that may need step-up: on 403 step_up_required, asks for re-authentication and retries once. */
export function useStepUp(totp: boolean) {
  const [pending, setPending] = useState<null | (() => Promise<void>)>(null);
  const run = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) {
      if ((e as { code?: string }).code === 'step_up_required') setPending(() => fn); else throw e;
    }
  };
  const dialog = <StepUpDialog open={!!pending} totp={totp} onClose={() => setPending(null)} onDone={async () => { const f = pending; setPending(null); try { await f?.(); } catch (e) { toast(errText(e), 'error'); } }} />;
  return { run, dialog };
}
