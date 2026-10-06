import YAML from 'yaml';

export interface ParsedMarkdown {
  hasFrontmatter: boolean;
  /** Raw frontmatter text between the fences, untouched. */
  rawFrontmatter: string;
  data: Record<string, unknown>;
  body: string;
  /** Offset of body start in the original string (citation offsets stay aligned). */
  bodyOffset: number;
  errors: string[];
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Parses YAML frontmatter with the YAML 1.2 core schema only: no custom tags, no
 * merge keys, no code execution. Unknown keys are preserved by editing the Document
 * (see setFrontmatterFields) instead of re-serializing a plain object.
 */
export function parseMarkdown(src: string): ParsedMarkdown {
  const m = FENCE.exec(src);
  if (!m) return { hasFrontmatter: false, rawFrontmatter: '', data: {}, body: src, bodyOffset: 0, errors: [] };
  const raw = m[1];
  const errors: string[] = [];
  let data: Record<string, unknown> = {};
  try {
    const doc = YAML.parseDocument(raw, { schema: 'core', customTags: [], merge: false, uniqueKeys: false, prettyErrors: false });
    for (const e of doc.errors) errors.push(e.message);
    for (const w of doc.warnings) if (/tag/i.test(w.message)) errors.push(w.message);
    const js = doc.toJS({ maxAliasCount: 50 });
    if (js && typeof js === 'object' && !Array.isArray(js)) data = js as Record<string, unknown>;
  } catch (e) { errors.push((e as Error).message); }
  return { hasFrontmatter: true, rawFrontmatter: raw, data, body: src.slice(m[0].length), bodyOffset: m[0].length, errors };
}

/** Updates selected keys while keeping unknown keys, ordering and comments intact. */
export function setFrontmatterFields(src: string, fields: Record<string, unknown>): string {
  const m = FENCE.exec(src);
  if (!m) {
    const doc = new YAML.Document(fields);
    return `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n${src}`;
  }
  const check = YAML.parseDocument(m[1], { schema: 'core', customTags: [] });
  if (check.errors.length) throw new Error('frontmatter is not valid YAML; refusing to rewrite');
  // Line-level edit: only the touched top-level keys change; every other byte stays as is.
  let lines = m[1].split(/\r?\n/);
  for (const [k, v] of Object.entries(fields)) {
    const rendered = `${k}: ${renderFlow(v)}`;
    const idx = lines.findIndex(l => new RegExp(`^${escapeRe(k)}\\s*:`).test(l));
    if (idx === -1) { lines.push(rendered); continue; }
    let end = idx + 1;
    while (end < lines.length && (/^\s+\S/.test(lines[end]) || /^\s*-\s/.test(lines[end]) && !/^\S/.test(lines[end]))) end++;
    lines = [...lines.slice(0, idx), rendered, ...lines.slice(end)];
  }
  const out = lines.join('\n');
  const verify = YAML.parseDocument(out, { schema: 'core', customTags: [] });
  if (verify.errors.length) throw new Error('frontmatter edit produced invalid YAML');
  return `---\n${out}\n---\n${src.slice(m[0].length)}`;
}

function renderFlow(v: unknown): string {
  return YAML.stringify(v, { collectionStyle: 'flow', lineWidth: 0, defaultStringType: 'PLAIN' }).trimEnd();
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string' || typeof x === 'number').map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export function titleFrom(parsed: ParsedMarkdown, fallbackPath: string): string {
  const t = parsed.data.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  const h1 = /^#\s+(.+)$/m.exec(parsed.body);
  if (h1) return h1[1].trim();
  return fallbackPath.split('/').pop()!.replace(/\.md$/i, '');
}
