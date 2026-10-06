import { useEffect, useRef, useState } from 'react';
import { getWorkspace } from './api';

export interface RunEvent { id: number; type: string; data: Record<string, any> }

/**
 * Subscribes to a run's SSE stream. EventSource reconnects by itself and sends Last-Event-ID,
 * so after a network drop or tab sleep the server replays only the missed events of this run.
 */
export function useRunStream(runId: string | null | undefined, onEnd?: (status: string) => void) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [connected, setConnected] = useState(false);
  const endRef = useRef(onEnd); endRef.current = onEnd;
  useEffect(() => {
    setEvents([]); setText(''); setStatus(null);
    if (!runId) return;
    const es = new EventSource(`/api/v1/runs/${runId}/events?ws=${encodeURIComponent(getWorkspace())}`);
    const seen = new Set<number>();
    const handle = (type: string) => (e: MessageEvent) => {
      const id = Number(e.lastEventId);
      const data = JSON.parse(e.data);
      // Dedupe by the event's own per-run sequence. `end` carries no id/seq; EventSource would
      // report the previous event's id for it, so it must never be deduplicated by lastEventId.
      if (typeof data.seq === 'number') { if (seen.has(data.seq)) return; seen.add(data.seq); }
      if (type === 'text_delta') setText(t => t + (data.text ?? ''));
      if (type === 'status') setStatus(data.status);
      if (type === 'end') { setStatus(data.status); es.close(); setConnected(false); endRef.current?.(data.status); return; }
      setEvents(ev => [...ev, { id, type, data }]);
    };
    for (const t of ['status', 'started', 'tool', 'text_delta', 'proposal', 'proposal_rejected', 'progress', 'end']) es.addEventListener(t, handle(t) as EventListener);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [runId]);
  return { events, status, text, connected };
}

export const TOOL_LABEL: Record<string, string> = {
  read_source: 'خواندن منبع', read_note: 'خواندن صفحه', search_wiki: 'جست‌وجو در ویکی', get_backlinks: 'یافتن لینک‌های ورودی', list_index: 'مرور فهرست', propose_change: 'پیشنهاد تغییر',
};
