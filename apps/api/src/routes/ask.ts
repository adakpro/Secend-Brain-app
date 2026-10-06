import type { FastifyPluginAsync } from 'fastify';
import { AskBody } from '@sb/contracts';
import { search, QUEUES, withTx, normalizeRelPath } from '@sb/core';
import { type Deps, parse, requireWs, HttpError, sendFile } from '../context';
import { modelAvailability } from './system';

const slugName = (t: string) => t.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'پاسخ';

export const askRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  app.get('/conversations', async req => {
    const ws = requireWs(req);
    const r = await deps.db.query(`SELECT id, title, scope, created_at, updated_at FROM conversations WHERE workspace_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`, [ws.id, req.session!.userId]);
    return { items: r.rows };
  });

  const loadConversation = async (wsId: string, userId: string, id: string) => {
    const c = (await deps.db.query(`SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND deleted_at IS NULL`, [wsId, id, userId])).rows[0];
    if (!c) throw new HttpError(404, 'not_found', 'گفتگو پیدا نشد.');
    const messages = (await deps.db.query(`SELECT m.id, m.role, m.mode, m.content, m.meta, m.run_id, m.created_at, r.status AS run_status FROM messages m LEFT JOIN agent_runs r ON r.id=m.run_id WHERE m.workspace_id=$1 AND m.conversation_id=$2 ORDER BY m.created_at`, [wsId, id])).rows;
    const cites = (await deps.db.query(
      `SELECT c.id, c.message_id, c.citation_key, c.title, c.heading, c.page, c.excerpt, c.validation, c.document_id, c.revision_id, c.source_version_id,
         (d.current_revision_id IS DISTINCT FROM c.revision_id AND c.document_id IS NOT NULL) AS stale, d.path
       FROM citations c LEFT JOIN documents d ON d.id=c.document_id AND d.workspace_id=c.workspace_id
       WHERE c.workspace_id=$1 AND c.message_id = ANY($2)`, [wsId, messages.map(m => m.id)])).rows;
    // Pending runs (no assistant message yet) so the UI can attach to the stream after a refresh.
    const pending = (await deps.db.query(`SELECT id, status FROM agent_runs WHERE workspace_id=$1 AND conversation_id=$2 AND status IN ('queued','running','cancel_requested') ORDER BY created_at DESC LIMIT 1`, [wsId, id])).rows[0] ?? null;
    return { conversation: c, messages: messages.map(m => ({ ...m, citations: cites.filter(x => x.message_id === m.id) })), pendingRun: pending };
  };

  app.get('/conversations/:id', async req => {
    const ws = requireWs(req);
    return loadConversation(ws.id, req.session!.userId, (req.params as { id: string }).id);
  });

  app.delete('/conversations/:id', async req => {
    const ws = requireWs(req);
    const r = await deps.db.query(`UPDATE conversations SET deleted_at=now() WHERE workspace_id=$1 AND id=$2 AND user_id=$3 RETURNING id`, [ws.id, (req.params as { id: string }).id, req.session!.userId]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'گفتگو پیدا نشد.');
    return { ok: true };
  });

  app.get('/conversations/:id/export', async (req, reply) => {
    const ws = requireWs(req);
    const { conversation, messages } = await loadConversation(ws.id, req.session!.userId, (req.params as { id: string }).id);
    const md = `# ${conversation.title || 'گفتگو'}\n\n` + messages.map(m => {
      const who = m.role === 'user' ? '**پرسش**' : m.mode === 'text_search' ? '**نتیجهٔ جست‌وجوی متنی (پاسخ مدل نیست)**' : m.mode === 'error' ? '**خطا**' : '**پاسخ مدل**';
      const refs = m.citations.length ? '\n\n' + m.citations.map((c: Record<string, any>) => `- [${c.citation_key}] ${c.title}${c.heading ? ' § ' + c.heading : ''}: «${String(c.excerpt).slice(0, 200)}»${c.validation?.valid ? '' : ' (ارجاع نامعتبر)'}`).join('\n') : '';
      return `${who}\n\n${m.content}${refs}\n`;
    }).join('\n---\n\n');
    return sendFile(reply, `${slugName(conversation.title || 'conversation')}.md`, 'text/markdown; charset=utf-8', md);
  });

  app.post('/ask', async req => {
    const ws = requireWs(req, 'viewer');
    const b = parse(AskBody, req.body);
    // Scope references must belong to this workspace.
    if (b.scope.documentIds?.length) {
      const n = (await deps.db.query(`SELECT count(*)::int n FROM documents WHERE workspace_id=$1 AND id = ANY($2)`, [ws.id, b.scope.documentIds])).rows[0].n;
      if (n !== new Set(b.scope.documentIds).size) throw new HttpError(403, 'forbidden_scope', 'بخشی از محدودهٔ انتخابی در این فضای دانش نیست.');
    }
    if (b.scope.projectId && !(await deps.db.query(`SELECT 1 FROM projects WHERE workspace_id=$1 AND id=$2`, [ws.id, b.scope.projectId])).rowCount) throw new HttpError(403, 'forbidden_scope', 'پروژه در این فضا نیست.');
    const userId = req.session!.userId;
    const avail = await modelAvailability(deps);
    const conversationId = await withTx(deps.db, async tx => {
      let cid = b.conversationId;
      if (cid) {
        const ok = await tx.query(`SELECT 1 FROM conversations WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND deleted_at IS NULL`, [ws.id, cid, userId]);
        if (!ok.rowCount) throw new HttpError(404, 'not_found', 'گفتگو پیدا نشد.');
      } else {
        cid = (await tx.query(`INSERT INTO conversations(workspace_id, user_id, title, scope) VALUES ($1,$2,$3,$4) RETURNING id`, [ws.id, userId, b.question.slice(0, 80), b.scope])).rows[0].id as string;
      }
      await tx.query(`INSERT INTO messages(workspace_id, conversation_id, role, mode, content) VALUES ($1,$2,'user','question',$3)`, [ws.id, cid, b.question]);
      return cid!;
    });
    if (!avail.available) {
      // Explicit text-search mode: results are labelled as search, never as a model answer.
      const hits = await search(deps.db, { workspaceId: ws.id, documentIds: b.scope.type === 'documents' ? b.scope.documentIds : undefined }, b.question, 8);
      const content = hits.length ? `${hits.length} بخش مرتبط با جست‌وجوی متنی پیدا شد. این نتیجه پاسخ تولیدشده توسط مدل نیست.` : 'جست‌وجوی متنی نتیجه‌ای پیدا نکرد.';
      await deps.db.query(`INSERT INTO messages(workspace_id, conversation_id, role, mode, content, meta) VALUES ($1,$2,'assistant','text_search',$3,$4)`,
        [ws.id, conversationId, content, { reason: avail.reason, hits: hits.map(h => ({ documentId: h.documentId, title: h.title, path: h.path, heading: h.heading, snippet: h.snippet })) }]);
      return { conversationId, mode: 'text_search', reason: avail.reason };
    }
    const run = await deps.runs.create(deps.db, { workspaceId: ws.id, kind: 'query', skillId: 'query', input: { question: b.question }, scope: b.scope, requestedBy: userId, conversationId, idempotencyKey: b.idempotencyKey });
    if (!run.existing) await deps.boss!.send(QUEUES.run, { runId: run.id }, { singletonKey: run.id });
    return { conversationId, mode: 'model', runId: run.id, provider: deps.cfg.modelProviderMode };
  });

  app.get('/citations/:id', async req => {
    const ws = requireWs(req);
    const c = (await deps.db.query(
      `SELECT c.*, d.path, d.title AS doc_title, (d.current_revision_id IS DISTINCT FROM c.revision_id) AS stale, r.revision, s.id AS source_id, s.title AS source_title
       FROM citations c LEFT JOIN documents d ON d.id=c.document_id AND d.workspace_id=c.workspace_id LEFT JOIN document_revisions r ON r.id=c.revision_id
       LEFT JOIN source_versions v ON v.id=c.source_version_id LEFT JOIN sources s ON s.id=v.source_id
       WHERE c.workspace_id=$1 AND c.id=$2`, [ws.id, (req.params as { id: string }).id])).rows[0];
    if (!c) throw new HttpError(404, 'not_found', 'ارجاع پیدا نشد.');
    return { citation: c };
  });

  /** Explicit "save answer as note": becomes a reviewable proposal, never a silent write. */
  app.post('/messages/:id/to-note', async req => {
    const ws = requireWs(req, 'member');
    const { projectId, title } = (req.body ?? {}) as { projectId?: string; title?: string };
    const m = (await deps.db.query(`SELECT m.*, c.title AS ctitle FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.workspace_id=$1 AND m.id=$2 AND c.user_id=$3 AND m.role='assistant'`, [ws.id, (req.params as { id: string }).id, req.session!.userId])).rows[0];
    if (!m) throw new HttpError(404, 'not_found', 'پیام پیدا نشد.');
    const cites = (await deps.db.query(`SELECT citation_key, title, heading, excerpt, validation FROM citations WHERE workspace_id=$1 AND message_id=$2`, [ws.id, m.id])).rows;
    const name = slugName(title || m.ctitle || 'پاسخ');
    let folder = 'notes';
    if (projectId) {
      const p = (await deps.db.query(`SELECT title FROM projects WHERE workspace_id=$1 AND id=$2`, [ws.id, projectId])).rows[0];
      if (!p) throw new HttpError(404, 'project_not_found', 'پروژه پیدا نشد.');
      folder = `projects/${slugName(p.title)}/Outputs`;
    }
    const today = new Date().toISOString().slice(0, 10);
    const content = `---\ntitle: ${JSON.stringify(name)}\ntype: note\ncreated: ${today}\nupdated: ${today}\naliases: []\ntags: [answer]\n---\n\n# ${name}\n\n${m.content}\n\n## ارجاع‌ها\n\n${cites.map(c => `- [${c.citation_key}] ${c.title}${c.heading ? ' § ' + c.heading : ''}: «${String(c.excerpt).slice(0, 300).replace(/\n/g, ' ')}»`).join('\n') || '- (بدون ارجاع)'}\n`;
    const path = normalizeRelPath(`${folder}/${name}.md`);
    const id = await deps.engine.propose({ workspaceId: ws.id, runId: null, origin: 'manual', title: `ذخیرهٔ پاسخ به‌عنوان یادداشت: ${name}`, summary: 'اقدام صریح کاربر؛ پس از تأیید در مرکز بررسی ذخیره می‌شود.', ops: [{ op: 'create', path, content }], sourceRefs: [], report: { sourceLabel: `answer ${m.id.slice(0, 8)}` } });
    return { changesetId: id };
  });
};
