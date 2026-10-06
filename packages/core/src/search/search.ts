import type { Queryable } from '../database/pool';
import { normalizeForSearch, compactForSearch } from '../text/normalize';

export interface SearchHit {
  kind: 'document' | 'source';
  documentId: string | null; sourceVersionId: string | null; sourceId: string | null;
  revisionId: string | null; path: string | null; title: string; docKind: string;
  heading: string | null; start: number; end: number; page: number | null; snippet: string; score: number;
}

export interface SearchScope {
  workspaceId: string;
  documentIds?: string[];
  sourceIds?: string[];
  kinds?: string[];
  /** Exclude no_external material (for anything that may reach a model). */
  modelSafe?: boolean;
  includeSources?: boolean;
}

/**
 * Text search without embeddings. Matches on the tsvector of normalized text OR a substring
 * of the space-free normalized form (handles ZWNJ/space variants). Every query is filtered by
 * workspace and, when modelSafe, by sensitivity so no_external material never enters retrieval.
 */
export async function search(q: Queryable, scope: SearchScope, query: string, limit = 20): Promise<SearchHit[]> {
  const norm = normalizeForSearch(query);
  const compact = compactForSearch(query);
  if (!norm) return [];
  const terms = norm.split(' ').filter(t => t.length > 1).slice(0, 12);
  const tsq = terms.length ? terms.map(t => t.replace(/[':&|!()]/g, '') + ':*').join(' | ') : null;
  const params: unknown[] = [scope.workspaceId, tsq, compact.length >= 2 ? `%${compact.replace(/[%_\\]/g, m => '\\' + m)}%` : null, Math.min(limit, 100), query.slice(0, 100).replace(/[%_\\]/g, m => '\\' + m)];
  const docFilter: string[] = [];
  if (scope.documentIds) { params.push(scope.documentIds); docFilter.push(`d.id = ANY($${params.length})`); }
  if (scope.kinds) { params.push(scope.kinds); docFilter.push(`d.kind = ANY($${params.length})`); }
  if (scope.modelSafe) docFilter.push(`d.sensitivity <> 'no_external'`);
  const srcFilter: string[] = [];
  if (scope.sourceIds) { params.push(scope.sourceIds); srcFilter.push(`s.id = ANY($${params.length})`); }
  if (scope.modelSafe) srcFilter.push(`s.sensitivity <> 'no_external'`);
  const match = `(($2::text IS NOT NULL AND c.tsv @@ to_tsquery('simple', $2)) OR ($3::text IS NOT NULL AND c.norm_compact LIKE $3))`;
  const rank = `(CASE WHEN $2::text IS NOT NULL THEN ts_rank(c.tsv, to_tsquery('simple', $2)) ELSE 0 END + CASE WHEN $3::text IS NOT NULL AND c.norm_compact LIKE $3 THEN 0.5 ELSE 0 END)`;
  const docSql = `SELECT 'document' AS kind, d.id AS document_id, NULL::uuid AS source_version_id, NULL::uuid AS source_id, c.revision_id, d.path, d.title, d.kind AS doc_kind,
      c.heading, c.start_offset, c.end_offset, c.page, left(c.body, 400) AS snippet, ${rank} + CASE WHEN d.title ILIKE '%' || $5 || '%' THEN 1 ELSE 0 END AS score
    FROM search_chunks c JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL AND d.current_revision_id = c.revision_id
    WHERE c.workspace_id = $1 AND ${match} ${docFilter.length ? 'AND ' + docFilter.join(' AND ') : ''}`;
  const sql1 = docSql;
  const srcSql = `SELECT 'source' AS kind, NULL::uuid AS document_id, v.id AS source_version_id, s.id AS source_id, NULL::uuid AS revision_id, NULL AS path, s.title, 'raw_source' AS doc_kind,
      c.heading, c.start_offset, c.end_offset, c.page, left(c.body, 400) AS snippet, ${rank} AS score
    FROM search_chunks c JOIN source_versions v ON v.id = c.source_version_id JOIN sources s ON s.id = v.source_id AND s.current_version_id = v.id AND s.deleted_at IS NULL
    WHERE c.workspace_id = $1 AND ${match} ${srcFilter.length ? 'AND ' + srcFilter.join(' AND ') : ''}`;
  const sql = scope.includeSources ? `(${sql1}) UNION ALL (${srcSql}) ORDER BY score DESC LIMIT $4` : `${sql1} ORDER BY score DESC LIMIT $4`;
  const { rows } = await q.query(sql, params);
  return rows.map(r => ({ kind: r.kind, documentId: r.document_id, sourceVersionId: r.source_version_id, sourceId: r.source_id, revisionId: r.revision_id, path: r.path, title: r.title, docKind: r.doc_kind, heading: r.heading, start: r.start_offset, end: r.end_offset, page: r.page, snippet: r.snippet, score: Number(r.score) }));
}

export async function indexSourceVersion(q: Queryable, workspaceId: string, sourceVersionId: string, text: string, chunks: { index: number; heading: string | null; start: number; end: number; page: number | null; text: string }[]) {
  await q.query('DELETE FROM search_chunks WHERE workspace_id=$1 AND source_version_id=$2', [workspaceId, sourceVersionId]);
  for (const c of chunks) {
    await q.query(
      `INSERT INTO search_chunks(workspace_id, source_version_id, chunk_index, heading, start_offset, end_offset, page, body, norm, norm_compact) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [workspaceId, sourceVersionId, c.index, c.heading, c.start, c.end, c.page, c.text, normalizeForSearch(`${c.heading ?? ''} ${c.text}`), compactForSearch(`${c.heading ?? ''} ${c.text}`)]);
  }
  void text;
}
