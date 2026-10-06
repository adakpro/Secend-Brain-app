import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export class PathError extends Error { constructor(msg: string, public code = 'invalid_path') { super(msg); } }

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Validates a vault-relative path from a user or a model. Returns the normalized POSIX
 * relative path. Absolute paths, drive letters, "..", backslashes, control characters,
 * reserved device names and hidden segments (except allowlisted) are rejected.
 */
export function normalizeRelPath(input: string, { allowHidden = false } = {}): string {
  if (typeof input !== 'string' || !input.trim()) throw new PathError('empty path');
  if (input.length > 400) throw new PathError('path too long');
  const s = input.normalize('NFC');
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new PathError('control characters in path');
  if (s.includes('\\')) throw new PathError('backslash separators are not allowed');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.startsWith('~')) throw new PathError('absolute paths are not allowed');
  const parts = s.split('/').filter(p => p.length > 0);
  if (!parts.length) throw new PathError('empty path');
  for (const p of parts) {
    if (p === '.' || p === '..') throw new PathError('relative segments are not allowed');
    if (p.startsWith('.') && !allowHidden) throw new PathError('hidden path segments are not allowed');
    if (WINDOWS_RESERVED.test(p)) throw new PathError('reserved file name');
    if (/[<>:"|?*]/.test(p)) throw new PathError('invalid characters in path');
    if (p.length > 180) throw new PathError('path segment too long');
  }
  return parts.join('/');
}

/**
 * Resolves a relative path inside root and verifies (via realpath of the deepest existing
 * ancestor) that no symlink escapes the root. Symlinked files themselves are refused.
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const realRoot = await fsp.realpath(root);
  const abs = path.join(realRoot, rel);
  if (!abs.startsWith(realRoot + path.sep)) throw new PathError('path escapes root');
  let probe = abs;
  while (probe !== realRoot) {
    try {
      const st = await fsp.lstat(probe);
      if (st.isSymbolicLink()) throw new PathError('symlinks are not allowed inside the vault', 'symlink');
      const real = await fsp.realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new PathError('path escapes root', 'symlink');
      break;
    } catch (e) {
      if (e instanceof PathError) throw e;
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      probe = path.dirname(probe);
    }
  }
  return abs;
}

/** Atomic write: temp file in the same directory, fsync, rename, fsync directory. */
export async function atomicWrite(absPath: string, content: string | Buffer, mode = 0o640): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.${randomBytes(6).toString('hex')}.sb-tmp`);
  const fh = await fsp.open(tmp, 'wx', mode);
  try { await fh.writeFile(content); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, absPath);
  await fsyncDir(dir);
}

export async function fsyncDir(dir: string): Promise<void> {
  try { const d = await fsp.open(dir, fs.constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); } } catch { /* some filesystems refuse dir fsync */ }
}

export async function removeStaleTemps(root: string): Promise<number> {
  let n = 0;
  async function walk(d: string) {
    let ents: fs.Dirent[];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.sb-tmp')) { await fsp.rm(p, { force: true }); n++; }
    }
  }
  await walk(root);
  return n;
}
