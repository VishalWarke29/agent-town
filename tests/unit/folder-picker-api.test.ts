import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_WORKSPACE } from '@agent-town/contracts';
import { createApp } from '../../apps/service/src/app';
import { createFolderPicker, type FolderHelperEvents, type FolderHelperLauncher, type FolderPicker } from '../../apps/service/src/folder-picker';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';
import { platformTest, realToolSuite, type PlatformGate, type RealToolGate } from '../helpers/real-tool-test';

// Not run here, these show in the report as skipped WITH a written reason (FD-06), not as a bare skip.
const windowsFolderRules: PlatformGate = { only: 'win32', why: 'it checks the Windows folder rules (the Windows folder, drive roots, network shares) on Windows paths' };
const realWindow: RealToolGate = { enabledBy: 'AGENT_TOWN_REAL_FOLDER_PICKER', needs: 'a real Windows folder window on a signed-in desktop that nobody is using', platform: 'win32' };

const origin = 'http://127.0.0.1:4310';
const host = { host: '127.0.0.1:4310' };
const unknownId = '00000000-0000-4000-8000-000000000000';
const line = (value: object) => `${JSON.stringify(value)}\n`;
const opened = line({ state: 'open' });
const chose = (path: string) => line({ state: 'selected', path });

type Session = { cookie: string; csrf: string };
type Instance = Awaited<ReturnType<typeof createApp>>;
interface Helper { events: FolderHelperEvents; kills: number; exited: boolean; /** Lets the fake helper finish going away. */ release(): void }

let instance: Instance | undefined;
let directories: string[] = [];
let helpers: Helper[] = [];
let now = Date.now();
let principalId = '101';
let holdExit = false;
/** Milliseconds until the fake helper reports its window is up; null = it never does (an unavailable desktop). */
let openAfterMs: number | null = 5;

/** A fake helper: nothing here starts a process or opens a window. Its exit is reported a moment later unless a test holds it. */
const launcher: FolderHelperLauncher = (_request, events) => {
  let finish: () => void = () => undefined;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const helper: Helper = { events, kills: 0, exited: false, release: () => { helper.exited = true; finish(); } };
  helpers.push(helper);
  if (openAfterMs !== null) setTimeout(() => { if (!helper.exited) events.onOutput(opened); }, openAfterMs);
  if (!holdExit) setTimeout(helper.release, 20);
  return { kill: () => { helper.kills++; }, done };
};
const newPicker = () => createFolderPicker({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, launcher });

async function build(extra: { folderPicker?: FolderPicker; logger?: boolean } = {}) {
  await instance?.app.close().catch(() => undefined);
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-folder-api-'));
  directories.push(directory);
  helpers = []; principalId = '101'; now = Date.now(); openAfterMs = 5;
  const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { secrets.set(key, value); }, get: async key => secrets.get(key) ?? null, delete: async key => { secrets.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: `fixture-secret-${principalId}`, expiresIn: 3600 }),
    verifyUser: async token => ({ id: token.split('-').at(-1)!, login: `user${principalId}`, displayName: 'Fixture Owner', avatarUrl: null }),
    listRepositories: async () => ({ repositories: [], truncated: false, checkedAt: new Date(now).toISOString() }),
  };
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'fixture-public-client-id', now: () => now });
  instance = await createApp({ database: ':memory:', privateDirectory: directory, identity, vault, folderPicker: extra.folderPicker ?? newPicker(), logger: extra.logger, simulationInterval: 600000 });
  return instance;
}

afterEach(async () => {
  try { await instance?.app.close(); } catch { /* Already closed by the test. */ }
  instance = undefined; holdExit = false;
  for (const directory of directories) {
    const target = resolve(directory);
    if (target.startsWith(resolve(tmpdir()) + sep)) { try { rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may hold a handle briefly. */ } }
  }
  directories = [];
});

const headers = (session: Session) => ({ ...host, origin, cookie: session.cookie, 'x-csrf-token': session.csrf });
const cookies = (response: { cookies: Array<{ name: string; value: string }> }) => response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
async function bootstrap(): Promise<Session> {
  const response = await instance!.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...host, origin } });
  return { cookie: cookies(response), csrf: response.json().csrf };
}
async function signIn(): Promise<Session> {
  const session = await bootstrap();
  const start = await instance!.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: headers(session) });
  expect(start.statusCode).toBe(200); now += 6000;
  const poll = await instance!.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', headers: headers(session), payload: { flowId: start.json().flowId } });
  expect(poll.json().status).toBe('authorized');
  return { cookie: cookies(poll), csrf: poll.json().session.csrf };
}
async function workspace(session: Session, name = 'Private workshop'): Promise<string> {
  const response = await instance!.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: headers(session), payload: { name, kind: 'personal' } });
  expect(response.statusCode).toBe(200);
  return response.json().workspace.id;
}
const pickUrl = (id: string, tail = '') => `/api/v1/workspaces/${id}/folders/pick${tail}`;
const start = (session: Session, id: string, payload?: unknown) => instance!.app.inject({ method: 'POST', url: pickUrl(id), headers: headers(session), payload: payload as object | undefined });
const status = (session: Session, id: string, pick: string) => instance!.app.inject({ method: 'GET', url: pickUrl(id, `/${pick}`), headers: headers(session) });
const cancel = (session: Session, id: string, pick: string) => instance!.app.inject({ method: 'POST', url: pickUrl(id, `/${pick}/cancel`), headers: headers(session) });
const snapshotCursor = async (session: Session, id: string) => (await instance!.app.inject({ url: `/api/v1/workspaces/${id}/snapshot`, headers: headers(session) })).json().cursor as number;

describe('folder window API', () => {
  it('starts a window and shows a path only once the person has chosen one', async () => {
    await build();
    const alice = await signIn(), id = await workspace(alice);
    const before = await snapshotCursor(alice, id);
    const started = await start(alice, id);
    expect(started.statusCode).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    const pick = started.json();
    expect(pick).toEqual({ id: expect.any(String), state: 'waiting', startedAt: expect.any(String), expiresAt: expect.any(String) });
    expect(helpers).toHaveLength(1);
    const waiting = await status(alice, id, pick.id);
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json()).toEqual(pick);
    expect(waiting.body).not.toContain('path');
    const chosen = 'C:\\Projects\\Chosen Folder';
    helpers[0]!.events.onOutput(chose(chosen));
    const done = await status(alice, id, pick.id);
    expect(done.json()).toEqual({ ...pick, state: 'selected', path: chosen });
    // Picking only reads a path: nothing was written to the workspace.
    expect(await snapshotCursor(alice, id)).toBe(before);
  });

  it('answers a start only once the window has reported in, so "waiting" always means a window is open', async () => {
    await build();
    openAfterMs = 120; holdExit = true;
    const alice = await signIn(), id = await workspace(alice);
    const began = Date.now();
    const started = await start(alice, id);
    expect(Date.now() - began).toBeGreaterThanOrEqual(100);
    expect(started.json()).toEqual({ id: expect.any(String), state: 'waiting', startedAt: expect.any(String), expiresAt: expect.any(String) });
    // A repeat click while the window is open answers straight away with the same pick and starts nothing new.
    const repeatBegan = Date.now();
    const repeat = (await start(alice, id)).json();
    expect(Date.now() - repeatBegan).toBeLessThan(100);
    expect(repeat).toEqual({ ...started.json(), alreadyOpen: true });
    expect(helpers).toHaveLength(1);
  });

  it('holds a repeat start while the window is still opening, then answers the live pick as already open', async () => {
    await build();
    openAfterMs = 150; holdExit = true;
    const alice = await signIn(), id = await workspace(alice);
    const began = Date.now();
    const answers = (await Promise.all([start(alice, id), start(alice, id)])).map(response => response.json());
    expect(Date.now() - began).toBeGreaterThanOrEqual(100);
    // Whichever request got in first opened the window; the other one is told it was already open. Both wait for it to be up.
    expect(answers.map(answer => answer.state)).toEqual(['waiting', 'waiting']);
    expect(answers.filter(answer => answer.alreadyOpen === true)).toHaveLength(1);
    expect(answers[0].id).toBe(answers[1].id);
    expect(helpers).toHaveLength(1);
  });

  it('answers a start with an unavailable desktop when no window appears within the handshake, and ends the helper', async () => {
    await build({ folderPicker: createFolderPicker({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, launcher, limits: { handshakeMs: 150 } }) });
    openAfterMs = null;
    const alice = await signIn(), id = await workspace(alice);
    const started = await start(alice, id);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({ id: expect.any(String), state: 'unavailable', reason: 'no-desktop', startedAt: expect.any(String), expiresAt: expect.any(String) });
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.kills).toBe(1);
  });

  it('reports why a window could not be used, and a cancelled window without a path', async () => {
    await build();
    const alice = await signIn(), id = await workspace(alice);
    const first = (await start(alice, id)).json();
    helpers[0]!.events.onExit();
    expect((await status(alice, id, first.id)).json()).toEqual({ ...first, state: 'unavailable', reason: 'helper-failed' });
    const second = (await start(alice, id)).json();
    helpers[1]!.events.onOutput(line({ state: 'cancelled' }));
    const closed = (await status(alice, id, second.id)).json();
    expect(closed).toEqual({ ...second, state: 'cancelled' });
    expect(closed).not.toHaveProperty('path');
  });

  it('returns the open window with alreadyOpen and does not start a second one', async () => {
    await build();
    const alice = await signIn(), id = await workspace(alice);
    const first = (await start(alice, id)).json();
    const again = await start(alice, id, {});
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ...first, alreadyOpen: true });
    expect(helpers).toHaveLength(1);
  });

  it('takes no input on start', async () => {
    await build();
    const alice = await signIn(), id = await workspace(alice);
    for (const payload of [{ path: 'C:\\x' }, { extra: true }, [], [{}]]) {
      const response = await start(alice, id, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().code).toBe('INVALID_REQUEST');
    }
    expect(helpers).toHaveLength(0);
    expect((await start(alice, id, {})).statusCode).toBe(200);
    expect(helpers).toHaveLength(1);
  });

  it('ends the helper when the page cancels, then allows a new window', async () => {
    await build();
    const alice = await signIn(), id = await workspace(alice);
    const first = (await start(alice, id)).json();
    const stopped = await cancel(alice, id, first.id);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ ...first, state: 'cancelled' });
    expect(helpers[0]!.kills).toBe(1);
    helpers[0]!.events.onOutput(chose('C:\\Late\\Result'));
    expect((await status(alice, id, first.id)).json()).toEqual({ ...first, state: 'cancelled' });
    const second = (await start(alice, id)).json();
    expect(second.id).not.toBe(first.id);
    expect(helpers).toHaveLength(2);
  });

  it('allows one window at a time across workspaces and owners', async () => {
    await build();
    const alice = await signIn(), one = await workspace(alice, 'One'), two = await workspace(alice, 'Two');
    principalId = '202'; const bob = await signIn(), bobs = await workspace(bob, 'Bobs');
    const first = (await start(alice, one)).json();
    for (const [session, target] of [[alice, two], [bob, bobs]] as const) {
      const busy = await start(session, target);
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toEqual({ code: 'FOLDER_PICK_BUSY', message: expect.stringMatching(/already open/i) });
    }
    expect(helpers).toHaveLength(1);
    await cancel(alice, one, first.id);
    expect((await start(bob, bobs)).statusCode).toBe(200);
    expect(helpers).toHaveLength(2);
  });

  it('answers an unknown id, an invalid id and another workspace\'s id identically, and never touches the real window', async () => {
    await build();
    const alice = await signIn(), one = await workspace(alice, 'One'), two = await workspace(alice, 'Two');
    principalId = '202'; const bob = await signIn(), bobs = await workspace(bob, 'Bobs');
    const pick = (await start(alice, one)).json();
    const misses = [
      await status(alice, one, unknownId), await cancel(alice, one, unknownId),
      await status(alice, two, pick.id), await cancel(alice, two, pick.id),
      await status(bob, bobs, pick.id), await cancel(bob, bobs, pick.id),
      await status(alice, one, 'not-an-id'), await cancel(alice, one, '12345'),
    ];
    for (const miss of misses) {
      expect(miss.statusCode).toBe(404);
      expect(miss.json()).toEqual({ code: 'FOLDER_PICK_NOT_FOUND', message: expect.any(String) });
    }
    expect(new Set(misses.map(miss => miss.body)).size).toBe(1);
    // Someone else's workspace is itself unavailable, so its window ids are never even consulted.
    expect((await status(bob, one, pick.id)).json().code).toBe('workspace_not_found');
    expect((await cancel(bob, one, pick.id)).json().code).toBe('workspace_not_found');
    expect((await start(bob, one)).json().code).toBe('workspace_not_found');
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.kills).toBe(0);
    expect((await status(alice, one, pick.id)).json().state).toBe('waiting');
  });

  it('requires a signed-in session, the CSRF token and the local origin for every action', async () => {
    await build();
    const alice = await signIn(), id = await workspace(alice);
    const pick = (await start(alice, id)).json();
    const inject = (method: 'GET' | 'POST', url: string, extra: Record<string, string>) => instance!.app.inject({ method, url, headers: { ...host, ...extra } });
    const targets: Array<['GET' | 'POST', string]> = [['POST', pickUrl(id)], ['GET', pickUrl(id, `/${pick.id}`)], ['POST', pickUrl(id, `/${pick.id}/cancel`)]];
    for (const [method, url] of targets) {
      // No session at all.
      expect((await inject(method, url, { origin })).statusCode, `${method} ${url} unsigned`).toBe(401);
      // A page that was never signed in cannot reach a private workspace.
      const anonymous = await bootstrap();
      expect((await instance!.app.inject({ method, url, headers: headers(anonymous) })).statusCode, `${method} ${url} anonymous`).toBe(404);
    }
    for (const [method, url] of targets.filter(([method]) => method === 'POST')) {
      const noToken = await inject(method, url, { origin, cookie: alice.cookie });
      expect(noToken.statusCode, `${url} without CSRF`).toBe(403); expect(noToken.json().code).toBe('CSRF_REQUIRED');
      const wrongToken = await inject(method, url, { origin, cookie: alice.cookie, 'x-csrf-token': '0'.repeat(64) });
      expect(wrongToken.statusCode, `${url} wrong CSRF`).toBe(403);
      const noOrigin = await inject(method, url, { cookie: alice.cookie, 'x-csrf-token': alice.csrf });
      expect(noOrigin.statusCode, `${url} without Origin`).toBe(403); expect(noOrigin.json().code).toBe('ORIGIN_REQUIRED');
      const foreign = await inject(method, url, { origin: 'http://evil.example', cookie: alice.cookie, 'x-csrf-token': alice.csrf });
      expect(foreign.statusCode, `${url} foreign Origin`).toBe(403);
    }
    // None of the refused calls started or ended anything.
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.kills).toBe(0);
    expect((await status(alice, id, pick.id)).json().state).toBe('waiting');
  });

  it('stops a live helper when the service closes, and waits for it to go', async () => {
    const app = (await build()).app;
    const alice = await signIn(), id = await workspace(alice);
    holdExit = true;
    await start(alice, id);
    expect(helpers[0]!.kills).toBe(0);
    const closing = app.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    // The helper is ended at once, and shutdown waits for it rather than leaving it behind.
    expect(helpers[0]!.kills).toBe(1);
    expect(closed).toBe(false);
    helpers[0]!.release();
    await closing;
    expect(helpers[0]!.exited).toBe(true);
    expect(helpers[0]!.kills).toBe(1);
  });

  it('gives demo mode no folder window at all', async () => {
    helpers = [];
    const picker = newPicker();
    const app = (await createApp({ database: ':memory:', mode: 'demo', folderPicker: picker, simulationInterval: 600000 })).app;
    try {
      const response = await app.inject({ method: 'POST', url: pickUrl(DEMO_WORKSPACE), headers: { ...host, origin } });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('DEMO_ONLY');
      expect(helpers).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('writes no folder path to the service log, even when a request fails unexpectedly', async () => {
    const secret = 'C:\\Users\\Secret Person\\Confidential Project';
    const real = newPicker();
    // The spy goes in before the service is built: the service's logger chooses its output when it is created.
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write);
    let body = '';
    try {
      await build({ logger: true, folderPicker: { ...real, status: () => { throw new Error(`Unexpected failure for ${secret}`); } } });
      const alice = await signIn(), id = await workspace(alice);
      const pick = (await start(alice, id)).json();
      helpers[0]!.events.onOutput(chose(secret));
      expect((await start(alice, id, { path: secret })).statusCode).toBe(400);
      expect((await cancel(alice, id, unknownId)).statusCode).toBe(404);
      expect((await cancel(alice, id, pick.id)).json()).toMatchObject({ state: 'selected', path: secret });
      const failed = await status(alice, id, pick.id);
      expect(failed.statusCode).toBe(500);
      body = failed.body;
      await instance!.app.close();
    } finally { spy.mockRestore(); }
    const log = written.join('');
    // The capture is live: the failed request was logged, by kind only.
    expect(log).toContain('Request failed');
    expect(log).toContain('errorType');
    for (const fragment of [secret, 'Secret Person', 'Confidential', 'Unexpected failure']) { expect(log).not.toContain(fragment); expect(body).not.toContain(fragment); }
  });
});

describe('the folder window adds no authority', () => {
  /** Drives the whole browse-then-add flow: the picker hands back text, and the add route decides. */
  async function pickThenAdd(session: Session, id: string, path: string, route: 'roots' | 'projects/local' = 'roots') {
    const pick = (await start(session, id)).json();
    const helper = helpers.at(-1)!;
    helper.events.onOutput(chose(path));
    const chosen = (await status(session, id, pick.id)).json();
    expect(chosen).toMatchObject({ state: 'selected', path });
    return instance!.app.inject({ method: 'POST', url: `/api/v1/workspaces/${id}/${route}`, headers: headers(session), payload: { path: chosen.path } });
  }
  const roots = async (session: Session, id: string) => ((await instance!.app.inject({ url: `/api/v1/workspaces/${id}/snapshot`, headers: headers(session) })).json().state.discovery.roots as string[]);

  platformTest('still refuses the Windows folder, a drive, the home folder and a network path when the picker returns them', windowsFolderRules, async () => {
    await build();
    const alice = await signIn(), id = await workspace(alice);
    const windows = process.env.WINDIR ?? process.env.SystemRoot!;
    const refused: Array<[string, string]> = [
      [windows, 'system-root'], [join(windows, 'System32'), 'system-root'],
      ['C:\\', 'invalid-root'], [homedir(), 'invalid-root'], ['\\\\server\\share\\project', 'invalid-root'],
    ];
    for (const [path, code] of refused) {
      const response = await pickThenAdd(alice, id, path);
      expect(response.statusCode, path).toBe(400);
      expect(response.json().code, path).toBe(code);
    }
    expect((await pickThenAdd(alice, id, windows, 'projects/local')).statusCode).toBe(400);
    expect(await roots(alice, id)).toEqual([]);
    expect((await instance!.app.inject({ url: `/api/v1/workspaces/${id}/snapshot`, headers: headers(alice) })).json().state.repositories).toEqual([]);
  });

  platformTest('adds an ordinary folder the picker returned, through the same route as a typed path', windowsFolderRules, async () => {
    await build();
    const alice = await signIn(), id = await workspace(alice);
    const project = mkdtempSync(join(tmpdir(), 'agent-town-picked-'));
    directories.push(project);
    const response = await pickThenAdd(alice, id, project);
    expect(response.statusCode).toBe(200);
    const saved = await roots(alice, id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.toLowerCase()).toContain('agent-town-picked-');
    // A picked folder is connected as a project by the same reviewed route, and nothing else was added on the way.
    const connected = await pickThenAdd(alice, id, project, 'projects/local');
    expect(connected.statusCode).toBe(200);
    expect(connected.json().repository).toMatchObject({ source: 'local', projectKind: 'folder' });
    expect(await roots(alice, id)).toEqual(saved);
  });
});

// Opt-in, like folder-picker-real.test.ts: opens a real folder window on this desktop through the real routes.
describe('the folder window routes with the real helper', () => {
  realToolSuite(realWindow);
  it('opens a real window, keeps it open across a repeat click, and closes it on cancel', async () => {
    await build({ folderPicker: createFolderPicker() });
    const alice = await signIn(), id = await workspace(alice);
    const began = Date.now();
    const started = await start(alice, id);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ state: 'waiting' });
    expect(Date.now() - began).toBeLessThan(8_000);
    const pick = started.json();
    expect((await start(alice, id)).json()).toMatchObject({ id: pick.id, state: 'waiting', alreadyOpen: true });
    const waiting = await status(alice, id, pick.id);
    expect(waiting.json()).toMatchObject({ id: pick.id, state: 'waiting' });
    expect(waiting.body).not.toContain('path');
    const cancelled = await cancel(alice, id, pick.id);
    expect(cancelled.json()).toMatchObject({ id: pick.id, state: 'cancelled' });
  }, 30_000);
});
