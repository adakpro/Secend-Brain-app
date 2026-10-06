import type { FastifyPluginAsync } from 'fastify';
import { OutputBriefBody, OutputVersionBody } from '@sb/contracts';
import { QUEUES, audit, withTx } from '@sb/core';
import { type Deps, parse, requireWs, HttpError, sendFile } from '../context';
import { modelAvailability } from './system';
import { markdownToSafeHtml } from '../render';

const TEMPLATE_HEADINGS: Record<string, string[]> = {
  report: ['پرسش پژوهش', 'یافته‌ها', 'اختلاف منابع', 'محدودیت‌ها و خلأها'],
  decision: ['زمینه', 'گزینه‌ها', 'معیارها', 'تصمیم پیشنهادی', 'ریسک‌ها'],
  article: ['مقدمه', 'بدنه', 'جمع‌بندی'],
};

export const studioRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  app.get('/outputs', async req => {
    const ws = requireWs(req);
    const r = await deps.db.query(`SELECT o.id, o.title, o.template, o.current_version, o.updated_at, o.project_id FROM outputs o WHERE o.workspace_id=$1 AND o.deleted_at IS NULL ORDER BY o.updated_at DESC LIMIT 100`, [ws.id]);
    return { items: r.rows };
  });

  app.get('/outputs/:id', async req => {
    const ws = requireWs(req);
    const id = (req.params as { id: string }).id;
    const o = (await deps.db.query(`SELECT * FROM outputs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [ws.id, id])).rows[0];
    if (!o) throw new HttpError(404, 'not_found', 'خروجی پیدا نشد.');
    const versions = (await deps.db.query(`SELECT id, version, author_kind, run_id, created_at, outline, source_refs FROM output_versions WHERE workspace_id=$1 AND output_id=$2 ORDER BY version DESC`, [ws.id, id])).rows;
    const cur = (await deps.db.query(`SELECT * FROM output_versions WHERE workspace_id=$1 AND output_id=$2 AND version=$3`, [ws.id, id, o.current_version])).rows[0] ?? null;
    const citations = cur ? (await deps.db.query(`SELECT id, citation_key, title, heading, excerpt, validation, document_id FROM citations WHERE workspace_id=$1 AND output_version_id=$2`, [ws.id, cur.id])).rows : [];
    const run = (await deps.db.query(`SELECT id, status, error_code, error_message, provider FROM agent_runs WHERE workspace_id=$1 AND input->>'outputId'=$2 ORDER BY created_at DESC LIMIT 1`, [ws.id, id])).rows[0] ?? null;
    return { output: o, versions, current: cur, citations, lastRun: run };
  });

  /** Creates the brief plus a deterministic template draft (no model): headings + excerpts with references. */
  app.post('/outputs', async req => {
    const ws = requireWs(req, 'member');
    const b = parse(OutputBriefBody, req.body);
    const docs = (await deps.db.query(`SELECT d.id, d.title, d.path, d.current_revision_id, r.content FROM documents d JOIN document_revisions r ON r.id=d.current_revision_id WHERE d.workspace_id=$1 AND d.id = ANY($2) AND d.deleted_at IS NULL`, [ws.id, b.documentIds])).rows;
    if (docs.length !== new Set(b.documentIds).size) throw new HttpError(403, 'forbidden_scope', 'بخشی از منابع انتخابی در این فضای دانش نیست.');
    const outline = TEMPLATE_HEADINGS[b.template];
    const excerpt = (c: string) => c.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 280);
    const content = `${b.goal ? `> هدف: ${b.goal}\n\n` : ''}${outline.map((h, i) => `## ${h}\n\n${i === 0 ? docs.map(d => `- [[${d.title}]] — ${excerpt(d.content)}`).join('\n') : '_این بخش را بنویسید یا با «تولید با مدل» پیش‌نویس بگیرید._'}`).join('\n\n')}\n\n## منابع\n\n${docs.map(d => `- [[${d.title}]] (\`${d.path}\`)`).join('\n')}\n`;
    const id = await withTx(deps.db, async tx => {
      const o = await tx.query(`INSERT INTO outputs(workspace_id, title, template, brief, current_version, project_id, created_by) VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING id`, [ws.id, b.title, b.template, b, b.projectId ?? null, req.session!.userId]);
      await tx.query(`INSERT INTO output_versions(workspace_id, output_id, version, outline, content, source_refs, author_kind) VALUES ($1,$2,1,$3,$4,$5,'template')`,
        [ws.id, o.rows[0].id, JSON.stringify(outline), content, JSON.stringify(docs.map(d => ({ documentId: d.id, revisionId: d.current_revision_id, path: d.path })))]);
      return o.rows[0].id as string;
    });
    return { id };
  });

  app.post('/outputs/:id/generate', async req => {
    const ws = requireWs(req, 'member');
    const id = (req.params as { id: string }).id;
    const o = (await deps.db.query(`SELECT * FROM outputs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [ws.id, id])).rows[0];
    if (!o) throw new HttpError(404, 'not_found', 'خروجی پیدا نشد.');
    const avail = await modelAvailability(deps);
    if (!avail.available) throw new HttpError(409, 'model_not_connected', avail.reason);
    const run = await deps.runs.create(deps.db, { workspaceId: ws.id, kind: 'studio', skillId: o.template === 'article' ? 'write' : 'report', input: { outputId: id, documentIds: o.brief.documentIds, brief: o.brief }, requestedBy: req.session!.userId, idempotencyKey: (req.body as { idempotencyKey?: string } | undefined)?.idempotencyKey });
    if (!run.existing) await deps.boss!.send(QUEUES.run, { runId: run.id }, { singletonKey: run.id });
    return { runId: run.id };
  });

  app.post('/outputs/:id/versions', async req => {
    const ws = requireWs(req, 'member');
    const id = (req.params as { id: string }).id;
    const b = parse(OutputVersionBody, req.body);
    const ver = await withTx(deps.db, async tx => {
      const o = (await tx.query(`SELECT current_version FROM outputs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, [ws.id, id])).rows[0];
      if (!o) throw new HttpError(404, 'not_found', 'خروجی پیدا نشد.');
      const prev = (await tx.query(`SELECT outline, source_refs FROM output_versions WHERE output_id=$1 AND version=$2`, [id, o.current_version])).rows[0];
      const v = o.current_version + 1;
      await tx.query(`INSERT INTO output_versions(workspace_id, output_id, version, outline, content, source_refs, author_kind) VALUES ($1,$2,$3,$4,$5,$6,'user')`, [ws.id, id, v, JSON.stringify(b.outline ?? prev?.outline ?? []), b.content, JSON.stringify(prev?.source_refs ?? [])]);
      await tx.query(`UPDATE outputs SET current_version=$2, updated_at=now() WHERE id=$1`, [id, v]);
      return v;
    });
    return { version: ver };
  });

  app.post('/outputs/:id/restore/:version', async req => {
    const ws = requireWs(req, 'member');
    const { id, version } = req.params as { id: string; version: string };
    const r = await deps.db.query(`UPDATE outputs SET current_version=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND EXISTS (SELECT 1 FROM output_versions WHERE output_id=$2 AND version=$3) RETURNING id`, [ws.id, id, Number(version)]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'نسخه پیدا نشد.');
    return { ok: true };
  });

  app.get('/outputs/:id/export', async (req, reply) => {
    const ws = requireWs(req);
    const id = (req.params as { id: string }).id;
    const { format = 'md', version } = req.query as { format?: string; version?: string };
    const o = (await deps.db.query(`SELECT * FROM outputs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [ws.id, id])).rows[0];
    if (!o) throw new HttpError(404, 'not_found', 'خروجی پیدا نشد.');
    const v = (await deps.db.query(`SELECT * FROM output_versions WHERE output_id=$1 AND version=$2`, [id, version ? Number(version) : o.current_version])).rows[0];
    if (!v) throw new HttpError(404, 'not_found', 'نسخه پیدا نشد.');
    const cites = (await deps.db.query(`SELECT citation_key, title, heading, excerpt FROM citations WHERE workspace_id=$1 AND output_version_id=$2`, [ws.id, v.id])).rows;
    const md = `# ${o.title}\n\n${v.content}${cites.length ? `\n\n## ارجاع‌ها\n\n${cites.map(c => `- [${c.citation_key}] ${c.title}${c.heading ? ' § ' + c.heading : ''}: «${String(c.excerpt).slice(0, 240).replace(/\n/g, ' ')}»`).join('\n')}` : ''}\n`;
    await audit(deps.db, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'output.exported', targetType: 'output', targetId: id, result: 'success', meta: { format, version: v.version } });
    if (format === 'md') return sendFile(reply, `${o.title}.md`, 'text/markdown; charset=utf-8', md);
    if (format === 'html') return sendFile(reply, `${o.title}.html`, 'text/html; charset=utf-8', markdownToSafeHtml(md, o.title, o.brief?.language === 'en' ? 'en' : 'fa'));
    throw new HttpError(501, 'capability_unavailable', 'خروجی PDF/DOCX در این نسخه فعال نیست (renderer فارسی/RTL نصب و آزمایش نشده است).');
  });

  app.delete('/outputs/:id', async req => {
    const ws = requireWs(req, 'member');
    const r = await deps.db.query(`UPDATE outputs SET deleted_at=now() WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id`, [ws.id, (req.params as { id: string }).id]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'خروجی پیدا نشد.');
    return { ok: true };
  });
};
