import { agentDisplayName } from './agentDisplayName';
import { SessionReports } from './SessionReports';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { activityLabel, type Agent, type NativeSessionPage, type NativeSetupSnapshot, type ToolSurface, type TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';

interface Props {
  state: TownState; identity: IdentityController; available: boolean;
  repoId: string; provider: ToolSurface; sourceId: string;
  onSourceChange: (id: string) => void;
}

/** Native inventory is deliberately separate from the event-driven town snapshot. */
export function NativeTrackingPanel({ state, identity, available, repoId, provider, sourceId, onSourceChange }: Props) {
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}/observation`;
  const [setup, setSetup] = useState<NativeSetupSnapshot | null>(null);
  const [page, setPage] = useState<NativeSessionPage | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [cursors, setCursors] = useState<string[]>([]);
  const [includeOlder, setIncludeOlder] = useState(false);
  const [homePath, setHomePath] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState<{ sessionId: string; agent: Agent } | null>(null);
  const generation = useRef(0);
  const action = useRef<AbortController | null>(null);
  const setupRequest = useRef(0);
  const inventoryRequest = useRef(0);
  const tool = setup?.tools.find(item => item.provider === provider);
  const sources = setup?.sources.filter(item => item.provider === provider) ?? [];
  const source = sources.find(item => item.id === sourceId);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++setupRequest.current;
    if (!available) return () => controller.abort();
    void identity.request<NativeSetupSnapshot>(`${prefix}/native-setup?repoId=${encodeURIComponent(repoId)}`, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), 'GET').then(result => {
      if (!Array.isArray(result.sources) || !Array.isArray(result.tools)) throw new Error('The local service returned an unsupported tracking setup response. Restart the service on the current build, then refresh tool status.');
      if (request === setupRequest.current && !controller.signal.aborted) { setSetup(result); setDetectionError(null); }
    }).catch(cause => { if (!controller.signal.aborted && request === setupRequest.current) setDetectionError(cause instanceof Error ? cause.message : 'Local tool detection is unavailable.'); });
    return () => controller.abort();
  }, [prefix, repoId, available, identity.request, refresh]);

  useEffect(() => {
    generation.current++;
    action.current?.abort(); action.current = null;
    setBusy(null); setError(null); setNotice(null); setPage(null); setCursors([]); setIncludeOlder(false); setLabel(''); setHomePath(''); setDetail(null);
  }, [provider, repoId]);
  useEffect(() => () => { generation.current++; action.current?.abort(); }, []);
  useEffect(() => {
    setPage(null); setCursors([]); setDetail(null);
    if (!sourceId || !available) { setInventoryLoading(false); return; }
    setInventoryLoading(true);
    const controller = new AbortController(); const current = generation.current; const request = ++inventoryRequest.current;
    const params = new URLSearchParams({ repoId, sourceId, includeOlder: String(includeOlder) });
    void identity.request<NativeSessionPage>(`${prefix}/native-sessions?${params}`, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), 'GET').then(result => {
      if (!controller.signal.aborted && generation.current === current && request === inventoryRequest.current) setPage(result);
    }).catch(cause => { if (!controller.signal.aborted && generation.current === current && request === inventoryRequest.current) setError(cause instanceof Error ? cause.message : 'Saved sessions could not be loaded.'); }).finally(() => { if (!controller.signal.aborted && generation.current === current && request === inventoryRequest.current) setInventoryLoading(false); });
    return () => controller.abort();
  }, [prefix, repoId, sourceId, includeOlder, available, identity.request]);

  const run = async (name: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (action.current || !available) return;
    const controller = new AbortController(); action.current = controller;
    if (name === 'scan' || name === 'visibility' || name === 'page') { inventoryRequest.current++; setInventoryLoading(false); }
    const current = generation.current;
    setBusy(name); setError(null); setNotice(null);
    try { await work(AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])); }
    catch (cause) {
      if (!controller.signal.aborted && current === generation.current) {
        setError(cause instanceof Error ? cause.message : 'Tracking setup could not complete.');
        // Failed scans persist adapter diagnostics. Refresh those separately so
        // a successful status read cannot erase the actual scan failure.
        if (name === 'scan') setRefresh(value => value + 1);
      }
    }
    finally { if (action.current === controller) { action.current = null; if (current === generation.current) setBusy(null); } }
  };
  const readPage = async (cursor: string | undefined, signal: AbortSignal) => {
    const params = new URLSearchParams({ repoId, sourceId, includeOlder: String(includeOlder), ...(cursor ? { cursor } : {}) });
    const result = await identity.request<NativeSessionPage>(`${prefix}/native-sessions?${params}`, undefined, signal, 'GET');
    if (!signal.aborted) setPage(result);
  };

  return <section className="native-tracking" aria-label="Find local agent sessions">
    <h4>1. Select the local profile</h4>
    {!available && <p className="form-notice" role="status">Tracking setup will resume when the local service reconnects.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {detectionError && <p className="form-error" role="alert">{detectionError}</p>}
    {notice && <p className="form-notice" role="status">{notice}</p>}
    {!setup ? <p className="muted small" role="status">{detectionError ? 'Tool detection could not complete. Use Refresh tool status to retry.' : 'Checking local tools…'}</p> : <>
      <dl className="facts tracking-readiness"><div><dt>Local profile</dt><dd>{tool?.detected ? 'Profile folder found' : 'No profile folder detected automatically'}</dd></div><div><dt>Version</dt><dd>{tool?.version ?? 'Unavailable'}</dd></div><div><dt>History discovery</dt><dd>{tool?.discovery === 'available' ? 'Available for supported local profiles' : tool?.discovery === 'unsupported' ? 'Not supported for this surface' : 'Unavailable'}</dd></div></dl>
      <p className="muted small">A profile folder does not verify installation, sign-in, or live tracking.</p>
      {tool?.message && <p className="muted small">{tool.message}</p>}
      <div className="setup-form"><label>Local agent profile<select value={sourceId} disabled={!!busy || !available} onChange={event => onSourceChange(event.target.value)}><option value="">Choose or register a profile</option>{sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
      <details className="workflow-details" open={sources.length === 0 || undefined}><summary>Register a local profile</summary>
        <form className="setup-form" onSubmit={event => { event.preventDefault(); if (!homePath.trim() || !label.trim()) return; void run('register', async signal => {
          const result = await identity.request<{ id: string }>(`${prefix}/native-sources`, { provider, label: label.trim(), homePath: homePath.trim() }, signal);
          if (signal.aborted) return;
          onSourceChange(result.id); setRefresh(value => value + 1); setLabel(''); setHomePath(''); setNotice('Local profile registered. Scan this project to find its sessions.');
        }); }}>
          <label>Profile label<input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} required placeholder="My local agent profile" disabled={!!busy} /></label>
          <label>Profile folder<input value={homePath} onChange={event => setHomePath(event.target.value)} maxLength={4096} required placeholder={tool?.defaultHomePath ?? 'Absolute native profile folder'} disabled={!!busy} /></label>
          {tool?.defaultHomePath && <button type="button" className="text-button" disabled={!!busy} onClick={() => { setHomePath(tool.defaultHomePath!); if (!label.trim()) setLabel(`${tool.label} local profile`); }}>Use detected profile folder</button>}
          <p className="muted small">{provider === 'custom' ? 'Choose this agent integration’s local project folder as its identity namespace. Register separate folders for unrelated integrations.' : provider === 'cursor' ? 'Choose the supported Cursor SDK store folder. This does not discover all Cursor IDE or CLI conversations.' : 'Choose the native tool’s profile folder, which holds its session metadata. The project folder remains the repository selected above.'}</p>
          <button className="button" disabled={!!busy || !available || !homePath.trim() || !label.trim()}>{busy === 'register' ? 'Registering…' : 'Register profile'}</button>
        </form>
      </details>
      {source && <><button className="text-button" disabled={!!busy || !available} onClick={() => void run('verify', async signal => { await identity.request(`${prefix}/native-sources/${encodeURIComponent(source.id)}/verify`, undefined, signal); if (!signal.aborted) { setRefresh(value => value + 1); setNotice('Profile checked. Native event delivery still needs separate verification.'); } })}>Recheck profile</button><p className="muted small">Profile: {source.status === 'ready' ? 'Ready to check' : source.status === 'needs-review' ? 'Review required' : 'Unavailable'}{source.message ? ` · ${source.message}` : ''}</p><p className="muted small">Last scan: {source.lastScanAt ? new Date(source.lastScanAt).toLocaleString() : 'Not scanned'}</p></>}
    </>}
    <h4>2. Find existing sessions</h4>
    <p className="muted small">A stored session is discovered history, not proof it is running. Select sessions to show in town; real events will update their activity.</p>
    <div className="setup-form"><label className="check-setting"><input type="checkbox" checked={includeOlder} disabled={!!busy} onChange={event => setIncludeOlder(event.target.checked)} /><span>Include history older than 30 days</span></label></div>
    <div className="setup-actions"><button className="button" disabled={!!busy || !available || !source || source.discovery === 'unsupported' || source.status === 'needs-review'} onClick={() => void run('scan', async signal => {
      const result = await identity.request<NativeSessionPage>(`${prefix}/native-sources/${encodeURIComponent(sourceId)}/scan`, { repoId, includeOlder }, signal);
      if (signal.aborted) return;
      setPage(result); setCursors([]); setRefresh(value => value + 1); setNotice(`${result.total} matching stored sessions. Activity stays unknown until events arrive.`);
    })}><Search size={15} />{busy === 'scan' ? 'Scanning local sessions…' : 'Scan existing sessions'}</button>
    {busy === 'scan' && <button className="button" onClick={() => {
      const current = generation.current;
      void identity.request(`${prefix}/native-sources/${encodeURIComponent(sourceId)}/cancel`).catch(cause => { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Cancellation could not be confirmed.'); });
      action.current?.abort(); action.current = null; setBusy(null); setNotice('Scan cancellation requested. Any sessions already saved remain available.');
    }}>Cancel scan</button>}
    <button className="text-button" disabled={!!busy || !available} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />Refresh tool status</button></div>
    {source?.nextScanCursor && source.lastScanRepoId === repoId && source.lastScanIncludeOlder === includeOlder && <button className="button" disabled={!!busy || !available} onClick={() => void run('scan', async signal => {
      const result = await identity.request<NativeSessionPage>(`${prefix}/native-sources/${encodeURIComponent(sourceId)}/scan`, { repoId, includeOlder, cursor: source.nextScanCursor }, signal);
      if (signal.aborted) return;
      setPage(result); setCursors([]); setRefresh(value => value + 1); setNotice(`${result.total} matching stored sessions saved. Continue discovery while more native history is available.`);
    })}>Find more sessions</button>}
    {!source && <p className="muted small">Choose a local profile before scanning.</p>}
    {source && source.discovery !== 'available' && <p className="form-notice">Existing-session discovery is unavailable for this profile. Recheck the profile or retry its scan after resolving the reported problem. Supported future-event tracking can be reviewed below.</p>}
    {inventoryLoading && <p className="muted small" role="status">Loading saved session inventory…</p>}
    {page && <section className="native-session-list" aria-label="Discovered local sessions"><p className="muted small" aria-live="polite">{page.total} saved matches, including child agents · Page {cursors.length + 1} · up to 25 per page</p>{!page.items.length && <p className="empty">No matching saved sessions on this page. Scan the selected profile or include older history.</p>}{page.items.map(session => {
      const agent = state.agents.find(item => item.id === session.agentId);
      const observed = !!session.observedAt || !!agent?.observation;
      return <article className="native-session-card" key={session.id}>
        <strong>{(agent ? agentDisplayName(agent) : session.nativeAgentName ?? session.title) ?? `${setup?.tools.find(item => item.provider === session.provider)?.label ?? session.provider} session`}</strong>
        {session.nativeAgentName && session.title && <p className="muted small">Session: {session.title}</p>}
        <span className="tracking-state">{observed ? `Last observed: ${activityLabel[agent?.activity ?? session.activity]}` : 'Discovered · activity unknown'}</span>
        <code className="repo-path">{session.nativeSessionId}</code>
        <small>History updated: {session.nativeUpdatedAt ? new Date(session.nativeUpdatedAt).toLocaleString() : 'Unavailable'}</small>
        {session.parentNativeSessionId && <small>Child session · parent <code>{session.parentNativeSessionId}</code></small>}
        {session.observedAt && <small>Last observed: {new Date(session.observedAt).toLocaleString()}</small>}
        {session.visible && !session.sceneVisible && <p className="muted small">Listed in inventory. This session is not currently displayed in the scene.</p>}
        <button className="button" aria-label={`${session.visible ? 'Hide' : 'Show'} session ${session.nativeSessionId}${session.visible ? '' : ' in town'}`} disabled={!!busy || !available} onClick={() => void run('visibility', async signal => {
          await identity.request(`${prefix}/native-sessions/${encodeURIComponent(session.id)}/visibility`, { visible: !session.visible }, signal);
          await readPage(cursors.at(-1), signal);
        })}>{session.visible ? 'Hide from town' : 'Show in town'}</button>
        <button className="text-button" disabled={!!busy || !available} aria-expanded={detail?.sessionId === session.id} onClick={() => {
          if (detail?.sessionId === session.id) { setDetail(null); return; }
          void run('detail', async signal => { const result = await identity.request<Agent>(`${prefix}/native-sessions/${encodeURIComponent(session.id)}/detail`, undefined, signal, 'GET'); if (!signal.aborted) setDetail({ sessionId: session.id, agent: result }); });
        }}>{detail?.sessionId === session.id ? 'Close session details' : 'View session details'}</button>
        {detail?.sessionId === session.id && <div className="native-session-detail"><h5>{agentDisplayName(detail.agent)}</h5><p>{detail.agent.task || 'Assignment unavailable'}</p><p>{detail.agent.evidence}</p><p className="muted small">Current activity is unknown when no recent events have arrived. Discovery does not establish task completion.</p><SessionReports state={state} identity={identity} agentId={detail.agent.id} available={available} />{detail.agent.files.length > 0 && <><h5>Reported files</h5><ul>{detail.agent.files.map(file => <li key={file}><code>{file}</code></li>)}</ul></>}</div>}
      </article>;
    })}<div className="setup-actions"><button className="button" disabled={!!busy || !available || cursors.length === 0} onClick={() => void run('page', async signal => { const previous = cursors.slice(0, -1); await readPage(previous.at(-1), signal); if (!signal.aborted) setCursors(previous); })}>Previous sessions</button><button className="button" disabled={!!busy || !available || !page.nextCursor} onClick={() => void run('page', async signal => { const cursor = page.nextCursor!; await readPage(cursor, signal); if (!signal.aborted) setCursors(current => [...current, cursor]); })}>Next sessions</button></div></section>}
    <div className="note"><ShieldCheck size={16} /><p>Only approved local profiles and this project are checked. Discovery does not resume sessions, send conversation history to a model, or use AI credits.</p></div>
  </section>;
}
