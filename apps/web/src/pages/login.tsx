import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrf } from '../lib/api';
import { Icon, Notice } from '../components/ui';
import { applyTheme } from '../session';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [recovery, setRecovery] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate(); const [params] = useSearchParams(); const qc = useQueryClient();
  useEffect(() => { document.title = 'ورود — Second Brain OS'; try { applyTheme((localStorage.getItem('sb-theme') as 'light') ?? 'system'); } catch { /* ignore */ } }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api<{ csrfToken: string }>('/auth/login', { json: { email, password, ...(needs2fa && !useRecovery && totp ? { totp } : {}), ...(needs2fa && useRecovery && recovery ? { recoveryCode: recovery } : {}) } });
      setCsrf(r.csrfToken); setPassword(''); setTotp(''); setRecovery('');
      await qc.invalidateQueries({ queryKey: ['me'] });
      const next = params.get('next');
      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : '/home', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'second_factor_required') { setNeeds2fa(true); setError(''); }
      else setError(err instanceof ApiError ? err.message : 'ارتباط با سرور برقرار نشد.');
    } finally { setBusy(false); }
  };
  return (
    <div className="login-page">
      <main className="card login-card" id="main">
        <div className="brand">
          <div className="brand-logo" aria-hidden="true"><Icon name="book" /></div>
          <div><div className="brand-title ltr">Second Brain OS</div><div className="brand-subtitle">ورود به فضای دانش شخصی</div></div>
        </div>
        <div className="login-hero" aria-hidden="true" />
        <form onSubmit={submit} noValidate={false}>
          {error ? <Notice kind="danger">{error}</Notice> : null}
          <div className="form-group"><label className="field-label" htmlFor="email">ایمیل</label><input id="email" className="field ltr" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></div>
          <div className="form-group"><label className="field-label" htmlFor="password">گذرواژه</label><input id="password" className="field ltr" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
          {needs2fa ? (useRecovery
            ? <div className="form-group"><label className="field-label" htmlFor="rc">کد بازیابی</label><input id="rc" className="field ltr" value={recovery} onChange={e => setRecovery(e.target.value)} autoComplete="off" required /></div>
            : <div className="form-group"><label className="field-label" htmlFor="totp">کد تأیید دومرحله‌ای</label><input id="totp" className="field ltr" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" value={totp} onChange={e => setTotp(e.target.value)} required autoFocus /></div>) : null}
          {needs2fa ? <button type="button" className="text-link" onClick={() => setUseRecovery(!useRecovery)} style={{ marginBottom: 14 }}>{useRecovery ? 'استفاده از کد برنامهٔ احراز هویت' : 'استفاده از کد بازیابی'}</button> : null}
          <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'در حال ورود…' : 'ورود'}</button>
        </form>
        <p className="field-help" style={{ marginTop: 16, lineHeight: 2 }}>این ورود فقط برای خود برنامه است و به حساب Claude ربطی ندارد. حساب مدیر با دستور <span className="mono">./scripts/create-admin.sh</span> ساخته می‌شود؛ حساب پیش‌فرض وجود ندارد.</p>
      </main>
    </div>
  );
}
