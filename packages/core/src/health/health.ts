import type { Queryable } from '../database/pool';
import { parseMarkdown } from '../markdown/frontmatter';

/**
 * Deterministic implementations of the upstream lint / graph / metrics skills. They report;
 * they never repair. Fixes go through ChangeSets.
 */
export async function lintReport(q: Queryable, workspaceId: string) {
  const docs = (await q.query(
    `SELECT d.id, d.path, d.title, d.kind, r.content FROM documents d JOIN document_revisions r ON r.id=d.current_revision_id
     WHERE d.workspace_id=$1 AND d.deleted_at IS NULL`, [workspaceId])).rows;
  const links = (await q.query(`SELECT from_document_id, target_raw, to_document_id, status FROM links WHERE workspace_id=$1`, [workspaceId])).rows;
  const inbound = new Map<string, number>();
  for (const l of links) if (l.to_document_id) inbound.set(l.to_document_id, (inbound.get(l.to_document_id) ?? 0) + 1);
  const wiki = docs.filter(d => ['source', 'concept', 'entity', 'synthesis'].includes(d.kind));
  const broken = links.filter(l => l.status === 'missing').map(l => ({ from: docs.find(d => d.id === l.from_document_id)?.path, target: l.target_raw }));
  const ambiguous = links.filter(l => l.status === 'ambiguous').map(l => ({ from: docs.find(d => d.id === l.from_document_id)?.path, target: l.target_raw }));
  const orphans = wiki.filter(d => !inbound.get(d.id)).map(d => d.path);
  const deadEnds = wiki.filter(d => !links.some(l => l.from_document_id === d.id)).map(d => d.path);
  const badFrontmatter: { path: string; problem: string }[] = [];
  for (const d of wiki) {
    const p = parseMarkdown(d.content);
    if (!p.hasFrontmatter) badFrontmatter.push({ path: d.path, problem: 'missing frontmatter' });
    else if (p.errors.length) badFrontmatter.push({ path: d.path, problem: p.errors[0] });
    else for (const k of ['title', 'type', 'created', 'updated']) if (!(k in p.data)) badFrontmatter.push({ path: d.path, problem: `missing ${k}` });
  }
  const stubs = wiki.filter(d => parseMarkdown(d.content).body.replace(/^#.*$/gm, '').trim().length < 80).map(d => d.path);
  return { pages: wiki.length, broken, ambiguous, orphans, deadEnds, badFrontmatter, stubs };
}

export async function graphMetrics(q: Queryable, workspaceId: string) {
  const nodes = (await q.query(`SELECT id, title, kind FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL AND kind IN ('source','concept','entity','synthesis','note')`, [workspaceId])).rows;
  const ids = new Set(nodes.map(n => n.id));
  const edges = (await q.query(`SELECT DISTINCT from_document_id AS a, to_document_id AS b FROM links WHERE workspace_id=$1 AND status='resolved'`, [workspaceId])).rows.filter(e => ids.has(e.a) && ids.has(e.b) && e.a !== e.b);
  const adj = new Map<string, Set<string>>(nodes.map(n => [n.id, new Set()]));
  for (const e of edges) { adj.get(e.a)!.add(e.b); adj.get(e.b)!.add(e.a); }
  const seen = new Set<string>(); let components = 0;
  for (const n of nodes) {
    if (seen.has(n.id)) continue; components++;
    const stack = [n.id];
    while (stack.length) { const x = stack.pop()!; if (seen.has(x)) continue; seen.add(x); for (const y of adj.get(x)!) if (!seen.has(y)) stack.push(y); }
  }
  const degrees = nodes.map(n => ({ id: n.id, title: n.title, degree: adj.get(n.id)!.size }));
  const isolated = degrees.filter(d => d.degree === 0).length;
  return {
    nodes: nodes.length, edges: edges.length, components, isolated,
    orphanRate: nodes.length ? isolated / nodes.length : 0,
    averageDegree: nodes.length ? (2 * edges.length) / nodes.length : 0,
    hubs: degrees.sort((a, b) => b.degree - a.degree).slice(0, 8),
  };
}
