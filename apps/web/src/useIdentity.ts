import { useCallback, useEffect, useRef, useState } from 'react';
import { DEMO_WORKSPACE, type BrowserSession, type WorkspaceSummary } from '@agent-town/contracts';

interface DeviceFlow { flowId: string; userCode: string; verificationUri: string; expiresAt: string; intervalSeconds: number }
interface DevicePoll { status: 'pending' | 'slow_down' | 'authorized' | 'expired' | 'denied' | 'cancelled'; retryAfterSeconds?: number; session?: BrowserSession }

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly restartSignIn: boolean) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function deviceAttemptEnded(cause: unknown): cause is ApiRequestError {
  if (!(cause instanceof ApiRequestError)) return false;
  if (cause.restartSignIn) return true;
  const code = cause.code?.toLowerCase();
  // Credential persistence happens after GitHub consumes the device code. Keep
  // that cause visible instead of polling the cancelled flow and replacing it.
  // Temporary transport/provider errors and rate limits can still recover.
  return !!code && (code.startsWith('vault_') || code.startsWith('credential_') || code === 'identity_failed' || code === 'identity_unavailable')
    || (cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429);
}

function previewRequested() {
  return new URLSearchParams(window.location.search).get('preview') === '1';
}

function setPreviewRequested(enabled: boolean) {
  const url = new URL(window.location.href);
  if (enabled) url.searchParams.set('preview', '1');
  else url.searchParams.delete('preview');
  window.history.replaceState(window.history.state, '', url);
}

function previousWorkspace(session: BrowserSession): string | null {
  if (session.applicationMode === 'demo') return DEMO_WORKSPACE;
  if (session.applicationMode !== 'production' && previewRequested()) return DEMO_WORKSPACE;
  if (!session.user) return null;
  try {
    const saved = localStorage.getItem(`agent-town-workspace:${session.user.id}`);
    if (session.workspaces.some(workspace => workspace.id === saved)) return saved;
  } catch { /* Workspace preferences are optional. */ }
  return session.workspaces[0]?.id ?? null;
}

export function useIdentity() {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const sessionRef = useRef(session);
  const pending = useRef(false);
  const mounted = useRef(true);
  const flowGeneration = useRef(0);
  const identityGeneration = useRef(0);
  const sessionRequests = useRef(new Set<AbortController>());
  const accept = useCallback((next: BrowserSession) => {
    const previousUser = sessionRef.current?.user?.id;
    // A real identity change must leave the sample behind. An explicit preview
    // URL still works on a fresh page, including for an already signed-in user.
    if (sessionRef.current && next.user?.id !== previousUser) setPreviewRequested(false);
    if (next.applicationMode === 'production') setPreviewRequested(false);
    identityGeneration.current++;
    sessionRef.current = next;
    setSession(next);
    setWorkspaceId(current => next.user?.id === previousUser && next.workspaces.some(workspace => workspace.id === current) ? current : previousWorkspace(next));
  }, []);

  const refreshSession = useCallback(async () => {
    const generation = identityGeneration.current;
    const abort = new AbortController();
    sessionRequests.current.add(abort);
    try {
      const response = await fetch('/api/v1/session', { method: 'POST', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error('The local service is not ready.');
      const next = await response.json() as BrowserSession;
      if (mounted.current && generation === identityGeneration.current) { accept(next); setConnection('connected'); setConnectionError(null); }
      return next;
    } finally { sessionRequests.current.delete(abort); }
  }, [accept]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let checking = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      if (disposed || checking) return;
      clearTimeout(retry); checking = true;
      try { await refreshSession(); }
      catch {
        if (!disposed) { setConnection('reconnecting'); setConnectionError('Waiting for the local service. Start it with run.ps1.'); retry = setTimeout(() => void connect(), 3000); }
      } finally { checking = false; }
    };
    // Browser network hints describe internet access, not the loopback service.
    // Only a failed local request changes readiness; failures keep retrying.
    const networkChanged = () => { void connect(); };
    window.addEventListener('offline', networkChanged);
    window.addEventListener('online', networkChanged);
    void connect();
    return () => { mounted.current = false; disposed = true; clearTimeout(retry); for (const abort of sessionRequests.current) abort.abort(); window.removeEventListener('offline', networkChanged); window.removeEventListener('online', networkChanged); };
  }, [refreshSession]);

  // First-run setup can change on disk while this page stays open. Poll only
  // until GitHub is configured; this never starts authorization or model work.
  useEffect(() => {
    if (!session || session.identity.configured || session.user || session.applicationMode === 'demo' || flow) return;
    let disposed = false;
    let checking = false;
    const checkSetup = async () => {
      if (disposed || checking || pending.current || document.visibilityState !== 'visible') return;
      checking = true;
      try { await refreshSession(); }
      catch {
        if (!disposed && mounted.current) {
          setConnection('reconnecting');
          setConnectionError('Waiting for the local service. Setup will refresh automatically when it reconnects.');
        }
      } finally { checking = false; }
    };
    const timer = setInterval(() => void checkSetup(), 5000);
    const visible = () => { if (document.visibilityState === 'visible') void checkSetup(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [session?.identity.configured, session?.user?.id, session?.applicationMode, flow, refreshSession]);

  const request = useCallback(async <T,>(path: string, body?: unknown, signal?: AbortSignal, method: 'GET' | 'POST' | 'PATCH' = 'POST'): Promise<T> => {
    const current = sessionRef.current;
    if (!current) throw new Error('Wait for the local connection before trying again.');
    const response = await fetch(`/api/v1${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': current.csrf, ...(method !== 'GET' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}), signal: signal ?? AbortSignal.timeout(20000),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const detail = result && typeof result === 'object' ? result as { message?: unknown; code?: unknown; restartSignIn?: unknown } : null;
      throw new ApiRequestError(typeof detail?.message === 'string' ? detail.message : 'This action could not be completed.', response.status, typeof detail?.code === 'string' ? detail.code : null, detail?.restartSignIn === true);
    }
    return result as T;
  }, []);
  const read = useCallback(<T,>(path: string) => request<T>(path, undefined, undefined, 'GET'), [request]);

  const action = useCallback(async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The local connection was interrupted.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }, []);

  useEffect(() => {
    if (!flow) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let interval = Math.max(5, flow.intervalSeconds);
    const generation = flowGeneration.current;
    const abort = new AbortController();
    const poll = async () => {
      if (Date.now() >= Date.parse(flow.expiresAt)) { setFlow(null); setNotice('This sign-in code expired. Start again for a new code.'); return; }
      try {
        const result = await request<DevicePoll>('/auth/github/device/poll', { flowId: flow.flowId }, abort.signal);
        if (disposed || generation !== flowGeneration.current) return;
        if (result.status === 'authorized' && result.session) { accept(result.session); setFlow(null); setNotice('GitHub connected. Choose or create your private workspace.'); return; }
        if (result.status === 'expired' || result.status === 'denied' || result.status === 'cancelled') { setFlow(null); setNotice(result.status === 'denied' ? 'Sign-in was declined. No account was connected.' : result.status === 'cancelled' ? 'This sign-in attempt was cancelled. Start again when ready.' : 'This sign-in code expired. Start again for a new code.'); return; }
        interval = Math.max(interval, result.retryAfterSeconds ?? interval);
        setNotice(result.status === 'slow_down' ? 'GitHub asked us to wait a little longer. Waiting for your approval…' : 'Waiting for you to approve this code on GitHub…');
      } catch (cause) {
        if (disposed || generation !== flowGeneration.current) return;
        if (deviceAttemptEnded(cause)) {
          flowGeneration.current++;
          setFlow(null);
          setError(cause.message);
          setNotice('This sign-in attempt ended. Resolve the error, then choose Sign in with GitHub for a new code.');
          return;
        }
        setNotice(cause instanceof Error ? cause.message : 'The connection was interrupted. Sign-in will retry.');
        interval = Math.min(30, interval + 5);
      }
      if (!disposed) timer = setTimeout(() => void poll(), interval * 1000);
    };
    timer = setTimeout(() => void poll(), interval * 1000);
    return () => { disposed = true; clearTimeout(timer); abort.abort(); };
  }, [flow, request, accept]);

  const chooseWorkspace = (id: string) => {
    const current = sessionRef.current;
    if (current?.applicationMode === 'demo' && id !== DEMO_WORKSPACE) return;
    if (current?.applicationMode === 'production' && id === DEMO_WORKSPACE) return;
    if (id !== DEMO_WORKSPACE && !current?.workspaces.some(workspace => workspace.id === id)) return;
    setPreviewRequested(id === DEMO_WORKSPACE);
    setWorkspaceId(id);
    if (current?.user && id !== DEMO_WORKSPACE) {
      try { localStorage.setItem(`agent-town-workspace:${current.user.id}`, id); } catch { /* Preference only. */ }
    }
  };

  return {
    session, workspaceId, flow, notice, error: error ?? connectionError, busy, connection, request, read, refreshSession, chooseWorkspace,
    applicationMode: session?.applicationMode ?? 'development',
    previewAvailable: session?.applicationMode !== 'production',
    previewOnly: session?.applicationMode === 'demo',
    exitPreview: () => {
      if (session?.applicationMode === 'demo') return;
      setPreviewRequested(false);
      setWorkspaceId(session ? previousWorkspace(session) : null);
    },
    startSignIn: () => action(async () => {
      flowGeneration.current++;
      setFlow(null);
      const next = await request<DeviceFlow>('/auth/github/device/start');
      if (next.verificationUri !== 'https://github.com/login/device') throw new Error('The sign-in destination could not be verified.');
      setFlow(next); setNotice('Open GitHub and enter the code below.');
    }),
    cancelSignIn: () => action(async () => {
      if (!flow) return;
      flowGeneration.current++;
      const flowId = flow.flowId;
      setFlow(null);
      let cancellationError: unknown;
      try { await request('/auth/github/device/cancel', { flowId }); }
      catch (cause) { cancellationError = cause; }
      // Approval may win the race and rotate the cookie before cancellation.
      // Always reconcile the browser's identity and CSRF with the server.
      const next = await refreshSession();
      if (next.user) setNotice('GitHub authorization completed before cancellation. Use Sign out to close that session.');
      else if (cancellationError) throw cancellationError;
      else setNotice('Sign-in cancelled.');
    }),
    logout: () => action(async () => {
      flowGeneration.current++; setFlow(null);
      const next = await request<BrowserSession>('/auth/logout');
      setPreviewRequested(false);
      accept(next); setNotice('Signed out. Private workspace details are closed.');
    }),
    disconnectGithub: () => action(async () => {
      // The route only confirms the stored credential was removed ({ ok: true }); it is not a
      // session and must never be handed to accept() as one (SP-2, that blanked the app). The
      // browser session itself is untouched by disconnect, so re-reading it keeps sign-in intact.
      await request('/auth/github/disconnect');
      await refreshSession();
      setNotice('GitHub credential removed. Sign in with GitHub again to reconnect.');
    }),
    createWorkspace: (name: string, kind: 'personal' | 'company') => action(async () => {
      const result = await request<{ workspace: WorkspaceSummary }>('/workspaces', { name, kind });
      setPreviewRequested(false);
      const next = await refreshSession();
      if (next.workspaces.some(workspace => workspace.id === result.workspace.id)) chooseWorkspace(result.workspace.id);
    }),
  };
}

export type IdentityController = ReturnType<typeof useIdentity>;
