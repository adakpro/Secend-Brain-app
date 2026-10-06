import {
  loadConfig, createPool, waitForDb, SCHEMA_VERSION, Keyring, requireSecret, CredentialService, RunService, VaultService, ChangeSetEngine,
  SourceService, createBoss, QUEUES, claimDueSchedules, lintReport, graphMetrics, log, audit,
} from '@sb/core';
import { buildProxy } from './proxy';
import { Executor, RetryableRunError } from './executor';

process.on('unhandledRejection', e => log.error('worker.unhandled_rejection', { error: String((e as Error)?.message ?? e) }));

async function main() {
  const cfg = loadConfig();
  const ring = Keyring.parse(requireSecret('MASTER_KEY'));
  const internalToken = requireSecret('INTERNAL_TOKEN');
  const db = createPool(cfg.databaseUrl, 10);
  await waitForDb(db);
  // Wait for the one-shot migrate service rather than migrating concurrently.
  for (let i = 0; ; i++) {
    const v = await db.query(`SELECT max(version)::int AS v FROM schema_migrations`).catch(() => ({ rows: [{ v: 0 }] }));
    if ((v.rows[0].v ?? 0) >= SCHEMA_VERSION) break;
    if (i > 120) throw new Error('schema not migrated');
    await new Promise(r => setTimeout(r, 1000));
  }
  const creds = new CredentialService(db, () => ring, cfg.anthropicBaseUrl);
  const runs = new RunService(db);
  const vault = new VaultService(db, cfg.vaultRoot);
  const engine = new ChangeSetEngine(db, vault);
  const sources = new SourceService(db, cfg.sourcesRoot);
  const executor = new Executor(db, cfg, runs, creds, engine, internalToken);

  const interrupted = await runs.markInterrupted(0);
  if (interrupted) log.warn('worker.interrupted_runs_marked', { count: interrupted });

  const proxy = buildProxy(db, creds, cfg);
  await proxy.listen({ host: '0.0.0.0', port: 8790 });

  const boss = await createBoss(cfg.databaseUrl, 'worker');
  const concurrency = Number(process.env.RUN_CONCURRENCY ?? 2);

  await boss.work<{ sourceId: string; analyze?: boolean; userId?: string }>(QUEUES.extract, { localConcurrency: 2 }, async jobs => {
    for (const job of jobs) {
      const r = await sources.extract(job.data.sourceId);
      log.info('source.extracted', { sourceId: job.data.sourceId, status: r.status });
      if (r.status === 'ready_for_analysis' && job.data.analyze) {
        const s = (await db.query('SELECT workspace_id FROM sources WHERE id=$1', [job.data.sourceId])).rows[0];
        const run = await runs.create(db, { workspaceId: s.workspace_id, kind: 'ingest', skillId: 'ingest', input: { sourceId: job.data.sourceId }, requestedBy: job.data.userId ?? null, sourceId: job.data.sourceId, idempotencyKey: `auto-ingest:${job.data.sourceId}` });
        if (!run.existing) await boss.send(QUEUES.run, { runId: run.id }, { singletonKey: run.id });
      }
    }
  });

  await boss.work<{ runId: string }>(QUEUES.run, { localConcurrency: concurrency }, async jobs => {
    for (const job of jobs) {
      try { await executor.execute(job.data.runId); }
      catch (e) {
        if (e instanceof RetryableRunError) throw e; // pg-boss retries with backoff
        log.error('run.execute_error', { runId: job.data.runId, error: (e as Error).message });
      }
    }
  });

  await boss.work(QUEUES.scheduleTick, async () => {
    await runs.markInterrupted(90);
    const { due, skipped } = await claimDueSchedules(db);
    for (const s of skipped) log.info('schedule.skipped', s);
    for (const s of due) {
      const run = await runs.create(db, { workspaceId: s.workspace_id, kind: 'maintenance', skillId: s.skill_id === 'ingest' ? 'ingest' : s.skill_id, input: { scheduleId: s.id, slot: s.slot }, requestedBy: s.created_by, scheduleId: s.id, idempotencyKey: `schedule:${s.id}:${s.slot}` });
      if (run.existing) continue;
      await db.query('UPDATE schedules SET last_run_id=$2 WHERE id=$1', [s.id, run.id]);
      if (s.skill_id === 'ingest') {
        // Scheduled ingest only PROPOSES; it never applies. One run per ready source, capped.
        await runs.transition(db, run.id, 'running', { started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() });
        const ready = (await db.query(`SELECT id FROM sources WHERE workspace_id=$1 AND status='ready_for_analysis' AND deleted_at IS NULL ORDER BY created_at LIMIT 5`, [s.workspace_id])).rows;
        const created: string[] = [];
        for (const src of ready) {
          const r = await runs.create(db, { workspaceId: s.workspace_id, kind: 'ingest', skillId: 'ingest', input: { sourceId: src.id }, requestedBy: s.created_by, sourceId: src.id, scheduleId: s.id, idempotencyKey: `schedule-ingest:${src.id}:${s.slot}` });
          if (!r.existing) { await boss.send(QUEUES.run, { runId: r.id }, { singletonKey: r.id }); created.push(r.id); }
        }
        await runs.transition(db, run.id, 'succeeded', { finished_at: new Date().toISOString(), result: { queuedIngestRuns: created.length, missed: s.missed } });
      } else {
        await runs.transition(db, run.id, 'running', { started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), provider: null });
        const result = s.skill_id === 'lint' ? await lintReport(db, s.workspace_id) : await graphMetrics(db, s.workspace_id);
        await runs.transition(db, run.id, 'succeeded', { finished_at: new Date().toISOString(), result: { ...result, missed: s.missed } });
      }
      await audit(db, { workspaceId: s.workspace_id, action: 'schedule.fired', targetType: 'schedule', targetId: s.id, result: 'success', meta: { slot: s.slot, missed: s.missed, runId: run.id } });
    }
  });
  await boss.schedule(QUEUES.scheduleTick, '* * * * *', {}, { tz: 'UTC' } as never);

  log.info('worker.started', { profile: cfg.profile, provider: cfg.modelProviderMode, concurrency });
  const stop = async () => { log.info('worker.stopping'); await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined); await proxy.close(); await db.end(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

main().catch(e => { log.error('worker.fatal', { error: (e as Error).message }); process.exit(1); });
