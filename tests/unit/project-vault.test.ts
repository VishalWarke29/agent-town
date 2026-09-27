import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from '@agent-town/contracts';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { scanProject } from '../../apps/service/src/vault/scan';
import { findSecrets } from '../../apps/service/src/vault/secrets';
import { decryptEnvelope, deriveKey, encryptEnvelope, newSalt } from '../../apps/service/src/vault/crypto';
import { VaultService } from '../../apps/service/src/vault/service';
import { VaultError } from '../../apps/service/src/vault/errors';

let project: string, vault: string, restoreDir: string, store: Store;
const workspaceId = 'fixture-workspace';
const repo = (localPath: string): Repository => ({ id: 'fixture-repo', name: 'Fixture Project', description: '', language: 'Unavailable', branch: 'main', color: '#ffffff', position: [0, 0], source: 'local', projectKind: 'folder', localPath });

const safeRemove = async (path: string, prefix: string) => {
  const resolved = resolve(path);
  if (!resolved.startsWith(`${resolve(tmpdir())}${sep}${prefix}`)) throw new Error('Unsafe fixture cleanup');
  await rm(resolved, { recursive: true, force: true });
};

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'agent-town-vault-project-'));
  vault = await mkdtemp(join(tmpdir(), 'agent-town-vault-store-'));
  restoreDir = await mkdtemp(join(tmpdir(), 'agent-town-vault-restore-'));
  store = new Store(':memory:', privateState({ id: workspaceId, name: 'Fixture', kind: 'personal' }));
});
afterEach(async () => {
  store.close();
  await safeRemove(project, 'agent-town-vault-project-');
  await safeRemove(vault, 'agent-town-vault-store-');
  await safeRemove(restoreDir, 'agent-town-vault-restore-');
});

describe('scanProject', () => {
  it('flags gitignored files without skipping them, and always prunes build/dependency output', async () => {
    await mkdir(join(project, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(project, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
    await writeFile(join(project, '.gitignore'), 'local-cache/\n.env\n');
    await mkdir(join(project, 'local-cache'), { recursive: true });
    await writeFile(join(project, 'local-cache', 'output.txt'), 'compiled');
    await writeFile(join(project, '.env'), 'FLAG=1');
    await writeFile(join(project, 'README.md'), '# Fixture');
    const result = await scanProject(project, 'fixture-repo');
    const byPath = new Map(result.entries.map(entry => [entry.path, entry]));
    expect(byPath.has('node_modules/left-pad/index.js')).toBe(false);
    expect(byPath.get('local-cache/output.txt')).toMatchObject({ gitignored: true });
    expect(byPath.get('.env')).toMatchObject({ gitignored: true, sensitiveName: true });
    expect(byPath.get('README.md')).toMatchObject({ gitignored: false, sensitiveName: false });
  });

  it('finds a real-looking secret in a candidate file and reports its line, never the full value', async () => {
    await writeFile(join(project, 'notes.txt'), 'first line\nAWS_KEY=AKIAABCDEFGHIJKLMNOP\nlast line\n');
    const result = await scanProject(project, 'fixture-repo');
    expect(result.findings).toEqual([expect.objectContaining({ path: 'notes.txt', line: 2, ruleId: 'aws-access-key-id' })]);
    expect(result.findings[0]!.redactedSnippet).not.toContain('ABCDEFGHIJKLMNOP');
  });
});

describe('findSecrets', () => {
  it('ignores obvious placeholder text', () => {
    expect(findSecrets('sample.env', 'API_KEY=your_api_key_here')).toEqual([]);
  });
  it('detects a private key block', () => {
    expect(findSecrets('id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----')).toEqual([expect.objectContaining({ ruleId: 'private-key-block' })]);
  });
});

describe('vault envelope encryption', () => {
  it('round-trips plaintext and fails closed on the wrong key', async () => {
    const salt = newSalt();
    const key = await deriveKey('correct horse battery staple', salt);
    const wrongKey = await deriveKey('a different passphrase', salt);
    const envelope = encryptEnvelope(key, Buffer.from('secret file contents'));
    expect(decryptEnvelope(key, envelope).toString('utf8')).toBe('secret file contents');
    expect(() => decryptEnvelope(wrongKey, envelope)).toThrow();
  });
});

describe('VaultService end to end (local-folder backend)', () => {
  beforeEach(() => { store.commit('seed', state => { state.repositories = [repo(project)]; return 'fixture.seed'; }); });

  it('backs up only the requested files, blocks a file with a real secret, and restores byte-identical content', async () => {
    await writeFile(join(project, 'app.js'), 'console.log("hello vault");');
    await writeFile(join(project, 'notes.bin'), Buffer.from([0, 1, 2, 253, 254, 255]));
    await writeFile(join(project, '.env'), 'AWS_KEY=AKIAABCDEFGHIJKLMNOP\n');
    const service = new VaultService();

    const status = service.enable(store, vault, 'enable-1');
    expect(status.enabled).toBe(true);

    const scanned = await service.scan(store, 'fixture-repo');
    const paths = scanned.entries.map(entry => entry.path);
    expect(paths).toEqual(expect.arrayContaining(['app.js', 'notes.bin', '.env']));

    await expect(service.backup(store, 'fixture-repo', paths, 'a very good passphrase', 'backup-blocked'))
      .rejects.toMatchObject({ code: 'secret-found', findings: [expect.objectContaining({ path: '.env' })] });

    const safePaths = paths.filter(path => path !== '.env');
    const manifest = await service.backup(store, 'fixture-repo', safePaths, 'a very good passphrase', 'backup-1');
    expect(manifest.fileCount).toBe(2);
    expect(manifest.entries.map(entry => entry.path).sort()).toEqual(['app.js', 'notes.bin']);

    // Prove it is actually encrypted at rest, not just copied: the plaintext string must not appear anywhere on disk.
    const rawOnDisk = await readFile(join(vault, workspaceId, 'fixture-repo', 'header.json'), 'utf8');
    expect(rawOnDisk).not.toContain('hello vault');

    const backups = await service.listBackups(store);
    expect(backups).toEqual([expect.objectContaining({ repoId: 'fixture-repo', label: 'Fixture Project', fileCount: 2 })]);

    await expect(service.restorePreview(store, 'fixture-repo', 'the wrong passphrase', restoreDir, 'preview-wrong-pass')).rejects.toMatchObject({ code: 'invalid-passphrase' });
    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-1');
    expect(preview.manifest.entries.map(entry => entry.path).sort()).toEqual(['app.js', 'notes.bin']);
    expect(preview.destinationKind).toBe('empty-existing');
    expect(preview.destination).toBe(restoreDir);
    expect(typeof preview.operationId).toBe('string');
    expect(preview.operationId).toMatch(/^[0-9a-f]{64}$/);

    const restored = await service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-1');
    expect(restored.fileCount).toBe(2);
    expect(await readFile(join(restoreDir, 'app.js'), 'utf8')).toBe('console.log("hello vault");');
    expect(await readFile(join(restoreDir, 'notes.bin'))).toEqual(Buffer.from([0, 1, 2, 253, 254, 255]));

    const repoStatus = service.status(store).repositories.find(item => item.repoId === 'fixture-repo');
    expect(repoStatus).toMatchObject({ fileCount: 2 });
    expect(repoStatus!.lastBackupAt).not.toBeNull();
    expect(repoStatus!.lastRestoreAt).not.toBeNull();

    const operations = service.restoreOperations(store, 'fixture-repo');
    expect(operations).toEqual([expect.objectContaining({ id: preview.operationId, status: 'completed', needsPassphrase: false, active: false })]);
  });

  it('refuses to back up before the vault is enabled, and refuses a re-selection that no longer matches the project', async () => {
    const service = new VaultService();
    await expect(service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-x')).rejects.toMatchObject({ code: 'not-enabled' });
    service.enable(store, vault, 'enable-2');
    await expect(service.backup(store, 'fixture-repo', ['does-not-exist.txt'], 'a very good passphrase', 'backup-y')).rejects.toMatchObject({ code: 'invalid-selection' });
  });

  it('rejects a vault directory that is not a safe local path', () => {
    const service = new VaultService();
    expect(() => service.enable(store, '\\\\server\\share', 'enable-3')).toThrow(VaultError);
  });

  it('refuses a nonempty restore destination, suggests a sibling folder, and never touches the existing file', async () => {
    await writeFile(join(project, 'app.js'), 'console.log("hello vault");');
    const service = new VaultService();
    service.enable(store, vault, 'enable-4');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-4');

    await writeFile(join(restoreDir, 'unrelated.txt'), 'do not touch me');
    const error = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-nonempty')
      .catch(cause => cause as VaultError);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('destination-not-empty');
    expect((error as VaultError).message).toMatch(/restore/);
    expect(await readFile(join(restoreDir, 'unrelated.txt'), 'utf8')).toBe('do not touch me');
  });

  it('refuses to restore once the backup changed after the preview was reviewed, writing nothing to the destination', async () => {
    await writeFile(join(project, 'app.js'), 'first version');
    const service = new VaultService();
    service.enable(store, vault, 'enable-5');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-5a');
    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-5');

    await writeFile(join(project, 'app.js'), 'second version, totally different content');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-5b');

    await expect(service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-5'))
      .rejects.toMatchObject({ code: 'operation-changed' });
    expect(await readdir(restoreDir)).toEqual([]);
  });

  it('refuses to restore once the destination stopped being empty after the preview, without touching the foreign file', async () => {
    await writeFile(join(project, 'app.js'), 'console.log(1);');
    const service = new VaultService();
    service.enable(store, vault, 'enable-6');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-6');
    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-6');

    await writeFile(join(restoreDir, 'someone-else-put-this-here.txt'), 'surprise');
    await expect(service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-6'))
      .rejects.toMatchObject({ code: 'operation-changed' });
    expect(await readdir(restoreDir)).toEqual(['someone-else-put-this-here.txt']);
  });

  it('refuses to restore a backup with a corrupted encrypted file, leaving the destination with no files at all', async () => {
    await writeFile(join(project, 'app.js'), 'console.log("still here");');
    await writeFile(join(project, 'notes.bin'), Buffer.from([9, 8, 7, 6]));
    const service = new VaultService();
    service.enable(store, vault, 'enable-7');
    await service.backup(store, 'fixture-repo', ['app.js', 'notes.bin'], 'a very good passphrase', 'backup-7');

    const filesDir = join(vault, workspaceId, 'fixture-repo', 'files');
    const [firstFile] = await readdir(filesDir);
    const encPath = join(filesDir, firstFile!);
    const corrupted = Buffer.from(await readFile(encPath));
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
    await writeFile(encPath, corrupted);

    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-7');
    await expect(service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-7')).rejects.toThrow();
    expect(await readdir(restoreDir)).toEqual([]);
    expect(service.restoreOperations(store, 'fixture-repo').find(op => op.id === preview.operationId)).toMatchObject({ status: 'failed' });
  });

  it('reconciles a duplicate or lost-response retry to the one completed operation without rewriting files', async () => {
    await writeFile(join(project, 'app.js'), 'console.log("dup");');
    const service = new VaultService();
    service.enable(store, vault, 'enable-8');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-8');
    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-8');
    const first = await service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-8a');
    const statBefore = await stat(join(restoreDir, 'app.js'));

    const second = await service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-8b');
    const statAfter = await stat(join(restoreDir, 'app.js'));

    expect(second).toEqual(first);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(await readFile(join(restoreDir, 'app.js'), 'utf8')).toBe('console.log("dup");');
  });

  it('never persists the passphrase anywhere in the saved vault state', async () => {
    await writeFile(join(project, 'app.js'), 'x');
    const service = new VaultService();
    service.enable(store, vault, 'enable-9');
    const passphrase = 'a very unusual and unique test passphrase 12345';
    await service.backup(store, 'fixture-repo', ['app.js'], passphrase, 'backup-9');
    const preview = await service.restorePreview(store, 'fixture-repo', passphrase, restoreDir, 'preview-9');
    await service.restore(store, 'fixture-repo', preview.operationId, passphrase, 'restore-9');
    expect(JSON.stringify(store.snapshot().state.vault)).not.toContain(passphrase);
  });

  it('refuses to resume an expired restore preview', async () => {
    await writeFile(join(project, 'app.js'), 'x');
    const service = new VaultService();
    service.enable(store, vault, 'enable-10');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-10');
    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-10');

    store.commit('force-expire-10', current => {
      const op = current.vault!.restoreOperations![preview.operationId]!;
      op.expiresAt = new Date(Date.now() - 1000).toISOString();
      return 'test.force-expire';
    });

    await expect(service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-10'))
      .rejects.toMatchObject({ code: 'operation-expired' });
  });

  it('refuses a concurrent duplicate restore call for the same operation, settling exactly one as busy', async () => {
    await writeFile(join(project, 'app.js'), 'x'.repeat(10_000));
    const service = new VaultService();
    service.enable(store, vault, 'enable-11');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-11');
    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-11');

    const results = await Promise.allSettled([
      service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-11a'),
      service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-11b'),
    ]);
    const busy = results.filter(result => result.status === 'rejected' && (result.reason as VaultError).code === 'operation-busy');
    expect(busy).toHaveLength(1);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  });

  it('resumes a restore left mid-publish by an earlier interrupted attempt: already-published files are trusted and not rewritten, and the rest complete', async () => {
    await writeFile(join(project, 'app.js'), 'console.log("first file");');
    await writeFile(join(project, 'notes.bin'), Buffer.from([10, 20, 30]));
    const service = new VaultService();
    service.enable(store, vault, 'enable-12');
    await service.backup(store, 'fixture-repo', ['app.js', 'notes.bin'], 'a very good passphrase', 'backup-12');
    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-12');

    // Simulate an earlier attempt that published app.js, then was interrupted (crash/restart) before
    // publishing notes.bin — the real code path this proves is restore()'s own resume logic (reads
    // op.publishedPaths, verifies the already-published file, and stages/publishes only what remains),
    // not a fresh full restore.
    await writeFile(join(restoreDir, 'app.js'), 'console.log("first file");');
    store.commit('simulate-partial-12', current => {
      const op = current.vault!.restoreOperations![preview.operationId]!;
      op.status = 'publishing'; op.publishedPaths = ['app.js'];
      return 'test.simulate-partial';
    });
    const appStatBefore = await stat(join(restoreDir, 'app.js'));

    const result = await service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-12');
    expect(result.fileCount).toBe(2);
    expect(await readFile(join(restoreDir, 'notes.bin'))).toEqual(Buffer.from([10, 20, 30]));
    expect((await stat(join(restoreDir, 'app.js'))).mtimeMs).toBe(appStatBefore.mtimeMs);
    expect(service.restoreOperations(store, 'fixture-repo').find(op => op.id === preview.operationId)).toMatchObject({ status: 'completed', publishedPaths: expect.arrayContaining(['app.js', 'notes.bin']) });
  });

  it('refuses to resume when an already-published file no longer matches the backup by content, even though its size is unchanged (not just a stat/size check)', async () => {
    await writeFile(join(project, 'app.js'), 'console.log("original");');
    await writeFile(join(project, 'notes.bin'), Buffer.from([1, 2, 3]));
    const service = new VaultService();
    service.enable(store, vault, 'enable-13');
    await service.backup(store, 'fixture-repo', ['app.js', 'notes.bin'], 'a very good passphrase', 'backup-13');
    const preview = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'preview-13');

    // Same byte length as the real backed-up content, but different bytes — a size-only check would
    // wrongly treat this as intact and still trust it as "already published".
    const tampered = 'console.log("EVIL!!!!!");'.slice(0, 'console.log("original");'.length);
    expect(tampered.length).toBe('console.log("original");'.length);
    await writeFile(join(restoreDir, 'app.js'), tampered);
    store.commit('simulate-partial-13', current => {
      const op = current.vault!.restoreOperations![preview.operationId]!;
      op.status = 'publishing'; op.publishedPaths = ['app.js'];
      return 'test.simulate-partial';
    });

    await expect(service.restore(store, 'fixture-repo', preview.operationId, 'a very good passphrase', 'restore-13')).rejects.toMatchObject({ code: 'operation-changed' });
    expect(await readFile(join(restoreDir, 'app.js'), 'utf8')).toBe(tampered);
    expect(await readdir(restoreDir)).toEqual(['app.js']);
  });

  it('refuses to reuse an idempotency key for backup against a genuinely different file selection, instead of silently leaving the real new backup unrepresented in the durable status', async () => {
    await writeFile(join(project, 'a.js'), 'a');
    await writeFile(join(project, 'b.js'), 'b');
    const service = new VaultService();
    service.enable(store, vault, 'enable-14');
    await service.backup(store, 'fixture-repo', ['a.js'], 'a very good passphrase', 'shared-key-14');
    await expect(service.backup(store, 'fixture-repo', ['b.js'], 'a very good passphrase', 'shared-key-14')).rejects.toThrow(/already used for a different command/);
  });

  it('refuses to reuse an idempotency key for restore-preview against a genuinely different destination, instead of silently returning a stale binding', async () => {
    await writeFile(join(project, 'app.js'), 'x');
    const service = new VaultService();
    service.enable(store, vault, 'enable-15');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-15');
    await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'shared-key-15');
    const otherDir = await mkdtemp(join(tmpdir(), 'agent-town-vault-restore-'));
    try {
      await expect(service.restorePreview(store, 'fixture-repo', 'a very good passphrase', otherDir, 'shared-key-15')).rejects.toThrow(/already used for a different command/);
    } finally { await safeRemove(otherDir, 'agent-town-vault-restore-'); }
  });

  it('scopes the busy/concurrency lock by workspace: two different workspaces reusing the same operation id never block each other', async () => {
    await writeFile(join(project, 'app.js'), 'x'.repeat(10_000));
    const service = new VaultService();
    service.enable(store, vault, 'enable-16');
    await service.backup(store, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-16');
    const previewA = await service.restorePreview(store, 'fixture-repo', 'a very good passphrase', restoreDir, 'shared-cross-workspace-key');

    const storeB = new Store(':memory:', privateState({ id: 'fixture-workspace-b', name: 'Fixture B', kind: 'personal' }));
    const restoreDirB = await mkdtemp(join(tmpdir(), 'agent-town-vault-restore-'));
    try {
      storeB.commit('seed-b', state => { state.repositories = [repo(project)]; return 'fixture.seed'; });
      service.enable(storeB, vault, 'enable-16b');
      await service.backup(storeB, 'fixture-repo', ['app.js'], 'a very good passphrase', 'backup-16b');
      const previewB = await service.restorePreview(storeB, 'fixture-repo', 'a very good passphrase', restoreDirB, 'shared-cross-workspace-key');
      // The same client-supplied idempotency key across two independent, private workspaces deterministically
      // yields the same operation id — this must never let one workspace's restore make the other "busy".
      expect(previewB.operationId).toBe(previewA.operationId);

      const results = await Promise.allSettled([
        service.restore(store, 'fixture-repo', previewA.operationId, 'a very good passphrase', 'restore-16a'),
        service.restore(storeB, 'fixture-repo', previewB.operationId, 'a very good passphrase', 'restore-16b'),
      ]);
      expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    } finally {
      storeB.close();
      await safeRemove(restoreDirB, 'agent-town-vault-restore-');
    }
  });
});
