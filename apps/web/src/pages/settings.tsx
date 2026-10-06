import { useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { relative, dateTime, setPrefs, type Prefs } from '../lib/format';
import { PageHeader, Field, Notice, LoadingState, ErrorState, Icon, Tile, Chip, ConfirmDialog, toast, errText } from '../components/ui';
import { useStepUp } from '../components/content';
import { useMe, useWorkspace, applyTheme } from '../session';
import '../styles/pages-work.css';

const SECTIONS: [string, string][] = [['general', 'عمومی'], ['workspaces', 'فضاهای دانش'], ['security', 'امنیت'], ['sessions', 'نشست‌ها'], ['connections', 'اتصال‌ها'], ['data', 'داده و پشتیبان']];

function Options<T extends string>({ value, items, onChange, label }: { value: T; items: [T, string, string?][]; onChange: (v: T) => void; label: string }) {
  return <div className="setting-options" role="radiogroup" aria-label={label}>{items.map(([v, l, ic]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={`setting-option ${value === v ? 'active' : ''}`} onClick={() => onChange(v)}>{ic ? <Icon name={ic} size="sm" /> : null}{l}</button>)}</div>;
}

function General() {
  const me = useMe(); const qc = useQueryClient();
  const [name, setName] = useState(me.user.displayName);
  const p = me.preferences;
  const save = async (patch: Partial<Prefs> & { displayName?: string }) => {
    try {
      if (patch.theme) applyTheme(patch.theme);
      setPrefs(patch);
      await api('/me/preferences', { method: 'PATCH', json: patch });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast('ذخیره شد.');
    } catch (err) { toast(errText(err), 'error'); }
  };
  const zones = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return [p.timezone]; } })();
  return (
    <>
      <section className="card settings-section"><h2>نمایه</h2>
        <form onSubmit={e => { e.preventDefault(); save({ displayName: name.trim() }); }}>
          <div className="settings-profile">
            <Field label="نام نمایشی" id="st-name"><input id="st-name" className="field" value={name} onChange={e => setName(e.target.value)} maxLength={100} required dir="auto" /></Field>
            <Field label="ایمیل ورود" id="st-email" help="ایمیل از مسیر CLI مدیر قابل تغییر است."><input id="st-email" className="field ltr" value={me.user.email} readOnly /></Field>
          </div>
          <button className="btn primary" disabled={!name.trim() || name === me.user.displayName}>ذخیرهٔ تغییرات</button>
        </form>
      </section>
      <section className="card settings-section"><h2>ظاهر و زبان</h2>
        <div className="setting-row"><div><h3>رنگ محیط</h3><p>روی سرور برای حساب تو ذخیره می‌شود.</p></div><Options label="رنگ محیط" value={p.theme} onChange={v => save({ theme: v })} items={[['light', 'روشن', 'sun'], ['dark', 'تاریک', 'moon'], ['system', 'سیستم', 'monitor']]} /></div>
        <div className="setting-row"><div><h3>زبان و چیدمان</h3><p>فارسی راست‌چین؛ انگلیسی چیدمان را چپ‌چین می‌کند. کد، نشانی و مسیر همیشه LTR‌اند.</p></div><Options label="زبان" value={p.locale} onChange={v => save({ locale: v }).then(() => window.location.reload())} items={[['fa', 'فارسی · RTL'], ['en', 'English · LTR']]} /></div>
        <div className="setting-row"><div><h3>تقویم</h3><p>تاریخ‌ها در پایگاه داده UTC ذخیره و با منطقهٔ زمانی تو نمایش داده می‌شوند.</p></div><Options label="تقویم" value={p.calendar} onChange={v => save({ calendar: v })} items={[['persian', 'شمسی'], ['gregorian', 'میلادی']]} /></div>
        <div className="setting-row"><div><h3>اعداد</h3><p>نمایش ارقام در رابط.</p></div><Options label="اعداد" value={p.digits} onChange={v => save({ digits: v })} items={[['fa', '۱۲۳ فارسی'], ['latn', '123 لاتین']]} /></div>
        <div className="setting-row"><div><h3>منطقهٔ زمانی</h3><p>برای نمایش تاریخ و زمان‌بندی‌ها.</p></div>
          <select className="field ltr" style={{ maxWidth: 240 }} aria-label="منطقهٔ زمانی" value={p.timezone} onChange={e => save({ timezone: e.target.value })}>{zones.map(z => <option key={z} value={z}>{z}</option>)}</select></div>
      </section>
    </>
  );
}

function Workspaces() {
  const me = useMe(); const ws = useWorkspace(); const qc = useQueryClient();
  const admin = me.user.isAdmin;
  const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [rename, setRename] = useState(ws?.name ?? ''); const [busy, setBusy] = useState(false);
  const switchTo = async (id: string) => { try { await api('/me/active-workspace', { json: { workspaceId: id } }); window.location.reload(); } catch (err) { toast(errText(err), 'error'); } };
  return (
    <>
      <section className="card settings-section"><h2>فضاهای دانش</h2>
        {me.workspaces.map(w => (
          <div key={w.id} className="setting-row"><div><h3>{w.name} {w.id === ws?.id ? <Chip color="blue">فعلی</Chip> : null} {w.isDemo ? <Chip color="orange">نمایشی</Chip> : null}</h3><p><span className="mono">vault/{w.slug}/</span> · نقش: {w.role}</p></div>
            {w.id !== ws?.id ? <button className="btn small" onClick={() => switchTo(w.id)}>تغییر به این فضا</button> : null}</div>))}
        <p className="field-help">هر فضای دانش vault، منابع، جست‌وجو و گفتگوهای جدا دارد؛ نتایج هیچ فضایی در فضای دیگر دیده نمی‌شود.</p>
      </section>
      {ws && (ws.role === 'owner' || ws.role === 'admin') ? <section className="card settings-section"><h2>تغییر نام فضای فعلی</h2>
        <form className="row" onSubmit={async e => { e.preventDefault(); try { await api('/workspaces/current', { method: 'PATCH', json: { name: rename } }); qc.invalidateQueries({ queryKey: ['me'] }); toast('نام تغییر کرد.'); } catch (err) { toast(errText(err), 'error'); } }}>
          <input className="field" value={rename} onChange={e => setRename(e.target.value)} maxLength={100} aria-label="نام فضا" dir="auto" /><button className="btn" disabled={!rename.trim()}>ذخیره</button>
        </form></section> : null}
      {admin ? <section className="card settings-section"><h2>فضای دانش جدید</h2>
        <form onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api('/workspaces', { json: { name, slug } }); setName(''); setSlug(''); await qc.invalidateQueries({ queryKey: ['me'] }); toast('فضای جدید ساخته شد.'); } catch (err) { toast(errText(err), 'error'); } finally { setBusy(false); } }}>
          <div className="settings-profile">
            <Field label="نام" id="nw-name"><input id="nw-name" className="field" value={name} onChange={e => setName(e.target.value)} maxLength={100} required dir="auto" /></Field>
            <Field label="نام پوشه (slug)" id="nw-slug" help="حروف کوچک لاتین، رقم و خط تیره"><input id="nw-slug" className="field ltr" value={slug} onChange={e => setSlug(e.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9-]{1,40}" required /></Field>
          </div>
          <button className="btn primary" disabled={busy}>ساخت فضا</button>
        </form></section> : null}
    </>
  );
}

function Security() {
  const me = useMe(); const qc = useQueryClient(); const stepUp = useStepUp(me.user.totpEnabled);
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [next2, setNext2] = useState(''); const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState<{ secret: string; uri: string } | null>(null); const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null); const [disable, setDisable] = useState(false);
  const run = (fn: () => Promise<void>) => stepUp.run(fn).catch(err => toast(errText(err), 'error'));
  return (
    <>
      <section className="card settings-section"><h2>تغییر گذرواژه</h2>
        <form onSubmit={async e => { e.preventDefault(); if (next !== next2) { toast('تکرار گذرواژه یکسان نیست.', 'error'); return; } setBusy(true);
          try { await api('/auth/password', { json: { current: cur, next } }); setCur(''); setNext(''); setNext2(''); toast('گذرواژه تغییر کرد؛ نشست‌های دیگر لغو شدند.'); } catch (err) { toast(errText(err), 'error'); } finally { setBusy(false); } }}>
          <div className="settings-profile">
            <Field label="گذرواژهٔ فعلی" id="pw-cur"><input id="pw-cur" className="field" type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} required /></Field>
            <span />
            <Field label="گذرواژهٔ جدید" id="pw-new" help="دست‌کم ۱۲ نویسه"><input id="pw-new" className="field" type="password" autoComplete="new-password" minLength={12} value={next} onChange={e => setNext(e.target.value)} required /></Field>
            <Field label="تکرار گذرواژهٔ جدید" id="pw-new2"><input id="pw-new2" className="field" type="password" autoComplete="new-password" minLength={12} value={next2} onChange={e => setNext2(e.target.value)} required /></Field>
          </div>
          <button className="btn primary" disabled={busy}>تغییر گذرواژه</button>
        </form>
      </section>
      <section className="card settings-section"><h2>تأیید دومرحله‌ای (TOTP)</h2>
        {codes ? <>
          <Notice kind="warning">این کدهای بازیابی فقط همین یک بار نمایش داده می‌شوند. هر کد یک بار مصرف دارد؛ آن‌ها را جای امنی نگه دار.</Notice>
          <div className="pw-codes">{codes.map(c => <code key={c} className="mono">{c}</code>)}</div>
          <div className="row"><button className="btn" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('کپی شد.'), () => toast('کپی ناموفق بود.', 'error'))}><Icon name="copy" size="sm" /> کپی کدها</button><button className="btn primary" onClick={() => setCodes(null)}>ذخیره کردم</button></div>
        </> : me.user.totpEnabled ? <div className="setting-row"><div><h3>فعال است</h3><p>هنگام ورود و تأیید عملیات حساس، کد شش‌رقمی لازم است.</p></div><button className="btn small danger" onClick={() => setDisable(true)}>غیرفعال‌سازی</button></div>
          : enroll ? <>
            <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>این کلید را در برنامهٔ احراز هویت (مثل Aegis یا Google Authenticator) وارد کن. برای حفظ محرمانگی، QR از سرویس بیرونی ساخته نمی‌شود.</p>
            <Field label="کلید (Base32)" id="totp-secret"><div id="totp-secret" className="pw-secret mono">{enroll.secret}</div></Field>
            <Field label="نشانی otpauth" id="totp-uri"><div id="totp-uri" className="pw-secret mono">{enroll.uri}</div></Field>
            <form className="row" onSubmit={e => { e.preventDefault(); run(async () => { const r = await api<{ recoveryCodes: string[] }>('/auth/totp/confirm', { json: { code } }); setCodes(r.recoveryCodes); setEnroll(null); setCode(''); qc.invalidateQueries({ queryKey: ['me'] }); }); }}>
              <input className="field ltr" style={{ maxWidth: 160 }} inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value)} aria-label="کد شش‌رقمی" required autoComplete="one-time-code" />
              <button className="btn primary">تأیید و فعال‌سازی</button><button type="button" className="btn" onClick={() => setEnroll(null)}>انصراف</button>
            </form>
          </> : <div className="setting-row"><div><h3>غیرفعال</h3><p>برای حساب مدیر توصیه می‌شود.</p></div><button className="btn small primary" onClick={() => run(async () => setEnroll(await api('/auth/totp/begin', { json: {} })))}>راه‌اندازی</button></div>}
      </section>
      <ConfirmDialog open={disable} danger title="غیرفعال‌سازی تأیید دومرحله‌ای" text="کدهای بازیابی هم حذف می‌شوند." confirmLabel="غیرفعال کن" onClose={() => setDisable(false)} onConfirm={() => { setDisable(false); run(async () => { await api('/auth/totp/disable', { json: {} }); toast('غیرفعال شد.'); qc.invalidateQueries({ queryKey: ['me'] }); }); }} />
      {stepUp.dialog}
    </>
  );
}

function Sessions() {
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api('/auth/sessions') }); const qc = useQueryClient(); const nav = useNavigate();
  const [all, setAll] = useState(false);
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <section className="card settings-section"><h2>نشست‌های فعال</h2>
      {q.data.sessions.map((s: any) => (
        <div key={s.id} className="setting-row"><div><h3>{s.current ? <Chip color="green">همین دستگاه</Chip> : null} <span className="ltr">{(s.user_agent || 'نامشخص').slice(0, 80)}</span></h3><p>آخرین فعالیت {relative(s.last_seen_at)} · شروع {dateTime(s.created_at)} · IP <span className="mono">{s.ip ?? '—'}</span> · انقضا {dateTime(s.expires_at)}</p></div>
          {s.current ? <button className="btn small" onClick={async () => { try { await api('/auth/logout', { json: {} }); } finally { qc.clear(); nav('/login'); } }}>خروج</button>
            : <button className="btn small" onClick={async () => { try { await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }); q.refetch(); } catch (err) { toast(errText(err), 'error'); } }}>لغو نشست</button>}
        </div>))}
      <div className="setting-row"><div><h3>خروج از همهٔ نشست‌ها</h3><p>همهٔ دستگاه‌ها، از جمله همین مرورگر، خارج می‌شوند.</p></div><button className="btn small danger" onClick={() => setAll(true)}>خروج از همه</button></div>
      <ConfirmDialog open={all} danger title="خروج از همهٔ نشست‌ها" text="پس از این کار باید دوباره وارد شوی." confirmLabel="خروج از همه" onClose={() => setAll(false)} onConfirm={async () => { try { await api('/auth/logout-all', { json: {} }); } catch (err) { toast(errText(err), 'error'); } finally { qc.clear(); nav('/login'); } }} />
    </section>
  );
}

function Connections() {
  return (
    <section className="card settings-section"><h2>اتصال‌های Claude</h2>
      <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>ورود به این برنامه، اتصال API مدل و ورود حساب در محیط رسمی Claude Code سه موضوع جدا هستند و وضعیت هرکدام مستقل نمایش داده می‌شود.</p>
      <div className="grid-2">
        <Link className="card pw-conn" to="/settings/integrations/claude"><Tile icon="spark" color="blue" /><div><h3>اتصال API Claude</h3><p className="muted" style={{ fontSize: 11 }}>تنها مسیر قابلیت‌های خودکار (پردازش منبع، پرسش، خروجی، زمان‌بندی) با کلید API خود مالک و صورتحساب API.</p></div></Link>
        <Link className="card pw-conn" to="/settings/integrations/claude#native"><Tile icon="monitor" color="purple" /><div><h3>محیط تعاملی رسمی Claude Code</h3><p className="muted" style={{ fontSize: 11 }}>ورود مستقیم خود مالک به باینری رسمی در ترمینال خصوصی؛ به صف خودکار یا API برنامه وصل نمی‌شود.</p></div></Link>
      </div>
    </section>
  );
}

function Data() {
  const me = useMe();
  return (
    <section className="card settings-section"><h2>داده و پشتیبان</h2>
      <div className="setting-row"><div><h3>خروجی قابل حمل</h3><p>فایل‌های Markdown هر صفحه از کتابخانه و خروجی‌ها از استودیو قابل دریافت‌اند؛ بدون credential یا نشست.</p></div><Link className="btn small" to="/library">کتابخانه</Link></div>
      <div className="setting-row"><div><h3>انتقال داده</h3><p>خروجی ZIP قابل حمل (Markdown و فایل‌های خام، بدون credential)، ورود از نسخهٔ HTML قبلی و ورود vault موجود به‌صورت پیشنهاد.</p></div><Link className="btn small" to="/transfer">انتقال داده</Link></div>
      <div className="setting-row"><div><h3>پشتیبان عملیاتی</h3><p>دیتابیس و فایل‌های vault در یک نقطهٔ سازگار، با manifest و checksum؛ برای بازیابی کامل. کلید اصلی داخل آرشیو نیست.</p></div>{me.user.isAdmin ? <Link className="btn small" to="/admin/backups">مدیریت پشتیبان</Link> : <span className="muted" style={{ fontSize: 11 }}>فقط مدیر</span>}</div>
      <Notice>نگه‌داشتن یک کپی روی همان دیسک یا فقط Git، پشتیبان کامل نیست؛ آرشیو را به مقصد دیگری منتقل کن.</Notice>
    </section>
  );
}

export default function SettingsPage() {
  const { section = 'general' } = useParams(); const me = useMe();
  const cur = SECTIONS.some(s => s[0] === section) ? section : 'general';
  return (
    <>
      <PageHeader title="تنظیمات" description="فضای دانش تو، با ترجیح‌ها و قواعد خودت." />
      <nav className="settings-nav" aria-label="بخش‌های تنظیمات">
        {SECTIONS.map(([id, l]) => <NavLink key={id} to={id === 'general' ? '/settings' : `/settings/${id}`} end className={() => `setting-option ${cur === id ? 'active' : ''}`}>{l}</NavLink>)}
        {me.user.isAdmin ? <>
          <NavLink to="/settings/integrations/claude" className="setting-option"><Icon name="spark" size="sm" />اتصال Claude</NavLink>
          <NavLink to="/admin/users" className="setting-option"><Icon name="settings" size="sm" />کاربران</NavLink>
          <NavLink to="/admin/audit" className="setting-option"><Icon name="shield" size="sm" />گزارش audit</NavLink>
          <NavLink to="/admin/backups" className="setting-option"><Icon name="database" size="sm" />پشتیبان</NavLink>
        </> : null}
      </nav>
      {cur === 'general' ? <General /> : cur === 'workspaces' ? <Workspaces /> : cur === 'security' ? <Security /> : cur === 'sessions' ? <Sessions /> : cur === 'connections' ? <Connections /> : <Data />}
    </>
  );
}
