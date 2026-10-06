import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import cytoscape from 'cytoscape';
import { api } from '../lib/api';
import { num, kindMeta } from '../lib/format';
import { Icon, Chip, PageHeader, Notice, ErrorState, LoadingState, EmptyState, Tabs } from '../components/ui';
import '../styles/pages-knowledge.css';

const KINDS = ['source', 'concept', 'entity', 'synthesis', 'note'] as const;
const TOKEN: Record<string, string> = { source: '--blue', concept: '--teal', entity: '--purple', synthesis: '--orange', note: '--muted', project: '--green', output: '--muted' };

interface GNode { id: string; title: string; kind: string; path: string; tags: string[]; degree: number }
interface GEdge { source: string; target: string; type: 'link' | 'accepted_relation' | 'shared_tag'; label?: string }

const css = (v: string, fallback: string) => (getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fallback);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function GraphPage() {
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus') ?? '';
  const [kinds, setKinds] = useState<string[]>([...KINDS]);
  const [limit, setLimit] = useState(150);
  const [showTags, setShowTags] = useState(false);
  const [view, setView] = useState<'map' | 'list'>('map');
  const [selected, setSelected] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);

  const q = useQuery({
    queryKey: ['graph', focus, kinds.join(','), limit, showTags],
    queryFn: () => api(`/graph?kinds=${kinds.join(',')}&limit=${limit}${focus ? `&focus=${focus}` : ''}${showTags ? '&tags=true' : ''}`),
    enabled: kinds.length > 0,
  });
  const nodes: GNode[] = q.data?.nodes ?? [];
  const edges: GEdge[] = q.data?.edges ?? [];

  const neighbors = useMemo(() => {
    const m = new Map<string, { id: string; type: GEdge['type'] }[]>();
    for (const e of edges) {
      m.set(e.source, [...(m.get(e.source) ?? []), { id: e.target, type: e.type }]);
      m.set(e.target, [...(m.get(e.target) ?? []), { id: e.source, type: e.type }]);
    }
    return m;
  }, [edges]);
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  useEffect(() => {
    if (view !== 'map' || !box.current || !nodes.length) return;
    const ink = css('--ink', '#152033'); const line = css('--line', '#e9edf2'); const muted = css('--muted', '#8290a5'); const blue = css('--blue', '#2168ff'); const surface = css('--surface', '#fff');
    const inst = cytoscape({
      container: box.current,
      elements: [
        ...nodes.map(n => ({ data: { id: n.id, label: n.title.length > 26 ? n.title.slice(0, 24) + '…' : n.title, color: css(TOKEN[n.kind] ?? '--muted', muted), size: 18 + Math.min(n.degree, 12) * 2.5 } })),
        ...edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, type: e.type } })),
      ],
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', width: 'data(size)', height: 'data(size)', label: 'data(label)', 'font-size': 10, color: ink, 'text-valign': 'bottom', 'text-margin-y': 5, 'font-family': 'Vazirmatn, Tahoma, sans-serif', 'border-width': 3, 'border-color': surface, 'text-wrap': 'none' } },
        { selector: 'node:selected', style: { 'border-color': blue, 'border-width': 3 } },
        { selector: 'edge', style: { width: 1.5, 'line-color': line, 'curve-style': 'bezier' } },
        { selector: 'edge[type = "link"]', style: { 'line-color': muted, 'target-arrow-shape': 'triangle', 'target-arrow-color': muted, 'arrow-scale': 0.6, opacity: 0.7 } },
        { selector: 'edge[type = "accepted_relation"]', style: { 'line-color': blue, width: 2.5 } },
        { selector: 'edge[type = "shared_tag"]', style: { 'line-style': 'dashed', 'line-color': line, width: 1 } },
      ],
      layout: { name: 'cose', animate: !reducedMotion(), padding: 30, nodeRepulsion: () => 9000, idealEdgeLength: () => 90 } as cytoscape.LayoutOptions,
      wheelSensitivity: 0.3, minZoom: 0.2, maxZoom: 3,
    });
    // Small graphs would otherwise be fitted to a giant zoom; keep labels at a readable size.
    inst.one('layoutstop', () => { if (inst.zoom() > 1.2) { inst.zoom(1.2); inst.center(); } });
    inst.on('tap', 'node', ev => setSelected(ev.target.id()));
    inst.on('tap', ev => { if (ev.target === inst) setSelected(null); });
    cy.current = inst;
    return () => { inst.destroy(); cy.current = null; };
  }, [nodes, edges, view]);

  const zoom = (f: number | 'reset') => { const c = cy.current; if (!c) return; if (f === 'reset') { c.fit(undefined, 30); if (c.zoom() > 1.2) { c.zoom(1.2); c.center(); } } else c.zoom({ level: c.zoom() * f, renderedPosition: { x: c.width() / 2, y: c.height() / 2 } }); };
  const toggleKind = (k: string) => setKinds(ks => (ks.includes(k) ? ks.filter(x => x !== k) : [...ks, k]));
  const setFocus = (id: string) => { const p = new URLSearchParams(params); if (id) p.set('focus', id); else p.delete('focus'); setParams(p, { replace: true }); setSelected(null); };
  const sel = selected ? byId.get(selected) : null;
  const typeLabel = (t: GEdge['type']) => (t === 'link' ? 'لینک' : t === 'accepted_relation' ? 'رابطهٔ پذیرفته‌شده' : 'برچسب مشترک');

  return (
    <>
      <PageHeader title="نقشهٔ دانش" description="یک تصویر از ارتباط صفحه‌ها؛ نزدیک‌تر شو و رابطه‌ها را کشف کن."
        action={<Tabs label="نوع نمایش" value={view} onChange={setView} items={[['map', 'نقشه'], ['list', 'فهرست']]} />} />
      <Notice>
        خط پیوسته یعنی لینک واقعی <span className="mono">[[wikilink]]</span> بین دو صفحه؛ خط ضخیم آبی رابطه‌ای است که تأیید شده؛ خط‌چین فقط «برچسب مشترک» است و رابطهٔ معنایی قطعی نیست.
        {q.data?.semanticSuggestions && !q.data.semanticSuggestions.available ? <> {q.data.semanticSuggestions.reason}</> : null}
      </Notice>
      <div className="toolbar graph-filters">
        <div className="row-wrap" role="group" aria-label="نوع صفحه‌ها">
          {KINDS.map(k => <label key={k} className="check-row"><input type="checkbox" checked={kinds.includes(k)} onChange={() => toggleKind(k)} /><span className="dot" style={{ color: `var(${TOKEN[k]})` }} />{kindMeta[k].label}</label>)}
        </div>
        <div className="row-wrap">
          <label className="check-row"><input type="checkbox" checked={showTags} onChange={e => setShowTags(e.target.checked)} />نمایش برچسب مشترک</label>
          <label className="check-row">سقف گره
            <select className="field" style={{ width: 'auto', padding: '3px 8px' }} value={limit} onChange={e => setLimit(Number(e.target.value))} aria-label="سقف تعداد گره">{[50, 100, 150, 250, 400].map(n => <option key={n} value={n}>{num(n)}</option>)}</select>
          </label>
        </div>
      </div>
      {focus ? <div className="row" style={{ marginBottom: 12 }}><Chip color="blue">تمرکز: {byId.get(focus)?.title ?? 'صفحه'} و همسایه‌ها</Chip><button className="text-link" onClick={() => setFocus('')}>نمایش کل نقشه <Icon name="close" size="sm" /></button></div> : null}
      {q.data?.truncated ? <Notice kind="warning">برای خوانایی فقط {num(nodes.length)} گره از {num(q.data.total)} نمایش داده شد (پرارتباط‌ترین‌ها). از فیلتر یا حالت تمرکز استفاده کن.</Notice> : null}
      {!kinds.length ? <EmptyState icon="graph" title="هیچ نوعی انتخاب نشده" text="دست‌کم یک نوع صفحه را انتخاب کن." />
        : q.isPending ? <LoadingState /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} />
        : !nodes.length ? <EmptyState icon="graph" title="نقشه هنوز خالی است" text="وقتی صفحه‌های ویکی ساخته و به هم لینک شوند، اینجا دیده می‌شوند." />
        : view === 'map' ? (
          <div className="card graph-stage graph-wrap">
            <div ref={box} className="graph-canvas" role="img" aria-label={`نقشهٔ ${num(nodes.length)} صفحه و ${num(edges.length)} ارتباط؛ برای نسخهٔ متنی حالت فهرست را انتخاب کن`} />
            {sel ? (
              <div className="card graph-panel">
                <div className="between"><h3 style={{ fontSize: 13 }}>{sel.title}</h3><button className="icon-btn" onClick={() => setSelected(null)} aria-label="بستن"><Icon name="close" size="sm" /></button></div>
                <div className="drawer-meta" style={{ margin: '8px 0' }}><Chip>{kindMeta[sel.kind]?.label ?? sel.kind}</Chip><Chip>درجه {num(sel.degree)}</Chip></div>
                <div className="mono" style={{ marginBottom: 8, overflowWrap: 'anywhere' }}>{sel.path}</div>
                <div className="connection-list" style={{ marginBottom: 10 }}>
                  {(neighbors.get(sel.id) ?? []).slice(0, 20).map((n, i) => { const nn = byId.get(n.id); return nn ? <button key={i} className="connection-item" style={{ direction: 'rtl', textAlign: 'right' }} onClick={() => { setSelected(nn.id); cy.current?.$id(nn.id).select(); }}><Icon name="triangle" /><span>{nn.title}</span><small className="muted">({typeLabel(n.type)})</small></button> : null; })}
                  {!(neighbors.get(sel.id) ?? []).length ? <span className="muted" style={{ fontSize: 11 }}>همسایه‌ای در این نما نیست.</span> : null}
                </div>
                <div className="row-wrap"><Link className="btn small primary" to={`/library/${sel.id}`}>باز کردن</Link><button className="btn small" onClick={() => setFocus(sel.id)}>تمرکز روی همسایه‌ها</button></div>
              </div>
            ) : null}
            <div className="graph-controls">
              <button className="icon-btn" onClick={() => zoom(1 / 1.25)} aria-label="کوچک‌نمایی"><Icon name="minus" size="sm" /></button>
              <button className="icon-btn" onClick={() => zoom('reset')} aria-label="بازنشانی بزرگ‌نمایی"><Icon name="refresh" size="sm" /></button>
              <button className="icon-btn" onClick={() => zoom(1.25)} aria-label="بزرگ‌نمایی"><Icon name="plus" size="sm" /></button>
            </div>
            <div className="graph-legend">{KINDS.map(k => <span key={k}><i className="dot" style={{ color: `var(${TOKEN[k]})` }} />{kindMeta[k].label}</span>)}</div>
          </div>
        ) : (
          <div className="card page-card">
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">فهرست صفحه‌ها و ارتباط‌ها</caption>
                <thead><tr><th scope="col">صفحه</th><th scope="col">نوع</th><th scope="col">درجه</th><th scope="col">همسایه‌ها</th><th scope="col"></th></tr></thead>
                <tbody>{nodes.map(n => (
                  <tr key={n.id}>
                    <td><Link to={`/library/${n.id}`}>{n.title}</Link></td>
                    <td>{kindMeta[n.kind]?.label ?? n.kind}</td>
                    <td>{num(n.degree)}</td>
                    <td>{(neighbors.get(n.id) ?? []).slice(0, 6).map((x, i) => { const nn = byId.get(x.id); return nn ? <span key={i}>{i ? '، ' : ''}<Link to={`/library/${nn.id}`}>{nn.title}</Link>{x.type === 'shared_tag' ? ' (برچسب)' : ''}</span> : null; })}{(neighbors.get(n.id) ?? []).length > 6 ? ' …' : ''}</td>
                    <td><button className="text-link" onClick={() => { setView('map'); setFocus(n.id); }}>تمرکز</button></td>
                  </tr>))}</tbody>
              </table>
            </div>
          </div>
        )}
      <p className="muted" style={{ fontSize: 10, marginTop: 10 }}>{num(nodes.length)} گره · {num(edges.length)} ارتباط در این نما.</p>
    </>
  );
}
