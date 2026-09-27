import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, NativeHideAllResult, NativeSession, NativeSource, ObservationConnection } from '@agent-town/contracts';
import { sessionReadSpy, spawnSpy } from '../helpers';
import { Store, type StoreLimits } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { registerObservationApi } from '../../apps/service/src/observation/service';
import { applyObservation } from '../../apps/service/src/observation/reducer';
import { IdentityError } from '../../apps/service/src/identity/types';

describe('native setup API', () => {
  it('registers a selected source, scans real metadata, binds hooks, and reconciles one character without billing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-native-api-'));
    const home = join(directory, 'codex'), repo = join(directory, 'repo'); mkdirSync(home); mkdirSync(repo);
    const db = new Database(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,cli_version TEXT)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('native-one', process.platform === 'win32' ? `\\\\?\\${repo}` : repo, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), 0, 'fixture'); db.close();
    const state = privateState({ id: 'native-api-workspace', name: 'Fixture', kind: 'personal' });
    state.discovery!.roots = [repo]; state.repositories = [{ id: 'project-one', name: 'Project', source: 'local', localPath: repo, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [0, 0] }];
    const store = new Store(':memory:', state), other = new Store(':memory:', privateState({ id: 'other-native-workspace', name: 'Other', kind: 'personal' }));
    const secrets = new Map<string, string>(), app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    const api = registerObservationApi(app, { directory, vault: { available: true, async put(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id) ?? null; }, async delete(id) { secrets.delete(id); } },
      scoped: request => ({ ownerId: request.headers['x-fixture-other'] ? 'other-owner' : 'owner', store: request.headers['x-fixture-other'] ? other : store }), workspace: () => store });
    const prefix = '/api/v1/workspaces/native-api-workspace/observation';
    try {
      const registered = await app.inject({ method: 'POST', url: `${prefix}/native-sources`, payload: { provider: 'codex', label: 'Selected local profile', homePath: home } });
      expect(registered.statusCode).toBe(200); const source = registered.json();
      expect(JSON.stringify(source)).not.toContain(home);
      const unavailable = await app.inject({ method: 'POST', url: `${prefix}/native-sources/${source.id}/scan`, payload: { repoId: 'not-selected' } }); expect(unavailable.statusCode).toBe(400);
      const scan = await app.inject({ method: 'POST', url: `${prefix}/native-sources/${source.id}/scan`, payload: { repoId: 'project-one' } });
      expect(scan.statusCode).toBe(200); expect(scan.json()).toMatchObject({ total: 1, items: [{ nativeSessionId: 'native-one', activity: 'unknown', observedAt: null }] });
      const sessionId = scan.json().items[0].id;
      const show = await app.inject({ method: 'POST', url: `${prefix}/native-sessions/${sessionId}/visibility`, payload: { visible: true } });
      expect(show.statusCode).toBe(200); expect(store.snapshot().state.agents[0]?.activity).toBe('unknown');
      const setup = await app.inject({ method: 'POST', url: `${prefix}/connections`, payload: { provider: 'codex', label: 'Codex events', repoId: 'project-one', nativeSourceId: source.id } });
      expect(setup.statusCode).toBe(200); expect(setup.json().connection.status).toBe('unverified');
      const record = api.registry.all()[0]!;
      const event = { id: 'fixture-live', sessionId: 'native-one', nativeSessionId: 'native-one', nativeSourceId: source.id, sourceRevision: source.revision, kind: 'tool.start' as const, occurredAt: new Date().toISOString() };
      api.receive(record, [event]);
      expect(store.snapshot().state.agents).toMatchObject([{ id: sessionId, activity: 'working' }]);
      const recheck = await app.inject({ method: 'POST', url: `${prefix}/native-sources/${source.id}/verify` });
      expect(recheck.json().revision).toBe(source.revision);
      expect(api.receive(record, [event])).toEqual({ accepted: 0, duplicate: 1 });
      // Already saved receipts still require current authorization.
      expect(() => api.receive(record, [{ ...event, sourceRevision: source.revision + 1 }])).toThrow(/approved native profile/);
      expect(() => api.receive(record, [{ ...event, nativeSessionId: 'other-native' }])).toThrow(/another session/);
      expect(store.snapshot().state.workflow?.policy.paidEnabled).toBe(false);
      const foreign = await app.inject({ method: 'GET', url: `${prefix}/native-sessions/${sessionId}/detail`, headers: { 'x-fixture-other': 'yes' } }); expect(foreign.statusCode).toBe(404);
      const unsupported = await app.inject({ method: 'POST', url: `${prefix}/native-sources`, payload: { provider: 'copilot-vscode', label: 'Unsupported history', homePath: home } });
      const unsupportedScan = await app.inject({ method: 'POST', url: `${prefix}/native-sources/${unsupported.json().id}/scan`, payload: { repoId: 'project-one' } });
      expect(unsupportedScan.statusCode).toBe(422);
      expect(store.native.source(unsupported.json().id)?.source.discovery).toBe('unsupported');
      const revoke = await app.inject({ method: 'POST', url: `${prefix}/connections/${record.connection.id}/revoke` }); expect(revoke.statusCode).toBe(200);
      expect(() => api.receive(record, [{ id: 'after-revoke', sessionId: 'native-one', kind: 'tool.start', occurredAt: new Date().toISOString() }])).toThrow(/revoked/);
    } finally {
      await api.close(); await app.close(); store.close(); other.close();
      if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-native-api-`)) throw new Error('Unsafe fixture cleanup');
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('detected native tool status', () => {
  const saved = { CODEX_HOME: process.env.CODEX_HOME, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR };
  afterEach(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key as keyof typeof saved]; else process.env[key as keyof typeof saved] = value; });

  it('requires the Cursor SDK store file (not just its folder) to report detected, and reads Codex version from its local session store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-native-tools-'));
    const codexHome = join(directory, 'codex'), cursorHome = join(directory, 'cursor'); mkdirSync(codexHome); mkdirSync(cursorHome);
    const db = new Database(join(codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,cli_version TEXT)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('older', '/repo', 1000, 1000, 0, '1.2.3');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('newer', '/repo', 1000, 2000, 0, '1.4.0');
    db.close();
    process.env.CODEX_HOME = codexHome; process.env.CURSOR_CONFIG_DIR = cursorHome;
    const state = privateState({ id: 'native-tools-workspace', name: 'Fixture', kind: 'personal' });
    const store = new Store(':memory:', state);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    const secrets = new Map<string, string>();
    const api = registerObservationApi(app, { directory, vault: { available: true, async put(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id) ?? null; }, async delete(id) { secrets.delete(id); } },
      scoped: () => ({ ownerId: 'owner', store }), workspace: () => store });
    try {
      const before = await app.inject({ method: 'GET', url: '/api/v1/workspaces/native-tools-workspace/observation/native-setup' });
      expect(before.statusCode).toBe(200);
      const tools = before.json().tools as { provider: string; detected: boolean; version: string | null }[];
      expect(tools.find(tool => tool.provider === 'cursor')).toMatchObject({ detected: false });
      expect(tools.find(tool => tool.provider === 'codex')).toMatchObject({ detected: true, version: '1.4.0' });
      writeFileSync(join(cursorHome, 'agents.ndjson'), '');
      const after = await app.inject({ method: 'GET', url: '/api/v1/workspaces/native-tools-workspace/observation/native-setup' });
      const toolsAfter = after.json().tools as { provider: string; detected: boolean }[];
      expect(toolsAfter.find(tool => tool.provider === 'cursor')).toMatchObject({ detected: true });
    } finally {
      await api.close(); await app.close(); store.close();
      if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-native-tools-`)) throw new Error('Unsafe fixture cleanup');
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// H0-12: POST .../observation/native-sessions/hide-all {repoId}
interface HideHarness { app: ReturnType<typeof Fastify>; store: Store; other: Store; prefix: string; hideAll(repoId: unknown, headers?: Record<string, string>): Promise<{ statusCode: number; json(): unknown }>; seed(repoId: string, count: number, startIndex?: number): void; seedLegacy(repoId: string, session: string): void }
async function withHideHarness(run: (harness: HideHarness) => Promise<void>, limits?: Partial<StoreLimits>) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-native-hide-'));
  const state = privateState({ id: 'native-hide-workspace', name: 'Fixture', kind: 'personal' });
  state.repositories = (['one', 'two'] as const).map((name, index) => ({ id: `project-${name}`, name: `Project ${name}`, source: 'local' as const, localPath: `C:\\fixture\\${name}`, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [index * 12, 0] as [number, number] }));
  const store = new Store(':memory:', state, limits), other = new Store(':memory:', privateState({ id: 'other-hide-workspace', name: 'Other', kind: 'personal' }));
  let source!: NativeSource;
  store.commit('seed-source', () => { source = store.native.register('codex', 'C:\\fixture\\codex-home', 'Fixture profile'); return 'observation.native_source_registered'; });
  const connection: ObservationConnection = { id: randomUUID(), provider: 'codex', repoId: 'project-one', label: 'Fixture', nativeSourceId: source.id, sourceRevision: source.revision, binding: 'declared', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 };
  const secrets = new Map<string, string>(), app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ code: error instanceof IdentityError ? error.code : undefined, message: error instanceof Error ? error.message : 'Request failed' }));
  const api = registerObservationApi(app, { directory, vault: { available: true, async put(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id) ?? null; }, async delete(id) { secrets.delete(id); } },
    scoped: request => ({ ownerId: request.headers['x-fixture-other'] ? 'other-owner' : 'owner', store: request.headers['x-fixture-other'] ? other : store }), workspace: () => store });
  const prefix = '/api/v1/workspaces/native-hide-workspace/observation';
  try {
    await run({ app, store, other, prefix,
      hideAll: (repoId, headers) => app.inject({ method: 'POST', url: `${prefix}/native-sessions/hide-all`, payload: repoId === undefined ? undefined : { repoId }, ...(headers ? { headers } : {}) }),
      // startIndex (H0-15) lets a second seed() call for the same project add distinct, non-colliding
      // sessions instead of re-touching ones a prior call already created.
      seed: (repoId, count, startIndex = 0) => { store.commit(randomUUID(), (current, at) => {
        for (let index = startIndex; index < startIndex + count; index++) store.native.receive(current, { ...connection, repoId }, { id: `${repoId}-start-${index}`, sessionId: `${repoId}-session-${index}`, nativeSessionId: `${repoId}-session-${index}`, nativeSourceId: source.id, sourceRevision: source.revision, kind: 'tool.start', occurredAt: at }, at);
        return 'observation.seed';
      }); },
      // A hook session seen through a connection with no native profile (what every Cursor session is): it has no native identity.
      seedLegacy: (repoId, session) => { const legacy: ObservationConnection = { ...connection, id: randomUUID(), provider: 'cursor', repoId, nativeSourceId: undefined, sourceRevision: undefined, binding: undefined };
        store.commit(randomUUID(), (current, at) => applyObservation(current, legacy, { id: `${session}-start`, sessionId: session, kind: 'tool.start', occurredAt: at }, at)); } });
  } finally {
    await api.close(); await app.close(); store.close(); other.close();
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-native-hide-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('hide all watched sessions API (H0-12)', () => {
  it('hides one project in one commit of its own type, frees the slots, and a repeat hides 0 without saving anything', async () => {
    await withHideHarness(async ({ app, store, prefix, hideAll, seed }) => {
      seed('project-one', 3); seed('project-two', 2);
      const before = store.snapshot();
      expect(before.state.agents).toHaveLength(5);
      // Hiding is deterministic bookkeeping: it reads no tool's session store and starts no process (the network guard is on for every file).
      const reads = sessionReadSpy(), launches = spawnSpy();
      let first: Awaited<ReturnType<typeof hideAll>>, again: Awaited<ReturnType<typeof hideAll>>;
      try { first = await hideAll('project-one'); again = await hideAll('project-one'); } finally { launches.restore(); reads.restore(); }
      reads.expectNone(); launches.expectNone();

      expect(first.statusCode).toBe(200);
      const result = first.json() as NativeHideAllResult;
      expect(result).toMatchObject({ repoId: 'project-one', hidden: 3, alreadyHidden: 0, skippedLegacy: 0 });
      expect(result.snapshot.cursor).toBe(before.cursor + 1);
      expect(result.snapshot.state.agents.map(agent => agent.repoId)).toEqual(['project-two', 'project-two']);
      // One saved event, of a type that is not pinned; one audit note, counts only.
      expect(store.replay(before.cursor).map(event => event.type)).toEqual(['observation.native_visibility_bulk']);
      expect(result.snapshot.state.activity).toHaveLength(before.state.activity.length + 1);
      expect(result.snapshot.state.activity[0]).toMatchObject({ kind: 'system', message: expect.stringMatching(/^Hid 3 sessions from town; saved reports are kept/) });
      expect(result.snapshot.state.activity[0]!.message).not.toMatch(/project-|session-|agent-|C:\\/);

      // A repeat finds nothing to hide and saves nothing: same state, same cursor, no new event or note.
      expect(again.statusCode).toBe(200); expect(again.json()).toMatchObject({ repoId: 'project-one', hidden: 0, alreadyHidden: 3, skippedLegacy: 0 });
      expect(store.snapshot()).toEqual(result.snapshot); expect(store.replay(result.snapshot.cursor)).toEqual([]);
      // The answer to a call that changed nothing still carries the current state, so a screen can refresh from it.
      expect((again.json() as NativeHideAllResult).snapshot).toEqual(store.snapshot());
      // The other house was never touched, and undo is per session through the existing visibility route.
      const listed = (await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-one` })).json() as { items: NativeSession[] };
      expect(listed.items.every(item => item.visibility === 'hidden')).toBe(true);
      const show = await app.inject({ method: 'POST', url: `${prefix}/native-sessions/${listed.items[0]!.id}/visibility`, payload: { visible: true } });
      expect(show.statusCode).toBe(200); expect(store.snapshot().state.agents).toHaveLength(3);
      expect((await hideAll('project-two')).json()).toMatchObject({ hidden: 2 });
    });
  });

  it('counts sessions without a native identity as skipped and saves nothing for a house that holds only those', async () => {
    await withHideHarness(async ({ store, hideAll, seed, seedLegacy }) => {
      seed('project-one', 2); seedLegacy('project-two', 'cursor-chat');
      const before = store.snapshot();
      expect(before.state.agents.filter(agent => agent.repoId === 'project-two')).toHaveLength(1);
      // Nothing to hide here: the legacy session is counted, stays in town, and the call writes no event, no note and no cursor change.
      const only = await hideAll('project-two');
      expect(only.statusCode).toBe(200);
      expect(only.json()).toMatchObject({ repoId: 'project-two', hidden: 0, alreadyHidden: 0, skippedLegacy: 1 });
      expect((only.json() as NativeHideAllResult).snapshot).toEqual(before);
      expect(store.snapshot()).toEqual(before); expect(store.replay(before.cursor)).toEqual([]);
      // Next to native sessions in the same house it is counted too, and stays in town while they leave.
      seedLegacy('project-one', 'cursor-second');
      const mixed = await hideAll('project-one');
      expect(mixed.statusCode).toBe(200); expect(mixed.json()).toMatchObject({ hidden: 2, alreadyHidden: 0, skippedLegacy: 1 });
      expect(store.snapshot().state.agents.map(agent => agent.repoId).sort()).toEqual(['project-one', 'project-two']);
    });
  });

  it('answers 404 for another owner or an unknown project and 400 for a malformed body, and changes nothing', async () => {
    await withHideHarness(async ({ store, other, hideAll, seed }) => {
      seed('project-one', 2);
      const before = store.snapshot(), otherBefore = other.snapshot();
      // Another owner asks for this owner's project: their own workspace does not have it.
      expect((await hideAll('project-one', { 'x-fixture-other': 'yes' })).statusCode).toBe(404);
      expect((await hideAll('project-missing')).statusCode).toBe(404);
      // No project, an empty one, or one that is not a plain string.
      for (const repoId of [undefined, '', 5, {}, ['project-one']]) expect((await hideAll(repoId)).statusCode, JSON.stringify(repoId)).toBe(400);
      expect(store.snapshot()).toEqual(before); expect(other.snapshot()).toEqual(otherBefore);
    });
  });

  it('rejects a body that carries more than the project', async () => {
    await withHideHarness(async ({ app, store, prefix, seed }) => {
      seed('project-one', 1);
      const before = store.snapshot();
      for (const payload of [{ repoId: 'project-one', visible: false }, { repoId: 'project-one', sessionIds: ['x'] }, { repoid: 'project-one' }]) {
        expect((await app.inject({ method: 'POST', url: `${prefix}/native-sessions/hide-all`, payload })).statusCode).toBe(400);
      }
      expect(store.snapshot()).toEqual(before);
    });
  });

  it('is not a protected receipt: it still works after the protected-history limit is reached', async () => {
    await withHideHarness(async ({ store, hideAll, seed }) => {
      seed('project-one', 2);
      store.commit('fill-protected-receipt', () => 'handoff.saved');
      // The fixture really is at the limit: a protected commit type is refused now.
      expect(() => store.commit('one-more-protected', () => 'handoff.saved')).toThrow('protected action history limit');
      const response = await hideAll('project-one');
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ hidden: 2 });
      expect(store.snapshot().state.agents).toHaveLength(0);
    }, { maxPinnedReceipts: 1 });
  });

  it('leaves state and session list untouched when the batch fails part-way, then hides all 200 in one commit on a retry', async () => {
    await withHideHarness(async ({ app, store, prefix, hideAll, seed }) => {
      seed('project-one', 200);
      const sessions = async () => { const items: NativeSession[] = []; for (let cursor: string | null = '0'; cursor !== null;) { const page = (await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-one&includeOlder=true&cursor=${cursor}` })).json() as { items: NativeSession[]; nextCursor: string | null }; items.push(...page.items); cursor = page.nextCursor; } return items; };
      const before = store.snapshot(), listed = await sessions(), diagnostics = store.diagnostics();
      expect(before.state.agents).toHaveLength(200); expect(listed).toHaveLength(200);

      const inventory = store.native as unknown as { save(session: NativeSession, agent: Agent | undefined): void };
      const original = inventory.save.bind(inventory); let writes = 0;
      const fault = vi.spyOn(inventory, 'save').mockImplementation((session, agent) => { if (++writes === 150) throw new Error('disk full'); original(session, agent); });
      expect((await hideAll('project-one')).statusCode).toBe(500);
      fault.mockRestore();

      expect(writes).toBe(150);
      expect(store.snapshot()).toEqual(before); expect(await sessions()).toEqual(listed); expect(store.diagnostics()).toEqual(diagnostics);

      const retry = await hideAll('project-one');
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ hidden: 200, alreadyHidden: 0, skippedLegacy: 0 });
      expect(store.snapshot().cursor).toBe(before.cursor + 1); expect(store.snapshot().state.agents).toHaveLength(0);
      expect((await sessions()).every(item => item.visibility === 'hidden')).toBe(true);
    });
  });
});

// H0-15: the hidden total and visibility=hidden filter GET .../native-sessions gained, and the 200-resident
// show limit the POST .../visibility route now refuses instead of losing a session silently.
describe('hidden total, visibility filter, and the 200-resident show limit (H0-15)', () => {
  it('lists only hidden sessions under visibility=hidden, and reports the same hiddenTotal with or without that filter', async () => {
    await withHideHarness(async ({ app, prefix, seed }) => {
      seed('project-one', 3);
      const first = (await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-one` })).json() as { items: { id: string }[] };
      const [hideMe, staysShown] = first.items.map(item => item.id);
      const hide = await app.inject({ method: 'POST', url: `${prefix}/native-sessions/${hideMe}/visibility`, payload: { visible: false } });
      expect(hide.statusCode).toBe(200);

      const hiddenOnly = await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-one&visibility=hidden` });
      expect(hiddenOnly.statusCode).toBe(200);
      const page = hiddenOnly.json() as { items: { id: string; visibility?: string }[]; hiddenTotal: number; total: number };
      expect(page.items.map(item => item.id)).toEqual([hideMe]);
      expect(page.items.every(item => item.visibility === 'hidden')).toBe(true);
      expect(page.hiddenTotal).toBe(1);
      expect(page.total).toBe(1);

      // Requesting the unfiltered page instead still reports the very same hiddenTotal, and never drops the
      // still-shown session just because one sibling session is hidden.
      const unfiltered = (await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-one` })).json() as { items: { id: string }[]; hiddenTotal: number };
      expect(unfiltered.hiddenTotal).toBe(1);
      expect(unfiltered.items.map(item => item.id)).toEqual(expect.arrayContaining([hideMe, staysShown]));

      // An unrelated project's hidden sessions never bleed into this one's count.
      seed('project-two', 1);
      const otherId = ((await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-two` })).json() as { items: { id: string }[] }).items[0]!.id;
      await app.inject({ method: 'POST', url: `${prefix}/native-sessions/${otherId}/visibility`, payload: { visible: false } });
      expect(((await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-one&visibility=hidden` })).json() as { hiddenTotal: number }).hiddenTotal).toBe(1);
      expect(((await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-two&visibility=hidden` })).json() as { hiddenTotal: number }).hiddenTotal).toBe(1);
    });
  });

  it('refuses to show a hidden session once the town is back at its 200-resident cap, with a clear reason and no state change, instead of losing it silently', async () => {
    await withHideHarness(async ({ app, store, prefix, seed }) => {
      seed('project-one', 200);
      const listed = (await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-one&includeOlder=true` })).json() as { items: { id: string }[] };
      const targetId = listed.items[0]!.id;
      expect((await app.inject({ method: 'POST', url: `${prefix}/native-sessions/${targetId}/visibility`, payload: { visible: false } })).statusCode).toBe(200);
      expect(store.snapshot().state.agents).toHaveLength(199);

      // A brand-new, distinct session fills the freed slot: the town is back at capacity, without touching
      // the one we hid.
      seed('project-one', 1, 200);
      expect(store.snapshot().state.agents).toHaveLength(200);
      const before = store.snapshot();

      const show = await app.inject({ method: 'POST', url: `${prefix}/native-sessions/${targetId}/visibility`, payload: { visible: true } });
      expect(show.statusCode).toBe(429);
      expect(show.json()).toMatchObject({ code: 'NATIVE_RESIDENT_LIMIT', message: 'Town is full at 200 residents. Hide one to show this.' });
      // Nothing changed: no event was saved, the town size is exactly as it was, and the session is still
      // hidden and findable rather than quietly marked shown and lost from both views.
      expect(store.snapshot()).toEqual(before);
      const stillHidden = (await app.inject({ method: 'GET', url: `${prefix}/native-sessions?repoId=project-one&visibility=hidden` })).json() as { items: { id: string }[] };
      expect(stillHidden.items.map(item => item.id)).toEqual([targetId]);

      // Below the cap, showing the very same session still works exactly as it always has: free a slot, retry.
      const freeASlot = await app.inject({ method: 'POST', url: `${prefix}/native-sessions/${listed.items[1]!.id}/visibility`, payload: { visible: false } });
      expect(freeASlot.statusCode).toBe(200);
      expect(store.snapshot().state.agents).toHaveLength(199);
      const showAgain = await app.inject({ method: 'POST', url: `${prefix}/native-sessions/${targetId}/visibility`, payload: { visible: true } });
      expect(showAgain.statusCode).toBe(200);
      expect(store.snapshot().state.agents).toHaveLength(200);
    });
  });
});
