import { normalizeForSearch } from '../text/normalize';

export interface WikiLink {
  raw: string;
  target: string;
  heading?: string;
  alias?: string;
  start: number;
  end: number;
}

/** Extracts [[target#heading|alias]] links, ignoring fenced and inline code. */
export function extractWikiLinks(body: string): WikiLink[] {
  const masked = maskCode(body);
  const out: WikiLink[] = [];
  const re = /\[\[([^\[\]\n|#]+?)(?:#([^\[\]\n|]+?))?(?:\|([^\[\]\n]+?))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const isEmbed = m.index > 0 && masked[m.index - 1] === '!';
    out.push({ raw: body.slice(m.index, m.index + m[0].length), target: m[1].trim(), heading: m[2]?.trim(), alias: m[3]?.trim(), start: m.index, end: m.index + m[0].length, ...(isEmbed ? {} : {}) });
  }
  return out;
}

function maskCode(s: string): string {
  return s
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]+`/g, m => ' '.repeat(m.length));
}

export interface LinkTarget { id: string; path: string; title: string; aliases: string[] }

export type Resolution =
  | { status: 'resolved'; id: string }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: string[] };

const key = (s: string) => normalizeForSearch(s);
const stem = (p: string) => p.replace(/\.md$/i, '');

/**
 * Resolves a wikilink target. Path-qualified targets ("concepts/LLM wiki") must match a
 * path suffix exactly. Bare names match file stem, title or alias; two different files
 * that match are reported as ambiguous, never merged silently.
 */
export function buildResolver(targets: LinkTarget[]) {
  const byPath = new Map<string, LinkTarget>();
  const byName = new Map<string, Set<string>>();
  const add = (k: string, id: string) => { if (!k) return; const s = byName.get(k) ?? new Set(); s.add(id); byName.set(k, s); };
  for (const t of targets) {
    byPath.set(stem(t.path).toLowerCase(), t);
    add(key(stem(t.path).split('/').pop()!), t.id);
    add(key(t.title), t.id);
    for (const a of t.aliases) add(key(a), t.id);
  }
  return (target: string): Resolution => {
    const tgt = stem(target.trim().replace(/\\/g, '/'));
    if (tgt.includes('/')) {
      const exact = byPath.get(tgt.toLowerCase());
      if (exact) return { status: 'resolved', id: exact.id };
      const suffix = [...byPath.entries()].filter(([p]) => p.endsWith('/' + tgt.toLowerCase())).map(([, t]) => t.id);
      if (suffix.length === 1) return { status: 'resolved', id: suffix[0] };
      if (suffix.length > 1) return { status: 'ambiguous', candidates: suffix };
      return { status: 'missing' };
    }
    const hits = byName.get(key(tgt));
    if (!hits || hits.size === 0) return { status: 'missing' };
    if (hits.size === 1) return { status: 'resolved', id: [...hits][0] };
    return { status: 'ambiguous', candidates: [...hits] };
  };
}

/** Rewrites links pointing at oldName to newName, keeping heading and alias text. */
export function rewriteLinks(body: string, matches: (target: string) => boolean, newTarget: string): { text: string; count: number } {
  let count = 0;
  const links = extractWikiLinks(body).filter(l => matches(l.target));
  let out = '';
  let last = 0;
  for (const l of links) {
    out += body.slice(last, l.start) + `[[${newTarget}${l.heading ? '#' + l.heading : ''}${l.alias ? '|' + l.alias : ''}]]`;
    last = l.end;
    count++;
  }
  return { text: out + body.slice(last), count };
}
