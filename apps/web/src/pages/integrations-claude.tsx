import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { num, dateTime } from '../lib/format';
import { PageHeader, Notice, Chip, Icon, Field, ConfirmDialog, ErrorState, LoadingState, Modal, toast, errText } from '../components/ui';
import { useStepUp } from '../components/content';
import { useMe } from '../session';
import { NativeTerminal } from '../components/claude-task';

function Pill({ kind, children }: { kind: 'ok' | 'bad' | 'warn' | 'off'; children: React.ReactNode }) {
  return <span className={`state-pill ${kind === 'off' ? '' : kind}`}><span className="dot" />{children}</span>;
}

function ApiCard() {
  const me = useMe(); const qc = useQueryClient(); const step = useStepUp(me.user.totpEnabled);
  const q = useQuery({ queryKey: ['claude-api'], queryFn: () => api('/admin/integrations/claude/api') });
  const [label, setLabel] = useState('Anthropic API');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<any>(null);
  const [disconnect, setDisconnect] = useState(false);
  const [cancelRuns, setCancelRuns] = useState(false);
  const [genConfirm, setGenConfirm] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  useEffect(() => { if (q.data?.credential) setSettings({ ...q.data.credential.settings }); }, [q.data?.credential?.id, q.data?.credential?.settings?.model]);
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const c = q.data.credential; const mock = q.data.mode === 'mock';
  const refresh = () => { qc.invalidateQueries({ queryKey: ['claude-api'] }); qc.invalidateQueries({ queryKey: ['system-status'] }); };
  const storeKey = (e: React.FormEvent) => {
    e.preventDefault();
    const k = key; // key lives only in this component state until sent; cleared immediately after
    void step.run(async () => {
      setBusy('store');
      try { const r = await api('/admin/integrations/claude/api/key', { json: { label, apiKey: k } }); setKey(''); setLastTest(r.test); toast(r.test.ok ? 'کلید ذخیره و اعتبارسنجی شد.' : `کلید ذخیره شد اما آزمون ناموفق بود: ${r.test.message}`, r.test.ok ? 'ok' : 'error'); refresh(); }
      catch (err) { setKey(''); throw err; }
      finally { setBusy(null); }
    }).catch(err => toast(errText(err), 'error'));
  };
  const test = async (kind: 'validate' | 'generate') => {
    setBusy(kind);
    try { await step.run(async () => { const r = await api('/admin/integrations/claude/api/test', { json: { kind } }); setLastTest(r); toast(r.ok ? (kind === 'validate' ? 'کلید معتبر است و فهرست مدل‌ها به‌روز شد.' : 'درخواست آزمایشی تولید متن موفق بود.') : r.message, r.ok ? 'ok' : 'error'); refresh(); }); }
    catch (err) { toast(errText(err), 'error'); } finally { setBusy(null); setGenConfirm(false); }
  };
  const saveSettings = async () => {
    setBusy('settings');
    try { await step.run(async () => { await api('/admin/integrations/claude/api/settings', { method: 'PATCH', json: settings }); toast('تنظیمات ذخیره شد.'); refresh(); }); }
    catch (err) { toast(errText(err), 'error'); } finally { setBusy(null); }
  };
  const doDisconnect = async () => {
    try { await step.run(async () => { const r = await api('/admin/integrations/claude/api/disconnect', { json: { cancelActiveRuns: cancelRuns } }); toast(`اتصال محلی قطع شد؛ ${num(r.revokedTokens)} توکن اجرا باطل شد${cancelRuns ? ` و ${num(r.canceledRuns)} اجرا لغو شد` : ''}.`); setDisconnect(false); refresh(); }); }
    catch (err) { toast(errText(err), 'error'); }
  };
  const state = mock ? <Pill kind="warn">حالت آزمایشی mock (اتصال واقعی نیست)</Pill>
    : !c ? <Pill kind="off">متصل نیست</Pill>
    : c.status === 'valid' ? <Pill kind="ok">متصل و معتبر</Pill>
    : c.status === 'invalid' ? <Pill kind="bad">کلید نامعتبر</Pill> : <Pill kind="warn">ثبت‌شده، آزموده نشده</Pill>;
  return (
    <section className="card conn-card" aria-labelledby="api-card-title">
      <div className="between"><h2 id="api-card-title"><span className="icon-tile blue"><Icon name="spark" /></span>اتصال API برای قابلیت‌های خودکار سامانه</h2>{state}</div>
      <p className="muted" style={{ fontSize: 12, margin: '10px 0 14px' }}>مسیر رسمی همهٔ اجراهای خودکار: تحلیل منبع، پرسش مستند، استودیو، آزمون و زمان‌بندی‌ها. هزینه به حساب API شما در Claude Console تعلق می‌گیرد؛ اشتراک Pro/Max جایگزین این اتصال نیست.</p>
      {mock ? <Notice kind="warning">این نصب با <span className="mono">MODEL_PROVIDER_MODE=mock</span> در پروفایل {me.profile} اجرا می‌شود. اجراها از ارائه‌دهندهٔ آزمایشی قطعی استفاده می‌کنند و هیچ درخواستی به Anthropic نمی‌رود. در پروفایل production این حالت پذیرفته نمی‌شود.</Notice> : null}
      {c ? (
        <dl className="kv" style={{ marginBottom: 14 }}>
          <dt>نام اتصال</dt><dd>{c.label}</dd>
          <dt>کلید</dt><dd className="mono">••••{c.last4} · fp {c.fingerprint}</dd>
          <dt>آخرین آزمون</dt><dd>{c.lastTestedAt ? `${dateTime(c.lastTestedAt)} (${c.lastTestKind === 'generate' ? 'تولید متن' : 'اعتبارسنجی بدون هزینه'})` : 'هنوز آزموده نشده'}{c.lastErrorCode ? <> — <span style={{ color: 'var(--red)' }}>{c.lastErrorMessage}</span></> : null}</dd>
          <dt>مدل‌های در دسترس</dt><dd>{num(c.availableModels.length)} مدل از فهرست واقعی همین کلید</dd>
          <dt>مصرف امروز</dt><dd>{num(q.data.usageToday.runs)} اجرا · {num(q.data.usageToday.input_tokens)} توکن ورودی / {num(q.data.usageToday.output_tokens)} خروجی · ≈ ${Number(q.data.usageToday.cost).toFixed(4)} <span className="muted">({q.data.usageToday.costLabel})</span></dd>
          <dt>اجرای فعال</dt><dd>{num(q.data.activeRuns)}</dd>
        </dl>) : null}
      {lastTest && !lastTest.ok ? <Notice kind="danger">آزمون ناموفق ({lastTest.code}): {lastTest.message}</Notice> : null}
      {c && settings ? (
        <div className="settings-section" style={{ padding: 0, boxShadow: 'none', border: 0 }}>
          <h3 style={{ fontSize: 13, margin: '6px 0 10px' }}>تنظیمات اجرا</h3>
          <div className="settings-profile">
            <Field label="مدل پیش‌فرض" id="m-model" help="فقط از مدل‌هایی که همین کلید واقعاً می‌بیند.">
              <select id="m-model" className="field ltr" value={settings.model ?? ''} onChange={e => setSettings({ ...settings, model: e.target.value || undefined })}><option value="">انتخاب مدل…</option>{c.availableModels.map((m: any) => <option key={m.id} value={m.id}>{m.display_name ? `${m.display_name} — ${m.id}` : m.id}</option>)}</select>
            </Field>
            <Field label="سقف خروجی هر درخواست (توکن)" id="m-out"><input id="m-out" className="field ltr" type="number" min={256} max={64000} value={settings.maxOutputTokens ?? 16000} onChange={e => setSettings({ ...settings, maxOutputTokens: Number(e.target.value) })} /></Field>
            <Field label="سقف هزینهٔ هر اجرا (USD، تخمین SDK)" id="m-run"><input id="m-run" className="field ltr" type="number" step="0.05" min={0.01} max={50} value={settings.perRunBudgetUsd ?? 0.5} onChange={e => setSettings({ ...settings, perRunBudgetUsd: Number(e.target.value) })} /></Field>
            <Field label="سقف روزانه (USD، تخمین)" id="m-day"><input id="m-day" className="field ltr" type="number" step="0.5" min={0.01} max={500} value={settings.dailyBudgetUsd ?? 5} onChange={e => setSettings({ ...settings, dailyBudgetUsd: Number(e.target.value) })} /></Field>
            <Field label="مهلت اجرا (ثانیه)" id="m-to"><input id="m-to" className="field ltr" type="number" min={30} max={3600} value={settings.timeoutS ?? 300} onChange={e => setSettings({ ...settings, timeoutS: Number(e.target.value) })} /></Field>
            <Field label="هم‌زمانی" id="m-cc" help="تعداد اجرای هم‌زمان در worker با متغیر RUN_CONCURRENCY محدود می‌شود."><input id="m-cc" className="field ltr" type="number" min={1} max={8} value={settings.concurrency ?? 2} onChange={e => setSettings({ ...settings, concurrency: Number(e.target.value) })} /></Field>
            <Field label="هنگام قطع اتصال، اجراهای فعال" id="m-pol"><select id="m-pol" className="field" value={settings.activeRunPolicy ?? 'let_finish'} onChange={e => setSettings({ ...settings, activeRunPolicy: e.target.value })}><option value="let_finish">پرسیده شود (پیش‌فرض: لغو نشوند)</option><option value="cancel">لغو شوند</option></select></Field>
          </div>
          <p className="field-help">سقف‌ها حد مصرف همین برنامه‌اند، نه صورتحساب قطعی Anthropic؛ هزینه‌ها تخمین سمت کلاینت SDK هستند.</p>
          <div className="row-wrap" style={{ marginTop: 10 }}><button className="btn primary" onClick={saveSettings} disabled={busy === 'settings'}>ذخیرهٔ تنظیمات</button></div>
        </div>) : null}
      <div className="row-wrap" style={{ margin: '16px 0' }}>
        {c ? <>
          <button className="btn" onClick={() => test('validate')} disabled={!!busy}><Icon name="check-circle" size="sm" />{busy === 'validate' ? 'در حال آزمون…' : 'آزمون اعتبار و مدل‌ها (بدون هزینه)'}</button>
          <button className="btn" onClick={() => setGenConfirm(true)} disabled={!!busy || !c.settings.model}><Icon name="spark" size="sm" />آزمون تولید متن (هزینه‌دار)</button>
          <button className="btn danger" onClick={() => setDisconnect(true)}><Icon name="close" size="sm" />قطع اتصال</button>
        </> : null}
      </div>
      <form onSubmit={storeKey} autoComplete="off" className="card page-card" style={{ background: 'var(--surface2)' }}>
        <h3 style={{ fontSize: 13, marginBottom: 12 }}>{c ? 'تعویض کلید API' : 'ثبت کلید API'}</h3>
        <div className="settings-profile">
          <Field label="نام اتصال" id="k-label"><input id="k-label" className="field" value={label} onChange={e => setLabel(e.target.value)} maxLength={100} /></Field>
          <Field label="API Key" id="k-key" help="فقط به سرور همین نصب فرستاده و سمت سرور رمز می‌شود؛ دوباره نمایش داده نمی‌شود."><input id="k-key" className="field ltr" type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} required minLength={20} /></Field>
        </div>
        <div className="row-wrap"><button className="btn primary" disabled={key.length < 20 || busy === 'store'}><Icon name="shield" size="sm" />{busy === 'store' ? 'در حال ذخیره…' : 'ذخیره و اعتبارسنجی'}</button><span className="field-help">کلید را از <span className="ltr">platform.claude.com › API Keys</span> بسازید.</span></div>
      </form>
      <p className="field-help" style={{ marginTop: 12 }}>{q.data.revokeHelp}</p>
      <ConfirmDialog open={genConfirm} title="آزمون تولید متن" onClose={() => setGenConfirm(false)} onConfirm={() => test('generate')} busy={busy === 'generate'} confirmLabel="ارسال درخواست آزمایشی"
        text={<p>یک درخواست کوچک (حداکثر ۱۶ توکن خروجی) با مدل <span className="mono">{c?.settings.model}</span> فرستاده می‌شود. این درخواست هزینه‌دار است.</p>} />
      <Modal open={disconnect} title="قطع اتصال API" onClose={() => setDisconnect(false)}>
        <p style={{ fontSize: 12 }}>کلید رمزشده از این نصب پاک و همهٔ توکن‌های کوتاه‌عمر اجرا باطل می‌شوند؛ اجرای جدید شروع نمی‌شود. این کار کلید را در Anthropic ابطال نمی‌کند.</p>
        <label className="check-row" style={{ margin: '12px 0' }}><input type="checkbox" checked={cancelRuns} onChange={e => setCancelRuns(e.target.checked)} /><span>{num(q.data.activeRuns)} اجرای فعال/در صف هم لغو شوند</span></label>
        <div className="dialog-actions"><button className="btn" onClick={() => setDisconnect(false)}>انصراف</button><button className="btn danger" onClick={doDisconnect}>قطع اتصال</button></div>
      </Modal>
      {step.dialog}
    </section>
  );
}

function NativeCard() {
  const me = useMe(); const qc = useQueryClient(); const step = useStepUp(me.user.totpEnabled);
  const q = useQuery({ queryKey: ['native-status'], queryFn: () => api('/admin/native-claude/status'), refetchInterval: 15000 });
  const [ticket, setTicket] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'shell'>('login');
  const [msg, setMsg] = useState<string | null>(null);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const s = q.data.status;
  const open = async (action: 'login' | 'shell') => {
    setMsg(null);
    try { await step.run(async () => { const r = await api('/admin/native-claude/sessions', { json: { action } }); setMode(action); setTicket(r.ticket); }); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : errText(e)); }
  };
  const logout = async () => { try { await step.run(async () => { const r = await api('/admin/native-claude/logout', { json: {} }); toast(r.ok ? 'خروج رسمی از حساب Claude انجام شد.' : 'خروج ناموفق بود.', r.ok ? 'ok' : 'error'); setLogoutConfirm(false); qc.invalidateQueries({ queryKey: ['native-status'] }); }); } catch (e) { toast(errText(e), 'error'); } };
  const state = !s.enabled ? <Pill kind="off">پروفایل غیرفعال</Pill> : !s.serviceUp ? <Pill kind="bad">سرویس در دسترس نیست</Pill> : s.loggedIn ? <Pill kind="ok">وارد شده ({s.authMethod})</Pill> : <Pill kind="warn">سرویس فعال، وارد نشده</Pill>;
  return (
    <section className="card conn-card" id="native" aria-labelledby="native-card-title" style={{ marginTop: 15 }}>
      <div className="between"><h2 id="native-card-title"><span className="icon-tile purple"><Icon name="monitor" /></span>محیط تعاملی رسمی؛ ورود حساب</h2>{state}</div>
      <p className="muted" style={{ fontSize: 12, margin: '10px 0 14px' }}>باینری رسمی و دست‌نخوردهٔ Claude Code در سرویس ایزولهٔ <span className="mono">native-claude</span> برای استفادهٔ مستقیم خودِ مالک. ورود فقط با جریان رسمی خود CLI داخل ترمینال انجام می‌شود؛ این برنامه گذرواژه، کوکی یا کد ورود را جمع‌آوری نمی‌کند. ورود در اینجا اتصال API بالا را فعال نمی‌کند و به صف خودکار، worker یا SDK وصل نیست.</p>
      <Notice kind="info">مبنای این تصمیم در <span className="mono">docs/CLAUDE-AUTH-DECISION.md</span> ثبت شده است (اسناد رسمی Legal and compliance و Authentication، بررسی 2026-10-06).</Notice>
      {!s.enabled || !s.serviceUp ? <Notice kind="warning">{s.reason ?? 'سرویس در دسترس نیست.'} برای فعال‌سازی: <span className="mono">docker compose --profile native up -d native-claude</span> و سپس بازخوانی این صفحه. فعال‌کردن پروفایل معادل مجوز Anthropic برای استفاده‌ای فراتر از استفادهٔ تعاملی خود مالک نیست.</Notice> : null}
      {s.serviceUp ? <dl className="kv" style={{ marginBottom: 14 }}>
        <dt>نسخهٔ باینری</dt><dd className="mono">{s.version ?? '—'}</dd>
        <dt>وضعیت ورود</dt><dd>{s.loggedIn ? 'وارد شده' : 'وارد نشده'}{s.authMethod ? ` · ${s.authMethod}` : ''}</dd>
        {s.email ? <><dt>حساب</dt><dd className="ltr">{s.email}</dd></> : null}
        {s.orgName ? <><dt>سازمان</dt><dd>{s.orgName}</dd></> : null}
        <dt>فضای کار دستی</dt><dd>staging جدا از vault اصلی؛ تغییرات فقط از مسیر «آماده‌سازی برای بررسی» وارد می‌شوند.</dd>
      </dl> : null}
      {s.serviceUp ? (
        <div className="card page-card" style={{ background: 'var(--surface2)', marginBottom: 14 }}>
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>کار با اشتراک Claude (بدون API key)</h3>
          <ol style={{ fontSize: 12, lineHeight: 2.2, paddingInlineStart: 18, margin: 0 }}>
            <li>یک بار «بازکردن محیط رسمی ورود» و ورود با حساب Claude خودت{s.loggedIn ? ' — انجام شده ✓' : ''}.</li>
            <li>«آماده‌سازی staging از فضای فعلی»: صفحات، متن منابع (در <span className="mono">raw/</span>)، قواعد و مهارت‌های second-brain کپی می‌شوند.</li>
            <li>«باز کردن Claude Code در staging» و درخواست به زبان خودت، مثلاً: <span className="mono">/ingest</span> یا «منبع raw/… را وارد ویکی کن» یا «/ask مدیریت دانش یعنی چه؟».</li>
            <li>پس از پایان، ترمینال را ببند و «آماده‌سازی تغییرات برای بررسی» را بزن؛ تفاوت‌ها در مرکز بررسی نمایش داده و فقط با تأیید تو اعمال می‌شوند.</li>
          </ol>
          <p className="field-help" style={{ marginTop: 8 }}>این مسیر استفادهٔ تعاملی خودِ توست؛ صف خودکار، زمان‌بندی و پاسخ ارجاع‌دار داخل صفحهٔ «پرسش» همچنان به اتصال API نیاز دارند.</p>
        </div>) : null}
      {msg ? <Notice kind="danger">{msg}</Notice> : null}
      {s.serviceUp ? <div className="row-wrap" style={{ marginBottom: 12 }}>
        <button className="btn primary" onClick={() => open('login')} disabled={!!ticket}><Icon name="external" size="sm" />بازکردن محیط رسمی ورود</button>
        <button className="btn" onClick={() => open('shell')} disabled={!!ticket || !s.loggedIn}><Icon name="monitor" size="sm" />باز کردن Claude Code در staging</button>
        <button className="btn" onClick={() => qc.invalidateQueries({ queryKey: ['native-status'] })}><Icon name="refresh" size="sm" />بررسی وضعیت (auth status)</button>
        {s.loggedIn ? <button className="btn danger" onClick={() => setLogoutConfirm(true)}>خروج از حساب Claude (logout رسمی)</button> : null}
        <button className="btn" disabled={!!ticket} onClick={async () => { try { const r = await api('/admin/native-claude/staging/prepare', { json: {} }); toast(`${num(r.files)} صفحه و ${num(r.sources)} منبع در staging آماده شد (vault اصلی دست‌نخورده است).`); } catch (e) { toast(errText(e), 'error'); } }}><Icon name="copy" size="sm" />آماده‌سازی staging از فضای فعلی</button>
        <button className="btn" disabled={!!ticket} onClick={async () => { try { const r = await api('/admin/native-claude/staging/import', { json: {} }); if (r.changesetId) toast(`${num(r.imported)} تغییر به بستهٔ پیشنهادی تبدیل شد.`, 'ok', { label: 'بررسی', run: () => { location.href = `/review/${r.changesetId}`; } }); else toast(`تغییری برای وارد کردن نبود${r.conflicts.length ? ` (${num(r.conflicts.length)} تعارض)` : ''}.`); } catch (e) { toast(errText(e), 'error'); } }}><Icon name="review" size="sm" />آماده‌سازی تغییرات برای بررسی</button>
      </div> : null}
      {ticket ? <>
        <Notice kind="warning">ترمینال خصوصی ({mode === 'login' ? 'claude auth login' : 'claude'}). لینک ورود را خود CLI چاپ می‌کند؛ اگر کدی خواست، همان‌جا در ترمینال وارد کن. هیچ کلیدفشاری یا متن ترمینال ذخیره نمی‌شود. «بستن ترمینال» با «خروج از حساب Claude» فرق دارد.</Notice>
        <NativeTerminal ticket={ticket} onClosed={why => { setTicket(null); setMsg(why); qc.invalidateQueries({ queryKey: ['native-status'] }); }} />
        <div className="row-wrap" style={{ marginTop: 10 }}><button className="btn" onClick={async () => { await api('/admin/native-claude/close', { json: {} }).catch(() => undefined); setTicket(null); qc.invalidateQueries({ queryKey: ['native-status'] }); }}>بستن ترمینال</button></div>
      </> : null}
      <ConfirmDialog open={logoutConfirm} title="خروج از حساب Claude" danger onClose={() => setLogoutConfirm(false)} onConfirm={logout} confirmLabel="claude auth logout"
        text={<p>دستور رسمی <span className="mono">claude auth logout</span> در سرویس native اجرا می‌شود و credential ذخیره‌شدهٔ CLI حذف می‌شود. نشست برنامه و اتصال API تغییری نمی‌کنند.</p>} />
      {step.dialog}
    </section>
  );
}

export default function ClaudeIntegrationPage() {
  const me = useMe();
  if (!me.user.isAdmin) return <ErrorState error={new ApiError(403, { code: 'forbidden', message: 'فقط مدیر سامانه به این بخش دسترسی دارد.', requestId: '', retryable: false })} />;
  return (
    <>
      <PageHeader title="اتصال Claude" description="دو اتصال مستقل: API برای اتوماسیون سامانه، و محیط تعاملی رسمی برای استفادهٔ مستقیم خودت." action={<Link className="btn" to="/settings/connections">بازگشت به تنظیمات</Link>} />
      <Notice kind="info" icon="info">ورود به این برنامه، اتصال API و ورود حساب در باینری رسمی Claude Code سه موضوع جدا هستند. هر کارت وضعیت خودش را دارد و موفقیت یکی، دیگری را متصل نشان نمی‌دهد.</Notice>
      <ApiCard />
      <NativeCard />
      <p className="field-help" style={{ marginTop: 12 }}><Chip>Claude</Chip> نام تجاری Anthropic است؛ این برنامه محصول Anthropic نیست.</p>
    </>
  );
}
