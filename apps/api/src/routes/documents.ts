import type { FastifyPluginAsync } from 'fastify';
import { SaveDocumentBody, CreateNoteBody, UpdateDocumentMetaBody } from '@sb/contracts';
import { search, setFrontmatterFields, audit, normalizeRelPath } from '@sb/core';
import { type Deps, parse, requireWs, HttpError, sendFile } from '../context';

const ID = /^[0-9a-f-]{36}$/;
const slugName = (t: string) => t.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'یادداشت';

export const documentRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  app.get('/documents', async req => {
    const ws = requireWs(req);
    const q = req.query as { kind?: string; tag?: string; q?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit ?? 60) || 60, 200); const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    let ids: string[] | null = null;
    if (q.q && q.q.trim()) ids = [...new Set((await search(deps.db, { workspaceId: ws.id }, q.q, 200)).map(h => h.documentId!).filter(Boolean))];
    const r = await deps.db.query(
      `SELECT d.id, d.path, d.kind, d.title, d.tags, d.aliases, d.sensitivity, d.updated_at, d.created_at, left(regexp_replace(r.content, '^---[\\s\\S]*?\\n---\\n', ''), 400) AS excerpt, r.author_kind
       FROM documents d JOIN document_revisions r ON r.id=d.current_revision_id
       WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND d.kind NOT IN ('index','log','claude_md')
         AND ($2::text IS NULL OR d.kind=$2) AND ($3::text IS NULL OR $3 = ANY(d.tags)) AND ($4::uuid[] IS NULL OR d.id = ANY($4))
       ORDER BY d.updated_at DESC LIMIT $5 OFFSET $6`, [ws.id, q.kind && q.kind !== 'all' ? q.kind : null, q.tag || null, ids, limit, offset]);
    const total = (await deps.db.query(`SELECT count(*)::int n FROM documents d WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND d.kind NOT IN ('index','log','claude_md') AND ($2::text IS NULL OR d.kind=$2) AND ($3::text IS NULL OR $3 = ANY(d.tags)) AND ($4::uuid[] IS NULL OR d.id = ANY($4))`, [ws.id, q.kind && q.kind !== 'all' ? q.kind : null, q.tag || null, ids])).rows[0].n;
    return { items: r.rows, total, limit, offset };
  });

  app.get('/documents/:id', async req => {
    const ws = requireWs(req);
    const { id } = req.params as { id: string };
    if (!ID.test(id)) throw new HttpError(404, 'not_found', 'سند پیدا نشد.');
    const d = await deps.vault.getDocument(deps.db, ws.id, id);
    if (!d) throw new HttpError(404, 'not_found', 'سند پیدا نشد.');
    const backlinks = (await deps.db.query(`SELECT DISTINCT f.id, f.title, f.path, f.kind FROM links l JOIN documents f ON f.id=l.from_document_id WHERE l.workspace_id=$1 AND l.to_document_id=$2 AND f.deleted_at IS NULL`, [ws.id, id])).rows;
    const outgoing = (await deps.db.query(`SELECT l.target_raw, l.status, t.id, t.title, t.path FROM links l LEFT JOIN documents t ON t.id=l.to_document_id WHERE l.workspace_id=$1 AND l.from_document_id=$2 ORDER BY l.target_raw`, [ws.id, id])).rows;
    const history = (await deps.db.query(`SELECT r.id, r.revision, r.author_kind, r.created_at, r.changeset_id, u.display_name FROM document_revisions r LEFT JOIN users u ON u.id=r.author_user_id WHERE r.document_id=$1 ORDER BY r.revision DESC LIMIT 50`, [id])).rows;
    const source = d.source_id ? (await deps.db.query(`SELECT id, title FROM sources WHERE id=$1 AND workspace_id=$2`, [d.source_id, ws.id])).rows[0] ?? null : null;
    // Track "recently viewed" for the context rail (per user, bounded).
    await deps.db.query(`UPDATE user_preferences SET recent_document_ids = (ARRAY[$2::uuid] || array_remove(recent_document_ids, $2::uuid))[1:8] WHERE user_id=$1`, [req.session!.userId, id]);
    return { document: { id: d.id, path: d.path, kind: d.kind, title: d.title, tags: d.tags, aliases: d.aliases, sensitivity: d.sensitivity, content: d.content, revisionId: d.current_revision_id, revision: d.revision, sha256: d.sha256, updatedAt: d.updated_at, createdAt: d.created_at }, backlinks, outgoing, history, source, canEdit: ['owner', 'admin', 'member'].includes(ws.role) };
  });

  app.get('/documents/:id/revisions/:rev', async req => {
    const ws = requireWs(req);
    const { id, rev } = req.params as { id: string; rev: string };
    const r = (await deps.db.query(`SELECT r.id, r.revision, r.content, r.author_kind, r.created_at, r.changeset_id FROM document_revisions r WHERE r.workspace_id=$1 AND r.document_id=$2 AND r.id=$3`, [ws.id, id, rev])).rows[0];
    if (!r) throw new HttpError(404, 'not_found', 'نسخه پیدا نشد.');
    return { revision: r };
  });

  app.put('/documents/:id', async req => {
    const ws = requireWs(req, 'member');
    const { id } = req.params as { id: string };
    const b = parse(SaveDocumentBody, req.body);
    const d = await deps.vault.getDocument(deps.db, ws.id, id);
    if (!d) throw new HttpError(404, 'not_found', 'سند پیدا نشد.');
    if (['index', 'log'].includes(d.kind)) throw new HttpError(403, 'managed_file', 'index و log را برنامه نگه می‌دارد.');
    const r = await deps.vault.saveDocument({ workspaceId: ws.id, slug: ws.slug, documentId: id, content: b.content, baseRevisionId: b.baseRevisionId, userId: req.session!.userId });
    return { revisionId: r.revisionId, revision: r.revision };
  });

  app.post('/documents', async req => {
    const ws = requireWs(req, 'member');
    const b = parse(CreateNoteBody, req.body);
    const today = new Date().toISOString().slice(0, 10);
    const base = `---\ntitle: ${JSON.stringify(b.title)}\ntype: note\ncreated: ${today}\nupdated: ${today}\naliases: []\ntags: [${b.tags.map(t => JSON.stringify(t)).join(', ')}]\n---\n\n# ${b.title}\n\n${b.content}`;
    let rel = normalizeRelPath(`${b.folder}/${slugName(b.title)}.md`);
    for (let i = 2; await deps.vault.getDocumentByPath(deps.db, ws.id, rel); i++) rel = normalizeRelPath(`${b.folder}/${slugName(b.title)} ${i}.md`);
    const r = await deps.vault.saveDocument({ workspaceId: ws.id, slug: ws.slug, path: rel, content: base, userId: req.session!.userId });
    await audit(deps.db, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'document.created', targetType: 'document', targetId: r.documentId, result: 'success' });
    return { id: r.documentId, path: r.path, revisionId: r.revisionId };
  });

  app.patch('/documents/:id/meta', async req => {
    const ws = requireWs(req, 'admin');
    const { id } = req.params as { id: string };
    const b = parse(UpdateDocumentMetaBody, req.body);
    const r = await deps.db.query('UPDATE documents SET sensitivity=$3 WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id', [ws.id, id, b.sensitivity]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'سند پیدا نشد.');
    await audit(deps.db, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'document.sensitivity_changed', targetType: 'document', targetId: id, result: 'success', meta: b });
    return { ok: true };
  });

  app.post('/documents/:id/tags', async req => {
    const ws = requireWs(req, 'member');
    const { id } = req.params as { id: string };
    const { tags, baseRevisionId } = req.body as { tags: string[]; baseRevisionId: string };
    if (!Array.isArray(tags) || tags.length > 30 || tags.some(t => typeof t !== 'string' || t.length > 60)) throw new HttpError(422, 'validation_failed', 'برچسب‌ها نامعتبرند.');
    const d = await deps.vault.getDocument(deps.db, ws.id, id);
    if (!d) throw new HttpError(404, 'not_found', 'سند پیدا نشد.');
    const content = setFrontmatterFields(d.content, { tags, updated: new Date().toISOString().slice(0, 10) });
    const r = await deps.vault.saveDocument({ workspaceId: ws.id, slug: ws.slug, documentId: id, content, baseRevisionId, userId: req.session!.userId });
    return { revisionId: r.revisionId };
  });

  app.get('/documents/:id/export', async (req, reply) => {
    const ws = requireWs(req);
    const d = await deps.vault.getDocument(deps.db, ws.id, (req.params as { id: string }).id);
    if (!d) throw new HttpError(404, 'not_found', 'سند پیدا نشد.');
    return sendFile(reply, d.path.split('/').pop()!, 'text/markdown; charset=utf-8', d.content);
  });

  app.post('/documents/reconcile', async req => {
    const ws = requireWs(req, 'member');
    const report = await deps.vault.reconcile(ws.id, ws.slug);
    return { report };
  });

  app.get('/search', async req => {
    const ws = requireWs(req);
    const q = req.query as { q?: string; limit?: string };
    if (!q.q || q.q.length > 300) return { hits: [], projects: [] };
    const hits = await search(deps.db, { workspaceId: ws.id, includeSources: true }, q.q, Math.min(Number(q.limit ?? 20) || 20, 50));
    const seen = new Set<string>();
    const dedup = hits.filter(h => { const k = h.documentId ?? h.sourceId!; if (seen.has(k)) return false; seen.add(k); return true; });
    const projects = (await deps.db.query(`SELECT id, title FROM projects WHERE workspace_id=$1 AND title ILIKE '%' || $2 || '%' LIMIT 5`, [ws.id, q.q.replace(/[%_\\]/g, m => '\\' + m)])).rows;
    return { hits: dedup, projects };
  });
};
