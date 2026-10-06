import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { num, date } from '../lib/format';
import { PageHeader, Modal, Field, Notice, LoadingState, ErrorState, Icon, Chip, ConfirmDialog, toast, errText } from '../components/ui';
import { useStepUp } from '../components/content';
import { useMe, useWorkspace } from '../session';
import '../styles/pages-work.css';

const ROLE: Record<string, string> = { owner: 'مالک', admin: 'مدیر', member: 'عضو', viewer: 'بیننده' };

export default function UsersPage() {
  const me = useMe(); const ws = useWorkspace(); const qc = useQueryClient(); const stepUp = useStepUp(me.user.totpEnabled);
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => api('/admin/users'), enabled: me.user.isAdmin });
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(''); const [displayName, setDisplayName] = useState(''); const [password, setPassword] = useState(''); const [role, setRole] = useState('member');
  const [confirm, setConfirm] = useState<null | { id: string; kind: 'disable' | 'enable' | 'revoke'; email: string }>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const run = (fn: () => Promise<void>) => stepUp.run(fn).catch(err => toast(errText(err), 'error'));
  if (!me.user.isAdmin) return <Notice kind="warning">فقط مدیر سامانه به این بخش دسترسی دارد.</Notice>;
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => { await api('/admin/users', { json: { email, displayName, password, role } }); setOpen(false); setEmail(''); setDisplayName(''); setPassword(''); toast('کاربر ساخته شد.'); refresh(); });
  };
  return (
    <>
      <PageHeader title="کاربران و نقش‌ها" description={`عضویت در فضای «${ws?.name ?? ''}»؛ نقش‌ها در سرور اعمال می‌شوند.`} action={<div className="row-wrap"><Link className="btn" to="/settings"><Icon name="arrow" size="sm" /> تنظیمات</Link><button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" size="sm" /> کاربر جدید</button></div>} />
      <Notice>ثبت‌نام عمومی وجود ندارد. «بیننده» فقط می‌خواند؛ «عضو» منبع و ویرایش و تأیید دارد؛ تنظیم credential، ترمینال، کاربران و بازیابی فقط برای مدیر و با تأیید دوبارهٔ هویت است.</Notice>
      {q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="card"><div className="card-body" style={{ paddingTop: 12 }}><div className="table-wrap"><table className="data-table">
          <thead><tr><th>کاربر</th><th>نقش‌ها</th><th>دومرحله‌ای</th><th>نشست فعال</th><th>وضعیت</th><th /></tr></thead>
          <tbody>{q.data.items.map((u: any) => {
            const m = (u.memberships ?? []).find((x: any) => x.workspaceId === ws?.id);
            return (
              <tr key={u.id}>
                <td><div dir="auto">{u.display_name}</div><div className="mono muted">{u.email}</div><div className="muted" style={{ fontSize: 10 }}>{date(u.created_at)}</div></td>
                <td>{(u.memberships ?? []).map((x: any) => <div key={x.workspaceId} style={{ fontSize: 11 }}>{x.workspace}: {ROLE[x.role] ?? x.role}</div>)}{u.is_installation_owner ? <Chip color="purple">مالک سامانه</Chip> : null}</td>
                <td>{u.totp_enabled ? <Chip color="green">فعال</Chip> : <Chip>غیرفعال</Chip>}</td>
                <td>{num(u.active_sessions)}</td>
                <td>{u.disabled_at ? <Chip color="orange">غیرفعال</Chip> : <Chip color="green">فعال</Chip>}</td>
                <td>{u.is_installation_owner ? <span className="muted" style={{ fontSize: 10 }}>محافظت‌شده (فقط CLI)</span> : <div className="row-wrap">
                  {m ? <select className="field" style={{ width: 'auto', padding: '3px 8px' }} aria-label={`نقش ${u.email}`} value={m.role} onChange={e => { const r = e.target.value; run(async () => { await api(`/admin/users/${u.id}`, { method: 'PATCH', json: { role: r } }); toast('نقش تغییر کرد.'); refresh(); }); }}>
                    <option value="admin">مدیر</option><option value="member">عضو</option><option value="viewer">بیننده</option></select> : null}
                  <button className="btn small" onClick={() => setConfirm({ id: u.id, kind: 'revoke', email: u.email })}>لغو نشست‌ها</button>
                  <button className={`btn small ${u.disabled_at ? '' : 'danger'}`} onClick={() => setConfirm({ id: u.id, kind: u.disabled_at ? 'enable' : 'disable', email: u.email })}>{u.disabled_at ? 'فعال‌سازی' : 'غیرفعال‌سازی'}</button>
                </div>}</td>
              </tr>);
          })}</tbody>
        </table></div></div></div>)}
      <Modal open={open} title="کاربر جدید" onClose={() => setOpen(false)}>
        <form onSubmit={create}>
          <Field label="ایمیل" id="u-email"><input id="u-email" className="field ltr" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="off" /></Field>
          <Field label="نام نمایشی" id="u-name"><input id="u-name" className="field" value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={100} required dir="auto" /></Field>
          <Field label="گذرواژهٔ اولیه" id="u-pw" help="دست‌کم ۱۲ نویسه؛ آن را از کانال امن به کاربر بده."><input id="u-pw" className="field" type="password" minLength={12} value={password} onChange={e => setPassword(e.target.value)} required autoComplete="new-password" /></Field>
          <Field label="نقش" id="u-role"><select id="u-role" className="field" value={role} onChange={e => setRole(e.target.value)}><option value="admin">مدیر</option><option value="member">عضو</option><option value="viewer">بیننده</option></select></Field>
          <div className="dialog-actions"><button type="button" className="btn" onClick={() => setOpen(false)}>انصراف</button><button className="btn primary" disabled={password.length < 12}>ساخت کاربر</button></div>
        </form>
      </Modal>
      <ConfirmDialog open={!!confirm} danger={confirm?.kind !== 'enable'} title={confirm?.kind === 'revoke' ? 'لغو همهٔ نشست‌ها' : confirm?.kind === 'disable' ? 'غیرفعال‌سازی کاربر' : 'فعال‌سازی کاربر'}
        text={<span>کاربر <span className="mono">{confirm?.email}</span>{confirm?.kind === 'disable' ? ' دیگر نمی‌تواند وارد شود و همهٔ نشست‌هایش لغو می‌شود.' : confirm?.kind === 'revoke' ? ' از همهٔ دستگاه‌ها خارج می‌شود.' : ' دوباره می‌تواند وارد شود.'}</span>}
        onClose={() => setConfirm(null)} onConfirm={() => { const c = confirm!; setConfirm(null); run(async () => {
          if (c.kind === 'revoke') { const r = await api(`/admin/users/${c.id}/revoke-sessions`, { json: {} }); toast(`${num(r.revoked)} نشست لغو شد.`); }
          else { await api(`/admin/users/${c.id}`, { method: 'PATCH', json: { disabled: c.kind === 'disable' } }); toast('انجام شد.'); }
          refresh();
        }); }} />
      {stepUp.dialog}
    </>
  );
}
