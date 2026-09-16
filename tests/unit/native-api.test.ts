import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { registerObservationApi } from '../../apps/service/src/observation/service';
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
