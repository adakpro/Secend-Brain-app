import { hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id === 2 (const enum in the typings; not usable with isolatedModules).
const ARGON2ID = 2;

// OWASP Password Storage Cheat Sheet baseline for Argon2id: m=19 MiB, t=2, p=1.
const PARAMS = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(pw: string): Promise<string> {
  validatePasswordPolicy(pw);
  return hash(pw, PARAMS);
}

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try { return await verify(stored, pw); } catch { return false; }
}

// A fixed dummy hash so unknown-user logins spend the same time as real ones.
let dummy: string | undefined;
export async function burnPasswordTime(pw: string): Promise<void> {
  dummy ??= await hash('dummy-password-for-timing', PARAMS);
  await verify(dummy, pw).catch(() => false);
}

export function validatePasswordPolicy(pw: string): void {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) throw new PolicyError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (pw.length > 256) throw new PolicyError('password too long');
}

export class PolicyError extends Error {}
