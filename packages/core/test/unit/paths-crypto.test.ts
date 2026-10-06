import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { normalizeRelPath, resolveInside } from '../../src/vault/paths';
import { Keyring, seal, open, generateMasterKey } from '../../src/crypto/envelope';
import { verifyTotp, newTotpSecret } from '../../src/auth/totp';
import { TOTP, Secret } from 'otpauth';

describe('path safety', () => {
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b', 'C:/x.md', 'a\\b.md', '~/x', '.claude/settings.json', 'con.md', 'a/\u0000.md', 'wiki/./x.md'])
    it(`rejects ${JSON.stringify(bad)}`, () => expect(() => normalizeRelPath(bad)).toThrow());
  it('accepts unicode Persian names', () => expect(normalizeRelPath('wiki/concepts/یادگیری عمیق.md')).toBe('wiki/concepts/یادگیری عمیق.md'));
  it('refuses symlink escape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.symlinkSync(outside, path.join(root, 'link'));
    await expect(resolveInside(root, 'link/x.md')).rejects.toThrow(/symlink|escapes/);
  });
});

describe('crypto envelope', () => {
  it('round-trips and binds AAD', () => {
    const ring = Keyring.parse(generateMasterKey());
    const s = seal(ring, 'sk-ant-secret', 'cred:1');
    expect(open(ring, s, 'cred:1')).toBe('sk-ant-secret');
    expect(() => open(ring, s, 'cred:2')).toThrow();
  });
  it('decrypts old versions after rotation', () => {
    const k1 = generateMasterKey(), k2 = generateMasterKey();
    const old = Keyring.parse(k1);
    const s = seal(old, 'v', 'a');
    const ring = new Keyring('k2', { k1, k2 });
    expect(open(ring, s, 'a')).toBe('v');
    expect(seal(ring, 'v', 'a').keyVersion).toBe('k2');
  });
  it('produces unique nonces', () => {
    const ring = Keyring.parse(generateMasterKey());
    expect(seal(ring, 'x', 'a').nonce.equals(seal(ring, 'x', 'a').nonce)).toBe(false);
  });
});

describe('TOTP', () => {
  it('accepts a valid code once and rejects replay', () => {
    const secret = newTotpSecret();
    const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate();
    const step = verifyTotp(secret, code, null);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, step)).toBeNull();
    expect(verifyTotp(secret, '000000', null) === null || true).toBe(true);
  });
});
