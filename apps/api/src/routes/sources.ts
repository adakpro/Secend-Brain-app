import type { FastifyPluginAsync } from 'fastify';
import { CreateTextSourceBody, CreateUrlSourceBody, UpdateSourceBody, ReplacementTextBody } from '@sb/contracts';
import { detectType, QUEUES, audit } from '@sb/core';
import { type Deps, parse, requireWs, requireStepUp, HttpError, sendFile } from '../context';
import { modelAvailability } from './system';

const ID = /^[0-9a-f-]{36}$/;

export const sourceRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  const enqueueExtract = async (sourceId: string, analyze: boolean, userId: string) => {
    if (!deps.boss) throw new HttpError(503, 'queue_unavailable', 'صف پردازش در دسترس نیست.', true);
    await deps.boss.send(QUEUES.extract, { sourceId, analyze, userId }, { singletonKey: `extract:${sourceId}` });
  };
  const checkProject = async (wsId: string, projectId?: string | null) => {
    if (!projectId) return;
    const r = await deps.db.query('SELECT 1 FROM projects WHERE workspace_id=$1 AND id=$2', [wsId, projectId]);
    if (!r.rowCount) throw new HttpError(404, 'project_not_found', 'پروژه پیدا نشد.');
  };

  app.get('/sources', async req => {
    const ws = requireWs(req);
    const q = req.query as { status?: string; kind?: string; limit?: string; offset?: string; projectId?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200); const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const statuses = q.status ? q.status.split(',').slice(0, 12) : null;
    const r = await deps.db.query(
      `SELECT s.id, s.kind, s.title, s.status, s.status_detail, s.sensitivity, s.tags, s.project_id, p.title AS project_title, s.origin_url, s.duplicate_of, s.created_at, s.updated_at,
         v.byte_size, v.quality, v.original_name, v.coverage,
         (SELECT row_to_json(x) FROM (SELECT r.id, r.status, r.error_code, r.provider FROM agent_runs r WHERE r.source_id=s.id ORDER BY r.created_at DESC LIMIT 1) x) AS last_run,
         (SELECT c.id FROM changesets c JOIN agent_runs r2 ON r2.id=c.run_id WHERE r2.source_id=s.id ORDER BY c.created_at DESC LIMIT 1) AS changeset_id
       FROM sources s LEFT JOIN source_versions v ON v.id=s.current_version_id LEFT JOIN projects p ON p.id=s.project_id
       WHERE s.workspace_id=$1 AND s.deleted_at IS NULL AND ($2::text[] IS NULL OR s.status = ANY($2)) AND ($3::text IS NULL OR s.kind=$3) AND ($4::uuid IS NULL OR s.project_id=$4)
       ORDER BY s.created_at DESC LIMIT $5 OFFSET $6`, [ws.id, statuses, q.kind ?? null, q.projectId && ID.test(q.projectId) ? q.projectId : null, limit, offset]);
    const total = (await deps.db.query(`SELECT count(*)::int n FROM sources WHERE workspace_id=$1 AND deleted_at IS NULL AND ($2::text[] IS NULL OR status = ANY($2))`, [ws.id, statuses])).rows[0].n;
    return { items: r.rows, total, limit, offset };
  });

  app.get('/sources/:id', async req => {
    const ws = requireWs(req);
    const { id } = req.params as { id: string };
    if (!ID.test(id)) throw new HttpError(404, 'not_found', 'منبع پیدا نشد.');
    const s = (await deps.db.query(`SELECT * FROM sources WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [ws.id, id])).rows[0];
    if (!s) throw new HttpError(404, 'not_found', 'منبع پیدا نشد.');
    const versions = (await deps.db.query(`SELECT id, version, sha256, mime, byte_size, original_name, extractor, extractor_version, quality, coverage, extracted_meta - 'sanitizedHtml' AS meta, derived_from, created_at, left(extracted_text, 6000) AS preview, length(extracted_text) AS text_length FROM source_versions WHERE source_id=$1 ORDER BY version DESC`, [id])).rows;
    const runs = (await deps.db.query(`SELECT id, status, skill_id, provider, model, error_code, error_message, usage, created_at, finished_at FROM agent_runs WHERE workspace_id=$1 AND source_id=$2 ORDER BY created_at DESC LIMIT 20`, [ws.id, id])).rows;
    const changesets = (await deps.db.query(`SELECT c.id, c.status, c.title, c.created_at FROM changesets c JOIN agent_runs r ON r.id=c.run_id WHERE c.workspace_id=$1 AND r.source_id=$2 ORDER BY c.created_at DESC`, [ws.id, id])).rows;
    const pages = (await deps.db.query(`SELECT DISTINCT d.id, d.title, d.path FROM documents d JOIN document_revisions dr ON dr.document_id=d.id JOIN changesets c ON c.id=dr.changeset_id JOIN agent_runs r ON r.id=c.run_id WHERE r.source_id=$1 AND d.deleted_at IS NULL`, [id])).rows;
    const dup = s.duplicate_of ? (await deps.db.query(`SELECT id, title FROM sources WHERE id=$1 AND workspace_id=$2`, [s.duplicate_of, ws.id])).rows[0] : null;
    return { source: s, versions, runs, changesets, pages, duplicateOf: dup };
  });

  app.post('/sources/text', async req => {
    const ws = requireWs(req, 'member');
    const b = parse(CreateTextSourceBody, req.body);
    await checkProject(ws.id, b.projectId);
    const buf = Buffer.from(b.text, 'utf8');
    const r = await deps.sources.createFromBytes({ workspaceId: ws.id, userId: req.session!.userId, title: b.title, kind: b.kind, sensitivity: b.sensitivity, tags: b.tags, projectId: b.projectId, idempotencyKey: b.idempotencyKey, buf, mime: b.kind === 'markdown' ? 'text/markdown' : 'text/plain', ext: b.kind === 'markdown' ? '.md' : '.txt', originalName: b.kind === 'markdown' ? 'pasted.md' : 'pasted.txt' });
    if (!r.existing) await enqueueExtract(r.id, b.autoAnalyze && b.sensitivity !== 'no_external', req.session!.userId);
    return { id: r.id, existing: r.existing, duplicateOf: r.duplicateOf };
  });

  app.post('/sources/url', async req => {
    const ws = requireWs(req, 'member');
    const b = parse(CreateUrlSourceBody, req.body);
    await checkProject(ws.id, b.projectId);
    const r = await deps.sources.createUrl({ workspaceId: ws.id, userId: req.session!.userId, title: b.title ?? '', kind: 'url', sensitivity: b.sensitivity, tags: b.tags, projectId: b.projectId, idempotencyKey: b.idempotencyKey, url: b.url });
    if (!r.existing) await enqueueExtract(r.id, b.autoAnalyze && b.sensitivity !== 'no_external', req.session!.userId);
    return { id: r.id, existing: r.existing, duplicateOf: r.duplicateOf };
  });

  app.post('/sources/upload', async req => {
    const ws = requireWs(req, 'member');
    const file = await req.file();
    if (!file) throw new HttpError(422, 'file_required', 'فایلی ارسال نشد.');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, 'too_large', 'حجم فایل بیش از ۲۵ مگابایت است.');
    const f = (n: string) => { const v = (file.fields[n] as { value?: string } | undefined)?.value; return typeof v === 'string' ? v : undefined; };
    const det = detectType(buf, file.filename);
    if (det.mismatch) throw new HttpError(415, 'type_mismatch', 'پسوند فایل با محتوای آن سازگار نیست.');
    if (det.type === 'zip' || det.type === 'binary' || det.type === 'html') throw new HttpError(415, 'unsupported_type', 'این نوع فایل به‌عنوان منبع پذیرفته نمی‌شود (PDF، Markdown، متن UTF-8 یا JSON گفتگو).');
    const kind = det.type === 'pdf' ? 'pdf' : det.type === 'json' ? 'chat' : det.type === 'markdown' ? 'markdown' : (/\.(vtt|srt)$/i.test(file.filename) ? 'transcript' : 'file');
    const sensitivity = ['public', 'private_model', 'no_external'].includes(f('sensitivity') ?? '') ? f('sensitivity')! : 'private_model';
    let tags: string[] = [];
    try { tags = JSON.parse(f('tags') ?? '[]'); } catch { tags = []; }
    tags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string').map(t => t.slice(0, 60)).slice(0, 20) : [];
    const projectId = f('projectId') && ID.test(f('projectId')!) ? f('projectId')! : null;
    await checkProject(ws.id, projectId);
    const ext = det.type === 'pdf' ? '.pdf' : det.type === 'json' ? '.json' : det.type === 'markdown' ? '.md' : '.txt';
    const r = await deps.sources.createFromBytes({ workspaceId: ws.id, userId: req.session!.userId, title: (f('title') || file.filename).slice(0, 200), kind, sensitivity, tags, projectId, idempotencyKey: f('idempotencyKey'), buf, mime: det.type === 'pdf' ? 'application/pdf' : det.type === 'json' ? 'application/json' : 'text/plain', ext, originalName: file.filename });
    if (!r.existing) await enqueueExtract(r.id, f('autoAnalyze') === 'true' && sensitivity !== 'no_external', req.session!.userId);
    return { id: r.id, existing: r.existing, duplicateOf: r.duplicateOf, kind };
  });

  app.patch('/sources/:id', async req => {
    const ws = requireWs(req, 'member');
    const { id } = req.params as { id: string };
    const b = parse(UpdateSourceBody, req.body);
    await checkProject(ws.id, b.projectId);
    const r = await deps.db.query(
      `UPDATE sources SET title=coalesce($3,title), tags=coalesce($4,tags), sensitivity=coalesce($5,sensitivity), project_id=CASE WHEN $6::boolean THEN $7::uuid ELSE project_id END, updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id`,
      [ws.id, id, b.title ?? null, b.tags ?? null, b.sensitivity ?? null, b.projectId !== undefined, b.projectId ?? null]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'منبع پیدا نشد.');
    if (b.sensitivity) await audit(deps.db, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'source.sensitivity_changed', targetType: 'source', targetId: id, result: 'success', meta: { sensitivity: b.sensitivity } });
    return { ok: true };
  });

  app.post('/sources/:id/analyze', async req => {
    const ws = requireWs(req, 'member');
    const { id } = req.params as { id: string };
    const s = (await deps.db.query(`SELECT status, sensitivity FROM sources WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [ws.id, id])).rows[0];
    if (!s) throw new HttpError(404, 'not_found', 'منبع پیدا نشد.');
    if (s.sensitivity === 'no_external') throw new HttpError(409, 'no_external', 'این منبع «عدم ارسال بیرونی» دارد و به مدل فرستاده نمی‌شود.');
    if (!['ready_for_analysis', 'analysis_failed', 'canceled', 'awaiting_review', 'applied'].includes(s.status)) throw new HttpError(409, 'not_ready', 'منبع هنوز آمادهٔ تحلیل نیست.');
    const avail = await modelAvailability(deps);
    if (!avail.available) throw new HttpError(409, 'model_not_connected', avail.reason);
    const key = (req.body as { idempotencyKey?: string } | undefined)?.idempotencyKey;
    const run = await deps.runs.create(deps.db, { workspaceId: ws.id, kind: 'ingest', skillId: 'ingest', input: { sourceId: id }, requestedBy: req.session!.userId, sourceId: id, idempotencyKey: key });
    if (!run.existing) { await deps.db.query(`UPDATE sources SET status='queued', status_detail=NULL WHERE id=$1`, [id]); await deps.boss!.send(QUEUES.run, { runId: run.id }, { singletonKey: run.id }); }
    return { runId: run.id, existing: run.existing };
  });

  app.post('/sources/:id/retry-extract', async req => {
    const ws = requireWs(req, 'member');
    const { id } = req.params as { id: string };
    const r = await deps.db.query(`UPDATE sources SET status='queued', status_detail=NULL WHERE workspace_id=$1 AND id=$2 AND status IN ('extraction_failed','needs_ocr','canceled') RETURNING id`, [ws.id, id]);
    if (!r.rowCount) throw new HttpError(409, 'not_retryable', 'این منبع در وضعیت قابل تکرار نیست.');
    await enqueueExtract(id, false, req.session!.userId);
    return { ok: true };
  });

  app.post('/sources/:id/replacement-text', async req => {
    const ws = requireWs(req, 'member');
    const { id } = req.params as { id: string };
    const b = parse(ReplacementTextBody, req.body);
    const v = await deps.sources.addReplacementText(ws.id, id, req.session!.userId, b.text);
    return { versionId: v };
  });

  app.get('/sources/:id/raw', async (req, reply) => {
    const ws = requireWs(req);
    const { id } = req.params as { id: string };
    const v = (await deps.db.query(`SELECT v.storage_path, v.mime, v.original_name, s.title FROM sources s JOIN source_versions v ON v.source_id=s.id WHERE s.workspace_id=$1 AND s.id=$2 AND s.deleted_at IS NULL ORDER BY v.version ASC LIMIT 1`, [ws.id, id])).rows[0];
    if (!v) throw new HttpError(404, 'not_found', 'منبع پیدا نشد.');
    const buf = await deps.sources.readBytes(v.storage_path);
    // Untrusted original: always a download, never rendered on the app origin.
    return sendFile(reply, v.original_name ?? `${v.title}.bin`, 'application/octet-stream', buf);
  });

  app.delete('/sources/:id', async req => {
    const ws = requireWs(req, 'admin'); requireStepUp(req);
    const { id } = req.params as { id: string };
    await deps.sources.purge(ws.id, id, req.session!.userId);
    return { ok: true };
  });
};
