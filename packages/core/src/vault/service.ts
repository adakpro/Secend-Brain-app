import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db, Queryable, Tx } from '../database/pool';
import { withTx } from '../database/pool';
import { sha256Hex } from '../crypto/envelope';
import { atomicWrite, normalizeRelPath, resolveInside, PathError, removeStaleTemps } from './paths';
import { parseMarkdown, titleFrom, asStringArray } from '../markdown/frontmatter';
import { extractWikiLinks, buildResolver } from '../markdown/links';
import { chunkText } from '../markdown/chunks';
import { normalizeForSearch, compactForSearch } from '../text/normalize';
import { log } from '../log';

export type DocKind = 'source' | 'concept' | 'entity' | 'synthesis' | 'note' | 'index' | 'log' | 'project' | 'output' | 'claude_md' | 'other';

export function kindFromPath(p: string, fm?: Record<string, unknown>): DocKind {
  if (p === 'wiki/index.md') return 'index';
  if (p === 'wiki/log.md') return 'log';
  if (p === 'CLAUDE.md' || p.endsWith('/CLAUDE.md')) return p.startsWith('projects/') ? 'project' : 'claude_md';
  if (p.startsWith('wiki/sources/')) return 'source';
  if (p.startsWith('wiki/concepts/')) return 'concept';
  if (p.startsWith('wiki/entities/')) return 'entity';
  if (p.startsWith('wiki/synthesis/')) return 'synthesis';
  if (p.startsWith('notes/')) return 'note';
  if (p.startsWith('projects/')) return 'project';
  if (p.startsWith('output/')) return 'output';
  const t = fm?.type;
  if (typeof t === 'string' && ['source', 'concept', 'entity', 'synthesis', 'note'].includes(t)) return t as DocKind;
  return 'other';
}

/** Paths the product manages as documents. raw/ is the immutable source archive; dot-dirs are quarantined. */
export function isManagedPath(rel: string): boolean {
  if (!rel.endsWith('.md')) return false;
  const first = rel.split('/')[0];
  if (first.startsWith('.') || first === 'raw' || first === 'templates' || first === 'scripts') return false;
  return !rel.split('/').some(s => s.startsWith('.'));
}

export class ConflictError extends Error {
  constructor(public details: { path: string; expected?: string | null; actual?: string | null; reason: string }) { super(`conflict on ${details.path}: ${details.reason}`); }
}

export interface DocRow {
  id: string; workspace_id: string; path: string; kind: DocKind; title: string; aliases: string[]; tags: string[];
  current_revision_id: string; disk_sha256: string | null; sensitivity: string; updated_at: string; created_at: string; source_id: string | null;
}

export class VaultService {
  constructor(private db: Db, private vaultRoot: string, private templateDir?: string) {}

  workspaceDir(slug: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw new PathError('invalid workspace slug');
    return path.join(this.vaultRoot, slug);
  }

  async absPath(slug: string, rel: string, opts: { allowHidden?: boolean } = {}) {
    const norm = normalizeRelPath(rel, opts);
    const root = this.workspaceDir(slug);
    await fsp.mkdir(root, { recursive: true });
    return { rel: norm, abs: await resolveInside(root, norm) };
  }

  /** Creates the upstream vault layout for a new workspace. Never overwrites existing files. */
  async initWorkspace(workspaceId: string, slug: string): Promise<void> {
    const root = this.workspaceDir(slug);
    for (const d of ['raw/assets', 'wiki/sources', 'wiki/concepts', 'wiki/entities', 'wiki/synthesis', 'projects', 'output', 'notes']) {
      await fsp.mkdir(path.join(root, d), { recursive: true });
    }
    if (this.templateDir) {
      const today = new Date().toISOString().slice(0, 10);
      for (const f of ['CLAUDE.md', 'wiki/index.md', 'wiki/log.md', 'templates/source.md', 'templates/concept.md', 'templates/entity.md', 'templates/synthesis.md']) {
        const dest = path.join(root, f);
        try { await fsp.access(dest); continue; } catch { /* missing: copy */ }
        let txt = await fsp.readFile(path.join(this.templateDir, f), 'utf8');
        if (f === 'wiki/index.md') txt = txt.replace('updated: 1970-01-01', `updated: ${today}`);
        await atomicWrite(dest, txt);
      }
    }
    await this.reconcile(workspaceId, slug, { actorKind: 'system' });
  }

  async readDisk(slug: string, rel: string): Promise<string | null> {
    const { abs } = await this.absPath(slug, rel);
    try { return await fsp.readFile(abs, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }

  async getDocument(q: Queryable, workspaceId: string, id: string) {
    const { rows } = await q.query(
      `SELECT d.*, r.content, r.revision, r.sha256, r.author_kind, r.created_at AS revision_created_at
       FROM documents d JOIN document_revisions r ON r.id = d.current_revision_id
       WHERE d.workspace_id = $1 AND d.id = $2 AND d.deleted_at IS NULL`, [workspaceId, id]);
    return rows[0] as (DocRow & { content: string; revision: number; sha256: string; author_kind: string; revision_created_at: string }) | undefined;
  }

  async getDocumentByPath(q: Queryable, workspaceId: string, rel: string) {
    const { rows } = await q.query(
      `SELECT d.*, r.content, r.revision, r.sha256 FROM documents d JOIN document_revisions r ON r.id = d.current_revision_id
       WHERE d.workspace_id = $1 AND d.path = $2 AND d.deleted_at IS NULL`, [workspaceId, rel]);
    return rows[0] as (DocRow & { content: string; revision: number; sha256: string }) | undefined;
  }

  /**
   * Records a new revision in the DB (caller holds the transaction) and refreshes the
   * search index for that document. Does not touch the filesystem.
   */
  async recordRevision(tx: Tx, args: { workspaceId: string; path: string; content: string; authorKind: string; authorUserId?: string | null; changesetId?: string | null; documentId?: string; sensitivity?: string; sourceId?: string | null }): Promise<{ documentId: string; revisionId: string; revision: number }> {
    const parsed = parseMarkdown(args.content);
    const kind = kindFromPath(args.path, parsed.data);
    const title = titleFrom(parsed, args.path).slice(0, 300);
    const aliases = asStringArray(parsed.data.aliases).slice(0, 50);
    const tags = asStringArray(parsed.data.tags).map(t => t.replace(/^#/, '')).slice(0, 50);
    const sha = sha256Hex(args.content);
    let docId = args.documentId;
    if (!docId) {
      const existing = await tx.query('SELECT id FROM documents WHERE workspace_id=$1 AND path=$2 AND deleted_at IS NULL', [args.workspaceId, args.path]);
      docId = existing.rows[0]?.id;
    }
    if (!docId) {
      const ins = await tx.query(
        `INSERT INTO documents(workspace_id, path, kind, title, aliases, tags, disk_sha256, sensitivity, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [args.workspaceId, args.path, kind, title, aliases, tags, sha, args.sensitivity ?? 'private_model', args.sourceId ?? null]);
      docId = ins.rows[0].id as string;
    }
    const revQ = await tx.query('SELECT coalesce(max(revision),0)+1 AS n FROM document_revisions WHERE document_id=$1', [docId]);
    const revision = revQ.rows[0].n as number;
    const rev = await tx.query(
      `INSERT INTO document_revisions(workspace_id, document_id, revision, content, sha256, author_kind, author_user_id, changeset_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [args.workspaceId, docId, revision, args.content, sha, args.authorKind, args.authorUserId ?? null, args.changesetId ?? null]);
    const revisionId = rev.rows[0].id as string;
    await tx.query(
      `UPDATE documents SET path=$3, kind=$4, title=$5, aliases=$6, tags=$7, current_revision_id=$8, disk_sha256=$9, updated_at=now(), deleted_at=NULL WHERE workspace_id=$1 AND id=$2`,
      [args.workspaceId, docId, args.path, kind, title, aliases, tags, revisionId, sha]);
    await this.indexDocument(tx, args.workspaceId, docId, revisionId, args.content, parsed.bodyOffset, title);
    await tx.query('DELETE FROM links WHERE workspace_id=$1 AND from_document_id=$2 AND link_kind <> $3', [args.workspaceId, docId, 'accepted_relation']);
    const targets = [...new Set(extractWikiLinks(parsed.body).map(l => l.target))];
    if (targets.length) await tx.query(`INSERT INTO links(workspace_id, from_document_id, target_raw, status, link_kind) SELECT $1, $2, t, 'missing', CASE WHEN t LIKE '%/%' THEN 'path' ELSE 'wikilink' END FROM unnest($3::text[]) AS t`,
      [args.workspaceId, docId, targets]);
    return { documentId: docId, revisionId, revision };
  }

  async indexDocument(tx: Queryable, workspaceId: string, documentId: string, revisionId: string, content: string, bodyOffset: number, title: string) {
    await tx.query('DELETE FROM search_chunks WHERE workspace_id=$1 AND document_id=$2', [workspaceId, documentId]);
    const body = content.slice(bodyOffset);
    const chunks = chunkText(body, { offset: bodyOffset });
    if (!chunks.length) chunks.push({ index: 0, heading: null, start: bodyOffset, end: content.length, page: null, text: body });
    const searchable = chunks.map(c => `${c.index === 0 ? title + ' ' : ''}${c.heading ?? ''} ${c.text}`);
    // One statement per document instead of one per chunk.
    await tx.query(
      `INSERT INTO search_chunks(workspace_id, document_id, revision_id, chunk_index, heading, start_offset, end_offset, page, body, norm, norm_compact)
       SELECT $1, $2, $3, * FROM unnest($4::int[], $5::text[], $6::int[], $7::int[], $8::int[], $9::text[], $10::text[], $11::text[])`,
      [workspaceId, documentId, revisionId, chunks.map(c => c.index), chunks.map(c => c.heading), chunks.map(c => c.start), chunks.map(c => c.end), chunks.map(c => c.page),
        chunks.map(c => c.text), searchable.map(normalizeForSearch), searchable.map(compactForSearch)]);
  }

  /** Re-resolves every stored link target in the workspace against live documents. */
  async resolveLinks(tx: Queryable, workspaceId: string) {
    const docs = await tx.query('SELECT id, path, title, aliases FROM documents WHERE workspace_id=$1 AND deleted_at IS NULL', [workspaceId]);
    const resolve = buildResolver(docs.rows.map(r => ({ id: r.id, path: r.path, title: r.title, aliases: r.aliases })));
    const links = await tx.query(`SELECT id, target_raw, status, to_document_id FROM links WHERE workspace_id=$1 AND link_kind <> 'accepted_relation'`, [workspaceId]);
    const ids: number[] = []; const statuses: string[] = []; const tos: (string | null)[] = [];
    const cache = new Map<string, ReturnType<typeof resolve>>();
    for (const l of links.rows) {
      let r = cache.get(l.target_raw); if (!r) { r = resolve(l.target_raw); cache.set(l.target_raw, r); }
      const to = r.status === 'resolved' ? r.id : null;
      if (l.status !== r.status || l.to_document_id !== to) { ids.push(l.id); statuses.push(r.status); tos.push(to); }
    }
    // Only changed rows, in a single statement.
    if (ids.length) await tx.query(`UPDATE links l SET status=u.status, to_document_id=u.to_id FROM unnest($1::bigint[], $2::text[], $3::uuid[]) AS u(id, status, to_id) WHERE l.id=u.id`, [ids, statuses, tos]);
  }

  /**
   * Manual save with optimistic concurrency. baseRevisionId must equal the current DB
   * revision and the disk file must still match it, otherwise ConflictError.
   */
  async saveDocument(args: { workspaceId: string; slug: string; documentId?: string; path?: string; content: string; baseRevisionId?: string | null; userId: string }) {
    return withTx(this.db, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ws:' + args.workspaceId]);
      let rel: string;
      let docId = args.documentId;
      if (docId) {
        const cur = await this.getDocument(tx, args.workspaceId, docId);
        if (!cur) throw new PathError('document not found', 'not_found');
        if (cur.current_revision_id !== args.baseRevisionId) throw new ConflictError({ path: cur.path, expected: args.baseRevisionId, actual: cur.current_revision_id, reason: 'document changed since it was opened' });
        rel = cur.path;
        const disk = await this.readDisk(args.slug, rel);
        if (disk !== null && sha256Hex(disk) !== cur.sha256) throw new ConflictError({ path: rel, expected: cur.sha256, actual: sha256Hex(disk), reason: 'file changed on disk outside the app' });
      } else {
        rel = normalizeRelPath(args.path ?? '');
        if (!isManagedPath(rel) || !(rel.startsWith('notes/') || rel.startsWith('projects/') || rel.startsWith('output/'))) throw new PathError('manual documents may only be created under notes/, projects/ or output/');
        const exists = await this.getDocumentByPath(tx, args.workspaceId, rel);
        if (exists || (await this.readDisk(args.slug, rel)) !== null) throw new ConflictError({ path: rel, reason: 'a file already exists at this path' });
      }
      const { abs } = await this.absPath(args.slug, rel);
      const out = await this.recordRevision(tx, { workspaceId: args.workspaceId, path: rel, content: args.content, authorKind: 'user', authorUserId: args.userId, documentId: docId });
      await this.resolveLinks(tx, args.workspaceId);
      // File write happens last inside the transaction window; if it fails the DB rolls back.
      await atomicWrite(abs, args.content);
      return { ...out, path: rel };
    });
  }

  /**
   * Compares disk with the DB: imports new files, records external edits as new revisions,
   * detects unambiguous renames (identical hash, one-to-one) and marks vanished files.
   */
  async reconcile(workspaceId: string, slug: string, { actorKind = 'external' }: { actorKind?: string } = {}) {
    const root = this.workspaceDir(slug);
    await fsp.mkdir(root, { recursive: true });
    await removeStaleTemps(root);
    const disk = new Map<string, string>();
    const quarantined: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (e.isSymbolicLink()) { quarantined.push(rel); continue; }
        if (e.isDirectory()) {
          if (e.name === '.claude' || e.name === '.mcp.json' || e.name === '.git' || e.name === '.obsidian') { if (e.name === '.claude') quarantined.push(rel + '/'); continue; }
          await walk(abs);
        } else if (e.isFile() && isManagedPath(rel)) {
          const st = await fsp.stat(abs);
          if (st.size > 5 * 1024 * 1024) { quarantined.push(rel); continue; }
          disk.set(rel, await fsp.readFile(abs, 'utf8'));
        } else if (e.isFile() && (e.name === '.mcp.json' || rel.startsWith('.claude/'))) quarantined.push(rel);
      }
    };
    await walk(root);
    const report = { imported: 0, updated: 0, renamed: 0, missing: 0, ambiguousRenames: 0, quarantined };
    await withTx(this.db, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['ws:' + workspaceId]);
      const { rows } = await tx.query(
        `SELECT d.id, d.path, r.sha256 FROM documents d JOIN document_revisions r ON r.id=d.current_revision_id WHERE d.workspace_id=$1 AND d.deleted_at IS NULL`, [workspaceId]);
      const dbByPath = new Map(rows.map(r => [r.path as string, r as { id: string; path: string; sha256: string }]));
      const vanished = rows.filter(r => !disk.has(r.path));
      const fresh = [...disk.keys()].filter(p => !dbByPath.has(p));
      // Rename detection: exact content match and unique on both sides.
      const freshByHash = new Map<string, string[]>();
      for (const p of fresh) { const h = sha256Hex(disk.get(p)!); freshByHash.set(h, [...(freshByHash.get(h) ?? []), p]); }
      const vanishedByHash = new Map<string, typeof vanished>();
      for (const v of vanished) vanishedByHash.set(v.sha256, [...(vanishedByHash.get(v.sha256) ?? []), v]);
      const renamedFresh = new Set<string>(); const renamedOld = new Set<string>();
      for (const [h, olds] of vanishedByHash) {
        const news = freshByHash.get(h) ?? [];
        if (olds.length === 1 && news.length === 1) {
          await tx.query('UPDATE documents SET path=$3, kind=$4, updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspaceId, olds[0].id, news[0], kindFromPath(news[0], parseMarkdown(disk.get(news[0])!).data)]);
          renamedFresh.add(news[0]); renamedOld.add(olds[0].id); report.renamed++;
          await audit(tx, { workspaceId, action: 'vault.external_rename', targetType: 'document', targetId: olds[0].id, result: 'success', meta: { from: olds[0].path, to: news[0] } });
        } else if (news.length) report.ambiguousRenames++;
      }
      for (const v of vanished) {
        if (renamedOld.has(v.id)) continue;
        await tx.query('UPDATE documents SET deleted_at=now() WHERE id=$1', [v.id]);
        report.missing++;
        await audit(tx, { workspaceId, action: 'vault.file_missing', targetType: 'document', targetId: v.id, result: 'success', meta: { path: v.path } });
      }
      for (const p of fresh) {
        if (renamedFresh.has(p)) continue;
        await this.recordRevision(tx, { workspaceId, path: p, content: disk.get(p)!, authorKind: actorKind === 'system' ? 'system' : 'import' });
        report.imported++;
      }
      for (const [p, content] of disk) {
        const d = dbByPath.get(p);
        if (d && d.sha256 !== sha256Hex(content)) {
          await this.recordRevision(tx, { workspaceId, path: p, content, authorKind: 'external', documentId: d.id });
          report.updated++;
        }
      }
      if (report.imported || report.updated || report.renamed || report.missing) await this.resolveLinks(tx, workspaceId);
    });
    if (report.updated || report.imported || report.renamed || report.missing) log.info('vault.reconciled', { workspaceId, ...report, quarantined: quarantined.length });
    return report;
  }
}

export async function audit(q: Queryable, e: { workspaceId?: string | null; actorUserId?: string | null; action: string; targetType?: string; targetId?: string; result: 'success' | 'failure' | 'denied'; ip?: string; requestId?: string; meta?: Record<string, unknown> }) {
  await q.query(
    `INSERT INTO audit_events(workspace_id, actor_user_id, action, target_type, target_id, result, ip, request_id, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.workspaceId ?? null, e.actorUserId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.result, e.ip ?? null, e.requestId ?? null, e.meta ?? {}]);
}
