import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { eventFieldSupported, eventKindSupported, observationEventSchema, serviceCapabilitiesSchema, surfaceSchema, SERVICE_CAPABILITIES_BYTE_LIMIT, SERVICE_CAPABILITIES_FILE, type ObservationEvent, type ServiceCapabilities, type ToolSurface } from '@agent-town/contracts';
import { normalizeObservationPath, safeHookProjectPath, sameObservationPath } from './paths.js';
import { hookRejectionCodes } from './normalize.js';

const base = { connectionId: z.string().uuid(), provider: surfaceSchema, repoPath: z.string(), spoolPath: z.string() };
export const bridgeConfigSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...base }).strict(),
  z.object({ version: z.literal(2), ...base, nativeSourceId: z.string().uuid().optional(), nativeHome: z.string().max(4096).optional(), sourceRevision: z.number().int().positive().optional(), binding: z.enum(['declared', 'resolved', 'ambiguous']).optional() }).strict(),
]);
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export const sourceBindingDiagnosticCodes = ['source-ambiguous', 'source-home-mismatch', 'producer-mismatch', 'hook-overlap'] as const;
export const sourceDiagnosticCodes = [...sourceBindingDiagnosticCodes, ...hookRejectionCodes] as const;
export type SourceDiagnostic = typeof sourceDiagnosticCodes[number];

/** Native metadata can identify some wire formats; compatible formats remain unknown. */
export function nativeHookProducer(input: unknown): ToolSurface | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const data = input as Record<string, unknown>;
  if (typeof data.cursor_version === 'string' && typeof data.conversation_id === 'string' && Array.isArray(data.workspace_roots)) return 'cursor';
  if (typeof data.sessionId === 'string' && typeof data.cwd === 'string' && typeof data.timestamp === 'number' && data.session_id === undefined && data.conversation_id === undefined) return 'copilot-cli';
  return undefined;
}

/** Copilot CLI and Copilot in VS Code also read `.claude/settings.local.json`. For PascalCase events they send
 * snake_case fields plus an ISO `timestamp`; Claude Code's own hook input has no timestamp, and Cursor,
 * Codex and camelCase Copilot payloads are excluded by their own fingerprints. Only used to stop such a
 * callback from being attributed to Claude Code. */
function looksLikeCopilotClaudeImport(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const data = input as Record<string, unknown>;
  return typeof data.session_id === 'string' && typeof data.timestamp === 'string' && data.permission_mode === undefined
    && data.cursor_version === undefined && data.conversation_id === undefined && data.sessionId === undefined;
}

function readHookConfiguration(path: string, root: string): unknown {
  if (!safeHookProjectPath(root, path)) throw new Error('Unsafe hook path');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink > 1 || before.size > 128000) throw new Error('Unsafe hook configuration');
    const buffer = Buffer.alloc(before.size + 1), bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = lstatSync(path), openedAfter = fstatSync(descriptor);
    if (bytes !== before.size || !safeHookProjectPath(root, path) || after.isSymbolicLink() || after.nlink > 1 || after.ino !== before.ino || after.dev !== before.dev || openedAfter.size !== before.size || openedAfter.mtimeMs !== before.mtimeMs) throw new Error('Hook configuration changed');
    return JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
  } finally { closeSync(descriptor); }
}

/** Bounded, no-follow read of the running service's own capability file from inside its spool
 * directory. Never throws: a missing file, an oversized one, a symlink, unparseable JSON or a schema
 * mismatch all read the same as "no evidence of a newer service," the safe default. A bridge
 * invocation is a short-lived process with no memory between runs, so this always re-reads fresh —
 * there is nothing to cache. */
export function readServiceCapabilities(spoolPath: string): ServiceCapabilities | null {
  try {
    const path = join(spoolPath, SERVICE_CAPABILITIES_FILE);
    if (!safeHookProjectPath(spoolPath, path)) return null;
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.nlink > 1 || before.size > SERVICE_CAPABILITIES_BYTE_LIMIT) return null;
      const buffer = Buffer.alloc(before.size), bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
      const after = lstatSync(path);
      if (bytes !== before.size || after.isSymbolicLink() || after.nlink > 1 || after.ino !== before.ino || after.dev !== before.dev) return null;
      const parsed = serviceCapabilitiesSchema.safeParse(JSON.parse(buffer.toString('utf8')));
      return parsed.success ? parsed.data : null;
    } finally { closeSync(descriptor); }
  } catch { return null; }
}

/** Applies the version guard to one outgoing event: null when the running service (per `capability`)
 * doesn't understand this event's own kind yet — nothing is written for it, the same as if the native
 * tool had stayed quiet, never a coverage-gap loss. Otherwise, strips any optional field the service
 * doesn't understand yet; the four always-required fields are never gated. The bridge only ever emits
 * less than it knows, never a guess dressed as a real field. */
export function gateEventForCapability(event: ObservationEvent, capability: ServiceCapabilities | null): ObservationEvent | null {
  if (!eventKindSupported(event.kind, capability)) return null;
  const always = new Set(['id', 'sessionId', 'kind', 'occurredAt']);
  return Object.fromEntries(Object.entries(event).filter(([key]) => always.has(key) || eventFieldSupported(key, capability))) as ObservationEvent;
}

/** Inspect bounded configuration only. Never run commands or read transcripts. */
export function hasAmbiguousHookOverlap(config: BridgeConfig): boolean {
  if (config.provider === 'codex' || config.provider === 'custom') return false;
  const paths = config.provider === 'cursor' ? [join(config.repoPath, '.cursor/hooks.json')] : [join(config.repoPath, '.claude/settings.local.json'), join(config.repoPath, '.claude/settings.json')];
  // A native Cursor callback makes its compatible Claude callback redundant.
  if (config.provider === 'claude') paths.push(join(config.repoPath, '.cursor/hooks.json'));
  const github = join(config.repoPath, '.github/hooks');
  if (config.provider !== 'cursor') {
    try {
      if (!safeHookProjectPath(config.repoPath, github)) return true;
      const entries = readdirSync(github, { withFileTypes: true });
      if (entries.length > 40) return true;
      paths.push(...entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => join(github, entry.name)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
  }
  let bytes = 0;
  for (const path of paths) {
    try {
      if (!safeHookProjectPath(config.repoPath, path)) return true;
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 128000 || (bytes += info.size) > 512000) return true;
      const value: unknown = readHookConfiguration(path, config.repoPath);
      const hooks = value && typeof value === 'object' && !Array.isArray(value) ? (value as { hooks?: unknown }).hooks : undefined;
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
      for (const entries of Object.values(hooks)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const serialized = JSON.stringify(entry);
          if (!serialized.includes('hook-bridge.cjs') || !serialized.includes('--config')) continue;
          const ids = [...serialized.matchAll(/([a-f0-9-]{36})\.json\b/gi)].map(match => match[1]!.toLowerCase());
          if (ids.some(id => id !== config.connectionId.toLowerCase())) return true;
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
  }
  return false;
}

export function resolveHookSource(config: BridgeConfig, input: unknown, environment: NodeJS.ProcessEnv = process.env): { fields: Partial<ObservationEvent>; blocked: boolean; diagnostic?: SourceDiagnostic } {
  const producer = nativeHookProducer(input);
  if (producer && producer !== config.provider) return { fields: {}, blocked: true, diagnostic: 'producer-mismatch' };
  if (config.provider === 'claude' && looksLikeCopilotClaudeImport(input)) return { fields: {}, blocked: true, diagnostic: 'producer-mismatch' };
  if (hasAmbiguousHookOverlap(config)) return { fields: {}, blocked: true, diagnostic: 'hook-overlap' };
  const fields: Partial<ObservationEvent> = producer ? { producer } : {};
  if (config.version === 2 && config.provider === 'copilot-vscode' && !producer) return { fields, blocked: true, diagnostic: 'source-ambiguous' };
  if (config.version === 1 || !config.nativeSourceId) return { fields, blocked: false };
  if (!config.nativeHome) return { fields, blocked: true, diagnostic: 'source-ambiguous' };
  const variable = config.provider === 'codex' ? 'CODEX_HOME' : config.provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : config.provider === 'copilot-cli' ? 'COPILOT_HOME' : null;
  if (!variable) return { fields, blocked: !producer, diagnostic: 'source-ambiguous' };
  const userHome = environment.USERPROFILE || environment.HOME;
  const suffix = config.provider === 'codex' ? '.codex' : config.provider === 'claude' ? '.claude' : '.copilot';
  const actualHome = environment[variable] || (userHome ? join(userHome, suffix) : undefined);
  if (!actualHome || !sameObservationPath(config.nativeHome, actualHome) || !safeHookProjectPath(config.nativeHome, actualHome)) return { fields, blocked: true, diagnostic: 'source-home-mismatch' };
  return { fields: { ...fields, nativeSourceId: config.nativeSourceId, sourceRevision: config.sourceRevision ?? 1 }, blocked: false };
}

const envelopeSchema = z.object({ version: z.literal(2), event: observationEventSchema }).strict();
export function parseSpoolEvent(input: unknown): ObservationEvent | null {
  const envelope = envelopeSchema.safeParse(input);
  if (envelope.success) return envelope.data.event;
  const legacy = observationEventSchema.safeParse(input);
  return legacy.success ? legacy.data : null;
}

export type SpoolEventClassification = { status: 'ok'; event: ObservationEvent } | { status: 'newer' } | { status: 'malformed' };

/**
 * An issue caused only by an unknown top-level key (`.strict()`), an unrecognized `kind` value, or an
 * unrecognized/higher envelope `version` is exactly what a NEWER bridge writing a format this service
 * doesn't understand yet would produce on an otherwise well-formed envelope. Anything else (a missing
 * or wrongly-typed required field) means the file itself is malformed, not merely from the future.
 */
function isNewerFormatIssue(issue: z.core.$ZodIssue): boolean {
  if (issue.code === 'unrecognized_keys') return true;
  if (issue.code !== 'invalid_value') return false;
  const key = issue.path[issue.path.length - 1];
  return key === 'kind' || key === 'version';
}

/**
 * Distinguishes a well-formed-but-future event (move to newer/, never delete) from a genuinely
 * malformed or unsafe one (delete, as today). Used by the spool drain's keep-newer guard.
 */
export function classifySpoolEvent(input: unknown): SpoolEventClassification {
  const envelope = envelopeSchema.safeParse(input);
  if (envelope.success) return { status: 'ok', event: envelope.data.event };
  const legacy = observationEventSchema.safeParse(input);
  if (legacy.success) return { status: 'ok', event: legacy.data };
  if (typeof input !== 'object' || input === null) return { status: 'malformed' };
  const record = input as Record<string, unknown>;
  const looksEnveloped = 'event' in record && 'version' in record;
  let issues = (looksEnveloped ? envelope.error : legacy.error)!.issues.filter(issue => issue.path[0] !== 'event');
  if (looksEnveloped && typeof record.event === 'object' && record.event !== null) {
    const nested = observationEventSchema.safeParse(record.event);
    if (!nested.success) issues = [...issues, ...nested.error.issues];
  }
  return issues.length > 0 && issues.every(isNewerFormatIssue) ? { status: 'newer' } : { status: 'malformed' };
}

export function normalizeBridgePaths(config: BridgeConfig): BridgeConfig | null {
  const repoPath = normalizeObservationPath(config.repoPath), spoolPath = normalizeObservationPath(config.spoolPath);
  return repoPath && spoolPath ? { ...config, repoPath, spoolPath } : null;
}
