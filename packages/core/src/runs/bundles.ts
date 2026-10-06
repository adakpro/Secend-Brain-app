import type { Queryable } from '../database/pool';
import type { JobBundle, BundleChunk, BundleDoc } from '@sb/contracts';
import { search } from '../search/search';

/**
 * Builds the scope-filtered input for one run. The model never sees anything outside this
 * bundle: no_external material, other workspaces and out-of-scope pages are excluded here,
 * including from the index titles.
 */
export interface Scope { type: 'workspace' | 'project' | 'documents' | 'sources' | 'tag'; projectId?: string; documentIds?: string[]; sourceIds?: string[]; tag?: string }

const MAX_DOCS = 40;
const MAX_CHARS = 180_000;

async function scopedDocIds(q: Queryable, workspaceId: string, scope: Scope): Promise<string[] | null> {
  if (scope.type === 'documents') return scope.documentIds ?? [];
  if (scope.type === 'tag' && scope.tag) return (await q.query(`SELECT id FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL AND $2 = ANY(tags)`, [workspaceId, scope.tag])).rows.map(r => r.id);
  if (scope.type === 'project' && scope.projectId) {
    // Pages produced from the project's linked sources plus pages under projects/<project>.
    return (await q.query(
      `SELECT DISTINCT d.id FROM documents d LEFT JOIN sources s ON s.id = d.source_id
       WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND (s.project_id=$2 OR d.path LIKE 'projects/%' AND d.path ILIKE '%' || (SELECT title FROM projects WHERE id=$2) || '%')`, [workspaceId, scope.projectId])).rows.map(r => r.id);
  }
  if (scope.type === 'sources') return [];
  return null; // whole workspace
}

async function loadDocs(q: Queryable, workspaceId: string, ids: string[] | null, prefer: string[], startKey: number) {
  const params: unknown[] = [workspaceId];
  let filter = '';
  if (ids) { params.push(ids); filter = `AND d.id = ANY($2)`; }
  const index = (await q.query(`SELECT d.id, d.path, d.title, d.kind FROM documents d WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND d.sensitivity <> 'no_external' AND d.kind IN ('source','concept','entity','synthesis','note','project') ${filter} ORDER BY d.kind, d.title LIMIT 2000`, params)).rows;
  const order = [...new Set([...prefer.filter(id => index.some(i => i.id === id)), ...index.map(i => i.id)])].slice(0, MAX_DOCS);
  const chunks: BundleChunk[] = []; const docs: BundleDoc[] = [];
  let k = startKey; let chars = 0;
  for (const id of order) {
    const d = (await q.query(`SELECT d.id, d.path, d.title, d.kind, d.aliases, d.current_revision_id FROM documents d WHERE d.id=$1`, [id])).rows[0];
    const cs = (await q.query(`SELECT * FROM search_chunks WHERE workspace_id=$1 AND document_id=$2 AND revision_id=$3 ORDER BY chunk_index`, [workspaceId, id, d.current_revision_id])).rows;
    const size = cs.reduce((a, c) => a + c.body.length, 0);
    if (chars + size > MAX_CHARS && docs.length) continue;
    chars += size;
    const keys: string[] = [];
    for (const c of cs) {
      const key = `C${++k}`; keys.push(key);
      chunks.push({ key, kind: 'document', documentId: d.id, revisionId: d.current_revision_id, path: d.path, title: d.title, heading: c.heading, start: c.start_offset, end: c.end_offset, page: c.page, text: c.body });
    }
    const links = (await q.query(`SELECT target_raw FROM links WHERE workspace_id=$1 AND from_document_id=$2`, [workspaceId, id])).rows.map(r => r.target_raw);
    docs.push({ path: d.path, title: d.title, kind: d.kind, documentId: d.id, revisionId: d.current_revision_id, aliases: d.aliases, chunkKeys: keys, links });
  }
  return { index: index.map(i => ({ path: i.path, title: i.title, kind: i.kind })), docs, chunks, nextKey: k };
}

export async function buildQueryBundle(q: Queryable, workspaceId: string, question: string, scope: Scope): Promise<JobBundle> {
  const ids = await scopedDocIds(q, workspaceId, scope);
  const hits = await search(q, { workspaceId, documentIds: ids ?? undefined, modelSafe: true }, question, 30);
  const prefer = [...new Set(hits.map(h => h.documentId!).filter(Boolean))];
  // One hop of outgoing links from the best hits (the upstream "follow links" step).
  if (prefer.length) {
    const nb = await q.query(`SELECT DISTINCT to_document_id FROM links WHERE workspace_id=$1 AND from_document_id = ANY($2) AND to_document_id IS NOT NULL`, [workspaceId, prefer.slice(0, 8)]);
    for (const r of nb.rows) if (!ids || ids.includes(r.to_document_id)) prefer.push(r.to_document_id);
  }
  const { index, docs, chunks } = await loadDocs(q, workspaceId, ids, prefer, 0);
  return { index, docs, chunks };
}

export async function buildDocsBundle(q: Queryable, workspaceId: string, documentIds: string[]): Promise<JobBundle> {
  const { index, docs, chunks } = await loadDocs(q, workspaceId, documentIds, documentIds, 0);
  return { index, docs, chunks };
}

export async function buildIngestBundle(q: Queryable, workspaceId: string, sourceId: string): Promise<{ bundle: JobBundle; coverage: { totalChunks: number; included: number } }> {
  const s = (await q.query(`SELECT s.*, v.id AS vid, v.extracted_text FROM sources s JOIN source_versions v ON v.id=s.current_version_id WHERE s.workspace_id=$1 AND s.id=$2`, [workspaceId, sourceId])).rows[0];
  if (!s) throw new Error('source not found');
  if (s.sensitivity === 'no_external') throw Object.assign(new Error('source is marked no_external'), { code: 'no_external' });
  const sc = (await q.query(`SELECT * FROM search_chunks WHERE workspace_id=$1 AND source_version_id=$2 ORDER BY chunk_index`, [workspaceId, s.vid])).rows;
  const chunks: BundleChunk[] = []; let k = 0; let chars = 0; let included = 0;
  for (const c of sc) {
    if (chars + c.body.length > MAX_CHARS) break;
    chars += c.body.length; included++;
    chunks.push({ key: `S${++k}`, kind: 'source', sourceVersionId: s.vid, title: s.title, heading: c.heading, start: c.start_offset, end: c.end_offset, page: c.page, text: c.body });
  }
  // Related existing pages: search with the source title and leading text.
  const probe = `${s.title} ${String(s.extracted_text ?? '').slice(0, 400)}`;
  const hits = await search(q, { workspaceId, modelSafe: true, kinds: ['source', 'concept', 'entity', 'synthesis'] }, probe, 20);
  const prefer = [...new Set(hits.map(h => h.documentId!).filter(Boolean))];
  const loaded = await loadDocs(q, workspaceId, null, prefer, 0);
  return { bundle: { index: loaded.index, docs: loaded.docs.slice(0, 15), chunks: [...chunks, ...loaded.chunks.filter(c => loaded.docs.slice(0, 15).some(d => d.chunkKeys.includes(c.key)))], source: { title: s.title, chunkKeys: chunks.map(c => c.key), totalChars: String(s.extracted_text ?? '').length } }, coverage: { totalChunks: sc.length, included } };
}
