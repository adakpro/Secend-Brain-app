import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, download, getWorkspace } from '../lib/api';
import { num } from '../lib/format';
import { PageHeader, Notice, Card, Icon, Chip, toast, errText } from '../components/ui';
import { useWorkspace, canEdit } from '../session';

export default function TransferPage() {
  const ws = useWorkspace(); const nav = useNavigate();
  const [json, setJson] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [includeDemo, setIncludeDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const writer = canEdit(ws.role);

  const pickJson = async (f: File | null) => {
    setPreview(null); setJson(null);
    if (!f) return;
    if (f.size > 40 * 1024 * 1024) { toast('فایل بیش از حد بزرگ است.', 'error'); return; }
    try {
      const data = JSON.parse(await f.text());
      const r = await api('/import/html-prototype/preview', { json: { data } });
      setJson(data); setPreview(r);
    } catch (e) { toast(e instanceof SyntaxError ? 'JSON نامعتبر است.' : errText(e), 'error'); }
  };
  const applyJson = async () => {
    setBusy(true);
    try {
      const r = await api('/import/html-prototype/apply', { json: { data: json, includeDemo } });
      toast(`${num(r.notesProposed)} یادداشت به‌صورت پیشنهاد و ${num(r.projectsCreated)} پروژه وارد شد.`);
      setPreview(null); setJson(null);
      if (r.changesetId) nav(`/review/${r.changesetId}`);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const pickZip = async (f: File | null) => {
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.set('file', f);
      const r = await api('/import/vault-zip', { method: 'POST', body: fd, headers: { 'x-workspace-id': getWorkspace() } });
      toast(`${num(r.proposed)} فایل به بستهٔ پیشنهادی تبدیل شد؛ ${num(r.quarantined.length)} فایل پیکربندی قرنطینه شد.`);
      if (r.changesetId) nav(`/review/${r.changesetId}`);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="انتقال داده" description="خروجی قابل حمل محتوا، و ورود از نسخهٔ HTML یا یک vault موجود." action={<Link className="btn" to="/settings/data">بازگشت</Link>} />
      <div className="grid-2">
        <Card title="خروجی قابل حمل (ZIP)">
          <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>Markdown همهٔ صفحات (نسخهٔ جاری)، خروجی‌های استودیو و فایل‌های خام منابع در ساختار vault. بدون حساب، نشست، کلید، تاریخچهٔ اجرا یا audit. منابع «عدم ارسال بیرونی» در آن نیستند. این پشتیبان عملیاتی نیست؛ برای بازیابی کامل از <Link to="/admin/backups">پشتیبان</Link> استفاده کن.</p>
          <button className="btn primary" disabled={!writer} onClick={() => download('/workspaces/current/export')}><Icon name="download" size="sm" />دریافت ZIP</button>
        </Card>
        <Card title="ورود vault موجود (ZIP)">
          <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>آرشیو ابتدا فقط خوانده و بررسی می‌شود (zip-slip، symlink، zip-bomb). صفحات Markdown به یک بستهٔ پیشنهادی تبدیل می‌شوند؛ <span className="mono">.claude/</span>، hookها و تنظیمات MCP اجرا یا وارد نمی‌شوند و فقط گزارش می‌شوند. index و log را برنامه می‌سازد.</p>
          <label className="btn" style={{ position: 'relative' }}><Icon name="upload" size="sm" />{busy ? 'در حال بررسی…' : 'انتخاب ZIP'}<input type="file" accept=".zip,application/zip" disabled={!writer || busy} onChange={e => pickZip(e.target.files?.[0] ?? null)} style={{ position: 'absolute', inset: 0, opacity: 0 }} aria-label="انتخاب فایل ZIP" /></label>
        </Card>
      </div>
      <Card title="ورود از نسخهٔ HTML قبلی">
        <Notice>در نسخهٔ HTML، از «فعالیت و سلامت › پشتیبان داده‌ها» یا «تنظیمات › دریافت پشتیبان» یک فایل JSON بگیر و اینجا انتخاب کن. دادهٔ localStorage مرورگر دیگر خودکار خوانده نمی‌شود.</Notice>
        <label className="btn" style={{ position: 'relative' }}><Icon name="upload" size="sm" />انتخاب فایل JSON<input type="file" accept="application/json,.json" disabled={!writer} onChange={e => pickJson(e.target.files?.[0] ?? null)} style={{ position: 'absolute', inset: 0, opacity: 0 }} aria-label="انتخاب فایل JSON" /></label>
        {preview ? <div style={{ marginTop: 16 }}>
          <div className="row-wrap" style={{ marginBottom: 10 }}>
            <Chip color="blue">{num(preview.counts.notes)} یادداشت</Chip><Chip color="orange">{num(preview.counts.demoNotes)} نمونه</Chip>
            <Chip color="green">{num(preview.counts.projects)} پروژه</Chip><Chip color="orange">{num(preview.counts.demoProjects)} پروژهٔ نمونه</Chip>
            <Chip>{num(preview.counts.reviewsIgnored)} پیشنهاد نمونه نادیده</Chip><Chip>{num(preview.counts.activityIgnored)} فعالیت نادیده</Chip>
          </div>
          <p className="field-help">{preview.notice}</p>
          <div className="table-wrap" style={{ maxHeight: 260, overflow: 'auto', margin: '10px 0' }}><table className="data-table"><thead><tr><th>عنوان</th><th>نوع</th><th>مقصد</th><th>نمونه</th></tr></thead><tbody>
            {preview.notes.map((n: any) => <tr key={n.id}><td dir="auto">{n.title}</td><td>{n.type}</td><td className="mono">{n.target}</td><td>{n.demo ? 'بله' : ''}</td></tr>)}
          </tbody></table></div>
          <label className="check-row" style={{ marginBottom: 10 }}><input type="checkbox" checked={includeDemo} disabled={!ws.isDemo} onChange={e => setIncludeDemo(e.target.checked)} /><span>دادهٔ نمونه هم وارد شود {ws.isDemo ? '' : '(فقط در فضای دانش نمایشی مجاز است)'}</span></label>
          <button className="btn primary" disabled={busy} onClick={applyJson}>ورود ({num(preview.notes.filter((n: any) => includeDemo || !n.demo).length)} یادداشت به‌صورت پیشنهاد)</button>
        </div> : null}
      </Card>
    </>
  );
}
