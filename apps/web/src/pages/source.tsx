import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, uid } from '../lib/api';
import { dateTime, relative, sourceStatus, runStatus, csStatus, bytes, num } from '../lib/format';
import { Card, Chip, ConfirmDialog, ErrorState, Icon, LoadingState, Modal, Notice, StatusBadge, toast, errText } from '../components/ui';
import { useStepUp } from '../components/content';
import { useMe, useWorkspace, canEdit } from '../session';
import { useRunStream, TOOL_LABEL } from '../lib/run-stream';
import { useNativeStatus, useClaudeJob } from '../components/claude-task';

export default function SourcePage() {
  const { id } = useParams(); const me = useMe(); const ws = useWorkspace(); const qc = useQueryClient(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['source', id], queryFn: () => api(`/sources/${id}`), refetchInterval: d => (['queued', 'extracting', 'analyzing'].includes(d.state.data?.source?.status) ? 2000 : false) });
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api('/system/status') });
  const [replace, setReplace] = useState(false); const [repText, setRepText] = useState('');
  const [purge, setPurge] = useState(false);
  const native = useNativeStatus();
  const claude = useClaudeJob();
  const activeRun = q.data?.runs?.find((r: any) => ['queued', 'running', 'cancel_requested'].includes(r.status));
  const stream = useRunStream(activeRun?.id, () => { qc.invalidateQueries({ queryKey: ['source', id] }); qc.invalidateQueries({ queryKey: ['overview'] }); });
  const step = useStepUp(me.user.totpEnabled);
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { source: s, versions, runs, changesets, pages, duplicateOf } = q.data;
  const cur = versions.find((v: any) => v.id === s.current_version_id) ?? versions[0];
  const writer = canEdit(ws.role);
  const modelOk = status.data?.capabilities?.modelFeatures;
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); qc.invalidateQueries({ queryKey: ['source', id] }); qc.invalidateQueries({ queryKey: ['sources'] }); } catch (e) { toast(errText(e), 'error'); } };
  return (
    <>
      <div className="section-title">
        <div><Link className="text-link" to="/inbox"><Icon name="arrow" size="sm" /> ورودی‌ها</Link><h1 dir="auto">{s.title}</h1><p>{s.kind} · ثبت {relative(s.created_at)}{s.origin_url ? <> · <a className="ltr" href={s.origin_url} target="_blank" rel="noopener noreferrer nofollow">{s.origin_url.slice(0, 70)}</a></> : null}</p></div>
        <StatusBadge map={sourceStatus} value={s.status} />
      </div>
      {s.status_detail ? <Notice kind={s.status.includes('failed') || s.status === 'needs_ocr' ? 'warning' : 'info'}>{s.status_detail}</Notice> : null}
      {duplicateOf ? <Notice>محتوای این منبع دقیقاً با <Link to={`/inbox/${duplicateOf.id}`}>«{duplicateOf.title}»</Link> یکی است (hash یا نشانی کانونی یکسان). چیزی خودکار حذف یا ادغام نشد.</Notice> : null}
      {s.sensitivity === 'no_external' ? <Notice kind="warning">این منبع «عدم ارسال بیرونی» دارد؛ در هیچ اجرای مدل یا جست‌وجوی مدل استفاده نمی‌شود.</Notice> : null}
      <div className="row-wrap" style={{ marginBottom: 16 }}>
        {writer && ['ready_for_analysis', 'analysis_failed', 'canceled', 'applied', 'awaiting_review'].includes(s.status) && s.sensitivity !== 'no_external'
          ? <button className="btn primary" disabled={!modelOk} title={modelOk ? '' : status.data?.capabilities?.modelFeaturesReason} onClick={() => act(() => api(`/sources/${id}/analyze`, { json: { idempotencyKey: uid() } }), 'تحلیل در صف قرار گرفت.')}><Icon name="spark" size="sm" />{s.status === 'applied' || s.status === 'awaiting_review' ? 'تحلیل دوباره' : 'تحلیل و ساخت پیشنهاد'}</button> : null}
        {writer && status.data && !modelOk && s.sensitivity !== 'no_external' ? (native.data?.loggedIn
          ? <button className="btn primary" disabled={!['ready_for_analysis', 'analysis_failed', 'canceled', 'applied', 'awaiting_review'].includes(s.status)} onClick={() => act(() => claude.start({ kind: 'ingest', sourceId: id }), 'Claude در پس‌زمینه شروع به تحلیل کرد؛ پیشرفت همین‌جا نمایش داده می‌شود.')}><Icon name="spark" size="sm" />تحلیل با Claude</button>
          : <Link className="btn" to="/settings/integrations/claude#native"><Icon name="monitor" size="sm" />اتصال Claude (اشتراک) برای تحلیل</Link>) : null}
        {activeRun && writer ? <button className="btn" onClick={() => act(() => api(`/runs/${activeRun.id}/cancel`, { json: {} }), 'درخواست لغو ثبت شد؛ هزینهٔ درخواست‌های ارسال‌شده صفر نمی‌شود.')}>لغو اجرا</button> : null}
        {writer && ['extraction_failed', 'needs_ocr', 'canceled'].includes(s.status) ? <button className="btn" onClick={() => act(() => api(`/sources/${id}/retry-extract`, { json: {} }), 'استخراج دوباره در صف است.')}><Icon name="refresh" size="sm" />استخراج دوباره</button> : null}
        {writer ? <button className="btn" onClick={() => setReplace(true)}><Icon name="edit" size="sm" />متن جایگزین</button> : null}
        <button className="btn" onClick={() => download(`/sources/${id}/raw`)}><Icon name="download" size="sm" />دریافت فایل اصلی</button>
        {ws.role === 'owner' || ws.role === 'admin' ? <button className="btn danger" onClick={() => setPurge(true)}><Icon name="trash" size="sm" />حذف آگاهانه</button> : null}
      </div>
      {activeRun ? (
        <Card title={<>{activeRun.model === 'claude-code-subscription' ? 'Claude (اشتراک) در حال کار' : 'اجرای فعال'} · <StatusBadge map={runStatus} value={stream.status ?? activeRun.status} /></>}>
          <div className="activity-list">{stream.events.filter(e => ['tool', 'proposal', 'proposal_rejected', 'progress', 'started'].includes(e.type)).map(e => (
            <div key={e.id} className="activity-item"><span className={`icon-tile ${e.type === 'proposal' ? 'green' : e.type === 'proposal_rejected' ? 'red' : 'blue'}`}><Icon name={e.type === 'proposal' ? 'check' : e.type === 'tool' ? 'search' : 'info'} size="sm" /></span>
              <div className="activity-content"><h3>{e.type === 'tool' ? TOOL_LABEL[e.data.name] ?? e.data.name : e.type === 'proposal' ? `پیشنهاد ${e.data.op === 'create' ? 'ایجاد' : 'ویرایش'}` : e.type === 'proposal_rejected' ? 'پیشنهاد رد شد (قواعد سرور)' : e.type === 'started' ? `شروع با ${e.data.model}` : 'پیشرفت'}</h3><p dir="auto">{e.data.summary ?? e.data.path ?? e.data.reason ?? e.data.message ?? ''}</p></div></div>))}
            {!stream.events.length ? <p className="muted" style={{ fontSize: 11 }}>در انتظار شروع اجرا…</p> : null}
          </div>
        </Card>) : null}
      <div className="grid-2" style={{ marginTop: 14 }}>
        <Card title="نسخهٔ جاری و کیفیت استخراج">
          {cur ? <dl className="kv">
            <dt>نسخه</dt><dd>{num(cur.version)}{cur.derived_from ? ' (متن جایگزین)' : ''}</dd>
            <dt>کیفیت</dt><dd><Chip color={cur.quality === 'ok' ? 'green' : cur.quality === 'partial' ? 'orange' : 'red'}>{cur.quality}</Chip></dd>
            <dt>استخراج‌کننده</dt><dd className="mono">{cur.extractor ?? '—'} v{cur.extractor_version ?? '-'}</dd>
            <dt>پوشش</dt><dd>{cur.coverage?.unit ? `${num(cur.coverage.readUnits ?? 0)} از ${num(cur.coverage.totalUnits ?? 0)} ${cur.coverage.unit === 'pages' ? 'صفحه' : cur.coverage.unit === 'messages' ? 'پیام' : 'نویسه'}` : '—'}{(cur.coverage?.notes ?? []).length ? ` — ${cur.coverage.notes.join('; ')}` : ''}</dd>
            <dt>اندازه</dt><dd>{bytes(cur.byte_size)} · {cur.mime}</dd>
            <dt>SHA-256</dt><dd className="mono" title={cur.sha256}>{cur.sha256.slice(0, 20)}…</dd>
          </dl> : <p className="muted">هنوز نسخه‌ای استخراج نشده.</p>}
        </Card>
        <Card title="نتیجه در دانش">
          {changesets.length ? changesets.map((c: any) => <div key={c.id} className="list-row"><Icon name="review" /><div className="grow"><Link to={`/review/${c.id}`}>{c.title}</Link><div className="muted" style={{ fontSize: 10 }}>{dateTime(c.created_at)}</div></div><StatusBadge map={csStatus} value={c.status} /></div>) : <p className="muted" style={{ fontSize: 11 }}>هنوز بستهٔ پیشنهادی ساخته نشده.</p>}
          {pages.length ? <><h3 style={{ margin: '12px 0 6px', fontSize: 12 }}>صفحات اعمال‌شده</h3>{pages.map((p: any) => <div key={p.id}><Link to={`/library/${p.id}`}>{p.title}</Link> <span className="mono muted">{p.path}</span></div>)}</> : null}
        </Card>
      </div>
      <Card title="پیش‌نمایش متن استخراج‌شده" className="" >
        {cur?.preview ? <><pre className="preview-box" style={{ maxHeight: 360 }} dir="auto">{cur.preview}</pre>{cur.text_length > 6000 ? <p className="field-help">فقط {num(6000)} نویسهٔ نخست از {num(cur.text_length)} نمایش داده شده است.</p> : null}</> : <p className="muted" style={{ fontSize: 11 }}>متنی برای نمایش نیست.</p>}
      </Card>
      <Card title="تاریخچهٔ پردازش">
        <div className="table-wrap"><table className="data-table"><thead><tr><th>زمان</th><th>وضعیت</th><th>ارائه‌دهنده</th><th>مصرف</th><th>خطا</th></tr></thead><tbody>
          {runs.map((r: any) => <tr key={r.id}><td>{dateTime(r.created_at)}</td><td><StatusBadge map={runStatus} value={r.status} /></td><td>{r.provider === 'mock' ? <Chip color="orange">آزمایشی mock</Chip> : r.provider ?? '—'}</td><td className="mono">{r.usage?.input_tokens ? `${num(r.usage.input_tokens)} in / ${num(r.usage.output_tokens)} out` : '—'}</td><td dir="auto">{r.error_message ?? ''}</td></tr>)}
          {!runs.length ? <tr><td colSpan={5} className="muted">هنوز اجرایی نبوده است.</td></tr> : null}
        </tbody></table></div>
      </Card>
      <Modal open={replace} title="متن جایگزین (نسخهٔ مشتق)" onClose={() => setReplace(false)}>
        <p className="muted" style={{ fontSize: 12 }}>متن جایگزین یک نسخهٔ جدید می‌سازد؛ فایل اصلی دست‌نخورده می‌ماند. برای PDF اسکن‌شده که OCR ندارد مفید است.</p>
        <textarea className="field" style={{ minHeight: 240 }} value={repText} onChange={e => setRepText(e.target.value)} dir="auto" />
        <div className="dialog-actions"><button className="btn" onClick={() => setReplace(false)}>انصراف</button><button className="btn primary" disabled={!repText.trim()} onClick={() => act(async () => { await api(`/sources/${id}/replacement-text`, { json: { text: repText } }); setReplace(false); setRepText(''); }, 'نسخهٔ جدید ثبت و نمایه شد.')}>ثبت نسخه</button></div>
      </Modal>
      <ConfirmDialog open={purge} title="حذف آگاهانهٔ منبع" danger confirmLabel="حذف دائمی" onClose={() => setPurge(false)} text={<p>فایل اصلی و متن استخراج‌شدهٔ این منبع حذف می‌شوند و فقط یک رکورد audit بدون محتوا باقی می‌ماند. صفحات ویکی ساخته‌شده از آن حذف نمی‌شوند. این عمل برگشت‌پذیر نیست و تأیید هویت دوباره لازم دارد.</p>}
        onConfirm={() => step.run(async () => { await api(`/sources/${id}`, { method: 'DELETE' }); setPurge(false); toast('منبع حذف شد.'); qc.invalidateQueries({ queryKey: ['sources'] }); nav('/inbox'); })} />
      {claude.dialog}
      {step.dialog}
    </>
  );
}
