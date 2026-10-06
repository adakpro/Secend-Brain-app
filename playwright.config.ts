import { defineConfig } from '@playwright/test';
// E2E runs against a live stack. BASE_URL defaults to the Docker test stack (compose.test.yaml).
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'evidence/e2e/results.json' }]],
  use: { baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:8081', locale: 'fa-IR', reducedMotion: 'reduce', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  outputDir: 'evidence/e2e/artifacts',
  projects: [
    { name: 'desktop', use: { viewport: { width: 1536, height: 1051 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, grep: /@mobile/ },
  ],
});
