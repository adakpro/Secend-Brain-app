import { it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { freshDb, tmpDir, seedOwner, TEMPLATE_DIR } from '../integration/helpers';
import { VaultService } from '../../src/vault/service';
import { withTx } from '../../src/database/pool';
import { search } from '../../src/search/search';

const FA = ['مدیریت دانش شخصی', 'یادگیری فعال', 'مرور با فاصله', 'نقشهٔ ذهنی', 'ویکی مبتنی بر مدل زبانی', 'تصمیم‌گیری مستند', 'پژوهش کاربر', 'نیم‌فاصله و املای فارسی'];
const EN = ['knowledge graph', 'spaced repetition', 'retrieval practice', 'zettelkasten', 'linked notes', 'decision record'];
const pick = <T,>(a: T[], i: number) => a[i % a.length];

it('H06 benchmark: 1000 pages (fa/en) — indexing, reconcile and search latency', async () => {
  const { db, drop } = await freshDb();
  const root = tmpDir('bench-');
  const vault = new VaultService(db, root, TEMPLATE_DIR);
  const ws = await seedOwner(db);
  await vault.initWorkspace(ws.workspaceId, ws.slug);
  const N = 1000;
  const t0 = Date.now();
  await withTx(db, async tx => {
    for (let i = 0; i < N; i++) {
      const t = `${pick(FA, i)} ${i}`; const e = pick(EN, i * 7);
      const body = `---\ntitle: ${JSON.stringify(t)}\ntype: concept\ntags: [bench]\n---\n# ${t}\n\n${'این صفحه دربارهٔ ' + pick(FA, i + 3) + ' و ' + e + ' است. '.repeat(1)}\n\n${('متن نمونه برای سنجش جست‌وجو با کلمات ' + pick(FA, i + 1) + ' و ' + pick(EN, i) + '. ').repeat(20)}\n\nلینک به [[${pick(FA, i + 2)} ${(i + 1) % N}]].`;
      await vault.recordRevision(tx, { workspaceId: ws.workspaceId, path: `wiki/concepts/p${i}.md`, content: body, authorKind: 'import' });
    }
    await vault.resolveLinks(tx, ws.workspaceId);
  });
  const indexMs = Date.now() - t0;
  // Write the same pages to disk and time a full hash reconciliation (no changes expected for DB-known content).
  for (const r of (await db.query(`SELECT d.path, r.content FROM documents d JOIN document_revisions r ON r.id=d.current_revision_id WHERE d.workspace_id=$1`, [ws.workspaceId])).rows) {
    const abs = path.join(root, ws.slug, r.path); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, r.content);
  }
  const t1 = Date.now(); const rep = await vault.reconcile(ws.workspaceId, ws.slug); const reconcileMs = Date.now() - t1;
  const queries = ['مدیریت دانش', 'يادگيري فعال', 'مرور با فاصله', 'نیمفاصله', 'knowledge graph', 'zettelkasten', 'تصمیم گیری', 'retrieval'];
  const lat: number[] = []; let hitsTotal = 0;
  for (let rep2 = 0; rep2 < 5; rep2++) for (const q of queries) { const s = Date.now(); const h = await search(db, { workspaceId: ws.workspaceId }, q, 20); lat.push(Date.now() - s); hitsTotal += h.length; }
  lat.sort((a, b) => a - b);
  const p = (x: number) => lat[Math.min(lat.length - 1, Math.floor(x * lat.length))];
  const chunks = (await db.query(`SELECT count(*)::int n FROM search_chunks`)).rows[0].n;
  const dbSize = (await db.query(`SELECT pg_size_pretty(pg_database_size(current_database())) s`)).rows[0].s;
  const result = { pages: N, chunks, indexMs, reconcileMs, reconcile: { imported: rep.imported, updated: rep.updated }, searchMs: { p50: p(0.5), p95: p(0.95), max: lat[lat.length - 1] }, queries: queries.length * 5, avgHits: hitsTotal / lat.length, dbSize,
    machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGiB: Math.round(os.totalmem() / 1024 ** 3), node: process.version, platform: `${os.platform()} ${os.release()}` }, postgres: '17.6 (docker, tmpfs data dir)' };
  fs.mkdirSync(path.resolve(__dirname, '../../../../evidence/tests'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, '../../../../evidence/tests/H06-benchmark.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result));
  expect(result.avgHits).toBeGreaterThan(0);
  await drop();
}, 600_000);
