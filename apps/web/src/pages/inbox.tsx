import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uid } from '../lib/api';
import { num, relative, sourceStatus, bytes } from '../lib/format';
import { PageHeader, Notice, Tabs, Tile, StatusBadge, EmptyState, LoadingState, ErrorState, Icon, toast, errText } from '../components/ui';
import { AddSourceDialog } from '../components/add-source';
import { useWorkspace, canEdit } from '../session';
import { useNativeStatus, useClaudeJob } from '../components/claude-task';

const FILTERS: [string, string, string | null][] = [
  ['active', 'در جریان', 'uploaded,queued,extracting,ready_for_analysis,analyzing,awaiting_review'],
  ['problems', 'نیازمند اقدام', 'extraction_failed,needs_ocr,analysis_failed,canceled'],
  ['applied', 'اعمال‌شده', 'applied'],
  ['all', 'همه', null],
];
const kindIcon: Record<string, string> = { text: 'note', markdown: 'note', transcript: 'chat', file: 'file', url: 'link', pdf: 'pdf', chat: 'chat' };

export default function InboxPage() {
  const ws = useWorkspace(); const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filter = params.get('status') && !FILTERS.some(f => f[0] === params.get('status')) ? 'custom' : (params.get('status') ?? 'active');
  const statuses = filter === 'custom' ? params.get('status') : FILTERS.find(f => f[0] === filter)?.[2] ?? null;
  const [add, setAdd] = useState(false);
  const native = useNativeStatus();
  const claude = useClaudeJob();
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api('/system/status') });
  const q = useQuery({ queryKey: ['sources', statuses], queryFn: () => api(`/sources?limit=100${statuses ? `&status=${statuses}` : ''}`), refetchInterval: d => ((d.state.data?.items ?? []).some((s: any) => ['queued', 'extracting', 'analyzing'].includes(s.status)) ? 2500 : 15000) });
  const writer = canEdit(ws.role);
  const modelOk = status.data?.capabilities?.modelFeatures;
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); qc.invalidateQueries({ queryKey: ['sources'] }); qc.invalidateQueries({ queryKey: ['overview'] }); } catch (e) { toast(errText(e), 'error'); } };
  return (
    <>
      <PageHeader title="ورودی‌ها" description="هر ایده، مقاله و یادداشت؛ یک نقطهٔ شروع برای دانشت." action={writer ? <button className="btn primary" onClick={() => setAdd(true)}><Icon name="plus" size="sm" /> افزودن منبع</button> : undefined} />
      {status.data && !modelOk ? <Notice kind="warning">اتصال مدل برقرار نیست: {status.data.capabilities.modelFeaturesReason} منابع ذخیره، استخراج و جست‌وجو می‌شوند؛ «تحلیل» خودکار تا اتصال API غیرفعال است؛ <Link to="/settings/integrations/claude#native">یا با اشتراک Claude در محیط تعاملی Claude Code کار کن</Link>.</Notice>
        : status.data?.capabilities?.provider === 'mock' ? <Notice kind="warning">این نصب در حالت آزمایشی (mock) است؛ پیشنهادها خروجی مدل واقعی نیستند.</Notice> : null}
      <div className="toolbar">
        <Tabs label="فیلتر وضعیت" value={filter} onChange={v => setParams({ status: v })} items={FILTERS.map(f => [f[0], f[1]] as [string, string])} />
        <span className="muted" style={{ fontSize: 11 }}>{q.data ? `${num(q.data.total)} منبع` : ''}</span>
      </div>
      {q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : !q.data.items.length
        ? <EmptyState icon="inbox" title="ورودی‌ای در این فیلتر نیست" text="متن، نشانی وب، PDF یا خروجی گفتگو اضافه کن تا از همین‌جا شروع شود." action={writer ? <button className="btn primary" onClick={() => setAdd(true)}>افزودن اولین منبع</button> : undefined} />
        : <div className="source-list">{q.data.items.map((s: any) => (
          <article key={s.id} className="card source-row">
            <Tile icon={kindIcon[s.kind] ?? 'file'} color={s.status.includes('failed') ? 'red' : s.status === 'awaiting_review' ? 'orange' : 'blue'} />
            <div className="source-info">
              <h3 dir="auto"><Link to={`/inbox/${s.id}`} style={{ color: 'inherit' }}>{s.title}</Link></h3>
              <p>{relative(s.created_at)} · {s.project_title ?? 'بدون پروژه'}{s.original_name ? ` · ${s.original_name}` : ''}{s.byte_size ? ` · ${bytes(s.byte_size)}` : ''}{s.sensitivity === 'no_external' ? ' · عدم ارسال بیرونی' : ''}{s.duplicate_of ? ' · تکراری قطعی' : ''}</p>
              {s.status_detail ? <p style={{ color: 'var(--muted-dark)' }}>{s.status_detail}</p> : null}
            </div>
            <StatusBadge map={sourceStatus} value={s.status} />
            <div className="source-actions">
              <Link className="btn small" to={`/inbox/${s.id}`}><Icon name="eye" size="sm" /> جزئیات</Link>
              {writer && ['ready_for_analysis', 'analysis_failed', 'canceled'].includes(s.status) && s.sensitivity !== 'no_external'
                ? <button className="btn small soft" disabled={!modelOk} title={modelOk ? '' : 'اتصال مدل برقرار نیست'} onClick={() => act(() => api(`/sources/${s.id}/analyze`, { json: { idempotencyKey: uid() } }), 'تحلیل در صف قرار گرفت.')}><Icon name="spark" size="sm" /> تحلیل</button> : null}
              {writer && !modelOk && native.data?.loggedIn && ['ready_for_analysis', 'analysis_failed', 'canceled'].includes(s.status) && s.sensitivity !== 'no_external'
                ? <button className="btn small primary" onClick={() => act(() => claude.start({ kind: 'ingest', sourceId: s.id }), 'Claude در پس‌زمینه شروع به تحلیل کرد.')}><Icon name="spark" size="sm" /> تحلیل با Claude</button> : null}
              {s.changeset_id && s.status === 'awaiting_review' ? <Link className="btn small primary" to={`/review/${s.changeset_id}`}><Icon name="review" size="sm" /> بررسی</Link> : null}
              {writer && ['queued', 'analyzing'].includes(s.status) && s.last_run?.id ? <button className="btn small" onClick={() => act(() => api(`/runs/${s.last_run.id}/cancel`, { json: {} }), 'درخواست لغو ثبت شد.')}>لغو</button> : null}
              {writer && ['extraction_failed', 'needs_ocr'].includes(s.status) ? <button className="btn small" onClick={() => act(() => api(`/sources/${s.id}/retry-extract`, { json: {} }), 'استخراج دوباره در صف است.')}><Icon name="refresh" size="sm" /> تلاش دوباره</button> : null}
            </div>
          </article>))}</div>}
      {add ? <AddSourceDialog initial="text" onClose={() => setAdd(false)} /> : null}
      {claude.dialog}
    </>
  );
}
