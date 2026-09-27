import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { VaultBackupSummary, VaultManifest, VaultRestoreOperationRecord, VaultRestoreOperationStatus, VaultRestoreOperationView, VaultRestorePreviewResult, VaultScanResult, VaultStatus } from '@agent-town/contracts';
import type { Store } from '../store.js';
import { canonicalizeRoot, checkedPath, isWithin, pathKey } from '../discovery/paths.js';
import { decryptEnvelope, deriveKey, encryptEnvelope, newSalt, SCRYPT_N, SCRYPT_P, SCRYPT_R } from './crypto.js';
import { listVaults, readFileEnvelope, readHeader, readManifestEnvelope, removeRestoreStaging, resetRestoreStaging, suggestRestoreSibling, validateRestoreDestination, validateVaultDirectory, writeRepoVault, type RepoVaultHeader } from './backend.js';
import { scanProject } from './scan.js';
import { VaultError } from './errors.js';

const MAX_BACKUP_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const RESTORE_OPERATION_TTL_MS = 30 * 60 * 1000;
const MAX_RESTORE_OPERATIONS_PER_REPO = 5;
const PUBLISH_CHECKPOINT_EVERY = 25;
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const storagePathName = (relativePath: string) => `${createHash('sha256').update(relativePath).digest('hex')}.enc`;

/** In-memory, per-process record of restore operations currently executing. Empty again after any
 * service restart — that is the whole point: `active`/`needsPassphrase` (see restoreOperations below)
 * distinguish a genuinely-running restore from one merely left mid-flight by a crash or a restart. */
const activeRestoreOperations = new Set<string>();

/** Reads the same already-checked path as raw bytes (checkedPath's own utf8 metadata reader would
 * corrupt binary content), re-verifying size against the scan that selected it. */
async function rawFileBytes(path: string, root: string, expectedSize: number): Promise<Buffer> {
  const verified = await checkedPath(path, [root]);
  const handle = await open(verified, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1 || stat.size !== expectedSize) throw new VaultError('invalid-selection');
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new VaultError('invalid-selection');
    return buffer;
  } finally { await handle.close(); }
}

export class VaultService {
  status(store: Store): VaultStatus {
    const state = store.snapshot().state.vault;
    return {
      enabled: !!state?.backend,
      backend: state?.backend ?? null,
      repositories: Object.entries(state?.repositories ?? {}).map(([repoId, status]) => ({ repoId, ...status })),
    };
  }

  enable(store: Store, directory: string, sourceId: string): VaultStatus {
    const validated = validateVaultDirectory(directory);
    // Content-derived fingerprint (matching app.ts's own convention for idempotent commands): a reused
    // Idempotency-Key with a genuinely different directory is rejected, not silently deduped away.
    store.commit(sourceId, state => {
      state.vault = { backend: { kind: 'local-folder', directory: validated }, repositories: state.vault?.repositories ?? {} };
      return 'vault.enabled';
    }, validated);
    return this.status(store);
  }

  async scan(store: Store, repoId: string): Promise<VaultScanResult> {
    const repo = store.snapshot().state.repositories.find(item => item.id === repoId);
    if (!repo?.localPath) throw new VaultError('repo-not-found');
    return scanProject(await canonicalizeRoot(repo.localPath), repoId);
  }

  async backup(store: Store, repoId: string, paths: string[], passphrase: string, sourceId: string): Promise<VaultManifest> {
    const state = store.snapshot().state;
    const backend = state.vault?.backend;
    if (!backend) throw new VaultError('not-enabled');
    const repo = state.repositories.find(item => item.id === repoId);
    if (!repo?.localPath) throw new VaultError('repo-not-found');
    const root = await canonicalizeRoot(repo.localPath);
    const fresh = await scanProject(root, repoId);
    const byPath = new Map(fresh.entries.map(entry => [entry.path, entry]));
    const requested = [...new Set(paths)];
    if (requested.some(path => !byPath.has(path))) throw new VaultError('invalid-selection');
    const blocking = fresh.findings.filter(finding => requested.includes(finding.path));
    if (blocking.length) throw new VaultError('secret-found', undefined, blocking);
    let totalBytes = 0;
    for (const path of requested) totalBytes += byPath.get(path)!.sizeBytes;
    if (totalBytes > MAX_BACKUP_TOTAL_BYTES) throw new VaultError('backup-limit');

    const salt = newSalt();
    const key = await deriveKey(passphrase, salt);
    const files: { storageName: string; envelope: Buffer }[] = [];
    const manifestEntries: VaultManifest['entries'] = [];
    for (const path of requested) {
      const entry = byPath.get(path)!;
      if (entry.sizeBytes > MAX_FILE_BYTES) throw new VaultError('backup-limit', path);
      const raw = await rawFileBytes(join(root, path), root, entry.sizeBytes);
      files.push({ storageName: storagePathName(path), envelope: encryptEnvelope(key, raw) });
      manifestEntries.push({ path, sizeBytes: entry.sizeBytes, sha256: sha256(raw) });
    }
    const createdAt = new Date().toISOString();
    const manifest: VaultManifest = {
      format: 'agent-town-vault', version: 1, repoId, workspaceId: state.workspace.id, label: repo.name,
      createdAt, fileCount: manifestEntries.length, totalBytes, entries: manifestEntries,
    };
    const header: RepoVaultHeader = {
      format: 'agent-town-vault', version: 1, createdAt, label: repo.name, fileCount: manifest.fileCount, totalBytes,
      kdf: { name: 'scrypt', saltHex: salt.toString('hex'), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    };
    const manifestEnvelope = encryptEnvelope(key, Buffer.from(JSON.stringify(manifest), 'utf8'));
    await writeRepoVault(backend.directory, state.workspace.id, repoId, header, manifestEnvelope, files);
    // Content-derived fingerprint, never the passphrase: a reused Idempotency-Key with a different
    // repoId/selection is rejected instead of silently leaving this real, already-written backup with
    // no durable VaultRepoStatus record (the passphrase never changes what actually got written, so it
    // is deliberately excluded from the fingerprint).
    store.commit(sourceId, current => {
      current.vault ??= { backend, repositories: {} };
      current.vault.repositories[repoId] = { lastBackupAt: createdAt, lastRestoreAt: current.vault.repositories[repoId]?.lastRestoreAt ?? null, fileCount: manifest.fileCount, totalBytes };
      return 'vault.backup';
    }, JSON.stringify({ repoId, paths: [...requested].sort() }));
    return manifest;
  }

  async listBackups(store: Store): Promise<VaultBackupSummary[]> {
    const state = store.snapshot().state;
    if (!state.vault?.backend) throw new VaultError('not-enabled');
    return listVaults(state.vault.backend.directory, state.workspace.id);
  }

  /** Shared by restorePreview and restore so a passphrase is scrypt-derived (deliberately slow) at
   * most once per call, not twice. */
  private async openManifest(store: Store, repoId: string, passphrase: string): Promise<{ manifest: VaultManifest; key: Buffer; directory: string; workspaceId: string }> {
    const state = store.snapshot().state;
    const backend = state.vault?.backend;
    if (!backend) throw new VaultError('not-enabled');
    const header = await readHeader(backend.directory, state.workspace.id, repoId);
    const key = await deriveKey(passphrase, Buffer.from(header.kdf.saltHex, 'hex'));
    const envelope = await readManifestEnvelope(backend.directory, state.workspace.id, repoId);
    try {
      const manifest = JSON.parse(decryptEnvelope(key, envelope).toString('utf8')) as VaultManifest;
      return { manifest, key, directory: backend.directory, workspaceId: state.workspace.id };
    } catch { throw new VaultError('invalid-passphrase'); }
  }

  private manifestHash(manifest: VaultManifest): string {
    return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  }

  /** At most MAX_RESTORE_OPERATIONS_PER_REPO operations are kept per repo; the oldest terminal
   * ('completed'/'failed') entries are evicted first when over the cap. A nonterminal operation is
   * never evicted — it either finishes or is superseded by the owner explicitly previewing again. */
  private evictOldRestoreOperations(operations: Record<string, VaultRestoreOperationRecord>, repoId: string): void {
    const forRepo = Object.values(operations).filter(op => op.repoId === repoId);
    let excess = forRepo.length - MAX_RESTORE_OPERATIONS_PER_REPO;
    if (excess <= 0) return;
    const terminal = forRepo.filter(op => op.status === 'completed' || op.status === 'failed')
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const op of terminal) {
      if (excess <= 0) break;
      delete operations[op.id];
      excess--;
    }
  }

  private transitionOperation(store: Store, repoId: string, operationId: string, status: VaultRestoreOperationStatus): void {
    store.commit(`vault-op:${operationId}:${status}`, current => {
      const op = current.vault?.restoreOperations?.[operationId];
      if (op && op.repoId === repoId && op.status !== status) op.status = status;
      return 'vault.restore-operation';
    });
  }

  private checkpointPublished(store: Store, repoId: string, operationId: string, published: string[]): void {
    // sourceId MUST vary with the growing array length, or every checkpoint after the first would
    // dedup away and never actually persist — this is the one call in this whole flow that legitimately
    // needs to run many times with genuinely new content.
    store.commit(`vault-op:${operationId}:published:${published.length}`, current => {
      const op = current.vault?.restoreOperations?.[operationId];
      if (op && op.repoId === repoId) op.publishedPaths = [...published];
      return 'vault.restore-operation';
    });
  }

  private failOperation(store: Store, repoId: string, operationId: string, reason: string): void {
    store.commit(`vault-op:${operationId}:failed`, current => {
      const op = current.vault?.restoreOperations?.[operationId];
      if (op && op.repoId === repoId && op.status !== 'completed') { op.status = 'failed'; op.error = reason; }
      return 'vault.restore-operation';
    });
  }

  private completeOperation(store: Store, repoId: string, operationId: string, manifest: VaultManifest): void {
    const completedAt = new Date().toISOString();
    store.commit(`vault-op:${operationId}:completed`, current => {
      const op = current.vault?.restoreOperations?.[operationId];
      if (op && op.repoId === repoId) { op.status = 'completed'; op.completedAt = completedAt; op.error = null; }
      if (current.vault) {
        current.vault.repositories[repoId] = {
          lastBackupAt: current.vault.repositories[repoId]?.lastBackupAt ?? manifest.createdAt,
          lastRestoreAt: completedAt, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes,
        };
      }
      return 'vault.restore';
    });
  }

  async restorePreview(store: Store, repoId: string, passphrase: string, destinationDirectory: string, sourceId: string): Promise<VaultRestorePreviewResult> {
    const { manifest } = await this.openManifest(store, repoId, passphrase);
    const destinationCheck = validateRestoreDestination(destinationDirectory);
    if (destinationCheck.exists && !destinationCheck.empty) {
      throw new VaultError('destination-not-empty', `Try a new folder such as ${suggestRestoreSibling(destinationCheck.canonical)}.`);
    }
    // Deterministic per client action (never a fresh randomUUID()), so a retried identical preview
    // call — the exact same Idempotency-Key — resolves to the SAME operation id: store.commit's own
    // dedup means the state-mutating callback below won't run twice, but the id itself must still
    // match on both calls for the caller to look it up.
    const operationId = createHash('sha256').update(sourceId).digest('hex');
    const now = new Date();
    const record: VaultRestoreOperationRecord = {
      id: operationId, repoId,
      destination: destinationCheck.canonical, destinationKind: destinationCheck.exists ? 'empty-existing' : 'new',
      manifestHash: this.manifestHash(manifest), backupCreatedAt: manifest.createdAt, label: manifest.label,
      fileCount: manifest.fileCount, totalBytes: manifest.totalBytes,
      status: 'previewed', publishedPaths: [],
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + RESTORE_OPERATION_TTL_MS).toISOString(),
      completedAt: null, error: null,
    };
    // Content-derived fingerprint (repoId + canonical destination, never the passphrase): a reused
    // Idempotency-Key against a genuinely different repo or destination is rejected instead of being
    // silently deduped and handing back a stale, mismatched destination bound to the FIRST call's data.
    store.commit(sourceId, current => {
      if (!current.vault?.backend) throw new VaultError('not-enabled');
      current.vault.restoreOperations ??= {};
      current.vault.restoreOperations[operationId] = record;
      this.evictOldRestoreOperations(current.vault.restoreOperations, repoId);
      return 'vault.restore-preview';
    }, JSON.stringify({ repoId, destination: destinationCheck.canonical }));
    // Read back from the store so a duplicate (dedup'd) retry of the same request still returns the
    // record the FIRST successful call created, under the same deterministic operationId.
    const saved = store.snapshot().state.vault?.restoreOperations?.[operationId];
    if (!saved) throw new VaultError('operation-not-found');
    return { operationId, manifest, destination: saved.destination, destinationKind: saved.destinationKind, expiresAt: saved.expiresAt };
  }

  // sourceId is accepted for API symmetry with restorePreview and to force every caller through the
  // same idempotency-key requirement, but every mutation this method makes uses a deterministic id
  // derived from operationId instead (see transitionOperation/checkpointPublished/failOperation/
  // completeOperation below) — operation identity, not the caller's own action id, is what a resumed
  // or duplicated restore call must key off of.
  async restore(store: Store, repoId: string, operationId: string, passphrase: string, _sourceId: string): Promise<VaultManifest> {
    // Scoped by workspace, not just operationId: operationId is a hash of a fully client-supplied
    // Idempotency-Key header with no workspace binding, so two different (private, isolated) workspaces
    // reusing the same key by coincidence, replay, or a crafted request must never make one wrongly
    // "busy"-block the other's genuinely unrelated restore. Cheap (no I/O) — read before paying the
    // scrypt cost below.
    const lockKey = `${store.snapshot().state.workspace.id}:${operationId}`;
    if (activeRestoreOperations.has(lockKey)) throw new VaultError('operation-busy');
    activeRestoreOperations.add(lockKey);
    try {
      // Re-derives the key AND re-verifies the passphrase on every single call — intentional: the
      // passphrase and derived key are NEVER persisted, so every resume, including after a restart,
      // requires the owner to type it in again.
      const { manifest, key, directory, workspaceId } = await this.openManifest(store, repoId, passphrase);
      const op = store.snapshot().state.vault?.restoreOperations?.[operationId];
      if (!op || op.repoId !== repoId) throw new VaultError('operation-not-found');

      // A duplicate call or a lost-response retry reconciles to the one real operation instead of
      // redoing (or double-writing) anything: no filesystem work at all once it is truly done.
      if (op.status === 'completed') return manifest;

      const currentHash = this.manifestHash(manifest);
      if (currentHash !== op.manifestHash) {
        this.failOperation(store, repoId, operationId, 'The backup changed since this preview.');
        throw new VaultError('operation-changed');
      }
      if (op.status === 'failed') throw new VaultError('operation-changed', 'This restore preview failed a check and cannot resume. Preview the backup again.');
      if (op.status === 'previewed' && Date.now() > Date.parse(op.expiresAt)) {
        this.failOperation(store, repoId, operationId, 'This restore preview expired.');
        throw new VaultError('operation-expired');
      }

      const destinationCheck = validateRestoreDestination(op.destination);
      if (pathKey(destinationCheck.canonical) !== pathKey(op.destination)) {
        this.failOperation(store, repoId, operationId, 'The destination changed since this preview.');
        throw new VaultError('operation-changed');
      }
      // Not just op.status === 'previewed': nothing of ours has landed at the destination yet for any
      // status up to and including 'staging' (staging only ever writes into the staging root, never the
      // destination) — so a foreign occupation must be caught here whenever publishedPaths is still
      // empty, however far this operation otherwise got before being interrupted.
      if (op.publishedPaths.length === 0 && destinationCheck.exists && !destinationCheck.empty) {
        this.failOperation(store, repoId, operationId, 'The destination is no longer empty.');
        throw new VaultError('operation-changed');
      }

      // Resume-safety: never silently trust that previously-published content is still intact. A
      // same-size file is not proof of identical bytes (an unclean shutdown can persist a file's
      // directory-entry size before its data blocks are flushed; an external process could also have
      // touched it) — re-read and re-hash every already-published file against the manifest, the same
      // full check the EEXIST-reconciliation branch below already does for a fresh write.
      const manifestByPath = new Map(manifest.entries.map(entry => [entry.path, entry]));
      for (const path of op.publishedPaths) {
        const entry = manifestByPath.get(path);
        let content: Buffer | undefined;
        try { content = await readFile(resolve(op.destination, path)); } catch { content = undefined; }
        if (!entry || !content || content.length !== entry.sizeBytes || sha256(content) !== entry.sha256) {
          this.failOperation(store, repoId, operationId, content ? 'A previously restored file no longer matches the backup.' : 'A previously restored file is missing.');
          throw new VaultError('operation-changed');
        }
      }

      if (op.status === 'previewed') this.transitionOperation(store, repoId, operationId, 'staging');

      const pending = manifest.entries.filter(entry => !op.publishedPaths.includes(entry.path));

      // Stage everything first, publish nothing yet: simpler and safer than resuming partial staging,
      // since backups are bounded (4 GiB total / 256 MiB per file) and staging is a recovery-only code
      // path, not the common case. A corrupt later file, or disk-full during staging, can never yield
      // success, because nothing has touched the real destination yet at this point.
      const stagingRoot = await resetRestoreStaging(directory, workspaceId, operationId);
      try {
        for (const entry of pending) {
          const envelope = await readFileEnvelope(directory, workspaceId, repoId, storagePathName(entry.path));
          const plaintext = decryptEnvelope(key, envelope);
          if (plaintext.length !== entry.sizeBytes || sha256(plaintext) !== entry.sha256) throw new VaultError('entry-integrity-failed', entry.path);
          const stagedTarget = resolve(stagingRoot, entry.path);
          if (!isWithin(stagingRoot, stagedTarget)) throw new VaultError('vault-invalid', entry.path);
          await mkdir(dirname(stagedTarget), { recursive: true, mode: 0o700 });
          const verifiedParent = await checkedPath(dirname(stagedTarget), [stagingRoot]);
          await writeFile(join(verifiedParent, basename(stagedTarget)), plaintext, { mode: 0o600, flag: 'wx' });
        }
      } catch (error) {
        await removeRestoreStaging(directory, workspaceId, operationId).catch(() => undefined);
        this.failOperation(store, repoId, operationId, error instanceof Error ? error.message : 'Staging failed.');
        throw error instanceof VaultError ? error : new VaultError('entry-integrity-failed');
      }

      this.transitionOperation(store, repoId, operationId, 'staged');
      this.transitionOperation(store, repoId, operationId, 'publishing');

      await mkdir(op.destination, { recursive: true, mode: 0o700 });

      const published = [...op.publishedPaths];
      for (const entry of pending) {
        const stagedSource = resolve(stagingRoot, entry.path);
        const verifiedStagedParent = await checkedPath(dirname(stagedSource), [stagingRoot]);
        const plaintext = await readFile(join(verifiedStagedParent, basename(stagedSource)));

        const target = resolve(op.destination, entry.path);
        if (!isWithin(op.destination, target)) {
          this.failOperation(store, repoId, operationId, 'The backup contains an unsafe path.');
          throw new VaultError('vault-invalid', entry.path);
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const verifiedParent = await checkedPath(dirname(target), [op.destination]);
        const finalTarget = join(verifiedParent, basename(target));
        try {
          await writeFile(finalTarget, plaintext, { mode: 0o600, flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            // Belt-and-suspenders enforcement of "never overwrite": should not normally happen given
            // the earlier checks. If it matches, it was already published by an earlier interrupted
            // attempt within the SAME operation — continue. If not, this is real foreign occupation.
            const existing = await readFile(finalTarget);
            if (existing.length !== entry.sizeBytes || sha256(existing) !== entry.sha256) {
              this.failOperation(store, repoId, operationId, `An unrelated file already exists at ${entry.path}.`);
              throw new VaultError('operation-changed', entry.path);
            }
          } else {
            // Disk-full (or similar) cannot yield success, but the operation stays resumable, not
            // falsely terminal: checkpoint whatever published so far and leave status as 'publishing'.
            this.checkpointPublished(store, repoId, operationId, published);
            throw new VaultError('restore-incomplete', error instanceof Error ? error.message : undefined);
          }
        }
        published.push(entry.path);
        if (published.length % PUBLISH_CHECKPOINT_EVERY === 0) this.checkpointPublished(store, repoId, operationId, published);
      }

      this.checkpointPublished(store, repoId, operationId, published);
      await removeRestoreStaging(directory, workspaceId, operationId);
      this.completeOperation(store, repoId, operationId, manifest);
      return manifest;
    } finally {
      activeRestoreOperations.delete(lockKey);
    }
  }

  /** Lists this repo's restore operations, newest first, each annotated with whether THIS service
   * process is currently executing it and whether it needs the owner to re-enter the passphrase to
   * resume (any nonterminal operation that is not currently active — after a restart or a crash
   * mid-flight, or simply before the first attempt). */
  restoreOperations(store: Store, repoId: string): VaultRestoreOperationView[] {
    const state = store.snapshot().state;
    const workspaceId = state.workspace.id;
    const operations = state.vault?.restoreOperations ?? {};
    return Object.values(operations)
      .filter(op => op.repoId === repoId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(op => {
        const active = activeRestoreOperations.has(`${workspaceId}:${op.id}`);
        return { ...op, active, needsPassphrase: op.status !== 'completed' && op.status !== 'failed' && !active };
      });
  }
}
