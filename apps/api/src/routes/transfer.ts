import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ZipWriter, ZipReader, ZipError, audit, withTx, normalizeRelPath, isManagedPath, parseMarkdown, sha256Hex } from '@sb/core';
import { type Deps, requireWs, parse, HttpError, sendFile } from '../context';

const slugName = (t: string) => t.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'یادداشت';
const yamlStr = (s: string) => JSON.stringify(s);

// Shape of the reference HTML prototype's JSON backup (schema 1, localStorage export).
const HtmlNote = z.object({
  id: z.string().max(100), title: z.string().max(200), content: z.string().max(250_000), type: z.enum(['source', 'concept', 'entity', 'synthesis', 'note']),
  status: z.enum(['ready', 'inbox']), tags: z.array(z.string().max(80)).max(30), description: z.string().max(1000).optional().default(''),
  project: z.string().max(100).optional().default(''), created: z.string().max(100), updated: z.string().max(100), link: z.string().max(2000).optional(), demo: z.boolean().optional(),
}).passthrough();
const HtmlState = z.object({
  schema: z.literal(1),
  notes: z.array(HtmlNote).max(3000),
  projects: z.array(z.object({ id: z.string().max(100), title: z.string().max(200), description: z.string().max(1000), tasks: z.array(z.object({ text: z.string().max(300), done: z.boolean() })).max(100), color: z.enum(['blue', 'purple', 'teal', 'green', 'orange']), demo: z.boolean().optional() }).passthrough()).max(500),
  reviews: z.array(z.unknown()).max(500), activity: z.array(z.unknown()).max(500),
  profile: z.object({ name: z.string().max(100), workspace: z.string().max(100) }).passthrough(),
}).passthrough();

const DEMO_IDS = /^(n\d{1,2}|p\d)$/; // ids used by the prototype's seed data

function isDemo(item: { id: string; demo?: boolean }) { return item.demo === true || (item.demo === undefined && DEMO_IDS.test(item.id)); }

function noteToMarkdown(n: z.infer<typeof HtmlNote>) {
  const day = (s: string) => (Number.isNaN(Date.parse(s)) ? new Date().toISOString() : new Date(s).toISOString()).slice(0, 10);
  const type = n.type;
  const fm = [`title: ${yamlStr(n.title)}`, `type: ${type}`, `created: ${day(n.created)}`, `updated: ${day(n.updated)}`, 'aliases: []', `tags: [${n.tags.map(yamlStr).join(', ')}]`, ...(n.link ? [`url: ${yamlStr(n.link)}`] : []), `imported_from: "html-prototype ${n.id}"`];
  return `---\n${fm.join('\n')}\n---\n\n${/^#\s/m.test(n.content) ? '' : `# ${n.title}\n\n`}${n.description ? `> ${n.description}\n\n` : ''}${n.content}\n`;
}

export const transferRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  /** Portable export: Markdown vault (current revisions), outputs and original sources. No credentials, sessions or audit. */
  app.get('/workspaces/current/export', async (req, reply) => {
    const ws = requireWs(req, 'member');
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-')), 'export.zip');
    const zip = await ZipWriter.create(tmp);
    const docs = (await deps.db.query(`SELECT d.path, r.content FROM documents d JOIN document_revisions r ON r.id=d.current_revision_id WHERE d.workspace_id=$1 AND d.deleted_at IS NULL ORDER BY d.path`, [ws.id])).rows;
    for (const d of docs) await zip.add(`vault/${d.path}`, d.content);
    const outs = (await deps.db.query(`SELECT o.title, v.content FROM outputs o JOIN output_versions v ON v.output_id=o.id AND v.version=o.current_version WHERE o.workspace_id=$1 AND o.deleted_at IS NULL`, [ws.id])).rows;
    for (const o of outs) await zip.add(`vault/output/${slugName(o.title)}.md`, `# ${o.title}\n\n${o.content}`);
    const srcs = (await deps.db.query(`SELECT s.title, v.storage_path, v.original_name, v.sha256 FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.version=1 WHERE s.workspace_id=$1 AND s.deleted_at IS NULL AND s.sensitivity <> 'no_external'`, [ws.id])).rows;
    let rawCount = 0;
    for (const s of srcs) { try { await zip.add(`vault/raw/${s.sha256.slice(0, 8)}-${slugName(s.original_name ?? s.title)}`, await deps.sources.readBytes(s.storage_path)); rawCount++; } catch { /* missing blob */ } }
    await zip.add('EXPORT.md', `# Second Brain OS export\n\nworkspace: ${ws.name}\ncreated: ${new Date().toISOString()}\npages: ${docs.length}\noutputs: ${outs.length}\nraw sources: ${rawCount} (no_external sources excluded)\n\nThis is portable content only: no accounts, sessions, credentials, run history or audit log.\n`);
    await zip.close();
    await audit(deps.db, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'workspace.exported', result: 'success', meta: { pages: docs.length } });
    const buf = fs.readFileSync(tmp); fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    return sendFile(reply, `second-brain-${ws.slug}-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip', buf);
  });

  // ---- Import from the HTML prototype (manual JSON export from its "پشتیبان داده‌ها" button) ----
  const parseHtml = (body: unknown) => {
    const r = HtmlState.safeParse((body as { data?: unknown })?.data);
    if (!r.success) throw new HttpError(422, 'invalid_html_backup', 'این فایل پشتیبان نسخهٔ HTML معتبر نیست (schema 1).', false, r.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`));
    return r.data;
  };

  app.post('/import/html-prototype/preview', { bodyLimit: 40 * 1024 * 1024 }, async req => {
    requireWs(req, 'member');
    const s = parseHtml(req.body);
    const notes = s.notes.map(n => ({ id: n.id, title: n.title, type: n.type, demo: isDemo(n), status: n.status, target: n.type === 'note' ? 'notes/' : `wiki/${n.type === 'entity' ? 'entities' : n.type === 'synthesis' ? 'synthesis' : n.type + 's'}/` }));
    return {
      counts: { notes: s.notes.length, demoNotes: notes.filter(n => n.demo).length, projects: s.projects.length, demoProjects: s.projects.filter(isDemo).length, reviewsIgnored: s.reviews.length, activityIgnored: s.activity.length },
      notes, projects: s.projects.map(p => ({ id: p.id, title: p.title, tasks: p.tasks.length, demo: isDemo(p) })),
      mapping: { note: 'notes/ (افزونهٔ محصول)', source: 'wiki/sources/', concept: 'wiki/concepts/', entity: 'wiki/entities/', synthesis: 'wiki/synthesis/' },
      notice: 'پیشنهادهای نمونه، فعالیت‌ها و پروفایل وارد نمی‌شوند. دادهٔ نمونه فقط با انتخاب صریح وارد می‌شود. یادداشت‌ها به‌صورت بستهٔ پیشنهادی در مرکز بررسی قرار می‌گیرند.',
    };
  });

  app.post('/import/html-prototype/apply', { bodyLimit: 40 * 1024 * 1024 }, async req => {
    const ws = requireWs(req, 'member');
    const s = parseHtml(req.body);
    const includeDemo = (req.body as { includeDemo?: boolean }).includeDemo === true;
    if (includeDemo && !ws.isDemo) throw new HttpError(409, 'demo_into_real', 'دادهٔ نمونه فقط در فضای دانش نمایشی (demo) قابل ورود است.');
    const notes = s.notes.filter(n => includeDemo || !isDemo(n));
    const used = new Set<string>();
    const ops = notes.map(n => {
      const folder = n.type === 'note' ? 'notes' : `wiki/${n.type === 'entity' ? 'entities' : n.type === 'synthesis' ? 'synthesis' : n.type + 's'}`;
      let p = `${folder}/${slugName(n.title)}.md`; for (let i = 2; used.has(p); i++) p = `${folder}/${slugName(n.title)} ${i}.md`;
      used.add(p);
      return { op: 'create' as const, path: normalizeRelPath(p), content: noteToMarkdown(n), rationale: `HTML prototype note ${n.id}` };
    });
    const existing = new Set((await deps.db.query(`SELECT path FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL`, [ws.id])).rows.map(r => r.path));
    const skipped = ops.filter(o => existing.has(o.path)).map(o => o.path);
    const fresh = ops.filter(o => !existing.has(o.path));
    const changesetId = fresh.length ? await deps.engine.propose({ workspaceId: ws.id, runId: null, origin: 'vault_import', title: `ورود از نسخهٔ HTML (${fresh.length} یادداشت)`, summary: `نگاشت نوع note به notes/؛ ${skipped.length} مسیر تکراری کنار گذاشته شد.`, ops: fresh, sourceRefs: [], report: { sourceLabel: 'html prototype import', skipped } }) : null;
    const projects = s.projects.filter(p => includeDemo || !isDemo(p));
    await withTx(deps.db, async tx => {
      for (const p of projects) {
        const r = await tx.query(`INSERT INTO projects(workspace_id, title, description, color, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ws.id, p.title, p.description, p.color, req.session!.userId]);
        let i = 0; for (const t of p.tasks) await tx.query(`INSERT INTO tasks(workspace_id, project_id, text, done, position) VALUES ($1,$2,$3,$4,$5)`, [ws.id, r.rows[0].id, t.text, t.done, i++]);
      }
      await audit(tx, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'import.html_prototype', result: 'success', meta: { notes: fresh.length, projects: projects.length, includeDemo } });
    });
    return { changesetId, notesProposed: fresh.length, projectsCreated: projects.length, skipped, demoExcluded: !includeDemo };
  });

  /** Vault ZIP import: read-only scan; Markdown pages become a reviewable proposal. raw/, .claude/, hooks and scripts are never imported or executed. */
  app.post('/import/vault-zip', async req => {
    const ws = requireWs(req, 'member');
    const file = await req.file();
    if (!file) throw new HttpError(422, 'file_required', 'فایل ZIP ارسال نشد.');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, 'too_large', 'فایل بیش از حد مجاز است.');
    let zip: ZipReader;
    try { zip = ZipReader.fromBuffer(buf, { maxEntries: 20_000, maxTotalBytes: 500 * 1024 ** 2, maxEntryBytes: 5 * 1024 ** 2, maxRatio: 100 }); }
    catch (e) { if (e instanceof ZipError) throw new HttpError(422, `zip_${e.code}`, `آرشیو رد شد: ${e.message}`); throw e; }
    const prefix = (() => { const top = new Set(zip.entries.map(e => e.name.split('/')[0])); return top.size === 1 && !zip.entries.some(e => e.name.startsWith('wiki/')) ? [...top][0] + '/' : ''; })();
    const ops: { op: 'create' | 'update'; path: string; content: string; rationale: string }[] = [];
    const quarantined: string[] = []; const skipped: { path: string; reason: string }[] = [];
    for (const e of zip.entries) {
      if (e.isDir) continue;
      const rel = e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
      if (/^(\.claude|\.mcp\.json|\.obsidian|\.git)/.test(rel) || rel.split('/').some(s => s.startsWith('.'))) { quarantined.push(rel); continue; }
      if (!isManagedPath(rel)) { skipped.push({ path: rel, reason: rel.startsWith('raw/') ? 'raw/ files are not imported automatically' : 'not a managed Markdown path' }); continue; }
      let p: string; try { p = normalizeRelPath(rel); } catch { skipped.push({ path: rel, reason: 'invalid path' }); continue; }
      if (p === 'wiki/index.md' || p === 'wiki/log.md') { skipped.push({ path: p, reason: 'index/log are maintained by the app' }); continue; }
      const content = zip.read(e).toString('utf8');
      if (parseMarkdown(content).errors.length) { skipped.push({ path: p, reason: 'invalid frontmatter' }); continue; }
      const cur = await deps.vault.getDocumentByPath(deps.db, ws.id, p);
      if (cur && cur.sha256 === sha256Hex(content)) continue;
      ops.push({ op: cur ? 'update' : 'create', path: p, content, rationale: 'vault ZIP import' });
      if (ops.length >= 2000) break;
    }
    const changesetId = ops.length ? await deps.engine.propose({ workspaceId: ws.id, runId: null, origin: 'vault_import', title: `ورود vault از ZIP (${ops.length} فایل)`, summary: `${quarantined.length} فایل پیکربندی/مخفی قرنطینه و ${skipped.length} مورد نادیده گرفته شد.`, ops, sourceRefs: [], report: { sourceLabel: file.filename, quarantined, skipped } }) : null;
    await audit(deps.db, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'import.vault_zip', result: 'success', meta: { proposed: ops.length, quarantined: quarantined.length, skipped: skipped.length } });
    return { changesetId, proposed: ops.length, quarantined, skipped };
  });
};
