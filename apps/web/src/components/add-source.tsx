import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uid, ApiError, getWorkspace } from '../lib/api';
import { bytes } from '../lib/format';
import { Modal, Field, Icon, Notice, Tabs, toast, errText } from './ui';

type Kind = 'text' | 'url' | 'file';

export function AddSourceDialog({ initial, onClose }: { initial: Kind; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>(initial);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [tags, setTags] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sensitivity, setSensitivity] = useState('private_model');
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [idem] = useState(uid());
  const qc = useQueryClient(); const nav = useNavigate();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api('/projects') });
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api('/system/status') });
  const modelOk = status.data?.capabilities?.modelFeatures;
  const tagList = tags.split(/[,،]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 20);

  const pick = async (f: File | null) => {
    setFile(f); setPreview('');
    if (!f) return;
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
    if (f.size > 25 * 1024 * 1024) { toast('حجم فایل بیش از ۲۵ مگابایت است.', 'error'); return; }
    if (/\.(md|markdown|txt|vtt|srt|json)$/i.test(f.name)) setPreview((await f.slice(0, 3000).text()));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      let r: { id: string; existing: boolean; duplicateOf: { id: string; title: string } | null };
      const common = { tags: tagList, projectId: projectId || null, sensitivity, idempotencyKey: idem, autoAnalyze: autoAnalyze && sensitivity !== 'no_external' };
      if (kind === 'text') r = await api('/sources/text', { json: { kind: /^(---\n|#{1,6} )/m.test(text) ? 'markdown' : 'text', title: title || text.split('\n')[0].slice(0, 80) || 'متن', text, ...common } });
      else if (kind === 'url') r = await api('/sources/url', { json: { url, title: title || undefined, ...common } });
      else {
        if (!file) throw new Error('no file');
        const fd = new FormData();
        fd.set('title', title || file.name); fd.set('tags', JSON.stringify(tagList)); fd.set('sensitivity', sensitivity); fd.set('idempotencyKey', idem); fd.set('autoAnalyze', String(common.autoAnalyze));
        if (projectId) fd.set('projectId', projectId);
        fd.set('file', file);
        r = await api('/sources/upload', { method: 'POST', body: fd, headers: { 'x-workspace-id': getWorkspace() } });
      }
      qc.invalidateQueries({ queryKey: ['sources'] }); qc.invalidateQueries({ queryKey: ['overview'] });
      toast(r.duplicateOf ? `ثبت شد؛ محتوای مشابه قطعی قبلاً با عنوان «${r.duplicateOf.title}» وارد شده بود.` : r.existing ? 'این درخواست قبلاً ثبت شده بود.' : 'منبع ثبت شد و در صف استخراج است.');
      onClose(); nav(`/inbox/${r.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : errText(err), 'error');
    } finally { setBusy(false); }
  };

  const valid = kind === 'text' ? text.trim().length > 0 : kind === 'url' ? /^https?:\/\/./.test(url) : !!file;
  return (
    <Modal open title="افزودن منبع" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div style={{ marginBottom: 16 }}><Tabs label="نوع منبع" value={kind} onChange={setKind} items={[['text', 'متن / Markdown'], ['url', 'نشانی وب'], ['file', 'فایل']]} /></div>
        {kind === 'text' ? <Field label="متن" id="srcText" help="متن فارسی یا انگلیسی، Markdown، یا transcript آماده. منبع خام پس از ثبت تغییر نمی‌کند."><textarea id="srcText" className="field" value={text} onChange={e => setText(e.target.value)} maxLength={2_000_000} required dir="auto" /></Field> : null}
        {kind === 'url' ? <Field label="نشانی" id="srcUrl" help="فقط صفحات عمومی. صفحهٔ نیازمند ورود یا paywall به‌عنوان خطا گزارش می‌شود؛ از کوکی مرورگر استفاده نمی‌شود."><input id="srcUrl" className="field ltr" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" required /></Field> : null}
        {kind === 'file' ? (
          <div className="form-group">
            <div className={`file-drop ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0] ?? null); }}>
              <Icon name="upload" /><span>{file ? `${file.name} · ${bytes(file.size)}` : 'فایل را اینجا رها کن یا برای انتخاب بزن'}</span>
              <small>PDF متن‌دار، Markdown، متن UTF-8، VTT/SRT یا JSON گفتگو (chat_messages / mapping / messages) — حداکثر ۲۵ مگابایت</small>
              <input type="file" accept=".pdf,.md,.markdown,.txt,.json,.vtt,.srt,application/pdf,text/plain,text/markdown,application/json" onChange={e => pick(e.target.files?.[0] ?? null)} aria-label="انتخاب فایل" />
            </div>
            {preview ? <pre className="preview-box" dir="auto">{preview}</pre> : null}
          </div>) : null}
        {kind === 'text' && text ? <div className="field-help" style={{ marginTop: -10, marginBottom: 14 }}>پیش‌نمایش: {text.length.toLocaleString('fa-IR')} نویسه</div> : null}
        <div className="settings-profile">
          <Field label="عنوان" id="srcTitle"><input id="srcTitle" className="field" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} dir="auto" /></Field>
          <Field label="برچسب‌ها" id="srcTags" help="با ویرگول جدا کن"><input id="srcTags" className="field" value={tags} onChange={e => setTags(e.target.value)} dir="auto" /></Field>
          <Field label="پروژه (اختیاری)" id="srcProject"><select id="srcProject" className="field" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">بدون پروژه</option>{(projects.data?.items ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
          <Field label="حساسیت" id="srcSens" help={sensitivity === 'no_external' ? 'این منبع از همهٔ جست‌وجوهای مدل، ابزارها و اجرای بیرونی کنار گذاشته می‌شود.' : 'محل پردازش: سرور همین نصب؛ تحلیل از طریق اتصال API که مدیر تنظیم کرده.'}>
            <select id="srcSens" className="field" value={sensitivity} onChange={e => setSensitivity(e.target.value)}><option value="private_model">خصوصی؛ مجاز برای مدل</option><option value="public">عمومی</option><option value="no_external">عدم ارسال بیرونی</option></select>
          </Field>
        </div>
        <label className="check-row" style={{ marginBottom: 6 }}><input type="checkbox" checked={autoAnalyze} disabled={!modelOk || sensitivity === 'no_external'} onChange={e => setAutoAnalyze(e.target.checked)} /><span>پس از استخراج، تحلیل و ساخت پیشنهاد را شروع کن (چیزی بدون تأیید تو اعمال نمی‌شود)</span></label>
        {!modelOk && status.data ? <Notice kind="warning">اتصال مدل برقرار نیست؛ منبع ذخیره و استخراج می‌شود و جست‌وجوی متنی کار می‌کند، اما تحلیل هوشمند تا اتصال API از پنل مدیر انجام نمی‌شود.</Notice> : null}
        <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>انصراف</button><button className="btn primary" disabled={!valid || busy}>{busy ? 'در حال ثبت…' : 'ثبت منبع'}</button></div>
      </form>
    </Modal>
  );
}
