import { it, expect } from 'vitest';
import { freshDb, seedOwner } from './helpers';
import { modelExecution } from '../../src/providers/execution';
import type { AppConfig } from '../../src/config';
it('persists model selection and permits Codex runs after migration', async () => {
  const { db, drop } = await freshDb();
  try {
    const cfg = { modelProviderMode: 'openai', modelExecution: 'codex' } as AppConfig;
    expect(await modelExecution(db, cfg)).toBe('codex');
    await db.query("INSERT INTO app_meta(key,value) VALUES ('model_execution','\"api\"')");
    expect(await modelExecution(db, cfg)).toBe('api');
    const { workspaceId } = await seedOwner(db);
    const r = await db.query("INSERT INTO agent_runs(workspace_id,kind,skill_id,skill_version,provider,status) VALUES ($1,'query','query','1.0.0','codex-cli','queued') RETURNING provider", [workspaceId]);
    expect(r.rows[0].provider).toBe('codex-cli');
    expect(await modelExecution(db, { ...cfg, modelProviderMode: 'mock' })).toBe('api');
  } finally { await drop(); }
});
