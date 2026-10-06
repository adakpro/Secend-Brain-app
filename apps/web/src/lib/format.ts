export interface Prefs { theme: 'light' | 'dark' | 'system'; locale: 'fa' | 'en'; timezone: string; calendar: 'persian' | 'gregorian'; digits: 'fa' | 'latn' }

let prefs: Prefs = { theme: 'system', locale: 'fa', timezone: 'Asia/Tehran', calendar: 'persian', digits: 'fa' };
export const setPrefs = (p: Partial<Prefs>) => { prefs = { ...prefs, ...p }; };
export const getPrefs = () => prefs;

const locale = () => `${prefs.locale === 'fa' ? 'fa-IR' : 'en-US'}-u-ca-${prefs.calendar === 'persian' ? 'persian' : 'gregory'}-nu-${prefs.digits === 'fa' ? 'arabext' : 'latn'}`;

export function num(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '';
  const v = typeof n === 'string' ? Number(n) : n;
  if (Number.isNaN(v)) return String(n);
  return new Intl.NumberFormat(prefs.digits === 'fa' ? 'fa-IR' : 'en-US').format(v);
}

/** All timestamps arrive as UTC ISO strings; display uses the user's chosen timezone and calendar. */
export function date(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' }): string {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: prefs.timezone }).format(new Date(iso)); } catch { return iso; }
}
export const dateTime = (iso?: string | null) => date(iso, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const weekday = (d = new Date()) => { try { return new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: prefs.timezone }).format(d); } catch { return ''; } };

export function relative(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  const rtf = new Intl.RelativeTimeFormat(prefs.locale === 'fa' ? 'fa-IR' : 'en-US', { numeric: 'auto' });
  if (diff < 60) return prefs.locale === 'fa' ? 'لحظاتی پیش' : 'just now';
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (diff < 86400 * 7) return rtf.format(-Math.round(diff / 86400), 'day');
  return date(iso);
}

export const bytes = (n: number) => (n < 1024 ? `${num(n)} B` : n < 1048576 ? `${num(Math.round(n / 102.4) / 10)} KB` : `${num(Math.round(n / 104857.6) / 10)} MB`);
export const isLatin = (s: string) => /^[A-Za-z0-9]/.test(s.trim());

export const kindMeta: Record<string, { label: string; icon: string; color: string }> = {
  source: { label: 'منبع', icon: 'file', color: 'blue' },
  concept: { label: 'مفهوم', icon: 'graph', color: 'teal' },
  entity: { label: 'موجودیت', icon: 'box', color: 'purple' },
  synthesis: { label: 'جمع‌بندی', icon: 'note', color: 'orange' },
  note: { label: 'یادداشت', icon: 'note', color: 'gray' },
  project: { label: 'پروژه', icon: 'folder', color: 'green' },
  output: { label: 'خروجی', icon: 'box', color: 'gray' },
  other: { label: 'سایر', icon: 'file', color: 'gray' },
};

export const sourceStatus: Record<string, { label: string; color: string }> = {
  uploaded: { label: 'بارگذاری شد', color: '' }, queued: { label: 'در صف', color: 'blue' }, extracting: { label: 'در حال استخراج', color: 'blue' },
  ready_for_analysis: { label: 'آمادهٔ پردازش', color: 'green' }, analyzing: { label: 'در حال تحلیل', color: 'purple' }, awaiting_review: { label: 'منتظر بررسی', color: 'orange' },
  applied: { label: 'اعمال شد', color: 'green' }, extraction_failed: { label: 'استخراج ناموفق', color: 'red' }, needs_ocr: { label: 'نیازمند OCR', color: 'orange' },
  analysis_failed: { label: 'تحلیل ناموفق', color: 'red' }, canceled: { label: 'لغو شد', color: '' },
};

export const runStatus: Record<string, { label: string; color: string }> = {
  queued: { label: 'در صف', color: 'blue' }, running: { label: 'در حال اجرا', color: 'purple' }, waiting_for_review: { label: 'منتظر بررسی', color: 'orange' },
  succeeded: { label: 'موفق', color: 'green' }, failed: { label: 'ناموفق', color: 'red' }, cancel_requested: { label: 'درخواست لغو', color: 'orange' },
  canceled: { label: 'لغو شد', color: '' }, interrupted: { label: 'قطع شد', color: 'red' },
};

export const csStatus: Record<string, { label: string; color: string }> = {
  proposed: { label: 'منتظر تأیید', color: 'orange' }, applying: { label: 'در حال اعمال', color: 'blue' }, applied: { label: 'اعمال‌شده', color: 'green' },
  partially_applied: { label: 'بخشی اعمال شد', color: 'green' }, rejected: { label: 'ردشده', color: '' }, conflict: { label: 'تعارض', color: 'red' },
  rolled_back: { label: 'بازگردانی‌شده', color: '' }, superseded: { label: 'جایگزین‌شده', color: '' },
};
