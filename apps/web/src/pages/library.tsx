import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { num, relative, kindMeta, isLatin } from '../lib/format';
import { Icon, Tile, Chip, PageHeader, EmptyState, ErrorState, LoadingState, Modal, Field, Tabs, toast, errText } from '../components/ui';
import { useWorkspace, canEdit } from '../session';

type KindTab = 'all' | 'source' | 'concept' | 'entity' | 'synthesis' | 'note';
const TABS: [KindTab, string][] = [['all', 'همه'], ['source', 'منابع'], ['concept', 'مفاهیم'], ['entity', 'موجودیت‌ها'], ['synthesis', 'جمع‌بندی‌ها'], ['note', 'یادداشت‌ها']];

function NewNoteDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate(); const qc = useQueryClient();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const tagList = tags.split(/[,،]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 20);
      const r = await api<{ id: string }>('/documents', { json: { title, content, tags: tagList, folder: 'notes' } });
      qc.invalidateQueries({ queryKey: ['documents'] }); qc.invalidateQueries({ queryKey: ['overview'] });
      toast('یادداشت ساخته شد.');
      onClose(); nav(`/library/${r.id}`);
    } catch (err) { toast(errText(err), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open title="یادداشت جدید" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="عنوان" id="nn-title"><input id="nn-title" className="field" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required dir="auto" autoFocus /></Field>
        <Field label="برچسب‌ها" id="nn-tags" help="با ویرگول جدا کن"><input id="nn-tags" className="field" value={tags} onChange={e => setTags(e.target.value)} dir="auto" /></Field>
        <Field label="متن اولیه (Markdown)" id="nn-text" help="یادداشت دستی در پوشهٔ notes/ ذخیره می‌شود و جزو صفحات wiki عامل نیست."><textarea id="nn-text" className="field" value={content} onChange={e => setContent(e.target.value)} dir="auto" /></Field>
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>انصراف</button><button className="btn primary" disabled={busy || !title.trim()}>{busy ? 'در حال ساخت…' : 'ساخت یادداشت'}</button></div>
      </form>
    </Modal>
  );
}

export default function LibraryPage() {
  const ws = useWorkspace();
  const writer = canEdit(ws?.role ?? 'viewer');
  const [params, setParams] = useSearchParams();
  const kind = (params.get('kind') as KindTab) || 'all';
  const tag = params.get('tag') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [newOpen, setNewOpen] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (params.get('new') === 'note' && writer) { setNewOpen(true); const p = new URLSearchParams(params); p.delete('new'); setParams(p, { replace: true }); } }, [params, setParams, writer]);
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };

  const docs = useQuery({
    queryKey: ['documents', kind, tag, debounced],
    queryFn: () => api(`/documents?limit=120${kind !== 'all' ? `&kind=${kind}` : ''}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`),
  });
  const items: any[] = docs.data?.items ?? [];
  return (
    <>
      <PageHeader title="کتابخانهٔ دانش" description="منابع را کنار هم ببین؛ از یادداشت‌های پراکنده به یک تصویر روشن برس."
        action={writer ? <button className="btn primary" onClick={() => setNewOpen(true)}><Icon name="plus" size="sm" />یادداشت جدید</button> : undefined} />
      <div className="toolbar">
        <Tabs label="نوع دانش" value={kind} onChange={v => setParam('kind', v === 'all' ? '' : v)} items={TABS} />
        <input className="field filter-input" type="search" placeholder="جست‌وجو در کتابخانه…" aria-label="جست‌وجو در کتابخانه" value={q} onChange={e => setQ(e.target.value)} dir="auto" />
      </div>
      {tag ? <div className="row" style={{ marginBottom: 15 }}><Chip color="blue">#{tag}</Chip><button className="text-link" onClick={() => setParam('tag', '')}>حذف فیلتر <Icon name="close" size="sm" /></button></div> : null}
      <div className="between" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 11 }} aria-live="polite">{docs.data ? `${num(docs.data.total)} صفحه${debounced ? ' (جست‌وجوی متنی)' : ''}` : ''}</span>
        <span className="muted" style={{ fontSize: 10 }}>برای مشاهده و ویرایش، یک صفحه را باز کن.</span>
      </div>
      {docs.isPending ? <LoadingState /> : docs.error ? <ErrorState error={docs.error} retry={() => docs.refetch()} /> : items.length ? (
        <div className="note-grid">
          {items.map(d => {
            const m = kindMeta[d.kind] ?? kindMeta.other;
            return (
              <Link key={d.id} className="card note-card" to={`/library/${d.id}`} style={{ textDecoration: 'none', color: 'inherit' }} aria-label={`باز کردن ${d.title}`}>
                <div className="between"><Tile icon={m.icon} color={m.color} /><span className="chip">{m.label}</span></div>
                <h3 className={isLatin(d.title) ? 'ltr' : ''}>{d.title}</h3>
                <p dir="auto">{String(d.excerpt ?? '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim() || 'بدون متن'}</p>
                <div className="tags">{(d.tags ?? []).slice(0, 3).map((t: string) => <span key={t} className="tag">#{t}</span>)}</div>
                <div className="note-foot"><span>{relative(d.updated_at)}</span><span>{d.author_kind === 'user' ? 'ویرایش شما' : d.author_kind === 'agent' ? 'پیشنهاد پذیرفته‌شده' : d.author_kind === 'external' ? 'تغییر بیرونی' : 'واردشده'}</span></div>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyState icon="search" title={debounced || tag || kind !== 'all' ? 'صفحه‌ای پیدا نشد' : 'کتابخانه هنوز خالی است'}
          text={debounced || tag || kind !== 'all' ? 'فیلتر یا عبارت جست‌وجو را تغییر بده.' : 'یک منبع اضافه کن و پیشنهادهای ساخت صفحه را در «بررسی تغییرات» تأیید کن، یا یک یادداشت دستی بنویس.'}
          action={writer && !debounced && !tag ? <button className="btn primary" onClick={() => setNewOpen(true)}>یادداشت جدید</button> : undefined} />
      )}
      {newOpen ? <NewNoteDialog onClose={() => setNewOpen(false)} /> : null}
    </>
  );
}
