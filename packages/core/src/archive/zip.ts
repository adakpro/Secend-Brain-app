import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { normalizeRelPath, PathError } from '../vault/paths';

/** Minimal streaming ZIP writer (deflate, no ZIP64: archives up to 4 GiB). */
export class ZipWriter {
  private entries: { name: Buffer; crc: number; csize: number; usize: number; offset: number; method: number; time: number; date: number }[] = [];
  private offset = 0;
  private constructor(private fh: fsp.FileHandle) {}
  static async create(path: string) { return new ZipWriter(await fsp.open(path, 'wx', 0o600)); }

  async add(name: string, data: Buffer | string) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(buf) >>> 0;
    const comp = zlib.deflateRawSync(buf, { level: 6 });
    const useStore = comp.length >= buf.length;
    const body = useStore ? buf : comp;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    if (this.offset + body.length + 100 > 0xffffffff) throw new Error('archive too large for ZIP32');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(useStore ? 0 : 8, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(buf.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    await this.fh.write(Buffer.concat([h, nameBuf])); await this.fh.write(body);
    this.entries.push({ name: nameBuf, crc, csize: body.length, usize: buf.length, offset: this.offset, method: useStore ? 0 : 8, time, date });
    this.offset += 30 + nameBuf.length + body.length;
  }

  async close() {
    const start = this.offset; const parts: Buffer[] = [];
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(e.offset, 42);
      parts.push(c, e.name);
    }
    const cd = Buffer.concat(parts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(start, 16);
    await this.fh.write(Buffer.concat([cd, end])); await this.fh.sync(); await this.fh.close();
  }
}

export interface ZipEntry { name: string; method: number; csize: number; usize: number; crc: number; localOffset: number; isSymlink: boolean; isDir: boolean }
export interface ZipLimits { maxEntries: number; maxTotalBytes: number; maxEntryBytes: number; maxRatio: number }
export const DEFAULT_LIMITS: ZipLimits = { maxEntries: 50_000, maxTotalBytes: 2 * 1024 ** 3, maxEntryBytes: 200 * 1024 ** 2, maxRatio: 200 };

export class ZipError extends Error { constructor(public code: string, msg: string) { super(msg); } }

/**
 * Reads a ZIP central directory and validates every entry BEFORE extracting anything:
 * path traversal / absolute names (zip-slip), symlink entries, entry count, declared total
 * size and compression ratio (zip-bomb). Extraction re-checks the real inflated size.
 */
export class ZipReader {
  private constructor(private buf: Buffer, public entries: ZipEntry[]) {}
  static async open(path: string, limits: ZipLimits = DEFAULT_LIMITS) {
    const st = await fsp.stat(path);
    if (st.size > limits.maxTotalBytes) throw new ZipError('too_large', 'archive too large');
    return ZipReader.fromBuffer(await fsp.readFile(path), limits);
  }
  static fromBuffer(buf: Buffer, limits: ZipLimits = DEFAULT_LIMITS) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new ZipError('not_zip', 'not a ZIP archive');
    const count = buf.readUInt16LE(eocd + 10); const cdSize = buf.readUInt32LE(eocd + 12); const cdOff = buf.readUInt32LE(eocd + 16);
    if (count > limits.maxEntries) throw new ZipError('too_many_entries', `archive has ${count} entries`);
    if (cdOff + cdSize > buf.length) throw new ZipError('corrupt', 'central directory out of range');
    const entries: ZipEntry[] = []; let p = cdOff; let total = 0;
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('corrupt', 'bad central directory entry');
      const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
      const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
      const attr = buf.readUInt32LE(p + 38) >>> 16; const local = buf.readUInt32LE(p + 42);
      const rawName = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
      p += 46 + nlen + xlen + clen;
      const isDir = rawName.endsWith('/');
      const isSymlink = (attr & 0o170000) === 0o120000;
      if (isSymlink) throw new ZipError('symlink', `symlink entry refused: ${rawName.slice(0, 80)}`);
      if (method !== 0 && method !== 8) throw new ZipError('unsupported', `compression method ${method} not supported`);
      let name: string;
      try { name = isDir ? rawName : normalizeRelPath(rawName, { allowHidden: true }); } catch (e) { throw new ZipError('zip_slip', `unsafe path in archive: ${rawName.slice(0, 80)} (${(e as PathError).message})`); }
      if (isDir && (rawName.includes('..') || rawName.startsWith('/'))) throw new ZipError('zip_slip', `unsafe directory: ${rawName.slice(0, 80)}`);
      if (usize > limits.maxEntryBytes) throw new ZipError('too_large', `entry too large: ${name}`);
      if (csize > 0 && usize / csize > limits.maxRatio) throw new ZipError('zip_bomb', `suspicious compression ratio for ${name}`);
      total += usize;
      if (total > limits.maxTotalBytes) throw new ZipError('too_large', 'uncompressed total too large');
      entries.push({ name, method, csize, usize, crc, localOffset: local, isSymlink, isDir });
    }
    return new ZipReader(buf, entries);
  }
  read(e: ZipEntry, limits: ZipLimits = DEFAULT_LIMITS): Buffer {
    const p = e.localOffset;
    if (this.buf.readUInt32LE(p) !== 0x04034b50) throw new ZipError('corrupt', 'bad local header');
    const nlen = this.buf.readUInt16LE(p + 26); const xlen = this.buf.readUInt16LE(p + 28);
    const data = this.buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + e.csize);
    const out = e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: Math.min(limits.maxEntryBytes, e.usize + 1) });
    if (out.length !== e.usize) throw new ZipError('size_mismatch', `size mismatch for ${e.name}`);
    if ((zlib.crc32(out) >>> 0) !== e.crc) throw new ZipError('crc', `CRC mismatch for ${e.name}`);
    return out;
  }
}
