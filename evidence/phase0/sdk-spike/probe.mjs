// Spike: which HTTP endpoints does the SDK's bundled CLI call via ANTHROPIC_BASE_URL?
import http from 'node:http';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
const log = [];
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    console.error('REQ', req.method, req.url, req.headers['x-api-key']?'x-api-key':'', body.slice(0,300)); console.error('REQ', req.method, req.url, JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['content-length','connection','host','accept-encoding'].includes(k)).map(([k,v])=>[k,k.includes('key')||k.includes('auth')?String(v).slice(0,8)+'…':v]))), 'maxtok', (body.match(/"max_tokens":\d+/)||[''])[0], 'stream', (body.match(/"stream":\w+/)||[''])[0], 'tools', (body.match(/"name":"[a-zA-Z_]+"/g)||[]).join(',')); log.push({ method: req.method, url: req.url, headers: Object.keys(req.headers), auth: req.headers['x-api-key'] ? 'x-api-key' : (req.headers.authorization ? 'bearer' : 'none'), body: body.slice(0, 1500) });
    if(log.length===1) log[0].fullBody=body; res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'probe' } }));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const home = fs.mkdtempSync('/tmp/sbprobe-');
const t = tool('read_note', 'Read a note', { path: z.string() }, async () => ({ content: [{ type: 'text', text: 'x' }] }));
const q = query({ prompt: 'hello', options: {
  tools: [], mcpServers: { vault: createSdkMcpServer({ name: 'vault', tools: [t] }) },
  allowedTools: ['mcp__vault__read_note'], permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true, persistSession: false,
  maxTurns: 2, outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }, cwd: home, model: 'claude-sonnet-5-5',
  env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home + '/.claude', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'job-token-probe', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' },
  stderr: d => process.stderr.write('[stderr] ' + d),
}});
const msgs = [];
try { for await (const m of q) { console.error('MSG', m.type, m.subtype||'', JSON.stringify(m).slice(0,500)); } } catch(e){console.error('ERR',String(e).slice(0,400))}
if(0) try { for await (const m of q) msgs.push({ type: m.type, subtype: m.subtype, tools: m.tools, is_error: m.is_error, result: m.result?.slice?.(0, 300), mcp: m.mcp_servers }); } catch (e) { msgs.push({ error: String(e).slice(0, 500) }); }
srv.close(); fs.writeFileSync('/tmp/claude-0/probe-body.json', log[0]?.fullBody||'');
console.log(JSON.stringify({ requests: log.map(l => ({ ...l, body: l.body.slice(0, 600) })), msgs }, null, 1));
