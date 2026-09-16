import { z } from 'zod';

export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);
export type HttpMethod = z.infer<typeof httpMethodSchema>;
export type TelemetrySignal = 'traces' | 'metrics' | 'logs';

export interface ApiEndpoint {
  id: string;
  repoId: string;
  method: HttpMethod | 'ANY';
  route: string | null;
  framework: 'express' | 'fastify' | 'next' | 'fastapi' | 'flask' | 'openapi';
  source: { path: string; line: number; hash: string };
  confidence: 'declared' | 'partial';
  reason: string | null;
}
export interface ApiInventory {
  repoId: string;
  endpoints: ApiEndpoint[];
  scannedAt: string;
  filesScanned: number;
  coverage: 'complete' | 'partial';
  issues: string[];
}
export interface TelemetryScope {
  sourceId: string;
  serviceId: string;
  repoId: string;
  resourceServiceName: string;
  routeTemplates: string[];
  allowedRunIds?: string[];
}
export interface HttpObservation {
  id: string;
  sourceId: string;
  serviceId: string;
  repoId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  method: HttpMethod | null;
  route: string | null;
  statusCode: number | null;
  error: boolean | null;
  durationMs: number;
  occurredAt: string;
  runId: string | null;
  sampling: 'sampled-observation';
}
export interface LogObservation {
  id: string;
  sourceId: string;
  serviceId: string;
  repoId: string;
  occurredAt: string;
  severityNumber: number | null;
  traceId: string | null;
  spanId: string | null;
  bodyExcluded: true;
}
export interface HttpMetricPoint {
  id: string;
  seriesId: string;
  sourceId: string;
  serviceId: string;
  repoId: string;
  method: HttpMethod | null;
  route: string | null;
  statusCode: number | null;
  startAt: string;
  occurredAt: string;
  temporality: 'delta' | 'cumulative';
  count: number;
  sumMs: number | null;
  boundsMs: number[];
  bucketCounts: number[];
}
export interface MetricCursor extends HttpMetricPoint {}
export interface TelemetrySource {
  id: string;
  serviceId: string;
  repoId: string;
  serviceName: string;
  createdAt: string;
  status: 'unverified' | 'receiving' | 'revoked';
  lastReceivedAt: string | null;
}
export interface TelemetryState {
  sources?: TelemetrySource[];
  inventoryOperation?: {
    id: string;
    repoId: string;
    status: 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
    startedAt: string;
    finishedAt: string | null;
    message: string;
  };
  inventories: ApiInventory[];
  spans: HttpObservation[];
  logs: LogObservation[];
  metrics: HttpMetricPoint[];
  metricCursors: MetricCursor[];
  seen: { id: string; at: string }[];
  coverage: { rejected: number; dropped: number; lastReceivedAt: string | null };
}
export interface ServiceTraffic {
  serviceId: string;
  source: 'metrics' | 'sampled-spans' | 'unavailable';
  requestCount: number | null;
  errorCount: number | null;
  meanLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  latencyKind: 'histogram-upper-bound' | 'sample-observation' | 'unavailable';
  from: string | null;
  through: string | null;
  partial: boolean;
}

export const telemetryRegistrationSchema = z.object({
  repoId: z.string().min(1).max(100), serviceName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u),
}).strict();
export const apiInventoryRequestSchema = z.object({
  repoId: z.string().min(1).max(100), openApiFiles: z.array(z.string().min(1).max(500)).max(10).optional(),
}).strict();
