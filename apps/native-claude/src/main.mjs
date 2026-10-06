// native-claude: runs the OFFICIAL, unmodified Claude Code binary for the owner's own,
// direct, interactive use (see docs/CLAUDE-AUTH-DECISION.md).
//
// Trust boundary: this service holds NO product secrets (no API key, master key, DB password or
// internal token). It is reachable only on the internal `native` network, where the only other
// member is the api service, which authenticates the user (session + step-up + single-use
// ticket + Origin) before proxying a terminal. Credentials are managed solely by the CLI itself in
// $HOME/.claude on the dedicated `native-home` volume; this code never reads or parses them.
// Nothing typed into or printed by the terminal is logged or stored.
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const PORT = Number(process.env.PORT ?? 8792);
const HOME = process.env.HOME ?? '/home/claude';
const STAGING = '/workspace';
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const IDLE_MS = 15 * 60 * 1000;
const MAX_MSG = 64 * 1024;
const MAX_SESSIONS = 1;

// Fixed command allowlist. The browser never supplies a command.
const COMMANDS = {
  login: { args: ['auth', 'login'], cwd: HOME },
  // The interactive session opens INSIDE the staging vault so the second-brain skills' relative paths (raw/, wiki/) match.
  shell: { args: [], cwd: path.join(STAGING, 'vault') },
};

const childEnv = () => ({
  HOME, PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: process.env.TZ ?? 'UTC',
  DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  // Explicitly NOT passing ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL: the owner signs in with the CLI's own flow.
});

const log = (msg, f = {}) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), service: 'native-claude', msg, ...f }) + '\n');

function run(args, timeoutMs = 15000) {
  return new Promise(resolve => {
    execFile(CLAUDE, args, { env: childEnv(), cwd: HOME, timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? '') });
    });
  });
}

let versionCache = null;
async function version() { if (!versionCache) { const r = await run(['--version'], 20000); versionCache = r.stdout.trim().split(/\s+/)[0] || null; } return versionCache; }

// Each CLI invocation takes seconds; cache status briefly and share one in-flight refresh.
let statusCache = null; let statusAt = 0; let inflight = null;
async function cachedStatus(force = false) {
  if (!force && statusCache && Date.now() - statusAt < 15000) return statusCache;
  inflight ??= authStatus().then(s => { statusCache = s; statusAt = Date.now(); return s; }).finally(() => { inflight = null; });
  return inflight;
}

/** `claude auth status` prints JSON; only allowlisted, minimal fields leave this service. */
async function authStatus() {
  const r = await run(['auth', 'status']);
  let j = {};
  try { j = JSON.parse(r.stdout); } catch { j = {}; }
  const pick = (...keys) => { for (const k of keys) if (typeof j[k] === 'string' && j[k]) return j[k].slice(0, 200); return null; };
  return {
    loggedIn: r.code === 0 && (j.loggedIn !== false),
    authMethod: pick('authMethod') ?? (r.code === 0 ? 'unknown' : 'none'),
    email: pick('email', 'emailAddress', 'accountEmail'),
    orgName: pick('orgName', 'organizationName'),
    statusExitCode: r.code,
    version: await version(),
    activeSessions: sessions.size,
  };
}

const sessions = new Map();

const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/status?fresh=1')) return send(200, { ...(await cachedStatus(req.url.endsWith('fresh=1'))), activeSessions: sessions.size });
    if (req.method === 'POST' && req.url === '/logout') {
      for (const s of sessions.values()) s.kill('logout');
      if (runningJob?.proc) { runningJob.status = 'canceled'; runningJob.proc.kill('SIGTERM'); }
      const r = await run(['auth', 'logout'], 30000);
      statusCache = null;
      log('auth.logout', { exitCode: r.code });
      return send(200, { ok: r.code === 0, exitCode: r.code });
    }
    if (req.method === 'POST' && req.url === '/sessions/close') { for (const s of sessions.values()) s.kill('closed_by_user'); return send(200, { ok: true }); }
    if (req.method === 'GET' && req.url === '/staging/export') return send(200, exportStaging());
    if (req.method === 'POST' && req.url === '/jobs') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 20000) return send(413, { error: 'too_large' }); }
      const { prompt } = JSON.parse(body);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) return send(422, { error: 'bad_prompt' });
      try { const j = startJob(prompt); return send(200, { id: j.id }); } catch (e) { return send(e.status ?? 500, { error: e.message }); }
    }
    const jm = /^\/jobs\/([a-z0-9]{6,20})(\/cancel)?(?:\?after=(\d+))?$/.exec(req.url ?? '');
    if (jm) {
      const j = jobs.get(jm[1]); if (!j) return send(404, { error: 'not_found' });
      if (req.method === 'POST' && jm[2]) { if (j.proc) { j.status = 'canceled'; j.proc.kill('SIGTERM'); } return send(200, { ok: true }); }
      const after = Number(jm[3] ?? 0);
      return send(200, { id: j.id, status: j.status, events: j.events.filter(e => e.seq > after), result: j.status === 'running' ? null : j.result, error: j.error });
    }
    if (req.method === 'POST' && req.url === '/staging/load') {
      let body = ''; let size = 0;
      for await (const c of req) { size += c.length; if (size > 20 * 1024 * 1024) return send(413, { error: 'too_large' }); body += c; }
      return send(200, loadStaging(JSON.parse(body)));
    }
    send(404, { error: 'not_found' });
  } catch (e) { log('request_error', { error: String(e?.message ?? e).slice(0, 200) }); send(500, { error: 'internal' }); }
});

// ---- Staging: plain files the owner edits with Claude Code. Import back is done by the API's importer. ----
function safeJoin(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error('bad path');
  const abs = path.join(STAGING, 'vault', rel);
  if (!abs.startsWith(path.join(STAGING, 'vault') + path.sep)) throw new Error('bad path');
  return abs;
}
function loadStaging({ files, snapshotId }) {
  if (sessions.size || runningJob) throw new Error('close the terminal / wait for the running job before reloading staging');
  const root = path.join(STAGING, 'vault');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const f of files ?? []) { const abs = safeJoin(f.path); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, f.content); }
  fs.writeFileSync(path.join(STAGING, 'SNAPSHOT_ID'), String(snapshotId ?? ''));
  return { ok: true, files: (files ?? []).length };
}
function exportStaging() {
  const root = path.join(STAGING, 'vault');
  const out = []; let total = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isSymbolicLink()) continue; // symlinks are never exported
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !(d === root && e.name === 'raw')) walk(abs); continue; }
      if (!e.isFile() || !e.name.endsWith('.md') || (d === root && e.name === 'CLAUDE.md')) continue;
      const st = fs.statSync(abs);
      if (st.size > 1024 * 1024) continue;
      total += st.size; if (total > 20 * 1024 * 1024 || out.length > 5000) return;
      out.push({ path: path.relative(root, abs).split(path.sep).join('/'), content: fs.readFileSync(abs, 'utf8') });
    }
  };
  if (fs.existsSync(root)) walk(root);
  let snapshotId = null; try { snapshotId = fs.readFileSync(path.join(STAGING, 'SNAPSHOT_ID'), 'utf8').trim() || null; } catch { /* none */ }
  return { snapshotId, files: out, terminalOpen: sessions.size > 0 };
}

// ---- Owner-initiated headless jobs (official `claude -p`, same login, no terminal shown) ----
// Started only by an explicit click of the owner in the app (via the api). One at a time; never while a
// terminal is open. Tools are limited to reading/editing files inside the staging vault (no Bash, no web).
const jobs = new Map(); let runningJob = null;
const HEADLESS_ARGS = ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
  '--allowedTools', 'Read,Edit,Write,Glob,Grep,MultiEdit,TodoWrite', '--disallowedTools', 'Bash,WebFetch,WebSearch,NotebookEdit',
  '--max-turns', '60', '--no-session-persistence'];

function startJob(prompt) {
  if (runningJob) throw Object.assign(new Error('a job is already running'), { status: 409 });
  if (sessions.size) throw Object.assign(new Error('close the terminal first'), { status: 409 });
  const id = Math.random().toString(36).slice(2, 12);
  const job = { id, status: 'running', events: [], result: null, error: null, startedAt: Date.now(), proc: null };
  jobs.set(id, job); runningJob = job;
  const vault = path.join(STAGING, 'vault');
  const proc = spawn(CLAUDE, ['-p', prompt, ...HEADLESS_ARGS], { cwd: vault, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  job.proc = proc;
  const push = e => { job.events.push({ seq: job.events.length + 1, ...e }); if (job.events.length > 2000) job.events.splice(0, 500); };
  push({ type: 'progress', message: 'Claude Code شروع به کار کرد' });
  let buf = '';
  proc.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'assistant' && m.message?.content) {
        for (const b of m.message.content) {
          if (b.type === 'text' && b.text) push({ type: 'text', text: b.text.slice(0, 4000) });
          if (b.type === 'tool_use') {
            const inp = b.input ?? {};
            const target = String(inp.file_path ?? inp.path ?? inp.pattern ?? '').replace(vault + '/', '').slice(0, 200);
            push({ type: 'tool', name: b.name, summary: target });
          }
        }
      } else if (m.type === 'result') {
        job.result = { subtype: m.subtype, isError: !!m.is_error, text: String(m.result ?? '').slice(0, 20000), numTurns: m.num_turns ?? null };
      }
    }
  });
  let errTail = '';
  proc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-2000); });
  proc.on('close', code => {
    if (job.status === 'canceled') { /* keep */ }
    else if (code === 0 && job.result && !job.result.isError) job.status = 'succeeded';
    else { job.status = 'failed'; job.error = (job.result?.text || errTail || `exit ${code}`).slice(0, 1000); }
    push({ type: 'end', status: job.status });
    job.proc = null; runningJob = null; statusCache = null;
    log('job.finished', { id, status: job.status, code, seconds: Math.round((Date.now() - job.startedAt) / 1000) });
  });
  log('job.started', { id });
  return job;
}

// ---- PTY over WebSocket (only the api proxies here, after its own ticket/session checks) ----
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action') ?? '';
  if (u.pathname !== '/pty' || !COMMANDS[action]) { socket.destroy(); return; }
  if (sessions.size >= MAX_SESSIONS || runningJob) { socket.write('HTTP/1.1 409 Conflict\r\n\r\n'); socket.destroy(); return; }
  // Optional text to pre-type at the prompt. It is typed WITHOUT Enter: the owner reads it and submits it themselves.
  let prefill = '';
  try { prefill = Buffer.from(u.searchParams.get('prefill') ?? '', 'base64url').toString('utf8'); } catch { prefill = ''; }
  prefill = prefill.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 600);
  wss.handleUpgrade(req, socket, head, ws => openSession(ws, u.searchParams.get('action'), Number(u.searchParams.get('cols') ?? 100), Number(u.searchParams.get('rows') ?? 30), action === 'shell' ? prefill : ''));
});

function openSession(ws, action, cols, rows, prefill = '') {
  const cmd = COMMANDS[action];
  fs.mkdirSync(path.join(STAGING, 'vault'), { recursive: true });
  const id = Math.random().toString(36).slice(2, 10);
  const term = pty.spawn(CLAUDE, cmd.args, { name: 'xterm-256color', cols: clamp(cols, 20, 300), rows: clamp(rows, 5, 120), cwd: cmd.cwd, env: childEnv() });
  let idle;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => kill('idle_timeout'), IDLE_MS); };
  const kill = reason => { try { term.kill(); } catch { /* already gone */ } if (ws.readyState === 1) ws.close(4000, reason); sessions.delete(id); clearTimeout(idle); log('pty.closed', { action, reason }); };
  sessions.set(id, { kill });
  log('pty.opened', { action });
  touch();
  let typed = !prefill;
  const typePrefill = () => { if (typed) return; typed = true; term.write(prefill); };
  if (prefill) setTimeout(typePrefill, 8000); // fallback if the prompt marker is never seen
  term.onData(d => {
    if (ws.readyState === 1) ws.send(d);
    if (!typed && /❯/.test(d)) setTimeout(typePrefill, 400); // the input prompt is ready
  });
  term.onExit(({ exitCode }) => { if (ws.readyState === 1) ws.close(1000, `process exited (${exitCode})`); sessions.delete(id); clearTimeout(idle); statusCache = null; log('pty.exit', { action, exitCode }); });
  ws.on('message', raw => {
    touch();
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t === 'in' && typeof m.d === 'string' && m.d.length <= 16384) term.write(m.d);
    else if (m.t === 'resize') term.resize(clamp(m.cols, 20, 300), clamp(m.rows, 5, 120));
  });
  ws.on('close', () => kill('client_closed'));
}
const clamp = (n, a, b) => Math.max(a, Math.min(b, Number.isFinite(n) ? Math.floor(n) : a));

server.listen(PORT, '0.0.0.0', () => { log('listening', { port: PORT }); void cachedStatus().catch(() => undefined); });
