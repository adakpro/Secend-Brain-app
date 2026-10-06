import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uid, download } from '../lib/api';
import { relative, num } from '../lib/format';
import { PageHeader, Chip, Icon, Modal, Notice, ErrorState, LoadingState, ConfirmDialog, toast, errText } from '../components/ui';
import { Markdown } from '../components/content';
import { useRunStream, TOOL_LABEL } from '../lib/run-stream';
import { useWorkspace, canEdit } from '../session';
import { useNativeStatus, useClaudeJob } from '../components/claude-task';

type Scope = { type: 'workspace' | 'project' | 'documents' | 'tag'; projectId?: string; documentIds?: string[]; tag?: string };

function CitationDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['citation', id], queryFn: () => api(`/citations/${id}`), enabled: !!id });
  const c = q.data?.citation;
  return (
    <Modal open={!!id} title="ارجاع" onClose={onClose} drawer>
      {q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : c ? <>
        <div className="drawer-meta">
          <Chip color={c.validation?.valid ? 'green' : 'orange'}>{c.validation?.valid ? 'ساختار ارجاع معتبر' : `ارجاع نامعتبر: ${(c.validation?.reasons ?? []).join('، ')}`}</Chip>
          {c.stale ? <Chip color="orange">صفحه از زمان پاسخ تغییر کرده</Chip> : null}
          {c.page ? <Chip>صفحهٔ {num(c.page)}</Chip> : null}
          <Chip>کلید {c.citation_key}</Chip>
        </div>
        <h2 dir="auto" style={{ marginBottom: 8 }}>{c.doc_title ?? c.source_title ?? c.title}</h2>
        {c.heading ? <p className="muted" style={{ fontSize: 11 }}>بخش: {c.heading}</p> : null}
        <blockquote className="note-prose" dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{c.excerpt}</blockquote>
        {c.validation?.quote ? <p className="field-help">نقل‌قول مدل: «{c.validation.quote}»</p> : null}
        <dl className="kv" style={{ marginTop: 14 }}>
          {c.path ? <><dt>مسیر</dt><dd className="mono">{c.path}</dd></> : null}
          {c.revision ? <><dt>نسخهٔ صفحه</dt><dd>{num(c.revision)}</dd></> : null}
          <dt>بازهٔ متن</dt><dd className="mono">{c.start_offset}–{c.end_offset}</dd>
        </dl>
        <p className="field-help" style={{ marginTop: 10 }}>اعتبار ساختاری یعنی این بخش واقعاً در همین اجرا بازیابی شده و نقل‌قول در آن وجود دارد؛ به معنای درستی معنایی پاسخ نیست.</p>
        <div className="note-tools">{c.document_id ? <Link className="btn small" to={`/library/${c.document_id}`} onClick={onClose}>باز کردن صفحه</Link> : null}{c.source_id ? <Link className="btn small" to={`/inbox/${c.source_id}`} onClick={onClose}>منبع</Link> : null}</div>
      </> : null}
    </Modal>
  );
}

function ScopePicker({ scope, setScope }: { scope: Scope; setScope: (s: Scope) => void }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api('/projects') });
  const tags = useQuery({ queryKey: ['overview'], queryFn: () => api('/workspaces/current/overview') });
  return (
    <div className="scope-bar">
      <Icon name="shield" size="sm" /><span>محدودهٔ پرسش:</span>
      <select className="field" style={{ width: 'auto', padding: '4px 8px' }} aria-label="نوع محدوده" value={scope.type} onChange={e => setScope({ type: e.target.value as Scope['type'] })}>
        <option value="workspace">کل فضای دانش</option><option value="project">یک پروژه</option><option value="tag">یک برچسب</option>
      </select>
      {scope.type === 'project' ? <select className="field" style={{ width: 'auto', padding: '4px 8px' }} aria-label="پروژه" value={scope.projectId ?? ''} onChange={e => setScope({ type: 'project', projectId: e.target.value })}><option value="">انتخاب…</option>{(projects.data?.items ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select> : null}
      {scope.type === 'tag' ? <select className="field" style={{ width: 'auto', padding: '4px 8px' }} aria-label="برچسب" value={scope.tag ?? ''} onChange={e => setScope({ type: 'tag', tag: e.target.value })}><option value="">انتخاب…</option>{(tags.data?.tags ?? []).map((t: any) => <option key={t.t} value={t.t}>#{t.t}</option>)}</select> : null}
      {scope.type === 'documents' ? <Chip>{num(scope.documentIds?.length ?? 0)} صفحهٔ انتخابی</Chip> : null}
      <span className="muted">فقط دانش خودت · وب‌گردی خاموش</span>
    </div>
  );
}

export default function AskPage() {
  const { id } = useParams(); const [params] = useSearchParams(); const nav = useNavigate(); const qc = useQueryClient(); const ws = useWorkspace();
  const [scope, setScope] = useState<Scope>(params.get('project') ? { type: 'project', projectId: params.get('project')! } : { type: 'workspace' });
  const [input, setInput] = useState(params.get('q') ?? '');
  const [runId, setRunId] = useState<string | null>(null);
  const [cite, setCite] = useState<string | null>(null);
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toNote, setToNote] = useState<{ id: string; project?: string } | null>(null);
  const native = useNativeStatus();
  const claude = useClaudeJob();
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api('/system/status') });
  const list = useQuery({ queryKey: ['conversations'], queryFn: () => api('/conversations') });
  const conv = useQuery({ queryKey: ['conversation', id], queryFn: () => api(`/conversations/${id}`), enabled: !!id });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api('/projects') });
  useEffect(() => { if (conv.data?.pendingRun) setRunId(conv.data.pendingRun.id); }, [conv.data?.pendingRun?.id]);
  useEffect(() => { if (conv.data?.conversation?.scope) setScope(conv.data.conversation.scope); }, [conv.data?.conversation?.id]);
  const stream = useRunStream(runId, () => { setRunId(null); qc.invalidateQueries({ queryKey: ['conversation', id] }); qc.invalidateQueries({ queryKey: ['conversations'] }); });
  const chatEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [conv.data?.messages?.length, stream.text]);
  const modelOk = status.data?.capabilities?.modelFeatures;
  const mock = status.data?.capabilities?.provider === 'mock';
  const send = async (question: string) => {
    if (!question.trim() || busy || runId) return;
    if (scope.type === 'project' && !scope.projectId) { toast('پروژه را انتخاب کن.', 'error'); return; }
    if (scope.type === 'tag' && !scope.tag) { toast('برچسب را انتخاب کن.', 'error'); return; }
    setBusy(true);
    if (!modelOk && native.data?.loggedIn) {
      // No API key, but the owner is signed in to Claude Code: answer with the subscription in the background.
      try { const r = await claude.start({ kind: 'ask', question, conversationId: id }); if (r) { setInput(''); setRunId(r.runId); if (!id && r.conversationId) nav(`/ask/${r.conversationId}`, { replace: true }); qc.invalidateQueries({ queryKey: ['conversation', r.conversationId] }); qc.invalidateQueries({ queryKey: ['conversations'] }); } }
      catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
      return;
    }
    try {
      const r = await api('/ask', { json: { question, conversationId: id, scope, idempotencyKey: uid() } });
      setInput('');
      if (r.runId) setRunId(r.runId);
      if (!id) nav(`/ask/${r.conversationId}`, { replace: true });
      qc.invalidateQueries({ queryKey: ['conversation', r.conversationId] }); qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const stop = async () => { if (!runId) return; try { await api(`/runs/${runId}/cancel`, { json: {} }); toast('درخواست توقف ثبت شد.'); } catch (e) { toast(errText(e), 'error'); } };
  const saveNote = async () => {
    if (!toNote) return;
    try { const r = await api(`/messages/${toNote.id}/to-note`, { json: { projectId: toNote.project || undefined } }); setToNote(null); toast('بستهٔ پیشنهادی ساخته شد؛ پس از تأیید ذخیره می‌شود.', 'ok', { label: 'بررسی', run: () => nav(`/review/${r.changesetId}`) }); }
    catch (e) { toast(errText(e), 'error'); }
  };
  const messages: any[] = conv.data?.messages ?? [];
  return (
    <>
      <PageHeader title="پرسش از دانش" description="سؤال خوب، نقطهٔ شروع یک ارتباط تازه است."
        action={<div className="row-wrap">{status.data ? (modelOk ? <Chip color={mock ? 'orange' : 'teal'}><Icon name="spark" size="sm" />{mock ? 'ارائه‌دهندهٔ آزمایشی mock' : 'پاسخ مدل با ارجاع'}</Chip> : native.data?.loggedIn ? <Chip color="teal"><Icon name="spark" size="sm" />Claude (اشتراک)</Chip> : <Chip color="blue"><Icon name="search" size="sm" />حالت جست‌وجوی متنی</Chip>) : null}
          {id ? <><button className="btn small" onClick={() => download(`/conversations/${id}/export`)}><Icon name="download" size="sm" />خروجی</button><button className="btn small" onClick={() => setDel(true)}><Icon name="trash" size="sm" /></button><Link className="btn small" to="/ask">گفتگوی تازه</Link></> : null}</div>} />
      {status.data && !modelOk && !native.data?.loggedIn ? <Notice kind="warning">{status.data.capabilities.modelFeaturesReason} تا آن زمان، پرسش‌ها با جست‌وجوی متنی پاسخ داده می‌شوند و نتیجه با برچسب «پاسخ مدل نیست» نمایش داده می‌شود؛ <Link to="/settings/integrations/claude#native">یا با اشتراک Claude در محیط تعاملی Claude Code کار کن</Link>.</Notice> : null}
      {(list.data?.items ?? []).length && !id ? <div className="row-wrap" style={{ marginBottom: 12 }}><span className="muted" style={{ fontSize: 11 }}>گفتگوهای اخیر:</span>{list.data.items.slice(0, 6).map((c: any) => <Link key={c.id} className="tag" to={`/ask/${c.id}`}>{c.title || 'بی‌عنوان'} · {relative(c.updated_at)}</Link>)}</div> : null}
      <div className="card ask-layout">
        <ScopePicker scope={scope} setScope={setScope} />
        {id && conv.error ? <ErrorState error={conv.error} /> : null}
        {messages.length || runId ? (
          <div className="ask-chat" aria-live="polite">
            {messages.map(m => m.role === 'user' ? <div key={m.id} className="chat-user" dir="auto">{m.content}</div> : (
              <div key={m.id} className="chat-assistant">
                {m.mode === 'text_search' ? <>
                  <div className="row" style={{ marginBottom: 9, color: 'var(--teal)' }}><Icon name="book" size="sm" /><strong style={{ fontSize: 11 }}>نتیجهٔ جست‌وجوی متنی در فضای تو</strong></div>
                  <p>{m.content}</p>
                  <div className="chat-results">{(m.meta.hits ?? []).map((h: any, i: number) => <Link key={i} className="chat-result" to={h.documentId ? `/library/${h.documentId}` : '#'}><h3 dir="auto">{h.title}{h.heading ? ` § ${h.heading}` : ''}</h3><p dir="auto">{String(h.snippet).slice(0, 220)}…</p></Link>)}</div>
                  <p className="muted" style={{ fontSize: 10, marginTop: 11 }}>جست‌وجوی متنی؛ این نتیجه پاسخ تولیدشده توسط مدل نیست.</p>
                </> : m.mode === 'error' ? <Notice kind="danger">{m.content}</Notice> : <>
                  <div className="row" style={{ marginBottom: 9, color: 'var(--teal)' }}><Icon name="spark" size="sm" /><strong style={{ fontSize: 11 }}>{m.meta.provider === 'mock' ? 'پاسخ آزمایشی (mock) — مدل واقعی نیست' : m.meta.provider === 'claude-code-subscription' ? 'پاسخ Claude (اشتراک) از صفحات همین فضا' : 'پاسخ مدل از دانش خودت'}</strong></div>
                  <Markdown text={m.content} citations onCite={key => { const c = m.citations.find((x: any) => x.citation_key === key); if (c) setCite(c.id); else toast(`ارجاع ${key} در این اجرا تأیید نشد.`, 'error'); }} />
                  {m.citations.length ? <div className="cite-list">{m.citations.map((c: any) => <button key={c.id} className={`cite-item ${c.validation?.valid ? '' : 'invalid'}`} onClick={() => setCite(c.id)}><strong>[{c.citation_key}] {c.title}</strong>{c.heading ? ` § ${c.heading}` : ''}{c.page ? ` · ص ${num(c.page)}` : ''}{c.stale ? ' · تغییر کرده' : ''}{c.validation?.valid ? '' : ' · نامعتبر'}<div className="muted" dir="auto">«{String(c.excerpt).replace(/\s+/g, ' ').slice(0, 140)}…»</div></button>)}</div> : m.meta.provider === 'claude-code-subscription' ? <p className="field-help">صفحات استفاده‌شده به‌صورت پیوند [[…]] در متن آمده‌اند؛ ارجاع بخش‌به‌بخش و اعتبارسنجی نقل‌قول فقط در حالت API انجام می‌شود.</p> : <Notice kind="warning">این پاسخ هیچ ارجاع معتبری ندارد.</Notice>}
                  <div className="meta-row">
                    {(m.meta.notCovered ?? []).length ? <Chip color="orange">پوشش‌داده‌نشده: {m.meta.notCovered.join('، ')}</Chip> : null}
                    {(m.meta.conflicts ?? []).length ? <Chip color="purple">اختلاف منابع: {m.meta.conflicts.join('، ')}</Chip> : null}
                    {(m.meta.read ?? []).length ? <Chip>صفحات خوانده‌شده: {num(m.meta.read.length)}</Chip> : null}
                    {m.meta.validation?.unbacked?.length ? <Chip color="orange">نشانه‌های بدون ارجاع: {m.meta.validation.unbacked.join(' ')}</Chip> : null}
                    {m.meta.validation?.fabricated?.length ? <Chip color="red">کلید ساختگی رد شد: {m.meta.validation.fabricated.join(' ')}</Chip> : null}
                  </div>
                  {canEdit(ws.role) ? <div className="note-tools"><button className="btn small" onClick={() => setToNote({ id: m.id })}><Icon name="note" size="sm" />ذخیره به‌عنوان یادداشت</button><button className="btn small" onClick={() => setToNote({ id: m.id, project: '' })}><Icon name="folder" size="sm" />ارسال به پروژه</button><Link className="btn small" to="/studio">ساخت گزارش</Link></div> : null}
                </>}
              </div>))}
            {runId ? (
              <div className="chat-assistant">
                <div className="row" style={{ marginBottom: 9, color: 'var(--teal)' }}><Icon name="spark" size="sm" /><strong style={{ fontSize: 11 }}>در حال پاسخ‌گویی{stream.connected ? '' : ' (اتصال دوباره…)'}</strong><span className="spacer" /><button className="btn small" onClick={stop}>توقف</button></div>
                <div className="meta-row">{stream.events.filter(e => e.type === 'tool').map(e => <Chip key={e.id}>{TOOL_LABEL[e.data.name] ?? e.data.name}: <span dir="auto">{String(e.data.summary).slice(0, 40)}</span></Chip>)}</div>
                <p className="stream-cursor" dir="auto" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>{stream.text}</p>
                <p className="muted" style={{ fontSize: 10 }}>متن جاری پیش‌نویس است؛ پاسخ نهایی پس از اعتبارسنجی ارجاع‌ها نمایش داده می‌شود.</p>
              </div>) : null}
            <div ref={chatEnd} />
          </div>
        ) : (id && conv.isPending ? <LoadingState /> :
          <div className="ask-intro"><span className="icon-tile teal" style={{ height: 63, width: 63, borderRadius: 19 }}><Icon name="spark" size="lg" /></span><Chip>فقط یادداشت‌های خودت</Chip><h2>از چیزهایی که می‌دانی، بیشتر بفهم.</h2><p>یک موضوع یا پرسش بنویس. پاسخ فقط از صفحات همین فضای دانش ساخته می‌شود و هر ادعا به بخش مشخصی از یک صفحه ارجاع دارد. اگر دانشت پاسخی نداشته باشد، همین را می‌گوید.</p></div>)}
        <form className="ask-composer" onSubmit={e => { e.preventDefault(); void send(input); }}>
          <div className="composer-field"><textarea rows={1} maxLength={2000} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} placeholder="دربارهٔ چه موضوعی از دانشت بپرسیم؟" aria-label="پرسش شما" dir="auto" /><button className="btn primary" type="submit" aria-label="ارسال پرسش" disabled={busy || !!runId || !input.trim()}><Icon name="send" /></button></div>
          {status.data && !modelOk && native.data?.loggedIn ? <div className="composer-note" style={{ color: 'var(--teal)' }}>پاسخ با Claude (اشتراک شما) در پس‌زمینه ساخته و در همین گفتگو ذخیره می‌شود.</div> : null}
          <div className="composer-note">{modelOk && !mock ? 'پرسش و بخش‌های مرتبط از طریق اتصال API که مدیر تنظیم کرده برای مدل فرستاده می‌شود؛ منابع «عدم ارسال بیرونی» کنار گذاشته می‌شوند.' : 'اطلاعاتی به سرویس بیرونی ارسال نمی‌شود.'} Enter برای ارسال · Shift + Enter برای خط جدید</div>
        </form>
      </div>
      <CitationDrawer id={cite} onClose={() => setCite(null)} />
      {claude.dialog}
      <ConfirmDialog open={del} title="حذف گفتگو" danger onClose={() => setDel(false)} onConfirm={async () => { try { await api(`/conversations/${id}`, { method: 'DELETE' }); setDel(false); qc.invalidateQueries({ queryKey: ['conversations'] }); nav('/ask'); } catch (e) { toast(errText(e), 'error'); } }} text={<p>گفتگو از فهرست حذف می‌شود.</p>} confirmLabel="حذف" />
      <Modal open={!!toNote} title={toNote?.project !== undefined ? 'ارسال پاسخ به پروژه' : 'ذخیرهٔ پاسخ به‌عنوان یادداشت'} onClose={() => setToNote(null)}>
        <p className="muted" style={{ fontSize: 12 }}>یک بستهٔ پیشنهادی ساخته می‌شود؛ تا آن را در «بررسی تغییرات» تأیید نکنی، فایلی ساخته نمی‌شود. ارجاع‌ها همراه یادداشت ذخیره می‌شوند.</p>
        {toNote?.project !== undefined ? <select className="field" aria-label="پروژه" value={toNote.project} onChange={e => setToNote({ ...toNote, project: e.target.value })}><option value="">انتخاب پروژه…</option>{(projects.data?.items ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select> : null}
        <div className="dialog-actions"><button className="btn" onClick={() => setToNote(null)}>انصراف</button><button className="btn primary" disabled={toNote?.project === ''} onClick={saveNote}>ساخت پیشنهاد</button></div>
      </Modal>
    </>
  );
}
