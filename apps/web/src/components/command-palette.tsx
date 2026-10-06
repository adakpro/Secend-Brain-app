import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { kindMeta } from '../lib/format';
import { Icon, Tile } from './ui';
import { NAV } from '../nav';

interface Cmd { id: string; title: string; hint: string; icon: string; to: string; writes?: boolean }

// Commands only navigate or open a form; nothing that writes runs straight from the palette.
const COMMANDS: Cmd[] = [
  ...NAV.map(n => ({ id: 'go' + n.to, title: `رفتن به ${n.label}`, hint: n.to, icon: n.icon, to: n.to })),
  { id: 'ingest', title: '/ingest — پردازش منبع آماده', hint: 'باز کردن ورودی‌ها؛ تحلیل با تأیید تو', icon: 'spark', to: '/inbox?status=ready_for_analysis', writes: true },
  { id: 'ask', title: '/ask — پرسش مستند', hint: 'پرسش از دانش خودت', icon: 'chat', to: '/ask' },
  { id: 'report', title: '/report — گزارش پژوهشی', hint: 'استودیوی خروجی', icon: 'file', to: '/studio?template=report', writes: true },
  { id: 'quiz', title: '/quiz — آزمون از منابع', hint: 'مرور و یادگیری', icon: 'bookmark', to: '/learn' },
  { id: 'lint', title: '/lint — سلامت ساختاری', hint: 'لینک شکسته، یتیم، frontmatter', icon: 'activity', to: '/activity?tab=health' },
  { id: 'graph', title: '/graph — تحلیل گراف', hint: 'نقشهٔ دانش', icon: 'graph', to: '/graph' },
  { id: 'project', title: '/project — پروژهٔ جدید', hint: 'فرم پروژه', icon: 'folder', to: '/projects?new=1', writes: true },
  { id: 'note', title: '/note — یادداشت دستی', hint: 'فرم یادداشت', icon: 'edit', to: '/library?new=note', writes: true },
  { id: 'claude', title: 'اتصال Claude', hint: 'تنظیمات › اتصال‌ها', icon: 'settings', to: '/settings/integrations/claude' },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ hits: any[]; projects: any[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) { d.showModal(); setQ(''); setRes(null); setTimeout(() => input.current?.focus(), 0); } if (!open && d.open) d.close(); }, [open]);
  useEffect(() => { const d = ref.current; const c = (e: Event) => { e.preventDefault(); onClose(); }; d?.addEventListener('cancel', c); return () => d?.removeEventListener('cancel', c); }, [onClose]);
  const commandMode = q.startsWith('>') || q.startsWith('/');
  useEffect(() => {
    if (commandMode || q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(async () => { setBusy(true); try { setRes(await api(`/search?q=${encodeURIComponent(q.trim())}&limit=12`)); } catch { setRes({ hits: [], projects: [] }); } finally { setBusy(false); } }, 220);
    return () => clearTimeout(t);
  }, [q, commandMode]);
  const go = (to: string) => { onClose(); nav(to); };
  const cmds = COMMANDS.filter(c => !q.trim() || c.title.includes(q.replace(/^[>/]/, '').trim()) || c.hint.includes(q.replace(/^[>/]/, '').trim()));
  return (
    <dialog ref={ref} className="search-dialog" aria-label="جست‌وجوی سراسری" onClick={e => { if (e.target === ref.current) onClose(); }}>
      {open ? <>
        <div className="search-box"><Icon name="search" /><input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="جست‌وجو… یا «>» برای فرمان‌ها" aria-label="عبارت جست‌وجو" /><kbd className="keycap">Esc</kbd></div>
        <div className="search-results" role="listbox">
          {commandMode || !q.trim() ? <>
            <div className="search-caption">فرمان‌ها {commandMode ? '' : '(برای فیلتر «>» بزنید)'}</div>
            {cmds.slice(0, commandMode ? 20 : 6).map(c => <button key={c.id} className="search-result" onClick={() => go(c.to)}><Tile icon={c.icon} color={c.writes ? 'orange' : 'blue'} mini /><span><h3>{c.title}</h3><p>{c.hint}{c.writes ? ' · فرم یا تأیید جداگانه' : ''}</p></span></button>)}
          </> : <>
            {busy ? <div className="search-caption">در حال جست‌وجو…</div> : null}
            {res?.projects?.length ? <><div className="search-caption">پروژه‌ها</div>{res.projects.map(p => <button key={p.id} className="search-result" onClick={() => go(`/projects/${p.id}`)}><Tile icon="folder" color="green" mini /><span><h3>{p.title}</h3></span></button>)}</> : null}
            {res?.hits?.length ? <><div className="search-caption">دانش و منابع (جست‌وجوی متنی)</div>{res.hits.map((h: any) => (
              <button key={h.documentId ?? h.sourceId} className="search-result" onClick={() => go(h.documentId ? `/library/${h.documentId}` : `/inbox/${h.sourceId}`)}>
                <Tile icon={h.documentId ? (kindMeta[h.docKind]?.icon ?? 'file') : 'import'} color={h.documentId ? (kindMeta[h.docKind]?.color ?? 'gray') : 'gray'} mini />
                <span><h3>{h.title}</h3><p>{h.documentId ? kindMeta[h.docKind]?.label : 'منبع خام'}{h.heading ? ` · ${h.heading}` : ''} — {String(h.snippet).replace(/\s+/g, ' ').slice(0, 110)}</p></span>
              </button>))}</> : null}
            {res && !busy && !res.hits.length && !res.projects.length ? <div className="search-caption">نتیجه‌ای پیدا نشد.</div> : null}
          </>}
        </div>
        <div className="search-bottom"><span>Enter برای باز کردن · Esc برای بستن</span><span>جست‌وجوی متنی؛ نتایج پاسخ مدل نیستند</span></div>
      </> : null}
    </dialog>
  );
}
