import { defineConfig } from 'vitest/config';

// tests/helpers/setup.ts (FD-06) refuses outbound network access to anything but loopback in every unit test file, and fails a test that attempted it even if the code caught the error.
// testTimeout and hookTimeout are 30 seconds, not vitest's 10 (MG-40 follow-up, 2026-09-24): several suites run real git, real subprocesses and real SQLite, and on a busy machine (other agents, other
// test runs) their fixtures alone passed 10 seconds while every assertion was right. Only the time a test may take is raised; no assertion, fixture size or polling condition is loosened, and a test
// that genuinely hangs still fails, after 30 seconds instead of 10. A test that needs more than that says so itself with an explicit { timeout }.
export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'], setupFiles: ['tests/helpers/setup.ts'], testTimeout: 30000, hookTimeout: 30000, coverage: {
  provider: 'v8', reporter: ['text', 'html'],
  include: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx', 'apps/service/src/**/*.ts'],
  exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts', '**/node_modules/**', '**/dist/**'],
} } });
