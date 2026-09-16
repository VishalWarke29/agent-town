import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'], testTimeout: 10000, coverage: {
  provider: 'v8', reporter: ['text', 'html'],
  include: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx', 'apps/service/src/**/*.ts'],
  exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts', '**/node_modules/**', '**/dist/**'],
} } });
