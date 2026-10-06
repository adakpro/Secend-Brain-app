import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Keyring loaded from the master-key secret. Format: either a single base64 32-byte key
 * (treated as version "k1") or JSON {"active":"k2","keys":{"k1":"…","k2":"…"}}.
 * Old versions stay readable so records can be re-encrypted after rotation.
 */
export class Keyring {
  private keys = new Map<string, Buffer>();
  constructor(public readonly active: string, keys: Record<string, string>) {
    for (const [id, b64] of Object.entries(keys)) {
      const k = Buffer.from(b64, 'base64');
      if (k.length !== 32) throw new Error(`master key ${id} must be 32 bytes`);
      this.keys.set(id, k);
    }
    if (!this.keys.has(active)) throw new Error('active master key version missing from keyring');
  }
  static parse(raw: string): Keyring {
    const t = raw.trim();
    if (t.startsWith('{')) {
      const j = JSON.parse(t) as { active: string; keys: Record<string, string> };
      return new Keyring(j.active, j.keys);
    }
    return new Keyring('k1', { k1: t });
  }
  get(version: string): Buffer {
    const k = this.keys.get(version);
    if (!k) throw new Error(`master key version ${version} not available`);
    return k;
  }
  versions(): string[] { return [...this.keys.keys()]; }
}

export interface Sealed { ciphertext: Buffer; nonce: Buffer; keyVersion: string }

export function seal(ring: Keyring, plaintext: string, aad: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.get(ring.active), nonce);
  cipher.setAAD(Buffer.from(`${aad}|${ring.active}`));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: ct, nonce, keyVersion: ring.active };
}

export function open(ring: Keyring, sealed: Sealed, aad: string): string {
  const key = ring.get(sealed.keyVersion);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  d.setAAD(Buffer.from(`${aad}|${sealed.keyVersion}`));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const sha256Buf = (s: string | Buffer) => createHash('sha256').update(s).digest();
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
export function generateMasterKey(): string { return randomBytes(32).toString('base64'); }
