import { randomUUID } from 'node:crypto';
import { mkdir, opendir, lstat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type ObservationConnection, type ObservationEvent } from '@agent-town/contracts';
import { IdentityError } from '../identity/index.js';
import { checkedPath, readMetadataFile } from '../discovery/paths.js';
import type { Store } from '../store.js';
import type { RegisteredObservation } from './registry.js';
import { SPOOL_EVENT_BYTES, SPOOL_DIRECTORY_LIMIT, SPOOL_BATCH_LIMIT, SPOOL_NEWER_DIRECTORY_LIMIT, SPOOL_NEWER_BYTE_LIMIT } from './spool-limits.js';
import { classifySpoolEvent, parseSpoolEvent, sourceBindingDiagnosticCodes, sourceDiagnosticCodes, type SourceDiagnostic } from './source-binding.js';
// Exported so setup.ts's clean-up (H0-11) counts a connection's pending spool files the exact same way this
// module's own drain does; service-capabilities.json and any marker file never match it.
export const eventName = /^[a-f0-9-]{36}\.json$/;
const lossClaim = /^coverage-gap-[a-f0-9-]{36}\.pending$/;
const sourceClaim = new RegExp(`^source-diagnostic-(${sourceDiagnosticCodes.join('|')})-[a-f0-9-]{36}\\.pending$`);
const sourceMessages: Record<SourceDiagnostic, string> = {
  'source-ambiguous': 'Native profile attribution is unresolved. Receipts with an identified tool may retain their connection scope; receipts without an identified tool are not accepted.',
  'source-home-mismatch': 'A callback came from a different or unavailable native home. Select the matching registered source before relying on discovery reconciliation.',
  'producer-mismatch': 'A compatible tool invoked another tool’s callback. That receipt was not attributed; review the native hook configuration.',
  'hook-overlap': 'Overlapping Agent Town callbacks make native attribution ambiguous. Those receipts were not accepted; remove redundant app callbacks or use a separately registered native hook location.',
  'project-path-rejected': 'A callback did not provide a safe path inside the selected project. Check the native working folder and the repository selected for this connection.',
  'missing-session-id': 'A callback did not provide a supported stable session identifier. Check the native tool version and hook format; this event was not assigned to an agent.',
  'missing-child-id': 'A child callback did not provide a supported stable child identifier. Check the native tool’s child-event support; the parent’s activity was preserved.',
  'unsupported-event': 'A callback used an unsupported event kind. Review the generated hook configuration for the selected native tool and version.',
  'malformed-payload': 'A callback had malformed or oversized event data. Review the native hook format and payload limits; raw callback contents were not saved.',
};
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

interface SpoolOptions {
  directory: string; spool: string; record: RegisteredObservation; store: Store;
  receive(events: ObservationEvent[]): unknown;
  closing(): boolean;
}

/** Only compare source sequence when timestamps tie; separate sessions have no shared sequence. */
export function orderObservedEvents(left: ObservationEvent, right: ObservationEvent): number {
  const timestamp = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (timestamp) return timestamp;
  const session = JSON.stringify([left.sessionId, left.parentSessionId ?? null]).localeCompare(JSON.stringify([right.sessionId, right.parentSessionId ?? null]));
  if (session) return session;
  // A total ordering also covers a mixture of sequenced and unsequenced events.
  const sequenceKind = Number(left.sequence !== undefined) - Number(right.sequence !== undefined);
  if (sequenceKind) return sequenceKind;
  if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) return left.sequence - right.sequence;
  // Equal-time lifecycle completion sorts after a report, so the latest visible state remains ended.
  const terminal = (event: ObservationEvent) => ['session.end', 'tool.failed', 'cancelled'].includes(event.kind) ? 1 : 0;
  return terminal(left) - terminal(right) || left.id.localeCompare(right.id);
}

/** Bounded offline replay; successful commits precede deletion, and transient failures preserve the input. */
export async function drainObservationSpool(options: SpoolOptions): Promise<void> {
  const { spool, directory, store, record } = options;
  const setDelivery = (status: NonNullable<ObservationConnection['delivery']>['status'], pendingEvents: number | null, message: string | null) => {
    const previous = store.snapshot().state.observation?.connections.find(item => item.id === record.connection.id)?.delivery;
    if (previous?.status === status && previous.pendingEvents === pendingEvents && previous.message === message
      && (status === 'idle' || Date.now() - Date.parse(previous.lastAttemptAt) < 30000)) return;
    store.commit(`spool-status:${randomUUID()}`, (state, now) => {
      const source = state.observation?.connections.find(item => item.id === record.connection.id);
      if (source && source.status !== 'revoked') source.delivery = { status, pendingEvents, lastAttemptAt: now, message };
      return 'observation.delivery';
    });
  };
  const recordLoss = (name: string, reason: string, exact: boolean) => {
    store.commit(`spool-loss:${record.connection.id}:${name}`, (state, now) => {
      const source = state.observation?.connections.find(item => item.id === record.connection.id);
      if (!source) throw new Error('The observation connection is unavailable.');
      source.droppedEvents++;
      source.droppedEventsExact = source.droppedEventsExact === true && exact;
      state.activity.unshift({ id: `spool-loss:${record.connection.id}:${name}`, message: `Observation coverage gap: ${reason} ${exact ? 'One event was not accepted.' : 'At least one event was not recorded; the exact count is unavailable.'}`, createdAt: now, kind: 'system' });
      state.activity = state.activity.slice(0, 500);
      return 'observation.coverage_gap';
    }, JSON.stringify({ name, reason, exact }));
  };
  const remove = async (name: string, base = spool) => { await checkedPath(base, [directory]); await unlink(join(base, name)); };
  const newerDirectory = join(spool, 'newer');
  const setNewerCount = (count: number) => {
    const previous = store.snapshot().state.observation?.connections.find(item => item.id === record.connection.id)?.newerEventCount ?? 0;
    if (previous === count) return;
    store.commit(`spool-newer-count:${record.connection.id}:${randomUUID()}`, state => {
      const source = state.observation?.connections.find(item => item.id === record.connection.id);
      if (source) source.newerEventCount = count;
      return 'observation.newer_events';
    });
  };
  let pending: number | null = null;
  try {
    await checkedPath(spool, [directory]);
    const entries = await opendir(spool);
    const files: string[] = [], claims: string[] = [], sourceClaims: string[] = [];
    let scanned = 0, limited = false, temporary = false;
    for await (const entry of entries) {
      if (++scanned > SPOOL_DIRECTORY_LIMIT) { limited = true; break; }
      if (eventName.test(entry.name)) files.push(entry.name);
      else if (lossClaim.test(entry.name)) claims.push(entry.name);
      else if (sourceClaim.test(entry.name)) sourceClaims.push(entry.name);
      else if (/^[a-f0-9-]{36}\.tmp$/.test(entry.name)) temporary = true;
    }
    pending = limited ? null : files.length;
    // Claim an overflow marker before acknowledging it. A new writer can then
    // create the next marker without an unlink race hiding later loss.
    const marker = 'coverage-gap';
    try {
      const info = await lstat(join(spool, marker));
      const claimed = `coverage-gap-${randomUUID()}.pending`;
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
        recordLoss(marker, 'The overflow marker was unsafe.', false); await remove(marker);
      } else {
        await checkedPath(spool, [directory]); await rename(join(spool, marker), join(spool, claimed)); claims.push(claimed);
      }
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    for (const code of sourceDiagnosticCodes) {
      const marker = `source-diagnostic-${code}`;
      try {
        const info = await lstat(join(spool, marker));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) { recordLoss(marker, 'A source diagnostic marker was unsafe.', false); await remove(marker); continue; }
        const claimed = `${marker}-${randomUUID()}.pending`;
        await checkedPath(spool, [directory]); await rename(join(spool, marker), join(spool, claimed)); sourceClaims.push(claimed);
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    for (const name of sourceClaims.slice(0, SPOOL_BATCH_LIMIT)) {
      if (options.closing()) return;
      const code = sourceClaim.exec(name)![1] as SourceDiagnostic;
      store.commit(`source-diagnostic:${record.connection.id}:${name}`, (state, now) => {
        const source = state.observation?.connections.find(item => item.id === record.connection.id);
        if (!source) throw new Error('The observation connection is unavailable.');
        const bindingIssue = (sourceBindingDiagnosticCodes as readonly string[]).includes(code);
        if (code !== 'source-ambiguous') { source.droppedEvents++; source.droppedEventsExact = false; }
        if (bindingIssue) source.binding = 'ambiguous';
        source.diagnostics = [{ code, message: sourceMessages[code], lastSeenAt: now }, ...(source.diagnostics ?? []).filter(item => item.code !== code)].slice(0, 8);
        const message = `${bindingIssue ? 'Observation source needs review' : 'Observation input rejected'}: ${sourceMessages[code]}`;
        if (!state.activity.some(item => item.kind === 'system' && item.message === message && Date.parse(now) - Date.parse(item.createdAt) < 30000)) {
          state.activity.unshift({ id: `source-diagnostic:${record.connection.id}:${name}`, message, createdAt: now, kind: 'system' }); state.activity = state.activity.slice(0, 500);
        }
        return bindingIssue ? 'observation.source_ambiguous' : 'observation.input_rejected';
      }, JSON.stringify({ code }));
      await remove(name);
    }
    for (const claim of claims.slice(0, SPOOL_BATCH_LIMIT)) {
      if (options.closing()) return;
      recordLoss(claim, 'The bounded local hook spool reported overflow or unsupported input.', false);
      await remove(claim);
    }
    // newer/ is created lazily, only the moment something actually needs quarantining below — an
    // empty spool must stay exactly empty, the same as before this guard existed.
    const selected: { name: string; event: ObservationEvent; base: string }[] = [];
    // Re-drain newer/ first: a file quarantined by an older service build may now parse cleanly if
    // this service build understands its format. Read-only retry — a file that still fails to parse
    // is left exactly where it is, never re-classified or removed here.
    let newerNames: string[] = [];
    try {
      const newerEntries = await opendir(newerDirectory);
      for await (const entry of newerEntries) if (eventName.test(entry.name)) newerNames.push(entry.name);
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    for (const name of newerNames.sort().slice(0, SPOOL_BATCH_LIMIT)) {
      if (options.closing()) return;
      let text: string;
      try { text = await readMetadataFile(join(newerDirectory, name), [directory], SPOOL_EVENT_BYTES); }
      catch (error) { if (errorCode(error) === 'ENOENT') continue; if (errorCode(error) !== 'unsafe-root') throw error; continue; }
      let event: ObservationEvent | null = null;
      try { event = parseSpoolEvent(JSON.parse(text)); } catch { /* Still not parseable; leave it in newer/ untouched. */ }
      if (event) selected.push({ name, event, base: newerDirectory });
    }
    // Sorting this bounded filename selection is for repeatability, not source order.
    for (const name of files.sort().slice(0, SPOOL_BATCH_LIMIT)) {
      if (options.closing()) return;
      let text: string;
      try { text = await readMetadataFile(join(spool, name), [spool], SPOOL_EVENT_BYTES); }
      catch (error) {
        if (errorCode(error) === 'ENOENT') { if (pending !== null) pending--; continue; }
        // Unsafe paths and oversized entries are rejected without reading their contents.
        if (errorCode(error) !== 'unsafe-root') throw error;
        recordLoss(name, 'A local event file exceeded its bound or failed path validation.', true);
        await remove(name); if (pending !== null) pending--; continue;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { recordLoss(name, 'A local event file did not match the supported event contract.', true); await remove(name); if (pending !== null) pending--; continue; }
      const classification = classifySpoolEvent(parsed);
      if (classification.status === 'ok') { selected.push({ name, event: classification.event, base: spool }); continue; }
      if (classification.status === 'malformed') {
        recordLoss(name, 'A local event file did not match the supported event contract.', true);
        await remove(name); if (pending !== null) pending--; continue;
      }
      // 'newer': a well-formed envelope this service build doesn't understand yet. Quarantine it —
      // move, never delete — unless the bounded newer/ folder is already at its cap. newer/ may not
      // exist yet (nothing has ever needed quarantining in this spool); that reads as an empty folder.
      let currentCount = 0, currentBytes = 0;
      try {
        const current = await opendir(newerDirectory);
        for await (const entry of current) { if (eventName.test(entry.name)) { currentCount++; currentBytes += (await lstat(join(newerDirectory, entry.name))).size; } }
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      if (currentCount >= SPOOL_NEWER_DIRECTORY_LIMIT || currentBytes + Buffer.byteLength(text, 'utf8') > SPOOL_NEWER_BYTE_LIMIT) {
        recordLoss(name, 'A newer-format event could not be quarantined because the newer/ folder is full.', false);
        if (pending !== null) pending--; continue; // Left in place, per spec — never deleted, never silently dropped.
      }
      await mkdir(newerDirectory, { recursive: true });
      await checkedPath(spool, [directory]); await checkedPath(newerDirectory, [directory]);
      await rename(join(spool, name), join(newerDirectory, name));
      if (pending !== null) pending--;
    }
    selected.sort((left, right) => orderObservedEvents(left.event, right.event) || left.name.localeCompare(right.name));
    for (const entry of selected) {
      if (options.closing()) return;
      try { options.receive([entry.event]); }
      catch (error) {
        if (error instanceof IdentityError && error.code === 'EVENT_TIME_INVALID') {
          recordLoss(entry.name, 'An event was outside the supported source-time window.', true);
          await remove(entry.name, entry.base); if (pending !== null && entry.base === spool) pending--; continue;
        }
        const message = error instanceof IdentityError && error.statusCode === 429
          ? 'Local events remain queued while this source or workspace is at its limit.'
          : 'Local events remain queued because delivery could not be committed. Retry follows automatically; review the source if this persists.';
        setDelivery('blocked', pending, message); return;
      }
      await remove(entry.name, entry.base); if (pending !== null && entry.base === spool) pending--;
    }
    try {
      const remaining = await opendir(newerDirectory);
      let count = 0;
      for await (const entry of remaining) if (eventName.test(entry.name)) count++;
      setNewerCount(count);
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    if (temporary) { setDelivery('blocked', null, 'A hook event is still in its temporary write stage. Completed events were replayed; unfinished files are retained. If this persists after the tool exits, inspect local storage before cleanup.'); return; }
    const idle = pending === 0 && claims.length <= SPOOL_BATCH_LIMIT && sourceClaims.length <= SPOOL_BATCH_LIMIT;
    setDelivery(idle ? 'idle' : 'pending', pending, idle ? null : 'Local events or coverage notices remain queued for the next bounded replay batch.');
  } catch {
    // A storage error can also prevent saving diagnostics. Keep every unacknowledged file.
    try { setDelivery('blocked', pending, 'The local event spool could not be read or committed safely. Pending events are retained for retry.'); } catch { /* Durable state remains the last successful observation. */ }
  }
}

/** One mutex shared by the periodic background replay (service.ts's 500 ms timer) and every connection's
 * bounded final drain (H0-11, orchestrated by Stop watching / H0-13): the two paths must never scan and
 * mutate the same spool folder at once. The periodic loop only ever tries once per tick and skips that tick
 * when the mutex is busy (tryAcquire, unchanged behaviour from before this mutex existed); a final drain
 * waits its turn (acquire) and holds the mutex only for its own bounded work on ONE connection, releasing it
 * the instant that connection's drain ends — Stop watching loops connections one at a time and must never
 * keep the periodic loop shut out for the whole job. */
export class DrainMutex {
  private busy = false;
  private waiters: (() => void)[] = [];
  /** Non-blocking: returns a release function immediately, or null when the mutex is already held. */
  tryAcquire(): (() => void) | null {
    if (this.busy) return null;
    this.busy = true;
    return () => this.release();
  }
  /** Waits its turn (first in, first out) and resolves with a release function once held. */
  acquire(): Promise<() => void> {
    if (!this.busy) { this.busy = true; return Promise.resolve(() => this.release()); }
    return new Promise(resolve => { this.waiters.push(() => resolve(() => this.release())); });
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.busy = false;
  }
}
/** The one instance every drain path (periodic and final) shares. */
export const drainMutex = new DrainMutex();

/** About how long a final drain may run before Stop watching gives up waiting and reports "timed out"
 * instead of deleting anything (H0-11: "bounded to about 8 s"). */
export const FINAL_DRAIN_BUDGET_MS = 8000;

let finalDrainBudgetOverrideMs: number | null = null;
/** Test-only seam: overrides the deadline finalDrainConnection computes from FINAL_DRAIN_BUDGET_MS, so the
 * 'timed-out' outcome can be exercised deterministically without an actual ~8s wait. Never used outside tests. */
export function __setFinalDrainBudgetForTests(ms: number | null) { finalDrainBudgetOverrideMs = ms; }

export interface FinalDrainOptions {
  directory: string; spool: string; record: RegisteredObservation; store: Store;
  receive(events: ObservationEvent[]): unknown;
  /** Checked between spool records, never mid-file (drainObservationSpool's own closing() callback, reused
   * as-is): a Cancel the owner pressed between connections, or the service shutting down. */
  cancelled(): boolean;
}
export type FinalDrainOutcome = 'drained' | 'blocked' | 'timed-out' | 'cancelled';
export interface FinalDrainResult {
  /** 'drained': this connection had 0 pending events when the call returned — revoke and clean-up may run.
   *  'blocked': delivery could not proceed (capacity, or a commit failure); reported once, never retried in
   *  a tight loop, and revoke/clean-up must not run. 'timed-out': the roughly 8 s budget elapsed with events
   *  still pending. 'cancelled': the caller's signal stopped the drain before it finished. Only 'drained'
   *  ever means clean-up may delete anything. */
  outcome: FinalDrainOutcome;
  pendingEvents: number | null;
  message: string | null;
}

/** Bounded, mutex-protected replay of ONE connection's pending spool before Stop watching may revoke it and
 * clean up its files (H0-11). Waits for the shared drain mutex, then repeatedly calls the same bounded
 * drainObservationSpool the periodic loop uses (so a spool with more files than one batch still finishes
 * within the budget), until: 0 events are left, delivery reports 'blocked', the roughly 8 s budget elapses,
 * or the caller's cancel/shutdown signal fires. Always releases the mutex on the way out, so it is never
 * held between connections — Stop watching calls this once per connection, in its own turn. */
export async function finalDrainConnection(options: FinalDrainOptions): Promise<FinalDrainResult> {
  const release = await drainMutex.acquire();
  try {
    const deadline = Date.now() + (finalDrainBudgetOverrideMs ?? FINAL_DRAIN_BUDGET_MS);
    const delivery = () => options.store.snapshot().state.observation?.connections.find(item => item.id === options.record.connection.id)?.delivery ?? null;
    for (;;) {
      if (options.cancelled()) return { outcome: 'cancelled', pendingEvents: delivery()?.pendingEvents ?? null, message: null };
      await drainObservationSpool({ directory: options.directory, spool: options.spool, record: options.record, store: options.store, receive: options.receive, closing: options.cancelled });
      if (options.cancelled()) return { outcome: 'cancelled', pendingEvents: delivery()?.pendingEvents ?? null, message: null };
      const status = delivery();
      if (!status || status.status === 'idle') return { outcome: 'drained', pendingEvents: 0, message: null };
      if (status.status === 'blocked') return { outcome: 'blocked', pendingEvents: status.pendingEvents, message: status.message };
      if (Date.now() >= deadline) return { outcome: 'timed-out', pendingEvents: status.pendingEvents, message: status.message };
      // status is 'pending' (more files than one batch, or a fresh coverage/source claim to process next
      // cycle): loop again, still inside the same acquired mutex, still bounded by the deadline above.
    }
  } finally { release(); }
}
