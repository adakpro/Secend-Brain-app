import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { BackupService } from '@sb/core';
import { type Deps, requireAdmin, requireStepUp, HttpError, sendFile } from '../context';

export function backupService(deps: Deps) {
  return new BackupService(deps.db, { vault: deps.cfg.vaultRoot, sources: deps.cfg.sourcesRoot, backups: deps.cfg.backupRoot }, deps.cfg.appVersion, process.env.UPSTREAM_COMMIT ?? null);
}

/** Admin backups: create/list/download/verify. Restore is CLI-only (services stopped, explicit file confirmation). */
export const backupRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  const svc = backupService(deps);
  const safeName = (f: string) => { if (!/^sb-backup-[0-9TZ-]+\.zip(\.enc)?$/.test(f)) throw new HttpError(400, 'invalid_name', 'نام فایل نامعتبر است.'); return path.join(deps.cfg.backupRoot, f); };

  app.get('/admin/backups', async req => {
    await requireAdmin(req, deps);
    return { items: await svc.list(), restoreCommand: './scripts/restore.sh <file>', dir: 'backups/' };
  });

  app.post('/admin/backups', async req => {
    const { session } = await requireAdmin(req, deps); requireStepUp(req);
    const { passphrase } = (req.body ?? {}) as { passphrase?: string };
    if (passphrase !== undefined && (typeof passphrase !== 'string' || passphrase.length < 12)) throw new HttpError(422, 'weak_passphrase', 'گذرواژهٔ رمزنگاری پشتیبان باید دست‌کم ۱۲ نویسه باشد.');
    const r = await svc.create({ actorId: session.userId, passphrase: passphrase || undefined });
    return { file: path.basename(r.file), tables: Object.keys(r.manifest.tables).length, files: r.manifest.files.length, activeRuns: r.manifest.activeRuns, notes: r.manifest.notes };
  });

  app.post('/admin/backups/:file/verify', async req => {
    await requireAdmin(req, deps);
    const f = safeName((req.params as { file: string }).file);
    if (!fs.existsSync(f)) throw new HttpError(404, 'not_found', 'فایل پیدا نشد.');
    const { passphrase } = (req.body ?? {}) as { passphrase?: string };
    try { const v = await svc.verify(f, passphrase); return { ok: v.ok, problems: v.problems, manifest: v.manifest }; }
    catch (e) { return { ok: false, problems: [(e as Error).message.slice(0, 300)] }; }
  });

  app.get('/admin/backups/:file/download', async (req, reply) => {
    await requireAdmin(req, deps); requireStepUp(req);
    const f = safeName((req.params as { file: string }).file);
    if (!fs.existsSync(f)) throw new HttpError(404, 'not_found', 'فایل پیدا نشد.');
    return sendFile(reply, path.basename(f), 'application/octet-stream', fs.readFileSync(f));
  });
};
