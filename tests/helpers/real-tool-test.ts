/**
 * realToolTest(): a test that needs something real (an installed tool, a real window, a real credential store). Unless it is
 * switched on with an environment variable it is SKIPPED WITH A WRITTEN REASON that the test report shows, never silently
 * dropped, and the default `npm test` stays free of real tools, real windows and outbound traffic.
 *
 *   realToolTest('reads the real Codex profile', { enabledBy: 'AGENT_TOWN_REAL_CODEX', needs: 'Codex installed and signed in' }, async () => { ... });
 *
 * A skipped run says: "Skipped: needs Codex installed and signed in. Set AGENT_TOWN_REAL_CODEX=1 to run it." Because the
 * skip is decided when the test runs, the reason travels with the result (vitest's skip note) instead of living in a comment.
 * A test switched on this way runs against the real machine: it is outside noNetwork()'s and isolatedProfile()'s promises,
 * and it is the kind of proof (CH-21, H0-21) that the in-process helpers cannot replace. Limits are the ones in ./index.ts.
 *
 * Three companions keep every other skip from being bare too:
 *   realToolSuite(gate)      call it first thing inside a describe block: every test in the block gets the same written skip.
 *   platformTest(...)        a test that only makes sense on one operating system (or not on one): skipped with the reason
 *                            elsewhere, e.g. "Skipped: needs the Windows folder window. It runs only on win32 (this is linux)."
 *   platformSuite(gate)      the describe-block form of platformTest.
 * Use them instead of it.skipIf(...) / describe.skipIf(...), which the report shows as a skip with no words.
 */
import { beforeEach, it, type TestContext } from 'vitest';

export interface RealToolGate {
  /** Environment variable that must be '1' for the test to run. */
  enabledBy: string;
  /** What the test needs, in plain words: it is written into the skip reason. */
  needs: string;
  /** Restrict to one platform; on any other the test is skipped with that reason. */
  platform?: NodeJS.Platform;
}

export interface PlatformGate {
  /** Run only on this platform. */
  only?: NodeJS.Platform;
  /** Do not run on this platform. */
  not?: NodeJS.Platform;
  /** Why the test is tied to the platform, in plain words: it is written into the skip reason. */
  why: string;
}

/** The written reason a gated test is skipped for, or null when it should run. */
export function realToolSkipReason(gate: RealToolGate, environment: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (gate.platform && platform !== gate.platform) return `Skipped: needs ${gate.needs}, which is only available on ${gate.platform} (this is ${platform}).`;
  if (environment[gate.enabledBy] !== '1') return `Skipped: needs ${gate.needs}. Set ${gate.enabledBy}=1 to run it.`;
  return null;
}

/** The written reason a platform-specific test is skipped for, or null when it should run here. */
export function platformSkipReason(gate: PlatformGate, platform: NodeJS.Platform = process.platform): string | null {
  if (gate.only && platform !== gate.only) return `Skipped: ${gate.why}. It runs only on ${gate.only} (this is ${platform}).`;
  if (gate.not && platform === gate.not) return `Skipped: ${gate.why}. It does not run on ${gate.not} (this is ${platform}).`;
  return null;
}

export function realToolTest(name: string, gate: RealToolGate, run: (context: TestContext) => unknown, timeout?: number): void {
  it(name, { timeout: timeout ?? 60_000 }, async context => {
    const reason = realToolSkipReason(gate);
    if (reason) context.skip(reason);
    await run(context);
  });
}

/** Inside a describe block: skips every test in it, with the written reason, unless the real tool is switched on. */
export function realToolSuite(gate: RealToolGate): void {
  beforeEach(context => {
    const reason = realToolSkipReason(gate);
    if (reason) context.skip(reason);
  });
}

/** Like it(), but skipped with a written reason on the wrong platform. Without `timeout` the test keeps the suite's or the config's limit. */
export function platformTest(name: string, gate: PlatformGate, run: (context: TestContext) => unknown, timeout?: number): void {
  const body = async (context: TestContext) => {
    const reason = platformSkipReason(gate);
    if (reason) context.skip(reason);
    await run(context);
  };
  if (timeout === undefined) it(name, body); else it(name, { timeout }, body);
}

/** Inside a describe block: skips every test in it, with the written reason, on the wrong platform. */
export function platformSuite(gate: PlatformGate): void {
  beforeEach(context => {
    const reason = platformSkipReason(gate);
    if (reason) context.skip(reason);
  });
}
