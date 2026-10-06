import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { num, date, weekday, relative, kindMeta, isLatin } from '../lib/format';
import { Icon, Tile, ErrorState, LoadingState, Progress } from '../components/ui';
import { useMe } from '../session';

const pct = (p: { tasks: number; done: number }) => (p.tasks ? Math.round((p.done / p.tasks) * 100) : 0);

export default function HomePage() {
  const me = useMe();
  const ov = useQuery({ queryKey: ['overview'], queryFn: () => api('/workspaces/current/overview') });
  if (ov.isPending) return <LoadingState />;
  if (ov.error) return <ErrorState error={ov.error} retry={() => ov.refetch()} />;
  const d = ov.data; const c = d.counts;
  const lastDoc = d.recentDocs[0]; const project = d.projects[0];
  const stats = [
    { label: 'آنچه اضافه شده', value: c.knowledge, desc: 'صفحه در کتابخانه', color: 'purple', icon: 'bars', to: '/library' },
    { label: 'پروژه‌های فعال', value: c.projects, desc: 'در جریان', color: 'green', icon: 'folder', to: '/projects' },
    { label: 'پیشنهادهای بررسی', value: c.reviews, desc: 'منتظر تأیید', color: 'orange', icon: 'review', to: '/review' },
    { label: 'ورودی‌های جدید', value: c.inbox, desc: 'در جریان پردازش', color: 'blue', icon: 'import', to: '/inbox' },
  ];
  const sugIcon: Record<string, [string, string]> = { review: ['review', 'orange'], ingest: ['spark', 'green'], health: ['link', 'orange'], graph: ['graph', 'purple'] };
  return (
    <div className="home-grid">
      <section className="hero" aria-label="خوش‌آمدگویی">
        <div className="date-card"><div className="day">{weekday()}</div><div className="date">{date(new Date().toISOString())}</div><p>گام‌های کوچک،<br />دانش بزرگ می‌سازند.</p></div>
        <div className="hero-text"><div className="hello">سلام{me.user.displayName ? `، ${me.user.displayName}` : '،'}</div><h1>امروز روی چه چیزی کار می‌کنی؟</h1><div className="hero-quote">«دانش زمانی ارزشمند است که در عمل به کار گرفته شود.»</div></div>
      </section>
      <section className="stats-grid" aria-label="وضعیت فضای دانش">
        {stats.map(s => <Link key={s.to} className="card stat-card" to={s.to}><span className={`icon-tile ${s.color}`}><Icon name={s.icon} size="lg" /></span><span className="stat-content"><span className="stat-label" style={{ display: 'block' }}>{s.label}</span><span className={`stat-value ${s.color}`} style={{ display: 'block' }}>{num(s.value)}</span><span className="stat-caption">{s.desc}</span></span></Link>)}
      </section>
      <section className="card"><div className="card-head"><h2>ادامهٔ کار</h2></div><div className="card-body"><div className="continue-grid">
        <div className="continue-card"><div className="row"><span className="icon-tile orange"><Icon name="note" /></span><div><div className="continue-title">آخرین صفحه</div><div className={`continue-desc truncate ${lastDoc && isLatin(lastDoc.title) ? 'ltr' : ''}`}>{lastDoc?.title ?? 'هنوز صفحه‌ای نیست؛ اولین منبع را اضافه کن'}</div></div></div>
          <div className="foot"><span className="eyebrow">{lastDoc ? relative(lastDoc.updated_at) : '—'}</span>{lastDoc ? <Link className="text-link" to={`/library/${lastDoc.id}`}>ادامهٔ مطالعه</Link> : <Link className="text-link" to="/inbox">افزودن منبع</Link>}</div></div>
        <div className="continue-card"><div className="row"><span className="icon-tile teal"><Icon name="folder" /></span><div><div className="continue-title">پروژهٔ فعال</div><div className="continue-desc truncate">{project?.title ?? 'هنوز پروژه‌ای نساخته‌ای'}</div></div></div>
          <div className="foot"><div className="row" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}><span className="eyebrow">{num(project ? pct(project) : 0)}٪</span><Progress value={project ? pct(project) : 0} /></div>{project ? <Link className="btn" to={`/projects/${project.id}`}>مشاهدهٔ پروژه</Link> : <Link className="btn" to="/projects?new=1">پروژهٔ جدید</Link>}</div></div>
        <div className="continue-card"><div className="row"><span className="icon-tile blue"><Icon name="chat" /></span><div><div className="continue-title">سؤال پژوهشی</div><div className="continue-desc truncate">{d.lastConversation?.title ?? 'از منابع خودت بپرس'}</div></div></div>
          <div className="foot"><span className="eyebrow">{d.lastConversation ? relative(d.lastConversation.updated_at) : 'فقط از دانش خودت'}</span><Link className="btn" to={d.lastConversation ? `/ask/${d.lastConversation.id}` : '/ask'}>{d.lastConversation ? 'ادامهٔ گفتگو' : 'شروع پرسش'}</Link></div></div>
      </div></div></section>
      <div className="dual-grid">
        <section className="card"><div className="card-head"><h2>پیشنهادهای قابل توضیح</h2></div><div className="card-body"><div className="suggestions">
          {d.suggestions.length ? d.suggestions.slice(0, 3).map((s: any, i: number) => <Link key={i} className="suggestion" to={s.target}><Icon name="arrow" /><span className="suggestion-text">{s.text}</span><span className={`icon-tile ${sugIcon[s.kind]?.[1] ?? 'blue'}`}><Icon name={sugIcon[s.kind]?.[0] ?? 'info'} /></span></Link>)
            : <p className="muted" style={{ fontSize: 11, padding: '6px 2px' }}>فعلاً پیشنهادی نیست. هر پیشنهاد از یک شمارش واقعی (بسته‌های منتظر، منابع آماده، لینک‌های شکسته، صفحات یتیم) ساخته می‌شود.</p>}
        </div></div><div className="card-footer"><Link className="text-link" to="/review">مرکز بررسی</Link></div></section>
        <section className="card"><div className="card-head"><h2>آنچه به دانشت اضافه شده</h2></div><div className="card-body"><div className="update-list">
          {d.recentDocs.length ? d.recentDocs.slice(0, 3).map((doc: any) => <Link key={doc.id} className="update-row" to={`/library/${doc.id}`}><Tile icon={kindMeta[doc.kind]?.icon ?? 'file'} color={kindMeta[doc.kind]?.color ?? 'gray'} /><span className="update-body"><span className={`update-title ${isLatin(doc.title) ? 'ltr' : ''}`} style={{ display: 'block' }}>{doc.title}</span><span className="update-detail">{kindMeta[doc.kind]?.label} · <span className="ltr">{doc.path}</span></span></span><span className="update-time">{relative(doc.updated_at)}</span></Link>)
            : <p className="muted" style={{ fontSize: 11, padding: '6px 2px' }}>هنوز صفحه‌ای ساخته نشده است.</p>}
        </div></div><div className="card-footer"><Link className="text-link" to="/activity">نمایش همه</Link></div></section>
      </div>
      <section className="card"><div className="card-head"><h2>پروژه‌های اخیر</h2></div><div className="card-body" style={{ paddingBottom: 9 }}><div className="project-strip">
        {d.projects.length ? d.projects.map((p: any) => <Link key={p.id} className="mini-project" to={`/projects/${p.id}`}><span className={`icon-tile ${p.color}`}><Icon name="folder" /></span><span className="mini-project-content"><span className="mini-project-title" style={{ display: 'block' }}>{p.title}</span><span className="mini-project-progress"><Progress value={pct(p)} color={p.color === 'purple' ? 'purple' : p.color === 'teal' ? 'green' : ''} /><span>{num(pct(p))}٪</span></span></span></Link>)
          : <p className="muted" style={{ fontSize: 11 }}>پروژه‌ای ثبت نشده است.</p>}
      </div></div><div className="card-footer" style={{ paddingBottom: 8 }}><Link className="text-link" to="/projects">نمایش همه <Icon name="left" size="sm" /></Link></div></section>
    </div>
  );
}
