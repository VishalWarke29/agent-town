import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkedPath, isWithin } from '../discovery/paths.js';
import { createServiceBackup, restoreOfflineBackup, validateBackup, type BackupManifest } from './backup.js';
import { OperationsError, safeLocalDirectory } from './lock.js';
import type { BackupStatus } from '@agent-town/contracts';
export type { BackupStatus } from '@agent-town/contracts';

const DAY = 86_400_000;
const backupName = /^scheduled-[0-9]{13}-[a-f0-9-]{36}$/u;
const requestName = /^[A-Za-z0-9-]{8,80}$/u;
interface ScheduleRecord { version: 1; owner: string; backups: string[]; requestIds: string[]; lastSuccessAt: string | null; status: BackupStatus }
interface SchedulerOptions { sourceDirectory: string; destinationDirectory?: string; enabled?: boolean; intervalMs?: number; retentionCopies?: number; now?: () => number }

/** Daily local database recovery copies. No source, credential or model calls. */
export class BackupScheduler {
  private readonly source: string;
  private readonly destination: string;
  private readonly interval: number;
  private readonly keep: number;
  private readonly now: () => number;
  private record: ScheduleRecord;
  private initialized?: Promise<void>;
  private running?: Promise<BackupStatus>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private storageReady = false;
  private pendingRequests = new Set<string>();
  constructor(options: SchedulerOptions) {
    this.source = resolve(options.sourceDirectory);
    this.destination = resolve(options.destinationDirectory ?? `${this.source}-backups`);
    if (isWithin(this.source, this.destination) || isWithin(this.destination, this.source)) throw new OperationsError('unsafe-path');
    this.interval = options.intervalMs ?? DAY; this.keep = options.retentionCopies ?? 7; this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.interval) || this.interval < 60_000 || this.interval > 30 * DAY || !Number.isSafeInteger(this.keep) || this.keep < 1 || this.keep > 30) throw new OperationsError('backup-limit');
    const enabled = options.enabled !== false;
    this.record = { version: 1, owner: randomUUID(), backups: [], requestIds: [], lastSuccessAt: null, status: {
      enabled, state: enabled ? 'idle' : 'disabled', intervalHours: this.interval / 3_600_000, retentionCopies: this.keep,
      lastStartedAt: null, lastCompletedAt: null, lastSuccessAt: null, nextDueAt: enabled ? new Date(this.now() + 60_000).toISOString() : null,
      lastBackupId: null, retainedCopies: 0, excludedItems: null, restoreVerifiedAt: null,
      message: enabled ? 'The first scheduled database backup is due one minute after startup.' : 'Scheduled backups are disabled.',
    } };
  }
  status(): BackupStatus { return structuredClone(this.record.status); }
  async start(): Promise<void> {
    if (!this.record.status.enabled || this.stopped) return;
    try { await this.initialize(); }
    catch (error) { this.fail(error); }
    this.schedule();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.running; }
  async runIfDue(): Promise<BackupStatus> {
    if (!this.record.status.enabled || this.stopped || this.now() < Date.parse(this.record.status.nextDueAt ?? '')) return this.status();
    return this.runNow();
  }
  runNow(requestId?: string): Promise<BackupStatus> {
    if (!this.record.status.enabled || this.stopped) return Promise.resolve(this.status());
    if (requestId !== undefined && !requestName.test(requestId)) return Promise.reject(new OperationsError('invalid-backup'));
    if (requestId && new Set([...this.record.requestIds, ...this.pendingRequests, requestId]).size > 1000) return Promise.reject(new OperationsError('backup-limit'));
    if (requestId) this.pendingRequests.add(requestId);
    if (this.running) return this.running;
    this.running = this.perform().then(async () => {
      // Include requests arriving while capture/verification or a prior receipt
      // flush was awaiting IO. All accepted callers share this verified outcome.
      while (this.storageReady && [...this.pendingRequests].some(id => !this.record.requestIds.includes(id))) {
        try { this.recordRequests(); await this.persist(); }
        catch (error) { this.fail(error); break; }
      }
      return this.status();
    }).finally(() => { this.running = undefined; this.pendingRequests.clear(); if (!this.stopped) this.schedule(); });
    return this.running;
  }
  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      safeLocalDirectory(this.source);
      safeLocalDirectory(this.destination, true);
      const path = join(this.destination, 'schedule.json');
      if (!existsSync(path)) { await this.persist(); this.storageReady = true; return; }
      const info = await lstat(await checkedPath(path, [this.destination]));
      if (!info.isFile() || info.nlink > 1 || info.size > 256_000) throw new OperationsError('invalid-backup');
      const saved = JSON.parse(await readFile(path, 'utf8')) as ScheduleRecord;
      if (saved.version !== 1 || !/^[a-f0-9-]{36}$/u.test(saved.owner) || !Array.isArray(saved.backups) || saved.backups.length > 1000
        || new Set(saved.backups).size !== saved.backups.length || saved.backups.some(name => !backupName.test(name))
        || saved.lastSuccessAt !== null && !Number.isFinite(Date.parse(saved.lastSuccessAt))) throw new OperationsError('invalid-backup');
      const requestIds = saved.requestIds ?? [];
      if (!Array.isArray(requestIds) || requestIds.length > 1000 || requestIds.some(id => !requestName.test(id))) throw new OperationsError('invalid-backup');
      // Never trust persisted display strings or paths. Only restore validated
      // owned identifiers and dates; revalidate actual backups before deletion.
      this.record.owner = saved.owner; this.record.backups = saved.backups; this.record.lastSuccessAt = saved.lastSuccessAt;
      this.record.requestIds = requestIds;
      this.record.status.lastSuccessAt = saved.lastSuccessAt;
      this.record.status.lastBackupId = saved.backups.at(-1) ?? null;
      this.record.status.retainedCopies = saved.backups.length;
      for (const field of ['lastStartedAt', 'lastCompletedAt', 'restoreVerifiedAt'] as const) {
        const date = saved.status?.[field];
        this.record.status[field] = typeof date === 'string' && Number.isFinite(Date.parse(date)) ? date : null;
      }
      const count = saved.status?.excludedItems;
      this.record.status.excludedItems = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 40_000 ? count : null;
      this.record.status.nextDueAt = new Date(saved.lastSuccessAt ? Math.max(this.now() + 1000, Date.parse(saved.lastSuccessAt) + this.interval) : this.now() + 60_000).toISOString();
      if (saved.status?.state === 'running' || saved.status?.state === 'failed') {
        this.record.status.state = 'failed'; this.record.status.message = 'The previous backup did not finish successfully. Retained data was not replaced; the schedule will retry.';
      } else if (saved.lastSuccessAt) { this.record.status.state = 'succeeded'; this.record.status.message = 'A previous scheduled backup and restore check are recorded. Files will be revalidated before rotation.'; }
      this.storageReady = true;
    })().catch(error => { this.initialized = undefined; throw error; });
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || !this.record.status.enabled) return;
    const wait = Math.max(1000, Date.parse(this.record.status.nextDueAt ?? '') - this.now());
    this.timer = setTimeout(() => { void this.runIfDue(); }, Number.isFinite(wait) ? wait : 60_000); this.timer.unref();
  }
  private fail(error: unknown) {
    this.record.status.state = 'failed'; this.record.status.lastCompletedAt = new Date(this.now()).toISOString();
    this.record.status.nextDueAt = new Date(this.now() + Math.min(this.interval, 3_600_000)).toISOString();
    this.record.status.message = error instanceof OperationsError ? error.message : 'The scheduled backup failed. Existing backups and live data were preserved. Check local storage and retry.';
  }
  private async persist() {
    safeLocalDirectory(this.destination);
    const temporary = join(this.destination, `.schedule-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.record, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, join(this.destination, 'schedule.json'));
  }
  private recordRequests() {
    const ids = [...new Set([...this.record.requestIds, ...this.pendingRequests])];
    if (ids.length > 1000) throw new OperationsError('backup-limit');
    this.record.requestIds = ids;
  }
  private async perform(): Promise<BackupStatus> {
    try {
      await this.initialize();
      if (this.pendingRequests.size && [...this.pendingRequests].every(id => this.record.requestIds.includes(id))) return this.status();
      this.recordRequests();
      this.record.status.state = 'running'; this.record.status.lastStartedAt = new Date(this.now()).toISOString();
      this.record.status.message = 'Capturing private databases, then verifying recovery in a new temporary directory.';
      await this.persist();
      // A failed rotation must not produce another extra copy on every retry.
      // Resolve the retained excess safely before capturing anything new.
      if (this.record.backups.length > this.keep) await this.rotate();
      const name = `scheduled-${this.now()}-${randomUUID()}`, destination = join(this.destination, name);
      const manifest = await createServiceBackup(this.source, destination);
      await writeFile(join(destination, 'schedule-owner.json'), JSON.stringify({ owner: this.record.owner }), { flag: 'wx', mode: 0o600, flush: true });
      const verification = join(this.destination, `.restore-check-${randomUUID()}`);
      await restoreOfflineBackup(destination, verification);
      // This is a private verification copy, never the active runtime. Remove
      // only after the fresh-directory restore has validated all copied bytes.
      await this.removeVerification(verification, manifest);
      this.record.backups.push(name);
      this.record.status.retainedCopies = this.record.backups.length;
      this.record.status.restoreVerifiedAt = new Date(this.now()).toISOString();
      this.record.status.excludedItems = manifest.coverage && Object.values(manifest.coverage.excluded).every(count => count.exact)
        ? Object.values(manifest.coverage.excluded).reduce((sum, count) => sum + count.items, 0) : null;
      // Persist ownership before rotation. A crash may leave extra backups, but
      // it must never delete the only verified recovery copy.
      await this.persist();
      await this.rotate();
      this.recordRequests();
      const completedAt = new Date(this.now()).toISOString();
      this.record.lastSuccessAt = completedAt;
      Object.assign(this.record.status, { state: 'succeeded', lastCompletedAt: completedAt, lastSuccessAt: completedAt, lastBackupId: name,
        retainedCopies: this.record.backups.length, nextDueAt: new Date(this.now() + this.interval).toISOString(),
        message: 'Database backup and fresh-directory restore verified. Credentials, source repositories, worktrees, execution copies, external evidence, and pending spool items are excluded; see the coverage manifest.' });
      await this.persist();
    } catch (error) {
      this.fail(error);
      try { this.recordRequests(); } catch { /* A full receipt ledger fails closed; do not evict previous approvals. */ }
      if (this.storageReady) try { await this.persist(); } catch { /* The in-memory failure remains visible when storage itself is unavailable. */ }
    }
    return this.status();
  }
  private async removeVerification(path: string, manifest: BackupManifest) {
    if (!/^\.restore-check-[a-f0-9-]{36}$/u.test(path.slice(this.destination.length + 1)) || !isWithin(this.destination, path)) throw new OperationsError('unsafe-path');
    await checkedPath(path, [this.destination]);
    const restored = JSON.parse(await readFile(join(path, 'restore-manifest.json'), 'utf8')) as BackupManifest;
    if (JSON.stringify(restored) !== JSON.stringify(manifest)) throw new OperationsError('invalid-backup');
    await this.checkOwnedTree(path, new Set(['restore-manifest.json', ...manifest.files.map(file => `private/${file.path}`)]));
    await rm(path, { recursive: true });
  }
  private async checkOwnedTree(root: string, files: Set<string>) {
    let visited = 0;
    const visit = async (path: string, relative: string) => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (++visited > 2000) throw new OperationsError('backup-limit');
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        const target = await checkedPath(join(path, entry.name), [this.destination]), info = await lstat(target);
        if (info.isSymbolicLink() || info.nlink > 1 && info.isFile()) throw new OperationsError('unsafe-path');
        if (info.isDirectory() && [...files].some(file => file.startsWith(`${name}/`))) await visit(target, name);
        else if (!info.isFile() || !files.has(name)) throw new OperationsError('unsafe-path');
      }
    };
    await visit(root, '');
  }
  private async rotate() {
    while (this.record.backups.length > this.keep) {
      const name = this.record.backups[0]!, path = join(this.destination, name);
      if (!backupName.test(name) || !isWithin(this.destination, path)) throw new OperationsError('unsafe-path');
      await checkedPath(path, [this.destination]);
      const manifest = await validateBackup(path);
      const ownerPath = await checkedPath(join(path, 'schedule-owner.json'), [this.destination]), info = await lstat(ownerPath);
      if (!info.isFile() || info.nlink > 1 || info.size > 1000 || JSON.parse(await readFile(ownerPath, 'utf8')).owner !== this.record.owner) throw new OperationsError('invalid-backup');
      await this.checkOwnedTree(path, new Set(['manifest.json', 'schedule-owner.json', ...manifest.files.map(file => file.path)]));
      await rm(path, { recursive: true });
      this.record.backups.shift();
      await this.persist();
    }
  }
}
