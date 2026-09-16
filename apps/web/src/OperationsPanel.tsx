import { useEffect, useState } from 'react';
import { DatabaseBackup, RefreshCw } from 'lucide-react';
import type { BackupStatus } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';

interface RuntimeHealth { applicationMode: string; sourceHotReload: boolean; build?: { id: string; builtAt: string | null }; servedWeb?: { entry: string | null; buildId: string | null; builtAt: string | null } }
export function OperationsPanel({ identity, available }: { identity: IdentityController; available: boolean }) {
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let closed = false;
    const refresh = async () => {
      const results = await Promise.allSettled([identity.read<RuntimeHealth>('/health'), identity.read<BackupStatus>('/operations/backups')]);
      if (closed) return;
      if (results[0].status === 'fulfilled') setHealth(results[0].value);
      if (results[1].status === 'fulfilled') { setBackup(results[1].value); setError(null); }
      else setError(results[1].reason instanceof Error ? results[1].reason.message : 'Backup status is unavailable.');
    };
    void refresh(); const interval = setInterval(() => void refresh(), 10000);
    return () => { closed = true; clearInterval(interval); };
  }, [identity.read]);
  return <section className="setup-form" aria-label="Local runtime and backups">
    <h3 className="subheading">Local runtime</h3>
    <dl className="facts"><div><dt>Environment</dt><dd>{health?.applicationMode ?? 'Unavailable'}</dd></div><div><dt>Backend build</dt><dd className="mono">{health?.build?.id ?? 'Unavailable'}</dd></div><div><dt>Served web build</dt><dd className="mono">{health?.servedWeb?.buildId ?? 'Unavailable'}</dd></div><div><dt>Web entry</dt><dd className="mono">{health?.servedWeb?.entry ?? 'Unavailable'}</dd></div><div><dt>Source refresh</dt><dd>{health ? health.sourceHotReload ? 'Development hot reload' : 'Restart after building changes' : 'Unavailable'}</dd></div></dl>
    <p className="muted small">Use <code>.\run.ps1 -Dev</code> for automatic source refresh. Normal startup serves a built copy. Production mode currently uses this computer only.</p>
    <h3 className="subheading"><DatabaseBackup size={18} /> Recovery copies</h3>
    {error && <p className="form-error" role="status">{error}</p>}
    {backup && <><p className={backup.state === 'failed' ? 'form-error' : 'form-notice'} role="status">{backup.message}</p><dl className="facts"><div><dt>Schedule</dt><dd>{backup.enabled ? `Every ${backup.intervalHours} hours · keep ${backup.retentionCopies} copies` : 'Disabled'}</dd></div><div><dt>Last successful copy</dt><dd>{backup.lastSuccessAt ? new Date(backup.lastSuccessAt).toLocaleString() : 'None recorded'}</dd></div><div><dt>Restore verification</dt><dd>{backup.restoreVerifiedAt ? new Date(backup.restoreVerifiedAt).toLocaleString() : 'Not verified'}</dd></div><div><dt>Retained copies</dt><dd>{backup.retainedCopies}</dd></div><div><dt>Excluded items</dt><dd>{backup.excludedItems ?? 'Unavailable'}</dd></div></dl>
      <p className="muted small">Database recovery includes saved sessions and reports. Credentials, pending connector files and managed worktrees need their separate recovery steps. This does not replace a full computer backup.</p>
      <button className="button" disabled={!available || busy || backup.state === 'running' || !backup.enabled} onClick={async () => { setBusy(true); setError(null); try { setBackup(await identity.request<BackupStatus>('/operations/backups/run', undefined, AbortSignal.timeout(180000))); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The backup did not finish. Check its status.'); } finally { setBusy(false); } }}><RefreshCw size={15} />{busy || backup.state === 'running' ? 'Creating recovery copy…' : 'Create database recovery copy'}</button></>}
  </section>;
}
