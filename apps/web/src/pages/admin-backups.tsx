import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, ApiError } from '../lib/api';
import { bytes, dateTime, num } from '../lib/format';
import { PageHeader, Notice, Card, Field, Icon, Chip, LoadingState, ErrorState, Modal, toast, errText } from '../components/ui';
import { useStepUp } from '../components/content';
import { useMe } from '../session';

export default function BackupsPage() {
  const me = useMe(); const qc = useQueryClient(); const step = useStepUp(me.user.totpEnabled);
  const q = useQuery({ queryKey: ['backups'], queryFn: () => api('/admin/backups'), enabled: me.user.isAdmin });
  const [pass, setPass] = useState(''); const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState<any>(null);
  if (!me.user.isAdmin) return <ErrorState error={new ApiError(403, { code: 'forbidden', message: 'فقط مدیر سامانه.', requestId: '', retryable: false })} />;
  const create = async () => {
    setBusy(true);
    try { await step.run(async () => { const r = await api('/admin/backups', { json: pass ? { passphrase: pass } : {} }); setPass(''); toast(`پشتیبان ساخته شد: ${r.file}`); qc.invalidateQueries({ queryKey: ['backups'] }); }); }
    catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const check = async (file: string) => {
    const pp = file.endsWith('.enc') ? window.prompt('گذرواژهٔ رمزنگاری این پشتیبان:') ?? '' : undefined;
    try { setVerify({ file, ...(await api(`/admin/backups/${encodeURIComponent(file)}/verify`, { json: pp !== undefined ? { passphrase: pp } : {} })) }); } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <>
      <PageHeader title="پشتیبان و بازیابی" description="یک نقطهٔ سازگار از پایگاه داده و فایل‌ها؛ جدا از export قابل حمل محتوا." />
      <Notice kind="warning" icon="shield">کلید اصلی (<span className="mono">secrets/master_key</span>) داخل پشتیبان نیست. بدون آن، کلید API رمزشده و TOTP قابل بازیابی نیستند؛ آن را جدا و امن نگه دار. ورود حساب در محیط native نیز در پشتیبان نیست و پس از بازیابی دوباره وارد می‌شوی. Git یا یک کپی روی همین دیسک پشتیبان کافی نیست؛ فایل را به مقصد دیگری منتقل کن.</Notice>
      <div className="grid-2">
        <Card title="ساخت پشتیبان عملیاتی">
          <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>در زمان پشتیبان‌گیری، نوشتن در vault قفل می‌شود و پایگاه داده از یک snapshot خوانده می‌شود. نشست‌ها، توکن‌های اجرا و تلاش‌های ورود عمداً ذخیره نمی‌شوند.</p>
          <Field label="گذرواژهٔ رمزنگاری پشتیبان (اختیاری، دست‌کم ۱۲ نویسه)" id="bk-pass" help="مستقل از گذرواژهٔ برنامه؛ اگر فراموش شود، پشتیبان قابل بازیابی نیست."><input id="bk-pass" className="field" type="password" autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)} /></Field>
          <button className="btn primary" onClick={create} disabled={busy || (!!pass && pass.length < 12)}><Icon name="download" size="sm" />{busy ? 'در حال ساخت…' : 'ساخت پشتیبان'}</button>
        </Card>
        <Card title="بازیابی">
          <p style={{ fontSize: 12, lineHeight: 2.1 }}>بازیابی عمداً فقط از خط فرمان سرور انجام می‌شود تا سرویس‌ها متوقف باشند و نام فایل صریح تأیید شود:</p>
          <pre className="preview-box mono">./scripts/restore.sh backups/&lt;file&gt;</pre>
          <p className="field-help">ابتدا اعتبارسنجی (checksum، نسخهٔ schema، مسیرها و فضای دیسک) به‌صورت dry-run اجرا می‌شود. داده‌های فعلی حذف نمی‌شوند و به پوشهٔ <span className="mono">.pre-restore-*</span> منتقل می‌شوند؛ همهٔ نشست‌ها پایان می‌یابند، زمان‌بندی‌ها متوقف می‌شوند و اجراهای ناتمام دوباره ارسال نمی‌شوند.</p>
        </Card>
      </div>
      <Card title="فایل‌های پشتیبان روی سرور">
        {q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : !q.data.items.length ? <p className="muted" style={{ fontSize: 12 }}>هنوز پشتیبانی ساخته نشده است.</p> :
          <div className="table-wrap"><table className="data-table"><thead><tr><th>فایل</th><th>اندازه</th><th>زمان</th><th>محتوا</th><th /></tr></thead><tbody>
            {q.data.items.map((b: any) => <tr key={b.file}><td className="mono">{b.file}</td><td>{bytes(b.size)}</td><td>{b.record ? dateTime(b.record.created_at) : '—'}</td><td>{b.record ? <>{num(b.record.manifest.files)} فایل · schema {num(b.record.manifest.schemaVersion)} {b.record.manifest.encrypted ? <Chip color="green">رمزشده</Chip> : <Chip>رمزنشده</Chip>}</> : <Chip>بدون رکورد (از نصب دیگر)</Chip>}</td>
              <td><div className="row-wrap"><button className="btn small" onClick={() => check(b.file)}>اعتبارسنجی</button><button className="btn small" onClick={() => step.run(async () => { const m = await api('/me'); if (!m.stepUpValidUntil || Date.parse(m.stepUpValidUntil) < Date.now() + 5000) throw Object.assign(new Error('step-up'), { code: 'step_up_required' }); download(`/admin/backups/${encodeURIComponent(b.file)}/download`); })}><Icon name="download" size="sm" />دریافت</button></div></td></tr>)}
          </tbody></table></div>}
      </Card>
      <Modal open={!!verify} title={`اعتبارسنجی ${verify?.file ?? ''}`} onClose={() => setVerify(null)}>
        {verify ? <>{verify.ok ? <Notice>پشتیبان سالم است و با این نسخه سازگار است.</Notice> : <Notice kind="danger">مشکلات: {(verify.problems ?? []).join('؛ ')}</Notice>}
          {verify.manifest ? <dl className="kv"><dt>ساخت</dt><dd>{dateTime(verify.manifest.createdAt)}</dd><dt>نسخهٔ برنامه</dt><dd>{verify.manifest.appVersion}</dd><dt>schema</dt><dd>{verify.manifest.schemaVersion}</dd><dt>فایل‌ها</dt><dd>{num(verify.manifest.files)}</dd><dt>اجرای ناتمام هنگام پشتیبان</dt><dd>{num(verify.manifest.activeRuns)}</dd><dt>upstream</dt><dd className="mono">{verify.manifest.upstreamCommit ?? '—'}</dd></dl> : null}</> : null}
      </Modal>
      {step.dialog}
    </>
  );
}
