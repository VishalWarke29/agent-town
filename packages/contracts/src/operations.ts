/** Installation-wide counts and recovery health; no account names or filesystem paths. */
export interface BackupStatus {
  enabled: boolean;
  state: 'disabled' | 'idle' | 'running' | 'succeeded' | 'failed';
  intervalHours: number; retentionCopies: number;
  lastStartedAt: string | null; lastCompletedAt: string | null; lastSuccessAt: string | null;
  nextDueAt: string | null; lastBackupId: string | null; retainedCopies: number;
  excludedItems: number | null; restoreVerifiedAt: string | null;
  message: string;
}
