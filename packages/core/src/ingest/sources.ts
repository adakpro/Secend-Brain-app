import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db, Queryable } from '../database/pool';
import { withTx } from '../database/pool';
import { sha256Hex } from '../crypto/envelope';
import { atomicWrite } from '../vault/paths';
import { audit } from '../vault/service';
import { chunkText } from '../markdown/chunks';
import { indexSourceVersion } from '../search/search';
import { canonicalizeUrl, safeFetch, FetchPolicyError } from '../net/safe-fetch';
import { detectType, extractPlain, extractHtml, extractPdf, decodeUtf8, EXTRACTOR_VERSION, type Extraction } from './extract';
import { parseChatExport, conversationToMarkdown } from './chat-import';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const WORKSPACE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export class SourceError extends Error { constructor(public code: string, msg: string, public status = 400) { super(msg); } }

export interface CreateSourceArgs {
  workspaceId: string; userId: string; title: string; kind: 'text' | 'markdown' | 'transcript' | 'file' | 'url' | 'pdf' | 'chat';
  sensitivity: string; tags: string[]; projectId?: string | null; idempotencyKey?: string;
}

export class SourceService {
  constructor(private db: Db, private sourcesRoot: string) {}

  private storagePath(workspaceId: string, sha: string, ext: string) {
    return path.join(workspaceId, sha.slice(0, 2), `${sha}${ext}`);
  }

  async storeBytes(workspaceId: string, buf: Buffer, ext: string): Promise<{ sha: string; rel: string }> {
    const sha = sha256Hex(buf);
    const rel = this.storagePath(workspaceId, sha, ext);
    const abs = path.join(this.sourcesRoot, rel);
    try { await fsp.access(abs); } catch { await atomicWrite(abs, buf, 0o440); }
    return { sha, rel };
  }

  async readBytes(rel: string): Promise<Buffer> {
    const abs = path.resolve(this.sourcesRoot, rel);
    if (!abs.startsWith(path.resolve(this.sourcesRoot) + path.sep)) throw new SourceError('invalid_path', 'invalid storage path');
    return fsp.readFile(abs);
  }

  private async checkQuota(q: Queryable, workspaceId: string, add: number) {
    const r = await q.query(`SELECT coalesce(sum(byte_size),0)::bigint AS n FROM source_versions WHERE workspace_id=$1`, [workspaceId]);
    if (Number(r.rows[0].n) + add > WORKSPACE_QUOTA_BYTES) throw new SourceError('quota_exceeded', 'سهمیهٔ ذخیره‌سازی این فضای دانش پر شده است.', 413);
  }

  /** Exact duplicates: same content hash or same canonical URL in this workspace. */
  async findDuplicate(q: Queryable, workspaceId: string, sha: string | null, canonicalUrl: string | null) {
    const r = await q.query(
      `SELECT s.id, s.title FROM sources s LEFT JOIN source_versions v ON v.source_id=s.id
       WHERE s.workspace_id=$1 AND s.deleted_at IS NULL AND (($2::text IS NOT NULL AND v.sha256=$2) OR ($3::text IS NOT NULL AND s.canonical_url=$3)) LIMIT 1`,
      [workspaceId, sha, canonicalUrl]);
    return r.rows[0] as { id: string; title: string } | undefined;
  }

  /** Creates a source from bytes already validated by the caller (text body or upload). */
  async createFromBytes(args: CreateSourceArgs & { buf: Buffer; originalName?: string; mime: string; ext: string; extraction?: Extraction }) {
    if (args.buf.length > MAX_UPLOAD_BYTES) throw new SourceError('too_large', 'حجم فایل بیش از حد مجاز است.', 413);
    return withTx(this.db, async tx => {
      if (args.idempotencyKey) {
        const ex = await tx.query('SELECT id FROM sources WHERE workspace_id=$1 AND idempotency_key=$2', [args.workspaceId, args.idempotencyKey]);
        if (ex.rows[0]) return { id: ex.rows[0].id as string, existing: true, duplicateOf: null };
      }
      await this.checkQuota(tx, args.workspaceId, args.buf.length);
      const { sha, rel } = await this.storeBytes(args.workspaceId, args.buf, args.ext);
      const dup = await this.findDuplicate(tx, args.workspaceId, sha, null);
      const s = await tx.query(
        `INSERT INTO sources(workspace_id, kind, title, status, sensitivity, project_id, tags, idempotency_key, duplicate_of, created_by)
         VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9) RETURNING id`,
        [args.workspaceId, args.kind, args.title.slice(0, 200), args.sensitivity, args.projectId ?? null, args.tags, args.idempotencyKey ?? null, dup?.id ?? null, args.userId]);
      const sourceId = s.rows[0].id as string;
      const v = await tx.query(
        `INSERT INTO source_versions(workspace_id, source_id, version, sha256, mime, byte_size, original_name, storage_path) VALUES ($1,$2,1,$3,$4,$5,$6,$7) RETURNING id`,
        [args.workspaceId, sourceId, sha, args.mime, args.buf.length, args.originalName?.slice(0, 200) ?? null, rel]);
      await tx.query('UPDATE sources SET current_version_id=$2 WHERE id=$1', [sourceId, v.rows[0].id]);
      await audit(tx, { workspaceId: args.workspaceId, actorUserId: args.userId, action: 'source.created', targetType: 'source', targetId: sourceId, result: 'success', meta: { kind: args.kind, bytes: args.buf.length, duplicateOf: dup?.id ?? null } });
      return { id: sourceId, existing: false, duplicateOf: dup ?? null };
    });
  }

  async createUrl(args: CreateSourceArgs & { url: string }) {
    let canonical: string;
    try { canonical = canonicalizeUrl(args.url); } catch { throw new SourceError('invalid_url', 'نشانی معتبر نیست.'); }
    if (!/^https?:/.test(canonical)) throw new SourceError('invalid_url', 'فقط http و https.');
    return withTx(this.db, async tx => {
      if (args.idempotencyKey) {
        const ex = await tx.query('SELECT id FROM sources WHERE workspace_id=$1 AND idempotency_key=$2', [args.workspaceId, args.idempotencyKey]);
        if (ex.rows[0]) return { id: ex.rows[0].id as string, existing: true, duplicateOf: null };
      }
      const dup = await this.findDuplicate(tx, args.workspaceId, null, canonical);
      const s = await tx.query(
        `INSERT INTO sources(workspace_id, kind, title, status, sensitivity, project_id, tags, idempotency_key, origin_url, canonical_url, duplicate_of, created_by)
         VALUES ($1,'url',$2,'queued',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [args.workspaceId, (args.title || canonical).slice(0, 200), args.sensitivity, args.projectId ?? null, args.tags, args.idempotencyKey ?? null, args.url, canonical, dup?.id ?? null, args.userId]);
      await audit(tx, { workspaceId: args.workspaceId, actorUserId: args.userId, action: 'source.created', targetType: 'source', targetId: s.rows[0].id, result: 'success', meta: { kind: 'url', duplicateOf: dup?.id ?? null } });
      return { id: s.rows[0].id as string, existing: false, duplicateOf: dup ?? null };
    });
  }

  private async setStatus(q: Queryable, id: string, status: string, detail: string | null = null) {
    await q.query('UPDATE sources SET status=$2, status_detail=$3, updated_at=now() WHERE id=$1', [id, status, detail]);
  }

  /**
   * Worker step: fetch (URL) or read stored bytes, extract text, record quality and coverage,
   * index the extracted text. Never marks a partial or failed extraction as complete.
   */
  async extract(sourceId: string): Promise<{ status: string }> {
    const s = (await this.db.query('SELECT * FROM sources WHERE id=$1', [sourceId])).rows[0];
    if (!s || s.deleted_at || s.status === 'canceled') return { status: 'skipped' };
    await this.setStatus(this.db, sourceId, 'extracting');
    let ex: Extraction; let versionId: string = s.current_version_id;
    try {
      if (s.kind === 'url') {
        let res;
        try { res = await safeFetch(s.origin_url); } catch (e) {
          const code = e instanceof FetchPolicyError ? e.code : 'fetch_failed';
          await this.setStatus(this.db, sourceId, 'extraction_failed', `${code}: ${(e as Error).message}`.slice(0, 300));
          return { status: 'extraction_failed' };
        }
        const isPdf = res.contentType.includes('application/pdf') || res.body.subarray(0, 5).toString('latin1') === '%PDF-';
        const { sha, rel } = await this.storeBytes(s.workspace_id, res.body, isPdf ? '.pdf' : '.html');
        if (isPdf) ex = await extractPdf(res.body);
        else {
          const html = decodeUtf8(res.body) ?? res.body.toString('latin1');
          ex = extractHtml(html, res.finalUrl, res.status);
        }
        ex.meta = { ...ex.meta, finalUrl: res.finalUrl, redirects: res.redirects, contentType: res.contentType, fetchedAt: new Date().toISOString(), responseSha256: sha };
        const ins = await this.db.query(
          `INSERT INTO source_versions(workspace_id, source_id, version, sha256, mime, byte_size, storage_path)
           VALUES ($1,$2,(SELECT coalesce(max(version),0)+1 FROM source_versions WHERE source_id=$2),$3,$4,$5,$6) RETURNING id`,
          [s.workspace_id, sourceId, sha, isPdf ? 'application/pdf' : 'text/html', res.body.length, rel]);
        versionId = ins.rows[0].id;
        await this.db.query('UPDATE sources SET current_version_id=$2, kind=$3 WHERE id=$1', [sourceId, versionId, isPdf ? 'pdf' : 'url']);
        if (ex.title && s.title === s.canonical_url) await this.db.query('UPDATE sources SET title=$2 WHERE id=$1', [sourceId, ex.title.slice(0, 200)]);
      } else {
        const v = (await this.db.query('SELECT * FROM source_versions WHERE id=$1', [versionId])).rows[0];
        if (v.extracted_text !== null && v.quality === 'ok') ex = { quality: 'ok', extractor: v.extractor, text: v.extracted_text, meta: v.extracted_meta, coverage: v.coverage };
        else {
          const buf = await this.readBytes(v.storage_path);
          const det = detectType(buf, v.original_name ?? '');
          if (det.type === 'pdf') ex = await extractPdf(buf);
          else if (det.type === 'json' && s.kind === 'chat') {
            ex = this.extractChat(buf);
          } else if (det.type === 'markdown' || det.type === 'text') ex = extractPlain(buf, det.type === 'markdown' ? 'markdown' : 'text');
          else ex = { quality: 'failed', extractor: 'none', text: '', meta: { detected: det.type }, coverage: { totalUnits: 0, readUnits: 0, unit: 'chars' }, failureCode: 'unsupported_type', failureMessage: 'نوع فایل پشتیبانی نمی‌شود.' };
        }
      }
    } catch (e) {
      ex = { quality: 'failed', extractor: 'error', text: '', meta: {}, coverage: { totalUnits: 0, readUnits: 0, unit: 'chars' }, failureCode: 'extract_error', failureMessage: (e as Error).message.slice(0, 200) };
    }
    await this.db.query(
      `UPDATE source_versions SET extractor=$2, extractor_version=$3, quality=$4, extracted_text=$5, extracted_meta=$6, coverage=$7 WHERE id=$1`,
      [versionId, ex.extractor, EXTRACTOR_VERSION, ex.quality, ex.text || null, ex.meta, ex.coverage]);
    if (ex.quality === 'needs_ocr') { await this.setStatus(this.db, sourceId, 'needs_ocr', ex.failureMessage ?? null); return { status: 'needs_ocr' }; }
    if (ex.quality === 'failed') { await this.setStatus(this.db, sourceId, 'extraction_failed', `${ex.failureCode}: ${ex.failureMessage}`.slice(0, 300)); return { status: 'extraction_failed' }; }
    await indexSourceVersion(this.db, s.workspace_id, versionId, ex.text, chunkText(ex.text));
    await this.setStatus(this.db, sourceId, 'ready_for_analysis', ex.quality === 'partial' ? `partial: ${(ex.coverage.notes ?? []).join('; ')}` : null);
    return { status: 'ready_for_analysis' };
  }

  private extractChat(buf: Buffer): Extraction {
    const txt = decodeUtf8(buf);
    let json: unknown;
    try { json = JSON.parse(txt ?? ''); } catch { return { quality: 'failed', extractor: 'chat-import', text: '', meta: {}, coverage: { totalUnits: 0, readUnits: 0, unit: 'messages' }, failureCode: 'invalid_json', failureMessage: 'JSON نامعتبر است.' }; }
    const r = parseChatExport(json);
    if (r.format === 'unsupported') return { quality: 'failed', extractor: 'chat-import', text: '', meta: { skipped: r.skipped }, coverage: { totalUnits: 0, readUnits: 0, unit: 'messages' }, failureCode: 'unsupported_chat_format', failureMessage: 'قالب این خروجی گفتگو پشتیبانی نمی‌شود (قالب‌های پشتیبانی‌شده: chat_messages، mapping، messages).' };
    const text = r.conversations.map(conversationToMarkdown).join('\n\n---\n\n');
    const total = r.conversations.reduce((a, c) => a + c.messages.length, 0);
    return { quality: r.skipped.length ? 'partial' : 'ok', extractor: `chat-import:${r.format}`, text, meta: { conversations: r.conversations.length, droppedBranches: r.conversations.reduce((a, c) => a + c.droppedBranches, 0), skipped: r.skipped }, coverage: { totalUnits: total, readUnits: total, unit: 'messages', notes: r.skipped.length ? [`${r.skipped.length} conversations skipped`] : [] } };
  }

  /** Replacement text (e.g. for needs_ocr) creates a NEW derived version; the original stays untouched. */
  async addReplacementText(workspaceId: string, sourceId: string, userId: string, text: string) {
    const s = (await this.db.query('SELECT * FROM sources WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [workspaceId, sourceId])).rows[0];
    if (!s) throw new SourceError('not_found', 'منبع پیدا نشد.', 404);
    const buf = Buffer.from(text, 'utf8');
    const { sha, rel } = await this.storeBytes(workspaceId, buf, '.txt');
    const v = await this.db.query(
      `INSERT INTO source_versions(workspace_id, source_id, version, sha256, mime, byte_size, storage_path, derived_from, extractor, extractor_version, quality, extracted_text, coverage, extracted_meta)
       VALUES ($1,$2,(SELECT coalesce(max(version),0)+1 FROM source_versions WHERE source_id=$2),$3,'text/plain',$4,$5,$6,'manual',$7,'ok',$8,$9,$10) RETURNING id`,
      [workspaceId, sourceId, sha, buf.length, rel, s.current_version_id, EXTRACTOR_VERSION, text, { totalUnits: text.length, readUnits: text.length, unit: 'chars' }, { replacementBy: userId }]);
    await this.db.query('UPDATE sources SET current_version_id=$2, status=$3, status_detail=$4, updated_at=now() WHERE id=$1', [sourceId, v.rows[0].id, 'ready_for_analysis', 'متن جایگزین دستی']);
    await indexSourceVersion(this.db, workspaceId, v.rows[0].id, text, chunkText(text));
    await audit(this.db, { workspaceId, actorUserId: userId, action: 'source.replacement_text', targetType: 'source', targetId: sourceId, result: 'success' });
    return v.rows[0].id as string;
  }

  /** Owner-initiated privacy deletion: removes raw bytes no other version references, keeps an audit trail without content. */
  async purge(workspaceId: string, sourceId: string, userId: string) {
    const vs = (await this.db.query('SELECT storage_path, sha256 FROM source_versions WHERE workspace_id=$1 AND source_id=$2', [workspaceId, sourceId])).rows;
    await withTx(this.db, async tx => {
      await tx.query('DELETE FROM search_chunks WHERE workspace_id=$1 AND source_version_id IN (SELECT id FROM source_versions WHERE source_id=$2)', [workspaceId, sourceId]);
      await tx.query(`UPDATE source_versions SET extracted_text=NULL, extracted_meta='{}'::jsonb WHERE source_id=$1`, [sourceId]);
      await tx.query(`UPDATE sources SET deleted_at=now(), title='[deleted]', origin_url=NULL, canonical_url=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, sourceId]);
      await audit(tx, { workspaceId, actorUserId: userId, action: 'source.purged', targetType: 'source', targetId: sourceId, result: 'success', meta: { versions: vs.length } });
    });
    for (const v of vs) {
      const still = await this.db.query('SELECT 1 FROM source_versions sv JOIN sources s ON s.id=sv.source_id WHERE sv.sha256=$1 AND s.deleted_at IS NULL LIMIT 1', [v.sha256]);
      if (!still.rowCount) await fsp.rm(path.join(this.sourcesRoot, v.storage_path), { force: true });
    }
  }
}
