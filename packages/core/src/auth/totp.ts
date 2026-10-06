import { TOTP, Secret } from 'otpauth';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './password';

export function newTotpSecret(): string { return new Secret({ size: 20 }).base32; }

export function totpUri(secretB32: string, account: string): string {
  return new TOTP({ issuer: 'Second Brain OS', label: account, secret: Secret.fromBase32(secretB32), algorithm: 'SHA1', digits: 6, period: 30 }).toString();
}

/**
 * Verifies a TOTP code and returns the matched time step, or null. Callers must persist the
 * step and reject any code whose step is <= the last accepted one (replay protection).
 */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const totp = new TOTP({ secret: Secret.fromBase32(secretB32), algorithm: 'SHA1', digits: 6, period: 30 });
  const delta = totp.validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / 30) + delta;
  if (lastStep !== null && step <= lastStep) return null;
  return step;
}

export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const b = randomBytes(8).toString('hex');
    return `${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}`;
  });
}

// Recovery codes are hashed with the same Argon2id parameters; they are long random strings,
// so the minimum-length policy is satisfied by construction.
export const hashRecoveryCode = (c: string) => hashPassword(normalizeRecovery(c).padEnd(19, '-'));
export const verifyRecoveryCode = (h: string, c: string) => verifyPassword(h, normalizeRecovery(c).padEnd(19, '-'));
const normalizeRecovery = (c: string) => c.trim().toLowerCase();
