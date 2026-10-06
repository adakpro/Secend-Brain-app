import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { num, relative, date, dateTime, runStatus, getPrefs } from '../lib/format';
import { PageHeader, Card, Field, Notice, LoadingState, ErrorState, EmptyState, Icon, Tile, Chip, StatusBadge, Tabs, ConfirmDialog, toast, errText } from '../components/ui';
import { useWorkspace, canEdit } from '../session';
import '../styles/pages-work.css';

type Tab = 'runs' | 'events' | 'health' | 'schedules' | 'skills';
const TABS: Tab[] = ['runs', 'events', 'health', 'schedules', 'skills'];
const SKILL_STATUS: Record<string, { label: string; color: string }> = {
  implemented: { label: 'پیاده‌شده (مدل)', color: 'green' }, deterministic: { label: 'کد قطعی، بدون مدل', color: 'blue' }, not_implemented: { label: 'پیاده نشده', color: '' },
};
const ACTION_ICON = (a: string) => (a.startsWith('changeset') ? 'review' : a.startsWith('source') ? 'import' : a.startsWith('auth') ? 'shield' : a.startsWith('run') ? 'spark' : a.startsWith('schedule') ? 'clock' : a.startsWith('integration') ? 'settings' : a.startsWith('vault') ? 'database' : 'activity');

function Runs() {
  const q = useQuery({ queryKey: ['activity'], queryFn: () => api('/activity'), refetchInterval: 5000 });
  const qc = useQueryClient(); const ws = useWorkspace(); const writer = canEdit(ws?.role ?? 'viewer');
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { runs, stats } = q.data;
  const act = async (id: string, what: 'cancel' | 'retry') => {
    try { const r = await api(`/runs/${id}/${what}`, { json: {} }); toast(what === 'cancel' ? (r.notice ?? 'درخواست لغو ثبت شد.') : 'اجرا دوباره در صف قرار گرفت.'); qc.invalidateQueries({ queryKey: ['activity'] }); } catch (err) { toast(errText(err), 'error'); }
  };
  return (
    <>
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))', marginBottom: 18 }}>
        {[{ l: 'اجرای فعال', v: stats.active_runs, c: 'purple', i: 'spark' }, { l: 'ناموفق در ۷ روز', v: stats.failed_7d, c: 'orange', i: 'info' }, { l: 'بستهٔ دارای تعارض', v: stats.conflicts, c: 'blue', i: 'review' }].map(s => (
          <div key={s.l} className="card stat-card" style={{ cursor: 'default' }}><span className={`icon-tile ${s.c}`}><Icon name={s.i} /></span><span className="stat-content"><span className="stat-label">{s.l}</span><span className="stat-value" style={{ display: 'block' }}>{num(s.v)}</span></span></div>))}
      </div>
      <Card title="مصرف ۳۰ روز اخیر (فقط اتصال API واقعی)">
        <dl className="kv">
          <dt>توکن ورودی</dt><dd>{num(stats.input_tokens_30d)}</dd>
          <dt>توکن خروجی</dt><dd>{num(stats.output_tokens_30d)}</dd>
          <dt>هزینه (تخمین)</dt><dd>{stats.cost_estimate_30d ? `${num(Number(stats.cost_estimate_30d).toFixed(4))} دلار — تخمین سمت SDK، نه صورتحساب قطعی` : 'دادهٔ معتبری نیست'}</dd>
          <dt>میانگین مدت اجرا</dt><dd>{stats.avg_run_s ? `${num(Math.round(stats.avg_run_s))} ثانیه` : '—'}</dd>
        </dl>
      </Card>
      <div className="card" style={{ marginTop: 15 }}><div className="card-head"><h2>اجراها</h2><span className="muted" style={{ fontSize: 10 }}>{num(runs.length)} مورد اخیر</span></div><div className="card-body">
        {runs.length ? <div className="table-wrap"><table className="data-table">
          <thead><tr><th>مهارت</th><th>وضعیت</th><th>ارائه‌دهنده</th><th>منبع</th><th>توکن</th><th>هزینه</th><th>زمان</th><th /></tr></thead>
          <tbody>{runs.map((r: any) => (
            <tr key={r.id}>
              <td><span className="mono">{r.skill_id}</span><div className="muted" style={{ fontSize: 10 }}>{r.kind}</div></td>
              <td><StatusBadge map={runStatus} value={r.status} />{r.error_message ? <div style={{ fontSize: 10, color: 'var(--red)', maxWidth: 260 }} dir="auto">{r.error_code}: {r.error_message}</div> : null}</td>
              <td>{r.provider === 'mock' ? <Chip color="orange">آزمایشی (mock)</Chip> : r.provider === 'anthropic' ? <Chip color="blue">Anthropic API</Chip> : <span className="muted">بدون مدل</span>}</td>
              <td>{r.source_title ?? '—'}</td>
              <td className="mono">{r.usage?.input_tokens || r.usage?.output_tokens ? `${num(r.usage.input_tokens ?? 0)} / ${num(r.usage.output_tokens ?? 0)}` : '—'}</td>
              <td>{r.cost_estimate_usd ? <span title="تخمین سمت SDK">{num(Number(r.cost_estimate_usd).toFixed(4))}$ (تخمین)</span> : '—'}</td>
              <td title={dateTime(r.created_at)}>{relative(r.created_at)}</td>
              <td>{writer && ['queued', 'running'].includes(r.status) ? <button className="btn small" onClick={() => act(r.id, 'cancel')}>لغو</button> : writer && ['failed', 'interrupted'].includes(r.status) ? <button className="btn small" onClick={() => act(r.id, 'retry')}>تکرار</button> : null}</td>
            </tr>))}</tbody>
        </table></div> : <EmptyState icon="spark" title="هنوز اجرایی نیست" text="پردازش منبع، پرسش مستند، خروجی و آزمون‌ها اینجا ثبت می‌شوند." />}
      </div></div>
    </>
  );
}

function Events() {
  const q = useQuery({ queryKey: ['activity'], queryFn: () => api('/activity') });
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const events: any[] = q.data.events;
  return (
    <div className="card"><div className="card-head"><h2>تاریخچهٔ رویدادها</h2><span className="muted" style={{ fontSize: 10 }}>{num(events.length)} رویداد</span></div>
      <div className="card-body activity-list">{events.length ? events.map(e => (
        <div key={e.id} className="activity-item"><Tile icon={ACTION_ICON(e.action)} color={e.result === 'success' ? 'green' : e.result === 'denied' ? 'orange' : 'red'} mini />
          <div className="activity-content"><h3><span className="mono">{e.action}</span> {e.result !== 'success' ? <Chip color="orange">{e.result}</Chip> : null}</h3><p>{e.display_name ?? 'سیستم'}{e.target_type ? ` · ${e.target_type}` : ''}</p></div>
          <span className="activity-time" title={dateTime(e.created_at)}>{relative(e.created_at)}</span></div>))
        : <p className="muted" style={{ fontSize: 11 }}>رویدادی ثبت نشده است.</p>}</div></div>
  );
}

function Health() {
  const q = useQuery({ queryKey: ['knowledge-health'], queryFn: () => api('/health/knowledge') });
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { lint, graph } = q.data;
  const stats = [
    { l: 'صفحات ویکی', v: lint.pages, c: 'green', i: 'book' }, { l: 'لینک شکسته', v: lint.broken.length, c: 'orange', i: 'link' }, { l: 'صفحهٔ یتیم', v: lint.orphans.length, c: 'purple', i: 'graph' },
    { l: 'بن‌بست (بدون لینک خروجی)', v: lint.deadEnds.length, c: 'blue', i: 'arrow' }, { l: 'frontmatter نامعتبر', v: lint.badFrontmatter.length, c: 'orange', i: 'info' }, { l: 'صفحهٔ کم‌محتوا', v: lint.stubs.length, c: 'blue', i: 'note' },
    { l: 'مؤلفه‌های گراف', v: graph.components, c: 'teal', i: 'graph' }, { l: 'میانگین درجه', v: Number(graph.averageDegree).toFixed(2), c: 'teal', i: 'bars' }, { l: 'لینک مبهم', v: lint.ambiguous.length, c: 'orange', i: 'link' },
  ];
  const list = (title: string, items: string[]) => <Card title={`${title} (${num(items.length)})`}>{items.length ? items.slice(0, 50).map((x, i) => <div key={i} className="list-row"><span className="mono grow truncate">{x}</span></div>) : <p className="muted" style={{ fontSize: 11 }}>موردی نیست.</p>}</Card>;
  return (
    <>
      <Notice>این گزارش با کد قطعی ساخته می‌شود (معادل مهارت‌های lint و graph مخزن مبنا) و چیزی را خودکار تعمیر نمی‌کند؛ اصلاح‌ها از مسیر پیشنهاد و تأیید انجام می‌شوند.</Notice>
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))', marginBottom: 18 }}>
        {stats.map(s => <div key={s.l} className="card stat-card" style={{ cursor: 'default' }}><span className={`icon-tile ${s.c}`}><Icon name={s.i} /></span><span className="stat-content"><span className="stat-label">{s.l}</span><span className="stat-value" style={{ display: 'block' }}>{num(s.v)}</span></span></div>)}
      </div>
      <div className="grid-2">
        {list('لینک‌های شکسته', lint.broken.map((b: any) => `${b.from} → [[${b.target}]]`))}
        {list('لینک‌های مبهم', lint.ambiguous.map((b: any) => `${b.from} → [[${b.target}]]`))}
        {list('صفحات یتیم', lint.orphans)}
        {list('frontmatter نامعتبر', lint.badFrontmatter.map((b: any) => `${b.path}: ${b.problem}`))}
      </div>
      <Card title="مراکز اتصال (hub)" className="" >{graph.hubs.filter((h: any) => h.degree > 0).length ? graph.hubs.filter((h: any) => h.degree > 0).map((h: any) => <div key={h.id} className="list-row"><Link className="grow" to={`/library/${h.id}`} dir="auto">{h.title}</Link><span className="muted">درجه {num(h.degree)}</span></div>) : <p className="muted" style={{ fontSize: 11 }}>هنوز لینکی بین صفحات نیست.</p>}</Card>
    </>
  );
}

function Schedules() {
  const ws = useWorkspace(); const admin = ws?.role === 'owner' || ws?.role === 'admin'; const qc = useQueryClient();
  const q = useQuery({ queryKey: ['schedules'], queryFn: () => api('/schedules') });
  const [name, setName] = useState(''); const [skillId, setSkillId] = useState('lint'); const [cron, setCron] = useState('0 6 * * *');
  const [timezone, setTimezone] = useState(getPrefs().timezone); const [missed, setMissed] = useState('skip'); const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['schedules'] });
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api('/schedules', { json: { name, skillId, cron, timezone, missedPolicy: missed, enabled: true } }); setName(''); toast('زمان‌بندی ساخته شد.'); refresh(); } catch (err) { toast(errText(err), 'error'); } finally { setBusy(false); }
  };
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const zones = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return [timezone]; } })();
  return (
    <>
      <Notice>زمان‌بندی‌ها پس از restart worker ادامه می‌یابند و هم‌پوشانی ندارند. زمان‌بندی «ingest» فقط پیشنهاد می‌سازد و هرگز چیزی را خودکار اعمال نمی‌کند؛ اجرای آن به اتصال API نیاز دارد. پس از بازیابی پشتیبان، زمان‌بندی‌ها متوقف می‌شوند.</Notice>
      <div className="card"><div className="card-head"><h2>زمان‌بندی‌ها</h2></div><div className="card-body">
        {q.data.items.length ? <div className="table-wrap"><table className="data-table">
          <thead><tr><th>نام</th><th>مهارت</th><th>زمان‌بندی</th><th>اجرای بعدی</th><th>آخرین وضعیت</th><th>فعال</th><th /></tr></thead>
          <tbody>{q.data.items.map((s: any) => (
            <tr key={s.id}>
              <td dir="auto">{s.name}{s.paused_reason ? <div className="muted" style={{ fontSize: 10 }}>{s.paused_reason}</div> : null}</td>
              <td className="mono">{s.skill_id}</td>
              <td><span className="mono">{s.cron}</span><div className="muted ltr" style={{ fontSize: 10 }}>{s.timezone} · missed: {s.missed_policy}</div></td>
              <td>{s.next_run_at ? date(s.next_run_at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
              <td>{s.last_run_status ? <StatusBadge map={runStatus} value={s.last_run_status} /> : '—'}</td>
              <td><input type="checkbox" checked={s.enabled} disabled={!admin} aria-label={`فعال بودن ${s.name}`} onChange={async () => { try { await api(`/schedules/${s.id}`, { method: 'PATCH', json: { enabled: !s.enabled } }); refresh(); } catch (err) { toast(errText(err), 'error'); } }} /></td>
              <td>{admin ? <button className="icon-btn" onClick={() => setDel(s.id)} aria-label={`حذف ${s.name}`}><Icon name="trash" size="sm" /></button> : null}</td>
            </tr>))}</tbody></table></div> : <p className="muted" style={{ fontSize: 11 }}>زمان‌بندی‌ای تعریف نشده است.</p>}
      </div></div>
      {admin ? <Card title="زمان‌بندی جدید" className="">
        <form onSubmit={create}>
          <div className="settings-profile">
            <Field label="نام" id="sc-name"><input id="sc-name" className="field" value={name} onChange={e => setName(e.target.value)} maxLength={100} required dir="auto" /></Field>
            <Field label="مهارت" id="sc-skill"><select id="sc-skill" className="field" value={skillId} onChange={e => setSkillId(e.target.value)}><option value="lint">lint — سلامت ساختاری</option><option value="metrics">metrics — شاخص‌ها</option><option value="graph">graph — تحلیل گراف</option><option value="ingest">ingest — پیشنهاد برای منابع آماده</option></select></Field>
            <Field label="عبارت cron" id="sc-cron" help="پنج فیلد: دقیقه ساعت روز ماه روزهفته"><input id="sc-cron" className="field ltr" value={cron} onChange={e => setCron(e.target.value)} required /></Field>
            <Field label="منطقهٔ زمانی" id="sc-tz"><select id="sc-tz" className="field ltr" value={timezone} onChange={e => setTimezone(e.target.value)}>{zones.map(z => <option key={z} value={z}>{z}</option>)}</select></Field>
            <Field label="اجرای ازدست‌رفته" id="sc-missed" help="رفتار پس از خاموشی: نادیده‌گرفتن یا فقط یک بار اجرا"><select id="sc-missed" className="field" value={missed} onChange={e => setMissed(e.target.value)}><option value="skip">نادیده بگیر</option><option value="run_once">یک بار اجرا کن</option></select></Field>
          </div>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? 'در حال ساخت…' : 'ساخت زمان‌بندی'}</button>
        </form>
      </Card> : null}
      <ConfirmDialog open={!!del} danger title="حذف زمان‌بندی" text="اجراهای قبلی در تاریخچه باقی می‌مانند." confirmLabel="حذف" onClose={() => setDel(null)} onConfirm={async () => { try { await api(`/schedules/${del}`, { method: 'DELETE' }); setDel(null); refresh(); } catch (err) { toast(errText(err), 'error'); } }} />
    </>
  );
}

function Skills() {
  const q = useQuery({ queryKey: ['skills'], queryFn: () => api('/skills') });
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <div className="card"><div className="card-head"><h2>فهرست مهارت‌ها (registry نسخه‌دار)</h2></div><div className="card-body"><div className="table-wrap"><table className="data-table">
      <thead><tr><th>شناسه</th><th>عنوان</th><th>حالت</th><th>وضعیت واقعی</th><th>فایل مبنا</th><th>توضیح</th></tr></thead>
      <tbody>{q.data.skills.map((s: any) => (
        <tr key={s.id}><td className="mono">{s.id}@{s.version}</td><td>{s.title}</td><td>{s.mode === 'read' ? 'خواندنی' : s.mode === 'propose' ? 'فقط پیشنهاد' : 'قطعی'}</td>
          <td><Chip color={SKILL_STATUS[s.status]?.color}>{SKILL_STATUS[s.status]?.label ?? s.status}</Chip></td><td className="mono">{s.upstreamFile}</td><td style={{ fontSize: 11 }}>{s.note ?? ''}</td></tr>))}</tbody>
    </table></div></div></div>
  );
}

export default function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'runs') as Tab;
  const ws = useWorkspace(); void canEdit(ws?.role ?? 'viewer');
  return (
    <>
      <PageHeader title="فعالیت و سلامت" description="بدان چه چیزی تغییر کرده و کدام بخش به توجه تو نیاز دارد." />
      <div className="toolbar"><Tabs label="بخش‌های فعالیت" value={tab} onChange={t => setParams({ tab: t }, { replace: true })} items={[['runs', 'اجراها'], ['events', 'رویدادها'], ['health', 'سلامت دانش'], ['schedules', 'زمان‌بندی'], ['skills', 'مهارت‌ها']]} /></div>
      {tab === 'runs' ? <Runs /> : tab === 'events' ? <Events /> : tab === 'health' ? <Health /> : tab === 'schedules' ? <Schedules /> : <Skills />}
    </>
  );
}
