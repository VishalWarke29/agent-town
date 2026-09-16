import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/service/src/app';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';
import { encodeOtlpFixture } from '../../apps/service/src/telemetry';
import type { WorkflowProvider } from '../../apps/service/src/workflow/provider';
import type { RunExecutor } from '../../apps/service/src/runner/types';

const origin = 'http://127.0.0.1:4310';
const host = { host: '127.0.0.1:4310' };
let directory: string;
let instance: Awaited<ReturnType<typeof createApp>>;
let now: number;
let principalId: string;
let verifyGate: (() => Promise<void>) | undefined;
type Session = { cookie: string; csrf: string };

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'agent-town-private-api-'));
  now = Date.now(); principalId = '101'; verifyGate = undefined;
  const secrets = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { secrets.set(key, value); }, get: async key => secrets.get(key) ?? null, delete: async key => { secrets.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: `fixture-secret-${principalId}`, expiresIn: 3600 }),
    verifyUser: async token => { await verifyGate?.(); return { id: token.split('-').at(-1)!, login: `user${principalId}`, displayName: 'Fixture Owner', avatarUrl: null }; },
    listRepositories: async () => ({ repositories: [{ id: '999', installationId: '222', name: 'repo', fullName: 'fixture/repo', private: true, defaultBranch: 'main', htmlUrl: 'https://github.com/fixture/repo', archived: false }], truncated: false, checkedAt: new Date(now).toISOString() }),
  };
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'fixture-public-client-id', now: () => now });
  const workflowProvider: WorkflowProvider = { verify: async () => ({ models: ['fixture-model'] }), countInput: async () => 10, summarize: async () => { throw new Error('This fixture never runs a paid manager.'); } };
  const runExecutor: RunExecutor = {
    preflight: async tool => ({ tool, ready: true, checkedAt: new Date().toISOString(), checks: [{ name: 'Fixture', passed: true, message: 'Injected protocol fixture; no native isolation claim.' }] }),
    subscription: async () => { throw new Error('This fixture never connects a native account.'); },
    execute: async input => {
      const reservation = input.onRequestStart(10, input.draft.maxOutputTokens);
      const usage = { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, source: 'provider-reported' as const };
      input.onRequestComplete(reservation, usage); input.onContextDelivered();
      writeFileSync(join(input.worktree, 'source.ts'), 'export const value = 2;');
      return { outcome: 'review', summary: 'Fixture updated source; reviewed test boundary only.', usage, providerRequests: 1 };
    },
  };
  instance = await createApp({ database: ':memory:', privateDirectory: directory, identity, vault, workflowProvider, runExecutor, simulationInterval: 600000 });
});
afterEach(async () => {
  await instance.app.close();
  const target = resolve(directory);
  if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { recursive: true });
});
const headers = (session: Session) => ({ ...host, origin, cookie: session.cookie, 'x-csrf-token': session.csrf });
async function bootstrap(): Promise<Session> {
  const response = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...host, origin } });
  return { cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), csrf: response.json().csrf };
}
async function signIn(): Promise<Session> {
  const session = await bootstrap();
  const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: headers(session) });
  expect(start.statusCode).toBe(200); now += 6000;
  const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', headers: headers(session), payload: { flowId: start.json().flowId } });
  expect(poll.statusCode).toBe(200); expect(poll.json().status).toBe('authorized');
  expect(poll.body).not.toContain('fixture-secret'); expect(poll.json().session.csrf).not.toBe(session.csrf);
  return { cookie: poll.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), csrf: poll.json().session.csrf };
}
async function workspace(session: Session): Promise<string> {
  const response = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: headers(session), payload: { name: 'Private workshop', kind: 'personal' } });
  expect(response.statusCode).toBe(200); return response.json().workspace.id;
}

describe('private browser API', () => {
  it('protects context memory and preserves version history without inference or reservations', async () => {
    const alice = await signIn(), id = await workspace(alice), prefix = `/api/v1/workspaces/${id}`;
    const body = { action: 'accept-decision', expectedVersion: 0, text: 'Preserve the public interface.', repoId: null, sourceReportIds: [] };
    const request = (key: string, payload = body) => instance.app.inject({ method: 'POST', url: `${prefix}/context/memory`, headers: { ...headers(alice), 'idempotency-key': key }, payload });
    expect((await instance.app.inject({ method: 'POST', url: `${prefix}/context/memory`, headers: headers(alice), payload: body })).statusCode).toBe(400);
    expect((await instance.app.inject({ method: 'POST', url: `${prefix}/context/memory`, headers: { ...headers(alice), 'x-csrf-token': '0'.repeat(64), 'idempotency-key': 'memory-csrf-fixture' }, payload: body })).statusCode).toBe(403);
    expect((await request('memory-first-fixture')).statusCode).toBe(200);
    const first = (await instance.app.inject({ url: `${prefix}/context`, headers: headers(alice) })).json();
    expect((await request('memory-stale-fixture')).statusCode).toBe(409);
    expect((await request('memory-second-fixture', { ...body, expectedVersion: 1, text: 'Preserve the database format.' })).statusCode).toBe(200);
    const second = (await instance.app.inject({ url: `${prefix}/context`, headers: headers(alice) })).json();
    expect(second.versions[0]).toEqual(first.versions[0]);
    const snapshot = (await instance.app.inject({ url: `${prefix}/snapshot`, headers: headers(alice) })).json();
    expect(snapshot.state.manager.version).toBe(2);
    expect(snapshot.state.workflow.manager.jobs).toEqual([]);
    expect(snapshot.state.workflow.reservations).toEqual([]);
    principalId = '202'; const bob = await signIn();
    for (const route of ['/context', '/manager/status', '/history/agents']) expect((await instance.app.inject({ url: `${prefix}${route}`, headers: headers(bob) })).statusCode).toBe(404);
    expect((await instance.app.inject({ method: 'POST', url: `${prefix}/context/memory`, headers: { ...headers(bob), 'idempotency-key': 'cross-owner-memory' }, payload: { ...body, expectedVersion: 2 } })).statusCode).toBe(404);
  });
  it('requires verified identity, isolates owners, and rejects demo mutation of a real workspace', async () => {
    const preview = await bootstrap();
    expect((await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: headers(preview), payload: { name: 'No owner', kind: 'personal' } })).statusCode).toBe(401);
    const alice = await signIn(), id = await workspace(alice);
    const snapshot = await instance.app.inject({ url: `/api/v1/workspaces/${id}/snapshot`, headers: headers(alice) });
    expect(snapshot.json().state.agents).toEqual([]); expect(snapshot.json().state.workspace.mode).toBe('private');
    expect((await instance.app.inject({ method: 'POST', url: `/api/v1/workspaces/${id}/demo/commands`, headers: headers(alice), payload: { action: 'play' } })).statusCode).toBe(400);
    principalId = '202'; const bob = await signIn();
    expect((await instance.app.inject({ url: `/api/v1/workspaces/${id}/snapshot`, headers: headers(bob) })).statusCode).toBe(404);
    expect((await instance.app.inject({ url: `/api/v1/workspaces/${id}/events`, headers: headers(bob) })).statusCode).toBe(404);
    expect((await instance.app.inject({ method: 'POST', url: `/api/v1/workspaces/${id}/roots`, headers: headers(bob), payload: { path: directory } })).statusCode).toBe(404);
  });

  it('revokes the old session on logout and requires its current CSRF value', async () => {
    const alice = await signIn(), id = await workspace(alice);
    const bad = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...headers(alice), 'x-csrf-token': '0'.repeat(64) } });
    expect(bad.statusCode).toBe(403);
    const logout = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(alice) });
    expect(logout.json().mode).toBe('demo'); expect(logout.json().user).toBeNull();
    expect((await instance.app.inject({ url: `/api/v1/workspaces/${id}/snapshot`, headers: headers(alice) })).statusCode).toBe(401);
  });

  it('cannot promote a sign-in session that was logged out during identity verification', async () => {
    const session = await bootstrap();
    const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: headers(session) }); now += 6000;
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    verifyGate = () => { entered(); return blocked; };
    const poll = instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', headers: headers(session), payload: { flowId: start.json().flowId } });
    // Start the thenable injection before awaiting the provider boundary.
    const result = Promise.resolve(poll);
    await waiting;
    await instance.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(session) });
    release(); const response = await result;
    expect(response.statusCode).toBe(401); expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('lists GitHub metadata without exposing credentials and selects only known repositories', async () => {
    const session = await signIn(), id = await workspace(session), base = `/api/v1/workspaces/${id}`;
    expect((await instance.app.inject({ method: 'POST', url: `${base}/repositories/select`, headers: headers(session), payload: { ids: ['unknown'] } })).statusCode).toBe(400);
    const listing = await instance.app.inject({ method: 'POST', url: `${base}/github/repositories`, headers: headers(session) });
    expect(listing.statusCode).toBe(200); expect(listing.body).not.toContain('fixture-secret');
    const selection = await instance.app.inject({ method: 'POST', url: `${base}/repositories/select`, headers: headers(session), payload: { ids: ['github-999'] } });
    expect(selection.json().snapshot.state.repositories[0].name).toBe('fixture/repo');
  });

  it('discovers real local Git metadata, waits for selection, and never stores instruction bodies', async () => {
    const root = join(directory, 'projects'), repo = join(root, 'source'); mkdirSync(repo, { recursive: true });
    execFileSync('git', ['-c', 'init.templateDir=', 'init', repo], { windowsHide: true, stdio: 'ignore' });
    writeFileSync(join(repo, 'AGENTS.md'), 'PRIVATE-INSTRUCTION-BODY-MUST-STAY-OUT');
    writeFileSync(join(repo, '.env'), 'NEVER_CAPTURE_THIS_TOKEN=fixture-secret-value');
    const session = await signIn(), id = await workspace(session), base = `/api/v1/workspaces/${id}`;
    expect((await instance.app.inject({ method: 'POST', url: `${base}/roots`, headers: headers(session), payload: { path: root } })).statusCode).toBe(200);
    const start = await instance.app.inject({ method: 'POST', url: `${base}/scans`, headers: headers(session) }); expect(start.statusCode).toBe(202);
    await expect.poll(async () => (await instance.app.inject({ url: `${base}/scans/${start.json().operationId}`, headers: headers(session) })).json().operation.status, { timeout: 15000 }).not.toBe('running');
    const response = await instance.app.inject({ url: `${base}/snapshot`, headers: headers(session) });
    expect(response.json().state.repositories).toEqual([]);
    const candidates = response.json().state.discovery.candidates; expect(candidates).toHaveLength(1);
    expect(candidates[0].instructions.map((file: { path: string }) => file.path)).toContain('AGENTS.md');
    expect(response.body).not.toContain('PRIVATE-INSTRUCTION'); expect(response.body).not.toContain('NEVER_CAPTURE');
    const selected = await instance.app.inject({ method: 'POST', url: `${base}/repositories/select`, headers: headers(session), payload: { ids: [candidates[0].id] } });
    expect(selected.json().snapshot.state.repositories[0].localPath).toBe(repo);
    // A native Git metadata change reaches the saved state without a browser rescan.
    execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/observed-change'], { windowsHide: true, stdio: 'ignore' });
    await expect.poll(async () => (await instance.app.inject({ url: `${base}/snapshot`, headers: headers(session) })).json().state.repositories[0].branch, { timeout: 10000 }).toBe('observed-change');
  }, 20000);

  it('authenticates scoped OTLP JSON and Protobuf, excludes private attributes, and revokes ingestion', async () => {
    const session = await signIn(), id = await workspace(session), base = `/api/v1/workspaces/${id}`;
    await instance.app.inject({ method: 'POST', url: `${base}/github/repositories`, headers: headers(session) });
    await instance.app.inject({ method: 'POST', url: `${base}/repositories/select`, headers: headers(session), payload: { ids: ['github-999'] } });
    const registration = await instance.app.inject({ method: 'POST', url: `${base}/services`, headers: headers(session), payload: { repoId: 'github-999', serviceName: 'fixture-service' } });
    expect(registration.statusCode).toBe(200);
    const source = registration.json().source, authorization: string = registration.json().setup.authorization;
    const token = authorization.split('.')[1]!;
    const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const stamp = (offset: number) => (BigInt(Date.now() + offset) * 1_000_000n).toString();
    const traces = { resourceSpans: [{ resource: { attributes: [attribute('service.name', 'fixture-service')] }, scopeSpans: [{ spans: [{
      traceId: 'ab'.repeat(16), spanId: 'cd'.repeat(8), kind: 2, startTimeUnixNano: stamp(-100), endTimeUnixNano: stamp(0),
      name: 'PRIVATE_RAW_PATH', attributes: [attribute('http.request.method', 'GET'), attribute('http.route', '/private-value?key=PRIVATE_SECRET'), attribute('http.request.header.authorization', 'Bearer PRIVATE_SECRET')],
    }] }] }] };
    const send = (payload: object | Buffer, extra: Record<string, string> = {}, type = 'application/json') => instance.app.inject({ method: 'POST', url: '/ingest/otlp/v1/traces', headers: { ...host, 'content-type': type, ...extra }, payload });
    expect((await send(traces)).statusCode).toBe(401);
    expect((await send(traces, { authorization, origin: 'https://untrusted.invalid' })).statusCode).toBe(403);
    expect((await send(traces, { authorization, 'content-encoding': 'gzip' })).statusCode).toBe(415);
    expect((await send(traces, { authorization })).statusCode).toBe(200);
    const span = traces.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const bytes = encodeOtlpFixture('traces', { resourceSpans: [{ ...traces.resourceSpans[0], scopeSpans: [{ spans: [{ ...span, traceId: Buffer.from(span.traceId, 'hex'), spanId: Buffer.from(span.spanId, 'hex') }] }] }] });
    expect((await send(bytes, { authorization }, 'application/x-protobuf')).statusCode).toBe(200);
    const snapshot = await instance.app.inject({ url: `${base}/snapshot`, headers: headers(session) });
    expect(snapshot.json().state.telemetry.spans).toHaveLength(1);
    expect(snapshot.json().state.telemetry.spans[0].route).toBeNull();
    expect(snapshot.body).not.toContain('PRIVATE_'); expect(snapshot.body).not.toContain(token);
    const traffic = await instance.app.inject({ url: `${base}/services`, headers: headers(session) });
    expect(traffic.json().traffic[0]).toMatchObject({ serviceId: source.id, source: 'sampled-spans', requestCount: 1, errorCount: null });
    principalId = '202'; const other = await signIn();
    expect((await instance.app.inject({ method: 'POST', url: `${base}/services/${source.id}/revoke`, headers: headers(other) })).statusCode).toBe(404);
    expect((await instance.app.inject({ method: 'POST', url: `${base}/services/${source.id}/revoke`, headers: headers(session) })).statusCode).toBe(200);
    expect((await send(traces, { authorization })).statusCode).toBe(401);
  });

  it('routes an approved task through a real isolated worktree and separate human review', async () => {
    const repo = join(directory, 'task-repo'); mkdirSync(repo);
    const git = (args: string[]) => execFileSync('git', ['-c', 'init.templateDir=', '-c', 'core.hooksPath=NUL', '-C', repo, ...args], { windowsHide: true, stdio: 'ignore' });
    git(['init']); writeFileSync(join(repo, 'source.ts'), 'export const value = 1;'); git(['add', 'source.ts']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--no-gpg-sign', '-m', 'Fixture']);
    const session = await signIn(), id = await workspace(session), base = `/api/v1/workspaces/${id}`;
    const post = (path: string, payload: object, key: string) => instance.app.inject({ method: 'POST', url: `${base}${path}`, headers: { ...headers(session), 'idempotency-key': key }, payload });
    await post('/roots', { path: repo }, 'root-first'); const scan = await post('/scans', {}, 'scan-first');
    await expect.poll(async () => (await instance.app.inject({ url: `${base}/scans/${scan.json().operationId}`, headers: headers(session) })).json().operation.status).toBe('complete');
    const current = () => instance.app.inject({ url: `${base}/snapshot`, headers: headers(session) });
    const repoId: string = (await current()).json().state.discovery.candidates[0].id;
    await post('/repositories/select', { ids: [repoId] }, 'repo-first');
    const connection = await post('/connections', { provider: 'openai', label: 'Fixture API', apiKey: 'sk-fixture_only_not_a_credential' }, 'fixture-connection');
    expect(connection.statusCode).toBe(200);
    const connectionId: string = connection.json().snapshot.state.workflow.connections[0].id;
    const policy = { paidEnabled: true, dailyBudgetMicroUsd: 1_000_000, managerDailyBudgetMicroUsd: 100_000, maxRunBudgetMicroUsd: 100_000, workerConcurrency: 1, timeZone: 'UTC' };
    expect((await instance.app.inject({ method: 'PATCH', url: `${base}/cost-policy`, headers: { ...headers(session), 'idempotency-key': 'fixture-policy' }, payload: policy })).statusCode).toBe(200);
    const draft = { repoId, tool: 'openai-api', connectionId, mode: 'api', model: 'fixture-model', objective: 'Change the source value to two.', acceptanceCriteria: ['Only source.ts changes.'], maxTurns: 1, maxOutputTokens: 256, maxMinutes: 1, budgetMicroUsd: 10000,
      price: { model: 'fixture-model', contextWindowTokens: 16000, inputPerMillionMicroUsd: 1000000, outputPerMillionMicroUsd: 5000000, cachedInputPerMillionMicroUsd: 100000, cacheWritePerMillionMicroUsd: 2000000, priceSource: 'https://example.test/pricing', priceCheckedAt: new Date().toISOString(), qualityStatus: 'user-attested', qualityNote: 'Protocol fixture only, not a model quality evaluation.' } };
    const created = await post('/tasks', draft, 'fixture-task'); expect(created.statusCode).toBe(200);
    const task = created.json().snapshot.state.runner.tasks[0];
    expect((await post(`/tasks/${task.id}/approve`, { approvalHash: '0'.repeat(64) }, 'wrong-approval')).statusCode).toBe(409);
    const approval = await post(`/tasks/${task.id}/approve`, { approvalHash: task.approvalHash }, 'correct-approval'); expect(approval.statusCode).toBe(200);
    // Real worktree creation and final Git safety checks can exceed the 1s polling default on Windows.
    await expect.poll(async () => (await current()).json().state.runner.tasks[0].status, { timeout: 5000 }).toBe('awaiting_review');
    const finished = (await current()).json().state;
    expect(finished.runner.runs[0]).toMatchObject({ contextDelivery: 'provider-acknowledged', changedFiles: ['source.ts'], providerRequests: 1 });
    expect(finished.handoffs[0].status).toBe('saved'); expect(finished.manager.version).toBe(0);
    expect((await post(`/tasks/${task.id}/approve`, { approvalHash: task.approvalHash }, 'correct-approval')).json().duplicate).toBe(true);
    expect((await post(`/tasks/${task.id}/review`, { decision: 'accepted' }, 'fixture-review')).statusCode).toBe(200);
    expect((await current()).json().state.runner.tasks[0].status).toBe('accepted');
    expect(git(['diff', '--exit-code'])).toBeNull();
  }, 20000);
});
