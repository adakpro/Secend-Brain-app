import { PgBoss } from 'pg-boss';
import { log } from '../log';

export const QUEUES = {
  extract: 'source-extract',
  run: 'run-execute',
  scheduleTick: 'schedule-tick',
} as const;

export type BossRole = 'migrate' | 'worker' | 'producer';

/**
 * pg-boss lives in its own schema inside the same PostgreSQL (no Redis). The migrate job
 * installs/upgrades it; the worker supervises and runs cron; the API only produces jobs.
 */
export async function createBoss(connectionString: string, role: BossRole): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString, schema: 'pgboss', application_name: `secondbrain-${role}`,
    max: role === 'producer' ? 3 : 6,
    migrate: role !== 'producer', createSchema: role !== 'producer',
    supervise: role === 'worker', schedule: role === 'worker',
  });
  boss.on('error', (e: Error) => log.warn('queue.error', { role, error: e.message }));
  await boss.start({ attempts: 30 });
  if (role !== 'producer') {
    // Retries are bounded; credential/input errors are not retried by the executor at all.
    await boss.createQueue(QUEUES.extract, { retryLimit: 3, retryDelay: 10, retryBackoff: true, expireInSeconds: 600 } as never).catch(() => undefined);
    await boss.createQueue(QUEUES.run, { retryLimit: 3, retryDelay: 15, retryBackoff: true, expireInSeconds: 3900 } as never).catch(() => undefined);
    await boss.createQueue(QUEUES.scheduleTick, { policy: 'singleton', retryLimit: 0, expireInSeconds: 120 } as never).catch(() => undefined);
  }
  return boss;
}
export type { PgBoss };
