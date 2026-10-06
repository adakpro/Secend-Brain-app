import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { num, relative } from '../lib/format';
import { PageHeader, Modal, Field, Tabs, Progress, EmptyState, LoadingState, ErrorState, Icon, Chip, toast, errText } from '../components/ui';
import { useWorkspace, canEdit } from '../session';

const STATUS: Record<string, { label: string; color: string }> = {
  active: { label: 'در جریان', color: 'blue' }, paused: { label: 'متوقف', color: 'orange' }, done: { label: 'تکمیل‌شده', color: 'green' }, archived: { label: 'بایگانی', color: '' },
};
const COLORS = ['blue', 'purple', 'teal', 'green', 'orange'] as const;

export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState(''); const [goal, setGoal] = useState(''); const [description, setDescription] = useState('');
  const [color, setColor] = useState<(typeof COLORS)[number]>('blue'); const [busy, setBusy] = useState(false);
  const qc = useQueryClient(); const nav = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api<{ id: string }>('/projects', { json: { title, goal, description, color } });
      qc.invalidateQueries({ queryKey: ['projects'] }); qc.invalidateQueries({ queryKey: ['overview'] });
      toast('پروژه ساخته شد.'); onClose(); nav(`/projects/${r.id}`);
    } catch (err) { toast(errText(err), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="پروژهٔ جدید" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="عنوان" id="pj-title"><input id="pj-title" className="field" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required dir="auto" /></Field>
        <Field label="هدف" id="pj-goal" help="یک هدف روشن؛ مثل CLAUDE.md پروژه در مخزن مبنا."><input id="pj-goal" className="field" value={goal} onChange={e => setGoal(e.target.value)} maxLength={1000} dir="auto" /></Field>
        <Field label="توضیح" id="pj-desc"><textarea id="pj-desc" className="field" value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} dir="auto" /></Field>
        <div className="form-group"><span className="field-label">رنگ</span><div className="setting-options" role="radiogroup" aria-label="رنگ پروژه">
          {COLORS.map(c => <button type="button" key={c} role="radio" aria-checked={color === c} className={`setting-option ${color === c ? 'active' : ''}`} onClick={() => setColor(c)}><span className="dot" style={{ color: `var(--${c})` }} />{c}</button>)}
        </div></div>
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>انصراف</button><button className="btn primary" disabled={busy || !title.trim()}>{busy ? 'در حال ساخت…' : 'ساخت پروژه'}</button></div>
      </form>
    </Modal>
  );
}

export default function ProjectsPage() {
  const ws = useWorkspace(); const writer = canEdit(ws?.role ?? 'viewer');
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'active' | 'all' | 'archived'>('active');
  const [open, setOpen] = useState(false);
  useEffect(() => { if (params.get('new') === '1' && writer) { setOpen(true); params.delete('new'); setParams(params, { replace: true }); } }, [params, setParams, writer]);
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api('/projects') });
  const items: any[] = (q.data?.items ?? []).filter((p: any) => filter === 'all' ? true : filter === 'archived' ? p.status === 'archived' : p.status !== 'archived');
  return (
    <>
      <PageHeader title="پروژه‌ها" description="دانسته‌هایت را به کاری که همین حالا انجام می‌دهی متصل کن." action={writer ? <button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" size="sm" /> پروژهٔ جدید</button> : undefined} />
      <div className="toolbar"><Tabs label="فیلتر وضعیت" value={filter} onChange={setFilter} items={[['active', 'فعال'], ['all', 'همه'], ['archived', 'بایگانی']]} /><span className="muted" style={{ fontSize: 11 }}>{num(items.length)} پروژه</span></div>
      {q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : items.length ? (
        <div className="project-grid">
          {items.map(p => (
            <article key={p.id} className="card project-card">
              <div className="between"><span className={`icon-tile ${p.color}`}><Icon name="folder" /></span><Chip color={STATUS[p.status]?.color}>{STATUS[p.status]?.label ?? p.status}</Chip></div>
              <h2 dir="auto">{p.title}</h2>
              <p dir="auto">{p.goal || p.description || 'هدفی ثبت نشده است.'}</p>
              <div>
                <div className="progress-label"><span className="muted">پیشرفت کارها</span><span>{p.tasks ? `${num(p.progress)}٪ · ${num(p.done)} از ${num(p.tasks)}` : 'بدون کار تعریف‌شده'}</span></div>
                <Progress value={p.tasks ? p.progress : 0} color={p.color === 'purple' ? 'purple' : ''} />
              </div>
              <div className="between"><span className="muted" style={{ fontSize: 10 }}>{num(p.sources)} منبع پیوندی · {relative(p.updated_at)}</span><Link className="btn small" to={`/projects/${p.id}`}>باز کردن پروژه <Icon name="left" size="sm" /></Link></div>
            </article>
          ))}
        </div>
      ) : <EmptyState icon="folder" title={filter === 'archived' ? 'پروژهٔ بایگانی‌شده‌ای نیست' : 'هنوز پروژه‌ای نساخته‌ای'} text="پروژه هدف، کارها و منابع مرتبط را در چهار بخش ورودی‌ها، فرایند، خروجی‌ها و بازخورد کنار هم نگه می‌دارد." action={writer && filter !== 'archived' ? <button className="btn primary" onClick={() => setOpen(true)}>ساخت اولین پروژه</button> : undefined} />}
      {open ? <NewProjectModal open onClose={() => setOpen(false)} /> : null}
    </>
  );
}
