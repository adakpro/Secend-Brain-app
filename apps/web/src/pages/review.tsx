import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { num, relative, csStatus } from '../lib/format';
import { PageHeader, Notice, Tabs, StatusBadge, EmptyState, LoadingState, ErrorState, Icon, Chip } from '../components/ui';

export default function ReviewPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'open';
  const q = useQuery({ queryKey: ['changesets', tab], queryFn: () => api(`/changesets${tab === 'open' ? '?status=open' : ''}`) });
  const open = useQuery({ queryKey: ['changesets', 'open'], queryFn: () => api('/changesets?status=open'), enabled: tab !== 'open' });
  const openCount = tab === 'open' ? q.data?.items?.length : open.data?.items?.length;
  return (
    <>
      <PageHeader title="بررسی تغییرات" description="هیچ تغییر هوشمندی نباید بدون اطلاع تو وارد دانشت شود." />
      <Notice kind="warning" icon="shield">پیش از تأیید، هیچ فایل اصلی تغییر نمی‌کند. می‌توانی بخشی از یک بسته را بپذیری، متن پیشنهادی را ویرایش کنی یا آن را رد کنی؛ هر بستهٔ اعمال‌شده با یک «بستهٔ معکوس» قابل بازگردانی است و ویرایش‌های مستقل بعدی تو حفظ می‌شوند.</Notice>
      <div className="toolbar"><Tabs label="فیلتر بسته‌ها" value={tab} onChange={v => setParams({ tab: v })} items={[['open', <>منتظر بررسی {openCount ? <Chip color="orange">{num(openCount)}</Chip> : null}</>], ['all', 'همهٔ بسته‌ها']]} /></div>
      {q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : !q.data.items.length
        ? <EmptyState icon="check-circle" title={tab === 'open' ? 'همه‌چیز بررسی شده است' : 'هنوز بسته‌ای نیست'} text={tab === 'open' ? 'پیشنهاد تازه‌ای در انتظار تصمیم تو نیست.' : 'با تحلیل یک منبع، بستهٔ پیشنهادی اینجا ظاهر می‌شود.'} action={tab === 'open' ? <button className="btn" onClick={() => setParams({ tab: 'all' })}>مشاهدهٔ سابقه</button> : <Link className="btn" to="/inbox">رفتن به ورودی‌ها</Link>} />
        : <div className="stack">{q.data.items.map((c: any) => (
          <article key={c.id} className="card review-card">
            <div className="between"><div className="row"><span className={`icon-tile ${c.status === 'conflict' ? 'red' : c.origin === 'rollback' ? 'purple' : 'orange'}`}><Icon name={c.origin === 'rollback' ? 'undo' : 'review'} /></span><h2 dir="auto">{c.title}</h2></div><StatusBadge map={csStatus} value={c.status} /></div>
            {c.summary ? <p className="review-desc" dir="auto">{c.summary}</p> : null}
            <div className="review-summary">
              <Chip color="blue">{num(c.items)} فایل</Chip>
              {(c.item_summary ?? []).slice(0, 4).map((i: any) => <Chip key={i.path}><span className="mono">{i.op} {i.path.split('/').slice(-2).join('/')}</span></Chip>)}
              {c.source_title ? <Chip>منبع: {c.source_title}</Chip> : null}
              {c.provider === 'mock' ? <Chip color="orange">خروجی آزمایشی mock</Chip> : c.provider === 'anthropic' ? <Chip color="teal">Claude API</Chip> : c.origin === 'manual' ? <Chip>اقدام دستی</Chip> : null}
              {c.report?.coverage?.partial ? <Chip color="orange">پوشش ناقص منبع</Chip> : null}
              <Chip>{relative(c.created_at)}</Chip>
            </div>
            <div className="review-actions"><Link className="btn primary" to={`/review/${c.id}`}><Icon name="eye" size="sm" /> مشاهدهٔ تفاوت و تصمیم</Link></div>
          </article>))}</div>}
    </>
  );
}
