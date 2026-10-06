import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { normalizeForSearch, compactForSearch, AGENT_WRITABLE_RE, type JobRequest, type RunnerEvent, type BundleChunk } from '@sb/contracts';

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

/**
 * Builds the MCP tool set for one job. Every tool reads only from the job bundle the worker
 * prepared for this run's scope. Authorization is enforced here, in the handler, in
 * addition to the SDK tool allowlist.
 */
export function buildTools(job: JobRequest, emit: (e: RunnerEvent) => void) {
  const chunks = new Map(job.bundle.chunks.map(c => [c.key, c]));
  const docsByPath = new Map(job.bundle.docs.map(d => [d.path, d]));
  const readChunks = new Set<string>();
  const proposals = new Map<string, NonNullable<Extract<RunnerEvent, { type: 'proposal' }>['op']>>();
  const fmt = (c: BundleChunk) => `[${c.key}]${c.page ? ` (p.${c.page})` : ''}${c.heading ? ` §${c.heading}` : ''}\n${c.text}`;

  const findDoc = (p: string) => {
    const k = p.replace(/^\/+/, '').replace(/\.md$/i, '');
    return docsByPath.get(k + '.md') ?? job.bundle.docs.find(d => d.path.replace(/\.md$/, '').endsWith('/' + k) || normalizeForSearch(d.title) === normalizeForSearch(k) || d.aliases.some(a => normalizeForSearch(a) === normalizeForSearch(k)));
  };

  const tools = [
    tool('search_wiki', 'Search the vault pages available to this run (scope-filtered). Returns page paths, titles and matching passages with citation keys.',
      { query: z.string().min(1).max(300) },
      async ({ query }) => {
        emit({ type: 'tool', name: 'search_wiki', summary: query.slice(0, 120) });
        const terms = normalizeForSearch(query).split(' ').filter(t => t.length > 1);
        const compact = compactForSearch(query);
        const scored = job.bundle.chunks.filter(c => c.kind === 'document').map(c => {
          const n = normalizeForSearch(`${c.title} ${c.heading ?? ''} ${c.text}`);
          let s = terms.reduce((a, t) => a + (n.includes(t) ? 1 : 0), 0);
          if (compact.length > 2 && n.replace(/ /g, '').includes(compact)) s += 2;
          return { c, s };
        }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8);
        if (!scored.length) return text('No matching pages in this scope.');
        for (const { c } of scored) readChunks.add(c.key);
        return text(scored.map(({ c }) => `${c.path} — ${c.title}\n${fmt({ ...c, text: c.text.slice(0, 600) })}`).join('\n\n---\n\n'));
      }, { annotations: { readOnlyHint: true, openWorldHint: false } }),

    tool('read_note', 'Read one vault page by path or title. Content is returned as passages with citation keys.',
      { path: z.string().min(1).max(300) },
      async ({ path }) => {
        const d = findDoc(path);
        emit({ type: 'tool', name: 'read_note', summary: d?.path ?? path.slice(0, 120) });
        if (!d) return text(`Page not available in this run's scope: ${path}`, true);
        d.chunkKeys.forEach(k => readChunks.add(k));
        const body = d.chunkKeys.map(k => chunks.get(k)).filter(Boolean).map(c => fmt(c!)).join('\n\n');
        return text(`path: ${d.path}\ntitle: ${d.title}\ntype: ${d.kind}\nrevision: ${d.revisionId}\noutgoing links: ${d.links.join(', ') || '(none)'}\n\n${body}`);
      }, { annotations: { readOnlyHint: true, openWorldHint: false } }),

    tool('get_backlinks', 'List pages in scope that link to the given page.',
      { path: z.string().min(1).max(300) },
      async ({ path }) => {
        const d = findDoc(path);
        emit({ type: 'tool', name: 'get_backlinks', summary: d?.path ?? path.slice(0, 120) });
        if (!d) return text(`Page not available in this run's scope: ${path}`, true);
        const names = [d.title, ...d.aliases, d.path.replace(/\.md$/, ''), d.path.split('/').pop()!.replace(/\.md$/, '')].map(normalizeForSearch);
        const back = job.bundle.docs.filter(o => o.path !== d.path && o.links.some(l => names.includes(normalizeForSearch(l)) || names.some(n => normalizeForSearch(l).endsWith(n))));
        return text(back.length ? back.map(b => `${b.path} — ${b.title}`).join('\n') : 'No backlinks in scope.');
      }, { annotations: { readOnlyHint: true, openWorldHint: false } }),

    tool('list_index', 'List the titles of all pages in this run\'s scope (the scope-filtered index).',
      {},
      async () => {
        emit({ type: 'tool', name: 'list_index', summary: `${job.bundle.index.length} pages` });
        return text(job.bundle.index.length ? job.bundle.index.map(i => `${i.kind}: ${i.title} (${i.path})`).join('\n') : 'The vault has no pages in this scope yet.');
      }, { annotations: { readOnlyHint: true, openWorldHint: false } }),
  ];

  if (job.bundle.source) {
    const src = job.bundle.source;
    tools.push(tool('read_source', 'Read the source being ingested, in passages with citation keys. Call repeatedly with increasing `from` until `done: true`.',
      { from: z.number().int().min(0).default(0), count: z.number().int().min(1).max(20).default(10) },
      async ({ from, count }) => {
        const keys = src.chunkKeys.slice(from, from + count);
        emit({ type: 'tool', name: 'read_source', summary: `passages ${from + 1}-${from + keys.length} of ${src.chunkKeys.length}` });
        keys.forEach(k => readChunks.add(k));
        const done = from + keys.length >= src.chunkKeys.length;
        return text(`source: ${src.title}\npassages ${from + 1}-${from + keys.length} of ${src.chunkKeys.length}; done: ${done}\n\n${keys.map(k => fmt(chunks.get(k)!)).join('\n\n')}`);
      }, { annotations: { readOnlyHint: true, openWorldHint: false } }) as unknown as typeof tools[number]);
  }

  if (job.writable) {
    tools.push(tool('propose_change', 'Propose creating or updating one wiki page. Nothing is written; a human reviews every proposal. Use full page content including frontmatter.',
      { op: z.enum(['create', 'update']), path: z.string().min(1).max(300), content: z.string().min(1).max(150_000), rationale: z.string().max(1000).default(''), sourceKeys: z.array(z.string().max(20)).max(50).default([]) },
      async ({ op, path, content, rationale, sourceKeys }) => {
        const p = path.replace(/^\/+/, '');
        const reject = (reason: string) => { emit({ type: 'proposal_rejected', path: p.slice(0, 200), reason }); return text(`REJECTED: ${reason}`, true); };
        if (p.includes('..') || p.includes('\\') || !AGENT_WRITABLE_RE.test(p)) return reject('path must be wiki/{sources,concepts,entities,synthesis}/<name>.md; raw/, index, log and config are not writable');
        const existing = docsByPath.get(p);
        if (op === 'create' && existing) return reject('page exists; use op "update" after read_note');
        if (op === 'update' && !existing) return reject('page does not exist in scope; use op "create"');
        if (proposals.size >= 30 && !proposals.has(p)) return reject('too many proposals in one run');
        const refs = sourceKeys.filter(k => chunks.has(k));
        const proposal = { op, path: p, content, rationale, sourceRefs: refs, baseRevisionId: existing?.revisionId ?? null };
        proposals.set(p, proposal);
        emit({ type: 'proposal', op: proposal });
        return text(`OK: ${op} ${p} recorded as a proposal (${proposals.size} so far).`);
      }, { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }) as unknown as typeof tools[number]);
  }

  const server = createSdkMcpServer({ name: 'vault', version: '1.0.0', tools });
  const allowed = tools.map(t => `mcp__vault__${t.name}`);
  return { server, allowed, readChunks, proposals };
}
