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
/** The literal kind strings this build's schema recognizes, read from the schema itself so this list
 * can never drift from what observationEventSchema actually accepts. */
export const currentEventKinds: readonly string[] = observationEventSchema.shape.kind.options;
export const observationBatchSchema = z.object({ events: z.array(observationEventSchema).min(1).max(100) }).strict();

/** The event format every service build to date understands: every kind and optional field that
 * exists today. A bridge with no evidence of a newer service always assumes this baseline. */
export const CURRENT_EVENT_FORMAT = 1;
/** Every event kind or optional field gated behind a format newer than the baseline. Empty today —
 * this version guard ships with nothing gated, so its release adds no new event field, kind or
 * marker (see docs/13-research-and-decisions.md, WS3-23). A later feature that adds a gated kind or
 * field lists it here with the format it first requires, and adds a matching fixture under
 * tests/fixtures/event-formats/; the compatibility test fails a table row added without one. */
export const eventFormatRequirements: { readonly kinds: Readonly<Record<string, number>>; readonly fields: Readonly<Record<string, number>> } = { kinds: {}, fields: {} };
export const SERVICE_CAPABILITIES_FILE = 'service-capabilities.json';
export const SERVICE_CAPABILITIES_BYTE_LIMIT = 4000;
export const serviceCapabilitiesSchema = z.object({
  eventFormat: z.number().int().positive(),
  kinds: z.array(z.string().max(40)).max(64),
  buildId: z.string().min(1).max(80),
  startedAt: z.string().datetime(),
}).strict();
export type ServiceCapabilities = z.infer<typeof serviceCapabilitiesSchema>;
/** True when `kind` is safe to emit against a service reporting `capability` — or none at all, since
 * every service build has always understood the ungated baseline. `requirements` defaults to the real
 * exported table; tests pass a synthetic one to exercise gating without a real gated kind to point at. */
export function eventKindSupported(kind: string, capability: ServiceCapabilities | null, requirements: Readonly<Record<string, number>> = eventFormatRequirements.kinds): boolean {
  // REV-22: `kind` can be external event text; Object.hasOwn keeps this a plain lookup instead of a
  // prototype-chain probe (a name like "constructor" must never resolve to a truthy inherited member).
  const required = Object.hasOwn(requirements, kind) ? requirements[kind] : undefined;
  return !required || (!!capability && capability.eventFormat >= required);
}
/** Same rule as eventKindSupported, for an optional field name instead of an event kind. */
export function eventFieldSupported(field: string, capability: ServiceCapabilities | null, requirements: Readonly<Record<string, number>> = eventFormatRequirements.fields): boolean {
  const required = Object.hasOwn(requirements, field) ? requirements[field] : undefined;
  return !required || (!!capability && capability.eventFormat >= required);
}
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
  /** Well-formed events from a newer bridge format this service build doesn't understand yet, quarantined
   * (not deleted) in the connection's spool/newer/ folder. Cleared on the next successful re-drain. */
  newerEventCount?: number;
  diagnostics?: { code: string; message: string; lastSeenAt: string }[];
  delivery?: { status: 'idle' | 'pending' | 'blocked'; pendingEvents: number | null; lastAttemptAt: string; message: string | null };
}
/** H0-32: the full durable per-connection Stop-watching outcome — everything a preview, a poll or a page
 * reload needs to reconstruct an honest status with no in-memory job at all (a restart, or simply a later
 * preview after the original job object is gone). Deliberately an array entry, not a `Record<string, …>`
 * keyed object (REV-22): `connectionId` is the lookup key, found with `.find`, exactly like the terser shape
 * this replaces. One entry per connection that has ever had a Stop-watching attempt; never removed by this
 * item, even once 'cleaned'. */
export interface StopSyncingConnectionProgress {
  connectionId: string; provider: ToolSurface; label: string;
  step: StopSyncingStep; result: 'stopped' | 'partial' | null;
  hooks: StopSyncingHooksOutcome; hooksPath: string | null; removedEntries: number; residualEntries: number;
  drain: StopSyncingDrainOutcome; eventsDelivered: number; eventsDiscarded: number; eventsRemaining: number | null;
  heldFromManager: boolean; heldReportCount: number;
  revoked: boolean; hidden: boolean; cleaned: boolean;
  /** True while a fresh Stop-watching attempt (with a fresh review) could still make progress on this
   * connection — i.e. result !== 'stopped'. Persisted (not just derived by the reader) so every reader
   * agrees, including after a restart. */
  retryable: boolean;
  updatedAt: string;
}
export interface ObservationState { connections: ObservationConnection[];
  /** H0-13/H0-32: durable per-connection Stop-watching progress, one entry per connection that has ever had a
   * Stop watching attempt for it (an entry is added the first time a job touches that connection and is never
   * removed by this item, even once revoked and cleaned — it is the only record of "how far did this get" once
   * the connection itself may already be gone from `connections` above). Read by the preview and by a new
   * POST so a restart or a page reload always resumes from the true last completed step, never redone from
   * the top. Not cleared by revoke; a fully 'cleaned' entry is simply never revisited by a later job. H0-32
   * widened this from `{connectionId, step, result}` to the full StopSyncingConnectionProgress shape: the
   * terser one could not honestly reconstruct a connection's hooks/drain/held-report/hide outcome once the
   * in-memory job that produced it was gone (a restart, or a later preview). */
  stopSyncingProgress?: StopSyncingConnectionProgress[];
  /** H0-13 / D47 (H0-17 default): report IDs a Stop-watching final drain saved while automatic manager
   * processing was on. The reports themselves stay in state.handoffs, saved and fully readable, exactly as
   * every other saved report — this list exists only so the preview and a connection's own result can say
   * "these were held", and so the exact one-line integration point is ready: eligibleForManager
   * (apps/service/src/workflow/budget.ts, not owned by this item) does not yet consult this list, so a held
   * report is not yet actually excluded from an automatic manager pass; wiring that in is the explicit
   * handoff this item records (see H0-13's evidence note), and H0-24 extends the same flag beyond this one
   * default case once D2/D47 is fully answered. Never cleared by this item. */
  heldFromManagerReportIds?: string[] }
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
export interface NativeSessionPage { items: NativeSession[]; total: number; nextCursor: string | null;
  /** H0-15: how many of this repo's (and, when given, this source's) sessions are visibility 'hidden'
   * right now — counted with no 30-day cutoff and ignoring `includeOlder`/`cursor`, unlike `total`/`items`
   * above, which stay windowed exactly as they always have. This is what the house inspector's Residents
   * block reads for its "N sessions hidden · Show" line, whether or not the request itself filtered by
   * `visibility=hidden`. */
  hiddenTotal: number }
export const registerNativeSourceSchema = z.object({ provider: surfaceSchema, label: z.string().trim().min(1).max(80), homePath: z.string().trim().min(1).max(4096) }).strict();
export const scanNativeSourceSchema = z.object({ repoId: z.string().min(1).max(100), includeOlder: z.boolean().optional(), cursor: z.string().max(1024).optional() }).strict();
export const nativeVisibilitySchema = z.object({ visible: z.boolean() }).strict();
export const bindNativeSourceSchema = z.object({ nativeSourceId: z.string().uuid() }).strict();

/** The onboarding auto-detection surface only covers tools with a verified local
 * history reader (see discoverNativeSessions); copilot-vscode and custom stay
 * manual through the existing single-tool setup. */
export const autoDetectSurfaceSchema = z.enum(['codex', 'claude', 'cursor', 'copilot-cli']);
export type AutoDetectSurface = z.infer<typeof autoDetectSurfaceSchema>;
/** One list of what the combined onboarding covers, so the service and the panel cannot drift. */
export const autoDetectTools: readonly { provider: AutoDetectSurface; label: string }[] = [
  { provider: 'codex', label: 'Codex' }, { provider: 'claude', label: 'Claude Code' }, { provider: 'cursor', label: 'Cursor' }, { provider: 'copilot-cli', label: 'Copilot CLI' },
];
export const toolDisplayName: Record<ToolSurface, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', 'copilot-cli': 'Copilot CLI', 'copilot-vscode': 'Copilot in VS Code', custom: 'Custom connector' };

/** Hook files each tool's callback inspects for ANOTHER Agent Town callback. The bridge rejects every
 * event as `hook-overlap` when it finds one (source-binding.ts hasAmbiguousHookOverlap); a unit test
 * keeps this table in step with that function so setup can refuse combinations that would go silent. */
const hookOverlapInspects: Partial<Record<ToolSurface, readonly ToolSurface[]>> = {
  claude: ['cursor', 'copilot-cli', 'copilot-vscode'],
  'copilot-cli': ['claude', 'copilot-vscode'],
  'copilot-vscode': ['claude', 'copilot-cli'],
};
export interface HookOverlapConflict { provider: ToolSurface; blockedBy: ToolSurface[] }
export function hookOverlapConflicts(providers: readonly ToolSurface[]): HookOverlapConflict[] {
  const present = new Set(providers);
  return [...present].flatMap(provider => {
    const blockedBy = (hookOverlapInspects[provider] ?? []).filter(other => present.has(other));
    return blockedBy.length ? [{ provider, blockedBy: [...blockedBy] }] : [];
  });
}
export function hookOverlapMessage(conflicts: readonly HookOverlapConflict[]): string {
  const names = (list: readonly ToolSurface[]) => list.map(provider => toolDisplayName[provider]).join(' and ');
  return `${conflicts.map(item => `${toolDisplayName[item.provider]} would not be able to report if ${names(item.blockedBy)} is connected too`).join('; ')}. These tools read the same hook files, and Agent Town ignores callbacks it cannot tell apart. Connect only one of them for this project.`;
}
/** Recommends a working combination of auto-detected tools, given what is installed on this
 * machine, which of those actually have session history for this project, and which auto-detect
 * tools already have a live connection here (always kept — this function never proposes dropping
 * an existing connection). Deterministic: the same inputs always produce the same ordered result,
 * and the result never contains a pair hookOverlapConflicts would reject, as long as `active` itself
 * is already conflict-free (true for every active set the guarded routes can ever produce). Driven
 * by the same table hookOverlapConflicts reads, so a later change to that table changes this
 * recommendation automatically — see WS2-01. */
export function recommendToolSet(installed: readonly AutoDetectSurface[], found: readonly AutoDetectSurface[], active: readonly ToolSurface[]): AutoDetectSurface[] {
  const order = autoDetectTools.map(tool => tool.provider);
  const activeSet = new Set(active);
  const result = new Set<AutoDetectSurface>(order.filter(provider => activeSet.has(provider)));
  // A tool with real session evidence for this project outranks one merely installed; ties break by
  // the fixed tool order so the result never depends on array/object iteration order.
  const rank = (provider: AutoDetectSurface) => found.includes(provider) ? 0 : 1;
  const candidates = order.filter(provider => !result.has(provider) && (found.includes(provider) || installed.includes(provider)))
    .sort((a, b) => rank(a) - rank(b) || order.indexOf(a) - order.indexOf(b));
  for (const provider of candidates) {
    const trial = new Set([...result, provider]);
    if (hookOverlapConflicts([...trial]).length === 0) result.add(provider);
  }
  return order.filter(provider => result.has(provider));
}

export interface ToolDetectionStatus {
  provider: AutoDetectSurface; label: string;
  state: 'not-installed' | 'no-activity' | 'found' | 'connected';
  sessionCount: number | null;
  /** False means the count stopped at the first discovery page; more sessions may exist. */
  sessionCountExact: boolean;
  connectionId?: string;
  connectionStatus?: ObservationConnection['status'];
  lastEventAt?: string | null;
  /** The tool's own activation step, for a connected tool that has not received an event yet. */
  nextStep?: string;
  message: string | null;
}
/** True once apps/service/dist/hook-bridge.cjs has been confirmed to exist on this machine (WS2-03).
 * Absent from an older service build that predates this check; the panel then assumes it is available,
 * matching every build to date's actual behaviour. */
export interface ToolDetectionSnapshot { repoId: string; tools: ToolDetectionStatus[]; bridge?: { available: boolean } }
export const toolDetectionReviewSchema = z.object({ repoId: z.string().min(1).max(100), providers: z.array(autoDetectSurfaceSchema).min(1).max(4) }).strict();
export interface ToolDetectionReviewItem { provider: AutoDetectSurface; label: string; connectionId: string; configPath: string; config: string; nextStep: string }
/** One requested (or already-active) tool that would stop another from reporting, in plain words —
 * see WS2-01. `tool` and `blockedBy` name the two sides exactly as hookOverlapConflicts does. */
export interface ToolDetectionConflict { tool: ToolSurface; blockedBy: ToolSurface[]; message: string }
/** `activeProviders` lists every tool already connected for this project (including manual ones) so the
 * review can warn when a chosen combination would make the bridge reject events. `conflicts` and
 * `recommendedTools` are present only when at least one requested tool would go silent alongside an
 * active connection or another requested tool; such a tool is left out of `items` (apply would refuse
 * it anyway) and explained here instead, alongside a working alternative combination — never a
 * refusal, since nothing is written by review either way. */
export interface ToolDetectionReview { repoId: string; items: ToolDetectionReviewItem[]; activeProviders: ToolSurface[]; conflicts?: ToolDetectionConflict[]; recommendedTools?: AutoDetectSurface[] }
export const toolDetectionApplySchema = z.object({ repoId: z.string().min(1).max(100), items: z.array(z.object({ provider: autoDetectSurfaceSchema, connectionId: z.string().uuid().regex(/^[0-9a-f-]{36}$/) }).strict()).min(1).max(4) }).strict();
export interface ToolDetectionApplyResult { provider: AutoDetectSurface; connectionId: string; applied: boolean; path?: string; error?: string; nextStep?: string }
export interface ToolDetectionApplyResponse { repoId: string; results: ToolDetectionApplyResult[] }

/** H0-12: hide every watched session of one project in one step. The body names the project only; the service decides which
 * sessions count (native-backed external residents, never managed runs). There is deliberately no bulk "show all". */
export const hideAllNativeSessionsSchema = z.object({ repoId: z.string().min(1).max(100) }).strict();
/** Counts only: no session name, id or path travels in this shape or in its audit note. */
export interface NativeHideAllCounts {
  /** Sessions this call newly hid (each also left the live town if it was there, freeing its slot). */
  hidden: number;
  /** Sessions of the project that were already hidden before this call. */
  alreadyHidden: number;
  /** External sessions without a native session identity (every Cursor hook session): they cannot stay hidden, so they stay in town. */
  skippedLegacy: number;
}
/** `snapshot` is the workspace state after the call. A call that hides 0 saves nothing new. */
export interface NativeHideAllResult extends NativeHideAllCounts { repoId: string; snapshot: import('./index.js').Snapshot }

/** H0-13: "Stop watching" undoes tracking for every active observation connection of one project, in the safe
 * order the docs prescribe (remove Agent Town's own hook entries, neutralize, bounded final drain, then —
 * only when nothing is left pending or the owner chose Discard — revoke and clean up local files), as one
 * resumable job under the project lock. GET .../stop-syncing?repoId= is a read-only preview; POST starts (or
 * attaches to) the job and answers 202 with an operation id the screen polls. */
export const STOP_SYNCING_CONNECTION_CAP = 32;
export const stopSyncingPreviewQuerySchema = z.object({ repoId: z.string().min(1).max(100) }).strict();
/** `editFiles: false` is the owner's explicit "stop without editing files" choice (skips the hook-entry-removal
 * step for every connection); `discard: true` is the separate, explicit "Discard N unread events" choice a
 * blocked or partial drain may need before revoke and clean-up can ever proceed for that connection. Both
 * default to what the preview recommends, but the owner's choice — not a default — is what is sent. */
export const stopSyncingRequestSchema = z.object({ repoId: z.string().min(1).max(100), reviewToken: z.string().min(1).max(200), editFiles: z.boolean(), discard: z.boolean() }).strict();
export type StopSyncingRequest = z.infer<typeof stopSyncingRequestSchema>;

/** The five durable step markers a connection's own Stop-watching progress moves through, in order. Persisted
 * per connection (never per job/operation, which is in-memory only and does not survive a restart) so a
 * restart or a page reload can show exactly how far a connection got and a repeat POST can finish the rest.
 * 'entries-removed' is reached whether or not anything was actually removed (including when the owner chose
 * "stop without editing files", or removal failed and was left for the owner to fix by hand) — it means only
 * "this connection's hook-entry decision is made", not "a file was edited". */
export const stopSyncingSteps = ['entries-removed', 'neutralized', 'drained', 'revoked', 'cleaned'] as const;
export type StopSyncingStep = typeof stopSyncingSteps[number];
/** What Stop watching did to one connection's hook entries. 'removed': at least one Agent Town entry was taken
 * out. 'absent': nothing of Agent Town's was found (already clean, or the file never had it). 'left': entries
 * were intentionally or unavoidably left in the file — the owner chose "stop without editing files", the file
 * was too large to back up safely, or removal otherwise failed; `hooksPath` names the file for manual review.
 * 'unsupported': a custom connector, which never had an automatically installed hook to remove. */
export type StopSyncingHooksOutcome = 'removed' | 'absent' | 'left' | 'unsupported';
/** 'skipped' means the final drain never ran (Stop watching's own job did not reach that connection yet, or it
 * had already reached 'revoked'/'cleaned' from an earlier attempt before this preview or poll was read). */
export type StopSyncingDrainOutcome = 'drained' | 'blocked' | 'timed-out' | 'cancelled' | 'skipped';
export interface StopSyncingConnectionStatus {
  connectionId: string;
  provider: ToolSurface;
  label: string;
  hooks: StopSyncingHooksOutcome;
  hooksPath: string | null;
  removedEntries: number;
  residualEntries: number;
  /** Preview only (the GET route): the hook event names (for example "PreToolUse") Stop watching would take
   * an entry out of, each with a count; never command text. Omitted from a poll of a running or finished job. */
  entries?: { event: string; count: number }[];
  drain: StopSyncingDrainOutcome;
  /** Spool event files the final drain took off this connection's spool (delivered as a saved report, or
   * recorded as an unavoidable coverage-gap loss); not the same as a queued manager pass — see `heldFromManager`. */
  eventsDelivered: number;
  /** Events deleted unread because the owner chose Discard; 0 unless discard was chosen for this connection. */
  eventsDiscarded: number;
  /** Events still pending after the drain stopped (blocked, timed out, or cancelled); null once the count is unknown. */
  eventsRemaining: number | null;
  /** True when the final drain saved at least one report while automatic manager processing was on: those
   * reports stay saved and fully readable, but Stop watching's own drain holds them from a paid manager pass
   * (D47/H0-17 default). False when nothing was held, whether because nothing was saved or automatic was off. */
  heldFromManager: boolean;
  /** H0-32: the actual number of reports `heldFromManager` refers to, not just whether any were held. 0
   * whenever heldFromManager is false. */
  heldReportCount: number;
  revoked: boolean;
  /** H0-32: true once `store.native.hideProject(...)` has actually run for this connection inside the revoke
   * commit (a single atomic transaction, so this is never "partially" true). False before revoke and for a
   * connection whose revoke happened outside this job (a plain manual revoke never hides sessions this way). */
  hidden: boolean;
  cleaned: boolean;
  step: StopSyncingStep | null;
  /** Set once this connection will make no further automatic progress: 'stopped' once every step completed
   * (or nothing was ever pending to begin with); 'partial' when the drain left events pending and Discard was
   * not chosen — the connection stays registered and neutralized, its spool untouched, and a repeat POST can
   * drain and finish it. Null while the job is still actively working on this connection. */
  result: 'stopped' | 'partial' | null;
}
/** `automaticManagerProcessing` is read once, at preview time, from the manager's own saved configuration
 * (workflow.manager.config.enabled && .automatic); it decides whether the preview's `heldFromManager` warning
 * applies, and it IS part of the review token's freshness check: `stopSyncingReviewToken` (history-state.ts)
 * hashes this same automatic-processing flag alongside the connection-ID set, so a config change between the
 * preview and the POST makes the token stale (409) exactly like a changed connection set does. */
export interface StopSyncingPreview {
  repoId: string;
  connections: StopSyncingConnectionStatus[];
  automaticManagerProcessing: boolean;
  reviewToken: string;
}
export interface StopSyncingOperation {
  operationId: string;
  repoId: string;
  status: 'running' | 'stopped' | 'partial' | 'cancelled';
  connections: StopSyncingConnectionStatus[];
  /** True only while the job is running and has not yet started its last connection. */
  cancellable: boolean;
}
