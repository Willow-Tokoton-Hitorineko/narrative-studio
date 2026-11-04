import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@narrative-studio/contracts': resolve('./packages/contracts/src/index.ts'),
      '@narrative-studio/core': resolve('./packages/core/src/index.ts'),
      '@narrative-studio/projection': resolve('./packages/projection/src/index.ts'),
      '@narrative-studio/jobs': resolve('./packages/jobs/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['verbose'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    env: {
      NS_LOG_LEVEL: 'silent',
    },
  },
});
