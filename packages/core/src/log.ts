// Minimal structured JSON logger with secret redaction. Never pass source text or chat
// content as fields; log identifiers and counts only.
const SECRET_KEYS = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|ciphertext|totp|recovery|credential|x-api-key/i;
const SECRET_VALUE = /(sk-ant-[A-Za-z0-9_-]{8,})|(sb_[A-Za-z0-9_-]{20,})/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;
const service = process.env.SERVICE_NAME ?? 'core';

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (order[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, service, msg, ...(redact(fields) as object) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
