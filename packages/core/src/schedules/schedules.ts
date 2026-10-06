import { CronExpressionParser } from 'cron-parser';
import type { Db } from '../database/pool';

export function validateCron(expr: string, tz: string): void {
  CronExpressionParser.parse(expr, { tz });
  if (!Intl.supportedValuesOf('timeZone').includes(tz) && tz !== 'UTC') throw new Error('unknown timezone');
}

export function latestSlot(expr: string, tz: string, now = new Date()): Date {
  return CronExpressionParser.parse(expr, { tz, currentDate: new Date(now.getTime() + 1000) }).prev().toDate();
}

export function nextSlot(expr: string, tz: string, now = new Date()): Date {
  return CronExpressionParser.parse(expr, { tz, currentDate: now }).next().toDate();
}

export interface DueSchedule { id: string; workspace_id: string; skill_id: string; slot: string; missed: boolean; name: string; budget_usd: number | null; created_by: string | null }

/**
 * Atomically claims due schedules. Exactly one worker can claim a given slot (compare-and-set
 * on last_slot). Missed slots during downtime follow missed_policy: "skip" advances without
 * running, "run_once" runs once for the latest slot (never once per missed slot). A schedule
 * whose previous run is still active is skipped (no overlap).
 */
export async function claimDueSchedules(db: Db, now = new Date(), graceMs = 120_000): Promise<{ due: DueSchedule[]; skipped: { id: string; reason: string }[] }> {
  const rows = (await db.query(`SELECT * FROM schedules WHERE enabled`)).rows;
  const due: DueSchedule[] = []; const skipped: { id: string; reason: string }[] = [];
  for (const s of rows) {
    let slot: Date;
    try { slot = latestSlot(s.cron, s.timezone, now); } catch { skipped.push({ id: s.id, reason: 'invalid_cron' }); continue; }
    if (s.last_slot && new Date(s.last_slot) >= slot) continue;
    const claimed = await db.query(`UPDATE schedules SET last_slot=$2, updated_at=now() WHERE id=$1 AND (last_slot IS NULL OR last_slot < $2) RETURNING id`, [s.id, slot.toISOString()]);
    if (!claimed.rowCount) continue;
    if (!s.last_slot) { skipped.push({ id: s.id, reason: 'first_slot_baseline' }); continue; }
    const late = now.getTime() - slot.getTime() > graceMs;
    if (late && s.missed_policy === 'skip') { skipped.push({ id: s.id, reason: 'missed_skip' }); continue; }
    if (s.last_run_id) {
      const prev = (await db.query(`SELECT status FROM agent_runs WHERE id=$1`, [s.last_run_id])).rows[0];
      if (prev && ['queued', 'running', 'cancel_requested'].includes(prev.status)) { skipped.push({ id: s.id, reason: 'previous_still_running' }); continue; }
    }
    due.push({ id: s.id, workspace_id: s.workspace_id, skill_id: s.skill_id, slot: slot.toISOString(), missed: late, name: s.name, budget_usd: s.budget_usd, created_by: s.created_by });
  }
  return { due, skipped };
}
