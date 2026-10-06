/**
 * Chat export importer. Supported shapes (each has fixtures and tests):
 *  - "chat_messages": Claude.ai export — array of {name|uuid, chat_messages:[{sender, text|content[], created_at}]}
 *  - "mapping": ChatGPT export — array of {title, mapping:{id:{message, parent, children}}, current_node}
 *  - "messages": generic — {messages:[{role, content}]} or an array of such conversations
 * Anything else is reported as unsupported; raw JSON is never passed through as a "processed" chat.
 */
export interface ChatMessage { role: 'user' | 'assistant' | 'system' | 'tool'; text: string; at?: string }
export interface ChatConversation { id: string; title: string; messages: ChatMessage[]; droppedBranches: number; format: ChatFormat }
export type ChatFormat = 'chat_messages' | 'mapping' | 'messages';
export interface ChatImportResult { format: ChatFormat | 'unsupported'; conversations: ChatConversation[]; skipped: { index: number; reason: string }[] }

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : (x && typeof x === 'object' && 'text' in x && typeof (x as { text: unknown }).text === 'string' ? (x as { text: string }).text : ''))).filter(Boolean).join('\n');
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    if (Array.isArray(o.parts)) return o.parts.filter(p => typeof p === 'string').join('\n');
    if (typeof o.text === 'string') return o.text;
  }
  return '';
}

const roleOf = (r: unknown): ChatMessage['role'] | null => {
  const s = String(r ?? '').toLowerCase();
  if (s === 'human' || s === 'user') return 'user';
  if (s === 'assistant' || s === 'ai' || s === 'model') return 'assistant';
  if (s === 'system') return 'system';
  if (s === 'tool') return 'tool';
  return null;
};

function fromChatMessages(conv: Record<string, unknown>, i: number): ChatConversation {
  const msgs = (conv.chat_messages as Record<string, unknown>[]).map(m => ({ role: roleOf(m.sender) ?? 'user', text: textOf(m.text) || textOf(m.content), at: typeof m.created_at === 'string' ? m.created_at : undefined }))
    .filter(m => m.text.trim());
  msgs.sort((a, b) => (a.at && b.at ? a.at.localeCompare(b.at) : 0));
  return { id: String(conv.uuid ?? conv.id ?? i), title: String(conv.name ?? conv.title ?? `گفتگو ${i + 1}`), messages: msgs, droppedBranches: 0, format: 'chat_messages' };
}

function fromMapping(conv: Record<string, unknown>, i: number): ChatConversation {
  const mapping = conv.mapping as Record<string, { message?: Record<string, any> | null; parent?: string | null; children?: string[] }>;
  // Follow the active branch: walk from current_node up to the root, then reverse.
  let node = typeof conv.current_node === 'string' ? conv.current_node : undefined;
  if (!node || !mapping[node]) {
    // Fall back to the deepest leaf on the first-child path.
    const roots = Object.entries(mapping).filter(([, v]) => !v.parent || !mapping[v.parent]);
    node = roots[0]?.[0];
    while (node && mapping[node]?.children?.length) node = mapping[node].children![0];
  }
  const path: string[] = [];
  const seen = new Set<string>();
  while (node && mapping[node] && !seen.has(node)) { seen.add(node); path.push(node); node = mapping[node].parent ?? undefined; }
  path.reverse();
  let dropped = 0;
  for (const id of path) dropped += Math.max(0, (mapping[id].children?.length ?? 0) - 1);
  const messages: ChatMessage[] = [];
  for (const id of path) {
    const m = mapping[id].message;
    if (!m) continue;
    const role = roleOf(m.author?.role);
    const text = textOf(m.content);
    if (!role || !text.trim() || role === 'system' || m.metadata?.is_visually_hidden_from_conversation) continue;
    messages.push({ role, text, at: typeof m.create_time === 'number' ? new Date(m.create_time * 1000).toISOString() : undefined });
  }
  return { id: String(conv.id ?? conv.conversation_id ?? i), title: String(conv.title ?? `گفتگو ${i + 1}`), messages, droppedBranches: dropped, format: 'mapping' };
}

function fromMessages(conv: Record<string, unknown>, i: number): ChatConversation {
  const messages = (conv.messages as Record<string, unknown>[]).map(m => ({ role: roleOf(m.role ?? m.sender ?? m.author) ?? 'user', text: textOf(m.content ?? m.text), at: typeof m.created_at === 'string' ? m.created_at : undefined })).filter(m => m.text.trim());
  return { id: String(conv.id ?? i), title: String(conv.title ?? conv.name ?? `گفتگو ${i + 1}`), messages, droppedBranches: 0, format: 'messages' };
}

export function parseChatExport(json: unknown): ChatImportResult {
  let list: unknown[];
  if (Array.isArray(json)) list = json;
  else if (json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>).conversations)) list = (json as { conversations: unknown[] }).conversations;
  else if (json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>).messages)) list = [json];
  else return { format: 'unsupported', conversations: [], skipped: [{ index: 0, reason: 'unrecognized top-level shape' }] };
  const out: ChatConversation[] = []; const skipped: { index: number; reason: string }[] = [];
  const formats = new Set<ChatFormat>();
  list.forEach((c, i) => {
    if (!c || typeof c !== 'object') { skipped.push({ index: i, reason: 'not an object' }); return; }
    const o = c as Record<string, unknown>;
    let conv: ChatConversation | null = null;
    if (Array.isArray(o.chat_messages)) conv = fromChatMessages(o, i);
    else if (o.mapping && typeof o.mapping === 'object') conv = fromMapping(o, i);
    else if (Array.isArray(o.messages)) conv = fromMessages(o, i);
    if (!conv) { skipped.push({ index: i, reason: 'unknown conversation shape' }); return; }
    if (!conv.messages.length) { skipped.push({ index: i, reason: 'no readable messages' }); return; }
    formats.add(conv.format); out.push(conv);
  });
  return { format: out.length ? [...formats][0] : 'unsupported', conversations: out, skipped };
}

export function conversationToMarkdown(c: ChatConversation): string {
  const head = `# ${c.title}\n\n`;
  const body = c.messages.map(m => `**${m.role === 'user' ? 'کاربر' : m.role === 'assistant' ? 'دستیار' : m.role}**${m.at ? ` (${m.at})` : ''}:\n\n${m.text.trim()}\n`).join('\n');
  return head + body + (c.droppedBranches ? `\n> ${c.droppedBranches} شاخهٔ جایگزین در این گفتگو وجود داشت و فقط شاخهٔ فعال وارد شد.\n` : '');
}
