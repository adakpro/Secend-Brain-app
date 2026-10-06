// Exploratory pass: logs in, visits every route, records console errors, page errors and screenshots.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const OUT = process.env.OUT ?? 'evidence/screens';
const EMAIL = process.env.E2E_EMAIL, PASS = process.env.E2E_PASSWORD;
const routes = ['/home', '/inbox', '/library', '/ask', '/projects', '/review', '/graph', '/studio', '/learn', '/activity', '/settings', '/settings/integrations/claude', '/admin/users', '/admin/backups', '/admin/audit'];
const vp = process.env.VP === 'mobile' ? { width: 390, height: 844 } : { width: 1536, height: 1051 };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: vp, locale: 'fa-IR', colorScheme: process.env.SCHEME ?? 'light', reducedMotion: 'reduce' });
const page = await ctx.newPage();
const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push({ url: page.url(), console: m.text().slice(0, 300) }); });
page.on('pageerror', e => problems.push({ url: page.url(), pageerror: String(e).slice(0, 300) }));
await page.goto(BASE + '/login');
await page.fill('#email', EMAIL); await page.fill('#password', PASS);
await page.click('button.btn.primary');
await page.waitForURL(/\/home/, { timeout: 15000 });
const tag = `${process.env.VP ?? 'desktop'}-${process.env.SCHEME ?? 'light'}`;
for (const r of routes) {
  await page.goto(BASE + r); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) problems.push({ url: r, horizontalOverflow: overflow });
  await page.screenshot({ path: `${OUT}/${tag}${r.replace(/\//g, '_')}.png`, fullPage: false });
}
console.log(JSON.stringify({ tag, problems }, null, 1));
await browser.close();
