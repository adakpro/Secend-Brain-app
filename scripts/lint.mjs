// Project-specific static checks (not a general style linter). Fails on security-relevant patterns.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'evidence', 'vendor', 'secrets', 'backups', 'test-results', 'playwright-report']);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js|yaml|yml|sh|md|json|conf)$/.test(e.name) && !e.name.endsWith('lock.yaml') && e.name !== 'package-lock.json') files.push(p);
  }
})(ROOT);

const rules = [
  { id: 'no-real-keys', re: /sk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{20,}/, msg: 'looks like a real Anthropic key' },
  { id: 'no-bypass-permissions', re: /bypassPermissions|dangerously-skip-permissions|allowDangerouslySkipPermissions/, msg: 'permission bypass is not allowed', allow: [/docs\//, /lint\.mjs$/, /THREAT|README/] },
  { id: 'no-unsanitized-html', re: /dangerouslySetInnerHTML/, msg: 'only the sanitized Markdown renderer may set HTML', allow: [/components\/content\.tsx$/, /lint\.mjs$/] },
  { id: 'no-eval', re: /\beval\(|new Function\(/, msg: 'no dynamic code execution', allow: [/lint\.mjs$/] },
  { id: 'no-token-in-localstorage', re: /localStorage\.setItem\([^)]*(token|csrf|session|key)/i, msg: 'auth material must not go to localStorage' },
  { id: 'no-docker-sock', re: /docker\.sock/, msg: 'docker.sock must not be mounted', allow: [/docs\//, /lint\.mjs$/, /README|THREAT/, /\.sh$/] },
  { id: 'no-privileged', re: /privileged:\s*true/, msg: 'privileged containers are not allowed' },
  { id: 'no-latest-tag', re: /image:\s*\S+:latest\b|FROM\s+\S+:latest\b/, msg: 'pin image versions', allow: [/lint\.mjs$/] },
  { id: 'no-console-log-server', re: /console\.log\(/, msg: 'use the structured logger', only: [/apps\/(api|worker|agent-runner)\/src\/(?!cli\.ts)/, /packages\/core\/src\//] },
];

let failures = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const text = fs.readFileSync(f, 'utf8');
  for (const r of rules) {
    if (r.only && !r.only.some(x => x.test(rel))) continue;
    if (r.allow && r.allow.some(x => x.test(rel))) continue;
    const lines = text.split('\n');
    lines.forEach((l, i) => { if (r.re.test(l)) { failures++; console.log(`${rel}:${i + 1}  [${r.id}] ${r.msg}`); } });
  }
}
console.log(`lint: ${files.length} files checked, ${failures} problem(s)`);
process.exit(failures ? 1 : 0);
