import type { VaultSecretFinding } from '@agent-town/contracts';

const MESSAGES = {
  'not-enabled': ['Project Vault is not enabled. Choose a local folder for it first.', 409],
  'unsafe-destination': ['Use a local directory without symbolic links, junctions, network paths, or path traversal.', 400],
  'invalid-selection': ['The requested files no longer match the project’s current contents. Re-scan and try again.', 409],
  'secret-found': ['A likely secret was found in a selected file. Deselect it or remove the secret, then try again.', 422],
  'invalid-passphrase': ['This passphrase does not match this vault, or the vault is corrupted.', 401],
  'vault-missing': ['No backup exists yet for this project.', 404],
  'vault-invalid': ['This backup is corrupted or from an unsupported version.', 409],
  'repo-not-found': ['This project is not connected in this workspace.', 404],
  'backup-limit': ['This backup exceeds the supported file or size limits.', 413],
  'destination-not-empty': ['Choose an empty or new folder for this restore. Existing files at the selected destination are never overwritten.', 409],
  'operation-not-found': ['This restore preview is no longer available. Preview the backup again before restoring.', 404],
  'operation-expired': ['This restore preview has expired. Preview the backup again before restoring.', 409],
  'operation-changed': ['The backup or destination changed since this preview was reviewed. Preview the backup again before restoring.', 409],
  'operation-busy': ['A restore for this backup is already running. Wait for it to finish, then try again.', 409],
  'restore-incomplete': ['The restore could not finish writing every file. Already-restored files are kept; retrying will continue instead of starting over.', 500],
  'entry-integrity-failed': ['A backed-up file failed verification and cannot be restored safely. No files were written to the destination.', 409],
} as const satisfies Record<string, readonly [string, number]>;

export class VaultError extends Error {
  public readonly statusCode: number;
  constructor(
    public readonly code: keyof typeof MESSAGES,
    detail?: string,
    public readonly findings?: VaultSecretFinding[],
  ) {
    const [message, statusCode] = MESSAGES[code];
    super(`${message}${detail ? ` ${detail}` : ''}`);
    this.name = 'VaultError';
    this.statusCode = statusCode;
  }
}
