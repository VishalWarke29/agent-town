/**
 * H0-16 (plan v5, decision D38 / DR-051): connecting a project is one saved record and nothing else.
 *
 * The complaint that came back was "I only connected a folder and Agent Town read my sessions". No test pinned the
 * opposite, and the old tests pinned the old behaviour. This file is that permanent test, at the service boundary: it runs
 * the real service in this process (createApp, real stores, real folder checks) with the FD-06 helpers armed and drives
 * POST projects/local, the route behind "Use as local project". The browser side (no tool check, no health poll, nothing
 * requested when a house or the inspector opens) is tests/browser/houses-first.spec.ts.
 *
 * What "nothing else" means here, each part with its own tripwire:
 *   - no session read           sessionReadSpy(): discoverNativeSessions (the MAIN door to a tool's saved sessions) is never called.
 *                               The other door, detectedTools() -> codexVersion(), is closed by isolatedProfile(): tool profile
 *                               variables point at an empty folder and any touch of the real ~/.codex, ~/.claude, ~/.cursor
 *                               or ~/.copilot is refused and reported (see the header of tests/helpers/session-read-spy.ts).
 *   - no tracking set up        no connection or native source is saved, and neither hook writer (changeHooks,
 *                               writeBridgeConfig, writeServiceCapabilities) is called.
 *   - no file written           the project folder is byte-for-byte what it was (no .claude, .codex, .cursor or .github folder,
 *                               no .git), and Agent Town's own observation folder gains no file.
 *   - no tool started           spawnSpy(): nothing is launched at all by this request. Git is the one program the service may run
 *                               (read-only, for folder scans); it is the only executable spawnSpy lets through, and this request
 *                               is expected to run none.
 *   - no model call             modelSpy() stays at 0 (paid work is off, and connecting a project is not a manager action).
 *   - no outside request        noNetwork() records nothing (loopback only).
 *
 * Background reads that are ALLOWED and are named so a reader does not mistake them for this request: after a project is
 * saved the service watches the folder and re-checks folder names and, for a Git project, Git status on a timer and when
 * files change (repository-api.ts, refreshWatchers and the 60 second reconciliation). Those are folder and Git reads,
 * never session reads. The scan test below runs one on purpose and shows it still reads no session.
 *
 * Limits (the ones in tests/helpers/index.ts): these spies see this test process. They do not see a child process's own
 * behaviour, and git.ts keeps a promisified copy of execFile made at import time, which spawnSpy cannot see, so a Git launch
 * from a scan is not visible to it (a launch of any other program from that module would not be either). Real-tool proof
 * that connecting reads no session on a real machine is H0-21's and the owner's Network-tab check, not this file's.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '@agent-town/contracts';
import { isolatedProfile, modelSpy, noNetwork, sessionReadSpy, spawnSpy, type IsolatedProfile, type ModelSpy, type NoNetwork, type SessionReadSpy, type SpawnSpy } from '../helpers';
import { createApp } from '../../apps/service/src/app';
import * as hookSetup from '../../apps/service/src/observation/setup';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';

const origin = 'http://127.0.0.1:4310';
const host = { host: '127.0.0.1:4310' };
type Session = { cookie: string; csrf: string };

let directory: string, instance: Awaited<ReturnType<typeof createApp>>, now: number;
let profile: IsolatedProfile, models: ModelSpy;
// Armed only after the app is booted and signed in, so they judge the connect request and what it sets going, not start-up.
let sessions: SessionReadSpy, spawns: SpawnSpy, network: NoNetwork;
/** The three functions that write tracking into a project folder or Agent Town's own observation folder (observation/setup.ts). */
const armHookSpies = () => ({ changeHooks: vi.spyOn(hookSetup, 'changeHooks'), writeBridgeConfig: vi.spyOn(hookSetup, 'writeBridgeConfig'), writeServiceCapabilities: vi.spyOn(hookSetup, 'writeServiceCapabilities') });
let hookWrites: ReturnType<typeof armHookSpies>;

beforeEach(async () => {
  profile = isolatedProfile(); // first: tool profile variables point at an empty folder and the real ones are refused
  models = modelSpy();
  directory = mkdtempSync(join(tmpdir(), 'agent-town-connect-no-scan-'));
  now = Date.now();
  const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { secrets.set(key, value); }, get: async key => secrets.get(key) ?? null, delete: async key => { secrets.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: 'fixture-secret-701', expiresIn: 3600 }),
    verifyUser: async () => ({ id: '701', login: 'connect-fixture-owner', displayName: 'Connect Fixture Owner', avatarUrl: null }),
    listRepositories: async () => { throw new Error('Connecting a project must not list GitHub repositories.'); },
  };
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'Iv1.connectNoScanFixture', now: () => now });
  instance = await createApp({ database: ':memory:', privateDirectory: join(directory, 'private'), identity, vault, workflowProvider: models.provider, simulationInterval: 600000 });
});
/** Puts every real function back. Restore in the reverse order the spies were made. */
function disarm() {
  network?.restore(); spawns?.restore(); sessions?.restore();
  vi.restoreAllMocks();
}
afterEach(async () => {
  disarm();
  await instance.app.close();
  profile.restore(); // throws if the flow reached the real tool folders and nobody looked
  const target = resolve(directory);
  if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('agent-town-connect-no-scan-')) rmSync(target, { recursive: true, force: true });
});

const headers = (session: Session) => ({ ...host, origin, cookie: session.cookie, 'x-csrf-token': session.csrf });
async function signIn(): Promise<Session> {
  const first = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...host, origin } });
  const anonymous: Session = { cookie: first.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), csrf: first.json().csrf };
  const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: headers(anonymous) });
  expect(start.statusCode).toBe(200); now += 6000;
  const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', headers: headers(anonymous), payload: { flowId: start.json().flowId } });
  expect(poll.statusCode).toBe(200);
  return { cookie: poll.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), csrf: poll.json().session.csrf };
}

/** Every file and folder under a folder, relative and sorted, so a before/after comparison shows exactly what appeared. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (folder: string) => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); found.push(relative(root, path)); if (entry.isDirectory()) walk(path); } };
  walk(root);
  return found.sort();
}

async function setUp(kind: 'plain' | 'git') {
  const session = await signIn();
  const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: headers(session), payload: { name: 'Connect workshop', kind: 'personal' } });
  expect(created.statusCode).toBe(200);
  const base = `/api/v1/workspaces/${created.json().workspace.id}`;
  const project = join(directory, 'projects', 'Plain project café');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'notes.txt'), 'A plain project fixture. Connecting must leave this folder exactly as it is.\n');
  // A folder that merely has a .git marker is a Git project to the connect route, which only looks for the marker: no Git program is needed to prove it.
  if (kind === 'git') mkdirSync(join(project, '.git'));
  expect((await instance.app.inject({ method: 'POST', url: `${base}/roots`, headers: headers(session), payload: { path: project } })).statusCode).toBe(200);
  const snapshot = async (): Promise<Snapshot> => (await instance.app.inject({ url: `${base}/snapshot`, headers: headers(session) })).json();
  const connect = () => instance.app.inject({ method: 'POST', url: `${base}/projects/local`, headers: headers(session), payload: { path: project } });
  const observationFolder = join(directory, 'private', 'observation');
  return { session, base, project, snapshot, connect, observationFolder };
}

/** Arms the tripwires, runs the step, lets fire-and-forget follow-ups run, and reports everything they saw. */
async function watchStep<T>(step: () => Promise<T>) {
  disarm(); // a test may watch more than one step; each starts from a clean count
  sessions = sessionReadSpy();
  spawns = spawnSpy(); // git only; anything else is refused and still recorded
  network = noNetwork();
  hookWrites = armHookSpies();
  models.reset();
  const result = await step();
  await new Promise(resolve => setTimeout(resolve, 300)); // watchers and follow-up reads start after the response
  return result;
}
function expectNothingElseHappened() {
  // Each check names what it saw, so a failure reads as "connecting read a claude session", not "expected 1 to be 0".
  expect(sessions.reads.map(read => `${read.provider} session read for ${read.repoPath}`), 'connecting must read no saved session (discoverNativeSessions)').toEqual([]);
  expect(spawns.launches.map(launch => `${launch.executables.join(' + ')} (${launch.via})`), 'connecting must start no program, tool or helper').toEqual([]);
  expect(network.attempts.map(attempt => `${attempt.host} (${attempt.via})`), 'connecting must make no outside network request').toEqual([]);
  expect(models.calls.map(call => call.method), 'connecting must make no model call').toEqual([]);
  expect({ changeHooks: hookWrites.changeHooks.mock.calls.length, writeBridgeConfig: hookWrites.writeBridgeConfig.mock.calls.length, writeServiceCapabilities: hookWrites.writeServiceCapabilities.mock.calls.length }, 'connecting must set up no tracking (no hook file, bridge config or capability file)').toEqual({ changeHooks: 0, writeBridgeConfig: 0, writeServiceCapabilities: 0 });
  profile.expectNoRealAccess();
}

describe('POST projects/local: connecting a project', () => {
  it('saves the project and nothing else: no session read, no tracking, no file, no tool, no model call, no outside request', async () => {
    const fixture = await setUp('plain');
    const filesBefore = tree(fixture.project), observationBefore = tree(fixture.observationFolder);
    const response = await watchStep(fixture.connect);
    expect(response.statusCode).toBe(200);
    const saved = response.json();
    expect(saved).toMatchObject({ duplicate: false, repository: { source: 'local', projectKind: 'folder', name: 'Plain project café' } });
    expectNothingElseHappened();

    // What was saved: the project. What was not: a connection, a source, a character, an event.
    const after = await fixture.snapshot();
    expect(after.state.repositories.map(repo => repo.id)).toEqual([saved.repository.id]);
    expect(after.state.observation?.connections ?? []).toEqual([]);
    expect(after.state.agents).toEqual([]);
    expect(after.state.activity).toEqual([]);
    expect(after.state.handoffs).toEqual([]);
    expect(after.state.workflow?.policy.paidEnabled).toBe(false);
    // Nothing was written into the project (a hook file would be .claude/settings.local.json, .codex/hooks.json, .cursor/hooks.json or .github/hooks/agent-town.json) or into Agent Town's observation folder.
    expect(tree(fixture.project)).toEqual(filesBefore);
    expect(filesBefore).toEqual(['notes.txt']);
    expect(tree(fixture.observationFolder)).toEqual(observationBefore);
  });

  it('a Git project is saved the same way: only its .git marker is looked at, and connecting it again saves no second project', async () => {
    const fixture = await setUp('git');
    const filesBefore = tree(fixture.project);
    const first = await watchStep(fixture.connect);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ duplicate: false, repository: { projectKind: 'git', git: { availability: 'unavailable', head: null, changedFiles: null } } });
    expectNothingElseHappened();
    const again = await watchStep(fixture.connect);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, repository: { id: first.json().repository.id } });
    expectNothingElseHappened();
    const after = await fixture.snapshot();
    expect(after.state.repositories).toHaveLength(1);
    expect(after.state.observation?.connections ?? []).toEqual([]);
    expect(tree(fixture.project)).toEqual(filesBefore);
  });

  it('the folder scan that may follow reads folder names and Git status only: it is allowed, and it reads no session either', async () => {
    const fixture = await setUp('plain');
    await fixture.connect();
    const started = await watchStep(() => instance.app.inject({ method: 'POST', url: `${fixture.base}/scans`, headers: headers(fixture.session) }));
    expect(started.statusCode).toBe(202);
    // A scan of a plain folder starts at most git (read-only); that is the one program spawnSpy lets through, so a launch of anything else is refused and recorded.
    await expect.poll(async () => (await instance.app.inject({ url: `${fixture.base}/scans/${started.json().operationId}`, headers: headers(fixture.session) })).json().operation.status, { timeout: 15000 }).not.toBe('running');
    expectNothingElseHappened();
    expect((await fixture.snapshot()).state.observation?.connections ?? []).toEqual([]);
  });
});
