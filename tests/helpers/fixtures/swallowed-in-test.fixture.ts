import { describe, expect, it } from 'vitest';
import { noNetwork } from '../no-network';

// Fixture for tests/unit/test-helpers.test.ts (run in a child vitest process, never by `npm test`; see guard-fixture.vitest.config.ts).
// The names begin with the outcome the parent expects: SWALLOWED must fail, everything else must pass.
describe('file-wide network guard fixture', () => {
  it('SWALLOWED: calls an outside URL and swallows the error, as production code often does', async () => {
    await fetch('https://swallowed-in-test.invalid/some/secret/path').catch(() => undefined);
  });

  it('CLEAN AFTER: a later test in the same file is not failed by the earlier swallowed call', () => {
    expect(1 + 1).toBe(2);
  });

  it('TAKEN: expects its refusal, takes it, and passes', async () => {
    const guard = noNetwork();
    try {
      await fetch('https://taken.invalid/').catch(() => undefined);
      expect(guard.take()).toHaveLength(1);
    } finally { guard.restore(); }
  });

  it('SWALLOWED TWICE: two swallowed calls in one test are both named', async () => {
    await fetch('https://first-of-two.invalid/').catch(() => undefined);
    await fetch('https://second-of-two.invalid:8443/').catch(() => undefined);
  });

  it('CLEAN LAST: passes', () => {
    expect(true).toBe(true);
  });
});
