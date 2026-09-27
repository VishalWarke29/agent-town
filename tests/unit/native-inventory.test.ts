import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { allocateAgentHome, type Agent, type ManagedRun, type NativeHideAllCounts, type NativeSession, type NativeSource, type ObservationConnection, type ObservationEvent, type TownState } from '@agent-town/contracts';
import { privateState } from '../../apps/service/src/workspaces';
import { Store } from '../../apps/service/src/store';
import { applyObservation, observationReceiptKey } from '../../apps/service/src/observation/reducer';
import { archiveReview } from '../../apps/service/src/history-state';
import { normalizeHook } from '../../apps/service/src/observation/normalize';

function fixture() {
  const state = privateState({ id: 'workspace-native', name: 'Native fixture', kind: 'personal' });
  state.repositories = [{ id: 'repo-native', name: 'Project', branch: 'Unavailable', description: '', language: '', color: '#859b87', position: [0, 0], source: 'local', localPath: 'C:\\projects\\fixture' }];
  const store = new Store(':memory:', state);
  let source!: NativeSource;
  store.commit(randomUUID(), () => { source = store.native.register('codex', 'C:\\native\\first', 'First'); return 'observation.source'; });
  const connection: ObservationConnection = { id: randomUUID(), provider: 'codex', repoId: 'repo-native', label: 'Fixture', nativeSourceId: source.id, sourceRevision: source.revision, binding: 'declared', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 };
  const event = (id: string, native = 'session-1', kind: ObservationEvent['kind'] = 'tool.start'): ObservationEvent => ({ id, sessionId: native, nativeSessionId: native, nativeSourceId: source.id, sourceRevision: source.revision, kind, occurredAt: new Date().toISOString() });
  const receive = (value: ObservationEvent, from = connection) => {
    const fingerprint = store.native.receiptFingerprint(from, value, store.snapshot().state);
    return store.commit(observationReceiptKey(from, value), (current, at) => store.native.receive(current, from, value, at) ?? 'observation.legacy', fingerprint);
  };
  const discover = (native = 'session-1', parent?: string, title?: string, nativeAgentName?: string) => store.commit(randomUUID(), (current, at) => { store.native.discover(source, 'repo-native', [{ nativeSessionId: native, ...(parent ? { parentNativeSessionId: parent } : {}), ...(title !== undefined ? { title } : {}), ...(nativeAgentName !== undefined ? { nativeAgentName } : {}), projectPath: 'C:\\projects\\fixture', createdAt: at, updatedAt: at }], current, at); return 'observation.discovered'; });
  return { store, source, connection, event, receive, discover };
}

describe('native session identity and visibility', () => {
  it('keeps native titles and nicknames separate from custom names across scans, hooks, archive and resume', () => {
    const f = fixture();
    try {
      f.discover('session-1', undefined, '  Repair local session tracking  ', '  Rowan  ');
      const record = f.store.native.page(f.store.snapshot().state).items[0]!;
      expect(record).toMatchObject({ title: 'Repair local session tracking', nativeAgentName: 'Rowan', activity: 'unknown', observedAt: null });
      expect(f.store.native.detail(record.id, f.store.snapshot().state).discovery?.title).toBe(record.title);
      f.store.commit('custom-character-name', state => {
        f.store.native.visibility(record.id, true, state);
        state.agents[0]!.name = 'My session reviewer';
        return 'agent.renamed';
      });
      f.receive(f.event('start-titled-work'));
      f.discover();
      expect(f.store.snapshot().state.agents[0]).toMatchObject({ id: record.id, name: 'My session reviewer', discovery: { title: record.title, nativeAgentName: 'Rowan' } });
      f.discover('session-1', undefined, 'Track existing local sessions');
      for (const invalid of ['', 'x'.repeat(161), 'Control\u001btitle', 'Bidi\u202etitle']) f.discover('session-1', undefined, invalid);
      for (const invalid of ['', 'x'.repeat(161), 'Control\u001bname', 'Bidi\u202ename']) f.discover('session-1', undefined, undefined, invalid);
      f.receive(f.event('end-titled-work', 'session-1', 'session.end'));
      const current = f.store.snapshot().state, actor = current.agents[0]!;
      f.store.archiveAgent(actor.id, archiveReview(current, actor).reviewToken);
      f.discover();
      expect(f.store.historyDetail(actor.id).agent).toMatchObject({ name: 'My session reviewer', activity: 'offline', discovery: { title: 'Track existing local sessions', nativeAgentName: 'Rowan' } });
      expect(f.store.native.page(f.store.snapshot().state).items[0]?.title).toBe('Track existing local sessions');
      f.receive({ ...f.event('resume-titled-work'), occurredAt: new Date(Date.now() + 1000).toISOString() });
      expect(f.store.snapshot().state.agents[0]).toMatchObject({ id: actor.id, name: 'My session reviewer', activity: 'working', discovery: { title: 'Track existing local sessions', nativeAgentName: 'Rowan' } });
      expect(f.store.snapshot().state.handoffs).toHaveLength(0);
    } finally { f.store.close(); }
  });

  it('discovers unknown activity, then observes the same character without moving it or creating a report', () => {
    const f = fixture();
    try {
      f.discover();
      const record = f.store.native.page(f.store.snapshot().state).items[0]!;
      expect(record).toMatchObject({ activity: 'unknown', observedAt: null, visible: false });
      expect(f.store.snapshot().state.agents).toHaveLength(0);
      f.store.commit(randomUUID(), state => { f.store.native.visibility(record.id, true, state); return 'observation.visible'; });
      const before = f.store.snapshot().state.agents[0]!;
      expect(before.activity).toBe('unknown'); expect(before.observation).toBeUndefined();
      f.receive(f.event('start'));
      const state = f.store.snapshot().state;
      expect(state.agents).toHaveLength(1);
      expect(state.agents[0]).toMatchObject({ id: before.id, home: before.home, activity: 'working' });
      expect(state.handoffs).toHaveLength(0);
      expect(state.observation?.connections[0]?.binding).toBe('resolved');
      f.discover(); expect(f.store.snapshot().state.agents[0]?.activity).toBe('working');
    } finally { f.store.close(); }
  });
  it('preserves identity and deduplicates reports across connection replacement, without comparing old sequence numbers', () => {
    const f = fixture();
    try {
      f.receive({ ...f.event('first'), sequence: 500 });
      const id = f.store.snapshot().state.agents[0]!.id;
      const replacement = { ...f.connection, id: randomUUID() };
      const report = { ...f.event('report', 'session-1', 'turn.end'), sequence: 1, summary: 'Reported completion remains unaccepted.' };
      f.receive(report, replacement); f.receive(report, f.connection);
      const state = f.store.snapshot().state;
      expect(state.agents).toHaveLength(1); expect(state.agents[0]).toMatchObject({ id, activity: 'reporting' });
      expect(state.agents[0]?.observation?.lastSequence).toBe(1);
      expect(state.handoffs).toHaveLength(1); expect(state.handoffs[0]?.agentId).toBe(id); expect(state.manager.version).toBe(0);
    } finally { f.store.close(); }
  });
  it.each(['discovery-first', 'hook-first'])('reconciles child aliases using a native parent relationship (%s)', order => {
    const f = fixture();
    try {
      const child = { ...f.event('child', 'parent'), sessionId: 'parent:child', parentSessionId: 'parent', nativeParentSessionId: 'parent', nativeChildId: 'child' };
      if (order === 'discovery-first') f.discover('child', 'parent');
      f.receive(child); const id = f.store.native.page(f.store.snapshot().state).items[0]!.id;
      f.discover('child', 'parent');
      f.receive({ ...child, id: 'child-tool' });
      const page = f.store.native.page(f.store.snapshot().state);
      expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ id, nativeSessionId: 'child', parentNativeSessionId: 'parent' });
      expect(f.store.snapshot().state.agents).toHaveLength(1);
    } finally { f.store.close(); }
  });
  it('keeps hidden sessions hidden during fresh events and retains their reports and inspectable state', () => {
    const f = fixture();
    try {
      f.receive(f.event('start')); const id = f.store.snapshot().state.agents[0]!.id;
      f.store.commit(randomUUID(), state => { f.store.native.visibility(id, false, state); return 'observation.hidden'; });
      f.receive({ ...f.event('report', 'session-1', 'turn.end'), summary: 'A saved report from a hidden session.' });
      f.discover();
      expect(f.store.snapshot().state.agents).toHaveLength(0);
      expect(f.store.snapshot().state.handoffs).toHaveLength(1);
      expect(f.store.native.detail(id, f.store.snapshot().state).activity).toBe('reporting');
      expect(f.store.native.page(f.store.snapshot().state).items[0]?.visible).toBe(false);
    } finally { f.store.close(); }
  });
  it('keeps identical IDs in different homes separate and rejects unknown or stale source bindings', () => {
    const f = fixture();
    try {
      f.receive(f.event('start'));
      let second!: NativeSource;
      f.store.commit(randomUUID(), () => { second = f.store.native.register('codex', 'C:\\native\\second', 'Second'); return 'observation.source'; });
      const connection = { ...f.connection, id: randomUUID(), nativeSourceId: second.id };
      f.receive({ ...f.event('start'), nativeSourceId: second.id }, connection);
      expect(f.store.snapshot().state.agents).toHaveLength(2);
      expect(() => f.receive({ ...f.event('wrong-home'), nativeSourceId: second.id })).toThrow(/approved native profile/);
      expect(() => f.receive({ ...f.event('stale'), sourceRevision: 9 })).toThrow(/approved native profile/);
    } finally { f.store.close(); }
  });
  it('retains overflow in the paginated inventory and saves events beyond the scene capacity', () => {
    const f = fixture();
    try {
      f.store.commit(randomUUID(), (state, at) => {
        for (let i = 0; i < 201; i++) f.store.native.receive(state, f.connection, { ...f.event(`start-${i}`, `session-${i}`), occurredAt: at }, at);
        return 'observation.many';
      });
      const state = f.store.snapshot().state, page = f.store.native.page(state);
      expect(state.agents).toHaveLength(200); expect(page.total).toBe(201); expect(page.items).toHaveLength(25); expect(page.nextCursor).toBe('25');
      f.receive({ ...f.event('overflow-report', 'session-200', 'turn.end'), summary: 'Overflow still saves reports.' });
      expect(f.store.snapshot().state.handoffs).toHaveLength(1);
    } finally { f.store.close(); }
  });

  it.each(['child-hook-first', 'direct-child-first'])('reconciles provisional child records and preserves both reports (%s)', order => {
    const f = fixture();
    try {
      const at = new Date().toISOString();
      const child: ObservationEvent = { ...f.event('child-report', 'parent', 'turn.end'), occurredAt: at, sessionId: 'parent:child', parentSessionId: 'parent', nativeParentSessionId: 'parent', nativeChildId: 'child', summary: 'Child-hook report.' };
      const direct: ObservationEvent = { ...f.event('direct-report', 'child', 'turn.end'), occurredAt: at, summary: 'Direct-thread report.' };
      f.receive(order === 'child-hook-first' ? child : direct);
      const first = f.store.snapshot().state.agents[0]!;
      f.receive(order === 'child-hook-first' ? direct : child);
      const before = f.store.snapshot().state, oldIds = before.agents.map(agent => agent.id), reportIds = before.handoffs.map(report => report.id);
      expect(oldIds).toHaveLength(2);
      f.discover('child', undefined, 'Child session name', 'Hazel');
      f.discover('child', 'parent');
      const merged = f.store.snapshot().state;
      expect(merged.agents).toHaveLength(1); expect(merged.agents[0]).toMatchObject({ id: first.id, home: first.home });
      expect(merged.handoffs.map(report => report.id)).toEqual(reportIds); expect(merged.handoffs.every(report => report.agentId === first.id)).toBe(true);
      expect(f.store.native.page(merged).items).toHaveLength(1);
      expect(f.store.native.page(merged).items[0]?.title).toBe('Child session name');
      expect(f.store.native.page(merged).items[0]?.nativeAgentName).toBe('Hazel');
      for (const oldId of oldIds) expect(f.store.native.detail(oldId, merged)).toMatchObject({ id: first.id, discovery: { title: 'Child session name', nativeAgentName: 'Hazel' } });
      const replay = { ...child, sessionId: 'child', nativeSessionId: 'child', parentSessionId: undefined, nativeParentSessionId: undefined, nativeChildId: undefined };
      expect(f.receive(replay).duplicate).toBe(true);
      expect(f.store.snapshot().state.handoffs).toHaveLength(2);
    } finally { f.store.close(); }
  });

  it('does not resurrect an archive for old tool events, late reports, or discovery refresh', () => {
    const f = fixture();
    try {
      const base = Date.now(), start = new Date(base - 3000).toISOString(), ended = new Date(base - 1000).toISOString();
      f.receive({ ...f.event('start'), occurredAt: start });
      f.receive({ ...f.event('ended', 'session-1', 'session.end'), occurredAt: ended });
      const current = f.store.snapshot().state, agent = current.agents[0]!;
      f.store.archiveAgent(agent.id, archiveReview(current, agent).reviewToken);
      f.receive({ ...f.event('late-tool'), occurredAt: new Date(base - 2000).toISOString() });
      const replacement = { ...f.connection, id: randomUUID() };
      f.receive({ ...f.event('late-report', 'session-1', 'turn.end'), occurredAt: new Date(base - 1500).toISOString(), summary: 'Late evidence.' }, replacement);
      f.discover();
      expect(f.store.snapshot().state.agents).toHaveLength(0); expect(f.store.history().total).toBe(1);
      expect(f.store.historyDetail(agent.id).agent).toMatchObject({ activity: 'offline', observation: { sourceTime: ended, connectionId: f.connection.id }, discovery: { nativeSessionId: 'session-1' } });
      expect(f.store.historyDetail(agent.id).reportCount).toBe(1);
      f.receive({ ...f.event('new-work'), occurredAt: new Date(base + 1).toISOString() }, replacement);
      expect(f.store.snapshot().state.agents[0]).toMatchObject({ id: agent.id, activity: 'working' }); expect(f.store.history().total).toBe(0);
    } finally { f.store.close(); }
  });

  it('adopts a legacy actor and existing report without duplicating evidence after native binding', () => {
    const f = fixture();
    try {
      const legacy = { ...f.connection, nativeSourceId: undefined, sourceRevision: undefined, binding: undefined };
      const old: ObservationEvent = { id: 'old-report', sessionId: 'session-1', kind: 'turn.end', occurredAt: new Date().toISOString(), summary: 'Legacy saved evidence.' };
      f.store.commit('legacy-fixture', (state, at) => applyObservation(state, legacy, old, at));
      const original = f.store.snapshot().state, actor = original.agents[0]!, report = original.handoffs[0]!;
      f.store.commit('bind-fixture', state => {
        Object.assign(state.observation!.connections[0]!, { nativeSourceId: f.source.id, sourceRevision: f.source.revision });
        f.store.native.preserveLegacyAliases(state); return 'observation.bound';
      });
      f.discover();
      expect(f.store.native.page(f.store.snapshot().state).items[0]?.agentId).toBe(actor.id);
      expect(f.store.native.page(f.store.snapshot().state).items[0]?.observedAt).toBe(actor.updatedAt);
      f.receive({ ...old, nativeSourceId: f.source.id, sourceRevision: f.source.revision, nativeSessionId: 'session-1' });
      const after = f.store.snapshot().state;
      expect(after.agents).toHaveLength(1); expect(after.agents[0]).toMatchObject({ id: actor.id, home: actor.home }); expect(after.handoffs).toEqual([report]);
    } finally { f.store.close(); }
  });

  it('validates source revocation, revision, project and producer before a matching duplicate receipt', () => {
    const f = fixture();
    try {
      const event = f.event('already-seen'); f.receive(event);
      expect(() => f.receive(event, { ...f.connection, status: 'revoked' })).toThrow(/unavailable/);
      expect(() => f.receive(event, { ...f.connection, sourceRevision: 99 })).toThrow(/approved native profile/);
      expect(() => f.receive({ ...event, producer: 'claude' })).toThrow(/approved native profile/);
      expect(() => f.receive(event, { ...f.connection, repoId: 'missing-project' })).toThrow(/unavailable/);
      expect(() => f.receive({ ...event, sessionId: 'another-session', nativeSessionId: 'another-session' })).toThrow(/another session/);
      f.store.commit('restore-source', () => { f.store.native.saveSource({ ...f.source, status: 'needs-review' }); return 'observation.source'; });
      expect(() => f.receive(event)).toThrow(/approved native profile/);
    } finally { f.store.close(); }
  });

  it.each(['replayed-event', 'new-event'])('rejects a changed native session behind an already bound transport alias (%s)', receipt => {
    const f = fixture();
    try {
      const event = { ...f.event('bound-report', 'native-one', 'turn.end'), summary: 'Evidence belongs to the original session.' };
      f.receive(event);
      const before = f.store.snapshot(), inventory = f.store.native.page(before.state);
      expect(() => f.receive({ ...event, id: receipt === 'replayed-event' ? event.id : 'fresh-report', nativeSessionId: 'other-native' })).toThrow(/another session/);
      expect(f.store.snapshot()).toEqual(before);
      expect(f.store.native.page(f.store.snapshot().state)).toEqual(inventory);
      expect(f.receive(event).duplicate).toBe(true);
      expect(f.store.snapshot().state.handoffs).toEqual(before.state.handoffs);
    } finally { f.store.close(); }
  });

  it('keeps explicitly hidden state when verified duplicate child records are reconciled', () => {
    const f = fixture();
    try {
      f.receive({ ...f.event('child', 'parent'), sessionId: 'parent:child', parentSessionId: 'parent', nativeParentSessionId: 'parent', nativeChildId: 'child' });
      const id = f.store.snapshot().state.agents[0]!.id;
      f.store.commit('hide-child', state => { f.store.native.visibility(id, false, state); return 'observation.hidden'; });
      f.receive(f.event('direct', 'child'));
      f.discover('child', 'parent');
      expect(f.store.snapshot().state.agents).toHaveLength(0);
      expect(f.store.native.page(f.store.snapshot().state).items[0]).toMatchObject({ id, visibility: 'hidden', visible: false });
      f.receive(f.event('fresh-child', 'child'));
      expect(f.store.snapshot().state.agents).toHaveLength(0);
    } finally { f.store.close(); }
  });

  it('adopts a legacy hashed child alias without losing archive history or its report', () => {
    const f = fixture();
    try {
      const legacy = { ...f.connection, nativeSourceId: undefined, sourceRevision: undefined, binding: undefined };
      const normalized = normalizeHook('codex', 'SubagentStop', { cwd: 'C:\\projects\\fixture', session_id: 'parent:one', agent_id: 'child:one', last_assistant_message: 'Legacy child evidence.' }, 'C:\\projects\\fixture')!;
      const { nativeSessionId: _session, nativeParentSessionId: _parent, nativeChildId: _child, ...old } = normalized;
      f.store.commit('old-child-report', (state, at) => applyObservation(state, legacy, old, at));
      f.store.commit('old-child-end', (state, at) => applyObservation(state, legacy, { ...old, id: 'old-child-ended', kind: 'session.end', summary: undefined, sequence: 2, occurredAt: new Date(Date.parse(old.occurredAt) + 1).toISOString() }, at));
      const state = f.store.snapshot().state, agent = state.agents[0]!;
      f.store.archiveAgent(agent.id, archiveReview(state, agent).reviewToken);
      f.store.commit('bind-old-child', current => { Object.assign(current.observation!.connections[0]!, { nativeSourceId: f.source.id, sourceRevision: f.source.revision }); f.store.native.preserveLegacyAliases(current); return 'observation.bound'; });
      f.discover('child:one', 'parent:one');
      const page = f.store.native.page(f.store.snapshot().state);
      expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ agentId: agent.id, nativeSessionId: 'child:one', parentNativeSessionId: 'parent:one', sceneVisible: false });
      expect(f.store.historyDetail(agent.id).reportCount).toBe(1); expect(f.store.snapshot().state.agents).toHaveLength(0);
    } finally { f.store.close(); }
  });

  it('does not let a rebound connection adopt its previous home’s same-named session', () => {
    const f = fixture();
    try {
      f.receive(f.event('first-home'));
      const firstId = f.store.snapshot().state.agents[0]!.id;
      let second!: NativeSource;
      f.store.commit('second-home', () => { second = f.store.native.register('codex', 'C:\\native\\second', 'Second'); return 'observation.source'; });
      const rebound = { ...f.connection, nativeSourceId: second.id, sourceRevision: second.revision };
      f.receive({ ...f.event('second-home-event'), nativeSourceId: second.id, sourceRevision: second.revision }, rebound);
      expect(f.store.snapshot().state.agents).toHaveLength(2); expect(f.store.native.page(f.store.snapshot().state).total).toBe(2);
      expect(f.store.snapshot().state.agents[0]!.id).toBe(firstId);
    } finally { f.store.close(); }
  });

  it('shows newly observed automatic entries, but never manufactures activity during discovery refresh', () => {
    const f = fixture();
    try {
      f.discover(); expect(f.store.snapshot().state.agents).toHaveLength(0);
      f.receive(f.event('first-real-event'));
      const actor = f.store.snapshot().state.agents[0]!;
      expect(actor.activity).toBe('working');
      f.discover(); expect(f.store.snapshot().state.agents[0]).toMatchObject({ id: actor.id, activity: 'working', observation: actor.observation, home: actor.home });
      const before = f.store.snapshot().cursor;
      expect(() => f.store.commit('wrong-project-metadata', (state, at) => { f.store.native.discover(f.source, 'repo-native', [{ nativeSessionId: 'wrong', projectPath: 'C:\\other\\project', createdAt: at, updatedAt: at }], state, at); return 'observation.discovered'; })).toThrow(/different selected project/);
      expect(f.store.snapshot().cursor).toBe(before); expect(f.store.native.page(f.store.snapshot().state).total).toBe(1);
    } finally { f.store.close(); }
  });
});

// H0-12: hide every watched session of one project in ONE commit. Hide is not archive and there is no bulk "show all".
type Fixture = ReturnType<typeof fixture>;
const OTHER_HOUSE = 'repo-other';
const addOtherHouse = (f: Fixture): ObservationConnection => {
  f.store.commit(randomUUID(), state => { state.repositories.push({ id: OTHER_HOUSE, name: 'Other project', branch: 'Unavailable', description: '', language: '', color: '#7a8bb0', position: [12, 0], source: 'local', localPath: 'C:\\projects\\other' }); return 'observation.house'; });
  return { ...f.connection, id: randomUUID(), repoId: OTHER_HOUSE };
};
/** An external session seen through a connection with no native profile (what every Cursor hook session is). */
const addLegacySession = (f: Fixture, session = 'legacy-session', provider: ObservationConnection['provider'] = 'cursor'): Agent => {
  const legacy: ObservationConnection = { ...f.connection, id: randomUUID(), provider, nativeSourceId: undefined, sourceRevision: undefined, binding: undefined };
  f.store.commit(randomUUID(), (state, at) => applyObservation(state, legacy, { id: `${session}-start`, sessionId: session, kind: 'tool.start', occurredAt: at }, at));
  return f.store.snapshot().state.agents.find(agent => agent.observation?.connectionId === legacy.id)!;
};
const managedRun = (id: string, at: string): ManagedRun => ({ id, taskId: `task-${id}`, tool: 'codex', connectionId: 'managed-connection', mode: 'api', model: 'fixture', price: null, status: 'running', startedAt: at, finishedAt: null,
  worktreePath: null, branch: null, contextVersion: 0, contextDelivery: 'pending', providerRequests: null, usage: null, message: null, changedFiles: [], reportId: null });
/** A managed worker character in the first house, owned by the runner: no observation, no native identity. */
const addManagedWorker = (f: Fixture, id = 'run-worker', alsoRuns: string[] = []): string => {
  f.store.commit(randomUUID(), (state, at) => {
    state.runner = { schemaVersion: 1, tasks: [], runs: [id, ...alsoRuns].map(run => managedRun(run, at)), subscriptions: [], subscriptionDefault: null };
    state.agents.push({ id, name: 'Codex worker', provider: 'Codex', role: 'Managed worker', repoId: 'repo-native', task: 'Managed task', activity: 'working', color: '#859b87', home: allocateAgentHome('repo-native', state.repositories, state.agents),
      updatedAt: at, files: [], evidence: 'Managed run evidence', contextVersion: 0 });
    return 'runner.fixture';
  });
  return id;
};
const hideAll = (f: Fixture, repoId = 'repo-native'): NativeHideAllCounts => {
  let counts!: NativeHideAllCounts;
  f.store.commit(randomUUID(), (state, now) => { counts = f.store.native.hideProject(repoId, state, now); return 'observation.native_visibility_bulk'; });
  return counts;
};
const everySession = (f: Fixture, state: TownState = f.store.snapshot().state, repoId?: string): NativeSession[] => {
  const items: NativeSession[] = []; let cursor: string | undefined;
  do { const page = f.store.native.page(state, { includeOlder: true, cursor, ...(repoId ? { repoId } : {}) }); items.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
  return items;
};
const residentIds = (f: Fixture) => f.store.snapshot().state.agents.map(agent => agent.id);
const sessionOf = (f: Fixture, nativeSessionId: string) => everySession(f).find(session => session.nativeSessionId === nativeSessionId)!;

describe('hide every watched session of a project (H0-12)', () => {
  it('hides only the native-backed external residents of one house, in one commit, and leaves everything else alone', () => {
    const f = fixture();
    try {
      const other = addOtherHouse(f);
      for (const id of ['session-1', 'session-2', 'session-3']) f.receive(f.event(`start-${id}`, id));
      f.receive({ ...f.event('report-1', 'session-1', 'turn.end'), summary: 'Saved before hiding.' });
      f.receive(f.event('start-other', 'other-session'), other);
      const legacy = addLegacySession(f), worker = addManagedWorker(f);
      const otherId = sessionOf(f, 'other-session').agentId, hiddenIds = ['session-1', 'session-2', 'session-3'].map(id => sessionOf(f, id).agentId);
      const before = f.store.snapshot();
      expect(before.state.agents).toHaveLength(6);

      expect(hideAll(f)).toEqual({ hidden: 3, alreadyHidden: 0, skippedLegacy: 1 });

      const after = f.store.snapshot();
      expect(after.cursor).toBe(before.cursor + 1);
      expect(after.state.agents.map(agent => agent.id).sort()).toEqual([otherId, legacy.id, worker].sort());
      for (const id of ['session-1', 'session-2', 'session-3']) expect(sessionOf(f, id)).toMatchObject({ visibility: 'hidden', visible: false, sceneVisible: false });
      expect(sessionOf(f, 'other-session')).toMatchObject({ visible: true, sceneVisible: true });
      // Hiding is not deleting: every report is still there, and a hidden session can still be opened.
      expect(after.state.handoffs).toEqual(before.state.handoffs);
      expect(f.store.native.detail(hiddenIds[0]!, after.state)).toMatchObject({ activity: 'reporting' });
      expect(everySession(f).some(session => session.agentId === legacy.id)).toBe(false);
      // One audit note, counts only: no session name, identifier or path.
      expect(after.state.activity).toHaveLength(before.state.activity.length + 1);
      expect(after.state.activity[0]).toMatchObject({ kind: 'system', message: 'Hid 3 sessions from town; saved reports are kept and nothing was deleted. New sessions from a tool that is still connected can still appear. 1 session without a native identity stayed in town.' });
      expect(after.state.activity[0]!.message).not.toMatch(/session-|agent-|repo-|C:\\|Project/);

      // A second call finds nothing left to hide and changes no state.
      expect(hideAll(f)).toEqual({ hidden: 0, alreadyHidden: 3, skippedLegacy: 1 });
      expect(f.store.snapshot().state.activity).toEqual(after.state.activity);
      expect(f.store.snapshot().state.agents).toEqual(after.state.agents);
    } finally { f.store.close(); }
  });

  it('never hides a managed run, not even one that shares its id with a native session', () => {
    const f = fixture();
    try {
      f.receive(f.event('start-plain', 'plain-session')); f.receive(f.event('start-shared', 'shared-session'));
      const sharedId = sessionOf(f, 'shared-session').agentId, plainId = sessionOf(f, 'plain-session').agentId;
      const worker = addManagedWorker(f, 'run-worker', [sharedId]);
      expect(hideAll(f)).toEqual({ hidden: 1, alreadyHidden: 0, skippedLegacy: 0 });
      expect(residentIds(f).sort()).toEqual([sharedId, worker].sort());
      expect(sessionOf(f, 'plain-session')).toMatchObject({ agentId: plainId, visibility: 'hidden' });
      expect(sessionOf(f, 'shared-session')).toMatchObject({ visibility: 'auto', visible: true });
    } finally { f.store.close(); }
  });

  it('counts sessions without a native identity as skipped and keeps them in town, never hiding them silently', () => {
    const f = fixture();
    try {
      const cursor = addLegacySession(f, 'cursor-chat', 'cursor'), claude = addLegacySession(f, 'legacy-claude', 'claude');
      const before = f.store.snapshot();
      // Only legacy sessions here: nothing to hide, both counted, no audit note, no change.
      expect(hideAll(f)).toEqual({ hidden: 0, alreadyHidden: 0, skippedLegacy: 2 });
      expect(f.store.snapshot().state.agents).toEqual(before.state.agents);
      expect(f.store.snapshot().state.activity).toEqual(before.state.activity);
      f.receive(f.event('start-native', 'native-session'));
      expect(hideAll(f)).toEqual({ hidden: 1, alreadyHidden: 0, skippedLegacy: 2 });
      expect(residentIds(f).sort()).toEqual([cursor.id, claude.id].sort());
      expect(f.store.snapshot().state.activity[0]!.message).toMatch(/2 sessions without a native identity stayed in town\.$/);
    } finally { f.store.close(); }
  });

  it('hides 200 residents and a session waiting for a slot in one commit, and frees every slot', () => {
    const f = fixture();
    try {
      f.store.commit(randomUUID(), (state, at) => {
        for (let i = 0; i < 201; i++) f.store.native.receive(state, f.connection, { ...f.event(`start-${i}`, `session-${i}`), occurredAt: at }, at);
        return 'observation.many';
      });
      const before = f.store.snapshot(), events = f.store.diagnostics().events;
      expect(before.state.agents).toHaveLength(200); expect(sessionOf(f, 'session-200')).toMatchObject({ visible: true, sceneVisible: false });

      expect(hideAll(f)).toEqual({ hidden: 201, alreadyHidden: 0, skippedLegacy: 0 });

      const after = f.store.snapshot(), sessions = everySession(f);
      expect(after.cursor).toBe(before.cursor + 1); expect(f.store.diagnostics().events).toBe(events + 1);
      expect(after.state.agents).toHaveLength(0);
      expect(sessions).toHaveLength(201); expect(sessions.every(session => session.visibility === 'hidden' && !session.visible && !session.sceneVisible)).toBe(true);
      // The slots are free: a session the town has never seen appears at once...
      f.receive(f.event('start-new', 'brand-new-session'));
      expect(f.store.snapshot().state.agents).toHaveLength(1);
      // ...while neither a resident nor the one that was waiting for a slot comes back on its own.
      f.receive(f.event('later-resident', 'session-3')); f.receive(f.event('later-waiting', 'session-200'));
      expect(f.store.snapshot().state.agents).toHaveLength(1);
    } finally { f.store.close(); }
  });

  it('leaves state, session list and archive exactly as they were when the batch fails part-way, and works on a retry', () => {
    const f = fixture();
    try {
      f.receive(f.event('ended-once', 'session-archived', 'session.end'));
      const finished = f.store.snapshot().state.agents[0]!;
      f.store.archiveAgent(finished.id, archiveReview(f.store.snapshot().state, finished).reviewToken);
      f.store.commit(randomUUID(), (state, at) => {
        for (let i = 0; i < 200; i++) f.store.native.receive(state, f.connection, { ...f.event(`start-${i}`, `session-${i}`), occurredAt: at }, at);
        return 'observation.many';
      });
      const before = f.store.snapshot(), sessions = everySession(f), archive = f.store.history(), diagnostics = f.store.diagnostics();
      expect(before.state.agents).toHaveLength(200); expect(archive.total).toBe(1);

      const inventory = f.store.native as unknown as { save(session: NativeSession, agent: Agent | undefined): void };
      const original = inventory.save.bind(inventory); let writes = 0;
      const fault = vi.spyOn(inventory, 'save').mockImplementation((session, agent) => { if (++writes === 150) throw new Error('disk full'); original(session, agent); });
      expect(() => hideAll(f)).toThrow('disk full');
      fault.mockRestore();

      expect(writes).toBe(150); // 149 sessions were already written inside the transaction when the 150th failed
      expect(f.store.snapshot()).toEqual(before); expect(everySession(f)).toEqual(sessions); expect(f.store.history()).toEqual(archive); expect(f.store.diagnostics()).toEqual(diagnostics);

      expect(hideAll(f)).toEqual({ hidden: 200, alreadyHidden: 0, skippedLegacy: 0 });
      expect(f.store.snapshot().cursor).toBe(before.cursor + 1); expect(f.store.snapshot().state.agents).toHaveLength(0);
      expect(f.store.history()).toEqual(archive);
    } finally { f.store.close(); }
  });

  it('keeps sessions hidden through later events and rescans, while a session the town never saw still appears (hide is a snapshot)', () => {
    const f = fixture();
    try {
      for (const id of ['session-1', 'session-2']) f.receive(f.event(`start-${id}`, id));
      hideAll(f);
      const hidden = ['session-1', 'session-2'].map(id => sessionOf(f, id).agentId);
      f.receive({ ...f.event('report-after', 'session-1', 'turn.end'), summary: 'A report that arrives after hiding.' });
      f.receive(f.event('tool-after', 'session-2'));
      f.discover('session-1'); f.discover('session-2', undefined, 'Renamed after a rescan');
      const state = f.store.snapshot().state;
      expect(state.agents).toHaveLength(0);
      expect(everySession(f).every(session => session.visibility === 'hidden' && !session.visible && !session.sceneVisible)).toBe(true);
      expect(state.handoffs).toHaveLength(1); expect(f.store.native.detail(hidden[0]!, state).activity).toBe('reporting');
      expect(sessionOf(f, 'session-2').title).toBe('Renamed after a rescan');
      // A session this inventory has never seen from a tool that is still hooked appears as usual.
      f.receive(f.event('start-new', 'session-new'));
      expect(residentIds(f)).toEqual([sessionOf(f, 'session-new').agentId]);
      // Undo is per session: showing one brings back only that one, and a second hide-all takes it away again.
      f.store.commit(randomUUID(), current => { f.store.native.visibility(hidden[1]!, true, current); return 'observation.visible'; });
      expect(residentIds(f).sort()).toEqual([hidden[1]!, sessionOf(f, 'session-new').agentId].sort());
      expect(hideAll(f)).toEqual({ hidden: 2, alreadyHidden: 1, skippedLegacy: 0 });
      expect(f.store.snapshot().state.agents).toHaveLength(0);
    } finally { f.store.close(); }
  });

  it('takes a character out of town even when its session was already hidden (it came back through a stray legacy event)', () => {
    const f = fixture();
    try {
      f.receive(f.event('start-stray', 'session-stray'));
      const id = sessionOf(f, 'session-stray').agentId;
      f.store.commit(randomUUID(), state => { f.store.native.visibility(id, false, state); return 'observation.hidden'; });
      f.store.commit(randomUUID(), state => { state.agents.push(structuredClone(f.store.native.detail(id, state))); return 'observation.legacy'; });
      expect(residentIds(f)).toEqual([id]); expect(sessionOf(f, 'session-stray')).toMatchObject({ visibility: 'hidden', sceneVisible: true });
      expect(hideAll(f)).toEqual({ hidden: 1, alreadyHidden: 0, skippedLegacy: 0 });
      expect(residentIds(f)).toEqual([]); expect(sessionOf(f, 'session-stray')).toMatchObject({ visibility: 'hidden', visible: false, sceneVisible: false });
    } finally { f.store.close(); }
  });

  it('touches neither archived sessions nor sessions that were only discovered', () => {
    const f = fixture();
    try {
      f.receive(f.event('ended-once', 'session-archived', 'session.end'));
      const finished = f.store.snapshot().state.agents[0]!;
      f.store.archiveAgent(finished.id, archiveReview(f.store.snapshot().state, finished).reviewToken);
      f.discover('only-discovered'); f.receive(f.event('start-live', 'session-live'));
      const archive = f.store.history();
      expect(hideAll(f)).toEqual({ hidden: 1, alreadyHidden: 0, skippedLegacy: 0 });
      expect(sessionOf(f, 'session-archived')).toMatchObject({ visibility: 'auto' }); expect(sessionOf(f, 'only-discovered')).toMatchObject({ visibility: 'auto', visible: false });
      expect(f.store.history()).toEqual(archive); expect(f.store.snapshot().state.history?.archivedAgents).toBe(1);
      expect(hideAll(f)).toEqual({ hidden: 0, alreadyHidden: 1, skippedLegacy: 0 });
    } finally { f.store.close(); }
  });

  it('ends every session exactly as hiding it alone would', () => {
    const f = fixture();
    try {
      f.receive(f.event('start-a', 'session-a'));
      f.receive({ ...f.event('report-b', 'session-b', 'turn.end'), summary: 'Reported before hiding.', files: ['src/example.ts'] });
      f.receive(f.event('end-c', 'session-c', 'session.end'));
      f.receive({ ...f.event('child', 'parent'), sessionId: 'parent:child', parentSessionId: 'parent', nativeParentSessionId: 'parent', nativeChildId: 'child' });
      addLegacySession(f);
      const ids = f.store.snapshot().state.agents.filter(agent => agent.observation?.nativeSourceId).map(agent => agent.id);
      expect(ids).toHaveLength(4);
      // Each strategy runs inside a transaction that is rolled back, so both start from the very same state and identifiers.
      const rehearse = (apply: (state: TownState, now: string) => void) => {
        let seen: { agents: Agent[]; sessions: NativeSession[]; details: Agent[] } | undefined;
        expect(() => f.store.commit(randomUUID(), (state, now) => {
          apply(state, now); seen = structuredClone({ agents: state.agents, sessions: everySession(f, state), details: ids.map(id => f.store.native.detail(id, state)) }); throw new Error('rehearsal');
        })).toThrow('rehearsal');
        return seen!;
      };
      const bulk = rehearse((state, now) => { f.store.native.hideProject('repo-native', state, now); });
      const single = rehearse(state => { for (const id of ids) f.store.native.visibility(id, false, state); });
      expect(bulk).toEqual(single);
      expect(bulk.agents).toHaveLength(1); expect(bulk.sessions.every(session => session.visibility === 'hidden')).toBe(true);
    } finally { f.store.close(); }
  });

  it('refuses an unknown project, previews without writing, and writes only inside a state transaction', () => {
    const f = fixture();
    try {
      f.receive(f.event('start-1', 'session-1')); addLegacySession(f);
      const before = f.store.snapshot(), sessions = everySession(f);
      expect(f.store.native.previewHideProject('repo-native', before.state)).toEqual({ hidden: 1, alreadyHidden: 0, skippedLegacy: 1 });
      expect(f.store.snapshot()).toEqual(before); expect(everySession(f)).toEqual(sessions);
      const unknown = expect.objectContaining({ code: 'NATIVE_PROJECT_NOT_FOUND', statusCode: 404 });
      expect(() => f.store.native.previewHideProject('missing-project', before.state)).toThrowError(unknown);
      expect(() => f.store.commit(randomUUID(), (state, now) => { f.store.native.hideProject('missing-project', state, now); return 'observation.native_visibility_bulk'; })).toThrowError(unknown);
      // A state from another workspace is refused the same way, so one workspace's call can never reach another's sessions.
      expect(() => f.store.native.previewHideProject('repo-native', { ...before.state, workspace: { ...before.state.workspace, id: 'another-workspace' } })).toThrowError(unknown);
      expect(() => f.store.native.hideProject('repo-native', before.state, new Date().toISOString())).toThrow('require a state transaction');
      expect(f.store.snapshot()).toEqual(before); expect(everySession(f)).toEqual(sessions);
      // The rule holds even when nothing is left to hide, so a caller cannot rely on it only sometimes.
      hideAll(f);
      expect(() => f.store.native.hideProject('repo-native', f.store.snapshot().state, new Date().toISOString())).toThrow('require a state transaction');
    } finally { f.store.close(); }
  });

  it('leaves another house completely alone: its live, hand-hidden and archived sessions stay as they were and are not counted', () => {
    const f = fixture();
    try {
      const other = addOtherHouse(f);
      f.receive(f.event('other-live-start', 'other-live'), other); f.receive(f.event('other-hand-start', 'other-hand'), other); f.receive(f.event('other-end', 'other-ended', 'session.end'), other);
      const handId = sessionOf(f, 'other-hand').agentId, finishedId = sessionOf(f, 'other-ended').agentId;
      f.store.commit(randomUUID(), state => { f.store.native.visibility(handId, false, state); return 'observation.hidden'; });
      const finished = f.store.snapshot().state.agents.find(agent => agent.id === finishedId)!;
      f.store.archiveAgent(finished.id, archiveReview(f.store.snapshot().state, finished).reviewToken);
      f.receive(f.event('mine-start', 'mine-1'));
      // The other house now holds one resident, one session hidden by hand and one archived session; this house holds one resident.
      const otherSessions = everySession(f, undefined, OTHER_HOUSE), otherTown = f.store.snapshot().state.agents.filter(agent => agent.repoId === OTHER_HOUSE), archive = f.store.history();
      expect(otherSessions).toHaveLength(3); expect(otherTown).toHaveLength(1); expect(archive.total).toBe(1);
      expect(otherSessions.find(session => session.id === handId)).toMatchObject({ visibility: 'hidden' });

      // Neither the other house's hand-hidden session nor its archived one may be hidden, counted as already hidden, or archived again.
      expect(hideAll(f)).toEqual({ hidden: 1, alreadyHidden: 0, skippedLegacy: 0 });
      expect(everySession(f, undefined, OTHER_HOUSE)).toEqual(otherSessions);
      expect(f.store.snapshot().state.agents.filter(agent => agent.repoId === OTHER_HOUSE)).toEqual(otherTown);
      expect(f.store.history()).toEqual(archive);
      // The second call still counts only this house.
      expect(hideAll(f)).toEqual({ hidden: 0, alreadyHidden: 1, skippedLegacy: 0 });
      expect(hideAll(f, OTHER_HOUSE)).toEqual({ hidden: 1, alreadyHidden: 1, skippedLegacy: 0 });
    } finally { f.store.close(); }
  });

  it('recognises a native identity from either of its two keys: a scanned session shown by hand, and a legacy session a native event adopted', () => {
    const f = fixture();
    try {
      // Only discovery.sourceId: found by a scan and shown by the owner; no tool event was ever seen for it.
      f.discover('scan-only');
      const scanned = sessionOf(f, 'scan-only').id;
      f.store.commit(randomUUID(), state => { f.store.native.visibility(scanned, true, state); return 'observation.visible'; });
      // Only observation.nativeSourceId: a hook session first seen before its connection had a native profile, then taken over by a bound native event.
      const legacy: ObservationConnection = { ...f.connection, nativeSourceId: undefined, sourceRevision: undefined, binding: undefined };
      f.store.commit(randomUUID(), (state, at) => applyObservation(state, legacy, { id: 'adopt-legacy-start', sessionId: 'adopted-1', kind: 'tool.start', occurredAt: at }, at));
      f.receive(f.event('adopt-native-start', 'adopted-1'));
      // Prove the two residents really differ in which key they carry, so dropping either key from the rule is noticed.
      const residents = f.store.snapshot().state.agents;
      expect(residents).toHaveLength(2);
      expect(residents.filter(agent => !agent.observation && agent.discovery?.sourceId)).toHaveLength(1);
      expect(residents.filter(agent => agent.observation?.nativeSourceId && !agent.discovery)).toHaveLength(1);

      expect(hideAll(f)).toEqual({ hidden: 2, alreadyHidden: 0, skippedLegacy: 0 });
      expect(residentIds(f)).toEqual([]);
      expect(everySession(f).every(session => session.visibility === 'hidden')).toBe(true);
    } finally { f.store.close(); }
  });

  it('stamps its audit note with the commit time and keeps the activity feed capped at 500 entries, newest first', () => {
    const f = fixture();
    try {
      f.receive(f.event('start-1', 'session-1'));
      f.store.commit(randomUUID(), (state, at) => { state.activity = Array.from({ length: 500 }, (_, index) => ({ id: `filler-${index}`, kind: 'system' as const, createdAt: at, message: 'Filler entry' })); return 'observation.fixture'; });
      const before = f.store.snapshot().cursor;
      expect(hideAll(f).hidden).toBe(1);
      const { activity } = f.store.snapshot().state, [saved] = f.store.replay(before);
      expect(saved).toMatchObject({ type: 'observation.native_visibility_bulk' });
      expect(activity).toHaveLength(500);
      expect(activity[0]).toMatchObject({ kind: 'system', createdAt: saved!.occurredAt, message: expect.stringMatching(/^Hid 1 session from town/) });
      // The oldest entry falls off the end; the note and the 498 newest fillers remain.
      expect(activity.at(-1)!.id).toBe('filler-498');
    } finally { f.store.close(); }
  });
});

// H0-15: a hidden total and visibility=hidden filter on page(), and an opt-in refusal (never a default) when
// showing a session would exceed the 200-resident cap.
describe('hidden total, visibility filter, and the opt-in 200-resident show refusal (H0-15)', () => {
  it('hiddenTotal counts every hidden session with no 30-day cutoff, while items and total stay windowed and filterable', () => {
    const f = fixture();
    try {
      for (const id of ['session-1', 'session-2']) f.receive(f.event(`start-${id}`, id));
      const oldAt = new Date(Date.now() - 40 * 86400000).toISOString();
      f.store.commit(randomUUID(), current => { f.store.native.discover(f.source, 'repo-native', [{ nativeSessionId: 'session-old', projectPath: 'C:\\projects\\fixture', createdAt: oldAt, updatedAt: oldAt }], current, oldAt); return 'observation.discovered'; });
      const idOne = f.store.native.page(f.store.snapshot().state).items.find(item => item.nativeSessionId === 'session-1')!.id;
      const oldId = f.store.native.page(f.store.snapshot().state, { includeOlder: true }).items.find(item => item.nativeSessionId === 'session-old')!.id;
      f.store.commit(randomUUID(), state => { f.store.native.visibility(idOne, false, state); f.store.native.visibility(oldId, false, state); return 'observation.hidden'; });

      const state = f.store.snapshot().state;
      // Default window: the old hidden session is outside the 30-day cutoff, so it is absent from items —
      // but hiddenTotal still counts it, because it is never windowed.
      const unfiltered = f.store.native.page(state, { repoId: 'repo-native' });
      expect(unfiltered.hiddenTotal).toBe(2);
      expect(unfiltered.items.find(item => item.nativeSessionId === 'session-1')).toMatchObject({ visibility: 'hidden' });
      expect(unfiltered.items.some(item => item.nativeSessionId === 'session-old')).toBe(false);

      // visibility=hidden filters items to just the hidden ones, still windowed by the same 30-day cutoff.
      const hiddenOnly = f.store.native.page(state, { repoId: 'repo-native', visibility: 'hidden' });
      expect(hiddenOnly.hiddenTotal).toBe(2);
      expect(hiddenOnly.items.map(item => item.nativeSessionId)).toEqual(['session-1']);
      expect(hiddenOnly.total).toBe(1);

      // includeOlder widens items to the old hidden session too; hiddenTotal is unchanged either way.
      const hiddenWithOlder = f.store.native.page(state, { repoId: 'repo-native', visibility: 'hidden', includeOlder: true });
      expect(hiddenWithOlder.hiddenTotal).toBe(2);
      expect(hiddenWithOlder.items.map(item => item.nativeSessionId).sort()).toEqual(['session-1', 'session-old']);
    } finally { f.store.close(); }
  });

  it('leaves every existing caller silent by default, and only refuses at the cap when explicitly asked (onLimit: "refuse")', () => {
    const f = fixture();
    try {
      f.store.commit(randomUUID(), (state, at) => {
        for (let i = 0; i < 200; i++) f.store.native.receive(state, f.connection, { ...f.event(`start-${i}`, `session-${i}`), occurredAt: at }, at);
        return 'observation.many';
      });
      expect(f.store.snapshot().state.agents).toHaveLength(200);
      f.discover('session-overflow');
      const overflow = f.store.native.page(f.store.snapshot().state, { includeOlder: true }).items.find(item => item.nativeSessionId === 'session-overflow')!;

      // Default (every caller that omits the option, including fixtures that seed overflow state on purpose,
      // like this file's H0-12 tests and history.test.ts): silent, exactly as it always has been.
      f.store.commit(randomUUID(), state => { f.store.native.visibility(overflow.id, true, state); return 'observation.visible'; });
      const afterSilent = f.store.snapshot().state;
      expect(afterSilent.agents).toHaveLength(200);
      expect(afterSilent.agents.some(agent => agent.id === overflow.id)).toBe(false);
      expect(f.store.native.page(afterSilent, { includeOlder: true }).items.find(item => item.id === overflow.id)).toMatchObject({ visibility: 'shown', visible: true, sceneVisible: false });

      // Put it back to hidden, then prove the strict mode refuses instead of repeating that silent loss.
      f.store.commit(randomUUID(), state => { f.store.native.visibility(overflow.id, false, state); return 'observation.hidden'; });
      const before = f.store.snapshot();
      expect(() => f.store.commit(randomUUID(), state => { f.store.native.visibility(overflow.id, true, state, { onLimit: 'refuse' }); return 'observation.visible'; }))
        .toThrowError(expect.objectContaining({ code: 'NATIVE_RESIDENT_LIMIT', statusCode: 429, message: 'Town is full at 200 residents. Hide one to show this.' }));
      // Refused cleanly: nothing was written, and the session is still hidden and findable, not lost.
      expect(f.store.snapshot()).toEqual(before);
      expect(f.store.native.page(f.store.snapshot().state, { includeOlder: true }).items.find(item => item.id === overflow.id)).toMatchObject({ visibility: 'hidden', visible: false });

      // Freeing a slot lets the strict mode succeed too: it only refuses AT the cap.
      f.store.commit(randomUUID(), state => { f.store.native.visibility(state.agents[0]!.id, false, state); return 'observation.hidden'; });
      f.store.commit(randomUUID(), state => { f.store.native.visibility(overflow.id, true, state, { onLimit: 'refuse' }); return 'observation.visible'; });
      expect(f.store.snapshot().state.agents.some(agent => agent.id === overflow.id)).toBe(true);
    } finally { f.store.close(); }
  });
});
