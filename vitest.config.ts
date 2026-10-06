import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['packages/*/test/unit/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'bench', include: ['packages/*/test/bench/**/*.test.ts'], environment: 'node', testTimeout: 600000, hookTimeout: 120000 } },
      { test: { name: 'integration', include: ['packages/*/test/integration/**/*.test.ts', 'apps/*/test/integration/**/*.test.ts'], environment: 'node', fileParallelism: false, testTimeout: 60000, hookTimeout: 120000 } },
    ],
  },
});
