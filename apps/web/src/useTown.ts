import { useCallback, useEffect, useRef, useState } from 'react';
import { DEMO_WORKSPACE, type DemoCommand, type Snapshot, type StateEvent } from '@agent-town/contracts';

export function useTown(workspaceId: string | null, csrf: string | null, onSessionExpired: () => Promise<unknown>) {
  const scope = `${csrf ?? ''}:${workspaceId ?? ''}`;
  const [stored, setStored] = useState<{ scope: string; snapshot: Snapshot } | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [snapshotGeneration, setSnapshotGeneration] = useState(0);
  const busy = useRef(false);
  const cursor = useRef(-1);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const prefix = `/api/v1/workspaces/${encodeURIComponent(workspaceId ?? '')}`;
  const accept = useCallback((incoming: Snapshot) => {
    if (currentScope.current !== scope) return;
    if (!incoming.state || incoming.state.schemaVersion !== 1 || incoming.state.workspace.id !== workspaceId) throw new Error('Incompatible workspace data.');
    if (incoming.cursor >= cursor.current) { cursor.current = incoming.cursor; setStored({ scope, snapshot: incoming }); }
  }, [workspaceId, scope]);

  useEffect(() => {
    setStored(null); cursor.current = -1; setError(null); setPending(false); busy.current = false;
    setConnection('connecting');
    if (!workspaceId || !csrf) return;
    let disposed = false;
    let stream: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let openingDeadline: ReturnType<typeof setTimeout>;
    let snapshotRequest: AbortController | undefined;
    let attempts = 0;
    let generation = 0;
    const abort = new AbortController();
    async function connect() {
      if (disposed) return;
      clearTimeout(retry); clearTimeout(openingDeadline);
      const current = ++generation;
      snapshotRequest?.abort();
      snapshotRequest = new AbortController();
      stream?.close();
      try {
        const response = await fetch(`${prefix}/snapshot`, { signal: AbortSignal.any([abort.signal, snapshotRequest.signal, AbortSignal.timeout(10000)]) });
        if (disposed || current !== generation) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setStored(null); setConnection('reconnecting');
          setError('This workspace is no longer available to your session.');
          await onSessionExpired();
          if (!disposed && current === generation) reconnect();
          return;
        }
        if (!response.ok) throw new Error('The workspace could not be loaded.');
        const latest = await response.json() as Snapshot;
        if (disposed || current !== generation) return;
        // A restored service can have a lower cursor; its fresh snapshot is authoritative.
        cursor.current = -1;
        accept(latest);
        setSnapshotGeneration(value => value + 1);
        stream = new EventSource(`${prefix}/events?after=${latest.cursor}`);
        openingDeadline = setTimeout(() => { if (!disposed && current === generation) reconnect(); }, 10000);
        stream.onopen = () => { if (!disposed && current === generation) { clearTimeout(openingDeadline); attempts = 0; setConnection('connected'); setError(null); } };
        stream.addEventListener('state', (event: MessageEvent<string>) => {
          if (disposed || current !== generation) return;
          try { accept(JSON.parse(event.data) as StateEvent); } catch { reconnect(); }
        });
        const reconnectCurrent = () => { if (!disposed && current === generation) reconnect(); };
        stream.addEventListener('resync_required', reconnectCurrent);
        stream.onerror = reconnectCurrent;
      } catch {
        if (!disposed && current === generation) reconnect();
      }
    }
    function reconnect() {
      stream?.close();
      if (disposed) return;
      generation++; snapshotRequest?.abort(); clearTimeout(openingDeadline);
      setConnection('reconnecting');
      clearTimeout(retry);
      retry = setTimeout(() => void connect(), Math.min(15000, 1000 * 2 ** Math.min(attempts++, 4)));
    }
    // Internet connectivity is only a hint. Loopback can remain reachable when
    // a laptop loses Wi-Fi, so recheck the actual local transport in both cases.
    const networkChanged = () => { setConnection('reconnecting'); void connect(); };
    window.addEventListener('offline', networkChanged);
    window.addEventListener('online', networkChanged);
    void connect();
    return () => { disposed = true; clearTimeout(retry); clearTimeout(openingDeadline); abort.abort(); snapshotRequest?.abort(); stream?.close(); window.removeEventListener('offline', networkChanged); window.removeEventListener('online', networkChanged); };
  }, [workspaceId, csrf, prefix, accept, onSessionExpired]);

  const command = useCallback(async (action: DemoCommand) => {
    if (busy.current || workspaceId !== DEMO_WORKSPACE || !csrf) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const response = await fetch(`${prefix}/demo/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(action), signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (currentScope.current !== scope) return;
      if (!response.ok) throw new Error(result.message ?? 'This action could not be saved.');
      accept(result.snapshot);
    } catch (cause) {
      if (currentScope.current === scope) setError(cause instanceof Error ? cause.message : 'The connection was interrupted. Check the latest state before trying again.');
    } finally { if (currentScope.current === scope) { busy.current = false; setPending(false); } }
  }, [workspaceId, csrf, scope, prefix, accept]);
  // Filtering during render clears private data immediately, before effect cleanup runs.
  const snapshot = stored?.scope === scope ? stored.snapshot : null;
  return { state: snapshot?.state, cursor: snapshot?.cursor ?? 0, snapshotGeneration, connection, error, dismissError: () => setError(null), pending, command };
}
