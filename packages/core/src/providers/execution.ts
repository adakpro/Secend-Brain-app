import type { Db } from '../database/pool';
import type { AppConfig } from '../config';

export async function modelExecution(db: Db, cfg: AppConfig): Promise<'codex' | 'api'> {
  if (cfg.modelProviderMode === 'mock') return 'api';
  const setting = (await db.query("SELECT value FROM app_meta WHERE key='model_execution'")).rows[0]?.value;
  return setting === 'api' || setting === 'codex' ? setting : cfg.modelExecution;
}
