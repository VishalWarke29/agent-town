import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NativeSource, ObservationConnection, ObservationEvent } from '@agent-town/contracts';
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
