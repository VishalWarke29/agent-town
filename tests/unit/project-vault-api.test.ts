import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from '@agent-town/contracts';
import { registerVaultApi } from '../../apps/service/src/vault-api';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';

let project: string, vaultDir: string, restoreDir: string, app: FastifyInstance, store: Store;
const prefix = '/api/v1/workspaces/fixture-workspace';
const repo = (localPath: string): Repository => ({ id: 'fixture-repo', name: 'Fixture Project', description: '', language: 'Unavailable', branch: 'main', color: '#ffffff', position: [0, 0], source: 'local', projectKind: 'folder', localPath });
const headers = { 'idempotency-key': 'a-fixed-test-key-00001' };

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'agent-town-vault-api-project-'));
  vaultDir = await mkdtemp(join(tmpdir(), 'agent-town-vault-api-store-'));
  restoreDir = await mkdtemp(join(tmpdir(), 'agent-town-vault-api-restore-'));
  await writeFile(join(project, 'app.js'), 'console.log(1);');
  store = new Store(':memory:', privateState({ id: 'fixture-workspace', name: 'Fixture', kind: 'personal' }));
  store.commit('seed', state => { state.repositories = [repo(project)]; return 'fixture.seed'; });
  app = Fastify({ logger: false });
  registerVaultApi(app, { scoped: () => store });
});
afterEach(async () => {
  await app.close(); store.close();
  for (const [path, prefixName] of [[project, 'agent-town-vault-api-project-'], [vaultDir, 'agent-town-vault-api-store-'], [restoreDir, 'agent-town-vault-api-restore-']] as const) {
    const resolved = resolve(path);
    if (!resolved.startsWith(`${resolve(tmpdir())}${sep}${prefixName}`)) throw new Error('Unsafe fixture cleanup');
    await rm(resolved, { recursive: true, force: true });
  }
});

describe('vault API', () => {
  it('reports disabled status until enabled, then walks scan → backup → list → restore-preview → restore', async () => {
    expect((await app.inject({ method: 'GET', url: `${prefix}/vault` })).json()).toMatchObject({ enabled: false });

    const enabled = await app.inject({ method: 'POST', url: `${prefix}/vault/enable`, payload: { directory: vaultDir }, headers });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, backend: { kind: 'local-folder' } });

    const scanned = await app.inject({ method: 'POST', url: `${prefix}/vault/scan`, payload: { repoId: 'fixture-repo' } });
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json().entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'app.js' })]));

    const backup = await app.inject({ method: 'POST', url: `${prefix}/vault/backup`, payload: { repoId: 'fixture-repo', paths: ['app.js'], passphrase: 'a very good passphrase' }, headers: { 'idempotency-key': 'a-fixed-test-key-00002' } });
    expect(backup.statusCode).toBe(200);
    expect(backup.json()).toMatchObject({ fileCount: 1 });

    const listed = await app.inject({ method: 'GET', url: `${prefix}/vault/backups` });
    expect(listed.json()).toEqual([expect.objectContaining({ repoId: 'fixture-repo', label: 'Fixture Project' })]);

    const preview = await app.inject({
      method: 'POST', url: `${prefix}/vault/backups/fixture-repo/restore-preview`,
      payload: { passphrase: 'a very good passphrase', destinationDirectory: restoreDir },
      headers: { 'idempotency-key': 'a-fixed-test-key-00003' },
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json();
    expect(previewBody).toMatchObject({
      operationId: expect.stringMatching(/^[0-9a-f]{64}$/),
      manifest: expect.objectContaining({ fileCount: 1 }),
      destination: restoreDir,
      destinationKind: 'empty-existing',
      expiresAt: expect.any(String),
    });

    const wrongPassphrase = await app.inject({
      method: 'POST', url: `${prefix}/vault/backups/fixture-repo/restore-preview`,
      payload: { passphrase: 'not the right one', destinationDirectory: restoreDir },
      headers: { 'idempotency-key': 'a-fixed-test-key-00004' },
    });
    expect(wrongPassphrase.statusCode).toBe(401);

    const restore = await app.inject({
      method: 'POST', url: `${prefix}/vault/backups/fixture-repo/restore`,
      payload: { operationId: previewBody.operationId, passphrase: 'a very good passphrase' },
      headers: { 'idempotency-key': 'a-fixed-test-key-00005' },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toMatchObject({ fileCount: 1 });
    expect(await readFile(join(restoreDir, 'app.js'), 'utf8')).toBe('console.log(1);');
  });

  it('requires an idempotency key for mutating actions and rejects a malformed body', async () => {
    const noKey = await app.inject({ method: 'POST', url: `${prefix}/vault/enable`, payload: { directory: vaultDir } });
    expect(noKey.statusCode).toBe(400);
    const badBody = await app.inject({ method: 'POST', url: `${prefix}/vault/enable`, payload: {}, headers });
    expect(badBody.statusCode).toBe(400);

    const previewNoKey = await app.inject({
      method: 'POST', url: `${prefix}/vault/backups/fixture-repo/restore-preview`,
      payload: { passphrase: 'a very good passphrase', destinationDirectory: restoreDir },
    });
    expect(previewNoKey.statusCode).toBe(400);
  });

  it('returns 409 with a suggested alternative folder when the chosen restore destination is not empty', async () => {
    await app.inject({ method: 'POST', url: `${prefix}/vault/enable`, payload: { directory: vaultDir }, headers });
    await app.inject({ method: 'POST', url: `${prefix}/vault/backup`, payload: { repoId: 'fixture-repo', paths: ['app.js'], passphrase: 'a very good passphrase' }, headers: { 'idempotency-key': 'a-fixed-test-key-00002' } });
    await writeFile(join(restoreDir, 'already-here.txt'), 'do not touch');

    const preview = await app.inject({
      method: 'POST', url: `${prefix}/vault/backups/fixture-repo/restore-preview`,
      payload: { passphrase: 'a very good passphrase', destinationDirectory: restoreDir },
      headers: { 'idempotency-key': 'a-fixed-test-key-00003' },
    });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().message).toMatch(/-restore/);
  });

  it('lists a restore operation as needing the passphrase before restore runs, and completed after it succeeds', async () => {
    await app.inject({ method: 'POST', url: `${prefix}/vault/enable`, payload: { directory: vaultDir }, headers });
    await app.inject({ method: 'POST', url: `${prefix}/vault/backup`, payload: { repoId: 'fixture-repo', paths: ['app.js'], passphrase: 'a very good passphrase' }, headers: { 'idempotency-key': 'a-fixed-test-key-00002' } });

    const preview = await app.inject({
      method: 'POST', url: `${prefix}/vault/backups/fixture-repo/restore-preview`,
      payload: { passphrase: 'a very good passphrase', destinationDirectory: restoreDir },
      headers: { 'idempotency-key': 'a-fixed-test-key-00003' },
    });
    const operationId = preview.json().operationId as string;

    const beforeRestore = await app.inject({ method: 'GET', url: `${prefix}/vault/backups/fixture-repo/restore-operations` });
    expect(beforeRestore.json()).toEqual([expect.objectContaining({ id: operationId, status: 'previewed', needsPassphrase: true, active: false })]);

    await app.inject({
      method: 'POST', url: `${prefix}/vault/backups/fixture-repo/restore`,
      payload: { operationId, passphrase: 'a very good passphrase' },
      headers: { 'idempotency-key': 'a-fixed-test-key-00005' },
    });

    const afterRestore = await app.inject({ method: 'GET', url: `${prefix}/vault/backups/fixture-repo/restore-operations` });
    expect(afterRestore.json()).toEqual([expect.objectContaining({ id: operationId, status: 'completed', needsPassphrase: false, active: false })]);
  });
});
