import { describe, expect, it } from 'vitest';
import { platformSuite, platformTest, realToolSuite, realToolTest } from '../real-tool-test';

// Fixture for tests/unit/test-helpers.test.ts (child vitest process only; see guard-fixture.vitest.config.ts). Nothing here may run:
// each block is gated on something that is not true, so the report must show every one as skipped WITH its written reason.
// The environment variable below is never set, and the platform below is never the one that runs this.
const NEVER_SET = 'AGENT_TOWN_FIXTURE_NEVER_SET';
const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';

describe('written skip reasons fixture', () => {
  realToolTest('REAL TOOL TEST needs a tool nobody switched on', { enabledBy: NEVER_SET, needs: 'a real fixture tool' }, () => { expect.unreachable('a gated real-tool test must not run'); });
  platformTest('PLATFORM TEST for another operating system', { only: otherPlatform, why: 'needs the fixture window system' }, () => { expect.unreachable('a wrong-platform test must not run'); });
  platformTest('PLATFORM TEST that runs here', { not: otherPlatform, why: 'not for the fixture platform' }, () => { expect(true).toBe(true); });

  describe('REAL TOOL SUITE', () => {
    realToolSuite({ enabledBy: NEVER_SET, needs: 'a real fixture window', platform: process.platform });
    it('first test in the gated suite', () => { expect.unreachable('a gated suite must not run'); });
    it('second test in the gated suite', () => { expect.unreachable('a gated suite must not run'); });
  });

  describe('PLATFORM SUITE', () => {
    platformSuite({ only: otherPlatform, why: 'fixture suite for another platform' });
    it('test in the platform suite', () => { expect.unreachable('a wrong-platform suite must not run'); });
  });
});
