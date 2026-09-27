import { z } from 'zod';

/** Project Vault: cross-device backup of a connected project's own files, including gitignored
 * ones a plain `git clone` on a second machine would never bring back. Local-folder backend only
 * today (DR-061, 2026-09-25) — no hosted vendor account exists in this repo yet; a real cloud
 * backend is a later, additive backend kind, not a redesign of this shape. */
export type VaultBackendKind = 'local-folder';
export interface VaultBackendConfig {
  kind: VaultBackendKind;
  /** local-folder only: an absolute path the owner pointed the vault at (e.g. a second drive or a
   * drive-letter-mapped share). Never a raw UNC path — same restriction this app already applies to
   * every other local-directory input (ops/lock.ts safeLocalDirectory). */
  directory: string;
}

export interface VaultSelectionEntry {
  /** Relative to the project root, forward-slash separated. */
  path: string;
  sizeBytes: number;
  /** Matched by the project's own .gitignore rules — never pre-selected for backup. */
  gitignored: boolean;
  /** Matches a name this app already treats as sensitive elsewhere (credentials, keys, env files,
   * session/history dumps — discovery/policy.ts isSecretName). Still selectable, but never
   * pre-selected, and always re-scanned for a real secret before it can be included. */
  sensitiveName: boolean;
}
export interface VaultSecretFinding {
  path: string;
  line: number;
  ruleId: string;
  /** Enough to locate the line, never enough to reconstruct the secret. */
  redactedSnippet: string;
}
export interface VaultScanResult {
  scannedAt: string;
  repoId: string;
  entries: VaultSelectionEntry[];
  findings: VaultSecretFinding[];
  totalBytes: number;
  issues: string[];
}

export interface VaultManifestEntry { path: string; sizeBytes: number; sha256: string }
export interface VaultManifest {
  format: 'agent-town-vault';
  version: 1;
  repoId: string;
  workspaceId: string;
  /** The project's own display name at backup time, plaintext (not secret) — how a restoring
   * second device tells one project's backup apart from another before it has any local record of it. */
  label: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  entries: VaultManifestEntry[];
}

export interface VaultRepoStatus {
  repoId: string;
  lastBackupAt: string | null;
  lastRestoreAt: string | null;
  fileCount: number | null;
  totalBytes: number | null;
}
export interface VaultStatus { enabled: boolean; backend: VaultBackendConfig | null; repositories: VaultRepoStatus[] }

export type VaultRestoreOperationStatus = 'previewed' | 'staging' | 'staged' | 'publishing' | 'completed' | 'failed';

/** Nonsecret restore-operation record: binds one restore attempt to an immutable backup identity and
 * destination so nothing can be silently substituted after the owner reviewed it (PV-02). Never holds
 * the passphrase or derived key — every restore call re-supplies the passphrase, and an operation that
 * survives a service restart mid-flight is resumed only by re-entering it, never auto-recovered. */
export interface VaultRestoreOperationRecord {
  id: string; repoId: string;
  destination: string; destinationKind: 'new' | 'empty-existing';
  manifestHash: string; backupCreatedAt: string; label: string; fileCount: number; totalBytes: number;
  status: VaultRestoreOperationStatus;
  publishedPaths: string[];
  createdAt: string; expiresAt: string; completedAt: string | null; error: string | null;
}
/** The read-only view the API returns: `active` is only ever true while THIS service process is
 * currently executing the operation; `needsPassphrase` is true for any nonterminal operation that is
 * not currently active — after a restart or a crash mid-flight, or simply before the first attempt. */
export interface VaultRestoreOperationView extends VaultRestoreOperationRecord { active: boolean; needsPassphrase: boolean }
export interface VaultRestorePreviewResult {
  operationId: string; manifest: VaultManifest;
  destination: string; destinationKind: 'new' | 'empty-existing'; expiresAt: string;
}

/** Persisted in TownState. `repositories` is keyed by repoId; converted to VaultStatus's array shape
 * for the API response. */
export interface VaultState {
  backend: VaultBackendConfig | null;
  repositories: Record<string, { lastBackupAt: string | null; lastRestoreAt: string | null; fileCount: number | null; totalBytes: number | null }>;
  restoreOperations?: Record<string, VaultRestoreOperationRecord>;
}

/** One backup found in the vault directory, for the restore side of a cross-device pair. `repoId`
 * here is only ever this vault's own storage key: on the machine that made the backup it happens to
 * equal that project's local connection id, but a repository record with that id need not exist on
 * a second, restoring machine — workspaceId (tied to the owner's GitHub sign-in, DR-002) is the one
 * key stable across devices, and everything under it is listed by its plain-text label instead. */
export interface VaultBackupSummary { repoId: string; label: string; createdAt: string; fileCount: number; totalBytes: number }

export const vaultEnableSchema = z.object({ directory: z.string().trim().min(1).max(1024) }).strict();
export const vaultScanSchema = z.object({ repoId: z.string().min(1).max(100) }).strict();
export const vaultBackupSchema = z.object({
  repoId: z.string().min(1).max(100),
  paths: z.array(z.string().min(1).max(1024)).min(1).max(20_000),
  passphrase: z.string().min(12).max(256),
}).strict();
export const vaultRestorePreviewSchema = z.object({
  passphrase: z.string().min(12).max(256),
  destinationDirectory: z.string().trim().min(1).max(1024),
}).strict();
export const vaultRestoreSchema = z.object({
  operationId: z.string().min(1).max(100),
  passphrase: z.string().min(12).max(256),
}).strict();
