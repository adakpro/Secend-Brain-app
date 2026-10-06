import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { num, relative, sourceStatus } from '../lib/format';
import { PageHeader, Card, Field, Progress, LoadingState, ErrorState, Icon, Notice, StatusBadge, ConfirmDialog, toast, errText } from '../components/ui';
import { useWorkspace, canEdit } from '../session';
import '../styles/pages-work.css';

const SECTIONS: [string, string, string][] = [
  ['inputs', 'ورودی‌ها', 'Inputs'], ['process', 'فرایند', 'Process'], ['outputs', 'خروجی‌ها', 'Outputs'], ['feedback', 'بازخورد', 'Feedback'],
];

function TaskSection({ projectId, section, label, en, tasks, writer, refresh }: { projectId: string; section: string; label: string; en: string; tasks: any[]; writer: boolean; refresh: () => void | Promise<unknown> }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  // Optimistic done-state so the checkbox responds immediately; reverted if the server refuses.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!text.trim()) return; setBusy(true);
    try { await api(`/projects/${projectId}/tasks`, { json: { text: text.trim(), section } }); setText(''); refresh(); } catch (err) { toast(errText(err), 'error'); } finally { setBusy(false); }
  };
  const toggle = async (t: any) => {
    const next = !(pending[t.id] ?? t.done);
    setPending(p => ({ ...p, [t.id]: next }));
    try { await api(`/projects/${projectId}/tasks/${t.id}`, { method: 'PATCH', json: { done: next } }); await refresh(); }
    catch (err) { toast(errText(err), 'error'); }
    finally { setPending(p => { const n = { ...p }; delete n[t.id]; return n; }); }
  };
  const isDone = (t: any) => pending[t.id] ?? t.done;
  const del = async (t: any) => { try { await api(`/projects/${projectId}/tasks/${t.id}`, { method: 'DELETE' }); refresh(); } catch (err) { toast(errText(err), 'error'); } };
  const done = tasks.filter(t => pending[t.id] ?? t.done).length;
  return (
    <section className="card pw-section">
      <div className="card-head"><h2>{label} <span className="muted ltr" style={{ fontSize: 10, fontWeight: 400 }}>{en}</span></h2><span className="muted" style={{ fontSize: 10 }}>{num(done)}/{num(tasks.length)}</span></div>
      <div className="card-body">
        {tasks.length ? tasks.map(t => (
          <div key={t.id} className={`task-row ${isDone(t) ? 'done' : ''}`}>
            <input type="checkbox" checked={isDone(t)} disabled={!writer} onChange={() => toggle(t)} aria-label={`انجام شد: ${t.text}`} />
            <span style={{ flex: 1 }} dir="auto">{t.text}</span>
            {writer ? <button className="icon-btn" onClick={() => del(t)} aria-label={`حذف ${t.text}`}><Icon name="trash" size="sm" /></button> : null}
          </div>)) : <p className="muted" style={{ fontSize: 11 }}>کاری در این بخش نیست.</p>}
        {writer ? <form className="row" onSubmit={add} style={{ marginTop: 10 }}>
          <input className="field" value={text} onChange={e => setText(e.target.value)} maxLength={300} placeholder="کار جدید…" aria-label={`کار جدید در ${label}`} dir="auto" />
          <button className="btn small" disabled={busy || !text.trim()}><Icon name="plus" size="sm" /></button>
        </form> : null}
      </div>
    </section>
  );
}

export default function ProjectPage() {
  const { id } = useParams(); const nav = useNavigate(); const qc = useQueryClient();
  const ws = useWorkspace(); const writer = canEdit(ws?.role ?? 'viewer');
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api(`/projects/${id}`) });
  const [goal, setGoal] = useState(''); const [description, setDescription] = useState(''); const [title, setTitle] = useState('');
  const [archive, setArchive] = useState(false);
  useEffect(() => { if (q.data) { setGoal(q.data.project.goal); setDescription(q.data.project.description); setTitle(q.data.project.title); } }, [q.data]);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['project', id] }), qc.invalidateQueries({ queryKey: ['projects'] }), qc.invalidateQueries({ queryKey: ['overview'] })]);
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { project: p, tasks, sources, outputs } = q.data;
  const dirty = goal !== p.goal || description !== p.description || title !== p.title;
  const save = async (patch: Record<string, unknown>) => {
    try { await api(`/projects/${id}`, { method: 'PATCH', json: patch }); toast('ذخیره شد.'); refresh(); } catch (err) { toast(errText(err), 'error'); }
  };
  return (
    <>
      <PageHeader title={p.title} description={p.goal || 'هدفی برای این پروژه ثبت نشده است.'} action={<div className="row-wrap">
        <Link className="btn" to="/projects"><Icon name="arrow" size="sm" /> همهٔ پروژه‌ها</Link>
        <button className="btn soft" onClick={() => nav(`/ask?project=${id}`)}><Icon name="chat" size="sm" /> پرسش در محدودهٔ این پروژه</button>
      </div>} />
      <div className="grid-2" style={{ marginBottom: 15 }}>
        <Card title="هدف و وضعیت">
          <Field label="عنوان" id="p-title"><input id="p-title" className="field" value={title} disabled={!writer} onChange={e => setTitle(e.target.value)} maxLength={200} dir="auto" /></Field>
          <Field label="هدف" id="p-goal"><input id="p-goal" className="field" value={goal} disabled={!writer} onChange={e => setGoal(e.target.value)} maxLength={1000} dir="auto" /></Field>
          <Field label="توضیح" id="p-desc"><textarea id="p-desc" className="field" value={description} disabled={!writer} onChange={e => setDescription(e.target.value)} maxLength={2000} dir="auto" style={{ minHeight: 90 }} /></Field>
          {writer ? <div className="row-wrap">
            <button className="btn primary small" disabled={!dirty || !title.trim()} onClick={() => save({ title, goal, description })}>ذخیرهٔ تغییرات</button>
            <label className="row" style={{ fontSize: 11 }}>وضعیت
              <select className="field" style={{ width: 'auto', padding: '4px 8px' }} value={p.status} onChange={e => save({ status: e.target.value })}>
                <option value="active">در جریان</option><option value="paused">متوقف</option><option value="done">تکمیل‌شده</option><option value="archived">بایگانی</option>
              </select></label>
            {p.status !== 'archived' && ['owner', 'admin'].includes(ws?.role ?? '') ? <button className="btn small danger" onClick={() => setArchive(true)}>بایگانی</button> : null}
          </div> : null}
        </Card>
        <Card title="پیشرفت">
          <div className="progress-label" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}><span className="muted">کارهای انجام‌شده</span><span>{p.tasksTotal ? `${num(p.progress)}٪ (${num(p.tasksDone)} از ${num(p.tasksTotal)})` : 'بدون کار تعریف‌شده'}</span></div>
          <Progress value={p.tasksTotal ? p.progress : 0} color={p.color === 'purple' ? 'purple' : ''} />
          <p className="field-help">درصد فقط از کارهای تعریف‌شده محاسبه می‌شود؛ پیشرفت معنایی پروژه به‌صورت خودکار اندازه‌گیری نمی‌شود.</p>
          <div style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 12, marginBottom: 8 }}>منابع پیوندی ({num(sources.length)})</h3>
            {sources.length ? sources.map((s: any) => <div key={s.id} className="list-row"><Icon name="file" size="sm" /><Link className="grow truncate" to={`/inbox/${s.id}`} dir="auto">{s.title}</Link><StatusBadge map={sourceStatus} value={s.status} /></div>)
              : <p className="muted" style={{ fontSize: 11 }}>هنوز منبعی به این پروژه وصل نشده؛ هنگام افزودن منبع، این پروژه را انتخاب کن.</p>}
          </div>
          <div style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 12, marginBottom: 8 }}>خروجی‌ها ({num(outputs.length)})</h3>
            {outputs.length ? outputs.map((o: any) => <div key={o.id} className="list-row"><Icon name="box" size="sm" /><Link className="grow truncate" to={`/studio/${o.id}`} dir="auto">{o.title}</Link><span className="muted" style={{ fontSize: 10 }}>نسخهٔ {num(o.current_version)} · {relative(o.updated_at)}</span></div>)
              : <p className="muted" style={{ fontSize: 11 }}>خروجی‌ای برای این پروژه ساخته نشده است.</p>}
          </div>
        </Card>
      </div>
      {p.status === 'archived' ? <Notice kind="warning">این پروژه بایگانی شده است؛ برای ادامهٔ کار وضعیت را به «در جریان» برگردان.</Notice> : null}
      <div className="pw-sections">
        {SECTIONS.map(([key, label, en]) => <TaskSection key={key} projectId={id!} section={key} label={label} en={en} tasks={tasks.filter((t: any) => t.section === key)} writer={writer} refresh={refresh} />)}
      </div>
      <ConfirmDialog open={archive} title="بایگانی پروژه" text="پروژه حذف نمی‌شود؛ فقط از فهرست فعال خارج می‌شود و همهٔ کارها و پیوندها باقی می‌مانند." confirmLabel="بایگانی" onClose={() => setArchive(false)} onConfirm={async () => {
        try { await api(`/projects/${id}`, { method: 'DELETE' }); setArchive(false); toast('پروژه بایگانی شد.'); refresh(); } catch (err) { toast(errText(err), 'error'); }
      }} />
    </>
  );
}
