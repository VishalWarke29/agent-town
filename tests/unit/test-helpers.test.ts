import { execFile, execFileSync, exec, execSync, fork, spawn } from 'node:child_process';
import { createServer, get as httpGet, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, createReadStream, readFile as readFileCallback,
  chownSync, exists as existsCallback, glob as globCallback, globSync, lchownSync, lutimesSync, mkdtempDisposableSync, openAsBlob, statfs as statfsCallback, statfsSync,
} from 'node:fs';
import { chown as chownPromise, glob as globPromise, lchown as lchownPromise, lutimes as lutimesPromise, readFile, opendir, statfs as statfsPromise } from 'node:fs/promises';
import nodeFs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TownState } from '@agent-town/contracts';
import type { ManagerConfig, WorkflowConnection, WorkflowModel, WorkflowUsage } from '../../packages/contracts/src/workflow';
import type { CredentialVault } from '../../apps/service/src/identity';
import { IdentityError } from '../../apps/service/src/identity/types';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { registerWorkflowApi } from '../../apps/service/src/workflow-api';
import { sanitizeModelText } from '../../apps/service/src/workflow/provider';
import { createShutdown } from '../../apps/service/src/shutdown';
import { discoverNativeSessions } from '../../apps/service/src/native-discovery/index';
import { detectedTools, registerNativeApi } from '../../apps/service/src/observation/native-api';
import {
  activeNetworkGuards, assertNoRefused, commandLineExecutables, connectTarget, GUARDED_FS_EXPORTS, isLoopbackHost, isolatedProfile, modelSpy, ModelCallBlockedError, NetworkBlockedError, noNetwork,
  UNGUARDED_FS_EXPORTS,
  platformSkipReason, RealProfileAccessError, realToolSkipReason, requestTarget, runShutdown, secretCanary, sessionReadSpy, SHUTDOWN_LIMITS_MS, SpawnBlockedError, spawnSpy,
  stepsJob, executableName,
  type NetworkAttempt, type NoNetwork, type ShutdownReport, type ShutdownSignal,
} from '../helpers';

// FD-06 self-tests. Each helper is shown to report 0 for an untouched flow, to report the right count when code calls it,
// and to do so through the service's real code paths (not only through a hand-written call), so that the helper is proved
// by a mutation: the flow is changed from "reads nothing" to "reads something" and the helper must notice.

const tempFolders: string[] = [];
function tempFolder(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `agent-town-helpers-${prefix}-`));
  tempFolders.push(path);
  return path;
}
afterEach(() => {
  for (const path of tempFolders.splice(0)) {
    const target = realpathSync(path);
    if (!target.startsWith(realpathSync(tmpdir())) || !target.includes('agent-town-helpers-')) throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});

async function localServer(): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const server: Server = createServer((_request, response) => { response.end('local ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, port, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const socketError = (socket: Socket) => new Promise<Error>((resolve, reject) => { socket.once('error', resolve); socket.once('connect', () => reject(new Error('the socket connected'))); });

describe('noNetwork', () => {
  let guard: NoNetwork;
  beforeEach(() => { guard = noNetwork(); });
  afterEach(() => { guard.restore(); });

  it('fails a call to an outside URL and names the blocked host, without recording its path or query string', async () => {
    const failure = await fetch('https://example.com/some/path?token=never-recorded').then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NetworkBlockedError);
    expect((failure as Error).message).toContain('example.com');
    expect(guard.blockedHosts()).toEqual(['example.com']);
    expect(guard.attempts).toEqual([{ host: 'example.com', port: null, via: 'fetch', method: 'GET', url: 'https://example.com' }]);
    expect(JSON.stringify(guard.attempts)).not.toMatch(/never-recorded|some\/path/);
    expect(() => guard.expectNone()).toThrow(/example\.com/);
  });

  it('keeps the host, port and method of a refused call in every form fetch takes, but never a path that can carry a secret, a query or credentials', async () => {
    await fetch('https://user:hunter2@bot.example.com:8443/bot123456:SECRET-TOKEN/sendMessage?key=query-secret', { method: 'post' }).catch(() => undefined);
    await fetch(new Request('https://hooks.example.com/services/T000/B000/WEBHOOK-ID', { method: 'PUT' })).catch(() => undefined); // fetch(Request)
    await fetch(new URL('https://url.example.com/private/path')).catch(() => undefined); // fetch(URL)
    expect(() => httpsRequest({ host: 'http.example.com', path: '/secret/path', method: 'delete' })).toThrow(NetworkBlockedError);
    expect(() => httpGet('http://get.example.com/another/secret', () => undefined)).toThrow(NetworkBlockedError);
    expect(guard.attempts).toEqual([
      { host: 'bot.example.com', port: 8443, via: 'fetch', method: 'POST', url: 'https://bot.example.com:8443' },
      { host: 'hooks.example.com', port: null, via: 'fetch', method: 'PUT', url: 'https://hooks.example.com' },
      { host: 'url.example.com', port: null, via: 'fetch', method: 'GET', url: 'https://url.example.com' },
      { host: 'http.example.com', port: null, via: 'http', method: 'DELETE', url: 'https://http.example.com' },
      { host: 'get.example.com', port: null, via: 'http', method: 'GET', url: 'http://get.example.com' },
    ]);
    const leaks = /hunter2|SECRET|query-secret|WEBHOOK|private|secret|another/;
    expect(JSON.stringify(guard.attempts)).not.toMatch(leaks);
    let message = '';
    try { guard.expectNone(); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/5 were refused: fetch bot\.example\.com:8443, fetch hooks\.example\.com, fetch url\.example\.com, http http\.example\.com, http get\.example\.com/);
    expect(message).not.toMatch(leaks);
  });

  it('refuses tls.connect with a servername, and a WebSocket, cleanly as NetworkBlockedError on the socket, not as a TypeError or an uncaught error', async () => {
    // With the refusal delivered inside connect(), tls.connect({ host, servername }) died in setServername (a TypeError) and a WebSocket
    // left an uncaught exception attributed to whichever test was running. It is delivered on the next tick now.
    const named = tlsConnect({ host: 'example.org', port: 443, servername: 'example.org' });
    expect(await socketError(named)).toBeInstanceOf(NetworkBlockedError);
    const byAddress = tlsConnect({ host: '203.0.113.9', port: 443, servername: 'named.example.org' });
    expect(await socketError(byAddress)).toBeInstanceOf(NetworkBlockedError);
    const webSocket = new WebSocket('wss://socket.example.invalid/');
    await new Promise<void>(resolve => { webSocket.addEventListener('error', () => resolve()); webSocket.addEventListener('close', () => resolve()); });
    // With NODE_USE_ENV_PROXY=1 (how the "npm test with the network blocked" check is run, through a dead proxy on loopback) Node
    // connects a WebSocket to the proxy, and a socket-level guard sees loopback: the limit noNetwork()'s header describes. The
    // WebSocket then still fails, on the dead proxy, and nothing leaves the machine, but there is no refusal to record.
    const throughEnvProxy = process.env.NODE_USE_ENV_PROXY === '1';
    expect(guard.attempts.map(attempt => `${attempt.via} ${attempt.host}:${attempt.port}`)).toEqual([
      'socket example.org:443', 'socket 203.0.113.9:443', ...(throughEnvProxy ? [] : ['socket socket.example.invalid:443']),
    ]);
  });

  it('still lets a loopback connection through after a tls.connect refusal', async () => {
    expect(await socketError(tlsConnect({ host: 'example.org', port: 443, servername: 'example.org' }))).toBeInstanceOf(NetworkBlockedError);
    const server = await localServer();
    try {
      const socket = netConnect(server.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.destroy();
    } finally { await server.close(); }
    expect(guard.blockedHosts()).toEqual(['example.org']);
  });

  it('lets a loopback call to the test\'s own server pass', async () => {
    const server = await localServer();
    try {
      const response = await fetch(server.url);
      expect(await response.text()).toBe('local ok');
      expect(guard.attempts).toEqual([]);
      expect(guard.allowedCount).toBeGreaterThan(0);
      guard.expectNone();
    } finally { await server.close(); }
  });

  const shown = (attempt: NetworkAttempt) => `${attempt.via} ${attempt.host}${attempt.port === null ? '' : `:${attempt.port}`}`;

  it('refuses node:http and node:https by destination, and node:net and node:tls connections before any name lookup', async () => {
    // http and https are checked by where the request is going, so an HTTP_PROXY on loopback cannot hide it.
    expect(() => httpGet('http://203.0.113.9/', () => undefined)).toThrow(NetworkBlockedError);
    expect(() => httpsRequest({ host: 'example.net', port: 8443, path: '/x' })).toThrow(/example\.net:8443/);
    // A name that cannot resolve still fails as NetworkBlockedError, not as ENOTFOUND: the connection is stopped before the lookup.
    const netFailure = await socketError(netConnect(80, 'no-such-host.invalid'));
    expect(netFailure).toBeInstanceOf(NetworkBlockedError);
    const tlsFailure = await socketError(tlsConnect({ host: 'example.org', port: 443 }));
    expect(tlsFailure).toBeInstanceOf(NetworkBlockedError);
    expect(guard.attempts.map(shown)).toEqual(['http 203.0.113.9', 'http example.net:8443', 'socket no-such-host.invalid:80', 'socket example.org:443']);
  });

  it('passes http.get to the test\'s own server', async () => {
    const server = await localServer();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        httpGet(server.url, response => { let text = ''; response.on('data', chunk => { text += String(chunk); }); response.on('end', () => resolve(text)); }).on('error', reject);
      });
      expect(body).toBe('local ok');
      guard.expectNone();
    } finally { await server.close(); }
  });

  it('reads the destination out of every shape of http.request arguments, with options overriding the URL', () => {
    expect(requestTarget(['http://a.example:8080/x?y=1'])).toEqual({ host: 'a.example', port: 8080 });
    expect(requestTarget([new URL('https://b.example/')])).toEqual({ host: 'b.example', port: null });
    expect(requestTarget([{ host: 'c.example', port: 81 }, () => undefined])).toEqual({ host: 'c.example', port: 81 });
    expect(requestTarget([{ hostname: 'd.example', host: 'ignored.example' }])).toEqual({ host: 'd.example', port: null });
    expect(requestTarget(['http://e.example/', { host: 'f.example' }, () => undefined])).toEqual({ host: 'f.example', port: null });
    expect(requestTarget([{ path: '/only' }])).toEqual({ host: 'localhost', port: null });
    expect(requestTarget([{ port: 3000 }])).toEqual({ host: 'localhost', port: 3000 });
    expect(requestTarget([{ socketPath: '/tmp/x.sock' }])).toBeNull();
  });

  it('lets a raw loopback socket and a named pipe path through', async () => {
    const server = await localServer();
    try {
      const socket = netConnect(server.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.destroy();
      expect(guard.attempts).toEqual([]);
    } finally { await server.close(); }
    // Not connectable here, but a pipe or unix-socket path is local by definition and must reach the real connect (which then fails on its own).
    const pipe = netConnect(process.platform === 'win32' ? '\\\\.\\pipe\\agent-town-helpers-none' : join(tmpdir(), 'agent-town-helpers-none.sock'));
    expect(await socketError(pipe)).not.toBeInstanceOf(NetworkBlockedError);
    expect(guard.attempts).toEqual([]);
  });

  it('classifies loopback and outside hosts, including every IPv6 spelling of ::1', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.5.6.7', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::ffff:7f00:1]', '::ffff:127.255.255.255', '::ffff:7fff:ffff']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['example.com', '127.example.com', '128.0.0.1', '10.0.0.1', '192.168.1.5', '169.254.169.254', '::2', '2001:db8::1', '0.0.0.0', 'localhost.example.com', 'notlocalhost', '']) expect(isLoopbackHost(host), host).toBe(false);
    // IPv4-mapped addresses are loopback only when they map to 127.x.x.x: ::ffff:7f:1 is 0.127.0.1, ::ffff:8000:1 is 128.0.0.1, ::ffff:a00:1 is 10.0.0.1.
    for (const host of ['::ffff:7f:1', '[::ffff:7f:1]', '::ffff:8000:1', '::ffff:7e00:1', '::ffff:a00:1', '::ffff:0.127.0.1', '::7f00:1']) expect(isLoopbackHost(host), host).toBe(false);
  });

  it('reads the destination out of every shape of Socket.connect arguments', () => {
    expect(connectTarget([{ port: 443, host: 'example.com' }])).toEqual({ host: 'example.com', port: 443 });
    expect(connectTarget([{ port: 80 }])).toEqual({ host: 'localhost', port: 80 });
    expect(connectTarget([{ host: 'a.example', port: '8443' }])).toEqual({ host: 'a.example', port: 8443 });
    expect(connectTarget([80, 'example.org'])).toEqual({ host: 'example.org', port: 80 });
    expect(connectTarget(['8080'])).toEqual({ host: 'localhost', port: 8080 });
    expect(connectTarget([[{ host: 'b.example', port: 1 }, () => undefined]])).toEqual({ host: 'b.example', port: 1 });
    expect(connectTarget([{ path: '\\\\.\\pipe\\x' }])).toBeNull();
    expect(connectTarget(['/tmp/x.sock'])).toBeNull();
  });

  it('nests: only the newest guard records, take() acknowledges, and the network patches come off with the last guard', async () => {
    const inner = noNetwork();
    await fetch('https://inner.example/').catch(() => undefined);
    expect(inner.attempts.map(attempt => attempt.host)).toEqual(['inner.example']);
    expect(guard.attempts).toEqual([]); // the outer guard never saw it
    expect(inner.take()).toHaveLength(1);
    inner.expectNone();
    inner.restore(); inner.restore(); // safe twice
    await fetch('https://outer.example/').catch(() => undefined);
    expect(guard.blockedHosts()).toEqual(['outer.example']); // back to the outer guard
    guard.take();
  });
});

describe('the file-wide network guard (vitest.config.ts setupFiles)', () => {
  it('is installed before any test runs, and records an outside call that the code under test swallowed', async () => {
    expect(activeNetworkGuards()).toBeGreaterThanOrEqual(1);
    const fileWide = (globalThis as unknown as Record<symbol, NoNetwork | undefined>)[Symbol.for('agent-town.tests.globalNetworkGuard')];
    expect(fileWide, 'tests/helpers/setup.ts must be listed in vitest.config.ts setupFiles').toBeDefined();
    await fetch('https://swallowed.example/').catch(() => undefined); // the caller "handles" the error, as production code often does
    expect(fileWide!.attempts.map(attempt => attempt.host)).toEqual(['swallowed.example']);
    fileWide!.take(); // acknowledged; left in place, the afterEach in setup.ts would fail this test
  });
});

describe('assertNoRefused (the check the file-wide guard runs after every test and every file)', () => {
  it('throws naming every refused host and port when a refusal was never taken, and empties the guard so one swallowed call fails one test only', async () => {
    const guard = noNetwork();
    try {
      await fetch('https://swallowed.example:8443/private/path?token=never-shown').catch(() => undefined);
      await fetch('https://second.example/').catch(() => undefined);
      let message = '';
      try { assertNoRefused(guard, 'during this test'); } catch (error) { message = (error as Error).message; }
      expect(message).toContain('Outbound network access was attempted during this test: fetch swallowed.example:8443, fetch second.example.');
      expect(message).not.toMatch(/private|never-shown/);
      expect(() => assertNoRefused(guard, 'again')).not.toThrow();
      expect(guard.attempts).toEqual([]);
    } finally { guard.restore(); }
  });

  it('stays silent when nothing was refused, after take() acknowledges a refusal, and for loopback calls', async () => {
    const guard = noNetwork(), server = await localServer();
    try {
      assertNoRefused(guard, 'untouched');
      await fetch(server.url).then(response => response.text());
      assertNoRefused(guard, 'after a loopback call');
      await fetch('https://expected.example/').catch(() => undefined);
      expect(guard.take()).toHaveLength(1);
      assertNoRefused(guard, 'after take()');
    } finally { guard.restore(); await server.close(); }
  });
});

// The afterEach/afterAll hooks in tests/helpers/setup.ts are what turn a swallowed outside call into a failing test. A unit test
// of assertNoRefused() alone would stay green if someone deleted those two lines, so the fixture specs in tests/helpers/fixtures
// are run for real, through a child vitest process that uses this repository's own vitest.config.ts (same setupFiles), and the
// report is read back. Mutation check (2026-09-24, scratch copy of the tree): with the afterEach line deleted from setup.ts the first
// test below fails, with the afterAll line deleted the second fails, with both deleted both fail, and with assertNoRefused() made
// to never throw those two fail as well as its own unit test.
interface FixtureResult { title: string; status: string; failureMessages: string[] }
interface FixtureFile { name: string; status: string; message?: string; assertionResults: FixtureResult[] }
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function runFixtureSpecs(): Promise<{ files: FixtureFile[]; output: string }> {
  const outputFile = join(tempFolder('fixture-run'), 'report.json');
  const environment: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1' };
  for (const name of Object.keys(environment)) if (name.startsWith('VITEST') || name === 'FORCE_COLOR') delete environment[name];
  const args = [join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'tests/helpers/fixtures/guard-fixture.vitest.config.ts', '--reporter=verbose', '--reporter=json', `--outputFile.json=${outputFile}`];
  // Some fixtures fail on purpose, so the child exits 1: what counts is the report it wrote.
  const output = await promisify(execFile)(process.execPath, args, { cwd: REPO_ROOT, env: environment, windowsHide: true, timeout: 150_000, maxBuffer: 16 * 1024 * 1024 })
    .then(result => `${result.stdout}${result.stderr}`, (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`);
  if (!existsSync(outputFile)) throw new Error(`The fixture vitest run wrote no report. Its output ended: ${output.slice(-1500)}`);
  return { files: (JSON.parse(readFileSync(outputFile, 'utf8')) as { testResults: FixtureFile[] }).testResults, output };
}

describe('the file-wide network guard, proved through a real vitest run of fixture specs', () => {
  let run: Awaited<ReturnType<typeof runFixtureSpecs>>;
  beforeAll(async () => { run = await runFixtureSpecs(); }, 180_000);
  const fileNamed = (name: string) => {
    const file = run.files.find(item => item.name.split('\\').join('/').endsWith(`/tests/helpers/fixtures/${name}`));
    if (!file) throw new Error(`The fixture run has no report for ${name}: ${run.files.map(item => item.name).join(', ')}`);
    return file;
  };
  const testStartingWith = (file: FixtureFile, prefix: string) => {
    const found = file.assertionResults.find(result => result.title.startsWith(prefix));
    if (!found) throw new Error(`No fixture test starts with "${prefix}" in ${file.name}`);
    return found;
  };

  it('fails a test whose code caught and swallowed a blocked outside call, names the host and port, and leaves the tests around it alone', () => {
    const file = fileNamed('swallowed-in-test.fixture.ts');
    const swallowed = testStartingWith(file, 'SWALLOWED:');
    expect(swallowed.status).toBe('failed');
    expect(swallowed.failureMessages.join('\n')).toContain('Outbound network access was attempted during or just before this test: fetch swallowed-in-test.invalid.');
    expect(swallowed.failureMessages.join('\n')).not.toContain('some/secret/path');
    const twice = testStartingWith(file, 'SWALLOWED TWICE');
    expect(twice.status).toBe('failed');
    expect(twice.failureMessages.join('\n')).toContain('fetch first-of-two.invalid, fetch second-of-two.invalid:8443');
    // A test that expected its refusal (noNetwork() + take()), and clean tests before and after the failures, pass.
    for (const prefix of ['CLEAN AFTER', 'TAKEN', 'CLEAN LAST']) expect(testStartingWith(file, prefix).status, prefix).toBe('passed');
  });

  it('fails the file when a swallowed outside call happens outside any test, in an afterAll', () => {
    const file = fileNamed('swallowed-after-last-test.fixture.ts');
    expect(file.status).toBe('failed');
    expect(file.message).toContain('Outbound network access was attempted outside any test: fetch swallowed-after-last-test.invalid.');
    expect(testStartingWith(file, 'CLEAN').status).toBe('passed'); // the test itself was fine; only the file is failed
  });

  it('shows every real-tool and platform skip in the report with its written reason, and still runs what is allowed', () => {
    const other = process.platform === 'win32' ? 'linux' : 'win32';
    const file = fileNamed('skip-reasons.fixture.ts');
    expect(file.assertionResults.filter(result => result.status === 'skipped')).toHaveLength(5);
    expect(testStartingWith(file, 'PLATFORM TEST that runs here').status).toBe('passed');
    const shown = (reason: string) => run.output.split(`[${reason}]`).length - 1;
    expect(shown('Skipped: needs a real fixture tool. Set AGENT_TOWN_FIXTURE_NEVER_SET=1 to run it.')).toBe(1);
    expect(shown('Skipped: needs a real fixture window. Set AGENT_TOWN_FIXTURE_NEVER_SET=1 to run it.')).toBe(2); // one per test in the gated suite
    expect(shown(`Skipped: needs the fixture window system. It runs only on ${other} (this is ${process.platform}).`)).toBe(1);
    expect(shown(`Skipped: fixture suite for another platform. It runs only on ${other} (this is ${process.platform}).`)).toBe(1);
  });
});

// A compact copy of the manager fixture from manager-timer.test.ts, so modelSpy is proved on the real service.
const fixtureKey = 'sk-fixture_credential_for_helper_tests';
const fakeApp = { get() {}, post() {}, patch() {}, log: { error() {} } } as unknown as FastifyInstance;
function workflowFixture(provider: ReturnType<typeof modelSpy>['provider']) {
  const seed: TownState = { schemaVersion: 1, workspace: { id: 'workspace-helpers', name: 'Private', mode: 'private' }, simulation: { running: false, step: 0 },
    repositories: [{ id: 'repo', name: 'Repo', description: '', language: 'TypeScript', branch: 'main', color: '#abc', position: [0, 0] }],
    agents: [], handoffs: [], activity: [], manager: { version: 0, brief: '', updatedAt: null } };
  const store = new Store(':memory:', seed);
  const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (id, value) => { secrets.set(id, value); }, get: async id => secrets.get(id) ?? null, delete: async id => { secrets.delete(id); } };
  const handle = registerWorkflowApi(fakeApp, { scoped: () => store, stores: () => [store], vault, provider });
  const service = handle.service(store);
  const model: WorkflowModel = { model: 'economy-test-model', contextWindowTokens: 16000, inputPerMillionMicroUsd: 1_000_000, outputPerMillionMicroUsd: 1_000_000,
    cachedInputPerMillionMicroUsd: 100_000, cacheWritePerMillionMicroUsd: 200_000, priceSource: 'https://example.test/pricing', priceCheckedAt: new Date().toISOString(), qualityStatus: 'user-attested', qualityNote: 'Fixture human review; no real model evaluation.' };
  const enable = async () => {
    await service.connectApi({ provider: 'openai', label: 'Account', apiKey: fixtureKey }, 'connection-helpers');
    service.configurePolicy({ paidEnabled: true, dailyBudgetMicroUsd: 1_000_000, managerDailyBudgetMicroUsd: 1_000_000, maxRunBudgetMicroUsd: 1_000_000, workerConcurrency: 1, timeZone: 'UTC' }, 'policy');
    const config: ManagerConfig = { enabled: true, connectionId: service.state().connections[0].id, model, maxInputTokens: 4000, maxOutputTokens: 800, requestBudgetMicroUsd: 1_000_000, automatic: false };
    service.configureManager(config, 'manager-config');
  };
  const addReport = () => store.commit('report-one', state => {
    state.handoffs.push({ id: 'report-one', repoId: 'repo', agentId: 'external-agent', summary: 'Worker report body.', createdAt: new Date().toISOString(), status: 'saved', contextVersion: null, delivery: 'unsupported' }); return 'handoff.saved';
  });
  return { store, service, handle, enable, addReport, close: async () => { await handle.close(); store.close(); } };
}
const usage: WorkflowUsage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, source: 'provider-reported' };
const connection: WorkflowConnection = { id: 'c', provider: 'openai', mode: 'api', label: 'x', status: 'verified', verifiedAt: '', createdAt: '', accountIdentity: 'unavailable', models: ['economy-test-model'], capabilities: { manager: true, managedExecution: false } };

describe('modelSpy', () => {
  it('reports 0 for an untouched provider', () => {
    const spy = modelSpy();
    expect(spy.count()).toBe(0); expect(spy.paidCount).toBe(0); expect(spy.calls).toEqual([]);
    spy.expectNone();
  });

  it('counts each method, keeps the request text but never the API key, and separates paid inference from free calls', async () => {
    const spy = modelSpy({ verify: async () => ({ models: ['m'] }), countInput: async () => 7, summarize: async () => ({ text: '{}', usage, requestId: 'r', complete: true }) });
    await spy.provider.verify({ provider: 'openai', label: 'Account', apiKey: fixtureKey });
    await spy.provider.countInput(connection, fixtureKey, { model: 'm', input: 'count this', maxOutputTokens: 10 });
    await spy.provider.summarize(connection, fixtureKey, { model: 'm', input: 'summarise this', maxOutputTokens: 10 });
    expect(spy.count()).toBe(3); expect(spy.count('verify')).toBe(1); expect(spy.count('countInput')).toBe(1); expect(spy.count('summarize')).toBe(1); expect(spy.paidCount).toBe(1);
    expect(spy.calls.map(call => call.input)).toEqual([null, 'count this', 'summarise this']);
    expect(JSON.stringify(spy.calls)).not.toContain(fixtureKey);
    expect(() => spy.expectNone()).toThrow(/3 were made: verify, countInput, summarize/);
    spy.reset(); expect(spy.count()).toBe(0);
  });

  it('refuses by default, and a caller that swallows the refusal is still counted', async () => {
    const spy = modelSpy();
    await expect(spy.provider.summarize(connection, fixtureKey, { model: 'm', input: 'x', maxOutputTokens: 1 })).rejects.toBeInstanceOf(ModelCallBlockedError);
    await spy.provider.verify({ provider: 'openai', label: 'Account', apiKey: fixtureKey }).catch(() => undefined);
    expect(spy.count()).toBe(2); expect(spy.paidCount).toBe(1);
  });

  it('is proved on the real service: state and policy reads make 0 calls, connecting an account 1 free call, and an explicit Process 1 count plus 1 paid call', async () => {
    const spy = modelSpy({ verify: async () => ({ models: ['economy-test-model'] }), countInput: async () => 1,
      summarize: async request => ({ complete: true, requestId: 'req', usage, text: JSON.stringify({ overview: 'ok', repoBriefs: [{ repoId: 'repo', brief: 'ok' }], processedReportIds: (JSON.parse(request.input) as { reports: { id: string }[] }).reports.map(report => report.id), blockers: [], proposals: [] }) }) });
    const fixture = workflowFixture(spy.provider);
    try {
      expect(fixture.service.state().connections).toEqual([]); // reading state, an untouched flow
      expect(spy.count()).toBe(0);
      await fixture.enable();
      fixture.addReport();
      expect(spy.count('verify')).toBe(1); expect(spy.count('countInput')).toBe(0); expect(spy.paidCount).toBe(0); // connecting verifies the key and starts no paid work
      await fixture.service.processManager('explicit-helpers');
      expect(spy.count('countInput')).toBe(1); expect(spy.paidCount).toBe(1); expect(spy.count()).toBe(3);
      expect(fixture.store.snapshot().state.handoffs[0].status).toBe('processed');
    } finally { await fixture.close(); }
  });

  it('is proved on the real service in the other direction: a manager that is never enabled makes 0 calls however long it is left', async () => {
    vi.useFakeTimers();
    const spy = modelSpy(); const fixture = workflowFixture(spy.provider);
    try {
      fixture.addReport();
      await vi.advanceTimersByTimeAsync(10 * 30_000); // ten scheduling ticks of the real manager timer
      spy.expectNone();
    } finally { await fixture.close(); vi.useRealTimers(); }
  });
});

describe('spawnSpy', () => {
  let spy: ReturnType<typeof spawnSpy>;
  beforeEach(() => { spy = spawnSpy(); });
  afterEach(() => { spy.restore(); });

  it('reports 0 for an untouched flow', () => {
    expect(spy.count()).toBe(0); expect(spy.launches).toEqual([]); expect(spy.blocked).toEqual([]);
    spy.expectNone();
  });

  it('lets git run and records it by executable with its arguments', async () => {
    expect(execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })).toContain('git version');
    const { stdout } = await promisify(execFile)('git', ['--version'], { windowsHide: true }); // promisify called after the spy exists still yields { stdout }
    expect(stdout).toContain('git version');
    expect(spy.launchesOf('git')).toMatchObject([{ executable: 'git', args: ['--version'], via: 'execFileSync', allowed: true }, { executable: 'git', via: 'execFile', allowed: true }]);
    expect(spy.blocked).toEqual([]);
    spy.expectOnly('git');
    expect(() => spy.expectNone()).toThrow(/2 happened: git \(execFileSync\), git \(execFile\)/);
  });

  it('refuses tool launchers before they start, in every launch form, and still records them', () => {
    expect(() => spawn('codex', ['--version'])).toThrow(SpawnBlockedError);
    expect(() => execFile('C:\\Users\\someone\\AppData\\Roaming\\npm\\claude.cmd', ['--version'], () => undefined)).toThrow(SpawnBlockedError);
    expect(() => exec('"C:\\Program Files\\cursor\\cursor.exe" --version', () => undefined)).toThrow(SpawnBlockedError);
    expect(() => execSync('copilot --version')).toThrow(SpawnBlockedError);
    expect(() => fork('./helper.js')).toThrow(SpawnBlockedError);
    expect(spy.launches.map(launch => `${launch.executable}:${launch.via}`)).toEqual(['codex:spawn', 'claude:execFile', 'cursor:exec', 'copilot:execSync', 'node:fork']);
    expect(spy.blocked).toHaveLength(5);
    expect(spy.launchesOf('CODEX.exe', 'Claude')).toHaveLength(2);
    expect(() => spy.expectOnly('git')).toThrow(/also saw: codex \(spawn\)/);
  });

  it('judges every executable in a chained shell command line, so a tool run after an allowed git is still recorded and refused', () => {
    // Before: only the first word was judged, so 'git --version && echo second-command-ran' ran, was recorded as git, and launchesOf('echo') was empty.
    const separators = ['git --version && echo second-command-ran', 'git --version || echo second-command-ran', 'git --version | echo second-command-ran', 'git --version & echo second-command-ran'];
    if (process.platform !== 'win32') separators.push('git --version; echo second-command-ran'); // in cmd.exe a ; does not separate commands
    for (const line of separators) expect(() => exec(line, () => undefined), line).toThrow(/Blocked launch of 'echo' \(exec\)/);
    // (The commands below only ask for versions, so a spy that failed to refuse would still not log in to, or open, a real tool.)
    expect(() => execSync('git --version && codex --version')).toThrow(/Blocked launch of 'codex' \(execSync\)/);
    expect(() => spawn('git', ['--version', '&&', 'claude', '--version'], { shell: true })).toThrow(/Blocked launch of 'claude' \(spawn\)/);
    expect(() => exec('git --version && (echo grouped & codex --version)', () => undefined)).toThrow(SpawnBlockedError);
    expect(spy.launches[0]).toMatchObject({ executable: 'git', executables: ['git', 'echo'], via: 'exec', allowed: false, refused: ['echo'] });
    expect(spy.launchesOf('echo')).toHaveLength(separators.length + 1);
    expect(spy.launchesOf('CODEX.exe')).toHaveLength(2);
    expect(spy.launchesOf('claude')).toHaveLength(1);
    expect(spy.launchesOf('git')).toHaveLength(separators.length + 3);
    expect(spy.blocked).toHaveLength(separators.length + 3);
    expect(() => spy.expectOnly('git')).toThrow(/also saw: git \+ echo \(exec\)/);
  });

  it('lets an allowed chain run, and records the second executable as a launch of its own', () => {
    spy.restore(); // a second spy must not sit behind this one: the older one would refuse echo again
    const wide = spawnSpy({ allow: ['git', 'echo'] });
    try {
      const output = execSync('git --version && echo chained-ok', { encoding: 'utf8', windowsHide: true });
      expect(output).toContain('git version'); expect(output).toContain('chained-ok');
      expect(wide.launchesOf('echo')).toMatchObject([{ executables: ['git', 'echo'], via: 'execSync', allowed: true, refused: [] }]);
      expect(wide.blocked).toEqual([]);
      wide.expectOnly('git', 'echo');
    } finally { wide.restore(); }
  });

  it('reads the command a shell is told to run, and refuses a tool hidden behind cmd /c or sh -c', () => {
    spy.restore();
    const wide = spawnSpy({ allow: ['git', 'cmd', 'sh'] });
    try {
      expect(() => execFile('cmd.exe', ['/c', 'git --version && codex --version'], () => undefined)).toThrow(/Blocked launch of 'codex' \(execFile\)/);
      expect(() => spawn('sh', ['-c', 'git --version; claude --version'])).toThrow(/Blocked launch of 'claude' \(spawn\)/);
      expect(wide.launches.map(launch => launch.executables)).toEqual([['cmd', 'git', 'codex'], ['sh', 'git', 'claude']]);
    } finally { wide.restore(); }
  });

  it('reads the executables out of a command line the way the shell that will run it does (cmd.exe on win32, a POSIX shell elsewhere)', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const executables = (line: string) => commandLineExecutables(line, platform);
      expect(executables('git a && codex b || claude c | cursor d & copilot e'), platform).toEqual(['git', 'codex', 'claude', 'cursor', 'copilot']);
      expect(executables('git status\ncodex login'), platform).toEqual(['git', 'codex']);
      expect(executables('git log 2>&1 && git status &> out.txt'), platform).toEqual(['git']); // redirections are not commands
      expect(executables('"C:\\Program Files\\Git\\cmd\\git.exe" status && "C:\\tools\\codex.cmd" login'), platform).toEqual(['git', 'codex']);
      expect(executables('git commit -m "one && two; three | four"'), platform).toEqual(['git']); // inside double quotes an operator is text
      expect(executables('git log --format=%(refname) -5'), platform).toEqual(['git']); // a ( inside a word is text, not a group
      expect(executables('echo $(codex --version)'), platform).toEqual(['echo', 'codex']);
      expect(executables('echo "$(codex --version)"'), platform).toEqual(['echo', 'codex']);
      expect(executables('echo $(echo $(claude --version))'), platform).toEqual(['echo', 'claude']);
      expect(executables('(git status & codex login)'), platform).toEqual(['git', 'codex']);
      // The command handed to a shell is read in THAT shell's syntax, whichever shell started it: cmd's for cmd, POSIX for sh and the rest.
      expect(executables('cmd /c "git --version && codex"'), platform).toEqual(['cmd', 'git', 'codex']);
      expect(executables('cmd.exe /d /s /c "git status & claude"'), platform).toEqual(['cmd', 'git', 'claude']);
      expect(executables('bash -c "git status; codex login"'), platform).toEqual(['bash', 'git', 'codex']);
      expect(executables('sh -lc "codex"'), platform).toEqual(['sh', 'codex']);
      // PowerShell scripts are not command lines and are not read (the header says so): the launch is judged as 'powershell' only.
      expect(executables('powershell -NoProfile -Command "git status; codex login"'), platform).toEqual(['powershell']);
      expect(executables('   '), platform).toEqual([]);
    }
    // A ; separates commands in a POSIX shell but not in cmd.exe, and a ( group ends at its ) in both.
    expect(commandLineExecutables('git a ; codex b', 'linux')).toEqual(['git', 'codex']);
    expect(commandLineExecutables('git a ; codex b', 'win32')).toEqual(['git']);
    expect(commandLineExecutables('(git status; codex login)', 'linux')).toEqual(['git', 'codex']);
    // Quoting differs by shell: cmd.exe has no single quotes and escapes with ^, a POSIX shell has both and escapes with a backslash.
    expect(commandLineExecutables('echo it\'s && codex', 'win32')).toEqual(['echo', 'codex']);
    expect(commandLineExecutables('echo a ^&& codex', 'win32')).toEqual(['echo', 'codex']); // the ^& is a literal &, and the second & separates
    expect(commandLineExecutables('git commit -m \'one && two\'', 'linux')).toEqual(['git']);
    expect(commandLineExecutables('echo \'$(codex)\' && git status', 'linux')).toEqual(['echo', 'git']);
    expect(commandLineExecutables('echo one\\;codex', 'linux')).toEqual(['echo']);
    expect(commandLineExecutables('echo `codex --version`', 'linux')).toEqual(['echo', 'codex']);
    expect(commandLineExecutables('CODEX_HOME=x FOO=bar codex login', 'linux')).toEqual(['codex']);
    expect(commandLineExecutables('set FOO=bar && git status', 'win32')).toEqual(['set', 'git']);
  });

  it('sees launches made by the service\'s own source modules, and honours a wider allow list', async () => {
    const home = tempFolder('home'), repo = tempFolder('repo');
    const result = await discoverNativeSessions({ provider: 'claude', homePath: home, repoPath: repo });
    // The real reader starts a metadata helper (node). With node not allowed it never starts, and the read reports itself unavailable.
    expect(result.status).toBe('unavailable');
    expect(spy.launchesOf('node')).toMatchObject([{ executable: 'node', via: 'spawn', allowed: false }]);
    expect(spy.launchesOf('node')[0].args.join(' ')).toContain('metadata-worker.mjs');
  });

  it('stops recording and puts the real functions back on restore()', () => {
    spy.restore();
    expect(execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })).toContain('git version');
    expect(spy.count()).toBe(0);
  });

  it('normalises executable names from paths, extensions and quoted command lines', () => {
    expect(executableName('C:\\Program Files\\Git\\cmd\\git.exe')).toBe('git');
    expect(executableName('/usr/bin/Codex')).toBe('codex');
    expect(executableName('claude.CMD')).toBe('claude');
    expect(executableName('node')).toBe('node');
  });
});

describe('sessionReadSpy', () => {
  it('reports 0 for an untouched flow and restores the real reader', async () => {
    const spy = sessionReadSpy();
    spy.expectNone(); expect(spy.count()).toBe(0);
    spy.restore();
    // With the spy gone the real function runs again (an unsupported provider answers immediately, starting nothing).
    expect(await discoverNativeSessions({ provider: 'custom', homePath: 'x', repoPath: 'y' })).toMatchObject({ status: 'unsupported' });
    expect(spy.count()).toBe(0);
  });

  it('counts a direct read and answers with a stub that never touches a profile', async () => {
    const spy = sessionReadSpy();
    try {
      const result = await discoverNativeSessions({ provider: 'codex', homePath: 'H:\\profile', repoPath: 'R:\\repo', includeOlder: true, cursor: 'c' });
      expect(result).toMatchObject({ status: 'unavailable', sessions: [] });
      expect(spy.reads).toEqual([{ provider: 'codex', homePath: 'H:\\profile', repoPath: 'R:\\repo', includeOlder: true, hasCursor: true }]);
      expect(() => spy.expectNone()).toThrow(/1 were attempted: codex/);
    } finally { spy.restore(); }
  });

  it('is proved on the real routes: connecting a profile reads 0 sessions and starts nothing, and only the explicit scan makes 1 read', async () => {
    const profile = isolatedProfile();
    const reads = sessionReadSpy(), launches = spawnSpy(), network = noNetwork(), model = modelSpy(), canary = secretCanary();
    const repo = tempFolder('repo'), home = join(profile.home, 'codex-profile');
    mkdirSync(home, { recursive: true });
    const state = privateState({ id: 'helpers-workspace', name: 'Fixture', kind: 'personal' });
    state.discovery!.roots = [repo];
    state.repositories = [{ id: 'project-one', name: 'Project', source: 'local', localPath: repo, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [0, 0] }];
    const store = new Store(':memory:', state), app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    registerNativeApi(app, () => ({ ownerId: 'owner', store }));
    const prefix = '/api/v1/workspaces/helpers-workspace/observation';
    try {
      canary.plantEnv('AGENT_TOWN_HELPERS_CANARY');
      // Connect: list the tools, register the profile. Neither may read a session, start a process, use the network or call a model.
      const setup = await app.inject({ method: 'GET', url: `${prefix}/native-setup` });
      expect(setup.statusCode).toBe(200);
      const registered = await app.inject({ method: 'POST', url: `${prefix}/native-sources`, payload: { provider: 'codex', label: 'Selected local profile', homePath: home } });
      expect(registered.statusCode).toBe(200);
      expect(reads.count()).toBe(0); launches.expectNone(); network.expectNone(); model.expectNone(); profile.expectNoRealAccess();
      canary.expectAbsent({ setup: setup.json(), registered: registered.json(), state: store.snapshot().state });
      // The mutation: the same flow plus the user's explicit scan. Now the spy must see exactly one session read, and still no launch.
      const scan = await app.inject({ method: 'POST', url: `${prefix}/native-sources/${registered.json().id}/scan`, payload: { repoId: 'project-one' } });
      expect(scan.statusCode).toBe(503); // the stub answers 'unavailable'
      expect(reads.count()).toBe(1);
      expect(reads.reads[0]).toMatchObject({ provider: 'codex', includeOlder: false, hasCursor: false });
      launches.expectNone(); network.expectNone(); model.expectNone();
    } finally {
      await app.close(); store.close(); canary.restore(); model.reset(); network.restore(); launches.restore(); reads.restore(); profile.restore();
    }
  });
});

describe('sessionReadSpy is the main door, not the only one', () => {
  // Documents what the header of session-read-spy.ts says. detectedTools() (run by GET native-setup, the connect screen) opens
  // Codex's state_5.sqlite to read a version string, and sessionReadSpy cannot see that. If this fails because codexVersion() no
  // longer opens the store, that is good news for the H0 owner: update the two headers (session-read-spy.ts, index.ts) and this test.
  it('cannot see detectedTools() opening the Codex state database for a version, so it is paired with isolatedProfile() and never used alone as proof', () => {
    const profile = isolatedProfile();
    const reads = sessionReadSpy();
    try {
      mkdirSync(profile.codexHome, { recursive: true });
      const database = new Database(join(profile.codexHome, 'state_5.sqlite'));
      database.exec('CREATE TABLE threads (cli_version TEXT)');
      database.prepare('INSERT INTO threads (cli_version) VALUES (?)').run('9.9.9-fixture');
      database.close();
      const codex = detectedTools().find(tool => tool.provider === 'codex');
      expect(codex).toMatchObject({ detected: true, version: '9.9.9-fixture' }); // the session database was opened and read...
      expect(reads.count()).toBe(0); // ...and the spy on the session reader saw nothing
      profile.expectNoRealAccess(); // the isolated profile confined it to the temp folder
    } finally { reads.restore(); profile.restore(); }
  });
});

describe('secretCanary', () => {
  it('makes a fresh, well-shaped fake secret each time', () => {
    const first = secretCanary(), second = secretCanary();
    expect(first.value).toMatch(/^sk-canary-[A-Za-z0-9]{32}$/);
    expect(first.value).not.toBe(second.value);
    expect(secretCanary('github-token').value).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    expect(secretCanary('generic').value).toMatch(/^canary-[0-9a-f]{32}$/);
  });

  it('finds the canary in strings, nested objects, Maps, Sets, Errors, Buffers and its encoded spellings, and reports where without printing it', () => {
    const canary = secretCanary('generic');
    const value = canary.value, base64 = Buffer.from(value).toString('base64'), hex = Buffer.from(value).toString('hex');
    expect(canary.find('nothing here')).toEqual([]);
    expect(canary.find({ headers: { authorization: `Bearer ${value}` } })).toEqual([{ where: '$.headers.authorization', form: 'plain' }]);
    expect(canary.find([{ a: 1 }, { b: [`x ${base64} y`] }], 'response')).toEqual([{ where: 'response.1.b.0', form: 'base64' }]);
    expect(canary.find({ token: hex })).toEqual([{ where: '$.token', form: 'hex' }]);
    expect(canary.find(new Map([[value, 'as a key']]))).toMatchObject([{ where: '$<key 0>', form: 'plain' }]);
    expect(canary.find(new Set([`in ${value}`]))).toEqual([{ where: '$<item 0>', form: 'plain' }]);
    expect(canary.find(new Error('boom', { cause: { detail: value } })).map(hit => hit.where)).toEqual(['$.cause.detail']);
    expect(canary.find(new Error(`failed with ${value}`)).map(hit => hit.where)).toContain('$.message');
    expect(canary.find({ raw: Buffer.from(`prefix ${value}`) })).toEqual([{ where: '$.raw', form: 'plain' }]);
    const circular: Record<string, unknown> = { fine: true }; circular.self = circular; circular.leak = value;
    expect(canary.find(circular)).toEqual([{ where: '$.leak', form: 'plain' }]);
    let failure: Error | null = null;
    try { canary.expectAbsent({ log: `key=${value}` }, 'service log'); } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('service log.log (plain)');
    expect(failure?.message).not.toContain(value);
  });

  it('finds the canary inside longer base64 and base64url text at every byte alignment, and in an HTTP Basic Authorization header', () => {
    // Base64 spells the same secret three ways depending on its byte offset modulo 3, and again depending on what follows it.
    for (const kind of ['api-key', 'github-token', 'generic'] as const) {
      const canary = secretCanary(kind);
      for (const encoding of ['base64', 'base64url'] as const) {
        for (let before = 0; before < 6; before++) {
          for (let after = 0; after < 4; after++) {
            const text = Buffer.from(`${'x'.repeat(before)}${canary.value}${'y'.repeat(after)}`).toString(encoding);
            const hits = canary.find(text), message = `${kind} ${encoding} with ${before} bytes before and ${after} after`;
            expect(hits.map(hit => hit.where), message).toEqual(['$']);
            expect(['base64', 'base64url'], message).toContain(hits[0]?.form); // text with no + / - _ characters is the same in both alphabets, and is reported once
          }
        }
      }
      // The usual way a key hides in a header: base64('user:' + key), five bytes in.
      const basic = `Basic ${Buffer.from(`user:${canary.value}`).toString('base64')}`;
      expect(canary.find({ headers: { authorization: basic } }), kind).toEqual([{ where: '$.headers.authorization', form: 'base64' }]);
      // A different secret of the same shape is not a hit, so a match is about this canary and not about the length.
      expect(canary.find(Buffer.from(`user:${secretCanary(kind).value}`).toString('base64')), kind).toEqual([]);
      expect(canary.find({ headers: { authorization: `Basic ${Buffer.from('user:not-a-secret').toString('base64')}` } }), kind).toEqual([]);
    }
  });

  it('finds the canary in files and file names under a folder, and passes a clean folder', async () => {
    const canary = secretCanary('generic'), clean = tempFolder('clean'), leaky = tempFolder('leaky');
    writeFileSync(join(clean, 'a.txt'), 'nothing secret');
    await expect(canary.expectAbsentFromFiles(clean)).resolves.toBeUndefined();
    mkdirSync(join(leaky, 'logs')); writeFileSync(join(leaky, 'logs', 'service.log'), `started with ${canary.value}\n`);
    await expect(canary.expectAbsentFromFiles(leaky)).rejects.toThrow(/file:logs\/service\.log \(plain\)/);
    writeFileSync(join(clean, `${canary.value}.txt`), 'x');
    await expect(canary.expectAbsentFromFiles(clean)).rejects.toThrow(/file-name:/);
  });

  it('plants an environment variable and captures console output, and restore() undoes both', () => {
    const canary = secretCanary();
    const before = process.env.AGENT_TOWN_CANARY_SELFTEST;
    canary.plantEnv('AGENT_TOWN_CANARY_SELFTEST');
    expect(process.env.AGENT_TOWN_CANARY_SELFTEST).toBe(canary.value);
    const watcher = canary.watchConsole();
    console.log('starting with', { key: canary.value }); console.error('harmless');
    expect(watcher.output()).toHaveLength(2);
    expect(canary.find(watcher.output(), 'console')).toEqual([{ where: 'console.0', form: 'plain' }]);
    canary.restore(); canary.restore();
    expect(process.env.AGENT_TOWN_CANARY_SELFTEST).toBe(before);
    expect(vi.isMockFunction(console.log)).toBe(false);
  });

  it('is proved on the real redaction code: text sanitised without the known secret leaks it, with it does not', () => {
    const canary = secretCanary('generic'); // a shape the pattern-based redaction does not know, so only the known-secret list can remove it
    const report = `worker used ${canary.value} to sign in`;
    expect(canary.find(sanitizeModelText(report))).toHaveLength(1);
    expect(canary.find(sanitizeModelText(report, [canary.value]))).toEqual([]);
    // Model input recorded by modelSpy is searchable the same way.
    const spy = modelSpy({ countInput: async () => 1 });
    void spy.provider.countInput(connection, fixtureKey, { model: 'm', input: sanitizeModelText(report, [canary.value]), maxOutputTokens: 1 });
    canary.expectAbsent(spy.calls, 'model input');
  });
});

describe('isolatedProfile', () => {
  const machineHome = homedir(); // read before any profile exists

  function fakeRealProfile() {
    const real = tempFolder('real');
    mkdirSync(join(real, '.codex'), { recursive: true }); mkdirSync(join(real, '.claude'), { recursive: true }); mkdirSync(join(real, 'projects'), { recursive: true });
    writeFileSync(join(real, '.codex', 'history.jsonl'), 'real codex history'); writeFileSync(join(real, '.claude.json'), '{"account":"real"}'); writeFileSync(join(real, 'projects', 'notes.txt'), 'ordinary file');
    return real;
  }

  it('points the profile variables at a temp folder and restores them exactly', () => {
    const names = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'COPILOT_HOME', 'XDG_CONFIG_HOME', 'AGENT_TOWN_DATA_DIR', 'AGENT_TOWN_VAULT_DIR'];
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.AGENT_TOWN_DATA_DIR = 'C:\\somewhere\\real-data';
    const profile = isolatedProfile({ real: { home: fakeRealProfile() } });
    try {
      for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'COPILOT_HOME', 'XDG_CONFIG_HOME']) {
        expect(process.env[name]?.startsWith(profile.root), name).toBe(true);
      }
      expect(homedir()).toBe(profile.home);
      expect(process.env.CODEX_HOME).toBe(profile.codexHome); expect(process.env.CLAUDE_CONFIG_DIR).toBe(profile.claudeConfigDir);
      expect(process.env.AGENT_TOWN_DATA_DIR).toBeUndefined(); expect(process.env.AGENT_TOWN_VAULT_DIR).toBeUndefined();
      expect(() => isolatedProfile()).toThrow(/already active/);
    } finally {
      profile.restore();
      if (before.AGENT_TOWN_DATA_DIR === undefined) delete process.env.AGENT_TOWN_DATA_DIR; else process.env.AGENT_TOWN_DATA_DIR = before.AGENT_TOWN_DATA_DIR;
    }
    for (const name of names.filter(name => name !== 'AGENT_TOWN_DATA_DIR')) expect(process.env[name], name).toBe(before[name]);
    expect(existsSync(profile.root)).toBe(false);
  });

  it('fails a test that reads the real tool folders, in every fs style, and lets ordinary and isolated paths through', async () => {
    const real = fakeRealProfile();
    const profile = isolatedProfile({ real: { home: real } });
    try {
      const codexFile = join(real, '.codex', 'history.jsonl');
      expect(() => readFileSync(codexFile)).toThrow(RealProfileAccessError);
      expect(() => existsSync(join(real, '.claude'))).toThrow(RealProfileAccessError);
      expect(() => readdirSync(join(real, '.codex'))).toThrow(/isolatedProfile\(\) refused readdirSync/);
      expect(() => readFileSync(join(real, '.claude.json'))).toThrow(RealProfileAccessError);
      expect(() => createReadStream(codexFile)).toThrow(RealProfileAccessError);
      await expect(readFile(codexFile, 'utf8')).rejects.toBeInstanceOf(RealProfileAccessError);
      await expect(opendir(join(real, '.codex'))).rejects.toBeInstanceOf(RealProfileAccessError);
      const viaCallback = await new Promise<unknown>(resolve => { readFileCallback(codexFile, error => resolve(error)); });
      expect(viaCallback).toBeInstanceOf(RealProfileAccessError);
      expect(profile.blockedAccesses.map(access => access.operation)).toEqual(['readFileSync', 'existsSync', 'readdirSync', 'readFileSync', 'createReadStream', 'readFile', 'opendir', 'readFile']);
      // Precision: an ordinary file beside the tool folders, and the profile's own folders, still work.
      expect(readFileSync(join(real, 'projects', 'notes.txt'), 'utf8')).toBe('ordinary file');
      mkdirSync(profile.codexHome, { recursive: true }); writeFileSync(join(profile.codexHome, 'state.txt'), 'isolated');
      expect(readFileSync(join(profile.codexHome, 'state.txt'), 'utf8')).toBe('isolated');
      expect(() => profile.expectNoRealAccess()).toThrow(/8 were refused/);
      // Nobody acknowledged the refusals, so restore() itself fails the test that swallowed them (the folder is still removed).
      expect(() => profile.restore()).toThrow(/nobody acknowledged/);
      expect(existsSync(profile.root)).toBe(false);
    } finally { profile.take(); profile.restore(); }
    // The mutation: without the profile the same real file is readable again, so it was the guard that stopped it.
    expect(readFileSync(join(real, '.codex', 'history.jsonl'), 'utf8')).toBe('real codex history');
  });

  it('puts everything back when the guard cannot be installed, instead of leaving a half-installed profile behind', () => {
    const real = fakeRealProfile();
    const promiseExports = nodeFs.promises as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(promiseExports, 'statfs')!;
    const before = { home: process.env.HOME, codex: process.env.CODEX_HOME, stat: promiseExports.stat, readFileSync: (nodeFs as unknown as Record<string, unknown>).readFileSync };
    const madeFolders = vi.spyOn(nodeFs, 'mkdtempSync'); // the profile's temp folder is made through this
    // The first read of fs.promises.statfs (by the patching, part way through) throws; later reads (the export sync while undoing) work.
    let armed = true;
    Object.defineProperty(promiseExports, 'statfs', { configurable: true, get() { if (armed) { armed = false; throw new Error('the guard cannot read this export'); } return descriptor.value; } });
    try {
      expect(() => isolatedProfile({ real: { home: real } })).toThrow(/the guard cannot read this export/);
    } finally { Object.defineProperty(promiseExports, 'statfs', descriptor); }
    const created = madeFolders.mock.results.map(result => String(result.value)).filter(path => basename(path).startsWith('agent-town-profile-'));
    madeFolders.mockRestore();
    expect(created).toHaveLength(1);
    expect(existsSync(created[0]!), 'the half-made profile folder is removed').toBe(false);
    expect(process.env.HOME).toBe(before.home); expect(process.env.CODEX_HOME).toBe(before.codex);
    expect(promiseExports.stat, 'a patch made before the failure is undone').toBe(before.stat);
    expect((nodeFs as unknown as Record<string, unknown>).readFileSync, 'and so is one on fs').toBe(before.readFileSync);
    expect(() => readFileSync(join(real, '.codex', 'history.jsonl'))).not.toThrow(); // no leftover guard: the fake real file reads normally
    const again = isolatedProfile({ real: { home: real } }); // not "already active": the failed one never became active
    again.restore();
  });

  it('still puts the variables back and removes its folder when one patch cannot be undone, and then says so', () => {
    const real = fakeRealProfile();
    const promiseExports = nodeFs.promises as unknown as Record<string, unknown>;
    const originalReaddir = promiseExports.readdir, before = { home: process.env.HOME, codex: process.env.CODEX_HOME, readFile: nodeFs.readFile, statSync: nodeFs.statSync };
    const profile = isolatedProfile({ real: { home: real } });
    const guardedReaddir = promiseExports.readdir;
    expect(guardedReaddir).not.toBe(originalReaddir);
    Object.defineProperty(promiseExports, 'readdir', { value: guardedReaddir, writable: false, configurable: true, enumerable: true }); // restore() can no longer put the original back
    try {
      expect(() => profile.restore()).toThrow(TypeError);
      expect(process.env.HOME).toBe(before.home); expect(process.env.CODEX_HOME).toBe(before.codex);
      expect(existsSync(profile.root)).toBe(false);
      expect(nodeFs.readFile, 'every other patch was still undone (fs.readFile)').toBe(before.readFile);
      expect(nodeFs.statSync, 'every other patch was still undone (fs.statSync)').toBe(before.statSync);
      expect(() => readFileSync(join(real, '.codex', 'history.jsonl'))).not.toThrow();
    } finally { Object.defineProperty(promiseExports, 'readdir', { value: originalReaddir, writable: true, configurable: true, enumerable: true }); }
    isolatedProfile({ real: { home: real } }).restore(); // and a new profile can be made
  });

  it('take() acknowledges an expected refusal so restore() succeeds', () => {
    const real = fakeRealProfile();
    const profile = isolatedProfile({ real: { home: real } });
    expect(() => readFileSync(join(real, '.codex', 'history.jsonl'))).toThrow(RealProfileAccessError);
    expect(profile.take()).toHaveLength(1);
    profile.expectNoRealAccess();
    expect(() => profile.restore()).not.toThrow();
  });

  it('also refuses the path-taking fs calls that used to slip through: openAsBlob, exists, glob, globSync, statfs, chown, lchown, lutimes, mkdtempDisposableSync', async () => {
    const real = fakeRealProfile();
    const profile = isolatedProfile({ real: { home: real } });
    const codex = join(real, '.codex'), file = join(codex, 'history.jsonl');
    const refused = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(RealProfileAccessError);
    try {
      await refused(openAsBlob(file)); // used to read the file's content
      expect(() => existsCallback(file, () => undefined)).toThrow(RealProfileAccessError); // its callback has no error argument, so it throws like existsSync
      await refused(promisify(existsCallback)(file));
      expect(() => statfsSync(codex)).toThrow(RealProfileAccessError);
      expect(await new Promise<unknown>(resolve => statfsCallback(codex, error => resolve(error)))).toBeInstanceOf(RealProfileAccessError);
      await refused(statfsPromise(codex));
      expect(() => chownSync(file, 0, 0)).toThrow(RealProfileAccessError);
      expect(() => lchownSync(file, 0, 0)).toThrow(RealProfileAccessError);
      expect(() => lutimesSync(file, 0, 0)).toThrow(RealProfileAccessError);
      await refused(chownPromise(file, 0, 0)); await refused(lchownPromise(file, 0, 0)); await refused(lutimesPromise(file, 0, 0));
      expect(() => mkdtempDisposableSync(join(codex, 'tmp-'))).toThrow(RealProfileAccessError);
      // A glob is refused when it is rooted in a real folder (cwd or the literal start of the pattern), or starts above one and can walk into it.
      expect(() => globSync('*', { cwd: codex })).toThrow(RealProfileAccessError);
      expect(() => globSync(join(codex, '**'))).toThrow(RealProfileAccessError);
      expect(() => globSync(['nothing/*.txt', join(codex, '*.jsonl')])).toThrow(RealProfileAccessError);
      expect(() => globSync('**/*.jsonl', { cwd: real })).toThrow(RealProfileAccessError); // the fake real home is above .codex and ** walks into it
      expect(() => globSync('*/*', { cwd: real })).toThrow(RealProfileAccessError); // two parts reach the files inside .codex
      expect(await new Promise<unknown>(resolve => globCallback('*', { cwd: codex }, error => resolve(error)))).toBeInstanceOf(RealProfileAccessError);
      await refused((async () => { for await (const match of globPromise('*', { cwd: codex })) void match; })()); // fs.promises.glob is an async iterator: the error arrives when it is read
      expect(profile.blockedAccesses.map(access => access.operation)).toEqual([
        'openAsBlob', 'exists', 'exists', 'statfsSync', 'statfs', 'statfs', 'chownSync', 'lchownSync', 'lutimesSync', 'chown', 'lchown', 'lutimes', 'mkdtempDisposableSync',
        'globSync', 'globSync', 'globSync', 'globSync', 'globSync', 'glob', 'glob',
      ]);
      // Precision: a glob inside the isolated profile, one beside the real folders, and one whose folder name only has parentheses, are left alone.
      mkdirSync(profile.codexHome, { recursive: true }); writeFileSync(join(profile.codexHome, 'state.txt'), 'isolated');
      expect(globSync('*.txt', { cwd: profile.codexHome })).toEqual(['state.txt']);
      expect(globSync('*', { cwd: join(real, 'projects') })).toEqual(['notes.txt']);
      expect(globSync(`${join(profile.root, 'Program Files (x86)').split('\\').join('/')}/**`)).toEqual([]);
      expect(profile.blockedAccesses).toHaveLength(20);
    } finally { profile.take(); profile.restore(); }
    // Without the profile the same calls reach the real (fake-real) file again, so it was the guard that stopped them.
    expect(await (await openAsBlob(file)).text()).toBe('real codex history');
  });

  it('lists every function node:fs and node:fs/promises export as guarded or knowingly unguarded, and really wraps and restores the guarded ones', () => {
    const fsExports = nodeFs as unknown as Record<string, unknown>, promiseExports = nodeFs.promises as unknown as Record<string, unknown>;
    for (const [scope, target] of [['fs', fsExports], ['promises', promiseExports]] as const) {
      const exported = Object.keys(target).filter(name => typeof target[name] === 'function');
      const guarded = new Set(GUARDED_FS_EXPORTS[scope]), unguarded = new Set(UNGUARDED_FS_EXPORTS[scope]);
      expect(exported.filter(name => !guarded.has(name) && !unguarded.has(name)), `${scope}: functions in neither list, so nobody decided whether they take a path`).toEqual([]);
      expect([...guarded].filter(name => unguarded.has(name)), `${scope}: in both lists`).toEqual([]);
      expect([...guarded].filter(name => !exported.includes(name) && !name.startsWith('lchmod')), `${scope}: guarded names this Node does not export (lchmod exists only on macOS)`).toEqual([]);
    }
    const originals = new Map<string, unknown>(GUARDED_FS_EXPORTS.fs.map(name => [`fs.${name}`, fsExports[name]]));
    for (const name of GUARDED_FS_EXPORTS.promises) originals.set(`promises.${name}`, promiseExports[name]);
    const profile = isolatedProfile({ real: { home: fakeRealProfile() } });
    try {
      for (const name of GUARDED_FS_EXPORTS.fs) if (typeof originals.get(`fs.${name}`) === 'function') expect(fsExports[name], `fs.${name} is wrapped`).not.toBe(originals.get(`fs.${name}`));
      for (const name of GUARDED_FS_EXPORTS.promises) if (typeof originals.get(`promises.${name}`) === 'function') expect(promiseExports[name], `promises.${name} is wrapped`).not.toBe(originals.get(`promises.${name}`));
    } finally { profile.restore(); }
    for (const [key, original] of originals) expect(key.startsWith('fs.') ? fsExports[key.slice(3)] : promiseExports[key.slice(9)], `${key} is put back`).toBe(original);
  });

  it('by default guards this machine\'s real tool folders, Agent Town data and vault, without reading any of them', () => {
    const profile = isolatedProfile();
    try {
      const expected = ['.codex', '.claude', '.claude.json', '.cursor', '.copilot'].map(name => resolve(machineHome, name));
      for (const path of expected) expect(profile.realFolders).toContain(path);
      expect(profile.realFolders.some(path => path.endsWith('AgentTownCredentials'))).toBe(true);
      expect(profile.realFolders.some(path => path.endsWith('AgentTown'))).toBe(true);
      expect(profile.realFolders.every(path => !path.startsWith(profile.root))).toBe(true);
      // Real code that hardcodes the real home is refused before the file system is touched (the name below does not exist).
      expect(() => readFileSync(join(machineHome, '.codex', 'agent-town-helper-selftest-does-not-exist'))).toThrow(RealProfileAccessError);
      profile.take();
    } finally { profile.restore(); }
  });

  it('is proved on the real tool-detection code: it looks only inside the isolated profile and finds nothing installed', () => {
    const profile = isolatedProfile();
    try {
      const tools = detectedTools();
      expect(tools.map(tool => tool.provider)).toEqual(expect.arrayContaining(['codex', 'claude', 'cursor', 'copilot-cli']));
      for (const tool of tools) {
        if (tool.defaultHomePath) expect(tool.defaultHomePath.startsWith(profile.root), tool.provider).toBe(true);
        expect(tool.detected, tool.provider).toBe(false);
        expect(tool.version).toBeNull();
      }
      profile.expectNoRealAccess();
    } finally { profile.restore(); }
  });
});

describe('runShutdown', () => {
  const sevenSecondJob = [{ name: 'flush', ms: 3_000 }, { name: 'backup', ms: 4_000 }];

  it('records the service\'s real limits (measured from createShutdown itself): 20 s, and 6 s when the console window closes', async () => {
    vi.useFakeTimers();
    try {
      const measured: Record<string, number> = {};
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as ShutdownSignal[]) {
        const shutdown = createShutdown({ close: () => new Promise(() => undefined), release: () => undefined, exit: () => undefined, log: () => undefined });
        const before = Date.now();
        shutdown(signal);
        await vi.advanceTimersToNextTimerAsync();
        measured[signal] = Date.now() - before;
      }
      expect(measured).toEqual({ SIGINT: 20_000, SIGTERM: 20_000, SIGHUP: 6_000 });
      expect(SHUTDOWN_LIMITS_MS).toEqual(measured);
    } finally { vi.useRealTimers(); }
  });

  it('reports a job that needs 7 s as cut off at 6 s when the console window closes, and finished under the 20 s limit', async () => {
    const cut = await runShutdown({ job: stepsJob(sevenSecondJob), signal: 'SIGHUP' });
    expect(cut).toMatchObject({ outcome: 'cut-off', limitMs: 6_000, elapsedMs: 6_000, exitCode: 1, completedSteps: ['flush'], interruptedSteps: ['backup'], skippedSteps: [], lockReleasedBeforeExit: true });
    expect(cut.events).toEqual(['log', 'release', 'exit:1']);
    expect(cut.logs[0]).toContain('longer than 6 seconds');
    const done = await runShutdown({ job: stepsJob(sevenSecondJob), signal: 'SIGINT' });
    expect(done).toMatchObject({ outcome: 'finished', limitMs: 20_000, elapsedMs: 7_000, exitCode: 0, completedSteps: ['flush', 'backup'], interruptedSteps: [], lockReleasedBeforeExit: true });
    expect(done.events).toEqual(['release', 'exit:0']);
    expect(done.logs).toEqual([]);
  });

  it('reports a job that stops at its next step boundary as stopped, not cut off', async () => {
    // The signal arrives 1 s into the 3 s "flush" step: the job finishes it, sees the shutdown and does not start "backup".
    const stopped = await runShutdown({ job: stepsJob(sevenSecondJob, 'stop-at-boundary'), signal: 'SIGHUP', signalAtMs: 1_000 });
    expect(stopped).toMatchObject({ outcome: 'stopped', elapsedMs: 2_000, exitCode: 0, completedSteps: ['flush'], interruptedSteps: [], skippedSteps: ['backup'], lockReleasedBeforeExit: true });
    expect(stopped.logs).toEqual([]);
    expect(stopped.events).toEqual(['release', 'exit:0']);
  });

  it('lets a job that fits its steps into the deadline stop early instead of being cut off, and finish when there is room', async () => {
    const tight = await runShutdown({ job: stepsJob(sevenSecondJob, 'fit-before-deadline'), signal: 'SIGHUP' });
    expect(tight).toMatchObject({ outcome: 'stopped', elapsedMs: 3_000, exitCode: 0, completedSteps: ['flush'], skippedSteps: ['backup'] });
    const roomy = await runShutdown({ job: stepsJob(sevenSecondJob, 'fit-before-deadline'), signal: 'SIGINT' });
    expect(roomy).toMatchObject({ outcome: 'finished', elapsedMs: 7_000, completedSteps: ['flush', 'backup'], skippedSteps: [] });
  });

  it('aims at a chosen step: a kill-at-each-step run over a three-step job shows which step was in flight', async () => {
    // Three 5 s steps and the 6 s console-window limit. The signal arrives at the start of step a, at the start of step b
    // and at the start of step c; the process is ended 6 s after the signal in every case.
    const steps = [{ name: 'a', ms: 5_000 }, { name: 'b', ms: 5_000 }, { name: 'c', ms: 5_000 }];
    const reports: ShutdownReport[] = [];
    for (const signalAtMs of [0, 5_000, 10_000]) reports.push(await runShutdown({ job: stepsJob(steps), signal: 'SIGHUP', signalAtMs }));
    expect(reports.map(report => [report.outcome, report.elapsedMs, report.completedSteps, report.interruptedSteps])).toEqual([
      ['cut-off', 6_000, ['a'], ['b']], // signal at 0 s: a ends at 5 s, b is in flight at the 6 s limit
      ['cut-off', 6_000, ['a', 'b'], ['c']], // signal at 5 s: b ends at 10 s, c is in flight at the 11 s limit
      ['finished', 5_000, ['a', 'b', 'c'], []], // signal at 10 s: c ends at 15 s, inside the 16 s limit
    ]);
  });

  it('cuts off a job that never ends at exactly the limit for each signal, releasing the lock first', async () => {
    for (const [signal, limit] of [['SIGINT', 20_000], ['SIGTERM', 20_000], ['SIGHUP', 6_000]] as const) {
      const report = await runShutdown({ job: () => new Promise(() => undefined), signal });
      expect(report).toMatchObject({ outcome: 'cut-off', elapsedMs: limit, limitMs: limit, exitCode: 1, lockReleasedBeforeExit: true });
      expect(report.logs[0]).toContain(`longer than ${limit / 1000} seconds`);
    }
  });

  it('reports a close step that throws as failed, and one that had already finished before the signal as finished with no wait', async () => {
    const failed = await runShutdown({ job: async () => { throw new Error('close failed'); } });
    expect(failed).toMatchObject({ outcome: 'failed', exitCode: 1, elapsedMs: 0, lockReleasedBeforeExit: true });
    const early = await runShutdown({ job: stepsJob([{ name: 'only', ms: 3_000 }]), signalAtMs: 10_000 });
    expect(early).toMatchObject({ outcome: 'finished', elapsedMs: 0, exitCode: 0, completedSteps: ['only'] });
  });

  it('installs and removes its own fake clock, but leaves one the test already installed', async () => {
    expect(vi.isFakeTimers()).toBe(false);
    await runShutdown({ job: stepsJob([{ name: 'x', ms: 10 }]) });
    expect(vi.isFakeTimers()).toBe(false);
    vi.useFakeTimers();
    try {
      await runShutdown({ job: stepsJob([{ name: 'x', ms: 10 }]) });
      expect(vi.isFakeTimers()).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe('realToolTest', () => {
  it('writes the reason a real-tool test is skipped, and runs it only when switched on for a matching platform', () => {
    const gate = { enabledBy: 'AGENT_TOWN_REAL_CODEX', needs: 'Codex installed and signed in' };
    expect(realToolSkipReason(gate, {}, 'win32')).toBe('Skipped: needs Codex installed and signed in. Set AGENT_TOWN_REAL_CODEX=1 to run it.');
    expect(realToolSkipReason(gate, { AGENT_TOWN_REAL_CODEX: '0' }, 'win32')).toContain('Set AGENT_TOWN_REAL_CODEX=1');
    expect(realToolSkipReason(gate, { AGENT_TOWN_REAL_CODEX: '1' }, 'win32')).toBeNull();
    expect(realToolSkipReason({ ...gate, platform: 'win32' }, { AGENT_TOWN_REAL_CODEX: '1' }, 'linux')).toBe('Skipped: needs Codex installed and signed in, which is only available on win32 (this is linux).');
  });

  it('writes why a test is tied to an operating system, so a platform skip is never bare either', () => {
    expect(platformSkipReason({ only: 'win32', why: 'needs the Windows folder window' }, 'linux')).toBe('Skipped: needs the Windows folder window. It runs only on win32 (this is linux).');
    expect(platformSkipReason({ only: 'win32', why: 'needs the Windows folder window' }, 'win32')).toBeNull();
    expect(platformSkipReason({ not: 'win32', why: 'needs a POSIX executable bit' }, 'win32')).toBe('Skipped: needs a POSIX executable bit. It does not run on win32 (this is win32).');
    expect(platformSkipReason({ not: 'win32', why: 'needs a POSIX executable bit' }, 'linux')).toBeNull();
  });
});
