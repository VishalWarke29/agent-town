import { useEffect, useState } from 'react';
import type { DbSchemaSnapshot } from '@agent-town/contracts';

export type DbSchemaStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/** Fetches the read-only database-schema snapshot for one workspace, on demand (only once `active`
 * is true, i.e. the Archive is actually open) rather than on every town load. Zero model inference;
 * this is a plain structural GET, matching the Economy default that opening saved details costs nothing. */
export function useDbSchema(workspaceId: string | null, active: boolean) {
  const [status, setStatus] = useState<DbSchemaStatus>('idle');
  const [snapshot, setSnapshot] = useState<DbSchemaSnapshot | null>(null);

  useEffect(() => {
    if (!active || !workspaceId) return;
    let disposed = false;
    setStatus('loading');
    setSnapshot(null);
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/db-schema`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (disposed) return;
        if (!response.ok) { setStatus('unavailable'); return; }
        const data = await response.json() as DbSchemaSnapshot;
        if (disposed) return;
        setSnapshot(data);
        setStatus('ready');
      } catch {
        if (!disposed) setStatus('unavailable');
      }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [workspaceId, active]);

  return { status, snapshot };
}
