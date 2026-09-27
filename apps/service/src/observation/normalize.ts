import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { observationEventSchema, type ObservationEvent, type ToolSurface } from '@agent-town/contracts';
import { normalizeObservationPath, reportedRelativePath, safeHookProjectPath } from './paths.js';

/** Reduces common credential exposure; arbitrary free text is still untrusted evidence. */
export function redactEvidence(value: string): string {
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[credential removed]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token removed]')
    .replace(/\b(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\r\n,;]+/gi, '$1=[removed]')
    .replace(/https?:\/\/[^\s<>"']+/g, raw => { try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return '[URL removed]'; } })
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[key material removed]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 12000);
}

/** Native title metadata is display text, never task instructions or evidence. */
export function safeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = redactEvidence(value.slice(0, 512))
    .replace(/[\u0080-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/gu, ' ').trim().slice(0, 160).trim();
  return title || undefined;
}

export function safeReportedFiles(files: string[] | undefined): string[] {
  return (files ?? []).map(file => file.replace(/\\/g, '/')).filter(file =>
    file.length > 0 && file.length <= 512 && !isAbsolute(file) && !file.startsWith('/') && !file.includes(':') && !file.split('/').some(part => part === '..' || part === '.' || /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part)) && !/[\x00-\x1f]/.test(file)
  ).slice(0, 100);
}

const names: Record<string, ObservationEvent['kind']> = {
  SessionStart: 'session.start', sessionStart: 'session.start', SessionEnd: 'session.end', sessionEnd: 'session.end',
  UserPromptSubmit: 'turn.start', userPromptSubmitted: 'turn.start', beforeSubmitPrompt: 'turn.start', beforeSendPrompt: 'turn.start',
  PreToolUse: 'tool.start', preToolUse: 'tool.start', beforeShellExecution: 'tool.start', beforeMCPExecution: 'tool.start',
  PostToolUse: 'tool.finish', postToolUse: 'tool.finish', afterShellExecution: 'tool.finish', afterMCPExecution: 'tool.finish', afterFileEdit: 'tool.finish',
  PostToolUseFailure: 'tool.failed', postToolUseFailure: 'tool.failed', StopFailure: 'tool.failed', ErrorOccurred: 'tool.failed', errorOccurred: 'tool.failed',
  Stop: 'turn.end', stop: 'turn.end', agentStop: 'turn.end', SubagentStart: 'session.start', subagentStart: 'session.start', SubagentStop: 'turn.end', subagentStop: 'turn.end',
};
const text = (record: Record<string, unknown>, ...keys: string[]) => keys.map(key => record[key]).find((value): value is string => typeof value === 'string');
const opaque = (value: string) => /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : createHash('sha256').update(value).digest('hex');
const nativeIdentifier = (value: string | undefined) => value && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined;
export const hookRejectionCodes = ['project-path-rejected', 'missing-session-id', 'missing-child-id', 'unsupported-event', 'malformed-payload'] as const;
export type HookRejection = typeof hookRejectionCodes[number];

/** Consume only allowlisted metadata and optional final response. Never read a transcript. */
export function normalizeHook(surface: ToolSurface, eventName: string, input: unknown, repoRoot: string, now = new Date().toISOString(), rejected?: (code: HookRejection) => void): ObservationEvent | null {
  const reject = (code: HookRejection) => { rejected?.(code); return null; };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return reject('malformed-payload');
  const data = input as Record<string, unknown>;
  const event = text(data, 'hook_event_name') ?? eventName;
  // REV-22: `event` is external hook payload text. A plain object lookup would return an inherited
  // member (e.g. Object.prototype.constructor) for a name like "constructor", which is truthy and
  // would slip past the `!kind` check below as a bogus, non-string "kind". Object.hasOwn keeps this
  // an ordinary lookup table, never a prototype-chain probe.
  let kind = Object.hasOwn(names, event) ? names[event] : undefined;
  const childHook = /subagent/i.test(event);
  const rawSession = surface === 'cursor' ? text(data, ...(childHook ? ['parent_conversation_id'] : []), 'conversation_id', 'session_id') : text(data, 'session_id', 'sessionId', 'conversation_id');
  if (!kind) return reject('unsupported-event');
  if (!rawSession || rawSession.length > 512) return reject('missing-session-id');
  const roots = surface === 'cursor' && Array.isArray(data.workspace_roots) ? data.workspace_roots : [data.cwd];
  if (!roots.some(root => typeof root === 'string' && safeHookProjectPath(repoRoot, root))) return reject('project-path-rejected');
  const child = surface === 'cursor' && childHook ? text(data, 'subagent_id', 'agent_id', 'agentId')
    : childHook || surface === 'claude' ? text(data, 'agent_id', 'agentId') : undefined;
  // A child event with no stable child ID must not overwrite the parent's lifecycle.
  if (childHook && !child || child !== undefined && (!child || child.length > 512)) return reject('missing-child-id');
  if (surface === 'cursor' && event === 'subagentStop') {
    if (data.status === 'error') kind = 'tool.failed';
    if (data.status === 'aborted') kind = 'cancelled';
  }
  // Preserve ordinary pre-existing parent:child identities, while disambiguating
  // identifiers containing the separator. Never identify a child by its role/name.
  const sessionId = child ? rawSession.includes(':') || child.includes(':')
    ? `child-${createHash('sha256').update(JSON.stringify([rawSession, child])).digest('hex')}` : opaque(`${rawSession}:${child}`) : opaque(rawSession);
  const timestamp = typeof data.timestamp === 'number' && Number.isFinite(data.timestamp) && Math.abs(data.timestamp) < 8.64e15 ? new Date(data.timestamp).toISOString() : text(data, 'timestamp');
  const sourceTime = timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : now;
  const finalText = kind === 'turn.end' ? text(data, 'last_assistant_message', 'response', ...(surface === 'cursor' && childHook ? ['summary'] : [])) : undefined;
  const rawFile = text(data, 'file_path');
  const file = rawFile && (normalizeObservationPath(rawFile) ? reportedRelativePath(repoRoot, rawFile) : rawFile);
  const nativeSessionId = nativeIdentifier(surface === 'cursor' && child ? text(data, 'conversation_id') ?? rawSession : rawSession);
  const normalized = {
    id: randomUUID(), sessionId, ...(child ? { parentSessionId: opaque(rawSession) } : {}), kind,
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(child && nativeIdentifier(rawSession) ? { nativeParentSessionId: rawSession } : {}),
    ...(nativeIdentifier(child) ? { nativeChildId: child } : {}),
    occurredAt: sourceTime,
    ...(finalText ? { summary: redactEvidence(finalText) } : {}),
    ...(text(data, 'tool_name', 'toolName') ? { tool: redactEvidence(text(data, 'tool_name', 'toolName')!).slice(0, 100) } : {}),
    ...(file ? { files: safeReportedFiles([file]) } : {}),
  };
  const parsed = observationEventSchema.safeParse(normalized);
  return parsed.success ? parsed.data : reject('malformed-payload');
}

/** Custom publishers use a registered local source, never source scope from input. */
export function normalizeCustomEvent(input: unknown, nativeSourceId: string, sourceRevision: number, rejected?: (code: HookRejection) => void): ObservationEvent | null {
  const parsed = observationEventSchema.safeParse(input);
  if (!parsed.success) {
    rejected?.(parsed.error.issues.some(issue => issue.path[0] === 'sessionId') ? 'missing-session-id'
      : parsed.error.issues.some(issue => issue.path[0] === 'kind') ? 'unsupported-event' : 'malformed-payload');
    return null;
  }
  const event = parsed.data;
  const normalized = observationEventSchema.safeParse({ ...event, nativeSourceId, sourceRevision, producer: 'custom', nativeSessionId: event.nativeSessionId ?? event.sessionId,
    ...(event.summary !== undefined ? { summary: redactEvidence(event.summary) } : {}),
    ...(event.tool !== undefined ? { tool: redactEvidence(event.tool).slice(0, 100) } : {}),
    ...(event.files !== undefined ? { files: safeReportedFiles(event.files) } : {}) });
  if (!normalized.success) rejected?.('malformed-payload');
  return normalized.success ? normalized.data : null;
}
