import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { ZipWriter, ZipReader } from '../../src/archive/zip';

// Hand-built single-entry ZIP so malicious names/attributes can be crafted.
function craft(name: string, data: Buffer, { symlink = false, deflate = false } = {}) {
  const body = deflate ? zlib.deflateRawSync(data) : data; const nb = Buffer.from(name);
  const crc = zlib.crc32(data) >>> 0;
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(deflate ? 8 : 0, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nb.length, 28);
  cd.writeUInt32LE(((symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38); cd.writeUInt32LE(0, 42);
  const local = Buffer.concat([lh, nb, body]); const central = Buffer.concat([cd, nb]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

describe('E08 archive safety', () => {
  it('round-trips with the writer', async () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'z-')), 'a.zip');
    const w = await ZipWriter.create(p); await w.add('wiki/a.md', 'سلام'); await w.add('raw/b.bin', Buffer.alloc(1000, 7)); await w.close();
    const r = await ZipReader.open(p);
    expect(r.entries.map(e => e.name)).toEqual(['wiki/a.md', 'raw/b.bin']);
    expect(r.read(r.entries[0]).toString()).toBe('سلام');
  });
  it('refuses zip-slip names', () => {
    expect(() => ZipReader.fromBuffer(craft('../../etc/passwd', Buffer.from('x')))).toThrow(/unsafe path/);
    expect(() => ZipReader.fromBuffer(craft('/abs/path.md', Buffer.from('x')))).toThrow(/unsafe path/);
  });
  it('refuses symlink entries', () => {
    expect(() => ZipReader.fromBuffer(craft('link', Buffer.from('/etc/passwd'), { symlink: true }))).toThrow(/symlink/);
  });
  it('refuses zip bombs by ratio', () => {
    expect(() => ZipReader.fromBuffer(craft('bomb.txt', Buffer.alloc(20 * 1024 * 1024, 0), { deflate: true }))).toThrow(/ratio/);
  });
});
