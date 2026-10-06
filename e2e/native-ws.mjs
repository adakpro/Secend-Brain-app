// D06/D07: terminal WebSocket authorization checks against a running stack (test profile).
import WebSocket from 'ws';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8081';
const ORIGIN = BASE; const WSB = BASE.replace(/^http/, 'ws');
async function login() {
  const r = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD }) });
  const cookie = r.headers.get('set-cookie').split(';')[0]; const { csrfToken } = await r.json();
  return { cookie, csrf: csrfToken };
}
async function ticket(s, action = 'login') {
  const r = await fetch(BASE + '/api/v1/admin/native-claude/sessions', { method: 'POST', headers: { origin: ORIGIN, cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  return { status: r.status, body: await r.json() };
}
function open(t, { cookie, origin = ORIGIN, collectMs = 6000 } = {}) {
  return new Promise(res => {
    const ws = new WebSocket(`${WSB}/api/v1/admin/native-claude/terminal?ticket=${encodeURIComponent(t)}`, { headers: { origin, ...(cookie ? { cookie } : {}) } });
    let out = ''; let opened = false;
    ws.on('open', () => { opened = true; ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 30 })); setTimeout(() => ws.close(), collectMs); });
    ws.on('message', d => { out += d.toString(); });
    ws.on('close', (code, reason) => res({ opened, code, reason: reason.toString(), out }));
    ws.on('error', e => res({ opened, code: 'error', reason: String(e.message), out }));
  });
}
const results = {};
const a = await login(); const b = await login();
const t1 = await ticket(a);
results.ticket_minted = t1.status;
results.bad_origin = await open(t1.body.ticket, { cookie: a.cookie, origin: 'https://evil.example', collectMs: 3000 }).then(r => ({ opened: r.opened, code: r.code, reason: r.reason }));
const t2 = await ticket(a);
results.other_session = await open(t2.body.ticket, { cookie: b.cookie, collectMs: 3000 }).then(r => ({ opened: r.opened, code: r.code, reason: r.reason }));
const t3 = await ticket(a);
results.no_cookie = await open(t3.body.ticket, { collectMs: 3000 }).then(r => ({ opened: r.opened, code: r.code, reason: r.reason }));
const t4 = await ticket(a);
const ok = await open(t4.body.ticket, { cookie: a.cookie, collectMs: 8000 });
// Only record WHETHER the official CLI started its own login flow; the flow output itself is not stored.
results.valid_ticket = { opened: ok.opened, code: ok.code, cliShowedOfficialLogin: /claude\.(ai|com)|console\.anthropic|platform\.claude|Select login method|Paste code|login/i.test(ok.out), outputBytes: ok.out.length };
results.reused_ticket = await open(t4.body.ticket, { cookie: a.cookie, collectMs: 3000 }).then(r => ({ opened: r.opened, code: r.code, reason: r.reason }));
const t5 = await ticket(a);
await new Promise(r => setTimeout(r, 62_000));
results.expired_ticket = await open(t5.body.ticket, { cookie: a.cookie, collectMs: 3000 }).then(r => ({ opened: r.opened, code: r.code, reason: r.reason }));
console.log(JSON.stringify(results, null, 1));
