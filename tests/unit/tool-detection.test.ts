import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDetectionSnapshot, ToolDetectionReview, ToolDetectionApplyResponse } from '@agent-town/contracts';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { registerObservationApi } from '../../apps/service/src/observation/service';
import { IdentityError } from '../../apps/service/src/identity/types';

describe('combined tool-detection onboarding API', () => {
  const saved = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR, COPILOT_HOME: process.env.COPILOT_HOME };
  afterEach(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key as keyof typeof saved]; else process.env[key as keyof typeof saved] = value; });

  it('detects installed tools with real activity, previews the exact hook diff, and only writes it after apply', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-tool-detection-'));
    const codexHome = join(directory, 'codex'), repo = join(directory, 'repo'); mkdirSync(codexHome); mkdirSync(repo);
    const missingHome = join(directory, 'does-not-exist');
    process.env.CODEX_HOME = codexHome; process.env.CLAUDE_CONFIG_DIR = missingHome; process.env.CURSOR_CONFIG_DIR = missingHome; process.env.COPILOT_HOME = missingHome;
    const db = new Database(join(codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,cli_version TEXT)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('native-one', process.platform === 'win32' ? `\\\\?\\${repo}` : repo, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), 0, 'fixture');
    db.close();
    const state = privateState({ id: 'onboarding-workspace', name: 'Fixture', kind: 'personal' });
    state.discovery!.roots = [repo];
    state.repositories = [{ id: 'project-one', name: 'Project', source: 'local', localPath: repo, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [0, 0] }];
    const store = new Store(':memory:', state);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    const secrets = new Map<string, string>();
    const api = registerObservationApi(app, { directory, vault: { available: true, async put(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id) ?? null; }, async delete(id) { secrets.delete(id); } },
      scoped: () => ({ ownerId: 'owner', store }), workspace: () => store });
    const prefix = '/api/v1/workspaces/onboarding-workspace/observation/tool-detection';
    try {
      const before = await app.inject({ method: 'GET', url: `${prefix}?repoId=project-one` });
      expect(before.statusCode).toBe(200);
      const snapshot: ToolDetectionSnapshot = before.json();
      expect(snapshot.tools).toMatchObject([
        { provider: 'codex', state: 'found', sessionCount: 1 },
        { provider: 'claude', state: 'not-installed', sessionCount: null },
        { provider: 'cursor', state: 'not-installed', sessionCount: null },
        { provider: 'copilot-cli', state: 'not-installed', sessionCount: null },
      ]);

      const missingTool = await app.inject({ method: 'POST', url: `${prefix}/review`, payload: { repoId: 'project-one', providers: ['cursor'] } });
      expect(missingTool.statusCode).toBe(409);

      const reviewed = await app.inject({ method: 'POST', url: `${prefix}/review`, payload: { repoId: 'project-one', providers: ['codex'] } });
      expect(reviewed.statusCode).toBe(200);
      const review: ToolDetectionReview = reviewed.json();
      expect(review.items).toHaveLength(1);
      const [item] = review.items;
      expect(item.provider).toBe('codex');
      expect(item.configPath.replace(/\\/g, '/')).toContain('.codex/hooks.json');
      expect(item.config).toContain('hook-bridge.cjs');
      // Codex is the one tool that needs per-hook trust, and the review says so before anything is written.
      expect(item.nextStep).toContain('/hooks');
      expect(review.activeProviders).toEqual([]);
      // Review only computes the diff text; nothing is registered or written yet.
      expect(store.snapshot().state.observation?.connections ?? []).toHaveLength(0);
      expect(api.registry.all()).toHaveLength(0);
      expect(() => readFileSync(join(repo, '.codex', 'hooks.json'))).toThrow();

      const applied = await app.inject({ method: 'POST', url: `${prefix}/apply`, payload: { repoId: 'project-one', items: [{ provider: item.provider, connectionId: item.connectionId }] } });
      expect(applied.statusCode).toBe(200);
      const response: ToolDetectionApplyResponse = applied.json();
      expect(response.results).toMatchObject([{ provider: 'codex', connectionId: item.connectionId, applied: true }]);
      const written = JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'));
      expect(JSON.stringify(written)).toContain('hook-bridge.cjs');
      // What was reviewed is exactly what was written.
      expect(written).toEqual(JSON.parse(item.config));
      expect(response.results[0]!.nextStep).toContain('/hooks');
      expect(store.snapshot().state.observation?.connections).toMatchObject([{ id: item.connectionId, provider: 'codex', repoId: 'project-one' }]);
      expect(api.registry.all()).toHaveLength(1);

      const after = await app.inject({ method: 'GET', url: `${prefix}?repoId=project-one` });
      const afterSnapshot: ToolDetectionSnapshot = after.json();
      expect(afterSnapshot.tools.find(tool => tool.provider === 'codex')).toMatchObject({ state: 'connected', connectionId: item.connectionId, connectionStatus: 'unverified' });

      // codex now has an active connection, so review refuses to prepare a second one for it —
      // catching this up front instead of letting apply reject it later with a less clear error.
      const secondReview = await app.inject({ method: 'POST', url: `${prefix}/review`, payload: { repoId: 'project-one', providers: ['codex'] } });
      expect(secondReview.statusCode).toBe(409);
    } finally {
      await api.close(); await app.close(); store.close();
      if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-tool-detection-`)) throw new Error('Unsafe fixture cleanup');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported provider from the auto-detect surface', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-tool-detection-'));
    const repo = join(directory, 'repo'); mkdirSync(repo);
    const state = privateState({ id: 'onboarding-workspace-2', name: 'Fixture', kind: 'personal' });
    state.discovery!.roots = [repo];
    state.repositories = [{ id: 'project-one', name: 'Project', source: 'local', localPath: repo, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [0, 0] }];
    const store = new Store(':memory:', state);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    const api = registerObservationApi(app, { directory, vault: { available: true, get: async () => null, put: async () => {}, delete: async () => {} },
      scoped: () => ({ ownerId: 'owner', store }), workspace: () => store });
    const prefix = '/api/v1/workspaces/onboarding-workspace-2/observation/tool-detection';
    try {
      const rejected = await app.inject({ method: 'POST', url: `${prefix}/review`, payload: { repoId: 'project-one', providers: ['copilot-vscode'] } });
      expect(rejected.statusCode).toBe(400);
      const missingRepo = await app.inject({ method: 'GET', url: `${prefix}?repoId=unknown-repo` });
      expect(missingRepo.statusCode).toBe(400);
    } finally {
      await api.close(); await app.close(); store.close();
      if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-tool-detection-`)) throw new Error('Unsafe fixture cleanup');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('applies one detected tool and reports the other as failed within a single multi-item request, without letting either affect the other', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-tool-detection-'));
    const codexHome = join(directory, 'codex'), repo = join(directory, 'repo'); mkdirSync(codexHome); mkdirSync(repo);
    const missingHome = join(directory, 'does-not-exist');
    process.env.CODEX_HOME = codexHome; process.env.CLAUDE_CONFIG_DIR = missingHome; process.env.CURSOR_CONFIG_DIR = missingHome; process.env.COPILOT_HOME = missingHome;
    const state = privateState({ id: 'onboarding-workspace-partial', name: 'Fixture', kind: 'personal' });
    state.discovery!.roots = [repo];
    state.repositories = [{ id: 'project-one', name: 'Project', source: 'local', localPath: repo, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [0, 0] }];
    const store = new Store(':memory:', state);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    const secrets = new Map<string, string>();
    const api = registerObservationApi(app, { directory, vault: { available: true, async put(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id) ?? null; }, async delete(id) { secrets.delete(id); } },
      scoped: () => ({ ownerId: 'owner', store }), workspace: () => store });
    const prefix = '/api/v1/workspaces/onboarding-workspace-partial/observation/tool-detection';
    try {
      const reviewed = await app.inject({ method: 'POST', url: `${prefix}/review`, payload: { repoId: 'project-one', providers: ['codex'] } });
      const [codexItem] = (reviewed.json() as ToolDetectionReview).items;
      // claude was never reviewed (its profile isn't detected), so this connectionId is fabricated —
      // exactly the shape a stale/racing client could send in a real two-tool batch.
      const applied = await app.inject({ method: 'POST', url: `${prefix}/apply`, payload: { repoId: 'project-one', items: [
        { provider: 'codex', connectionId: codexItem.connectionId },
        { provider: 'claude', connectionId: '11111111-1111-4111-8111-111111111111' },
      ] } });
      expect(applied.statusCode).toBe(200);
      const response: ToolDetectionApplyResponse = applied.json();
      expect(response.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: 'codex', applied: true }),
        expect.objectContaining({ provider: 'claude', applied: false }),
      ]));
      // Only the successful tool is actually persisted; the failed one left nothing behind.
      const connections = store.snapshot().state.observation?.connections ?? [];
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({ provider: 'codex', id: codexItem.connectionId });
      expect(api.registry.all()).toHaveLength(1);
    } finally {
      await api.close(); await app.close(); store.close();
      if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-tool-detection-`)) throw new Error('Unsafe fixture cleanup');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('a duplicate apply for the same reviewed tool fails safely and does not revoke the first, successful connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-tool-detection-'));
    const codexHome = join(directory, 'codex'), repo = join(directory, 'repo'); mkdirSync(codexHome); mkdirSync(repo);
    const missingHome = join(directory, 'does-not-exist');
    process.env.CODEX_HOME = codexHome; process.env.CLAUDE_CONFIG_DIR = missingHome; process.env.CURSOR_CONFIG_DIR = missingHome; process.env.COPILOT_HOME = missingHome;
    const state = privateState({ id: 'onboarding-workspace-retry', name: 'Fixture', kind: 'personal' });
    state.discovery!.roots = [repo];
    state.repositories = [{ id: 'project-one', name: 'Project', source: 'local', localPath: repo, description: '', branch: 'Unavailable', language: '', color: '#888888', position: [0, 0] }];
    const store = new Store(':memory:', state);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof IdentityError ? error.statusCode : 500).send({ message: error instanceof Error ? error.message : 'Request failed' }));
    const secrets = new Map<string, string>();
    const api = registerObservationApi(app, { directory, vault: { available: true, async put(id, value) { secrets.set(id, value); }, async get(id) { return secrets.get(id) ?? null; }, async delete(id) { secrets.delete(id); } },
      scoped: () => ({ ownerId: 'owner', store }), workspace: () => store });
    const prefix = '/api/v1/workspaces/onboarding-workspace-retry/observation/tool-detection';
    try {
      const reviewed = await app.inject({ method: 'POST', url: `${prefix}/review`, payload: { repoId: 'project-one', providers: ['codex'] } });
      const [item] = (reviewed.json() as ToolDetectionReview).items;
      const first = await app.inject({ method: 'POST', url: `${prefix}/apply`, payload: { repoId: 'project-one', items: [{ provider: item.provider, connectionId: item.connectionId }] } });
      expect((first.json() as ToolDetectionApplyResponse).results).toMatchObject([{ applied: true }]);
      const tokenAfterFirst = secrets.get(`observation-${item.connectionId}`);
      expect(tokenAfterFirst).toBeDefined();

      // A retry with the SAME reviewed connectionId (a client timeout/double-click) must not
      // destroy the connection the first call already created.
      const retry = await app.inject({ method: 'POST', url: `${prefix}/apply`, payload: { repoId: 'project-one', items: [{ provider: item.provider, connectionId: item.connectionId }] } });
      expect(retry.statusCode).toBe(200);
      const retryResponse: ToolDetectionApplyResponse = retry.json();
      expect(retryResponse.results).toMatchObject([{ applied: false }]);

      const connections = store.snapshot().state.observation?.connections ?? [];
      expect(connections).toHaveLength(1);
      expect(connections[0]!.status).not.toBe('revoked');
      expect(api.registry.all()).toHaveLength(1);
      expect(api.registry.get(item.connectionId)?.connection.status).not.toBe('revoked');
      expect(secrets.get(`observation-${item.connectionId}`)).toBe(tokenAfterFirst);
    } finally {
      await api.close(); await app.close(); store.close();
      if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-tool-detection-`)) throw new Error('Unsafe fixture cleanup');
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
