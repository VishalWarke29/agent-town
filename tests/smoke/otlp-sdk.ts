import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createApp } from '../../apps/service/src/app.js';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity/index.js';
import { privateState } from '../../apps/service/src/workspaces.js';
import { Store } from '../../apps/service/src/store.js';
import { initialState } from '../../apps/service/src/demo.js';
import { emptyTelemetryState, trafficForService } from '../../apps/service/src/telemetry/index.js';
import type { TownState } from '@agent-town/contracts';

const argument = (key: string) => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const environment = argument('--environment'), output = argument('--output');
assert(environment && output, 'Pass --environment ISOLATED_ENVIRONMENT and --output EVIDENCE_JSON.');
const environmentRoot = resolve(environment), runtime = join(environmentRoot, `runtime-${randomUUID()}`);
await mkdir(runtime);
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
const address = listener.address(); assert(address && typeof address !== 'string', 'Could not allocate an isolated loopback port.');
const port = address.port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const vaultData = new Map<string, string>();
const vault: CredentialVault = { available: true, put: async (key, value) => { vaultData.set(key, value); }, get: async key => vaultData.get(key) ?? null, delete: async key => { vaultData.delete(key); } };
let now = Date.now();
const provider: IdentityProvider = {
  begin: async () => ({ deviceCode: 'isolated-smoke-device', userCode: 'SMOK-E123', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
  poll: async () => ({ status: 'authorized', accessToken: 'isolated-smoke-fixture-token', expiresIn: 3600 }),
  verifyUser: async () => ({ id: '900001', login: 'isolated-smoke-owner', displayName: 'Isolated smoke owner', avatarUrl: null }),
  listRepositories: async () => { throw new Error('No real repository listing is permitted in this fixture.'); },
};
const registry = new IdentityRegistry(join(runtime, 'app.sqlite'));
registry.registerOwner({ id: '900001', login: 'isolated-smoke-owner', displayName: 'Isolated smoke owner', avatarUrl: null }, 'isolated-smoke-credential-ref', null);
const workspace = registry.createWorkspace('900001', 'Isolated SDK verification');
const initial = privateState(workspace);
const repo = { ...initialState().repositories[0]!, id: 'otel-smoke-repository', name: 'Isolated exporter fixture', source: 'local' as const, localPath: runtime };
initial.repositories = [repo]; initial.telemetry = emptyTelemetryState();
initial.telemetry.inventories = [{ repoId: repo.id, scannedAt: new Date().toISOString(), filesScanned: 1, coverage: 'complete', issues: [], endpoints: [{ id: 'known-http-route', repoId: repo.id, method: 'GET', route: '/items/:id', framework: 'express', source: { path: 'fixture', line: 1, hash: '0'.repeat(64) }, confidence: 'declared', reason: null }] }];
const workspaceDatabase = join(runtime, 'workspaces', workspace.id, 'town.sqlite');
const seed = new Store(workspaceDatabase, initial); seed.close();
const identity = new IdentityService({ registry, vault, provider, clientId: 'isolated-public-fixture', now: () => now });
const instance = await createApp({ database: join(runtime, 'preview.sqlite'), privateDirectory: runtime, identity, vault, port, mode: 'development', logger: false, simulationInterval: 600000 });
const receipts: { signal: string; code: number; contentType: string }[] = [];
instance.app.addHook('onResponse', async (request, reply) => {
  if (request.url.startsWith('/ingest/otlp/v1/')) receipts.push({ signal: request.url.split('/').at(-1)!, code: reply.statusCode, contentType: String(reply.getHeader('content-type') ?? '') });
});
let cookie = '', csrf = '';
const headers = () => ({ host: `127.0.0.1:${port}`, origin, cookie, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() });
const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
  const response = await instance.app.inject({ method, url, headers: headers(), payload });
  assert(response.statusCode === 200, `Isolated application fixture route failed (${response.statusCode}).`);
  return response;
};
const snapshot = async () => (await call('GET', `/api/v1/workspaces/${workspace.id}/snapshot`)).json().state as TownState;
interface ExporterMessage { phase: 'flushed' | 'done'; requests: number; exports?: { traces: number; metrics: number; failures: number }; shutdown?: boolean }
async function exporter(language: 'node' | 'python', config: { endpoint: string; authorization: string; resourceName: string }, verifyFlushed: () => Promise<void>): Promise<ExporterMessage> {
  const executable = language === 'node' ? process.execPath : join(environmentRoot, 'python-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const args = language === 'node' ? [join(environmentRoot, 'node', 'exporter.mjs')] : ['-I', join(process.cwd(), 'tests/smoke/python/exporter.py')];
  // Child environments contain no inherited provider/auth/exporter variables.
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
  const child = spawn(executable, args, { cwd: environmentRoot, env: { ...env, PYTHONUNBUFFERED: '1', OTEL_LOG_LEVEL: 'none' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderrBytes = 0; child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error(`${language} SDK fixture could not start.`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${language} SDK fixture failed (exit ${code}, ${stderrBytes} diagnostic bytes withheld).`)));
  });
  void done.catch(() => undefined);
  const timer = setTimeout(() => child.kill(), 45000);
  const message = async () => {
    const line = await iterator.next(); assert(!line.done && line.value.length < 4096, `${language} SDK did not return its expected bounded phase.`);
    return JSON.parse(line.value) as ExporterMessage;
  };
  try {
    child.stdin.write(`${JSON.stringify(config)}\n`);
    const first = await message(); assert(first.phase === 'flushed' && first.requests === 2, `${language} first flush was not acknowledged.`);
    await verifyFlushed(); child.stdin.end('continue\n');
    const last = await message(); await done;
    assert(last.phase === 'done' && last.shutdown && last.requests === 3 && last.exports?.failures === 0, `${language} shutdown did not complete successfully.`);
    return last;
  } finally { clearTimeout(timer); lines.close(); if (child.exitCode === null) child.kill(); }
}

const results: object[] = [];
let failure: unknown;
try {
  await instance.app.listen({ host: '127.0.0.1', port });
  const bootstrap = await call('POST', '/api/v1/session'); cookie = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; '); csrf = bootstrap.json().csrf;
  const start = await call('POST', '/api/v1/auth/github/device/start'); now += 6000;
  const signin = await call('POST', '/api/v1/auth/github/device/poll', { flowId: start.json().flowId });
  assert(signin.json().status === 'authorized', 'Injected fixture identity was not accepted.');
  cookie = signin.cookies.map(value => `${value.name}=${value.value}`).join('; '); csrf = signin.json().session.csrf;
  for (const language of ['node', 'python'] as const) {
    const serviceName = `${language}-sdk-smoke`;
    const registration = (await call('POST', `/api/v1/workspaces/${workspace.id}/services`, { repoId: repo.id, serviceName })).json();
    const sourceId = registration.source.id as string;
    const assertTraffic = async (count: number) => {
      const state = await snapshot(), telemetry = state.telemetry!;
      const summary = trafficForService(telemetry, sourceId);
      assert(summary.source === 'metrics' && summary.requestCount === count && summary.errorCount === 1, `${language}: histogram totals or metric/span authority are incorrect.`);
      const spans = telemetry.spans.filter(span => span.serviceId === sourceId);
      assert(spans.length === count && spans.every(span => span.repoId === repo.id && span.sourceId === sourceId && span.runId === null), `${language}: source/repository/run attribution is incorrect.`);
      assert(spans.filter(span => span.route === '/items/:id').length === 2, `${language}: reviewed route attribution is incorrect.`);
      if (count === 3) assert(spans.filter(span => span.route === null).length === 1, `${language}: unreviewed route must remain unavailable.`);
      assert(!JSON.stringify(state).includes('SMOKE_PRIVATE_MARKER') && !JSON.stringify(state).includes('UNAPPROVED_SMOKE_RUN'), `${language}: private fixture content leaked into saved state.`);
      return summary;
    };
    const firstReceipt = receipts.length;
    const run = await exporter(language, { ...registration.setup, resourceName: serviceName }, async () => { await assertTraffic(2); });
    const summary = await assertTraffic(3);
    const beforeMismatch = (await snapshot()).telemetry!;
    await exporter(language, { ...registration.setup, resourceName: `${language}-wrong-resource` }, async () => {
      const current = (await snapshot()).telemetry!;
      assert(current.spans.length === beforeMismatch.spans.length && current.metrics.length === beforeMismatch.metrics.length, `${language}: mismatched resource reached saved observations.`);
    });
    const afterMismatch = (await snapshot()).telemetry!;
    assert(afterMismatch.spans.length === beforeMismatch.spans.length && afterMismatch.metrics.length === beforeMismatch.metrics.length && afterMismatch.coverage.rejected > beforeMismatch.coverage.rejected, `${language}: wrong-resource rejection was not recorded.`);
    const acknowledgements = receipts.slice(firstReceipt);
    assert(acknowledgements.length >= 8 && acknowledgements.every(receipt => receipt.code === 200 && receipt.contentType.startsWith('application/x-protobuf')), `${language}: real HTTP/Protobuf acknowledgement failed.`);
    results.push({ language, realHttpRequests: run.requests, wrongResourceHttpRequests: 3, totalFixtureHttpRequests: 6, requestsCounted: summary.requestCount, errorsCounted: summary.errorCount, spansRetained: 3, countSource: summary.source,
      knownRouteSpans: 2, unavailableRouteSpans: 1, unapprovedRunAttribution: false, shutdownFlush: run.shutdown, exports: run.exports,
      wrongResourceRejected: true, protobufAcknowledgements: acknowledgements.length });
  }
  const state = await snapshot();
  assert(state.workflow!.reservations.length === 0 && state.workflow!.manager.jobs.length === 0 && !state.workflow!.policy.paidEnabled, 'Telemetry unexpectedly started managed or paid work.');
} catch (error) { failure = error; }
finally { await instance.app.close(); }

async function verifyPersisted(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) await verifyPersisted(target);
    else {
      const bytes = await readFile(target);
      assert(!bytes.includes(Buffer.from('SMOKE_PRIVATE_MARKER')) && !bytes.includes(Buffer.from('UNAPPROVED_SMOKE_RUN')), 'Private fixture input leaked into a persisted file.');
      for (const secret of vaultData.values()) assert(!bytes.includes(Buffer.from(secret)), 'An ephemeral fixture credential leaked into a persisted file.');
    }
  }
}
if (failure) throw failure;
await verifyPersisted(runtime);
const report = { checkedAt: new Date().toISOString(), evidenceKind: 'real-sdk-isolated-http-protobuf-smoke', passed: true,
  inferenceCalls: 0, realAccountsAuthorized: 0, userRepositoriesModified: 0, globalPackagesInstalled: 0,
  sdkVersions: { nodeSdk: '2.11.0', nodeExporter: '0.222.0', nodeApi: '1.9.1', pythonSdkAndExporter: '1.44.0' },
  fixtures: results, persistedContentRedaction: true, ephemeralCredentialsNotPersisted: true,
  limits: ['Manually instrumented real HTTP handlers and official SDK exporters; not universal zero-code framework instrumentation certification.', 'Fresh synthetic owner, repository inventory and workspace; no real account or user application was used.', 'HTTP/protobuf without compression; no gRPC or compressed exporter support claimed.'] };
await writeFile(resolve(output), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
