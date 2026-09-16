import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, ServerResponse, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handoff, StateEvent } from '@agent-town/contracts';
import { createApp } from '../../apps/service/src/app';
import { createStateStream } from '../../apps/service/src/state-stream';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';
import { privateState, WorkspaceStores } from '../../apps/service/src/workspaces';
import type { Store } from '../../apps/service/src/store';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await cleanup?.(); cleanup = undefined; });

function event(cursor: number): StateEvent {
  return { cursor, type: 'report.saved', occurredAt: new Date().toISOString(), state: privateState({ id: 'private-fixture', name: 'Private fixture', kind: 'personal' }) };
}

class BufferedResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  accepts = false;
  frames: string[] = [];
  write(frame: string) { this.frames.push(frame); return this.accepts; }
}

describe('bounded state stream writer', () => {
  it('treats false as accepted output, skips blocked heartbeats, and drains only the newest pending snapshot', () => {
    const response = new BufferedResponse(), close = vi.fn();
    const writer = createStateStream(response as unknown as ServerResponse, { authorized: () => true, close });
    writer.emit(event(1));
    for (let cursor = 2; cursor <= 100; cursor++) { writer.emit(event(cursor)); writer.heartbeat(); }
    expect(close).not.toHaveBeenCalled(); expect(writer.backpressured()).toBe(true);
    expect(response.frames).toHaveLength(1); expect(response.frames[0]).toContain('id: 1\n');
    response.accepts = true; response.emit('drain');
    expect(response.frames).toHaveLength(2); expect(response.frames[1]).toContain('id: 100\n');
    writer.emit(event(99)); expect(response.frames).toHaveLength(2);
    writer.emit(event(101)); expect(response.frames[2]).toContain('id: 101\n');
    writer.dispose(); expect(response.listenerCount('drain')).toBe(0);
  });

  it('drops pending private output on authorization loss and bounds a stalled connection lifetime', async () => {
    const response = new BufferedResponse(); let authorized = true;
    const close = vi.fn(() => writer.dispose());
    const writer = createStateStream(response as unknown as ServerResponse, { authorized: () => authorized, close });
    writer.emit(event(1)); writer.emit(event(2)); authorized = false; response.emit('drain');
    expect(close).toHaveBeenCalledOnce(); expect(response.frames).toHaveLength(1);

    vi.useFakeTimers();
    const stalled = new BufferedResponse(), stopped = vi.fn(() => limited.dispose());
    const limited = createStateStream(stalled as unknown as ServerResponse, { authorized: () => true, close: stopped, stallTimeoutMs: 30 });
    limited.emit(event(1)); await vi.advanceTimersByTimeAsync(20);
    limited.emit(event(2)); await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toHaveBeenCalledOnce(); expect(stalled.frames).toHaveLength(1);
    stalled.emit('drain'); expect(stalled.frames).toHaveLength(1);
  });
});

async function fixture() {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}`;
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-sse-'));
  let now = Date.now(); const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { secrets.set(key, value); }, get: async key => secrets.get(key) ?? null, delete: async key => { secrets.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device', userCode: 'SSE-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: 'fixture-token', expiresIn: 3600 }),
    verifyUser: async () => ({ id: '101', login: 'sse-fixture', displayName: 'Fixture owner', avatarUrl: null }),
    listRepositories: async () => { throw new Error('SSE tests never fetch a real repository.'); },
  };
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'fixture-client-id', now: () => now });
  // Observe the actual, ownership-checked Store without replacing its behavior.
  const opened = vi.spyOn(WorkspaceStores.prototype, 'get');
  const instance = await createApp({ database: ':memory:', privateDirectory: directory, identity, vault, port, simulationInterval: 600000,
    workflowProvider: { verify: async () => { throw new Error('No connection verification expected.'); }, countInput: async () => { throw new Error('No token counting expected.'); }, summarize: async () => { throw new Error('No inference expected.'); } },
    runExecutor: { preflight: async () => { throw new Error('No native execution expected.'); }, subscription: async () => { throw new Error('No native account expected.'); }, execute: async () => { throw new Error('No managed execution expected.'); } },
  });
  const responses: IncomingMessage[] = [];
  cleanup = async () => {
    for (const response of responses) response.destroy();
    await instance.app.close();
    const target = resolve(directory);
    if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { recursive: true });
  };
  await instance.app.listen({ host: '127.0.0.1', port });
  const bootstrap = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: { host, origin } });
  let cookie = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; '), csrf = bootstrap.json().csrf as string;
  const headers = () => ({ host, origin, cookie, 'x-csrf-token': csrf });
  const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: headers() }); now += 6000;
  const signed = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', headers: headers(), payload: { flowId: start.json().flowId } });
  expect(signed.json().status).toBe('authorized');
  cookie = signed.cookies.map(value => `${value.name}=${value.value}`).join('; '); csrf = signed.json().session.csrf;
  const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: headers(), payload: { name: 'Private streaming fixture', kind: 'personal' } });
  expect(created.statusCode).toBe(200);
  const id = created.json().workspace.id as string, prefix = `/api/v1/workspaces/${id}`;
  const store = opened.mock.results.at(-1)!.value as Store; opened.mockRestore();
  expect(store.snapshot().state.workspace).toMatchObject({ id, mode: 'private' });
  let reportNumber = 0;
  const report = (at: string): Handoff => ({ id: `sse-report-${++reportNumber}`, agentId: 'sse-agent', repoId: 'sse-repo', createdAt: at, summary: `Report ${reportNumber}: ${'Reviewed local fixture evidence. '.repeat(40)}`, status: 'saved', contextVersion: null, delivery: 'unsupported' });
  store.commit('sse-private-seed', (state, at) => {
    state.repositories.push({ id: 'sse-repo', name: 'Fixture repo', description: 'Protocol test only', language: 'TypeScript', branch: 'main', color: '#778899', position: [0, 0] });
    state.agents.push({ id: 'sse-agent', repoId: 'sse-repo', provider: 'Codex', name: 'Fixture session', role: 'Backend', task: 'Protocol fixture', activity: 'idle', color: '#778899', home: [0, 0], updatedAt: at, files: [], evidence: 'Fixture metadata only.', contextVersion: null });
    for (let index = 0; index < 64; index++) state.handoffs.push(report(at));
    return 'report.saved';
  });
  expect(Buffer.byteLength(JSON.stringify(store.snapshot()))).toBeGreaterThan(64 * 1024);
  const append = () => store.commit(`sse-append-${reportNumber + 1}`, (state, at) => { state.handoffs.push(report(at)); return 'report.saved'; }).snapshot;
  async function connect(after: number, lastEventId?: number) {
    const events: StateEvent[] = [], control: string[] = []; let closed = false;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(`${origin}${prefix}/events?after=${after}`, { headers: { cookie, ...(lastEventId === undefined ? {} : { 'Last-Event-ID': String(lastEventId) }) } }, resolve);
      req.on('error', reject); req.end();
    });
    responses.push(response);
    let partial = ''; response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      partial += chunk;
      for (let boundary = partial.indexOf('\n\n'); boundary >= 0; boundary = partial.indexOf('\n\n')) {
        const frame = partial.slice(0, boundary); partial = partial.slice(boundary + 2);
        if (frame.includes('event: state\n')) events.push(JSON.parse(frame.split('\ndata: ')[1]!) as StateEvent);
        if (frame.includes('event: resync_required')) control.push('resync_required');
      }
    });
    response.on('error', () => { closed = true; }); response.on('close', () => { closed = true; });
    return { response, events, control, closed: () => closed };
  }
  return { ...instance, store, prefix, headers, connect, append };
}

describe('real private HTTP state streams', () => {
  it('keeps >64KiB updates open through a paused reader, burst, reconnect replay and subsequent live update', async () => {
    const f = await fixture(), start = f.store.snapshot().cursor;
    const connection = await f.connect(start); expect(connection.response.statusCode).toBe(200);
    const writes = vi.spyOn(ServerResponse.prototype, 'write');
    connection.response.pause();
    for (let index = 0; index < 40; index++) f.append();
    const final = f.store.snapshot(); connection.response.resume();
    await vi.waitFor(() => expect(connection.events.at(-1)?.cursor).toBe(final.cursor));
    expect(writes.mock.results.some(result => result.type === 'return' && result.value === false)).toBe(true);
    expect(connection.closed()).toBe(false);
    expect(connection.events.at(-1)?.state.handoffs).toEqual(final.state.handoffs);
    const next = f.append();
    await vi.waitFor(() => expect(connection.events.at(-1)?.cursor).toBe(next.cursor));
    expect(connection.closed()).toBe(false); connection.response.destroy();

    // Last-Event-ID must override the deliberately invalid query cursor.
    const replay = await f.connect(next.cursor + 999, start);
    await vi.waitFor(() => expect(replay.events.at(-1)?.cursor).toBe(next.cursor));
    expect(replay.control).toEqual([]); expect(replay.closed()).toBe(false);
    expect(replay.events.at(-1)?.state.handoffs).toEqual(next.state.handoffs);
    expect(replay.events.map(value => value.cursor)).toEqual([...new Set(replay.events.map(value => value.cursor))].sort((a, b) => a - b));
    const latest = f.append();
    await vi.waitFor(() => expect(replay.events.at(-1)?.cursor).toBe(latest.cursor));
    expect(replay.closed()).toBe(false);
    expect(f.store.diagnostics().listenerFailures).toBe(0);
    const snapshot = await f.app.inject({ url: `${f.prefix}/snapshot`, headers: f.headers() });
    expect(snapshot.json().state.handoffs).toEqual(latest.state.handoffs);
    const resync = await f.connect(latest.cursor + 1);
    await vi.waitFor(() => expect(resync.control).toEqual(['resync_required']));
    await vi.waitFor(() => expect(resync.closed()).toBe(true));
  });

  it('closes a live private stream on logout and rejects its former session on reconnect', async () => {
    const f = await fixture(), stream = await f.connect(f.store.snapshot().cursor);
    f.append(); await vi.waitFor(() => expect(stream.events).toHaveLength(1));
    const logout = await f.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: f.headers() });
    expect(logout.statusCode).toBe(200); await vi.waitFor(() => expect(stream.closed()).toBe(true));
    const count = stream.events.length; f.append(); expect(stream.events).toHaveLength(count);
    const rejected = await f.connect(f.store.snapshot().cursor); expect(rejected.response.statusCode).toBe(401);
  });

  it('requests a fresh snapshot beyond the retained 200-event stream replay window', async () => {
    const f = await fixture(), before = f.store.snapshot();
    for (let index = 0; index < 201; index++) f.store.commit(`sse-window-${index}`, state => {
      state.agents[0]!.task = `Fixture progress ${index}`; return 'agent.activity';
    });
    const stream = await f.connect(before.cursor);
    await vi.waitFor(() => expect(stream.control).toEqual(['resync_required']));
    await vi.waitFor(() => expect(stream.closed()).toBe(true));
    expect(stream.events).toEqual([]);
    expect(f.store.snapshot().state.handoffs).toEqual(before.state.handoffs);
    const fresh = await f.connect(f.store.snapshot().cursor), next = f.append();
    await vi.waitFor(() => expect(fresh.events.at(-1)?.cursor).toBe(next.cursor));
    expect(fresh.closed()).toBe(false);
  });

  it('checks session expiry before writing another saved private update', async () => {
    const f = await fixture(), stream = await f.connect(f.store.snapshot().cursor);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 60 * 60 * 1000 + 1000);
    f.append(); await vi.waitFor(() => expect(stream.closed()).toBe(true));
    expect(stream.events).toEqual([]);
    const rejected = await f.connect(f.store.snapshot().cursor); expect(rejected.response.statusCode).toBe(401);
  });
});
