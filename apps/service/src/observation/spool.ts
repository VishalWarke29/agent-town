import { randomUUID } from 'node:crypto';
import { opendir, lstat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type ObservationConnection, type ObservationEvent } from '@agent-town/contracts';
import { IdentityError } from '../identity/index.js';
import { checkedPath, readMetadataFile } from '../discovery/paths.js';
import type { Store } from '../store.js';
import type { RegisteredObservation } from './registry.js';
import { SPOOL_EVENT_BYTES, SPOOL_DIRECTORY_LIMIT, SPOOL_BATCH_LIMIT } from './spool-limits.js';
import { parseSpoolEvent, sourceBindingDiagnosticCodes, sourceDiagnosticCodes, type SourceDiagnostic } from './source-binding.js';
const eventName = /^[a-f0-9-]{36}\.json$/;
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
  const remove = async (name: string) => { await checkedPath(spool, [directory]); await unlink(join(spool, name)); };
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
    const selected: { name: string; event: ObservationEvent }[] = [];
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
      let event: ObservationEvent | undefined;
      try { event = parseSpoolEvent(JSON.parse(text)) ?? undefined; } catch { /* Invalid JSON is a rejected local record. */ }
      if (!event) {
        recordLoss(name, 'A local event file did not match the supported event contract.', true);
        await remove(name); if (pending !== null) pending--; continue;
      }
      selected.push({ name, event });
    }
    selected.sort((left, right) => orderObservedEvents(left.event, right.event) || left.name.localeCompare(right.name));
    for (const entry of selected) {
      if (options.closing()) return;
      try { options.receive([entry.event]); }
      catch (error) {
        if (error instanceof IdentityError && error.code === 'EVENT_TIME_INVALID') {
          recordLoss(entry.name, 'An event was outside the supported source-time window.', true);
          await remove(entry.name); if (pending !== null) pending--; continue;
        }
        const message = error instanceof IdentityError && error.statusCode === 429
          ? 'Local events remain queued while this source or workspace is at its limit.'
          : 'Local events remain queued because delivery could not be committed. Retry follows automatically; review the source if this persists.';
        setDelivery('blocked', pending, message); return;
      }
      await remove(entry.name); if (pending !== null) pending--;
    }
    if (temporary) { setDelivery('blocked', null, 'A hook event is still in its temporary write stage. Completed events were replayed; unfinished files are retained. If this persists after the tool exits, inspect local storage before cleanup.'); return; }
    const idle = pending === 0 && claims.length <= SPOOL_BATCH_LIMIT && sourceClaims.length <= SPOOL_BATCH_LIMIT;
    setDelivery(idle ? 'idle' : 'pending', pending, idle ? null : 'Local events or coverage notices remain queued for the next bounded replay batch.');
  } catch {
    // A storage error can also prevent saving diagnostics. Keep every unacknowledged file.
    try { setDelivery('blocked', pending, 'The local event spool could not be read or committed safely. Pending events are retained for retry.'); } catch { /* Durable state remains the last successful observation. */ }
  }
}
