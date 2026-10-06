import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../lib/api';

export function Icon({ name, size }: { name: string; size?: 'sm' | 'lg' }) {
  return <svg className={`icon ${size ?? ''}`} aria-hidden="true"><use href={`#i-${name}`} /></svg>;
}

export function Tile({ icon, color = 'blue', mini }: { icon: string; color?: string; mini?: boolean }) {
  return <span className={`icon-tile ${color} ${mini ? 'mini' : ''}`}><Icon name={icon} /></span>;
}

export function Chip({ color = '', children, title }: { color?: string; children: ReactNode; title?: string }) {
  return <span className={`chip ${color}`} title={title}>{children}</span>;
}

export function StatusBadge({ map, value }: { map: Record<string, { label: string; color: string }>; value: string }) {
  const m = map[value] ?? { label: value, color: '' };
  return <Chip color={m.color === 'red' ? 'orange' : m.color}>{m.color === 'red' ? <span className="dot" style={{ color: 'var(--red)' }} /> : null}{m.label}</Chip>;
}

export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="section-title"><div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

export function Card({ title, footer, children, className = '', actions }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return <section className={`card ${className}`}>{title ? <div className="card-head"><h2>{title}</h2>{actions}</div> : null}<div className="card-body">{children}</div>{footer ? <div className="card-footer">{footer}</div> : null}</section>;
}

export function EmptyState({ icon = 'inbox', title, text, action }: { icon?: string; title: string; text: string; action?: ReactNode }) {
  return <div className="card empty-state"><Tile icon={icon} /><h2>{title}</h2><p>{text}</p>{action}</div>;
}

export function LoadingState({ label = 'در حال بارگذاری…' }: { label?: string }) {
  return <div className="card empty-state" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><p>{label}</p></div>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const e = error instanceof ApiError ? error : null;
  return (
    <div className="card empty-state" role="alert">
      <Tile icon="info" color="red" />
      <h2>{e?.status === 403 ? 'دسترسی ندارید' : e?.status === 404 ? 'پیدا نشد' : 'مشکلی پیش آمد'}</h2>
      <p>{e?.message ?? 'ارتباط با سرور برقرار نشد.'}</p>
      {e?.body.requestId ? <small className="muted ltr">ref: {e.body.requestId}</small> : null}
      {retry ? <button className="btn" onClick={retry}><Icon name="refresh" size="sm" />تلاش دوباره</button> : null}
    </div>
  );
}

export function Notice({ kind = 'info', icon, children }: { kind?: 'info' | 'warning' | 'danger'; icon?: string; children: ReactNode }) {
  return <div className={`notice ${kind === 'info' ? '' : kind}`} role={kind === 'danger' ? 'alert' : undefined}><Icon name={icon ?? (kind === 'info' ? 'info' : 'shield')} /><div>{children}</div></div>;
}

/** Accessible modal on the native <dialog>: focus is trapped by the browser, Escape closes, focus returns to the opener. */
export function Modal({ open, title, onClose, children, drawer, wide, labelledBy }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; drawer?: boolean; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) { opener.current = document.activeElement; d.showModal(); }
    if (!open && d.open) { d.close(); (opener.current as HTMLElement | null)?.focus?.(); }
  }, [open]);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, [onClose]);
  const id = labelledBy ?? 'dlg-title-' + String(title).length;
  return createPortal(
    <dialog ref={ref} className={`${drawer ? 'drawer' : ''} ${wide ? 'wide' : ''}`} aria-labelledby={id} onClick={e => { if (e.target === ref.current) onClose(); }}>
      {open ? <>
        <header className="dialog-head"><h2 id={id}>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="بستن پنجره"><Icon name="close" /></button></header>
        <div className="dialog-content">{children}</div>
      </> : null}
    </dialog>, document.body);
}

export function ConfirmDialog({ open, title, text, confirmLabel = 'تأیید', danger, onConfirm, onClose, busy }: { open: boolean; title: string; text: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      <div>{text}</div>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>انصراف</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'در حال انجام…' : confirmLabel}</button>
      </div>
    </Modal>
  );
}

// ---- Toasts -----------------------------------------------------------------
type Toast = { id: number; text: string; kind: 'ok' | 'error'; action?: { label: string; run: () => void } };
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = []; let tid = 0;
export function toast(text: string, kind: 'ok' | 'error' = 'ok', action?: Toast['action']) {
  const t = { id: ++tid, text, kind, action };
  toasts = [...toasts, t].slice(-4); toastListeners.forEach(l => l(toasts));
  setTimeout(() => { toasts = toasts.filter(x => x.id !== t.id); toastListeners.forEach(l => l(toasts)); }, kind === 'error' ? 7000 : 4000);
}
export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => { toastListeners.add(setList); return () => { toastListeners.delete(setList); }; }, []);
  return <div className="toast-stack" aria-live="polite" aria-atomic="false">{list.map(t => <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}><Icon name={t.kind === 'error' ? 'info' : 'check-circle'} /><span>{t.text}</span>{t.action ? <button onClick={t.action.run}>{t.action.label}</button> : null}</div>)}</div>;
}
export const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'خطای ارتباط با سرور.');

export function Field({ label, help, children, id }: { label: string; help?: ReactNode; children: ReactNode; id?: string }) {
  return <div className="form-group"><label className="field-label" htmlFor={id}>{label}</label>{children}{help ? <div className="field-help">{help}</div> : null}</div>;
}

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, ReactNode][]; label: string }) {
  return <div className="tabs" role="tablist" aria-label={label}>{items.map(([id, l]) => <button key={id} role="tab" aria-selected={value === id} className={`tab ${value === id ? 'active' : ''}`} onClick={() => onChange(id)}>{l}</button>)}</div>;
}

export function Progress({ value, color = '' }: { value: number; color?: string }) {
  return <div className="progress-track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><div className={`progress-fill ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}
