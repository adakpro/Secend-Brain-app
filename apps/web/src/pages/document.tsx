import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, download } from '../lib/api';
import { num, dateTime, relative, kindMeta, isLatin } from '../lib/format';
import { Icon, Tile, Chip, Card, ErrorState, LoadingState, Modal, Notice, ConfirmDialog, toast, errText } from '../components/ui';
import { Markdown } from '../components/content';
import { useWorkspace, canEdit } from '../session';

const AUTHOR: Record<string, string> = { user: 'ویرایش کاربر', agent: 'پیشنهاد پذیرفته‌شده', external: 'تغییر بیرونی (Obsidian/دیسک)', import: 'واردشده از vault', system: 'سیستم', rollback: 'بازگردانی', native_import: 'محیط تعاملی' };
const SENS: Record<string, string> = { public: 'عمومی', private_model: 'خصوصی؛ مجاز برای مدل', no_external: 'عدم ارسال بیرونی' };

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';

export default function DocumentPage() {
  const { id = '' } = useParams();
  const ws = useWorkspace(); const qc = useQueryClient();
  const writer = canEdit(ws?.role ?? 'viewer');
  const isAdmin = ws?.role === 'owner' || ws?.role === 'admin';
  const q = useQuery({ queryKey: ['document', id], queryFn: () => api(`/documents/${id}`) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const [revView, setRevView] = useState<any | null>(null);
  const [tagText, setTagText] = useState('');
  const [tagBusy, setTagBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const baseRef = useRef(base); baseRef.current = base;

  const doc = q.data?.document;
  const readOnlyKind = doc && ['index', 'log'].includes(doc.kind);
  const dirty = editing && doc && (save === 'dirty' || save === 'saving' || save === 'conflict' || save === 'error') && draft !== undefined;

  useEffect(() => { if (doc) setTagText((doc.tags ?? []).join('، ')); }, [doc?.revisionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving with unsaved text: browser-level and in-app navigation are both guarded.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const blocker = useBlocker(!!dirty);

  const startEdit = () => { if (!doc) return; setDraft(doc.content); setBase(doc.revisionId); setSave('idle'); setEditing(true); };

  const doSave = useCallback(async () => {
    if (!baseRef.current) return;
    setSave('saving');
    const content = draftRef.current;
    try {
      const r = await api<{ revisionId: string }>(`/documents/${id}`, { method: 'PUT', json: { content, baseRevisionId: baseRef.current } });
      setBase(r.revisionId);
      setSave(draftRef.current === content ? 'saved' : 'dirty');
      qc.invalidateQueries({ queryKey: ['document', id] });
      qc.invalidateQueries({ queryKey: ['documents'] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setSave('conflict');
      else { setSave('error'); toast(errText(e), 'error'); }
    }
  }, [id, qc]);

  // Debounced autosave; stops entirely once a conflict is detected.
  useEffect(() => {
    if (!editing || save !== 'dirty') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void doSave(); }, 2500);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [draft, editing, save, doSave]);

  const onChange = (v: string) => { setDraft(v); if (save !== 'conflict') setSave('dirty'); };

  const reloadServer = async () => {
    const r = await q.refetch();
    const d = r.data?.document;
    if (d) { setDraft(d.content); setBase(d.revisionId); setSave('idle'); }
  };
  const copyMine = async () => { try { await navigator.clipboard.writeText(draft); toast('متن تو در حافظهٔ موقت کپی شد.'); } catch { toast('کپی ممکن نشد؛ متن را دستی انتخاب کن.', 'error'); } };

  const saveTags = async () => {
    if (!doc) return;
    setTagBusy(true);
    try {
      const tags = tagText.split(/[,،]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 30);
      await api(`/documents/${id}/tags`, { json: { tags, baseRevisionId: doc.revisionId } });
      toast('برچسب‌ها ذخیره شد.');
      qc.invalidateQueries({ queryKey: ['document', id] }); qc.invalidateQueries({ queryKey: ['overview'] });
    } catch (e) { toast(e instanceof ApiError && e.status === 409 ? 'صفحه از زمان باز شدن تغییر کرده؛ صفحه را تازه کن.' : errText(e), 'error'); } finally { setTagBusy(false); }
  };

  const setSensitivity = async (s: string) => {
    try { await api(`/documents/${id}/meta`, { method: 'PATCH', json: { sensitivity: s } }); toast('سطح حساسیت ثبت شد.'); qc.invalidateQueries({ queryKey: ['document', id] }); }
    catch (e) { toast(errText(e), 'error'); }
  };

  const openRevision = async (revId: string) => {
    try { const r = await api(`/documents/${id}/revisions/${revId}`); setRevView(r.revision); } catch (e) { toast(errText(e), 'error'); }
  };

  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { backlinks, outgoing, history, source } = q.data as { backlinks: any[]; outgoing: any[]; history: any[]; source: { id: string; title: string } | null };
  const m = kindMeta[doc.kind] ?? kindMeta.other;
  const links: Record<string, string | null> = {};
  for (const o of outgoing) links[o.target_raw] = o.status === 'resolved' ? o.id : null;
  const current = history[0];
  const saveLabel: Record<SaveState, string> = { idle: '', dirty: 'تغییرات ذخیره‌نشده', saving: 'در حال ذخیره…', saved: 'ذخیره شد', conflict: 'تعارض؛ ذخیرهٔ خودکار متوقف شد', error: 'ذخیره ناموفق' };

  return (
    <>
      <div className="section-title">
        <div className="row" style={{ alignItems: 'flex-start', gap: 13 }}>
          <Tile icon={m.icon} color={m.color} />
          <div style={{ minWidth: 0 }}>
            <h1 className={isLatin(doc.title) ? 'ltr' : ''}>{doc.title}</h1>
            <div className="drawer-meta" style={{ margin: '8px 0 0' }}>
              <Chip>{m.label}</Chip>
              <span className="chip mono" title="مسیر فایل در vault">{doc.path}</span>
              <Chip color={doc.sensitivity === 'no_external' ? 'orange' : ''}>{SENS[doc.sensitivity] ?? doc.sensitivity}</Chip>
              {current ? <Chip color="blue">{AUTHOR[current.author_kind] ?? current.author_kind} · نسخهٔ {num(doc.revision)}</Chip> : null}
              <Chip>{relative(doc.updatedAt)}</Chip>
            </div>
          </div>
        </div>
        <div className="row-wrap">
          <Link className="btn small" to="/library"><Icon name="arrow" size="sm" />کتابخانه</Link>
          <button className="btn small" onClick={() => download(`/documents/${id}/export`)}><Icon name="download" size="sm" />دریافت Markdown</button>
          {writer && !readOnlyKind && !editing ? <button className="btn small primary" onClick={startEdit}><Icon name="edit" size="sm" />ویرایش</button> : null}
          {editing ? <button className="btn small" onClick={() => { if (dirty && !confirm('تغییرات ذخیره‌نشده از بین می‌رود. ادامه می‌دهی؟')) return; setEditing(false); setSave('idle'); }}>پایان ویرایش</button> : null}
        </div>
      </div>

      {readOnlyKind ? <Notice>این فایل ({doc.path}) را برنامه هنگام اعمال پیشنهادها نگه می‌دارد و دستی ویرایش نمی‌شود.</Notice> : null}

      {editing ? (
        <section className="card page-card" style={{ marginBottom: 15 }}>
          <div className="between" style={{ marginBottom: 12 }}>
            <h2>ویرایش Markdown</h2>
            <span className="save-indicator" aria-live="polite" style={{ color: save === 'conflict' || save === 'error' ? 'var(--red)' : save === 'dirty' ? 'var(--orange)' : undefined }}>
              {save === 'dirty' ? <span className="dirty-dot" /> : save === 'saved' ? <Icon name="check" size="sm" /> : null}{saveLabel[save]}
            </span>
          </div>
          {save === 'conflict' ? (
            <Notice kind="danger">
              <strong>این صفحه بعد از باز شدن، جای دیگری (برنامه، Obsidian یا دیسک) تغییر کرده است.</strong> برای جلوگیری از بازنویسی خاموش، ذخیرهٔ خودکار متوقف شد. متن خودت را کپی کن و نسخهٔ جدید را بارگذاری کن.
              <div className="row-wrap" style={{ marginTop: 10 }}>
                <button className="btn small" onClick={copyMine}><Icon name="copy" size="sm" />کپی متن من</button>
                <button className="btn small danger" onClick={reloadServer}><Icon name="refresh" size="sm" />بارگذاری نسخهٔ جدید (متن من کنار گذاشته می‌شود)</button>
              </div>
            </Notice>
          ) : null}
          <div className="editor-grid">
            <div>
              <label className="field-label" htmlFor="doc-editor">متن خام</label>
              <textarea id="doc-editor" className="field editor-area" dir="auto" value={draft} onChange={e => onChange(e.target.value)} spellCheck={false} />
              <div className="row-wrap" style={{ marginTop: 8 }}>
                <button className="btn small primary" disabled={save !== 'dirty' && save !== 'error'} onClick={() => void doSave()}>ذخیره</button>
                <span className="kbd-hint">ذخیرهٔ خودکار ۲٫۵ ثانیه پس از توقف تایپ. frontmatter، جدول، code fence، نقل‌قول و [[wikilink]] پشتیبانی می‌شوند.</span>
              </div>
            </div>
            <div>
              <span className="field-label">پیش‌نمایش</span>
              <div className="card" style={{ padding: 14, minHeight: 460, overflow: 'auto' }}><Markdown text={draft} links={links} /></div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="editor-grid" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' }}>
        {!editing ? <section className="card page-card"><Markdown text={doc.content} links={links} /></section> : <div />}
        <div className="stack">
          {source ? <Card title="منبع"><Link className="connection-item" style={{ direction: 'rtl' }} to={`/inbox/${source.id}`}><Icon name="file" size="sm" /><span>{source.title}</span></Link></Card> : null}
          <Card title={`پیوندهای ورودی (${num(backlinks.length)})`}>
            {backlinks.length ? <div className="connection-list">{backlinks.map(b => <Link key={b.id} className="connection-item" style={{ direction: 'rtl', textAlign: 'right' }} to={`/library/${b.id}`}><Icon name="triangle" /><span>{b.title}</span></Link>)}</div>
              : <p className="muted" style={{ fontSize: 11 }}>هیچ صفحه‌ای به این صفحه لینک نداده است.</p>}
          </Card>
          <Card title={`پیوندهای خروجی (${num(outgoing.length)})`}>
            {outgoing.length ? <div className="connection-list">{outgoing.map((o, i) => o.status === 'resolved'
              ? <Link key={i} className="connection-item" style={{ direction: 'rtl', textAlign: 'right' }} to={`/library/${o.id}`}><Icon name="triangle" /><span>{o.title}</span></Link>
              : <div key={i} className="connection-item" style={{ direction: 'rtl', textAlign: 'right', cursor: 'default' }}><Icon name="info" /><span>{o.target_raw}</span><Chip color="orange">{o.status === 'missing' ? 'خلأ: صفحه وجود ندارد' : 'مبهم: چند صفحهٔ هم‌نام'}</Chip></div>)}</div>
              : <p className="muted" style={{ fontSize: 11 }}>این صفحه لینکی ندارد.</p>}
          </Card>
          <Card title="برچسب‌ها">
            {writer && !readOnlyKind ? (
              <div>
                <input className="field" aria-label="برچسب‌ها" value={tagText} onChange={e => setTagText(e.target.value)} dir="auto" disabled={!!dirty} />
                <div className="row-wrap" style={{ marginTop: 8 }}><button className="btn small" disabled={tagBusy || !!dirty} onClick={saveTags}>ذخیرهٔ برچسب‌ها</button>{dirty ? <span className="kbd-hint">ابتدا ویرایش متن را ذخیره کن.</span> : null}</div>
              </div>
            ) : <div className="tag-list">{(doc.tags ?? []).map((t: string) => <Link key={t} className="tag" to={`/library?tag=${encodeURIComponent(t)}`}>#{t}</Link>)}{!(doc.tags ?? []).length ? <span className="muted" style={{ fontSize: 11 }}>بدون برچسب</span> : null}</div>}
          </Card>
          {isAdmin ? (
            <Card title="حساسیت">
              <select className="field" aria-label="سطح حساسیت" value={doc.sensitivity} onChange={e => setSensitivity(e.target.value)}>
                {Object.entries(SENS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <p className="field-help">«عدم ارسال بیرونی» این صفحه را از همهٔ جست‌وجوهای مدل و اجرای عامل خارج می‌کند.</p>
            </Card>
          ) : null}
          <Card title={`تاریخچه (${num(history.length)})`}>
            <div className="update-list">
              {history.map(h => (
                <button key={h.id} className="list-row" style={{ background: 'none', border: 0, width: '100%', textAlign: 'right', cursor: 'pointer' }} onClick={() => openRevision(h.id)}>
                  <span className="grow"><span style={{ display: 'block', fontSize: 12 }}>نسخهٔ {num(h.revision)} · {AUTHOR[h.author_kind] ?? h.author_kind}</span><span className="muted" style={{ fontSize: 10 }}>{dateTime(h.created_at)}{h.display_name ? ` · ${h.display_name}` : ''}</span></span>
                  {h.changeset_id ? <Link className="text-link" to={`/review/${h.changeset_id}`} onClick={e => e.stopPropagation()}>بسته</Link> : null}
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Modal open={!!revView} title={revView ? `نسخهٔ ${num(revView.revision)} — فقط خواندنی` : ''} onClose={() => setRevView(null)} wide>
        {revView ? <>
          <p className="muted" style={{ fontSize: 11, marginBottom: 12 }}>{AUTHOR[revView.author_kind] ?? revView.author_kind} · {dateTime(revView.created_at)}</p>
          <div className="card" style={{ padding: 14 }}><Markdown text={revView.content} links={links} /></div>
        </> : null}
      </Modal>
      <ConfirmDialog open={blocker.state === 'blocked'} title="تغییرات ذخیره نشده" text="متن ویرایش‌شده هنوز ذخیره نشده است. اگر خارج شوی از بین می‌رود." confirmLabel="خروج بدون ذخیره" danger
        onConfirm={() => blocker.proceed?.()} onClose={() => blocker.reset?.()} />
    </>
  );
}
