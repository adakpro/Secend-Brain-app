import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uid, ApiError } from '../lib/api';
import { num, dateTime, csStatus } from '../lib/format';
import { Card, Chip, ConfirmDialog, ErrorState, Icon, LoadingState, Modal, Notice, StatusBadge, toast, errText } from '../components/ui';
import { DiffViewer, Markdown } from '../components/content';
import { useWorkspace, canEdit } from '../session';

const OP_LABEL: Record<string, string> = { create: 'ایجاد', update: 'ویرایش', delete: 'حذف', rename: 'تغییرنام', merge: 'ادغام' };

export default function ChangeSetPage() {
  const { id } = useParams(); const ws = useWorkspace(); const qc = useQueryClient(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['changeset', id], queryFn: () => api(`/changesets/${id}`) });
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [view, setView] = useState<Record<number, 'diff' | 'preview'>>({});
  const [editing, setEditing] = useState<{ seq: number; text: string } | null>(null);
  const [confirm, setConfirm] = useState<null | 'apply' | 'reject' | 'rollback'>(null);
  const [busy, setBusy] = useState(false);
  const [applyKey] = useState(uid());
  const [conflict, setConflict] = useState<string | null>(null);
  useEffect(() => { if (q.data) setAccepted(new Set(q.data.items.filter((i: any) => i.status === 'pending').map((i: any) => i.seq))); }, [q.data]);
  const items: any[] = q.data?.items ?? [];
  const brokenDeps = useMemo(() => items.filter(i => accepted.has(i.seq)).flatMap(i => (i.depends_on as number[]).filter(d => !accepted.has(d)).map(d => ({ seq: i.seq, dep: d }))), [items, accepted]);
  if (q.isPending) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const c = q.data.changeset; const open = ['proposed', 'conflict'].includes(c.status); const writer = canEdit(ws.role);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['changeset', id] }); qc.invalidateQueries({ queryKey: ['changesets'] }); qc.invalidateQueries({ queryKey: ['overview'] }); };
  const toggle = (seq: number) => setAccepted(s => { const n = new Set(s); if (n.has(seq)) n.delete(seq); else n.add(seq); return n; });
  const apply = async () => {
    setBusy(true); setConflict(null);
    try {
      const all = accepted.size === items.length;
      const r = await api(`/changesets/${id}/apply`, { json: { accepted: all ? 'all' : [...accepted], applyKey } });
      toast(r.idempotent ? 'این بسته قبلاً اعمال شده بود.' : `اعمال شد: ${num(r.applied.length)} فایل.`);
      setConfirm(null); refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setConflict(e.message + ' ' + String((e.body.details as any)?.reason ?? '')); setConfirm(null); refresh(); }
      else toast(errText(e), 'error');
    } finally { setBusy(false); }
  };
  const reject = async () => { setBusy(true); try { await api(`/changesets/${id}/reject`, { json: {} }); toast('بسته رد شد.'); setConfirm(null); refresh(); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); } };
  const rollback = async () => { setBusy(true); try { const r = await api(`/changesets/${id}/rollback`, { json: {} }); toast('بستهٔ معکوس ساخته شد؛ آن را بررسی و اعمال کن.'); setConfirm(null); nav(`/review/${r.rollbackChangesetId}`); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); } };
  const saveEdit = async () => { if (!editing) return; try { await api(`/changesets/${id}/items/${editing.seq}`, { method: 'PUT', json: { content: editing.text } }); toast('متن پیشنهادی ویرایش شد.'); setEditing(null); refresh(); } catch (e) { toast(errText(e), 'error'); } };
  const report = c.report ?? {};
  return (
    <>
      <div className="section-title">
        <div><Link className="text-link" to="/review"><Icon name="arrow" size="sm" /> بررسی تغییرات</Link><h1 dir="auto">{c.title}</h1><p dir="auto">{c.summary}</p></div>
        <StatusBadge map={csStatus} value={c.status} />
      </div>
      {c.provider === 'mock' ? <Notice kind="warning">این بسته توسط ارائه‌دهندهٔ آزمایشی (mock) ساخته شده و خروجی مدل واقعی نیست.</Notice> : null}
      {conflict || c.status === 'conflict' ? <Notice kind="danger">تعارض: {conflict ?? (report.conflicts ?? []).map((x: any) => `${x.path}: ${x.reason}`).join('؛ ')}. هیچ فایلی بازنویسی نشد. نسخهٔ فعلی صفحه را در کتابخانه ببین؛ پس از هماهنگ‌کردن، تحلیل را دوباره اجرا کن تا پیشنهاد روی نسخهٔ جدید ساخته شود.</Notice> : null}
      {report.recoveredFromCrash ? <Notice kind="warning">اعمال قبلی این بسته در میانه قطع شد و به‌طور خودکار به وضعیت سالم برگردانده شد.</Notice> : null}
      <div className="grid-2">
        <Card title="منشأ و پوشش">
          <dl className="kv">
            <dt>منبع</dt><dd>{c.source_id ? <Link to={`/inbox/${c.source_id}`}>{c.source_title}</Link> : c.origin === 'rollback' ? <Link to={`/review/${c.rollback_of}`}>بستهٔ اصلی</Link> : c.origin}</dd>
            <dt>اجرا</dt><dd>{c.provider ? `${c.provider === 'mock' ? 'mock (آزمایشی)' : 'Claude API'} · ${c.model ?? ''}` : '—'}</dd>
            <dt>ساخت</dt><dd>{dateTime(c.created_at)}</dd>
            {report.coverage ? <><dt>پوشش منبع</dt><dd>{num(report.coverage.readPassages)} از {num(report.coverage.sourcePassages)} بخش خوانده شد{report.coverage.partial ? ' — ناقص' : ''}</dd></> : null}
            {c.applied_at ? <><dt>اعمال</dt><dd>{dateTime(c.applied_at)}</dd></> : null}
          </dl>
        </Card>
        <Card title="گزارش عامل">
          {(report.contradictions ?? []).length ? <><h3 style={{ fontSize: 12 }}>اختلاف‌ها</h3><ul>{report.contradictions.map((x: string, i: number) => <li key={i} dir="auto">{x}</li>)}</ul></> : <p className="muted" style={{ fontSize: 11 }}>اختلافی گزارش نشد.</p>}
          {(report.gaps ?? []).length ? <><h3 style={{ fontSize: 12 }}>خلأها</h3><ul>{report.gaps.map((x: string, i: number) => <li key={i} dir="auto">{x}</li>)}</ul></> : null}
          {(report.unreadParts ?? []).length ? <><h3 style={{ fontSize: 12 }}>بخش‌های خوانده‌نشده</h3><ul>{report.unreadParts.map((x: string, i: number) => <li key={i} dir="auto">{x}</li>)}</ul></> : null}
          {(report.validationIssues ?? []).length || (report.rejectedProposals ?? []).length ? <Notice kind="warning">پیشنهادهای ردشده توسط قواعد سرور: {[...(report.validationIssues ?? []), ...(report.rejectedProposals ?? []).map((r: any) => `${r.path}: ${r.reason}`)].join('؛ ')}</Notice> : null}
        </Card>
      </div>
      <Notice icon="info">{q.data.maintenanceNote}</Notice>
      {items.map(it => {
        const deps: number[] = it.depends_on ?? [];
        const v = view[it.seq] ?? 'diff';
        return (
          <section key={it.seq} className="cs-item" aria-label={`مورد ${it.seq}`}>
            <div className="cs-item-head">
              {open && writer ? <input type="checkbox" aria-label={`پذیرش مورد ${it.seq}`} checked={accepted.has(it.seq)} onChange={() => toggle(it.seq)} /> : null}
              <Chip color={it.op === 'create' ? 'green' : it.op === 'delete' ? 'orange' : 'blue'}>{OP_LABEL[it.op] ?? it.op}</Chip>
              <span className="mono" style={{ fontSize: 12 }}>{it.path}</span>
              <Chip>{it.status === 'pending' ? 'در انتظار' : it.status === 'applied' ? 'اعمال‌شده' : it.status === 'rejected' ? 'پذیرفته نشد' : it.status}</Chip>
              {it.stale ? <Chip color="red">صفحه پس از پیشنهاد تغییر کرده</Chip> : null}
              {it.edited_by_user ? <Chip color="purple">ویرایش‌شده توسط تو</Chip> : null}
              {deps.length ? <Chip title="پذیرش این مورد بدون موارد وابسته ممکن نیست">وابسته به: {deps.map(d => num(d)).join('، ')}</Chip> : null}
              {(it.source_refs ?? []).length ? <Chip color="teal">ارجاع به منبع: {it.source_refs.join(' ')}</Chip> : null}
              <span className="spacer" />
              <div className="tabs" role="tablist"><button role="tab" aria-selected={v === 'diff'} className={`tab ${v === 'diff' ? 'active' : ''}`} onClick={() => setView({ ...view, [it.seq]: 'diff' })}>تفاوت</button><button role="tab" aria-selected={v === 'preview'} className={`tab ${v === 'preview' ? 'active' : ''}`} onClick={() => setView({ ...view, [it.seq]: 'preview' })}>پیش‌نمایش</button></div>
              {open && writer && it.op !== 'delete' ? <button className="btn small" onClick={() => setEditing({ seq: it.seq, text: it.after_content ?? '' })}><Icon name="edit" size="sm" />ویرایش متن</button> : null}
            </div>
            {it.rationale ? <p className="muted" style={{ fontSize: 11, marginBottom: 8 }} dir="auto">دلیل: {it.rationale}</p> : null}
            {v === 'diff' ? <DiffViewer diff={it.diff} /> : <div className="card page-card"><Markdown text={it.after_content ?? ''} /></div>}
          </section>
        );
      })}
      {brokenDeps.length ? <Notice kind="danger">انتخاب فعلی وابستگی‌ها را می‌شکند: {brokenDeps.map(b => `مورد ${num(b.seq)} به ${num(b.dep)}`).join('، ')}. موارد وابسته را هم انتخاب کن یا این مورد را کنار بگذار.</Notice> : null}
      <div className="review-actions" style={{ position: 'sticky', bottom: 0, background: 'var(--bg)', paddingBottom: 12 }}>
        {open && writer ? <>
          <button className="btn" onClick={() => setConfirm('reject')}>رد کل بسته</button>
          <button className="btn primary" disabled={!accepted.size || !!brokenDeps.length || busy} onClick={() => setConfirm('apply')}><Icon name="check" size="sm" />{accepted.size === items.length ? 'تأیید و اعمال همه' : `اعمال ${num(accepted.size)} مورد انتخابی`}</button>
        </> : null}
        {writer && ['applied', 'partially_applied'].includes(c.status) && c.origin !== 'rollback' ? <button className="btn" onClick={() => setConfirm('rollback')}><Icon name="undo" size="sm" />بازگردانی این تغییر</button> : null}
        {c.rolled_back_by ? <Link className="btn" to={`/review/${c.rolled_back_by}`}>مشاهدهٔ بستهٔ بازگردانی</Link> : null}
        {['rejected'].includes(c.status) && writer ? <button className="btn" onClick={async () => { try { await api(`/changesets/${id}/reopen`, { json: {} }); refresh(); } catch (e) { toast(errText(e), 'error'); } }}>بازگشایی برای بررسی</button> : null}
      </div>
      <ConfirmDialog open={confirm === 'apply'} title="اعمال تغییرات در فایل‌های اصلی" busy={busy} onClose={() => setConfirm(null)} onConfirm={apply}
        text={<p>{num(accepted.size)} فایل نوشته می‌شود و index و log براساس همین انتخاب به‌روز می‌شوند. اگر صفحه‌ای از زمان پیشنهاد تغییر کرده باشد، هیچ فایلی نوشته نمی‌شود و تعارض گزارش می‌شود.</p>} confirmLabel="اعمال" />
      <ConfirmDialog open={confirm === 'reject'} title="رد بسته" busy={busy} onClose={() => setConfirm(null)} onConfirm={reject} text={<p>هیچ فایلی تغییر نمی‌کند؛ بسته در سابقه می‌ماند و می‌توانی بعداً بازگشایی‌اش کنی.</p>} confirmLabel="رد" />
      <ConfirmDialog open={confirm === 'rollback'} title="بازگردانی" busy={busy} onClose={() => setConfirm(null)} onConfirm={rollback} text={<p>یک بستهٔ معکوس جدید ساخته می‌شود که وصلهٔ معکوس را روی متن فعلی اعمال می‌کند؛ ویرایش‌های مستقل بعدی تو حذف نمی‌شوند. پیش از اعمال، آن را بررسی می‌کنی.</p>} confirmLabel="ساخت بستهٔ معکوس" />
      <Modal open={!!editing} title="ویرایش متن پیشنهادی" onClose={() => setEditing(null)} wide>
        <p className="muted" style={{ fontSize: 11 }}>متن ویرایش‌شده جای پیشنهاد عامل را می‌گیرد و با برچسب «ویرایش‌شده توسط تو» نمایش داده می‌شود.</p>
        <textarea className="field editor-area" value={editing?.text ?? ''} onChange={e => setEditing(ed => (ed ? { ...ed, text: e.target.value } : ed))} dir="auto" />
        <div className="dialog-actions"><button className="btn" onClick={() => setEditing(null)}>انصراف</button><button className="btn primary" onClick={saveEdit}>ذخیرهٔ ویرایش</button></div>
      </Modal>
    </>
  );
}
