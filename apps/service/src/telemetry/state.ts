import type { HttpMetricPoint, ServiceTraffic, TelemetryState } from '../../../../packages/contracts/src/telemetry';
import type { DecodedTelemetryBatch } from './otlp';

const DAY = 86_400_000;
const MAX_DETAILS = 1_000;
const MAX_METRICS = 2_000;
const MAX_SERIES = 500;

export function emptyTelemetryState(): TelemetryState {
  return { sources: [], inventories: [], spans: [], logs: [], metrics: [], metricCursors: [], seen: [], coverage: { rejected: 0, dropped: 0, lastReceivedAt: null } };
}

export function ingestTelemetry(previous: TelemetryState, batch: DecodedTelemetryBatch): { state: TelemetryState; accepted: number; rejected: number; duplicate: number } {
  const state = structuredClone(previous);
  const now = Date.parse(batch.receivedAt);
  const seen = new Set(state.seen.map(item => item.id));
  let accepted = 0, rejected = batch.rejected, duplicate = 0;
  const remember = (id: string) => { seen.add(id); state.seen.push({ id, at: batch.receivedAt }); accepted++; };
  for (const item of batch.spans) {
    if (seen.has(item.id)) { duplicate++; continue; }
    state.spans.push(item); remember(item.id);
  }
  for (const item of batch.logs) {
    if (seen.has(item.id)) { duplicate++; continue; }
    state.logs.push(item); remember(item.id);
  }
  for (const item of batch.metrics) {
    if (seen.has(item.id)) { duplicate++; continue; }
    const index = state.metricCursors.findIndex(cursor => cursor.seriesId === item.seriesId);
    const cursor = state.metricCursors[index];
    if (!cursor && state.metricCursors.length >= MAX_SERIES) { rejected++; continue; }
    if (cursor && item.occurredAt <= cursor.occurredAt) { rejected++; continue; }
    let delta: HttpMetricPoint = structuredClone(item);
    if (cursor) {
      if (item.temporality !== cursor.temporality) { rejected++; continue; }
      if (item.temporality === 'delta') {
        if (item.startAt < cursor.occurredAt) { rejected++; continue; }
      } else if (item.startAt === cursor.startAt) {
        if (item.count < cursor.count || JSON.stringify(item.boundsMs) !== JSON.stringify(cursor.boundsMs)
          || item.bucketCounts.some((count, bucket) => count < cursor.bucketCounts[bucket])
          || item.sumMs !== null && cursor.sumMs !== null && item.sumMs < cursor.sumMs) { rejected++; continue; }
        delta = { ...delta, startAt: cursor.occurredAt, temporality: 'delta', count: item.count - cursor.count,
          sumMs: item.sumMs === null || cursor.sumMs === null ? null : item.sumMs - cursor.sumMs,
          bucketCounts: item.bucketCounts.map((count, bucket) => count - cursor.bucketCounts[bucket]) };
      } else if (item.startAt < cursor.occurredAt) { rejected++; continue; }
    }
    if (index < 0) state.metricCursors.push(item); else state.metricCursors[index] = item;
    state.metrics.push(delta); remember(item.id);
  }
  const retain = <T extends { occurredAt: string }>(items: T[], age: number, cap: number): T[] => {
    const kept = items.filter(item => Date.parse(item.occurredAt) >= now - age).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(-cap);
    state.coverage.dropped += items.length - kept.length; return kept;
  };
  state.spans = retain(state.spans, 7 * DAY, MAX_DETAILS);
  state.logs = retain(state.logs, 7 * DAY, MAX_DETAILS);
  state.metrics = retain(state.metrics, 30 * DAY, MAX_METRICS);
  state.metricCursors = state.metricCursors.filter(item => Date.parse(item.occurredAt) >= now - 30 * DAY);
  state.seen = state.seen.filter(item => Date.parse(item.at) >= now - 30 * DAY).slice(-10_000);
  state.coverage.rejected += rejected;
  state.coverage.lastReceivedAt = batch.receivedAt;
  return { state, accepted, rejected, duplicate };
}

export function trafficForService(state: TelemetryState, serviceId: string): ServiceTraffic {
  const metrics = state.metrics.filter(point => point.serviceId === serviceId);
  const spans = state.spans.filter(span => span.serviceId === serviceId);
  const summary: ServiceTraffic = { serviceId, source: 'unavailable', requestCount: null, errorCount: null, meanLatencyMs: null,
    p50LatencyMs: null, p95LatencyMs: null, latencyKind: 'unavailable', from: null, through: null,
    partial: state.coverage.rejected > 0 || state.coverage.dropped > 0 };
  // Select one source for the entire service. Metrics and matching server spans must never be added.
  if (metrics.length) {
    summary.source = 'metrics'; summary.requestCount = metrics.reduce((total, point) => total + point.count, 0);
    summary.errorCount = metrics.every(point => point.statusCode !== null)
      ? metrics.reduce((total, point) => total + (point.statusCode! >= 500 ? point.count : 0), 0) : null;
    summary.from = metrics.map(point => point.startAt).sort()[0];
    summary.through = metrics.map(point => point.occurredAt).sort().at(-1)!;
    summary.meanLatencyMs = summary.requestCount && metrics.every(point => point.sumMs !== null)
      ? metrics.reduce((total, point) => total + point.sumMs!, 0) / summary.requestCount : null;
    const buckets = new Map<number, number>();
    for (const point of metrics) point.bucketCounts.forEach((count, index) => {
      const upper = point.boundsMs[index] ?? Infinity; buckets.set(upper, (buckets.get(upper) ?? 0) + count);
    });
    const ordered = [...buckets].sort(([a], [b]) => a - b);
    const percentile = (fraction: number) => {
      if (!summary.requestCount || metrics.some(point => point.bucketCounts.length === 0)) return null;
      let accumulated = 0;
      for (const [upper, count] of ordered) {
        accumulated += count;
        if (accumulated >= summary.requestCount * fraction) return Number.isFinite(upper) ? upper : null;
      }
      return null;
    };
    summary.p50LatencyMs = percentile(0.5); summary.p95LatencyMs = percentile(0.95);
    summary.latencyKind = 'histogram-upper-bound';
  } else if (spans.length) {
    summary.source = 'sampled-spans'; summary.requestCount = spans.length;
    summary.errorCount = spans.every(span => span.error !== null) ? spans.filter(span => span.error).length : null;
    const durations = spans.map(span => span.durationMs).sort((a, b) => a - b);
    summary.meanLatencyMs = durations.reduce((total, value) => total + value, 0) / durations.length;
    summary.p50LatencyMs = durations[Math.ceil(durations.length * 0.5) - 1];
    summary.p95LatencyMs = durations[Math.ceil(durations.length * 0.95) - 1];
    summary.latencyKind = 'sample-observation';
    summary.from = spans.map(span => span.occurredAt).sort()[0]; summary.through = spans.map(span => span.occurredAt).sort().at(-1)!;
  }
  return summary;
}
