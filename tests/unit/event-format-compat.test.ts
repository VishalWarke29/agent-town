import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CURRENT_EVENT_FORMAT, eventFieldSupported, eventFormatRequirements, eventKindSupported, type ObservationEvent, type ServiceCapabilities } from '@agent-town/contracts';
import { privateState } from '../../apps/service/src/workspaces';
import { Store, projectRoot } from '../../apps/service/src/store';
import { ObservationRegistry, type RegisteredObservation } from '../../apps/service/src/observation/registry';
import { drainObservationSpool } from '../../apps/service/src/observation/spool';
import { gateEventForCapability } from '../../apps/service/src/observation/source-binding';
import { spoolPath, writeBridgeConfig } from '../../apps/service/src/observation/setup';

/** WS3-23 part 4: the compatibility table (packages/contracts/src/observation.ts) lists every event
 * kind or optional field gated behind a format newer than the baseline every service build to date
 * understands, and this directory holds one fixture per table row — a well-formed event that uses it.
 * A row added here with no matching fixture is a mistake this file's first test catches. */
const FIXTURE_DIR = join(projectRoot, 'tests', 'fixtures', 'event-formats');

function fixtureNamesFor(requirements: { kinds: Readonly<Record<string, number>>; fields: Readonly<Record<string, number>> }) {
  return [...Object.keys(requirements.kinds), ...Object.keys(requirements.fields)];
}
/** The name every table row's fixture must use, so the two can be cross-checked by name alone. */
function missingFixtures(requirements: { kinds: Readonly<Record<string, number>>; fields: Readonly<Record<string, number>> }, availableFileNames: readonly string[]) {
  const available = new Set(availableFileNames.map(name => name.replace(/\.json$/, '')));
  return fixtureNamesFor(requirements).filter(name => !available.has(name));
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = realpathSync(directory), base = realpathSync(tmpdir()), remainder = relative(base, target);
    if (!remainder || remainder.startsWith('..') || isAbsolute(remainder) || !target.includes('agent-town-format-compat-')) throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});

/** Runs the real drain against one fixture event in a fresh, disposable spool — "as" a service that
 * currently understands nothing beyond the baseline (there has only ever been one real format so
 * far), which is exactly the service a fixture for a newer, gated format must still survive against.
 * Returns 'delivered' when the store received it, 'quarantined' when it landed in newer/ untouched,
 * or 'lost' when neither happened — the one outcome a kept event must never produce. */
async function drainAsBaseline(event: unknown): Promise<'delivered' | 'quarantined' | 'lost'> {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-format-compat-')), root = join(directory, 'repo');
  directories.push(directory); mkdirSync(root);
  const state = privateState({ id: 'workspace-one', name: 'Fixture', kind: 'personal' });
  state.repositories = [{ id: 'repo-one', name: 'Repo', branch: 'main', description: '', language: 'TypeScript', color: '#abc', position: [0, 0], source: 'local', localPath: root }];
  state.discovery!.roots = [root];
  const record: RegisteredObservation = { ownerId: '101', workspaceId: 'workspace-one', repoPath: root,
    connection: { id: randomUUID(), provider: 'claude', repoId: 'repo-one', label: 'Fixture', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0, droppedEventsExact: true } };
  state.observation = { connections: [record.connection] };
  const store = new Store(join(directory, 'town.sqlite'), state);
  const registry = new ObservationRegistry(join(directory, 'observation.sqlite')); registry.register(record, 'a'.repeat(64)); registry.close();
  await writeBridgeConfig(record, directory);
  const spool = spoolPath(directory, record.connection.id);
  writeFileSync(join(spool, `${randomUUID()}.json`), JSON.stringify(event));
  const received: ObservationEvent[] = [];
  await drainObservationSpool({ directory, spool, record, store, receive: events => received.push(...events), closing: () => false });
  try {
    if (received.length > 0) return 'delivered';
    const newerCount = store.snapshot().state.observation!.connections[0].newerEventCount ?? 0;
    return newerCount > 0 ? 'quarantined' : 'lost';
  } finally { store.close(); }
}

describe('event-format compatibility table', () => {
  it('flags a compatibility-table row with no matching fixture, and clears once one is added', () => {
    expect(missingFixtures({ kinds: { 'future.kind': 2 }, fields: {} }, [])).toEqual(['future.kind']);
    expect(missingFixtures({ kinds: { 'future.kind': 2 }, fields: { futureField: 2 } }, ['future.kind.json'])).toEqual(['futureField']);
    expect(missingFixtures({ kinds: { 'future.kind': 2 }, fields: {} }, ['future.kind.json'])).toEqual([]);
  });

  it('has a fixture for every real table row — currently none, since this guard ships gating nothing yet', () => {
    // See eventFormatRequirements' own comment: WS3-23 ships the mechanism with an empty table, so the
    // release adds no new event field, kind or marker. A later feature that adds a gated row must also
    // add tests/fixtures/event-formats/<name>.json, or this assertion catches the gap.
    expect(eventFormatRequirements.kinds).toEqual({});
    expect(eventFormatRequirements.fields).toEqual({});
    const available = existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR) : [];
    expect(missingFixtures(eventFormatRequirements, available)).toEqual([]);
  });

  it('gates a kind or field on the capability file\'s eventFormat, and always allows an ungated one regardless of capability evidence', () => {
    const capabilityAt = (eventFormat: number): ServiceCapabilities => ({ eventFormat, kinds: [], buildId: 'fixture-build', startedAt: new Date().toISOString() });
    const gatedKinds = { 'context.updated': 2 }, gatedFields = { nativeChildId: 2 };
    expect(eventKindSupported('context.updated', null, gatedKinds)).toBe(false);
    expect(eventKindSupported('context.updated', capabilityAt(1), gatedKinds)).toBe(false);
    expect(eventKindSupported('context.updated', capabilityAt(2), gatedKinds)).toBe(true);
    expect(eventKindSupported('context.updated', capabilityAt(3), gatedKinds)).toBe(true);
    expect(eventKindSupported('session.start', null, gatedKinds)).toBe(true);
    expect(eventKindSupported('session.start', capabilityAt(1), gatedKinds)).toBe(true);
    expect(eventFieldSupported('nativeChildId', null, gatedFields)).toBe(false);
    expect(eventFieldSupported('nativeChildId', capabilityAt(1), gatedFields)).toBe(false);
    expect(eventFieldSupported('nativeChildId', capabilityAt(2), gatedFields)).toBe(true);
    expect(eventFieldSupported('summary', capabilityAt(1), gatedFields)).toBe(true);
    // The real, currently-empty table: every existing kind and field is the ungated baseline today.
    expect(eventKindSupported('session.start', null)).toBe(true);
    expect(eventFieldSupported('summary', null)).toBe(true);
  });

  it('gateEventForCapability is a no-op today: nothing is gated yet, so every existing event kind and field passes through unchanged regardless of capability evidence', () => {
    const event: ObservationEvent = { id: 'e1', sessionId: 's1', kind: 'tool.finish', occurredAt: new Date().toISOString(), tool: 'grep', summary: 'ok', sequence: 3 };
    expect(gateEventForCapability(event, null)).toEqual(event);
    expect(gateEventForCapability(event, { eventFormat: CURRENT_EVENT_FORMAT, kinds: [], buildId: 'fixture-build', startedAt: new Date().toISOString() })).toEqual(event);
  });

  it('drainAsBaseline keeps a well-formed event this baseline cannot parse, quarantined rather than lost', async () => {
    // A synthetic stand-in for a fixture that will exist once a real table row does: a well-formed
    // envelope using a kind CURRENT_EVENT_FORMAT does not list. Proves the harness itself works —
    // the real fixture loop below has nothing to iterate yet.
    const future = { id: 'compat-fixture-event', sessionId: 'compat-session', kind: 'context.updated', occurredAt: new Date().toISOString() };
    expect(await drainAsBaseline(future)).toBe('quarantined');
    expect(CURRENT_EVENT_FORMAT).toBeGreaterThanOrEqual(1);
  });

  it('malformed input is still lost, not falsely reported as kept', async () => {
    expect(await drainAsBaseline('not an object')).toBe('lost');
  });

  const available = existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR).filter(name => name.endsWith('.json')) : [];
  it.runIf(available.length > 0).each(available)('fixture %s is kept when drained as the current baseline', async name => {
    const event = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
    expect(await drainAsBaseline(event)).not.toBe('lost');
  });
});
