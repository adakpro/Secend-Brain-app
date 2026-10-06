import fs from 'node:fs';

export type AppProfile = 'production' | 'development' | 'test';

function readSecretFile(name: string): string | undefined {
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar && fs.existsSync(fileVar)) return fs.readFileSync(fileVar, 'utf8').trim();
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

export function requireSecret(name: string): string {
  const v = readSecretFile(name);
  if (!v) throw new Error(`missing required secret ${name} (set ${name}_FILE)`);
  return v;
}

export function optionalSecret(name: string): string | undefined {
  return readSecretFile(name);
}

export interface AppConfig {
  profile: AppProfile;
  appOrigin: string;
  databaseUrl: string;
  vaultRoot: string;
  sourcesRoot: string;
  stagingRoot: string;
  backupRoot: string;
  cookieSecure: boolean;
  trustProxy: boolean | string;
  modelProviderMode: 'anthropic' | 'mock';
  anthropicBaseUrl: string;
  workerInternalUrl: string;
  runnerUrl: string;
  inferenceProxyPublicUrl: string;
  nativeUrl: string | undefined;
  appVersion: string;
}

let cached: AppConfig | undefined;

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  if (cached && !Object.keys(overrides).length) return cached;
  const profile = (process.env.APP_PROFILE ?? 'production') as AppProfile;
  if (!['production', 'development', 'test'].includes(profile)) throw new Error(`invalid APP_PROFILE ${profile}`);
  const dbPassword = readSecretFile('DB_PASSWORD');
  const databaseUrl = process.env.DATABASE_URL ?? (dbPassword
    ? `postgres://${process.env.DB_USER ?? 'secondbrain'}:${encodeURIComponent(dbPassword)}@${process.env.DB_HOST ?? 'postgres'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'secondbrain'}`
    : '');
  const appOrigin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:8080';
  const modelProviderMode = (process.env.MODEL_PROVIDER_MODE ?? 'anthropic') as 'anthropic' | 'mock';
  if (modelProviderMode === 'mock' && profile === 'production') {
    throw new Error('MODEL_PROVIDER_MODE=mock is refused in the production profile');
  }
  const cookieSecure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : appOrigin.startsWith('https://');
  if (profile === 'production' && !cookieSecure && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(appOrigin)) {
    throw new Error('production profile on a non-localhost origin requires HTTPS (APP_ORIGIN=https://…)');
  }
  const cfg: AppConfig = {
    profile,
    appOrigin,
    databaseUrl,
    vaultRoot: process.env.VAULT_ROOT ?? '/data/vault',
    sourcesRoot: process.env.SOURCES_ROOT ?? '/data/sources',
    stagingRoot: process.env.STAGING_ROOT ?? '/data/staging',
    backupRoot: process.env.BACKUP_ROOT ?? '/data/backups',
    cookieSecure,
    trustProxy: process.env.TRUST_PROXY ? (process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY) : false,
    modelProviderMode,
    anthropicBaseUrl: 'https://api.anthropic.com',
    workerInternalUrl: process.env.WORKER_INTERNAL_URL ?? 'http://worker:8790',
    runnerUrl: process.env.RUNNER_URL ?? 'http://agent-runner:8791',
    inferenceProxyPublicUrl: process.env.INFERENCE_PROXY_URL ?? 'http://worker:8790/inference',
    nativeUrl: process.env.NATIVE_CLAUDE_URL || undefined,
    appVersion: process.env.APP_VERSION ?? '0.1.0',
    ...overrides,
  };
  if (!Object.keys(overrides).length) cached = cfg;
  return cfg;
}
