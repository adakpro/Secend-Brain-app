/**
 * TEST/DEVELOPMENT ONLY. A deterministic stand-in for the Anthropic Messages API that the
 * inference proxy calls instead of api.anthropic.com when MODEL_PROVIDER_MODE=mock. It lets
 * CI exercise the real Agent SDK, the real runner tools and the full review pipeline without
 * a key. It is refused in the production profile (see loadConfig) and every run it serves is
 * recorded with provider="mock". Its output is NOT model output and must never be presented
 * as a successful real connection.
 */
type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string; tool_use_id?: string; content?: unknown };
type Msg = { role: string; content: string | Block[] };

const blocks = (m: Msg): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content);
const textOfResult = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x as Block).text ?? '').join('\n') : '');

interface Plan { text?: string; tool?: { name: string; input: Record<string, unknown> }; stop: 'tool_use' | 'end_turn' }

function history(messages: Msg[]) {
  const calls: { name: string; input: Record<string, unknown>; result: string }[] = [];
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const m of messages) for (const b of blocks(m)) {
    if (b.type === 'tool_use' && b.id) pending.set(b.id, { name: b.name!, input: b.input ?? {} });
    if (b.type === 'tool_result' && b.tool_use_id && pending.has(b.tool_use_id)) calls.push({ ...pending.get(b.tool_use_id)!, result: textOfResult(b.content) });
  }
  return calls;
}

const passages = (txt: string) => [...txt.matchAll(/\[((?:C|S)\d+)\](?: \(p\.\d+\))?(?: §([^\n]*))?\n([\s\S]*?)(?=\n\n\[(?:C|S)\d+\]|\n\n---|$)/g)].map(m => ({ key: m[1], heading: m[2]?.trim() || null, text: m[3].trim() }));
const firstWords = (s: string, n: number) => s.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');
const userText = (messages: Msg[]) => blocks(messages.find(m => m.role === 'user')!).filter(b => b.type === 'text').map(b => b.text).join('\n');
const has = (tools: string[], n: string) => tools.includes(`mcp__vault__${n}`);

function today() { return new Date().toISOString().slice(0, 10); }

function planIngest(messages: Msg[], tools: string[]): Plan {
  const calls = history(messages);
  const reads = calls.filter(c => c.name.endsWith('read_source'));
  const last = reads[reads.length - 1];
  if (!reads.length || (last && /done: false/.test(last.result))) {
    const from = reads.reduce((a, r) => a + passages(r.result).length, 0);
    return { tool: { name: 'mcp__vault__read_source', input: { from, count: 20 } }, stop: 'tool_use' };
  }
  const src = reads.flatMap(r => passages(r.result));
  const title = (/^source: (.+)$/m.exec(reads[0].result)?.[1] ?? 'منبع').trim().replace(/[\\/:*?"<>|#^[\]]/g, ' ').slice(0, 80).trim();
  const concept = (src.find(p => p.heading)?.heading ?? firstWords(src[0]?.text ?? title, 3)).replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim().slice(0, 60) || 'مفهوم اصلی';
  const proposals = calls.filter(c => c.name.endsWith('propose_change'));
  if (proposals.length === 0 && has(tools, 'propose_change')) {
    const claims = src.slice(0, 6).map(p => `- ${firstWords(p.text, 18)} [${p.key}]`).join('\n');
    const content = `---\ntitle: ${title}\ntype: source\ncreated: ${today()}\nupdated: ${today()}\nurl:\nauthor:\npublished:\naliases: []\ntags: [mock]\n---\n\n# ${title}\n\n## What it is\n\n${firstWords(src[0]?.text ?? '', 30)}\n\n## Claims\n\n${claims}\n\n## Why it matters here\n\nپیشنهاد آزمایشی (mock) برای تست مسیر بررسی.\n\n## Links\n\n- [[${concept}]]\n`;
    return { text: 'خواندن منبع کامل شد؛ صفحهٔ منبع پیشنهاد می‌شود.', tool: { name: 'mcp__vault__propose_change', input: { op: 'create', path: `wiki/sources/${title}.md`, content, rationale: 'mock: source page', sourceKeys: src.slice(0, 6).map(p => p.key) } }, stop: 'tool_use' };
  }
  if (proposals.length === 1 && has(tools, 'propose_change')) {
    const content = `---\ntitle: ${concept}\ntype: concept\ncreated: ${today()}\nupdated: ${today()}\naliases: []\ntags: [mock]\n---\n\n# ${concept}\n\n## In one paragraph\n\n${firstWords(src[0]?.text ?? '', 40)}\n\n## Where it came from\n\n[[${title}]]\n\n## Open questions\n\n- not covered by any source here\n`;
    return { tool: { name: 'mcp__vault__propose_change', input: { op: 'create', path: `wiki/concepts/${concept}.md`, content, rationale: 'mock: concept page', sourceKeys: src.slice(0, 2).map(p => p.key) } }, stop: 'tool_use' };
  }
  return { tool: { name: 'StructuredOutput', input: { title: `ورود «${title}»`, summary: `پیشنهاد آزمایشی mock: ۱ صفحهٔ منبع و ۱ مفهوم (${concept}).`, contradictions: [], gaps: [], unreadParts: [] } }, stop: 'tool_use' };
}

function planQuery(messages: Msg[]): Plan {
  const calls = history(messages);
  const q = (/Question:\s*([\s\S]+?)(?:\n\n|$)/.exec(userText(messages))?.[1] ?? userText(messages)).trim();
  const search = calls.find(c => c.name.endsWith('search_wiki'));
  if (!search) return { tool: { name: 'mcp__vault__search_wiki', input: { query: q } }, stop: 'tool_use' };
  const firstPath = /^(\S[^\n]*?\.md) — /m.exec(search.result)?.[1];
  const read = calls.find(c => c.name.endsWith('read_note'));
  if (firstPath && !read) return { tool: { name: 'mcp__vault__read_note', input: { path: firstPath } }, stop: 'tool_use' };
  const ps = read ? passages(read.result) : [];
  if (!ps.length) {
    const answer = '[پاسخ آزمایشی mock] در دانش این فضا دربارهٔ این پرسش چیزی پیدا نشد.';
    if (!calls.some(c => c.name === 'StructuredOutput')) return { text: answer, tool: { name: 'StructuredOutput', input: { answer, citations: [], read: [], notCovered: [q], conflicts: [] } }, stop: 'tool_use' };
  }
  const p = ps.find(x => x.text.replace(/^#.*$/m, '').trim().length > 20) ?? ps[0];
  const quote = firstWords(p.text.replace(/^#.*$/gm, '').trim(), 10);
  const title = /^title: (.+)$/m.exec(read!.result)?.[1] ?? '';
  const answer = `[پاسخ آزمایشی mock] بر پایهٔ «${title}»: ${quote} [${p.key}]`;
  return { text: answer, tool: { name: 'StructuredOutput', input: { answer, citations: [{ key: p.key, quote }], read: [firstPath], notCovered: [], conflicts: [] } }, stop: 'tool_use' };
}

function planDocs(messages: Msg[], kind: 'studio' | 'quiz'): Plan {
  const calls = history(messages);
  const index = calls.find(c => c.name.endsWith('list_index'));
  if (!index) return { tool: { name: 'mcp__vault__list_index', input: {} }, stop: 'tool_use' };
  const paths = [...index.result.matchAll(/\(([^()\n]+\.md)\)$/gm)].map(m => m[1]).slice(0, 3);
  const reads = calls.filter(c => c.name.endsWith('read_note'));
  if (reads.length < paths.length) return { tool: { name: 'mcp__vault__read_note', input: { path: paths[reads.length] } }, stop: 'tool_use' };
  const ps = reads.flatMap(r => passages(r.result).map(p => ({ ...p, title: /^title: (.+)$/m.exec(r.result)?.[1] ?? '' }))).filter(p => p.text.replace(/^#.*$/gm, '').trim().length > 20);
  if (kind === 'studio') {
    const sections = ps.slice(0, 3).map(p => ({ heading: p.title, body: `${firstWords(p.text.replace(/^#.*$/gm, ''), 25)} [${p.key}]` }));
    return { tool: { name: 'StructuredOutput', input: { outline: sections.map(s => s.heading), sections, citations: ps.slice(0, 3).map(p => ({ key: p.key, quote: firstWords(p.text.replace(/^#.*$/gm, '').trim(), 8) })), notCovered: ['mock output: not a real model draft'] } }, stop: 'tool_use' };
  }
  const questions = ps.slice(0, 3).map((p, i) => {
    const correct = firstWords(p.text.replace(/^#.*$/gm, '').trim(), 8);
    const others = ps.filter((_, j) => j !== i).map(o => firstWords(o.text.replace(/^#.*$/gm, '').trim(), 8)).slice(0, 2);
    while (others.length < 2) others.push(`گزینهٔ نادرست ${others.length + 1}`);
    return { question: `[mock] کدام عبارت در «${p.title}» آمده است؟`, choices: [correct, ...others], answerIndex: 0, explanation: 'پاسخ از متن همین صفحه نقل شده است.', citationKey: p.key, quote: correct };
  });
  return { tool: { name: 'StructuredOutput', input: { questions } }, stop: 'tool_use' };
}

export function mockPlan(body: { system?: unknown; messages: Msg[]; tools?: { name: string }[] }): Plan {
  const sys = JSON.stringify(body.system ?? '');
  const tools = (body.tools ?? []).map(t => t.name);
  // After StructuredOutput was called, finish the turn.
  if (history(body.messages).some(c => c.name === 'StructuredOutput')) return { text: 'done', stop: 'end_turn' };
  if (sys.includes('SKILL:ingest')) return planIngest(body.messages, tools);
  if (sys.includes('SKILL:query')) return planQuery(body.messages);
  if (sys.includes('SKILL:quiz')) return planDocs(body.messages, 'quiz');
  if (sys.includes('SKILL:report') || sys.includes('SKILL:write')) return planDocs(body.messages, 'studio');
  return { text: 'mock: unsupported skill', stop: 'end_turn' };
}

/** Serializes a plan as an Anthropic-compatible SSE stream. */
export function* mockSse(plan: Plan, model: string): Generator<string> {
  const id = 'msg_mock_' + Math.random().toString(36).slice(2, 10);
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  yield ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let i = 0;
  if (plan.text) {
    yield ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
    for (const piece of plan.text.match(/.{1,24}/gs) ?? []) yield ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } });
    yield ev('content_block_stop', { type: 'content_block_stop', index: i });
    i++;
  }
  if (plan.tool) {
    yield ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'toolu_mock_' + Math.random().toString(36).slice(2, 10), name: plan.tool.name, input: {} } });
    yield ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(plan.tool.input) } });
    yield ev('content_block_stop', { type: 'content_block_stop', index: i });
  }
  yield ev('message_delta', { type: 'message_delta', delta: { stop_reason: plan.stop, stop_sequence: null }, usage: { output_tokens: 0 } });
  yield ev('message_stop', { type: 'message_stop' });
}
