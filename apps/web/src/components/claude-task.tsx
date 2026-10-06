import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { num } from '../lib/format';
import { Icon, Modal, Notice, toast, errText } from './ui';
import { useStepUp } from './content';
import { useMe } from '../session';

export function NativeTerminal({ ticket, onClosed }: { ticket: string; onClosed: (why: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false; let ws: WebSocket | null = null; let term: any; let fit: any;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !el.current) return;
      term = new Terminal({ fontSize: 13, cursorBlink: true, scrollback: 2000, convertEol: false, theme: { background: '#0f1622' } });
      fit = new FitAddon(); term.loadAddon(fit); term.open(el.current); fit.fit(); term.focus();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/v1/admin/native-claude/terminal?ticket=${encodeURIComponent(ticket)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws!.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      ws.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
      ws.onclose = e => { if (!disposed) onClosed(e.reason || 'نشست ترمینال بسته شد.'); };
      term.onData((d: string) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'in', d })); });
      const onResize = () => { fit.fit(); if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })); };
      window.addEventListener('resize', onResize);
    })();
    return () => { disposed = true; ws?.close(); term?.dispose(); };
  }, [ticket]);
  return <div className="terminal-wrap" ref={el} aria-label="ترمینال خصوصی Claude Code" />;
}

/** Native (subscription) status, only for admins; other roles never call the admin endpoint. */
export function useNativeStatus() {
  const me = useMe();
  return useQuery({ queryKey: ['native-status'], queryFn: () => api('/admin/native-claude/status').then(r => r.status), enabled: me.user.isAdmin, staleTime: 30_000 });
}

/**
 * Runs one task in the owner's own interactive Claude Code session: staging is prepared, the terminal
 * opens with the command pre-typed (not submitted), the owner presses Enter, and then sends the
 * resulting edits to the Review center.
 */
export function ClaudeTaskDialog({ kind, sourceId, question, onClose }: { kind: 'ingest' | 'ask'; sourceId?: string; question?: string; onClose: () => void }) {
  const me = useMe(); const nav = useNavigate(); const step = useStepUp(me.user.totpEnabled);
  const [ticket, setTicket] = useState<string | null>(null);
  const [prefill, setPrefill] = useState('');
  const [phase, setPhase] = useState<'starting' | 'terminal' | 'importing' | 'error'>('starting');
  const [msg, setMsg] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    step.run(async () => {
      const r = await api('/admin/native-claude/task', { json: { kind, sourceId, question } });
      setPrefill(r.prefill); setTicket(r.ticket); setPhase('terminal');
    }).catch(e => { setMsg(e instanceof ApiError ? e.message : errText(e)); setPhase('error'); });
  }, []);
  const finish = async () => {
    setPhase('importing');
    try {
      await api('/admin/native-claude/close', { json: {} }).catch(() => undefined);
      setTicket(null);
      const r = await api('/admin/native-claude/staging/import', { json: {} });
      if (r.changesetId) { toast(`${num(r.imported)} تغییر برای بررسی آماده شد.`); onClose(); nav(`/review/${r.changesetId}`); return; }
      toast(r.conflicts?.length ? `تغییری وارد نشد؛ ${num(r.conflicts.length)} تعارض.` : 'Claude تغییری در صفحات ویکی ایجاد نکرد.', r.conflicts?.length ? 'error' : 'ok');
      onClose();
    } catch (e) { setMsg(errText(e)); setPhase('error'); }
  };
  return (
    <Modal open title={kind === 'ingest' ? 'تحلیل منبع با Claude (اشتراک شما)' : 'پرسش با Claude Code (اشتراک شما)'} onClose={onClose} wide>
      {phase === 'starting' ? <p className="muted" style={{ fontSize: 12 }}>در حال آماده‌سازی staging و باز کردن Claude Code…</p> : null}
      {phase === 'error' ? <Notice kind="danger">{msg}</Notice> : null}
      {ticket ? <>
        <Notice icon="info">فرمان <span className="mono">{prefill}</span> در ترمینال تایپ شده ولی ارسال نشده است. آن را بخوان و <b>Enter</b> را بزن. Claude در یک کپی جدا (staging) کار می‌کند{kind === 'ingest' ? '؛ پس از پایان کار، «پایان و ارسال برای بررسی» را بزن تا تفاوت‌ها را ببینی و تأیید کنی' : '؛ پاسخ همین‌جا در ترمینال نمایش داده می‌شود'}.</Notice>
        <NativeTerminal ticket={ticket} onClosed={why => { setTicket(null); if (phase === 'terminal') setMsg(why); }} />
      </> : null}
      {msg && phase !== 'error' ? <Notice kind="warning">{msg}</Notice> : null}
      <div className="dialog-actions">
        <button className="btn" onClick={async () => { await api('/admin/native-claude/close', { json: {} }).catch(() => undefined); onClose(); }}>بستن بدون ارسال</button>
        {kind === 'ingest' || phase !== 'starting' ? <button className="btn primary" disabled={phase === 'starting' || phase === 'importing'} onClick={finish}><Icon name="review" size="sm" />{phase === 'importing' ? 'در حال آماده‌سازی…' : 'پایان و ارسال برای بررسی'}</button> : null}
      </div>
      {step.dialog}
    </Modal>
  );
}

/** Starts a background Claude Code (subscription) job; step-up aware. Progress arrives through the run's SSE stream. */
export function useClaudeJob() {
  const me = useMe(); const step = useStepUp(me.user.totpEnabled);
  const start = async (body: { kind: 'ingest' | 'ask'; sourceId?: string; question?: string; conversationId?: string }) => {
    let out: { runId: string; conversationId: string | null } | null = null;
    await step.run(async () => { out = await api('/admin/native-claude/jobs', { json: body }); });
    return out as { runId: string; conversationId: string | null } | null;
  };
  return { start, dialog: step.dialog };
}
