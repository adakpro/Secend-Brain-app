// Same-origin API client. The session lives in an HttpOnly cookie; the CSRF token is held in
// memory only (never localStorage) and comes from /me.
export interface ApiErrorBody { code: string; message: string; requestId: string; retryable: boolean; details?: unknown }

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) { super(body.message); }
  get code() { return this.body.code; }
}

let csrfToken = '';
let workspaceId = '';
export const setCsrf = (t: string) => { csrfToken = t; };
export const setWorkspace = (id: string) => { workspaceId = id; };
export const getWorkspace = () => workspaceId;

type Listener = (e: ApiError) => void;
const listeners = new Set<Listener>();
export const onApiError = (f: Listener) => { listeners.add(f); return () => listeners.delete(f); };

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? (init.json !== undefined ? 'POST' : 'GET')).toUpperCase();
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET' && csrfToken) headers.set('x-csrf-token', csrfToken);
  if (workspaceId) headers.set('x-workspace-id', workspaceId);
  const res = await fetch(`/api/v1${path}`, { ...init, method, headers, credentials: 'same-origin', body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const err = new ApiError(res.status, body && body.code ? body : { code: 'http_' + res.status, message: res.status === 502 || res.status === 503 ? 'سرور در دسترس نیست؛ چند لحظه بعد دوباره تلاش کنید.' : 'خطای ارتباط با سرور.', requestId: res.headers.get('x-request-id') ?? '', retryable: res.status >= 500 });
    listeners.forEach(l => l(err));
    throw err;
  }
  return body as T;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export function download(path: string) {
  // Downloads go through a normal navigation so the browser keeps the server's Content-Disposition.
  const a = document.createElement('a');
  a.href = `/api/v1${path}${path.includes('?') ? '&' : '?'}ws=${encodeURIComponent(workspaceId)}`;
  a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
