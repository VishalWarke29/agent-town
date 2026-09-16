import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { SpanKind } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader, AggregationType } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const input = lines[Symbol.asyncIterator]();
const config = JSON.parse((await input.next()).value);
assert(/^http:\/\/127\.0\.0\.1:\d+\/ingest\/otlp$/.test(config.endpoint), 'Fixture receiver must be loopback.');
const marker = 'SMOKE_PRIVATE_MARKER';
const resource = resourceFromAttributes({ 'service.name': config.resourceName, 'private.resource': marker });
const counts = { traces: 0, metrics: 0, failures: 0 };
const instrumentExport = (exporter, kind) => {
  const original = exporter.export.bind(exporter);
  exporter.export = (data, callback) => original(data, result => { counts[kind]++; if (result.code !== 0) counts.failures++; callback(result); });
  return exporter;
};
const options = signal => ({ url: `${config.endpoint}/v1/${signal}`, headers: { Authorization: config.authorization }, timeoutMillis: 5000 });
const traces = new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(instrumentExport(new OTLPTraceExporter(options('traces')), 'traces'), { scheduledDelayMillis: 60000 })] });
const metrics = new MeterProvider({ resource,
  readers: [new PeriodicExportingMetricReader({ exporter: instrumentExport(new OTLPMetricExporter(options('metrics')), 'metrics'), exportIntervalMillis: 60000, exportTimeoutMillis: 5000 })],
  views: [{ instrumentName: 'http.server.request.duration', aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 1] } } }],
});
const tracer = traces.getTracer('agent-town-node-sdk-smoke', '1.0.0');
const duration = metrics.getMeter('agent-town-node-sdk-smoke', '1.0.0').createHistogram('http.server.request.duration', { unit: 's' });
let handled = 0;
const server = createServer((req, res) => {
  const start = performance.now();
  const index = ++handled, code = index === 2 ? 503 : 200;
  const attributes = { 'http.request.method': req.method, 'http.route': index === 3 ? `/unreviewed/${marker}` : '/items/:id', 'http.response.status_code': code,
    'url.full': `http://127.0.0.1${req.url}`, 'http.request.header.authorization': req.headers.authorization,
    'http.request.body': marker, 'http.response.body': marker, 'agent_town.run_id': 'UNAPPROVED_SMOKE_RUN' };
  const span = tracer.startSpan(`GET ${req.url}`, { kind: SpanKind.SERVER, attributes });
  req.resume(); req.on('end', () => {
    res.statusCode = code; res.end(marker);
    duration.record(Math.max((performance.now() - start) / 1000, 0.0001), attributes);
    span.addEvent(marker, { 'exception.message': marker }); span.end();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const hit = index => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, method: 'GET', path: `/items/${marker}-${index}?api_key=${marker}`, headers: { Authorization: `Bearer ${marker}`, 'Content-Length': Buffer.byteLength(marker) } }, res => { res.resume(); res.on('end', resolve); });
  req.on('error', reject); req.end(marker);
});
try {
  await hit(1); await hit(2); await traces.forceFlush(); await metrics.forceFlush();
  assert(counts.failures === 0, 'A real Node SDK export failed.');
  process.stdout.write(`${JSON.stringify({ phase: 'flushed', requests: 2 })}\n`);
  assert((await input.next()).value === 'continue', 'Fixture continuation was not received.');
  await hit(3);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await traces.shutdown(); await metrics.shutdown();
  assert(counts.failures === 0 && counts.traces >= 2 && counts.metrics >= 2, 'Node shutdown exports were not acknowledged.');
  process.stdout.write(`${JSON.stringify({ phase: 'done', requests: handled, exports: counts, shutdown: true })}\n`);
} finally { server.close(); lines.close(); }
