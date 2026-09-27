import { afterAll, describe, expect, it } from 'vitest';

// Fixture for tests/unit/test-helpers.test.ts (child vitest process only; see guard-fixture.vitest.config.ts). Every test here is
// clean. The call that must be caught happens in an afterAll, that is outside any test, so only the file-wide afterAll hook in
// tests/helpers/setup.ts can see it: the file must be reported as failed, naming the host.
describe('file-wide network guard fixture, after the last test', () => {
  it('CLEAN: passes', () => {
    expect(true).toBe(true);
  });

  afterAll(async () => {
    await fetch('https://swallowed-after-last-test.invalid/').catch(() => undefined);
  });
});
