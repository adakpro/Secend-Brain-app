// D06: an expired terminal ticket must be refused by the server (not merely closed by the client).
import WebSocket from 'ws';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8081'; const WSB = BASE.replace(/^http/, 'ws');
const r = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD }) });
const cookie = r.headers.get('set-cookie').split(';')[0]; const { csrfToken } = await r.json();
const t = await (await fetch(BASE + '/api/v1/admin/native-claude/sessions', { method: 'POST', headers: { origin: BASE, cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: '{"action":"login"}' })).json();
await new Promise(res => setTimeout(res, 63_000));
const out = await new Promise(res => { const ws = new WebSocket(`${WSB}/api/v1/admin/native-claude/terminal?ticket=${encodeURIComponent(t.ticket)}`, { headers: { origin: BASE, cookie } }); let bytes = 0; ws.on('message', d => { bytes += d.length; }); ws.on('close', (code, reason) => res({ code, reason: reason.toString(), bytesReceived: bytes })); setTimeout(() => ws.terminate(), 20_000); });
console.log(JSON.stringify({ expired_ticket: out }));
