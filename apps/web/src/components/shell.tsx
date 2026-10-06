import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { num, relative, kindMeta, isLatin } from '../lib/format';
import { useMe, useWorkspace, applyTheme, canEdit } from '../session';
import { Icon, Tile, Toasts, toast } from './ui';
import { CommandPalette } from './command-palette';
import { AddSourceDialog } from './add-source';
import { NAV } from '../nav';
export { NAV };


function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: () => api('/workspaces/current/overview'), refetchInterval: 30_000 });
}

function NavButton({ item, badge }: { item: (typeof NAV)[number]; badge?: number }) {
  return (
    <NavLink to={item.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      <span className="nav-label">{item.label}</span>
      {badge ? <span className="badge-count" aria-label={`${badge} مورد`}>{num(badge)}</span> : <Icon name={item.icon} />}
    </NavLink>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMe(); const ws = useWorkspace(); const ov = useOverview();
  const reviews = ov.data?.counts?.reviews ?? 0;
  const initials = me.user.displayName.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('');
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} id="sidebar" aria-label="ناوبری اصلی">
      <button className="icon-btn sidebar-close" onClick={onClose} aria-label="بستن منو"><Icon name="close" /></button>
      <div className="brand">
        <div className="brand-logo" aria-hidden="true"><svg viewBox="0 0 42 42" fill="none"><path d="M19 7c-4-4-9-1-9 3-5 0-6 6-3 9-4 3-3 8 1 10-1 5 5 9 10 6V8M24 7c4-4 9-1 9 3 5 0 6 6 3 9 4 3 3 8-1 10 1 5-5 9-10 6V8" fill="#91dcc2" stroke="#142b35" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 11c4 0 1 6 5 7M7 19c7-3 9 2 5 5M10 29c1-5 7-5 8-1M30 11c-4 0-1 6-5 7M36 19c-7-3-9 2-5 5M32 29c-1-5-7-5-8-1M21 5v33" stroke="#142b35" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="17" r="1.6" fill="#142b35" /><circle cx="30" cy="26" r="1.6" fill="#142b35" /></svg></div>
        <div><div className="brand-title ltr">Second Brain OS</div><div className="brand-subtitle">منابع تو، به دانشی که واقعاً استفاده می‌کنی.</div></div>
      </div>
      <div className="nav-scroll" onClick={e => { if ((e.target as HTMLElement).closest('a')) onClose(); }}>
        <nav aria-label="بخش‌ها">
          <div className="nav-group">{NAV.slice(0, 5).map(n => <NavButton key={n.to} item={n} />)}</div>
          <div className="nav-divider" />
          <div className="nav-caption">ابزارها</div>
          <div className="nav-group">{NAV.slice(5, 10).map(n => <NavButton key={n.to} item={n} badge={n.to === '/review' ? reviews : undefined} />)}</div>
          <div className="nav-divider" />
          <NavButton item={NAV[10]} />
        </nav>
      </div>
      <div className="sidebar-bottom">
        <div className="workspace-card">
          <div className="between"><h3 style={{ fontSize: 11 }}>فضای دانش فعلی</h3><Icon name="database" /></div>
          <NavLink to="/settings/workspaces" className="workspace-name" style={{ background: 'none', border: 0, padding: 0, width: '100%', color: 'inherit' }}><span>{ws?.name}</span><Icon name="chevron" size="sm" /></NavLink>
          <div className="workspace-path">vault/{ws?.slug}/</div>
          <div className="workspace-meta">{ov.data ? `${num(ov.data.counts.knowledge)} صفحه · ${num(ov.data.counts.projects)} پروژهٔ فعال` : '…'}</div>
          <div className="storage-status"><Icon name="check-circle" /><span>ذخیره روی سرور همین نصب{ws?.isDemo ? ' · فضای نمایشی' : ''}</span></div>
        </div>
        <div className="profile">
          <span className="avatar avatar-initials" aria-hidden="true">{initials}</span>
          <div className="profile-info"><div className="profile-name">{me.user.displayName}</div><div className="profile-email">{me.user.email}</div></div>
          <NavLink className="icon-btn" to="/settings" aria-label="تنظیمات حساب"><Icon name="more" size="sm" /></NavLink>
        </div>
      </div>
    </aside>
  );
}

function ContextRail() {
  const me = useMe(); const ov = useOverview(); const loc = useLocation();
  const recent = useQuery({ queryKey: ['recent-docs', me.preferences.recentDocumentIds.join(',')], queryFn: () => api('/documents?limit=8'), staleTime: 20_000 });
  const health = useQuery({ queryKey: ['knowledge-health'], queryFn: () => api('/health/knowledge'), staleTime: 60_000 });
  const docs: any[] = recent.data?.items ?? [];
  const recentIds: string[] = me.preferences.recentDocumentIds;
  const ordered = [...recentIds.map(id => docs.find(d => d.id === id)).filter(Boolean), ...docs.filter(d => !recentIds.includes(d.id))].slice(0, 5);
  const counts = ov.data?.counts;
  if (loc.pathname.startsWith('/settings')) return null;
  return (
    <aside className="context-rail" aria-label="یادداشت‌های اخیر و اطلاعات مرتبط">
      <section className="card"><div className="card-head"><h2>اخیراً مشاهده‌شده</h2></div><div className="card-body"><div className="recent-list">
        {ordered.length ? ordered.map(d => (
          <NavLink key={d.id} className="recent-item" to={`/library/${d.id}`}>
            <Tile icon={kindMeta[d.kind]?.icon ?? 'file'} color={kindMeta[d.kind]?.color ?? 'gray'} mini />
            <span className="recent-text"><span className={`recent-title ${isLatin(d.title) ? 'ltr' : ''}`} style={{ display: 'block' }}>{d.title}</span><span className="recent-meta">نوع: {kindMeta[d.kind]?.label ?? d.kind} · {relative(d.updated_at)}</span></span>
          </NavLink>)) : <p className="muted" style={{ fontSize: 11 }}>هنوز صفحه‌ای ساخته نشده است.</p>}
      </div></div></section>
      <section className="card"><div className="card-head"><h2>ارتباط‌های پرتکرار</h2></div><div className="card-body"><div className="connection-list">
        {(health.data?.graph?.hubs ?? []).filter((h: any) => h.degree > 0).slice(0, 4).map((h: any) => <NavLink key={h.id} className="connection-item" to={`/library/${h.id}`}><Icon name="triangle" /><span>{h.title}</span></NavLink>)}
        {health.data && !(health.data.graph?.hubs ?? []).some((h: any) => h.degree > 0) ? <p className="muted" style={{ fontSize: 11, direction: 'rtl' }}>هنوز لینکی بین صفحات نیست.</p> : null}
      </div></div><div className="card-footer"><NavLink className="text-link" to="/graph">نمایش در نقشه</NavLink></div></section>
      <section className="card"><div className="card-head"><h2>برچسب‌ها</h2></div><div className="card-body"><div className="tag-list">
        {(ov.data?.tags ?? []).map((t: any) => <NavLink key={t.t} className="tag" to={`/library?tag=${encodeURIComponent(t.t)}`}>#{t.t}</NavLink>)}
        {ov.data && !ov.data.tags.length ? <p className="muted" style={{ fontSize: 11, direction: 'rtl' }}>برچسبی ثبت نشده.</p> : null}
      </div></div></section>
      <section className="card"><div className="card-head"><h2>پیشرفت امروز</h2></div><div className="card-body"><div className="daily-list">
        <div className="daily-row"><span className="daily-icon"><Icon name="check" /></span><span>{num(counts?.sources_today ?? 0)} منبع جدید اضافه‌شده</span></div>
        <div className="daily-row"><span className="daily-icon orange"><Icon name="review" /></span><span>{num(counts?.reviews ?? 0)} پیشنهاد برای بررسی</span></div>
        <div className="daily-row"><span className="daily-icon blue"><Icon name="note" /></span><span>{num(counts?.edits_today ?? 0)} ویرایش یادداشت</span></div>
        <div className="daily-row"><span className="daily-icon purple"><Icon name="spark" /></span><span>{num(counts?.quiz_today ?? 0)} تمرین مرور</span></div>
      </div></div></section>
      <div className="demo-indicator"><span className="dot" />{me.providerMode === 'mock' ? 'حالت آزمایشی: ارائه‌دهندهٔ mock (پاسخ مدل واقعی نیست)' : 'داده‌ها روی سرور همین نصب ذخیره می‌شوند'}</div>
    </aside>
  );
}

function Notifications({ onClose }: { onClose: () => void }) {
  const ov = useOverview(); const nav = useNavigate();
  const items: any[] = ov.data?.suggestions ?? [];
  return (
    <div className="popover notification-popover" role="dialog" aria-label="اعلان‌ها">
      <div className="popover-title">اعلان‌ها</div>
      {items.length ? items.map((s, i) => <button key={i} className="menu-item" onClick={() => { onClose(); nav(s.target); }}><Icon name={s.kind === 'review' ? 'review' : s.kind === 'ingest' ? 'inbox' : s.kind === 'graph' ? 'graph' : 'activity'} /><span>{s.text}</span></button>)
        : <p className="muted" style={{ padding: 10, fontSize: 11 }}>اعلان تازه‌ای نیست.</p>}
    </div>
  );
}

export function AppShell() {
  const me = useMe(); const ws = useWorkspace(); const qc = useQueryClient(); const loc = useLocation(); const nav = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState<null | 'text' | 'url' | 'file'>(null);
  const [pop, setPop] = useState<null | 'add' | 'notif'>(null);
  const ov = useOverview();
  const notifCount = (ov.data?.suggestions ?? []).length;
  const dark = document.documentElement.dataset.theme === 'dark';
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); } if (e.key === 'Escape') setPop(null); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => { setPop(null); setNavOpen(false); const t = NAV.find(n => loc.pathname.startsWith(n.to))?.label ?? 'خانه'; document.title = `${t} — Second Brain OS`; }, [loc.pathname]);
  const toggleTheme = async () => {
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { await api('/me/preferences', { method: 'PATCH', json: { theme: next } }); qc.invalidateQueries({ queryKey: ['me'] }); } catch { toast('ذخیرهٔ ترجیح ظاهر ناموفق بود.', 'error'); }
  };
  const writer = canEdit(ws?.role ?? 'viewer');
  return (
    <>
      <div className={`nav-backdrop ${navOpen ? 'open' : ''}`} onClick={() => setNavOpen(false)} />
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="shell">
        <header className="topbar">
          <div className="topbar-right">
            <button className="icon-btn mobile-menu" onClick={() => setNavOpen(true)} aria-label="باز کردن منوی اصلی" aria-controls="sidebar" aria-expanded={navOpen}><Icon name="menu" /></button>
            <button className="theme-toggle" onClick={toggleTheme} aria-label={dark ? 'تغییر به حالت روشن' : 'تغییر به حالت تاریک'} title="تغییر حالت روشن / تاریک"><span className="theme-track"><span className="theme-knob" /></span><Icon name={dark ? 'moon' : 'sun'} size="sm" /></button>
          </div>
          <button className="search-trigger" onClick={() => setPaletteOpen(true)}><Icon name="search" size="sm" /><span>جست‌وجو در همهٔ دانش، پروژه‌ها، منابع…</span><kbd className="keycap">⌘ K</kbd></button>
          <div className="topbar-left">
            <div className="add-button-group">
              <button className="add-main" onClick={() => writer ? setAddOpen('text') : toast('نقش شما اجازهٔ افزودن منبع ندارد.', 'error')}><span>افزودن</span><Icon name="plus" /></button>
              <button className="add-more" onClick={() => setPop(pop === 'add' ? null : 'add')} aria-label="گزینه‌های افزودن" aria-expanded={pop === 'add'}><Icon name="chevron" /></button>
            </div>
            <button className="icon-btn" onClick={() => setPop(pop === 'notif' ? null : 'notif')} aria-label="اعلان‌ها" aria-expanded={pop === 'notif'}><Icon name="bell" />{notifCount ? <span className="notification-badge">{num(notifCount)}</span> : null}</button>
          </div>
        </header>
        {pop === 'add' ? (
          <div className="popover" role="menu" aria-label="افزودن">
            <div className="popover-title">چه چیزی اضافه می‌کنی؟</div>
            {[['text', 'note', 'متن یا Markdown', 'چسباندن متن، یادداشت یا transcript'], ['url', 'link', 'نشانی وب', 'استخراج مقالهٔ عمومی'], ['file', 'upload', 'فایل', 'PDF، Markdown، متن یا JSON گفتگو']].map(([k, ic, t, d]) =>
              <button key={k} role="menuitem" className="menu-item" onClick={() => { setPop(null); writer ? setAddOpen(k as 'text') : toast('نقش شما اجازهٔ افزودن ندارد.', 'error'); }}><Icon name={ic} /><span>{t}<small>{d}</small></span></button>)}
            <button role="menuitem" className="menu-item" onClick={() => { setPop(null); nav('/library?new=note'); }}><Icon name="edit" /><span>یادداشت دستی<small>در پوشهٔ notes/</small></span></button>
            <button role="menuitem" className="menu-item" onClick={() => { setPop(null); nav('/projects?new=1'); }}><Icon name="folder" /><span>پروژهٔ جدید<small>هدف، کارها و منابع</small></span></button>
          </div>) : null}
        {pop === 'notif' ? <Notifications onClose={() => setPop(null)} /> : null}
        <div className="workspace-grid">
          <main className="main-content" id="main" tabIndex={-1}><div className="view" key={loc.pathname.split('/')[1]}><Outlet /></div></main>
          <ContextRail />
        </div>
      </div>
      <nav className="mobile-bottom" aria-label="دسترسی سریع موبایل">
        {NAV.slice(0, 2).map(n => <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}><Icon name={n.icon} /><span>{n.label}</span></NavLink>)}
        <button className="add-mobile" onClick={() => writer && setAddOpen('text')} aria-label="افزودن منبع"><Icon name="plus" /></button>
        {[NAV[2], NAV[3]].map(n => <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}><Icon name={n.icon} /><span>{n.to === '/ask' ? 'پرسش' : n.label}</span></NavLink>)}
      </nav>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {addOpen ? <AddSourceDialog initial={addOpen} onClose={() => setAddOpen(null)} /> : null}
      <Toasts />
      {me.profile !== 'production' ? null : null}
    </>
  );
}

export function Page({ children }: { children: ReactNode }) { return <>{children}</>; }
