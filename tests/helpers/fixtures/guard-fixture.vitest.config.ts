import { defineConfig } from 'vitest/config';
import repoConfig from '../../../vitest.config.ts';

// Used only by tests/unit/test-helpers.test.ts, which starts a child vitest process with this config to prove that the file-wide
// helpers really fail and skip the way they say. It is the repository's own config (same setupFiles, so the same network guard
// from tests/helpers/setup.ts, same timeouts) with one change: it collects the fixture specs in this folder instead of
// tests/unit. The fixtures are named *.fixture.ts so that a plain `npm test` never runs them: several of them fail on purpose.
export default defineConfig({
  test: {
    ...repoConfig.test,
    include: ['tests/helpers/fixtures/*.fixture.ts'],
    coverage: { enabled: false },
  },
});
