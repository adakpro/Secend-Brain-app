import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, uid, ApiError } from '../lib/api';
import { num, relative, dateTime, kindMeta, runStatus } from '../lib/format';
import { PageHeader, Card, Field, Notice, LoadingState, ErrorState, EmptyState, Icon, Chip, ConfirmDialog, toast, errText } from '../components/ui';
import { useWorkspace, canEdit } from '../session';
import '../styles/pages-work.css';

const TEMPLATES: [string, string, string][] = [['report', 'file', 'گزارش پژوهشی'], ['decision', 'flag', 'سند تصمیم‌گیری'], ['article', 'note', 'طرح اولیهٔ مقاله']];
const AUTHOR: Record<string, string> = { template: 'قالب مستند، بدون مدل', user: 'ویرایش تو', agent: 'تولید مدل' };
const TERMINAL = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_review'];

function BriefForm({ initialTemplate }: { initialTemplate: string }) {
  const [template, setTemplate] = useState(initialTemplate);
  const [title, setTitle] = useState(''); const [goal, setGoal] = useState(''); const [audience, setAudience] = useState('');
  const [language, setLanguage] = useState<'fa' | 'en'>('fa'); const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [selected, setSelected] = useState<string[]>([]); const [filter, setFilter] = useState(''); const [busy, setBusy] = useState(false);
  const docs = useQuery({ queryKey: ['documents', 'studio-pick'], queryFn: () => api('/documents?limit=200') });
  const nav = useNavigate(); const qc = useQueryClient();
  useEffect(() => setTemplate(initialTemplate), [initialTemplate]);
  const items: any[] = (docs.data?.items ?? []).filter((d: any) => !filter || d.title.includes(filter));
  const toggle = (id: string) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : s.length >= 40 ? s : [...s, id]));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api<{ id: string }>('/outputs', { json: { title, template, goal, audience, language, length, documentIds: selected } });
      qc.invalidateQueries({ queryKey: ['outputs'] }); toast('پیش‌نویس قالبی ساخته شد.'); nav(`/studio/${r.id}`);
    } catch (err) { toast(errText(err), 'error'); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      <div className="template-grid" role="radiogroup" aria-label="نوع خروجی">
        {TEMPLATES.map(([id, ic, t]) => <button type="button" key={id} role="radio" aria-checked={template === id} className={`template ${template === id ? 'active' : ''}`} onClick={() => setTemplate(id)}><Icon name={ic} /><span>{t}</span></button>)}
      </div>
      <Field label="عنوان" id="o-title"><input id="o-title" className="field" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required placeholder="مثلاً: تصمیم‌های طراحی تجربهٔ ورود" dir="auto" /></Field>
      <Field label="هدف" id="o-goal"><input id="o-goal" className="field" value={goal} onChange={e => setGoal(e.target.value)} maxLength={1000} dir="auto" /></Field>
      <div className="settings-profile">
        <Field label="مخاطب" id="o-aud"><input id="o-aud" className="field" value={audience} onChange={e => setAudience(e.target.value)} maxLength={200} dir="auto" /></Field>
        <Field label="زبان" id="o-lang"><select id="o-lang" className="field" value={language} onChange={e => setLanguage(e.target.value as 'fa')}><option value="fa">فارسی</option><option value="en">English</option></select></Field>
        <Field label="طول تقریبی" id="o-len"><select id="o-len" className="field" value={length} onChange={e => setLength(e.target.value as 'short')}><option value="short">کوتاه</option><option value="medium">متوسط</option><option value="long">بلند</option></select></Field>
      </div>
      <label className="field-label">منابع مجاز ({num(selected.length)} انتخاب‌شده)</label>
      <input className="field filter-input" style={{ maxWidth: 'none', marginBottom: 8 }} value={filter} onChange={e => setFilter(e.target.value)} placeholder="فیلتر عنوان…" aria-label="فیلتر صفحات" />
      <div className="source-checkboxes">
        {docs.isPending ? <p className="muted" style={{ fontSize: 11 }}>در حال بارگذاری…</p> : items.length ? items.map(d => (
          <label key={d.id} className="check-row"><input type="checkbox" checked={selected.includes(d.id)} onChange={() => toggle(d.id)} /><span dir="auto">{d.title}</span><span className="muted" style={{ fontSize: 10, marginInlineStart: 'auto' }}>{kindMeta[d.kind]?.label ?? d.kind}</span></label>))
          : <p className="muted" style={{ fontSize: 11 }}>صفحه‌ای در کتابخانه نیست؛ ابتدا منبعی وارد و تأیید کن.</p>}
      </div>
      <p className="field-help">ساخت پیش‌نویس اول بدون مدل است: سرفصل‌های قالب و گزیدهٔ منابع انتخاب‌شده. تولید متن با مدل در گام بعد و با اجازهٔ تو انجام می‌شود.</p>
      <button className="btn primary" style={{ width: '100%', marginTop: 12 }} disabled={busy || !title.trim() || !selected.length}><Icon name="file" size="sm" /> ساخت قالب مستند</button>
    </form>
  );
}

function OutputView({ id }: { id: string }) {
  const ws = useWorkspace(); const writer = canEdit(ws?.role ?? 'viewer'); const qc = useQueryClient(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['output', id], queryFn: () => api(`/outputs/${id}`) });
  const [text, setText] = useState(''); const [base, setBase] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null); const [genError, setGenError] = useState(''); const [del, setDel] = useState(false);
  useEffect(() => { if (q.data && q.data.output.current_version !== base) { setText(q.data.current?.content ?? ''); setBase(q.data.output.current_version); } }, [q.data, base]);
  useEffect(() => { if (q.data?.lastRun && ['queued', 'running', 'cancel_requested'].includes(q.data.lastRun.status)) setRunId(q.data.lastRun.id); }, [q.data?.lastRun]);
  const run = useQuery({ queryKey: ['run', runId], enabled: !!runId, queryFn: () => api(`/runs/${runId}`), refetchInterval: d => (d.state.data && TERMINAL.includes(d.state.data.run.status) ? false : 2000) });
  useEffect(() => {
    const st = run.data?.run.status;
    if (st && TERMINAL.includes(st)) { qc.invalidateQueries({ queryKey: ['output', id] }); if (st === 'failed') setGenError(run.data.run.error_message ?? 'تولید ناموفق بود.'); setRunId(null); }
  }, [run.data, id, qc]);
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { output: o, versions, current, citations } = q.data;
  const dirty = (current?.content ?? '') !== text;
  const save = async () => {
    try { await api(`/outputs/${id}/versions`, { json: { content: text } }); toast('نسخهٔ جدید ذخیره شد.'); setBase(null); qc.invalidateQueries({ queryKey: ['output', id] }); } catch (err) { toast(errText(err), 'error'); }
  };
  const generate = async () => {
    setGenError('');
    try { const r = await api<{ runId: string }>(`/outputs/${id}/generate`, { json: { idempotencyKey: uid() } }); setRunId(r.runId); toast('تولید در صف قرار گرفت.'); }
    catch (err) { if (err instanceof ApiError && err.status === 409) setGenError(err.message); else toast(errText(err), 'error'); }
  };
  const busy = !!runId;
  return (
    <>
      <PageHeader title={o.title} description={`${TEMPLATES.find(t => t[0] === o.template)?.[2] ?? o.template} · نسخهٔ ${num(o.current_version)} · ${relative(o.updated_at)}`} action={<Link className="btn" to="/studio"><Icon name="arrow" size="sm" /> همهٔ خروجی‌ها</Link>} />
      {genError ? <Notice kind="warning">{genError}</Notice> : null}
      {busy ? <Notice>در حال تولید با مدل ({runStatus[run.data?.run.status ?? 'queued']?.label ?? '…'})؛ نسخهٔ جدید پس از پایان اضافه می‌شود و متن فعلی تو بازنویسی نمی‌شود.</Notice> : null}
      <div className="studio-layout">
        <div className="stack">
          <Card title="نسخه‌ها">
            {versions.map((v: any) => (
              <div key={v.id} className={`pw-version ${v.version === o.current_version ? 'current' : ''}`}>
                <span>نسخهٔ {num(v.version)}</span><Chip color={v.author_kind === 'agent' ? 'purple' : v.author_kind === 'user' ? 'blue' : ''}>{AUTHOR[v.author_kind] ?? v.author_kind}</Chip>
                <span className="muted" style={{ marginInlineStart: 'auto' }}>{dateTime(v.created_at)}</span>
                {writer && v.version !== o.current_version ? <button className="btn small" onClick={async () => { try { await api(`/outputs/${id}/restore/${v.version}`, { json: {} }); setBase(null); qc.invalidateQueries({ queryKey: ['output', id] }); } catch (err) { toast(errText(err), 'error'); } }}>بازگرداندن</button> : null}
              </div>))}
          </Card>
          <Card title={`ارجاع‌های نسخهٔ فعلی (${num(citations.length)})`}>
            {citations.length ? <div className="cite-list">{citations.map((c: any) => (
              <div key={c.id} className={`cite-item ${c.validation?.valid ? '' : 'invalid'}`}>
                <strong>[{c.citation_key}]</strong> {c.document_id ? <Link to={`/library/${c.document_id}`}>{c.title}</Link> : c.title}{c.heading ? ` § ${c.heading}` : ''}
                <div className="muted" dir="auto">«{String(c.excerpt).slice(0, 200)}»</div>
                {!c.validation?.valid ? <small style={{ color: 'var(--red)' }}>ارجاع نامعتبر: {(c.validation?.reasons ?? []).join('، ')}</small> : null}
              </div>))}</div> : <p className="muted" style={{ fontSize: 11 }}>این نسخه ارجاع ثبت‌شده‌ای ندارد{current?.author_kind === 'template' ? '؛ پیش‌نویس قالبی فقط فهرست منابع را دارد.' : '.'}</p>}
            <p className="field-help">اعتبار ارجاع یعنی کلید و نقل‌قول در همان بخش منبع پیدا شده؛ به معنی درستی معنایی متن نیست.</p>
          </Card>
          {writer ? <Card title="تولید با مدل">
            <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>فقط صفحات انتخاب‌شده در brief به مدل داده می‌شود. خروجی یک نسخهٔ جدید است و چیزی در vault تغییر نمی‌کند.</p>
            <button className="btn soft" disabled={busy} onClick={generate}><Icon name="spark" size="sm" /> {busy ? 'در حال تولید…' : 'تولید با مدل'}</button>
          </Card> : null}
        </div>
        <section className="card page-card">
          <div className="between" style={{ marginBottom: 14 }}><h2>پیش‌نویس</h2><div className="row"><Chip>Markdown</Chip>{dirty ? <span className="row" style={{ fontSize: 10 }}><span className="dirty-dot" />ذخیره‌نشده</span> : null}</div></div>
          <textarea className="field studio-editor" value={text} onChange={e => setText(e.target.value)} readOnly={!writer} aria-label="ویرایش پیش‌نویس خروجی" maxLength={500000} dir="auto" />
          <div className="between" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            {writer ? <button className="btn primary small" disabled={!dirty} onClick={save}>ذخیره به‌عنوان نسخهٔ جدید</button> : <span />}
            <div className="row-wrap">
              <button className="btn small" disabled={dirty} title={dirty ? 'ابتدا ذخیره کن' : undefined} onClick={() => download(`/outputs/${id}/export?format=md`)}><Icon name="download" size="sm" /> Markdown</button>
              <button className="btn small" disabled={dirty} onClick={() => download(`/outputs/${id}/export?format=html`)}><Icon name="download" size="sm" /> HTML</button>
              <button className="btn small" disabled title="renderer فارسی/RTL برای PDF و DOCX نصب و آزمایش نشده است">PDF / DOCX — فعال نیست</button>
              {writer ? <button className="icon-btn" onClick={() => setDel(true)} aria-label="حذف خروجی"><Icon name="trash" size="sm" /></button> : null}
            </div>
          </div>
        </section>
      </div>
      <ConfirmDialog open={del} danger title="حذف خروجی" text="این خروجی و نسخه‌هایش از فهرست حذف می‌شوند." confirmLabel="حذف" onClose={() => setDel(false)} onConfirm={async () => {
        try { await api(`/outputs/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['outputs'] }); nav('/studio'); } catch (err) { toast(errText(err), 'error'); }
      }} />
    </>
  );
}

export default function StudioPage() {
  const { id } = useParams(); const [params] = useSearchParams();
  const ws = useWorkspace(); const writer = canEdit(ws?.role ?? 'viewer');
  const list = useQuery({ queryKey: ['outputs'], queryFn: () => api('/outputs'), enabled: !id });
  if (id) return <OutputView id={id} />;
  const tpl = TEMPLATES.some(t => t[0] === params.get('template')) ? params.get('template')! : 'report';
  return (
    <>
      <PageHeader title="استودیوی خروجی" description="از یادداشت‌هایت، یک خروجی قابل استفاده بساز." />
      <Notice>هر خروجی منابع و نسخه‌های استفاده‌شده را نگه می‌دارد. نوشتن در خروجی چیزی را در vault تغییر نمی‌دهد و انتشار بیرونی ندارد.</Notice>
      <div className="studio-layout">
        <section className="card page-card">
          <h2 style={{ marginBottom: 17 }}>خروجی‌های قبلی</h2>
          {list.isPending ? <LoadingState /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : list.data.items.length ? (
            <div className="pw-studio-list">{list.data.items.map((o: any) => (
              <Link key={o.id} className="list-row" to={`/studio/${o.id}`}><Icon name={TEMPLATES.find(t => t[0] === o.template)?.[1] ?? 'file'} /><span className="grow truncate" dir="auto">{o.title}</span><span className="muted" style={{ fontSize: 10 }}>نسخهٔ {num(o.current_version)} · {relative(o.updated_at)}</span></Link>))}</div>
          ) : <EmptyState icon="box" title="هنوز خروجی‌ای نساخته‌ای" text="یک قالب و چند صفحه از کتابخانه انتخاب کن." />}
        </section>
        <section className="card page-card">
          <h2 style={{ marginBottom: 17 }}>خروجی جدید</h2>
          {writer ? <BriefForm initialTemplate={tpl} /> : <p className="muted" style={{ fontSize: 12 }}>نقش شما اجازهٔ ساخت خروجی ندارد.</p>}
        </section>
      </div>
    </>
  );
}
