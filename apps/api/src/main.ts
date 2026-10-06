import {
  loadConfig, createPool, waitForDb, SCHEMA_VERSION, Keyring, requireSecret, AuthService, CredentialService, VaultService, ChangeSetEngine,
  SourceService, RunService, createBoss, log,
} from '@sb/core';
import { buildApp } from './app';
import { RunEventHub } from './routes/runs';
import type { Deps } from './context';

process.on('unhandledRejection', e => log.error('api.unhandled_rejection', { error: String((e as Error)?.message ?? e) }));

async function main() {
  const cfg = loadConfig();
  const ring = Keyring.parse(requireSecret('MASTER_KEY'));
  const internalToken = requireSecret('INTERNAL_TOKEN');
  const db = createPool(cfg.databaseUrl, 15);
  await waitForDb(db);
  for (let i = 0; ; i++) {
    const v = await db.query(`SELECT max(version)::int AS v FROM schema_migrations`).catch(() => ({ rows: [{ v: 0 }] }));
    if ((v.rows[0].v ?? 0) >= SCHEMA_VERSION) break;
    if (i > 120) throw new Error('schema not migrated; run the migrate service');
    await new Promise(r => setTimeout(r, 1000));
  }
  const vault = new VaultService(db, cfg.vaultRoot, process.env.VAULT_TEMPLATE_DIR);
  const engine = new ChangeSetEngine(db, vault);
  const boss = await createBoss(cfg.databaseUrl, 'producer');
  const hub = new RunEventHub(cfg.databaseUrl);
  await hub.start();
  const deps: Deps & { hub: RunEventHub } = {
    cfg, db, ring: () => ring, boss, internalToken, hub,
    auth: new AuthService(db, () => ring), creds: new CredentialService(db, () => ring, cfg.anthropicBaseUrl),
    vault, engine, sources: new SourceService(db, cfg.sourcesRoot), runs: new RunService(db),
  };

  // Crash recovery before serving: undo half-applied ChangeSets, then pick up external edits.
  const slugOf = async (id: string) => (await db.query('SELECT slug FROM workspaces WHERE id=$1', [id])).rows[0]?.slug ?? null;
  const recovered = await engine.recoverJournals(slugOf);
  if (recovered) log.warn('api.apply_journals_recovered', { count: recovered });
  const wss = (await db.query('SELECT id, slug FROM workspaces')).rows;
  for (const w of wss) { await vault.initWorkspace(w.id, w.slug).catch(e => log.error('vault.init_failed', { workspaceId: w.id, error: (e as Error).message })); }
  // Periodic hash reconciliation (watchers are unreliable on network filesystems).
  setInterval(async () => {
    for (const w of (await db.query('SELECT id, slug FROM workspaces').catch(() => ({ rows: [] }))).rows) await vault.reconcile(w.id, w.slug).catch(e => log.warn('vault.reconcile_failed', { error: (e as Error).message }));
  }, Number(process.env.RECONCILE_INTERVAL_S ?? 60) * 1000).unref();

  const app = await buildApp(deps);
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
  log.info('api.started', { profile: cfg.profile, provider: cfg.modelProviderMode, origin: cfg.appOrigin, cookieSecure: cfg.cookieSecure });
  const stop = async () => { await app.close(); await hub.stop(); await boss.stop({ graceful: false }).catch(() => undefined); await db.end(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

main().catch(e => { log.error('api.fatal', { error: (e as Error).message }); process.exit(1); });
