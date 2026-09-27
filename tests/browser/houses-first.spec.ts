import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BrowserSession, ObservationConnection, Repository, Snapshot, ToolDetectionStatus } from '@agent-town/contracts';
import { createApp } from '../../apps/service/src/app';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';
// FD-06 helpers, imported one by one: the barrel also loads the vitest-only ones, which Playwright cannot import.
import { isolatedProfile } from '../helpers/isolated-profile';
import { modelSpy } from '../helpers/model-spy';
import { noNetwork } from '../helpers/no-network';
import { spawnSpy } from '../helpers/spawn-spy';

/**
 * H0-16 (plan v5, decision D38 / DR-051): connecting a project, opening its house and opening the inspector read no
 * session, set up no tracking and start no tool. The complaint came back because no test pinned "connecting does not scan",
 * and the old tests pinned the opposite. Every test here records EVERY /api/v1 request the browser makes and fails, printing
 * the whole call log, when one of these appears where it must not:
 *
 *   tool-detection, native-setup, native-sessions, native-sources     (a tool check or a session read: the session inventory)
 *   observation/connections                                           (tracking being set up, read or changed)
 *   telemetry inventory/scan                                          (a source API scan)
 *   /health                                                           (the restart-notice poll: only for a project that has a connection)
 *
 * Journeys (H0-16 a, b, c, e; H0-02 adds the last one):
 *   1  the REAL service, in this process: connect a first project, wait 1.5 s, then open the house from the world and from
 *      the List view. Only roots, scans and projects/local may be written. The service side is watched too, with the FD-06
 *      helpers: no program started, no model call, no outside request, no real tool profile touched, the project folder unchanged.
 *   2  a 60 second fake clock with the inspector open: /health is never asked for a house without a connection and at most
 *      once per 30 seconds for one with a connection, even while live updates re-render the whole app.
 *   3  expanding the tracking section sends nothing; only "Check this computer" starts one check.
 *   4  opening Connections asks for no native setup. EXPECTED TO FAIL until H0-09 stops mounting the manual form on open.
 *
 * Fixtures point every tool profile variable at nothing (isolatedProfile) or answer from mocks, so no journey depends on the
 * machine that runs it. The service the Playwright config starts on port 4311 serves only the web app here; every API call
 * is answered by the in-process service or by a mock. The browser-side request guard is UX-07's, which ports this spec later.
 *
 * Limit: these see the browser's requests and this test process. A real tool, a real profile and the owner's Network-tab
 * check (H0-02 "Real Chrome") are separate proof.
 */

interface Call { method: string; path: string; query: string }
const workspaceIdMock = 'houses-first';
const mockPrefix = `/api/v1/workspaces/${workspaceIdMock}`;
const mockRepoPath = String.raw`C:\synthetic-houses-first\project`;

const label = (call: Call) => `${call.method} ${call.path.replace(/^\/api\/v1\//, '')}${call.query}`;
const printLog = (calls: readonly Call[], from = 0) => calls.length ? calls.map((call, index) => `${index >= from ? '>>' : '  '} ${String(index + 1).padStart(2)}. ${label(call)}`).join('\n') : '(no request was recorded)';
const isSessionOrSnapshot = (call: Call) => call.path === '/api/v1/session' || call.path.endsWith('/snapshot');
// Everything under /observation (tool-detection, native-setup, native-sessions, native-sources, connections) is a tool check, a session read or tracking; the source API scan is a scan too.
const isToolRead = (call: Call) => /\/observation(\/|$)|\/inventory\/scan$/.test(call.path);
const isHealth = (call: Call) => call.path === '/api/v1/health';
const isForbidden = (call: Call, health: boolean) => isToolRead(call) || (health && isHealth(call));

/** Soft, so a red run shows every stage that broke the rule, and prints the whole log with the stage's own requests marked. */
function expectNoToolReads(calls: readonly Call[], from: number, when: string, { health = true } = {}) {
  const found = calls.slice(from).filter(call => isForbidden(call, health));
  expect.soft(found.map(label), `${when}: expected no tool check, native setup, session, source, connection or ${health ? 'health ' : ''}request.\nCall log (>> marks this stage):\n${printLog(calls, from)}`).toEqual([]);
}

async function attachLog(testInfo: TestInfo, calls: readonly Call[]) {
  await testInfo.attach('call-log.txt', { body: printLog(calls), contentType: 'text/plain' });
}

const flush = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

// ---------------------------------------------------------------------------------------------------------------------
// 1. The real service.
// ---------------------------------------------------------------------------------------------------------------------

async function realTown(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-houses-first-'));
  const projectName = 'Houses first café';
  const projectPath = join(directory, projectName);
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'notes.txt'), 'A plain project fixture. Connecting must leave this folder exactly as it is.\n');
  const profile = isolatedProfile(); // tool profile variables point at an empty folder; the real ~/.codex, ~/.claude, ~/.cursor and ~/.copilot are refused and reported
  const models = modelSpy();
  let now = Date.now(), githubListings = 0;
  const calls: Call[] = [], remote: string[] = [], pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { secrets.set(key, value); }, get: async key => secrets.get(key) ?? null, delete: async key => { secrets.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: 'fixture-test-credential', expiresIn: 3600 }),
    verifyUser: async () => ({ id: '703', login: 'houses-first-owner', displayName: 'Houses First Owner', avatarUrl: null }),
    listRepositories: async () => { githubListings++; return { repositories: [], truncated: false, checkedAt: new Date(now).toISOString() }; },
  };
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'Iv1.housesFirstFixture', now: () => now });
  const instance = await createApp({ port: 4311, database: ':memory:', privateDirectory: join(directory, 'private'), identity, vault, workflowProvider: models.provider });
  const baseHeaders = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
  const initial = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: baseHeaders });
  let cookie = initial.cookies.map(item => `${item.name}=${item.value}`).join('; ');
  const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
  now += 6000;
  const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', payload: { flowId: start.json().flowId }, headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
  cookie = poll.cookies.map(item => `${item.name}=${item.value}`).join('; ');
  const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'Houses first workspace', kind: 'personal' }, headers: { ...baseHeaders, cookie, 'x-csrf-token': poll.json().session.csrf } });
  const workspaceId: string = created.json().workspace.id;
  const prefix = `/api/v1/workspaces/${workspaceId}`;
  const snapshot = async (): Promise<Snapshot> => (await instance.app.inject({ url: `${prefix}/snapshot`, headers: { ...baseHeaders, cookie } })).json();
  await page.exposeFunction('readHousesFirstSnapshot', snapshot);
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    const readSnapshot = (window as unknown as { readHousesFirstSnapshot(): Promise<{ cursor: number; state: { workspace: { id: string } } }> }).readHousesFirstSnapshot;
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      cursor = -1;
      timer?: ReturnType<typeof setTimeout>;
      constructor(readonly url: string) {
        super();
        this.timer = setTimeout(() => { if (!this.closed) { this.onopen?.(); void this.read(); } }, 0);
      }
      async read() {
        try {
          const saved = await readSnapshot();
          if (!this.closed && this.url.includes(`/workspaces/${saved.state.workspace.id}/`) && saved.cursor !== this.cursor) {
            this.cursor = saved.cursor;
            this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(saved) }));
          }
        } finally { if (!this.closed) this.timer = setTimeout(() => void this.read(), 100); }
      }
      close() { this.closed = true; clearTimeout(this.timer); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== baseHeaders.origin) { remote.push(url.origin); await route.abort(); return; }
    if (!url.pathname.startsWith('/api/v1/')) { await route.continue(); return; }
    calls.push({ method: request.method(), path: url.pathname, query: url.search });
    const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: `${url.pathname}${url.search}`, headers: { ...request.headers(), ...baseHeaders, cookie }, ...(request.postData() ? { payload: request.postData()! } : {}) });
    await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
  });
  // Armed last, so they judge the journey, not the start-up of the fixture.
  const spawns = spawnSpy(); // git only; any other program is refused and still recorded
  const network = noNetwork(); // loopback only
  const stop = async () => {
    try { if (!page.isClosed()) await page.close(); }
    finally {
      network.restore(); spawns.restore();
      try { await instance.app.close(); }
      finally {
        try { profile.restore(); }
        finally {
          const full = resolve(directory);
          if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-houses-first-')) throw new Error('Unsafe fixture cleanup');
          rmSync(full, { recursive: true, force: true });
        }
      }
    }
  };
  return { calls, remote, pageErrors, prefix, projectName, projectPath, snapshot, models, spawns, network, profile, stop, githubListings: () => githubListings };
}

test('connecting a first project and opening its house from the world and the list reads no session, sets up no tracking and starts no tool', async ({ page }, testInfo) => {
  const town = await realTown(page);
  const writes: { path: string; body: unknown }[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/') && request.method() !== 'GET' && url.pathname !== '/api/v1/session') writes.push({ path: url.pathname, body: request.postDataJSON() });
  });
  try {
    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();

    // (a) Connect a first project, then wait 1.5 s.
    await page.getByRole('button', { name: 'Connect a project', exact: true }).click();
    const local = page.getByRole('region', { name: 'Local folders', exact: true });
    await local.getByLabel('Project folder', { exact: true }).fill(town.projectPath);
    await local.getByRole('button', { name: 'Add this project', exact: true }).click();
    const use = local.getByRole('button', { name: `Use ${town.projectPath} as a local project`, exact: true });
    await expect(use).toBeEnabled();
    let from = town.calls.length;
    await use.click();
    // The first connected project opens its own house details.
    const drawer = page.getByTestId('right-drawer');
    await expect(drawer).toContainText('Local project folder');
    const tracking = drawer.getByRole('region', { name: /^Live tracking:/ });
    await expect(tracking).toBeVisible();
    await page.waitForTimeout(1500);
    expectNoToolReads(town.calls, from, 'connecting the first project and waiting 1.5 seconds');
    // Tracking is collapsed and says nothing was checked: a check is something the person starts.
    await expect.soft(tracking.getByRole('button', { name: 'Show details', exact: true }), 'the first house opens with tracking collapsed').toHaveAttribute('aria-expanded', 'false');
    await page.screenshot({ path: testInfo.outputPath('first-house.png') });

    // (b) Open the inspector from the world.
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    const house = page.locator('button.world-label[data-repo-id]').filter({ hasText: town.projectName });
    await house.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('room-context')).toBeVisible();
    from = town.calls.length;
    await page.getByRole('button', { name: 'Repository details', exact: true }).click();
    await expect(drawer).toContainText('Local project folder');
    await page.waitForTimeout(1500);
    expectNoToolReads(town.calls, from, 'opening the inspector from the world');

    // (b) ...and from the List view: in the room, then from the town's list of houses.
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.getByRole('button', { name: 'Show list view', exact: true }).click();
    from = town.calls.length;
    await page.getByRole('button', { name: 'Repository details', exact: true }).click();
    await expect(drawer).toContainText('Local project folder');
    await page.waitForTimeout(1500);
    expectNoToolReads(town.calls, from, 'opening the inspector from the List view (in the room)');
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.getByRole('button', { name: 'Back to town', exact: true }).click();
    from = town.calls.length;
    // In the List view a house opens into its room, like the world's label does; the room's "Repository details" opens the inspector.
    await page.locator('.list-places').getByRole('button', { name: town.projectName, exact: true }).click();
    await expect(page.getByTestId('room-context')).toBeVisible();
    await page.getByRole('button', { name: 'Repository details', exact: true }).click();
    await expect(drawer).toContainText('Local project folder');
    await page.waitForTimeout(1500);
    expectNoToolReads(town.calls, from, 'opening the inspector from the List view (the list of houses)');

    // Across the whole journey the only writes were the ones that save the folder and the project.
    const stray = writes.filter(call => !['/roots', '/scans', '/projects/local'].some(suffix => call.path === `${town.prefix}${suffix}`));
    expect.soft(stray.map(call => call.path), `only roots, scans and projects/local may be written.\nCall log:\n${printLog(town.calls)}`).toEqual([]);
    expect.soft(writes.filter(call => call.path.endsWith('/projects/local')), 'the project is saved once, from the folder that was chosen').toEqual([{ path: `${town.prefix}/projects/local`, body: { path: town.projectPath } }]);
    expect.soft(town.calls.filter(call => isToolRead(call) || isHealth(call)).map(label), `the whole journey asked for no tool check, session, connection or health.\nCall log:\n${printLog(town.calls)}`).toEqual([]);

    // The service's side: nothing was read, written, started or called.
    const saved = await town.snapshot();
    expect.soft(saved.state.repositories.map(repo => repo.localPath)).toEqual([town.projectPath]);
    expect.soft(saved.state.observation?.connections ?? [], 'no tracking connection was saved').toEqual([]);
    expect.soft(saved.state.agents, 'no character was created').toEqual([]);
    expect.soft(readdirSync(town.projectPath), 'nothing was written into the project folder (no .claude, .codex, .cursor, .github or .git)').toEqual(['notes.txt']);
    expect.soft(town.spawns.launches.map(launch => launch.executables.join(' + ')), 'the service started no program').toEqual([]);
    expect.soft(town.models.calls.map(call => call.method), 'no model was called').toEqual([]);
    expect.soft(town.network.attempts.map(attempt => `${attempt.host} (${attempt.via})`), 'the service made no outside request').toEqual([]);
    expect.soft(town.profile.take().map(access => `${access.operation} ${access.path}`), 'no real tool profile folder (.codex, .claude, .cursor, .copilot) was touched').toEqual([]);
    expect.soft(town.githubListings(), 'GitHub was not asked for a repository list').toBe(0);
    expect.soft(town.remote, 'the browser made no request outside the local service').toEqual([]);
    expect.soft(town.pageErrors).toEqual([]);
  } finally {
    await attachLog(testInfo, town.calls);
    await town.stop();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Mocked service for the clock, expansion and Connections journeys.
// ---------------------------------------------------------------------------------------------------------------------

const detected: ToolDetectionStatus[] = [
  { provider: 'codex', label: 'Codex', state: 'found', sessionCount: 18, sessionCountExact: true, message: null },
  { provider: 'claude', label: 'Claude Code', state: 'found', sessionCount: 3, sessionCountExact: true, message: null },
  { provider: 'cursor', label: 'Cursor', state: 'no-activity', sessionCount: 0, sessionCountExact: true, message: null },
  { provider: 'copilot-cli', label: 'Copilot CLI', state: 'not-installed', sessionCount: null, sessionCountExact: true, message: 'GitHub Copilot CLI was not found on this machine.' },
];
const savedConnection = (): ObservationConnection => ({ id: '5a0d2a6e-6f6a-4a9b-9d3e-0c1f7f2b8a11', provider: 'codex', repoId: 'project', label: 'Codex (auto-detected)', status: 'unverified', createdAt: '2026-09-15T12:00:00.000Z', lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true });

const defaultMockRepository: Repository = { id: 'project', name: 'Local project', description: 'Synthetic local project', language: 'TypeScript', branch: 'main', color: '#859b87', position: [-6, -3], source: 'local', localPath: mockRepoPath };
interface MockOptions { connections?: ObservationConnection[]; rebuilt?: boolean; list?: boolean; clock?: boolean; repositories?: Repository[] }
async function mockedTown(page: Page, options: MockOptions = {}) {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceIdMock, name: 'Houses first fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: options.repositories ?? [defaultMockRepository], agents: [], activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null }, observation: { connections: options.connections ?? [] }, discovery: { roots: [String.raw`C:\synthetic-houses-first`], candidates: [], operation: null } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'houses-first-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: workspaceIdMock, name: 'Houses first fixture', kind: 'personal' }], identity: { configured: true } };
  const calls: Call[] = [], pageErrors: string[] = [], remote: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') remote.push(request.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('houses-first-fixture-state', this.listener); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; window.removeEventListener('houses-first-fixture-state', this.listener); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  // A list-only town: no 3D canvas, so a fake 60 second clock does not run 3,700 animation frames of the world. The List view is an equal route to every action (CLAUDE.md).
  if (options.list) await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl' || type === 'webgl2') return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  if (options.clock) await page.clock.install({ time: new Date('2026-09-24T12:00:00.000Z') });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    calls.push({ method: request.method(), path, query: url.search });
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    if (path === '/api/v1/health') return route.fulfill({ json: { ok: true, rebuiltPendingRestart: options.rebuilt ?? false } });
    if (path === `${mockPrefix}/observation/tool-detection` && request.method() === 'GET') return route.fulfill({ json: { repoId: 'project', tools: detected } });
    if (path === `${mockPrefix}/observation/native-setup` && request.method() === 'GET') return route.fulfill({ json: { sources: [], tools: [] } });
    return route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  const publish = async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('houses-first-fixture-state', { detail: current })), snapshot); };
  return { snapshot, calls, remote, pageErrors, publish };
}

/** A house opens into its room (from the world's label or the List view's list of houses); the room's "Repository details" opens the inspector. */
async function openInspector(page: Page, list: boolean) {
  if (list) await page.locator('.list-places').getByRole('button', { name: 'Local project', exact: true }).click();
  else await page.getByRole('button', { name: 'Local project', exact: true }).click();
  await expect(page.getByTestId('room-context')).toBeVisible();
  await page.getByRole('button', { name: 'Repository details', exact: true }).click();
  const drawer = page.getByTestId('right-drawer');
  await expect(drawer).toBeVisible();
  const panel = drawer.getByRole('region', { name: /^Live tracking:/ });
  await expect(panel).toBeVisible();
  return { drawer, panel };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. The health poll (WS3-24's "rebuilt, restart to use it" notice) on a fake clock.
// ---------------------------------------------------------------------------------------------------------------------

for (const withConnection of [false, true]) {
  test(`with the inspector open for 60 seconds, ${withConnection ? 'a house with a saved connection asks for /health at most every 30 seconds' : 'a house without a connection never asks for /health'}`, async ({ page }, testInfo) => {
    const town = await mockedTown(page, { connections: withConnection ? [savedConnection()] : [], list: true, clock: true });
    await openInspector(page, true);
    // Time is now ours: nothing fires until the clock is told to run.
    const startedAt = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(startedAt + 1000);
    await page.waitForTimeout(300);
    const healthCalls = () => town.calls.filter(isHealth);
    if (withConnection) await expect.poll(() => healthCalls().length, { message: 'a house with a connection still checks for a rebuilt build' }).toBeGreaterThanOrEqual(1);
    let elapsed = 0;
    for (const step of [1, 2, 3, 4, 5, 6]) {
      await page.clock.runFor(10000); elapsed += 10000;
      // An unrelated live update re-renders the whole app. It must not make the panel ask again (it used to, on every render).
      if (step % 2 === 0) await town.publish();
      await page.waitForTimeout(150);
      const count = healthCalls().length;
      // One check when the panel appears, then one per 30 seconds; the 3 seconds are the fake time that passed before the clock was paused.
      const allowed = withConnection ? 1 + Math.floor((elapsed + 3000) / 30000) : 0;
      expect.soft(count, `after ${elapsed / 1000} fake seconds ${withConnection ? `at most ${allowed} health request(s) are allowed` : 'no health request is allowed'}, saw ${count}.\nCall log:\n${printLog(town.calls)}`).toBeLessThanOrEqual(allowed);
    }
    expectNoToolReads(town.calls, 0, 'a 60 second fake clock with the inspector open', { health: false });
    expect.soft(town.calls.filter(call => call.method !== 'GET' && call.path !== '/api/v1/session'), 'nothing is written').toEqual([]);
    expect.soft(town.remote).toEqual([]); expect.soft(town.pageErrors).toEqual([]);
    await attachLog(testInfo, town.calls);
  });
}

test('a rebuilt build still shows its restart notice for a house with a connection', async ({ page }) => {
  const connected = await mockedTown(page, { connections: [savedConnection()], rebuilt: true, list: true });
  const { panel } = await openInspector(page, true);
  await expect(panel.getByText('Agent Town was rebuilt. Restart it to use the new version.', { exact: true })).toBeVisible();
  expect(connected.calls.filter(isHealth).length).toBeGreaterThanOrEqual(1);
});

test('a house without a connection shows no restart notice and asks nothing, even when the build was rebuilt', async ({ page }) => {
  const town = await mockedTown(page, { connections: [], rebuilt: true, list: true });
  const { panel } = await openInspector(page, true);
  await page.waitForTimeout(1500);
  await expect(panel.getByText('Agent Town was rebuilt. Restart it to use the new version.', { exact: true })).toHaveCount(0);
  expect(town.calls.filter(isHealth), `Call log:\n${printLog(town.calls)}`).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Expanding sends nothing; the button starts one check.
// ---------------------------------------------------------------------------------------------------------------------

test('expanding the tracking section sends nothing, and only Check this computer starts one check', async ({ page }, testInfo) => {
  const town = await mockedTown(page);
  const { panel } = await openInspector(page, false);
  const quiet = () => town.calls.filter(call => !isSessionOrSnapshot(call));
  await page.waitForTimeout(1500);
  expect.soft(quiet().map(label), `opening the house sends nothing.\nCall log:\n${printLog(town.calls)}`).toEqual([]);
  const toggle = panel.getByRole('button', { name: 'Show details', exact: true });
  await expect(toggle, 'tracking starts collapsed').toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(panel.getByRole('button', { name: 'Hide details', exact: true })).toHaveAttribute('aria-expanded', 'true');
  const check = panel.getByRole('button', { name: 'Check this computer', exact: true });
  await expect(check).toBeVisible();
  await expect(check).toBeEnabled();
  await flush(page); await page.waitForTimeout(500);
  expect.soft(quiet().map(label), `expanding the section sends nothing.\nCall log:\n${printLog(town.calls)}`).toEqual([]);
  await expect(panel.locator('.tool-row'), 'no tool is listed until a check has run').toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('expanded-before-check.png') });

  await check.click();
  await expect(panel.locator('.tool-row')).toHaveCount(4);
  expect(quiet().map(label), `one press starts exactly one check, and nothing else.\nCall log:\n${printLog(town.calls)}`).toEqual([`GET workspaces/${workspaceIdMock}/observation/tool-detection?repoId=project`]);
  await attachLog(testInfo, town.calls);
  expect(town.remote).toEqual([]); expect(town.pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Connections. H0-16 (e): opening it requests no native setup.
// ---------------------------------------------------------------------------------------------------------------------

test('opening Connections requests no native setup', async ({ page }) => {
  const town = await mockedTown(page);
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(page.getByTestId('left-drawer')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(town.calls.filter(isToolRead).map(label), `opening Connections asked for tracking data.\nCall log:\n${printLog(town.calls)}`).toEqual([]);
});

// H0-09: the "Observation connections" list (Revoke, Remove Agent Town hook) stays visible without opening manual
// setup, and reads nothing to show it. Opening manual setup from a house presets the project only, not the tool
// (an inspected session is the only thing that presets both — see ObservationPanel.tsx), and its one native-setup
// request fires once, when the form actually opens, not before.
test('the observation connections list is visible and readable without opening manual setup, and opening it from a house presets only the project', async ({ page }, testInfo) => {
  const active = savedConnection();
  const revoked: ObservationConnection = { ...savedConnection(), id: 'a6f2f0a0-7c3a-4d7a-9d2e-6a2b9d4e7c10', label: 'Old Codex link', status: 'revoked' };
  const town = await mockedTown(page, { connections: [active, revoked] });

  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  const drawer = page.getByTestId('left-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(active.label, { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Revoke observation', exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Remove Agent Town hook', exact: true })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Set up local agent tracking', exact: true })).toHaveCount(0);
  await page.waitForTimeout(1500);
  expectNoToolReads(town.calls, 0, 'opening Connections with saved connections present');
  await drawer.getByRole('button', { name: 'Revoke observation', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('connections-list-no-manual-setup.png') });
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();

  // Opening manual setup from a house supplies the project but never presets a tool. H0-08 replaced
  // the room-header "Set up tracking" button with the quiet "Watch sessions (optional)" link: it opens
  // the house inspector's Watch section already expanded (and sends nothing, per the test above), not
  // manual setup directly. Manual setup itself is reached one hop further in, via that section's own
  // "Manual setup for other tools" link (still calling openTracking, so it still presets project-only).
  await page.getByRole('button', { name: 'Local project', exact: true }).click();
  const from = town.calls.length;
  await page.getByTestId('room-context').getByRole('button', { name: 'Watch sessions (optional)', exact: true }).click();
  const inspector = page.getByTestId('right-drawer');
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Hide details', exact: true }), 'Watch sessions (optional) opens the Watch section already expanded').toHaveAttribute('aria-expanded', 'true');
  await inspector.getByRole('button', { name: 'Manual setup for other tools', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up local agent tracking', exact: true })).toBeVisible();
  const toolSelect = page.getByRole('combobox', { name: 'Agent tool', exact: true });
  await expect(toolSelect).toHaveValue('');
  await expect(toolSelect.locator('option').first()).toHaveText('Choose a tool');
  const projectSelect = page.getByRole('combobox', { name: 'Repository for observation', exact: true });
  await expect(projectSelect).toHaveValue('project');
  await expect(projectSelect.locator('option').first()).toHaveText('Choose a project');
  await expect(page.getByRole('button', { name: 'Prepare observation setup', exact: true })).toBeDisabled();
  await toolSelect.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('manual-setup-unchosen.png') });
  await page.waitForTimeout(500);
  expect(town.calls.slice(from).filter(call => call.path.endsWith('/native-setup')).map(label), `opening manual setup from a house.\nCall log:\n${printLog(town.calls)}`).toEqual([`GET workspaces/${workspaceIdMock}/observation/native-setup?repoId=project`]);

  // Wa2r finding 1: the hint that opened manual setup above must not outlive that one visit. Close the drawer, then
  // reopen Connections generically (the same dock button used at the very start of this test, not Set up tracking):
  // the form must start closed again, with no second native-setup request, even though this project's manual setup
  // was already opened once in this session.
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(drawer).toBeHidden();
  const reopenedFrom = town.calls.length;
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up local agent tracking', exact: true })).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(town.calls.slice(reopenedFrom).filter(call => call.path.endsWith('/native-setup')).map(label), `reopening Connections generically after manual setup was already opened once in this session.\nCall log:\n${printLog(town.calls)}`).toEqual([]);
});

// Wa2r finding 2: with no local repository connected, the manual-setup entry point has nothing to open, so
// Connections must explain why instead of showing a dead-end disabled button (the pre-H0-09 message, unreachable
// once the button gated on formOpen, per the review).
test('with no local repository, Connections explains why instead of a dead-end disabled button', async ({ page }, testInfo) => {
  const remoteOnly: Repository = { id: 'remote-project', name: 'Remote project', description: 'Synthetic remote-only repository', language: 'TypeScript', branch: 'main', color: '#859b87', position: [-6, -3], source: 'github', githubId: 1, githubUrl: 'https://github.com/example/remote-project' };
  const town = await mockedTown(page, { repositories: [remoteOnly] });
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  const drawer = page.getByTestId('left-drawer');
  await expect(drawer).toBeVisible();
  const message = drawer.getByText('Connect a local repository before setting up observation. A remote repository alone has no local hook destination.', { exact: true });
  await expect(message).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Set up tracking', exact: true })).toHaveCount(0);
  await message.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('connections-no-local-repository.png') });
  await page.waitForTimeout(500);
  expect(town.calls.filter(isToolRead).map(label), `Call log:\n${printLog(town.calls)}`).toEqual([]);
});
