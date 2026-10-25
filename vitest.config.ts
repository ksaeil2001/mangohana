import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/domain/**/*.test.ts', 'tests/postgres/**/*.test.ts', 'tests/protocol/**/*.test.ts'],
  fileParallelism: false, testTimeout: 20000, hookTimeout: 30000, reporters: ['default'] } });
