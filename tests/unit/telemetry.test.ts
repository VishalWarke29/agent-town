import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeOtlp, emptyTelemetryState, encodeOtlpFixture, encodeOtlpResponse, ingestTelemetry, safeRouteTemplate, scanApiInventory, trafficForService } from '../../apps/service/src/telemetry';
import type { TelemetryScope } from '../../packages/contracts/src/telemetry';

const now = '2026-09-14T20:00:00.000Z';
const millis = Date.parse(now);
const nanos = (offset: number) => (BigInt(millis + offset) * 1_000_000n).toString();
const scope: TelemetryScope = { sourceId: 'source-a', serviceId: 'service-a', repoId: 'repo-a', resourceServiceName: 'fixture-service', routeTemplates: ['/items/:id'] };
const attribute = (key: string, value: string | number) => ({ key, value: typeof value === 'string' ? { stringValue: value } : { intValue: String(value) } });
const attributes = [attribute('http.request.method', 'GET'), attribute('http.route', '/items/:id'), attribute('http.response.status_code', 200)];
const resource = { attributes: [attribute('service.name', scope.resourceServiceName)] };
const span = (overrides: Record<string, unknown> = {}) => ({
  traceId: 'ab'.repeat(16), spanId: 'cd'.repeat(8), kind: 2,
  startTimeUnixNano: nanos(-100), endTimeUnixNano: nanos(0), attributes, ...overrides,
});
const traces = (spans: Record<string, unknown>[] = [span()]) => ({ resourceSpans: [{ resource, scopeSpans: [{ spans }] }] });
const metrics = (count = 2, end = 0, overrides: Record<string, unknown> = {}) => ({ resourceMetrics: [{ resource, scopeMetrics: [{ metrics: [{
  name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 2, dataPoints: [{
    startTimeUnixNano: nanos(-1000), timeUnixNano: nanos(end), count: String(count), sum: count * 0.05,
    explicitBounds: [0.1], bucketCounts: [String(count), '0'], attributes, ...overrides,
  }] },
}] }] }] });

describe('OTLP decoding and traffic accounting', () => {
  it('retains only allowed fields, exact route templates and approved run attribution', () => {
    const message = traces([span({ name: 'GET /items/SECRET?api_key=SECRET', attributes: [...attributes,
      attribute('url.full', 'https://user:SECRET@example.invalid/items/SECRET?api_key=SECRET'),
      attribute('http.request.header.authorization', 'Bearer SECRET'), attribute('agent_town.run_id', 'unapproved-run')],
      events: [{ name: 'SECRET exception', attributes: [attribute('exception.message', 'SECRET body')] }],
    })]);
    const decoded = decodeOtlp('traces', JSON.stringify(message), 'application/json', scope, now);
    expect(decoded.spans[0]).toMatchObject({ method: 'GET', route: '/items/:id', durationMs: 100, runId: null, sampling: 'sampled-observation' });
    expect(JSON.stringify(decoded)).not.toContain('SECRET');
    const unknown = decodeOtlp('traces', traces([span({ attributes: [attribute('http.request.method', 'GET'), attribute('http.route', '/items/private-value?key=SECRET'), attribute('url.path', '/items/private-value')] })]), 'application/json', scope, now);
    expect(unknown.spans[0].route).toBeNull();
    expect(JSON.stringify(unknown)).not.toContain('private-value');
  });

  it('decodes actual Protobuf and JSON into the same sanitized observation', () => {
    const json = decodeOtlp('traces', traces(), 'application/json', scope, now);
    const bytes = encodeOtlpFixture('traces', traces([span({ traceId: Buffer.from('ab'.repeat(16), 'hex'), spanId: Buffer.from('cd'.repeat(8), 'hex') })]));
    const binary = decodeOtlp('traces', bytes, 'application/x-protobuf', scope, now);
    expect(binary).toEqual(json);
    const metricBytes = encodeOtlpFixture('metrics', metrics());
    expect(decodeOtlp('metrics', metricBytes, 'application/x-protobuf', scope, now)).toEqual(decodeOtlp('metrics', metrics(), 'application/json', scope, now));
  });

  it('uses one count source, settles cumulative metric deltas, and rejects repeated or out-of-order intervals', () => {
    let state = ingestTelemetry(emptyTelemetryState(), decodeOtlp('traces', traces(), 'application/json', scope, now)).state;
    expect(trafficForService(state, scope.serviceId)).toMatchObject({ source: 'sampled-spans', requestCount: 1 });
    const first = decodeOtlp('metrics', metrics(), 'application/json', scope, now);
    state = ingestTelemetry(state, first).state;
    expect(trafficForService(state, scope.serviceId)).toMatchObject({ source: 'metrics', requestCount: 2, errorCount: 0, meanLatencyMs: 50, p95LatencyMs: 100 });
    expect(ingestTelemetry(state, first)).toMatchObject({ accepted: 0, duplicate: 1 });
    state = ingestTelemetry(state, decodeOtlp('metrics', metrics(3, 100), 'application/json', scope, now)).state;
    expect(trafficForService(state, scope.serviceId).requestCount).toBe(3);
    expect(state.metrics.at(-1)?.count).toBe(1);
    const outOfOrder = ingestTelemetry(state, decodeOtlp('metrics', metrics(2, 50), 'application/json', scope, now));
    expect(outOfOrder).toMatchObject({ accepted: 0, rejected: 1 });
    expect(trafficForService(outOfOrder.state, scope.serviceId).requestCount).toBe(3);
  });

  it('handles restarts and rejects overlapping delta intervals without adding them twice', () => {
    const delta = metrics(); delta.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.aggregationTemporality = 1;
    let state = ingestTelemetry(emptyTelemetryState(), decodeOtlp('metrics', delta, 'application/json', scope, now)).state;
    const overlap = metrics(3, 10); overlap.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.aggregationTemporality = 1;
    expect(ingestTelemetry(state, decodeOtlp('metrics', overlap, 'application/json', scope, now))).toMatchObject({ accepted: 0, rejected: 1 });
    const next = metrics(1, 100, { startTimeUnixNano: nanos(0) }); next.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.aggregationTemporality = 1;
    state = ingestTelemetry(state, decodeOtlp('metrics', next, 'application/json', scope, now)).state;
    expect(trafficForService(state, scope.serviceId).requestCount).toBe(3);
    let cumulative = ingestTelemetry(emptyTelemetryState(), decodeOtlp('metrics', metrics(), 'application/json', scope, now)).state;
    cumulative = ingestTelemetry(cumulative, decodeOtlp('metrics', metrics(1, 200, { startTimeUnixNano: nanos(100) }), 'application/json', scope, now)).state;
    expect(trafficForService(cumulative, scope.serviceId).requestCount).toBe(3);
  });

  it('keeps unavailable measurements distinct from zero, validates resources, and ignores client spans', () => {
    expect(trafficForService(emptyTelemetryState(), scope.serviceId)).toMatchObject({ source: 'unavailable', requestCount: null, errorCount: null });
    expect(decodeOtlp('traces', traces([span({ kind: 3 })]), 'application/json', scope, now).spans).toEqual([]);
    expect(decodeOtlp('traces', traces([span({ attributes: [attribute('rpc.system', 'grpc')] })]), 'application/json', scope, now).spans).toEqual([]);
    expect(decodeOtlp('traces', traces(), 'application/json', { ...scope, resourceServiceName: 'other-service' }, now)).toMatchObject({ spans: [], rejected: 1 });
    const state = ingestTelemetry(emptyTelemetryState(), decodeOtlp('traces', traces([span({ attributes: [attribute('http.request.method', 'GET')] })]), 'application/json', scope, now)).state;
    expect(trafficForService(state, scope.serviceId)).toMatchObject({ requestCount: 1, errorCount: null });
  });

  it('excludes log bodies and arbitrary attributes in JSON and Protobuf', () => {
    const message = { resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{
      timeUnixNano: nanos(0), severityNumber: 17, body: { stringValue: 'SECRET log body' }, attributes: [attribute('auth', 'SECRET token')],
    }] }] }] };
    for (const [body, type] of [[message, 'application/json'], [encodeOtlpFixture('logs', message), 'application/x-protobuf']] as const) {
      const decoded = decodeOtlp('logs', body, type, scope, now);
      expect(decoded.logs[0]).toMatchObject({ severityNumber: 17, bodyExcluded: true });
      expect(JSON.stringify(decoded)).not.toContain('SECRET');
    }
  });

  it('rejects malformed, oversized and structurally excessive payloads without touching saved state', () => {
    expect(() => decodeOtlp('traces', '{', 'application/json', scope, now)).toThrow('malformed');
    expect(() => decodeOtlp('traces', [], 'application/json', scope, now)).toThrow('malformed');
    expect(() => decodeOtlp('traces', Buffer.from([0xff, 0xff]), 'application/x-protobuf', scope, now)).toThrow('malformed');
    expect(() => decodeOtlp('traces', Buffer.alloc(8 * 1024 * 1024 + 1), 'application/json', scope, now)).toThrow('eight MiB');
    expect(() => decodeOtlp('traces', {}, 'text/plain', scope, now)).toThrow('JSON or Protobuf');
    let deep: unknown = {}; for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(() => decodeOtlp('traces', deep, 'application/json', scope, now)).toThrow('structural limits');
    expect(decodeOtlp('metrics', metrics(2, 0, { bucketCounts: ['1', '0'] }), 'application/json', scope, now)).toMatchObject({ metrics: [], rejected: 1 });
  });

  it('keeps valid histogram counts when buckets are unavailable and rejects changed duplicate interval values', () => {
    const first = decodeOtlp('metrics', metrics(2, 0, { explicitBounds: [], bucketCounts: [] }), 'application/json', scope, now);
    const state = ingestTelemetry(emptyTelemetryState(), first).state;
    expect(trafficForService(state, scope.serviceId)).toMatchObject({ requestCount: 2, meanLatencyMs: 50, p95LatencyMs: null });
    const changed = decodeOtlp('metrics', metrics(3, 0, { explicitBounds: [], bucketCounts: [] }), 'application/json', scope, now);
    expect(ingestTelemetry(state, changed)).toMatchObject({ accepted: 0, rejected: 1, duplicate: 0 });
  });

  it('returns exporter-compatible partial responses and preserves optional parameter templates without retaining queries', () => {
    expect(encodeOtlpResponse('traces', 'application/json', 2)).toMatchObject({ partialSuccess: { rejectedSpans: '2' } });
    expect(encodeOtlpResponse('metrics', 'application/json', 1)).toMatchObject({ partialSuccess: { rejectedDataPoints: '1' } });
    expect(encodeOtlpResponse('logs', 'application/x-protobuf', 0)).toEqual(Buffer.alloc(0));
    expect(Buffer.isBuffer(encodeOtlpResponse('logs', 'application/x-protobuf', 1))).toBe(true);
    expect(safeRouteTemplate('/users/:id?')).toBe('/users/:id?');
    expect(safeRouteTemplate('/users/{id?}')).toBe('/users/{id?}');
    expect(safeRouteTemplate('/users?secret=value')).toBeNull();
  });

  it('tracks locally generated HTTP traffic through a real OTLP HTTP Protobuf POST', async () => {
    let state = emptyTelemetryState();
    const observed: Record<string, unknown>[] = [];
    const liveNow = () => new Date().toISOString();
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        state = ingestTelemetry(state, decodeOtlp('traces', Buffer.concat(chunks), req.headers['content-type']!, scope, liveNow())).state;
        res.writeHead(200); res.end();
      });
    });
    const app = createServer((req, res) => {
      const start = BigInt(Date.now()) * 1_000_000n;
      const status = req.url?.includes('fail') ? 500 : 200;
      res.writeHead(status); res.end('fixture');
      observed.push(span({ traceId: Buffer.alloc(16, observed.length + 1), spanId: Buffer.alloc(8, observed.length + 1),
        startTimeUnixNano: start.toString(), endTimeUnixNano: (start + 5_000_000n).toString(),
        attributes: [attribute('http.request.method', 'GET'), attribute('http.route', '/items/:id'), attribute('http.response.status_code', status),
          attribute('url.full', `http://local${req.url}`), attribute('http.request.header.authorization', String(req.headers.authorization))] }));
    });
    const listen = (server: ReturnType<typeof createServer>) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local listener'); resolve(address.port);
    }));
    try {
      const appPort = await listen(app), collectorPort = await listen(collector);
      await fetch(`http://127.0.0.1:${appPort}/items/one?token=SECRET`, { headers: { authorization: 'Bearer SECRET' } });
      await fetch(`http://127.0.0.1:${appPort}/items/fail?token=SECRET`, { headers: { authorization: 'Bearer SECRET' } });
      const body = encodeOtlpFixture('traces', traces(observed));
      await new Promise<void>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: collectorPort, method: 'POST', path: '/v1/traces', headers: { 'content-type': 'application/x-protobuf', 'content-length': body.length } }, res => {
          res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Collector rejected fixture')));
        });
        req.on('error', reject); req.end(body);
      });
      expect(trafficForService(state, scope.serviceId)).toMatchObject({ source: 'sampled-spans', requestCount: 2, errorCount: 1, meanLatencyMs: 5 });
      expect(JSON.stringify(state)).not.toContain('SECRET');
    } finally {
      await Promise.all([app, collector].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    }
  });
});

describe('static API inventory', () => {
  let fixture: string;
  beforeEach(async () => { fixture = await mkdtemp(join(tmpdir(), 'agent-town-telemetry-')); });
  afterEach(async () => {
    const absolute = resolve(fixture);
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}agent-town-telemetry-`)) throw new Error('Unsafe fixture cleanup');
    await rm(absolute, { recursive: true, force: true });
  });
  const file = async (root: string, name: string, content: string) => {
    const parts = name.split('/'); const basename = parts.pop()!;
    const directory = join(root, ...parts); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, basename), content);
  };

  it('finds TypeScript Express mounts, Fastify plugin prefixes, and Next route handlers using syntax trees', async () => {
    await file(fixture, 'server.ts', `
      import express from 'express';
      import Fastify from 'fastify';
      const app = express(); const router = express.Router();
      router.get('/items/:id', handler); app.use('/v1', router);
      app.post('/items', handler); app.get(dynamicRoute, handler);
      app.route('/chain').get(handler).delete(handler);
      const server = Fastify();
      server.register(async function(api) { api.get('/health', handler); }, {prefix:'/service'});
      server.route({method: ['PUT', 'PATCH'], url:'/items/:id', handler});
      // app.delete('/fake-comment', handler);
      const misleading = "app.delete('/fake-string', handler)";
    `);
    await file(fixture, 'app/api/items/[id]/route.ts', 'export async function GET() { return Response.json({}); }');
    await file(fixture, 'app/index/route.ts', 'export function GET() { return Response.json({}); }');
    await file(fixture, 'pages/api/legacy/[id].ts', 'export default function handler(req, res) { res.end(); }');
    await file(fixture, 'pages/api/index.ts', 'export default function handler(req, res) { res.end(); }');
    const inventory = await scanApiInventory({ repoId: 'repo-a', rootPath: fixture });
    expect(inventory.endpoints.map(endpoint => [endpoint.method, endpoint.route])).toEqual(expect.arrayContaining([
      ['GET', '/v1/items/:id'], ['POST', '/items'], ['GET', '/service/health'], ['PUT', '/items/:id'], ['PATCH', '/items/:id'],
      ['GET', '/api/items/[id]'], ['ANY', '/api/legacy/[id]'],
      ['GET', '/chain'], ['DELETE', '/chain'], ['GET', '/index'], ['ANY', '/api'],
    ]));
    expect(inventory.endpoints.some(endpoint => endpoint.route?.includes('fake'))).toBe(false);
    expect(inventory.issues).toContain('dynamic-or-unsafe-route');
    expect(inventory.endpoints.every(endpoint => endpoint.source.line >= 1 && /^[a-f0-9]{64}$/u.test(endpoint.source.hash))).toBe(true);
  });

  it('parses real Python ASTs without running application code or loading repo-local ast.py', async () => {
    const marker = join(fixture, 'EXECUTED');
    await file(fixture, 'ast.py', `raise RuntimeError('PRIVATE module should never load')`);
    await file(fixture, 'api.py', `
from fastapi import FastAPI, APIRouter
from flask import Flask, Blueprint
open(${JSON.stringify(marker.replaceAll('\\', '/'))}, 'w').write('EXECUTED')
app = FastAPI()
router = APIRouter(prefix='/items')
@router.get('/{item_id}')
def read_item(): pass
app.include_router(router, prefix='/v2')
flask_app = Flask(__name__)
blueprint = Blueprint('api', __name__, url_prefix='/api')
@blueprint.route('/health', methods=['GET', 'POST'])
def health(): pass
flask_app.register_blueprint(blueprint)
`);
    const inventory = await scanApiInventory({ repoId: 'repo-a', rootPath: fixture });
    expect(inventory.issues).not.toContain('python-parser-unavailable');
    expect(inventory.endpoints.map(endpoint => [endpoint.method, endpoint.route])).toEqual(expect.arrayContaining([
      ['GET', '/v2/items/{item_id}'], ['GET', '/api/health'], ['POST', '/api/health'],
    ]));
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE module');
  });

  it('honors ignore rules and exclusions, rejects junctions, and bounds scanning', async () => {
    await file(fixture, '.gitignore', 'ignored/\n*.generated.ts\n');
    await file(fixture, 'ignored/routes.ts', "import express from 'express'; const app=express(); app.get('/ignored', handler);");
    await file(fixture, 'node_modules/routes.ts', "import express from 'express'; const app=express(); app.get('/dependency', handler);");
    await file(fixture, 'credentials.ts', "import express from 'express'; const app=express(); app.get('/secret', handler);");
    await file(fixture, 'routes.ts', "import express from 'express'; const app=express(); app.get('/visible', handler);");
    const linked = join(fixture, 'linked'); await symlink(join(fixture, 'ignored'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    const inventory = await scanApiInventory({ repoId: 'repo-a', rootPath: fixture });
    expect(inventory.endpoints.map(endpoint => endpoint.route)).toEqual(['/visible']);
    expect(inventory.issues).toContain('linked-path-excluded');
    const bounded = await scanApiInventory({ repoId: 'repo-a', rootPath: fixture, limits: { maxEntries: 1 } });
    expect(bounded.coverage).toBe('partial'); expect(bounded.issues).toContain('scan-limit');
  });

  it('reads explicitly selected OpenAPI JSON as data, with references unresolved and no secret values retained', async () => {
    await file(fixture, 'openapi.json', JSON.stringify({ openapi: '3.1.1', info: { title: 'Fixture', version: '1' }, paths: {
      '/items/{id}': { get: { responses: {}, description: 'SECRET body' } }, '/referenced': { $ref: 'https://user:SECRET@example.invalid/path' },
    }, servers: [{ url: 'https://user:SECRET@example.invalid/?token=SECRET' }] }));
    expect((await scanApiInventory({ repoId: 'repo-a', rootPath: fixture })).endpoints).toEqual([]);
    const inventory = await scanApiInventory({ repoId: 'repo-a', rootPath: fixture, openApiFiles: ['openapi.json'] });
    expect(inventory.endpoints).toHaveLength(1);
    expect(inventory.endpoints[0]).toMatchObject({ method: 'GET', route: '/items/{id}', framework: 'openapi' });
    expect(inventory.issues).toContain('openapi-reference-not-resolved');
    expect(JSON.stringify(inventory)).not.toContain('SECRET');
    await expect(scanApiInventory({ repoId: 'repo-a', rootPath: fixture, openApiFiles: ['../outside.json'] })).rejects.toThrow('inside the selected');
  });
});
