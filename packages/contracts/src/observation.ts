import { z } from 'zod';

export const surfaceSchema = z.enum(['codex', 'claude', 'cursor', 'copilot-vscode', 'copilot-cli', 'custom']);
export type ToolSurface = z.infer<typeof surfaceSchema>;
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
export const observationEventSchema = z.object({
  id: identifier,
  sessionId: identifier,
  parentSessionId: identifier.optional(),
  nativeSourceId: z.string().uuid().optional(),
  nativeSessionId: identifier.optional(),
  nativeParentSessionId: identifier.optional(),
  nativeChildId: identifier.optional(),
  sourceRevision: z.number().int().positive().optional(),
  producer: surfaceSchema.optional(),
  kind: z.enum(['session.start', 'session.end', 'turn.start', 'turn.end', 'tool.start', 'tool.finish', 'tool.failed', 'report', 'cancelled']),
  occurredAt: z.string().datetime(),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  summary: z.string().max(12000).optional(),
  tool: z.string().max(100).optional(),
  files: z.array(z.string().max(1024)).max(100).optional(),
}).strict();
export type ObservationEvent = z.infer<typeof observationEventSchema>;
export const observationBatchSchema = z.object({ events: z.array(observationEventSchema).min(1).max(100) }).strict();
export const createObservationSchema = z.object({ provider: surfaceSchema, repoId: z.string().min(1).max(100), label: z.string().trim().min(1).max(80), nativeSourceId: z.string().uuid().optional() }).strict();
export interface ObservationConnection {
  id: string;
  provider: ToolSurface;
  repoId: string;
  label: string;
  nativeSourceId?: string;
  sourceRevision?: number;
  binding?: 'declared' | 'resolved' | 'ambiguous';
  status: 'unverified' | 'receiving' | 'revoked';
  createdAt: string;
  lastEventAt: string | null;
  version: string | null;
  coverage: 'partial';
  droppedEvents: number;
  /** False means this count is a lower bound, for example after a coalesced overflow marker. */
  droppedEventsExact?: boolean;
  diagnostics?: { code: string; message: string; lastSeenAt: string }[];
  delivery?: { status: 'idle' | 'pending' | 'blocked'; pendingEvents: number | null; lastAttemptAt: string; message: string | null };
}
export interface ObservationState { connections: ObservationConnection[] }
export interface ObservationSetup {
  connection: ObservationConnection; configPath: string; config: string; bridgeCommand: string; instructions: string[];
  diagnostics?: { code: string; message: string }[];
  readiness?: { configured: boolean; nativeTrustRequired: boolean; sourceBinding: 'resolved' | 'declared' | 'ambiguous' | 'unavailable'; overlappingHooks: boolean };
}

export type NativeDiscoveryAvailability = 'available' | 'unsupported' | 'unavailable';
export interface NativeSource {
  id: string; provider: ToolSurface; label: string;
  status: 'ready' | 'unavailable' | 'needs-review';
  discovery: NativeDiscoveryAvailability; lastScanAt: string | null; message: string | null; revision: number;
  nextScanCursor?: string | null; lastScanRepoId?: string; lastScanIncludeOlder?: boolean;
}
export interface NativeToolStatus {
  provider: ToolSurface; label: string; detected: boolean; defaultHomePath: string | null;
  discovery: NativeDiscoveryAvailability; message: string; version: string | null;
}
export interface NativeSetupSnapshot { sources: NativeSource[]; tools: NativeToolStatus[] }
/** A native session label only; prompts and transcript text are not titles. */
export const nativeSessionTitleSchema = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u);
export interface NativeSession {
  id: string; agentId: string; sourceId: string; provider: ToolSurface; nativeSessionId: string;
  title?: string;
  /** Explicit native agent nickname, separate from the shared conversation title. */
  nativeAgentName?: string;
  parentNativeSessionId?: string; repoId: string; createdAt: string | null; nativeUpdatedAt: string | null;
  discoveredAt: string; observedAt: string | null; visible: boolean; sceneVisible: boolean;
  visibility?: 'auto' | 'shown' | 'hidden';
  activity: import('./index.js').AgentActivity;
}
export interface NativeSessionPage { items: NativeSession[]; total: number; nextCursor: string | null }
export const registerNativeSourceSchema = z.object({ provider: surfaceSchema, label: z.string().trim().min(1).max(80), homePath: z.string().trim().min(1).max(4096) }).strict();
export const scanNativeSourceSchema = z.object({ repoId: z.string().min(1).max(100), includeOlder: z.boolean().optional(), cursor: z.string().max(1024).optional() }).strict();
export const nativeVisibilitySchema = z.object({ visible: z.boolean() }).strict();
export const bindNativeSourceSchema = z.object({ nativeSourceId: z.string().uuid() }).strict();
