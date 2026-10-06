import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { PageHeader, Notice, LoadingState, ErrorState, Icon, Chip, toast, errText } from '../components/ui';
import { useMe } from '../session';
import '../styles/pages-work.css';

export default function AuditPage() {
  const me = useMe();
  const [action, setAction] = useState(''); const [applied, setApplied] = useState('');
  const [items, setItems] = useState<any[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState<unknown>(null); const [more, setMore] = useState(true);
  const load = async (reset: boolean) => {
    setLoading(true); setError(null);
    try {
      const before = !reset && items.length ? items[items.length - 1].id : null;
      const p = new URLSearchParams({ limit: '100' }); if (applied) p.set('action', applied); if (before) p.set('before', String(before));
      const r = await api(`/admin/audit?${p}`);
      setItems(reset ? r.items : [...items, ...r.items]); setMore(r.items.length === 100);
    } catch (err) { if (reset) setError(err); else toast(errText(err), 'error'); } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (me.user.isAdmin) load(true); }, [applied]);
  if (!me.user.isAdmin) return <Notice kind="warning">فقط مدیر سامانه به این بخش دسترسی دارد.</Notice>;
  return (
    <>
      <PageHeader title="گزارش audit" description="چه کسی، چه کاری، با چه نتیجه‌ای. متن منبع، گفتگو و کلیدها در این گزارش ذخیره نمی‌شوند." action={<Link className="btn" to="/settings"><Icon name="arrow" size="sm" /> تنظیمات</Link>} />
      <form className="toolbar" onSubmit={e => { e.preventDefault(); setApplied(action.trim()); }}>
        <div className="row"><input className="field filter-input ltr" value={action} onChange={e => setAction(e.target.value)} placeholder="پیشوند عملیات، مثلاً auth. یا changeset." aria-label="فیلتر عملیات" /><button className="btn small">فیلتر</button>{applied ? <button type="button" className="text-link" onClick={() => { setAction(''); setApplied(''); }}>حذف فیلتر</button> : null}</div>
      </form>
      {error ? <ErrorState error={error} retry={() => load(true)} /> : (
        <div className="card"><div className="card-body" style={{ paddingTop: 12 }}><div className="table-wrap"><table className="data-table">
          <thead><tr><th>زمان</th><th>عملیات</th><th>نتیجه</th><th>کاربر</th><th>هدف</th><th>جزئیات</th></tr></thead>
          <tbody>{items.map(e => (
            <tr key={e.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{dateTime(e.created_at)}</td>
              <td className="mono">{e.action}</td>
              <td><Chip color={e.result === 'success' ? 'green' : 'orange'}>{e.result}</Chip></td>
              <td className="mono">{e.email ?? 'سیستم'}{e.ip ? <div className="muted">{e.ip}</div> : null}</td>
              <td className="mono">{e.target_type ? `${e.target_type}:${String(e.target_id ?? '').slice(0, 8)}` : '—'}</td>
              <td><div className="mono pw-json">{e.meta && Object.keys(e.meta).length ? JSON.stringify(e.meta) : ''}</div>{e.request_id ? <div className="mono muted" style={{ fontSize: 9 }}>req {String(e.request_id).slice(0, 8)}</div> : null}</td>
            </tr>))}</tbody>
        </table></div>
          {loading ? <LoadingState /> : !items.length ? <p className="muted" style={{ fontSize: 11, padding: 12 }}>رویدادی پیدا نشد.</p> : more ? <div style={{ textAlign: 'center', padding: 12 }}><button className="btn small" onClick={() => load(false)}>رویدادهای قدیمی‌تر</button></div> : null}
        </div></div>)}
    </>
  );
}
