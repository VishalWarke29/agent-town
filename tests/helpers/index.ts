/**
 * Shared unit-test helpers (FD-06). They exist so that "connecting, scanning or assigning reads nothing, starts no tool and
 * calls no model" is checked by something that fails when it stops being true, instead of every spec inventing its own spy.
 *
 *   noNetwork()        refuses connections to anything but loopback and records the attempts (a file-wide copy runs from setup.ts)
 *   modelSpy()         a counting WorkflowProvider; it must stay 0 for any flow that is not a paid manager action
 *   spawnSpy()         records process launches by executable; git is allowed, tool launchers are not
 *   sessionReadSpy()   counts discoverNativeSessions calls, the MAIN door to another tool's saved sessions (not the only one:
 *                      detectedTools() -> codexVersion() opens Codex's state_5.sqlite for a version string; pair the spy with
 *                      isolatedProfile(), see session-read-spy.ts)
 *   secretCanary()     a fake secret to plant, then prove it never reaches model input, state, logs, files or arguments
 *   isolatedProfile()  points HOME, USERPROFILE, APPDATA, CODEX_HOME, CLAUDE_CONFIG_DIR and friends at a temp folder and
 *                      refuses every path-taking node:fs call on the real tool folders, Agent Town's real data and its real
 *                      vault (the list of calls covered, and of those not covered, is in isolated-profile.ts)
 *   runShutdown()      runs a job's close step through the service's own createShutdown on a fake clock at the real limits
 *   realToolTest()     a test that needs a real tool or window: skipped with a written reason unless it is switched on
 *                      (realToolSuite() does the same for a describe block; platformTest()/platformSuite() give an
 *                      operating-system-only test its written reason, so no skip in the report is bare)
 *
 * HONEST LIMIT (repeated in each helper): these see THIS test process only. They do not see worker threads, child processes
 * (a tool the test launches can use the network, read profiles and call models on its own) or the e2e service that Playwright
 * starts, and a fake clock does not prove a real process exits in time. Proof against a real tool, real window or real
 * process (CH-21, H0-21, MG-14, SK-17) still stands and is not replaced by these helpers. The browser-side request guard is
 * UX-07's; H0-16 and later specs use both.
 *
 * Opt in from a test file:
 *
 *   import { modelSpy, spawnSpy } from '../helpers';
 *   const spy = spawnSpy();            // in beforeEach
 *   afterEach(() => spy.restore());
 *
 * Only the network guard is on for every file (vitest.config.ts setupFiles -> ./setup.ts). Importing the barrel is cheap, but
 * a test that needs one helper can import that file directly.
 */
export { noNetwork, assertNoRefused, activeNetworkGuards, isLoopbackHost, connectTarget, requestTarget, NetworkBlockedError, type NoNetwork, type NetworkAttempt } from './no-network';
export { modelSpy, ModelCallBlockedError, type ModelSpy, type ModelCall, type ModelMethod, type ModelSpyResponses } from './model-spy';
export { spawnSpy, executableName, commandLineExecutables, SpawnBlockedError, type SpawnSpy, type Launch, type LaunchVia } from './spawn-spy';
export { sessionReadSpy, type SessionReadSpy, type SessionRead } from './session-read-spy';
export { secretCanary, type SecretCanary, type CanaryHit, type CanaryKind } from './secret-canary';
export { isolatedProfile, RealProfileAccessError, GUARDED_FS_EXPORTS, UNGUARDED_FS_EXPORTS, type IsolatedProfile, type IsolatedProfileOptions, type RealProfileAccess } from './isolated-profile';
export { runShutdown, stepsJob, SHUTDOWN_LIMITS_MS, type ShutdownRun, type ShutdownReport, type ShutdownJobContext, type ShutdownStep, type ShutdownSignal, type ShutdownOutcome, type StepsJobMode } from './shutdown-deadline';
export { realToolTest, realToolSuite, realToolSkipReason, platformTest, platformSuite, platformSkipReason, type RealToolGate, type PlatformGate } from './real-tool-test';
