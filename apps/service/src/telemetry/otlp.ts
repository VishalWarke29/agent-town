import { createHash } from 'node:crypto';
import protobuf from 'protobufjs';
import { httpMethodSchema, type HttpMetricPoint, type HttpObservation, type LogObservation, type TelemetryScope, type TelemetrySignal } from '../../../../packages/contracts/src/telemetry';
import descriptor from './proto/descriptor.json' with { type: 'json' };

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 2_000;
const DAY = 86_400_000;
const root = protobuf.Root.fromJSON(descriptor);
const requestTypes = {
  traces: root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest'),
  metrics: root.lookupType('opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest'),
  logs: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest'),
};

export class TelemetryError extends Error {
  constructor(public readonly code: 'invalid-payload' | 'payload-too-large' | 'unsupported-content-type' | 'invalid-scope') {
    super({ 'invalid-payload': 'The telemetry payload is malformed or exceeds structural limits.',
      'payload-too-large': 'The decoded telemetry payload exceeds eight MiB.',
      'unsupported-content-type': 'Use OTLP HTTP JSON or Protobuf without compression.',
      'invalid-scope': 'The telemetry source is not configured correctly.' }[code]);
    this.name = 'TelemetryError';
  }
}
export interface DecodedTelemetryBatch {
  signal: TelemetrySignal;
  receivedAt: string;
  spans: HttpObservation[];
  logs: LogObservation[];
  metrics: HttpMetricPoint[];
  rejected: number;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,16}$/u.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null;
};
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function boundedStructure(value: unknown) {
  const stack = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++visited > 100_000 || item.depth > 32) throw new TelemetryError('invalid-payload');
    if (typeof item.value === 'string' && item.value.length > MAX_BYTES) throw new TelemetryError('payload-too-large');
    if (item.value && typeof item.value === 'object' && !(item.value instanceof Uint8Array)) {
      const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
      if (children.length > 10_000) throw new TelemetryError('invalid-payload');
      for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
}

function attrs(value: unknown): Map<string, unknown> | null {
  const entries = array(value);
  if (entries.length > 128) return null;
  const kept = new Map<string, unknown>();
  const allowed = new Set(['service.name', 'service.instance.id', 'http.route', 'http.request.method', 'http.method',
    'http.response.status_code', 'http.status_code', 'agent_town.run_id']);
  for (const entry of entries) {
    const item = object(entry);
    if (typeof item.key !== 'string' || !allowed.has(item.key)) continue;
    if (kept.has(item.key)) return null;
    const wrapped = object(item.value);
    const value = wrapped.stringValue ?? wrapped.intValue;
    if (typeof value === 'string' && value.length <= 500 || typeof value === 'number' && Number.isFinite(value)) kept.set(item.key, value);
  }
  return kept;
}

function id(value: unknown, bytes: number): string | null {
  const text = value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value;
  return typeof text === 'string' && new RegExp(`^[a-fA-F0-9]{${bytes * 2}}$`, 'u').test(text)
    && !/^0+$/u.test(text) ? text.toLowerCase() : null;
}

function timestamp(value: unknown, now: number): { iso: string; nanos: bigint } | null {
  if (typeof value !== 'string' || !/^\d{1,20}$/u.test(value)) return null;
  const nanos = BigInt(value);
  const milliseconds = Number(nanos / 1_000_000n);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < now - 30 * DAY || milliseconds > now + 300_000) return null;
  return { iso: new Date(milliseconds).toISOString(), nanos };
}

export function safeRouteTemplate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const optionalParameters = value.replace(/(:[a-zA-Z_][a-zA-Z0-9_]*|\{[a-zA-Z_][a-zA-Z0-9_]*)\?(?=\/|\}|$)/gu, '$1');
  return value.length <= 240 && value.startsWith('/') && !value.startsWith('//')
    && !/[\u0000-\u0020\u007f?#@\\]/u.test(optionalParameters) && !/%(?:2f|5c|3f|23|40)/iu.test(value) ? value : null;
}

function httpAttributes(attributes: Map<string, unknown>, scope: TelemetryScope) {
  const method = httpMethodSchema.safeParse(attributes.get('http.request.method') ?? attributes.get('http.method'));
  const possibleRoute = safeRouteTemplate(attributes.get('http.route'));
  const route = possibleRoute && scope.routeTemplates.includes(possibleRoute) ? possibleRoute : null;
  const rawStatus = integer(attributes.get('http.response.status_code') ?? attributes.get('http.status_code'), 599);
  const statusCode = rawStatus !== null && rawStatus >= 100 ? rawStatus : null;
  return { method: method.success ? method.data : null, route, statusCode };
}

export function decodeOtlp(signal: TelemetrySignal, body: Buffer | string | unknown, contentType: string, scope: TelemetryScope, now = new Date().toISOString()): DecodedTelemetryBatch {
  if (!['traces', 'metrics', 'logs'].includes(signal) || !scope.sourceId || !scope.serviceId || !scope.repoId
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(scope.resourceServiceName) || scope.routeTemplates.length > 2_000
    || scope.routeTemplates.some(route => !safeRouteTemplate(route)) || !Number.isFinite(Date.parse(now))) throw new TelemetryError('invalid-scope');
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (!['application/json', 'application/x-protobuf'].includes(type)) throw new TelemetryError('unsupported-content-type');
  let parsed: unknown;
  try {
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      if (Buffer.byteLength(body) > MAX_BYTES) throw new TelemetryError('payload-too-large');
      parsed = type === 'application/x-protobuf'
        ? requestTypes[signal].toObject(requestTypes[signal].decode(Buffer.isBuffer(body) ? body : Buffer.from(body)), { longs: String, bytes: Buffer, enums: Number })
        : JSON.parse(body.toString());
    } else {
      if (type !== 'application/json') throw new TelemetryError('invalid-payload');
      boundedStructure(body);
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) throw new TelemetryError('payload-too-large');
      parsed = body;
    }
    boundedStructure(parsed);
  } catch (error) { if (error instanceof TelemetryError) throw error; throw new TelemetryError('invalid-payload'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TelemetryError('invalid-payload');
  const envelope = object(parsed);
  const field = { traces: 'resourceSpans', metrics: 'resourceMetrics', logs: 'resourceLogs' }[signal];
  if (envelope[field] !== undefined && !Array.isArray(envelope[field])) throw new TelemetryError('invalid-payload');
  const batch: DecodedTelemetryBatch = { signal, receivedAt: now, spans: [], logs: [], metrics: [], rejected: 0 };
  const nowMs = Date.parse(now);
  let visited = 0;
  for (const resourceEntry of array(envelope[field])) {
    const resource = object(resourceEntry);
    const resourceAttributes = attrs(object(resource.resource).attributes);
    const allowedResource = resourceAttributes?.get('service.name') === scope.resourceServiceName;
    const scopeField = { traces: 'scopeSpans', metrics: 'scopeMetrics', logs: 'scopeLogs' }[signal];
    for (const scopeEntry of array(resource[scopeField])) {
      const scopeObject = object(scopeEntry);
      const records = array(scopeObject[{ traces: 'spans', metrics: 'metrics', logs: 'logRecords' }[signal]]);
      for (const rawRecord of records) {
        if (++visited > MAX_RECORDS) throw new TelemetryError('invalid-payload');
        const record = object(rawRecord);
        if (!allowedResource) { batch.rejected++; continue; }
        if (signal === 'traces') {
          const attributes = attrs(record.attributes);
          const traceId = id(record.traceId, 16), spanId = id(record.spanId, 8);
          const start = timestamp(record.startTimeUnixNano, nowMs), end = timestamp(record.endTimeUnixNano, nowMs);
          if (integer(record.kind, 5) !== 2) continue; // Only SERVER spans can count requests.
          if (!attributes || !traceId || !spanId || !start || !end || end.nanos < start.nanos || end.nanos - start.nanos > BigInt(DAY) * 1_000_000n) { batch.rejected++; continue; }
          if (!attributes.has('http.request.method') && !attributes.has('http.method') && !attributes.has('http.route')) continue;
          const http = httpAttributes(attributes, scope);
          const run = attributes.get('agent_town.run_id');
          batch.spans.push({ id: digest([scope.sourceId, traceId, spanId]), sourceId: scope.sourceId, serviceId: scope.serviceId, repoId: scope.repoId,
            traceId, spanId, parentSpanId: id(record.parentSpanId, 8), ...http,
            error: object(record.status).code === 2 ? true : http.statusCode === null ? null : http.statusCode >= 500,
            durationMs: Number(end.nanos - start.nanos) / 1_000_000, occurredAt: end.iso,
            runId: typeof run === 'string' && scope.allowedRunIds?.includes(run) ? run : null, sampling: 'sampled-observation' });
        } else if (signal === 'logs') {
          const at = timestamp(record.timeUnixNano ?? record.observedTimeUnixNano, nowMs);
          if (!at) { batch.rejected++; continue; }
          const traceId = id(record.traceId, 16), spanId = id(record.spanId, 8), severityNumber = integer(record.severityNumber, 24);
          batch.logs.push({ id: digest([scope.sourceId, at.nanos.toString(), traceId, spanId, severityNumber]), sourceId: scope.sourceId,
            serviceId: scope.serviceId, repoId: scope.repoId, occurredAt: at.iso, severityNumber, traceId, spanId, bodyExcluded: true });
        } else {
          if (record.name !== 'http.server.request.duration' || record.unit !== 's') { batch.rejected++; continue; }
          const histogram = object(record.histogram);
          const temporality = integer(histogram.aggregationTemporality, 2);
          if (temporality !== 1 && temporality !== 2) { batch.rejected++; continue; }
          for (const rawPoint of array(histogram.dataPoints)) {
            if (++visited > MAX_RECORDS) throw new TelemetryError('invalid-payload');
            const point = object(rawPoint), attributes = attrs(point.attributes);
            const start = timestamp(point.startTimeUnixNano, nowMs), end = timestamp(point.timeUnixNano, nowMs);
            const count = integer(point.count, 1_000_000_000), sum = finite(point.sum);
            const rawBounds = array(point.explicitBounds), rawBuckets = array(point.bucketCounts);
            const bounds = rawBounds.map(finite), buckets = rawBuckets.map(value => integer(value, 1_000_000_000));
            if (!attributes || !start || !end || start.nanos > end.nanos || count === null || rawBounds.length > 100
              || bounds.some(value => value === null || value > 86_400) || buckets.some(value => value === null)
              || (buckets.length !== bounds.length + 1 && !(bounds.length === 0 && buckets.length === 0)) || bounds.some((value, index) => index > 0 && value! <= bounds[index - 1]!)
              || (buckets.length > 0 && buckets.reduce<number>((total, value) => total + (value ?? 0), 0) !== count) || sum !== null && sum > count * 86_400) { batch.rejected++; continue; }
            const http = httpAttributes(attributes, scope);
            const instance = resourceAttributes?.get('service.instance.id');
            const seriesId = digest([scope.sourceId, typeof instance === 'string' ? instance : null, http, object(scopeObject.scope).name ?? null]);
            const pointId = digest([seriesId, start.nanos.toString(), end.nanos.toString(), count, sum, bounds, buckets]);
            batch.metrics.push({ id: pointId, seriesId, sourceId: scope.sourceId, serviceId: scope.serviceId, repoId: scope.repoId, ...http,
              startAt: start.iso, occurredAt: end.iso, temporality: temporality === 1 ? 'delta' : 'cumulative', count,
              sumMs: sum === null ? null : sum * 1000, boundsMs: (bounds as number[]).map(value => value * 1000), bucketCounts: buckets as number[] });
          }
        }
      }
    }
  }
  return batch;
}

/** Protocol-only helper for reproducible local fixtures. It does not send data anywhere. */
export function encodeOtlpFixture(signal: TelemetrySignal, message: Record<string, unknown>): Buffer {
  return Buffer.from(requestTypes[signal].encode(requestTypes[signal].fromObject(message)).finish());
}

export function encodeOtlpResponse(signal: TelemetrySignal, contentType: string, rejected: number): Buffer | Record<string, unknown> {
  if (!Number.isSafeInteger(rejected) || rejected < 0) throw new TelemetryError('invalid-payload');
  const rejectionField = { traces: 'rejectedSpans', metrics: 'rejectedDataPoints', logs: 'rejectedLogRecords' }[signal];
  const response = rejected > 0 ? { partialSuccess: { [rejectionField]: String(rejected), errorMessage: 'Some records were rejected. Check source scope and coverage.' } } : {};
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'application/json') return response;
  if (type !== 'application/x-protobuf') throw new TelemetryError('unsupported-content-type');
  const responseType = root.lookupType(requestTypes[signal].fullName.replace(/Request$/u, 'Response'));
  return Buffer.from(responseType.encode(responseType.fromObject(response)).finish());
}
