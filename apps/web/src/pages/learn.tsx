import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { num, relative, date } from '../lib/format';
import { Icon, Chip, PageHeader, Notice, ErrorState, LoadingState, EmptyState, Card, toast, errText } from '../components/ui';
import { useWorkspace, canEdit } from '../session';
import '../styles/pages-knowledge.css';

const TERMINAL = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_review'];

function Generator({ onDone }: { onDone: () => void }) {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [count, setCount] = useState(5);
  const [runId, setRunId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'warning' | 'danger' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const docs = useQuery({ queryKey: ['documents', 'learn-pick'], queryFn: () => api('/documents?limit=200') });
  const run = useQuery({
    queryKey: ['run', runId], enabled: !!runId, queryFn: () => api(`/runs/${runId}`),
    refetchInterval: q => (q.state.data && TERMINAL.includes(q.state.data.run.status) ? false : 2000),
  });
  const status = run.data?.run?.status;
  useEffect(() => {
    if (!status || !TERMINAL.includes(status)) return;
    const r = run.data.run;
    if (status === 'succeeded') { setNotice({ kind: 'info', text: `${num(r.result?.kept ?? 0)} سؤال مستند ساخته شد${r.result?.dropped?.length ? `؛ ${num(r.result.dropped.length)} سؤال به دلیل ارجاع نامعتبر کنار گذاشته شد` : ''}.` }); onDone(); }
    else setNotice({ kind: 'danger', text: r.error_message ?? 'ساخت آزمون ناموفق بود.' });
    setRunId(null);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const list: any[] = (docs.data?.items ?? []).filter((d: any) => ['source', 'concept', 'entity', 'synthesis', 'note'].includes(d.kind));
  const shown = filter.trim() ? list.filter(d => d.title.includes(filter.trim())) : list;
  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : p.length >= 20 ? p : [...p, id]));
  const generate = async () => {
    setBusy(true); setNotice(null);
    try { const r = await api<{ runId: string }>('/learning/generate', { json: { documentIds: picked, count } }); setRunId(r.runId); }
    catch (e) { if (e instanceof ApiError && e.code === 'model_not_connected') setNotice({ kind: 'warning', text: e.message }); else toast(errText(e), 'error'); }
    finally { setBusy(false); }
  };
  const running = !!runId;
  return (
    <Card title="ساخت آزمون از صفحه‌های انتخابی">
      <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>سؤال‌ها از متن واقعی صفحه‌ها ساخته می‌شوند و هر کدام به یک بخش و نسخهٔ مشخص ارجاع دارند. سؤالی که ارجاعش در متن پیدا نشود ذخیره نمی‌شود.</p>
      <input className="field" type="search" placeholder="جست‌وجوی عنوان…" aria-label="جست‌وجوی صفحه" value={filter} onChange={e => setFilter(e.target.value)} dir="auto" />
      {docs.isPending ? <p className="muted" style={{ fontSize: 11 }}>در حال بارگذاری…</p> : docs.error ? <ErrorState error={docs.error} /> : (
        <div className="learn-pick source-checkboxes" role="group" aria-label="انتخاب صفحه‌ها">
          {shown.map(d => <label key={d.id} className="check-row"><input type="checkbox" checked={picked.includes(d.id)} onChange={() => toggle(d.id)} /><span>{d.title}</span></label>)}
          {!shown.length ? <span className="muted" style={{ fontSize: 11 }}>صفحه‌ای پیدا نشد.</span> : null}
        </div>
      )}
      <div className="between" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 11 }}>{num(picked.length)} از ۲۰ صفحه انتخاب شد</span>
        <div className="row">
          <label className="check-row">تعداد سؤال<select className="field" style={{ width: 'auto', padding: '3px 8px' }} value={count} onChange={e => setCount(Number(e.target.value))} aria-label="تعداد سؤال">{[3, 5, 8, 10].map(n => <option key={n} value={n}>{num(n)}</option>)}</select></label>
          <button className="btn primary" disabled={!picked.length || busy || running} onClick={generate}><Icon name="spark" size="sm" />{running ? 'در حال ساخت…' : 'ساخت آزمون'}</button>
        </div>
      </div>
      {running ? <p className="muted" role="status" style={{ fontSize: 11, marginTop: 10 }}>وضعیت اجرا: {status ?? 'در صف'} — نتیجه پس از پایان اجرا نمایش داده می‌شود.</p> : null}
      {notice ? <div style={{ marginTop: 12 }}><Notice kind={notice.kind}>{notice.text}</Notice></div> : null}
    </Card>
  );
}

function QuizCard({ items, onAnswered }: { items: any[]; onAnswered: () => void }) {
  const [idx, setIdx] = useState(0);
  const [choice, setChoice] = useState<number | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const item = items[idx % items.length];
  const check = async () => {
    if (choice === null) return;
    setBusy(true);
    try { setResult(await api(`/learning/items/${item.id}/attempt`, { json: { chosen: choice } })); onAnswered(); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const next = () => { setIdx(i => i + 1); setChoice(null); setResult(null); };
  return (
    <section className="card quiz-card" aria-live="polite">
      <div className="between"><span className="chip purple">مرور فعال</span><span className="muted" style={{ fontSize: 11 }}>سؤال {num((idx % items.length) + 1)} از {num(items.length)}</span></div>
      <h2 dir="auto">{item.question}</h2>
      <fieldset className="quiz-options" style={{ border: 0, padding: 0, margin: '0 0 20px' }}>
        <legend className="sr-only">گزینه‌ها</legend>
        {(item.choices as string[]).map((c, i) => (
          <label key={i} className="quiz-option" style={result ? { borderColor: i === result.answerIndex ? 'var(--green)' : i === choice ? 'var(--orange)' : undefined } : undefined}>
            <input type="radio" name={`q-${item.id}`} value={i} checked={choice === i} disabled={!!result} onChange={() => setChoice(i)} /><span dir="auto">{c}</span>
          </label>
        ))}
      </fieldset>
      {result ? (
        <div className={`quiz-feedback ${result.correct ? '' : 'wrong'}`}>
          <strong>{result.correct ? 'درست بود.' : 'پاسخ درست با رنگ سبز مشخص شده است.'}</strong>
          <p dir="auto">{result.explanation}</p>
          {result.excerpt ? <blockquote className="quiz-excerpt" dir="auto">«{String(result.excerpt).slice(0, 400)}»</blockquote> : null}
          {result.document ? <Link className="text-link" style={{ color: 'var(--blue)' }} to={`/library/${result.document.id}`}>صفحهٔ مرجع: {result.document.title} <Icon name="left" size="sm" /></Link> : null}
          {result.document?.stale ? <div style={{ marginTop: 8 }}><Chip color="orange">منبع از زمان ساخت سؤال تغییر کرده</Chip></div> : null}
          <p className="muted" style={{ fontSize: 10, marginTop: 8 }}>مرور بعدی: {num(result.nextReviewInDays)} روز دیگر</p>
        </div>
      ) : null}
      <div className="between">
        <span className="muted" style={{ fontSize: 10 }}>سؤال و توضیح را مدل ساخته است؛ کمک‌آموزشی است و جای خواندن صفحهٔ مرجع را نمی‌گیرد.</span>
        {result ? <button className="btn primary" onClick={next}>سؤال بعدی <Icon name="left" size="sm" /></button> : <button className="btn primary" disabled={choice === null || busy} onClick={check}>بررسی پاسخ</button>}
      </div>
    </section>
  );
}

export default function LearnPage() {
  const ws = useWorkspace(); const qc = useQueryClient();
  const writer = canEdit(ws?.role ?? 'viewer');
  const q = useQuery({ queryKey: ['learning-items'], queryFn: () => api('/learning/items') });
  const items: any[] = q.data?.items ?? [];
  const active = useMemo(() => {
    const now = Date.now();
    const a = items.filter(i => i.status === 'active');
    // Due first (never answered, or review date passed), then the rest.
    return [...a.filter(i => !i.last_attempt || Date.parse(i.last_attempt.next_review_at) <= now), ...a.filter(i => i.last_attempt && Date.parse(i.last_attempt.next_review_at) > now)];
  }, [items]);
  const stale = items.filter(i => i.status !== 'active');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['learning-items'] }); qc.invalidateQueries({ queryKey: ['overview'] }); };
  return (
    <>
      <PageHeader title="مرور و یادگیری" description="آنچه خوانده‌ای را به دانشی تبدیل کن که همراهت می‌ماند."
        action={<span className="chip purple">{num(q.data?.attempts ?? 0)} پاسخ ثبت‌شده</span>} />
      <div className="stack">
        {q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} />
          : active.length ? <QuizCard key={active.map(i => i.id).join(',')} items={active} onAnswered={refresh} />
          : <EmptyState icon="bookmark" title="هنوز سؤالی برای مرور نیست" text="سؤال‌ها فقط از صفحه‌های واقعی همین فضای دانش ساخته می‌شوند. چند صفحه انتخاب کن و آزمون بساز." />}
        {writer ? <Generator onDone={refresh} /> : null}
        {stale.length ? (
          <Card title={`سؤال‌های نیازمند بازبینی (${num(stale.length)})`}>
            <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>منبع از زمان ساخت سؤال تغییر کرده یا حذف شده است؛ این سؤال‌ها در مرور نمایش داده نمی‌شوند.</p>
            {stale.map(i => (
              <div key={i.id} className="list-row">
                <span className="grow"><span style={{ display: 'block', fontSize: 12 }} dir="auto">{i.question}</span><span className="muted" style={{ fontSize: 10 }}>{i.doc_title ?? 'صفحهٔ حذف‌شده'} · {date(i.created_at)}</span></span>
                {i.document_id && i.doc_title ? <Link className="text-link" to={`/library/${i.document_id}`}>صفحه</Link> : null}
              </div>
            ))}
          </Card>
        ) : null}
        {items.length ? (
          <Card title="تاریخچهٔ تمرین">
            {items.filter(i => i.last_attempt).slice(0, 15).map(i => (
              <div key={i.id} className="list-row">
                <span className={`daily-icon ${i.last_attempt.correct ? '' : 'orange'}`}><Icon name={i.last_attempt.correct ? 'check' : 'close'} /></span>
                <span className="grow" style={{ fontSize: 11 }} dir="auto">{i.question}</span>
                <span className="muted" style={{ fontSize: 10 }}>{relative(i.last_attempt.created_at)}</span>
              </div>
            ))}
            {!items.some(i => i.last_attempt) ? <p className="muted" style={{ fontSize: 11 }}>هنوز پاسخی ثبت نشده است.</p> : null}
          </Card>
        ) : null}
      </div>
    </>
  );
}
