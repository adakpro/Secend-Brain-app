import type { FastifyPluginAsync } from 'fastify';
import { CreateWorkspaceBody } from '@sb/contracts';
import { audit, withTx } from '@sb/core';
import { type Deps, parse, requireSession, requireWs, requireAdmin } from '../context';

export const workspaceRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  app.get('/workspaces', async req => {
    const s = requireSession(req);
    return { workspaces: (await deps.auth.memberships(deps.db, s.userId)).map(w => ({ id: w.id, slug: w.slug, name: w.name, role: w.role, isDemo: w.is_demo })) };
  });

  app.post('/workspaces', async req => {
    const { session } = await requireAdmin(req, deps);
    const b = parse(CreateWorkspaceBody, req.body);
    const id = await withTx(deps.db, async tx => {
      const w = await tx.query('INSERT INTO workspaces(slug, name) VALUES ($1,$2) RETURNING id', [b.slug, b.name]);
      await tx.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [w.rows[0].id, session.userId]);
      await audit(tx, { workspaceId: w.rows[0].id, actorUserId: session.userId, action: 'workspace.created', result: 'success' });
      return w.rows[0].id as string;
    });
    await deps.vault.initWorkspace(id, b.slug);
    return { id };
  });

  app.patch('/workspaces/current', async req => {
    const ws = requireWs(req, 'admin');
    const { name } = req.body as { name?: string };
    if (!name || name.length > 100) return { ok: false };
    await deps.db.query('UPDATE workspaces SET name=$2, updated_at=now() WHERE id=$1', [ws.id, name]);
    return { ok: true };
  });

  /** Dashboard numbers come only from real rows; nothing is invented for an empty install. */
  app.get('/workspaces/current/overview', async req => {
    const ws = requireWs(req);
    const q = (sql: string, p: unknown[] = [ws.id]) => deps.db.query(sql, p).then(r => r.rows);
    const [counts] = await q(`SELECT
        (SELECT count(*)::int FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL AND kind IN ('source','concept','entity','synthesis','note')) AS knowledge,
        (SELECT count(*)::int FROM projects WHERE workspace_id=$1 AND status='active') AS projects,
        (SELECT count(*)::int FROM changesets WHERE workspace_id=$1 AND status IN ('proposed','conflict')) AS reviews,
        (SELECT count(*)::int FROM sources WHERE workspace_id=$1 AND deleted_at IS NULL AND status NOT IN ('applied','canceled')) AS inbox,
        (SELECT count(*)::int FROM sources WHERE workspace_id=$1 AND created_at > date_trunc('day', now())) AS sources_today,
        (SELECT count(*)::int FROM document_revisions WHERE workspace_id=$1 AND author_kind='user' AND created_at > date_trunc('day', now())) AS edits_today,
        (SELECT count(*)::int FROM quiz_attempts WHERE workspace_id=$1 AND created_at > date_trunc('day', now())) AS quiz_today`);
    const recentDocs = await q(`SELECT d.id, d.title, d.kind, d.path, d.updated_at FROM documents d WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND d.kind IN ('source','concept','entity','synthesis','note') ORDER BY d.updated_at DESC LIMIT 5`);
    const projects = await q(`SELECT p.id, p.title, p.color, p.status, count(t.*)::int AS tasks, count(t.*) FILTER (WHERE t.done)::int AS done FROM projects p LEFT JOIN tasks t ON t.project_id=p.id WHERE p.workspace_id=$1 AND p.status <> 'archived' GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 3`);
    const lastConversation = (await q(`SELECT id, title, updated_at FROM conversations WHERE workspace_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`, [ws.id, req.session!.userId]))[0] ?? null;
    const tags = await q(`SELECT t, count(*)::int AS n FROM documents, unnest(tags) t WHERE workspace_id=$1 AND deleted_at IS NULL GROUP BY t ORDER BY n DESC LIMIT 8`);
    // Explainable suggestions, each derived from a concrete query.
    const suggestions: { kind: string; text: string; target: string; count?: number }[] = [];
    if (counts.reviews) suggestions.push({ kind: 'review', text: `${counts.reviews} بستهٔ پیشنهادی منتظر بررسی توست.`, target: '/review', count: counts.reviews });
    const ready = (await q(`SELECT count(*)::int AS n FROM sources WHERE workspace_id=$1 AND status='ready_for_analysis' AND deleted_at IS NULL`))[0].n;
    if (ready) suggestions.push({ kind: 'ingest', text: `${ready} منبع استخراج‌شده آمادهٔ پردازش است.`, target: '/inbox', count: ready });
    const broken = (await q(`SELECT count(*)::int AS n FROM links WHERE workspace_id=$1 AND status='missing'`))[0].n;
    if (broken) suggestions.push({ kind: 'health', text: `${broken} لینک به صفحه‌ای که هنوز وجود ندارد اشاره می‌کند.`, target: '/activity', count: broken });
    const orphans = (await q(`SELECT count(*)::int AS n FROM documents d WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND d.kind IN ('concept','entity','synthesis') AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_document_id=d.id)`))[0].n;
    if (orphans) suggestions.push({ kind: 'graph', text: `${orphans} صفحه هیچ لینک ورودی ندارد؛ در نقشه ببین به کجا وصل شوند.`, target: '/graph', count: orphans });
    return { counts, recentDocs, projects, lastConversation, tags, suggestions, workspace: { id: ws.id, name: ws.name, slug: ws.slug, role: ws.role, isDemo: ws.isDemo } };
  });
};
