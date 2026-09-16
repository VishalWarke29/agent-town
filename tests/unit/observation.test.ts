import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ObservationConnection, ObservationEvent } from '@agent-town/contracts';
import { privateState } from '../../apps/service/src/workspaces';
import { Store } from '../../apps/service/src/store';
import { normalizeHook, redactEvidence } from '../../apps/service/src/observation/normalize';
import { applyObservation } from '../../apps/service/src/observation/reducer';
import { registerObservationApi } from '../../apps/service/src/observation/service';
import { changeHooks, observationSetup } from '../../apps/service/src/observation/setup';
import { IdentityError, type CredentialVault } from '../../apps/service/src/identity';

const source: ObservationConnection = { id: randomUUID(), provider: 'claude', repoId: 'repo-one', label: 'Claude', status: 'unverified', createdAt: new Date().toISOString(), lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 };
function seed(root: string) {
  const state = privateState({ id: 'workspace-one', name: 'Fixture workspace', kind: 'personal' });
  state.discovery!.roots = [root];
  state.repositories = [{ id: 'repo-one', name: 'Repo', branch: 'main', description: '', language: 'Unavailable', color: '#859b87', position: [-6, -3], source: 'local', localPath: root }];
  return state;
}
function clean(directory: string) { const target = resolve(directory); if (target.startsWith(resolve(tmpdir()) + sep)) rmSync(target, { recursive: true }); }
const event = (kind: ObservationEvent['kind'], sequence = 1): ObservationEvent => ({ id: `event-${sequence}`, sessionId: 'session-1', kind, sequence, occurredAt: new Date().toISOString() });

describe('observed agent transitions', () => {
  it('keeps one stable character per scoped session across resumes, repeated events, and several residents in one house', () => {
    const state = seed('C:\\projects\\fixture'), now = '2026-09-14T12:00:00.000Z';
    for (let i = 0; i < 8; i++) applyObservation(state, source, { id: `session-${i}-start`, sessionId: `session-${i}`, kind: 'session.start', occurredAt: now }, now);
    const homes = state.agents.map(agent => [...agent.home]), ids = state.agents.map(agent => agent.id);
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) expect(Math.hypot(homes[i][0] - homes[j][0], homes[i][1] - homes[j][1])).toBeGreaterThanOrEqual(1.1);
    const ended: ObservationEvent = { id: 'session-0-end', sessionId: 'session-0', kind: 'session.end', sequence: 3, occurredAt: now };
    applyObservation(state, source, ended, now); applyObservation(state, source, ended, now);
    applyObservation(state, source, { ...ended, id: 'session-0-resume', kind: 'session.start', sequence: 4 }, now);
    expect(state.agents).toHaveLength(8); expect(state.agents.map(agent => agent.id)).toEqual(ids); expect(state.agents.map(agent => agent.home)).toEqual(homes);
    expect(state.agents[0].activity).toBe('working'); expect(state.handoffs).toEqual([]);
    applyObservation(state, { ...source, id: 'another-scoped-connection' }, { ...ended, id: 'different-source', kind: 'session.start' }, now);
    expect(state.agents).toHaveLength(9);
  });

  it('separates child identity from a similarly named parent session and preserves older persisted character IDs', () => {
    const state = seed('C:\\projects\\fixture'), now = '2026-09-14T12:00:00.000Z';
    applyObservation(state, source, { id: 'main', sessionId: 'parent:child', kind: 'session.start', occurredAt: now }, now);
    applyObservation(state, source, { id: 'child', sessionId: 'parent:child', parentSessionId: 'parent', kind: 'session.start', occurredAt: now }, now);
    expect(new Set(state.agents.map(agent => agent.id)).size).toBe(2);
    state.agents[1].id = 'legacy-character-id';
    applyObservation(state, source, { id: 'child-tool', sessionId: 'parent:child', parentSessionId: 'parent', kind: 'tool.finish', occurredAt: now }, now);
    expect(state.agents).toHaveLength(2); expect(state.agents[1].id).toBe('legacy-character-id');
  });

  it('keeps backfilled sessions stale and permits existing sessions to update at the retention cap', () => {
    const state = seed('C:\\projects\\fixture'), now = '2026-09-14T12:00:00.000Z';
    for (let i = 0; i < 200; i++) applyObservation(state, source, { id: `start-${i}`, sessionId: `session-${i}`, kind: 'session.start', occurredAt: '2026-09-14T11:00:00.000Z' }, now);
    expect(state.agents.every(agent => agent.observation?.freshness === 'stale')).toBe(true);
    // Managed history occupies the same retained capacity as observed sessions.
    delete state.agents[199].observation; state.agents[199].role = 'Managed worker'; state.agents[199].activity = 'offline';
    expect(() => applyObservation(state, source, { id: 'over-cap', sessionId: 'new-session', kind: 'session.start', occurredAt: now }, now)).toThrowError(expect.objectContaining({ code: 'AGENT_CAPACITY' }));
    applyObservation(state, source, { id: 'fresh-existing', sessionId: 'session-0', kind: 'tool.finish', occurredAt: now }, now);
    expect(state.agents).toHaveLength(200); expect(state.agents[0].observation?.freshness).toBe('current');
  });

  it('normalizes Claude child tool events and Cursor conversations/children without inventing unsupported child identities', () => {
    const root = 'C:\\projects\\fixture', now = '2026-09-14T12:00:00.000Z';
    const childStart = normalizeHook('claude', 'SubagentStart', { cwd: root, session_id: 'parent', agent_id: 'child' }, root, now)!;
    const childTool = normalizeHook('claude', 'PreToolUse', { cwd: root, session_id: 'parent', agent_id: 'child', tool_name: 'Read' }, root, now)!;
    expect(childTool.sessionId).toBe(childStart.sessionId); expect(childTool.parentSessionId).toBe('parent');
    const cursorStart = normalizeHook('cursor', 'sessionStart', { workspace_roots: [root], conversation_id: 'conversation', session_id: 'conversation', generation_id: 'turn-a' }, root, now)!;
    const cursorNext = normalizeHook('cursor', 'preToolUse', { workspace_roots: [root], conversation_id: 'conversation', generation_id: 'turn-b' }, root, now)!;
    expect(cursorNext.sessionId).toBe(cursorStart.sessionId);
    const cursorChild = normalizeHook('cursor', 'subagentStart', { workspace_roots: [root], conversation_id: 'child-conversation', parent_conversation_id: 'conversation', subagent_id: 'worker-1' }, root, now)!;
    expect(cursorChild.parentSessionId).toBe('conversation'); expect(cursorChild.sessionId).not.toBe(cursorStart.sessionId);
    const cursorStop = normalizeHook('cursor', 'subagentStop', { workspace_roots: [root], conversation_id: 'child-conversation', parent_conversation_id: 'conversation', subagent_id: 'worker-1', summary: 'Checked child work.', status: 'completed' }, root, now)!;
    const state = seed(root), cursorSource = { ...source, provider: 'cursor' as const };
    for (const normalized of [cursorStart, cursorChild, cursorStop, cursorNext]) applyObservation(state, cursorSource, normalized, now);
    expect(state.agents).toHaveLength(2);
    expect(state.agents[0].activity).toBe('working'); expect(state.agents[1].activity).toBe('reporting');
    expect(state.handoffs).toHaveLength(1); expect(state.handoffs[0].agentId).toBe(state.agents[1].id);
    expect(normalizeHook('cursor', 'subagentStop', { workspace_roots: [root], conversation_id: 'conversation', subagent_type: 'explore', summary: 'Do not assign this to the parent' }, root, now)).toBeNull();
    expect(normalizeHook('copilot-cli', 'subagentStart', { cwd: root, sessionId: 'conversation', agentName: 'explore' }, root, now)).toBeNull();
    const a = normalizeHook('claude', 'SubagentStart', { cwd: root, session_id: 'a:b', agent_id: 'c' }, root, now)!;
    const b = normalizeHook('claude', 'SubagentStart', { cwd: root, session_id: 'a', agent_id: 'b:c' }, root, now)!;
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('separates sessions and child agents and does not accept a finished response', () => {
    const state = seed('C:\\projects\\fixture');
    applyObservation(state, source, event('session.start'), new Date().toISOString());
    applyObservation(state, source, event('turn.end', 2), new Date().toISOString());
    expect(state.agents[0].activity).toBe('idle'); expect(state.handoffs).toEqual([]); expect(state.manager.version).toBe(0);
    applyObservation(state, source, { ...event('session.start'), id: 'child-start', sessionId: 'child', parentSessionId: 'session-1' }, new Date().toISOString());
    expect(state.agents).toHaveLength(2); expect(state.agents[1].observation!.parentSessionId).toBe('session-1');
  });
  it('saves a sanitized report before walking and ignores late activity after a newer session end', () => {
    const state = seed('C:\\projects\\fixture');
    applyObservation(state, source, { ...event('turn.end'), summary: 'Changed login. api_key=fixture-sensitive https://name:password@example.test/path?secret=value', files: ['src/login.ts', '../escape.ts', '.env', 'C:\\secret'] }, new Date().toISOString());
    expect(state.agents[0].activity).toBe('reporting'); expect(state.agents[0].files).toEqual(['src/login.ts']);
    expect(state.handoffs[0].status).toBe('saved'); expect(state.handoffs[0].delivery).toBe('unsupported'); expect(state.manager.version).toBe(0);
    expect(JSON.stringify(state)).not.toContain('fixture-sensitive'); expect(JSON.stringify(state)).not.toContain('secret=value');
    applyObservation(state, source, event('session.end', 3), new Date().toISOString());
    applyObservation(state, source, event('tool.start', 2), new Date().toISOString());
    expect(state.agents[0].activity).toBe('offline');
  });
  it('maps native allowlisted metadata without reading prompts, tool arguments, or transcripts', () => {
    const input = { session_id: 'native-session', hook_event_name: 'Stop', cwd: 'C:\\projects\\fixture', last_assistant_message: 'Done. api_key=private-fixture', transcript_path: 'C:\\private\\auth.json', prompt: 'PRIVATE_PROMPT', tool_input: { command: 'SECRET_COMMAND' } };
    const output = normalizeHook('claude', 'Stop', input, 'C:\\projects\\fixture');
    expect(output?.kind).toBe('turn.end'); expect(output?.summary).toContain('[removed]');
    expect(JSON.stringify(output)).not.toContain('PRIVATE_PROMPT'); expect(JSON.stringify(output)).not.toContain('SECRET_COMMAND'); expect(JSON.stringify(output)).not.toContain('auth.json');
    expect(normalizeHook('claude', 'Stop', { ...input, cwd: 'C:\\outside' }, 'C:\\projects\\fixture')).toBeNull();
    expect(normalizeHook('copilot-cli', 'subagentStart', { sessionId: 'one', cwd: 'C:\\projects\\fixture', agentName: 'no-stable-id' }, 'C:\\projects\\fixture')).toBeNull();
    expect(redactEvidence('Bearer sk-abcdefghijklmnopqrstuvwxyz')).not.toContain('sk-');
  });
  it.each(['report', 'turn.end'] as const)('saves a late unseen %s exactly once without changing newer terminal activity or context', kind => {
    const state = seed('C:\\projects\\fixture'), now = '2026-09-14T12:00:03.000Z';
    applyObservation(state, source, { id: 'newer-end', sessionId: 'one', kind: 'session.end', sequence: 9, occurredAt: '2026-09-14T12:00:02.000Z' }, now);
    state.agents[0].observation!.freshness = 'stale';
    const before = structuredClone(state.agents[0]);
    const late: ObservationEvent = { id: 'older-report', sessionId: 'one', kind, sequence: 8, occurredAt: '2026-09-14T12:00:01.000Z', summary: 'Earlier evidence. api_key=fixture-private', files: ['old.ts'] };
    expect(applyObservation(state, source, late, now)).toBe('handoff.saved');
    expect(applyObservation(state, source, late, now)).toBe('observation.duplicate');
    expect(state.handoffs).toHaveLength(1); expect(state.handoffs[0]).toMatchObject({ status: 'saved', contextVersion: null, delivery: 'unsupported' });
    expect(state.workflow!.manager.queueReportIds).toEqual([state.handoffs[0].id]);
    expect(state.manager.version).toBe(0); expect(state.workflow!.manager.config.enabled).toBe(false);
    expect(state.agents[0]).toEqual(before);
    expect(JSON.stringify(state)).not.toContain('fixture-private');
  });
  it('keeps an ended session ended when a report has the same timestamp without ordering evidence', () => {
    const state = seed('C:\\projects\\fixture'), now = '2026-09-14T12:00:03.000Z';
    applyObservation(state, source, { id: 'end', sessionId: 'one', kind: 'session.end', occurredAt: now }, now);
    applyObservation(state, source, { id: 'report', sessionId: 'one', kind: 'report', occurredAt: now, summary: 'Equal-time evidence.' }, now);
    expect(state.agents[0].activity).toBe('offline'); expect(state.handoffs).toHaveLength(1);
  });
});

describe('observation delivery and setup', () => {
  it('keeps one active tool connection when concurrent setup requests finish credential protection together', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-observation-race-'));
    const root = join(directory, 'repo'); mkdirSync(root);
    const store = new Store(join(directory, 'town.sqlite'), seed(root));
    const secrets = new Map<string, string>();
    let arrivals = 0, release!: () => void;
    const bothProtected = new Promise<void>(resolve => { release = resolve; });
    const vault: CredentialVault = { available: true, put: async (id, value) => { secrets.set(id, value); if (++arrivals === 2) release(); await bothProtected; }, get: async id => secrets.get(id) ?? null, delete: async id => { secrets.delete(id); } };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    const api = registerObservationApi(app, { directory, vault, scoped: () => ({ ownerId: '101', store }), workspace: () => store });
    const create = () => app.inject({ method: 'POST', url: '/api/v1/workspaces/workspace-one/observation/connections', payload: { provider: 'claude', repoId: 'repo-one', label: 'Claude' } });
    try {
      const results = await Promise.all([create(), create()]);
      expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
      expect(api.registry.all()).toHaveLength(1); expect(secrets.size).toBe(1);
      expect(store.snapshot().state.observation!.connections).toHaveLength(1);
      const winner = api.registry.all()[0].connection.id;
      await app.inject({ method: 'POST', url: `/api/v1/workspaces/workspace-one/observation/connections/${winner}/revoke` });
      const replacement = await create();
      expect(replacement.statusCode).toBe(200); expect(api.registry.all()).toHaveLength(1);
      expect(api.registry.all()[0].connection.id).not.toBe(winner); expect(secrets.size).toBe(1);
      expect(store.snapshot().state.observation!.connections).toHaveLength(2);
    } finally { await api.close(); await app.close(); store.close(); clean(directory); }
  });

  it('requires connector authentication, deduplicates committed events, redacts fingerprints, and revokes immediately', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-observation-'));
    const root = join(directory, 'repo'); mkdirSync(root);
    const store = new Store(join(directory, 'town.sqlite'), seed(root));
    const secrets = new Map<string, string>();
    const vault: CredentialVault = { available: true, put: async (id, value) => { secrets.set(id, value); }, get: async id => secrets.get(id) ?? null, delete: async id => { secrets.delete(id); } };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 409).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    const api = registerObservationApi(app, { directory, vault, scoped: () => ({ ownerId: '101', store }), workspace: (owner, id) => { if (owner !== '101' || id !== 'workspace-one') throw new Error('Scope violation'); return store; } });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces/workspace-one/observation/connections', payload: { provider: 'claude', repoId: 'repo-one', label: 'Claude' } });
      expect(created.statusCode).toBe(200);
      const id = created.json().connection.id;
      const auth = `Bearer ${id}.${secrets.get(`observation-${id}`)}`;
      const payload = { events: [{ ...event('report'), summary: 'api_key=fixture-never-persist-raw' }] };
      expect((await app.inject({ method: 'POST', url: '/ingest/v1/events', payload })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/ingest/v1/events', headers: { authorization: auth }, payload })).json().accepted).toBe(1);
      expect((await app.inject({ method: 'POST', url: '/ingest/v1/events', headers: { authorization: auth }, payload })).json().duplicate).toBe(1);
      expect(store.snapshot().state.handoffs).toHaveLength(1);
      expect(store.snapshot().state.agents).toHaveLength(1);
      await app.inject({ method: 'POST', url: `/api/v1/workspaces/workspace-one/observation/connections/${id}/revoke` });
      expect((await app.inject({ method: 'POST', url: '/ingest/v1/events', headers: { authorization: auth }, payload })).statusCode).toBe(401);
      expect(store.snapshot().state.observation!.connections[0].status).toBe('revoked');
    } finally {
      await api.close(); await app.close(); store.close();
      expect(readFileSync(join(directory, 'town.sqlite')).includes(Buffer.from('fixture-never-persist-raw'))).toBe(false);
      clean(directory);
    }
  });

  it('preserves unrelated hooks, encrypts the backup, and removes only its exact entries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-hook-setup-'));
    const root = join(directory, 'repo'); mkdirSync(join(root, '.claude'), { recursive: true });
    const path = join(root, '.claude', 'settings.local.json');
    const original = { env: { SECRET: 'fixture-original-value' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } };
    writeFileSync(path, JSON.stringify(original));
    const saved = new Map<string, string>();
    const vault: CredentialVault = { available: true, put: async (id, value) => { saved.set(id, value); }, get: async id => saved.get(id) ?? null, delete: async id => { saved.delete(id); } };
    const record = { connection: source, workspaceId: 'workspace-one', ownerId: '101', repoPath: root };
    try {
      const setup = observationSetup(record, directory); expect(setup.config).not.toContain('fixture-original-value');
      await changeHooks(record, directory, vault);
      expect(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop).toHaveLength(2);
      expect([...saved.values()]).toContain(JSON.stringify(original));
      await changeHooks(record, directory, vault, true);
      const restored = JSON.parse(readFileSync(path, 'utf8'));
      expect(restored.env).toEqual(original.env); expect(restored.hooks.Stop).toEqual(original.hooks.Stop);
    } finally { clean(directory); }
  });

  it('preserves a user edit made while encrypting the hook backup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-hook-race-'));
    const root = join(directory, 'repo'); mkdirSync(join(root, '.claude'), { recursive: true });
    const path = join(root, '.claude', 'settings.local.json'); writeFileSync(path, '{"hooks":{}}');
    const concurrent = '{"hooks":{},"userChange":"preserve me"}';
    const vault: CredentialVault = { available: true, put: async () => { writeFileSync(path, concurrent); }, get: async () => null, delete: async () => {} };
    try {
      await expect(changeHooks({ connection: source, workspaceId: 'workspace-one', ownerId: '101', repoPath: root }, directory, vault)).rejects.toThrow('changed during setup');
      expect(readFileSync(path, 'utf8')).toBe(concurrent);
    } finally { clean(directory); }
  });
});
