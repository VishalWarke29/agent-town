import { agentDisplayName, agentSearchText } from './agentDisplayName';
import { useCallback, useEffect, useRef, useState } from 'react';
import { activityLabel, toolDisplayName, type Agent, type NativeSession, type NativeSessionPage, type Snapshot, type TownState } from '@agent-town/contracts';
import { ArrowUpRight, Search, Users } from 'lucide-react';
import { isActivityStale } from './world/interaction';
import { sessionHierarchy } from './sessionHierarchy';
import { ChildActivity, ChildAgentControl, sessionSummary } from './SessionPresentation';
import { RESIDENT_STOPPED_LABEL, RESIDENTS_EMPTY_LINE_1, RESIDENTS_EMPTY_LINE_2 } from './houseCopy';

/**
 * H0-15: "Hide these N sessions" / "N sessions hidden · Show" (DES-02 RS-3). This component is reused,
 * unmodified, by the world room roster, the List view and the house inspector (App.tsx, not owned by this
 * item), and none of those three call sites pass this component an `identity` object today — only `state`,
 * `repoId`, `connected` and a couple of callbacks. Threading `identity`/`available` through would mean
 * editing App.tsx, which this item does not own (another item in the same wave does). These three small
 * helpers below make exactly the two calls this feature needs (a plain GET, and a POST authorized the same
 * way useTown.ts's own `command()` authorizes its POST: a fresh CSRF token from `/api/v1/session`, which
 * needs no token itself and simply confirms the session cookie already set by the running app) without
 * reimplementing identity/session management. A later item that threads `identity` into this component's
 * props can delete these and pass `identity.request` down instead; nothing else here would need to change.
 */
async function residentsSessionCsrf(signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
  const result: unknown = await response.json().catch(() => null);
  const csrf = result && typeof result === 'object' ? (result as { csrf?: unknown }).csrf : undefined;
  if (!response.ok || typeof csrf !== 'string') throw new Error('Could not confirm this browser session. Refresh and try again.');
  return csrf;
}
function residentsRequestError(result: unknown): string {
  const message = result && typeof result === 'object' ? (result as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : 'This request could not be completed.';
}
async function residentsGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { signal });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(residentsRequestError(result));
  return result as T;
}
async function residentsPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const csrf = await residentsSessionCsrf(signal);
  const response = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body ?? {}), signal });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(residentsRequestError(result));
  return result as T;
}
function hiddenSessionLabel(session: NativeSession): string {
  return session.nativeAgentName ?? session.title ?? `${toolDisplayName[session.provider]} session`;
}

export function RepositoryAgents({ state, repoId, connected, selectedId, onSelect, onWatch, showChildAgents = false, onShowChildAgents, showControls = true }: { state: TownState; repoId: string; connected: boolean; selectedId?: string; onSelect: (id: string) => void; onWatch?: (repoId: string) => void; showChildAgents?: boolean; onShowChildAgents?: (value: boolean) => void; showControls?: boolean }) {
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, []);
  const savedResidents = state.agents.filter(agent => agent.repoId === repoId);
  const hierarchy = sessionHierarchy(savedResidents);
  const residents = showChildAgents ? savedResidents : hierarchy.primary;
  const filtered = residents.filter(agent => `${agentSearchText(agent)} ${toolLabel(agent)}`.toLowerCase().includes(query.toLowerCase()));
  const sections = [
    { name: 'Discovered · activity unknown', agents: filtered.filter(agent => agent.activity === 'unknown') },
    { name: 'At work and resting', agents: filtered.filter(agent => ['working', 'testing', 'waiting', 'idle'].includes(agent.activity)) },
    { name: 'Reporting away from the workroom', agents: filtered.filter(agent => agent.activity === 'reporting') },
    { name: 'Review and inactive sessions', agents: filtered.filter(agent => ['review', 'offline', 'failed', 'cancelled'].includes(agent.activity)) },
  ];
  function toolLabel(agent: Agent) {
    const run = state.runner?.runs.find(candidate => candidate.id === agent.id);
    return run?.tool === 'openai-api' ? 'OpenAI API worker' : run?.tool === 'anthropic-api' ? 'Anthropic API worker' : agent.provider;
  }

  // H0-15: native-backed external residents of this house (an observed hook session with a bound native
  // profile, or a session only ever discovered by a scan) are what "Hide these N sessions" hides — the exact
  // same set the server's hide-all decides (native-inventory.ts's hidePlan), minus the "waiting for a free
  // slot" sessions that never made it into state.agents at all (an edge case at the 200-resident cap that a
  // client-side count cannot see; the server's own reported count after hiding is always the authoritative
  // one). Cursor's legacy hook sessions have neither field and are correctly left out: hide-all skips them.
  const nativeBackedCount = savedResidents.filter(agent => agent.observation?.nativeSourceId || agent.discovery?.sourceId).length;
  const localProject = state.workspace.mode !== 'demo' && state.repositories.some(repo => repo.id === repoId && repo.localPath);
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}/observation`;

  const [confirmHide, setConfirmHide] = useState(false);
  const [hideBusy, setHideBusy] = useState(false);
  const [hideError, setHideError] = useState<string | null>(null);
  const [hiddenPage, setHiddenPage] = useState<NativeSessionPage | null>(null);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  const [hiddenIncludeOlder, setHiddenIncludeOlder] = useState(false);
  const [showBusyId, setShowBusyId] = useState<string | null>(null);
  const [showNotice, setShowNotice] = useState<string | null>(null);
  const hideButtonRef = useRef<HTMLButtonElement>(null);
  const hideConfirmRef = useRef<HTMLButtonElement>(null);
  const hiddenSummaryRef = useRef<HTMLElement>(null);
  const [pendingSummaryFocus, setPendingSummaryFocus] = useState(false);
  // H0-33: a request-sequencing token, the same pattern LiveTrackingPanel.tsx's own `openSeq` already uses.
  // Every loadHiddenPage() call (a fresh load, a "Load more" page, the includeOlder checkbox's reload, or the
  // disclosure's own first-open fetch) captures the counter's value at its own start and only ever applies
  // its own result while it is still the most recent one requested — so a slow response left over from
  // project A cannot land after the house has moved on to project B, or after a newer request for the same
  // house has already superseded it.
  const hiddenSeq = useRef(0);

  const loadHiddenPage = useCallback(async (options: { includeOlder?: boolean; cursor?: string; append?: boolean } = {}) => {
    if (!localProject) { setHiddenPage(null); return; }
    const seq = ++hiddenSeq.current;
    setHiddenLoading(true); setHiddenError(null);
    try {
      const includeOlder = options.includeOlder ?? hiddenIncludeOlder;
      const params = new URLSearchParams({ repoId, visibility: 'hidden', includeOlder: String(includeOlder) });
      if (options.cursor) params.set('cursor', options.cursor);
      const page = await residentsGet<NativeSessionPage>(`${prefix}/native-sessions?${params}`);
      if (hiddenSeq.current !== seq) return; // superseded by a newer request while this one was in flight
      setHiddenPage(previous => options.append && previous ? { ...page, items: [...previous.items, ...page.items] } : page);
    } catch (cause) {
      if (hiddenSeq.current !== seq) return;
      setHiddenError(cause instanceof Error ? cause.message : 'The hidden session list could not be loaded.');
    } finally { if (hiddenSeq.current === seq) setHiddenLoading(false); }
  }, [localProject, prefix, repoId, hiddenIncludeOlder]);
  // H0-07 fix, extended by H0-33: this must never fetch merely because the component mounts or repoId
  // changes — tests/browser/local-folder.spec.ts (and, less directly, session-names.spec.ts and
  // session-hierarchy.spec.ts) pin that nothing above an explicit Watch/hide/show action sends a request for
  // a freshly opened house. loadHiddenPage() above is still only ever called from an explicit trigger: a
  // hide/show action below, the includeOlder checkbox, a "Load more" click, or this disclosure's own
  // onToggle handler the first time a user actually opens it (see the JSX below) — never from a bare mount.
  // H0-33 closes the gap that reliance on those triggers alone used to leave: the "N hidden · Show" badge
  // itself no longer depends on any of them having fired. It reads hiddenSessionCount below, a read-time
  // overlay the server now carries on every snapshot and live push (store.ts's withHiddenCounts), so a house
  // whose sessions were hidden in an earlier page load shows its badge again immediately on a fresh load —
  // with zero additional requests. Only the LIST underneath (hiddenPage) still needs an explicit fetch.
  useEffect(() => { hiddenSeq.current++; setConfirmHide(false); setHideError(null); setHiddenError(null); setShowNotice(null); setHiddenIncludeOlder(false); setHiddenPage(null); }, [repoId, localProject]);
  // A result banner takes focus once it actually reflects the action that produced it (DES-02 section 6):
  // requestAnimationFrame right after the triggering await is not reliable here, because the <details> this
  // moves focus into can be mounting for the very first time from data a second, still-pending fetch
  // (loadHiddenPage) supplies — an effect keyed on that fetch settling is what a commit is guaranteed to
  // have already happened before.
  useEffect(() => { if (pendingSummaryFocus && !hiddenLoading) { hiddenSummaryRef.current?.focus(); setPendingSummaryFocus(false); } }, [pendingSummaryFocus, hiddenLoading, hiddenPage]);

  const startHide = () => { setHideError(null); setConfirmHide(true); requestAnimationFrame(() => hideConfirmRef.current?.focus()); };
  const cancelHide = () => { setConfirmHide(false); requestAnimationFrame(() => hideButtonRef.current?.focus()); };
  const confirmHideAll = async () => {
    setHideBusy(true); setHideError(null);
    try {
      await residentsPost(`${prefix}/native-sessions/hide-all`, { repoId });
      setConfirmHide(false);
      await loadHiddenPage();
      setPendingSummaryFocus(true);
    } catch (cause) { setHideError(cause instanceof Error ? cause.message : 'These sessions could not be hidden.'); }
    finally { setHideBusy(false); }
  };
  const showSession = async (session: NativeSession) => {
    setShowBusyId(session.id); setShowNotice(null); setHiddenError(null);
    try {
      await residentsPost<Snapshot>(`${prefix}/native-sessions/${encodeURIComponent(session.id)}/visibility`, { visible: true });
      await loadHiddenPage();
      setPendingSummaryFocus(true);
    } catch (cause) { setShowNotice(cause instanceof Error ? cause.message : 'This session could not be shown.'); }
    finally { setShowBusyId(null); }
  };
  // H0-33: prefer the live overlay (always current, including a house whose sessions were hidden in an
  // earlier page load); fall back to an already-fetched page's own hiddenTotal only when the overlay is
  // absent (an older or hand-built Snapshot, e.g. some test fixtures) so nothing regresses before every
  // producer of a Snapshot carries the new field. Both describe the exact same count (every hidden session
  // for this repository, across every source, with no 30-day window — see hiddenTotal's own contract note).
  const hiddenSessionCount = state.repositories.find(repo => repo.id === repoId)?.hiddenSessionCount ?? hiddenPage?.hiddenTotal ?? 0;

  return <section className="repository-agents" data-testid="repository-agents" data-slot="residents" data-repo-id={repoId} aria-label="Agents in this repository">
    <div className="section-summary"><h3><Users size={17} />Residents</h3><span>{state.workspace.mode === 'demo' ? `${residents.length} sample` : `${sessionSummary(savedResidents)} in town`}</span></div>
    {localProject && nativeBackedCount > 0 && !confirmHide && <button ref={hideButtonRef} type="button" className="button" style={{ minHeight: 44 }} disabled={!connected || hideBusy} onClick={startHide}>Hide these {nativeBackedCount} session{nativeBackedCount === 1 ? '' : 's'}</button>}
    {localProject && confirmHide && <div className="setup-actions" role="group" aria-label="Confirm hiding sessions">
      <p role="status">Hide these {nativeBackedCount} session{nativeBackedCount === 1 ? '' : 's'}? They leave town but stay in history. You can show any of them again.</p>
      {hideError && <p className="form-error" role="alert">{hideError}</p>}
      <button ref={hideConfirmRef} type="button" className="button primary" style={{ minHeight: 44 }} disabled={hideBusy} onClick={() => void confirmHideAll()}>{hideBusy ? 'Hiding…' : `Yes, hide these ${nativeBackedCount} sessions`}</button>
      <button type="button" className="text-button" disabled={hideBusy} onClick={cancelHide}>Cancel</button>
    </div>}
    {localProject && hiddenSessionCount > 0 && <details data-testid="hidden-sessions" onToggle={event => { if (event.currentTarget.open && !hiddenPage && !hiddenLoading) void loadHiddenPage(); }}>
      <summary ref={hiddenSummaryRef} style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer', fontWeight: 600 }}>{hiddenSessionCount} session{hiddenSessionCount === 1 ? '' : 's'} hidden · Show</summary>
      <p className="muted small">Hidden sessions leave town but stay in history. Sessions hidden in the last 30 days are listed here; older ones stay hidden until you include them below.</p>
      {showNotice && <p className="form-notice" role="status">{showNotice}</p>}
      {hiddenError && <p className="form-error" role="alert">{hiddenError}</p>}
      {hiddenLoading && <p className="muted small" role="status">Loading hidden sessions…</p>}
      {hiddenPage && hiddenPage.items.length > 0 && <ul className="session-children">{hiddenPage.items.map(session => <li key={session.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ overflowWrap: 'anywhere' }}>{hiddenSessionLabel(session)}</span>
        <button type="button" className="text-button" disabled={!connected || showBusyId === session.id} onClick={() => void showSession(session)}>{showBusyId === session.id ? 'Showing…' : 'Show in town'}</button>
      </li>)}</ul>}
      {hiddenPage && !hiddenLoading && hiddenPage.items.length === 0 && <p className="muted small">No hidden sessions from the last 30 days{hiddenIncludeOlder ? '.' : '. Include older sessions below to see more.'}</p>}
      {hiddenPage && hiddenPage.items.length < hiddenPage.total && <p className="muted small">Showing the first {hiddenPage.items.length} of {hiddenPage.total} matching hidden sessions.</p>}
      {/* H0-33: real pagination — a "26+ rows accessible" acceptance criterion the earlier static sentence
          above could not satisfy on its own. Appends to the existing list rather than replacing it
          (loadHiddenPage's own `append` option), and only renders while the server says more remain. */}
      {hiddenPage?.nextCursor && <button type="button" className="text-button" style={{ minHeight: 44 }} disabled={hiddenLoading} onClick={() => void loadHiddenPage({ cursor: hiddenPage.nextCursor ?? undefined, append: true })}>{hiddenLoading ? 'Loading…' : 'Load more hidden sessions'}</button>}
      <div className="setup-form"><label className="check-setting"><input type="checkbox" checked={hiddenIncludeOlder} onChange={event => { const value = event.target.checked; setHiddenIncludeOlder(value); void loadHiddenPage({ includeOlder: value }); }} /><span>Include sessions hidden more than 30 days ago</span></label></div>
    </details>}
    {showControls && onShowChildAgents && <ChildAgentControl count={hierarchy.children.length} checked={showChildAgents} onChange={onShowChildAgents} />}
    {!connected && <p className="room-notice" role="status">Reconnecting · showing last reported activity.</p>}
    {residents.length > 0 && <label className="search"><Search size={16} /><input aria-label="Find a repository agent" placeholder="Search names, tools or tasks" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    {sections.map(section => section.agents.length > 0 && <div key={section.name} className="resident-group"><h4>{section.name}</h4>{section.agents.map(agent => {
      const sourceRevoked = agent.observation && state.observation?.connections.some(source => source.id === agent.observation!.connectionId && source.status === 'revoked');
      const stale = isActivityStale(agent, connected && !sourceRevoked, now);
      const stamp = agent.observation?.sourceTime ?? agent.updatedAt;
      // A revoked/stopped resident gets the same neutral colour as the other terminal activities
      // (idle/offline/cancelled, styles.css) instead of whatever colour its last-known activity happened to
      // carry (H0-14 fixer review, finding n=2): otherwise a session stopped right after "working" kept the
      // active green family even though its own text already reads "Stopped watching".
      return <div key={agent.id}><button type="button" className={`agent-row ${agent.id === selectedId ? 'selected' : ''}`} data-agent-id={agent.id} aria-label={`Inspect ${agentDisplayName(agent)}`} onClick={() => onSelect(agent.id)}>
        <span className="resident-avatar" style={{ backgroundColor: agent.color }} aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <span className="agent-row-body"><strong>{agentDisplayName(agent)}<small>{toolLabel(agent)}</small></strong><span className={`status ${sourceRevoked ? 'status-offline' : `status-${agent.activity}`}`}>{sourceRevoked ? RESIDENT_STOPPED_LABEL : activityLabel[agent.activity]}</span>{stale && <span className="stale-tag">Last reported · stale</span>}<span className="resident-task">{agent.task || 'Assignment unavailable'}</span>{agent.activity === 'unknown' && !agent.observation ? <small>Discovered history · no activity received</small> : <small>Reported {Number.isFinite(Date.parse(stamp)) ? new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'time unavailable'}</small>}{(agent.observation?.parentSessionId ?? agent.discovery?.parentNativeSessionId) && <small>Child session · parent {agent.observation?.parentSessionId ?? agent.discovery?.parentNativeSessionId}</small>}</span><ArrowUpRight size={15} />
      </button>
      {hierarchy.unresolved.some(candidate => candidate.id === agent.id) && <p className="muted small">Parent unavailable</p>}
      {!showChildAgents && (hierarchy.childrenById.get(agent.id)?.length ?? 0) > 0 && <details className="session-child-disclosure"><summary>{hierarchy.childrenById.get(agent.id)!.length} child agents</summary><ul className="session-children">{hierarchy.childrenById.get(agent.id)!.map(child => <li key={child.id}><button className="text-button" aria-label={`Inspect child · ${agentDisplayName(child)}`} onClick={() => onSelect(child.id)}>{agentDisplayName(child)}</button><ChildActivity agent={child} state={state} connected={connected} now={now} /></li>)}</ul></details>}
      </div>;
    })}</div>)}
    {!residents.length && <div className="room-empty"><Users size={24} />{connected ? <><h3>{RESIDENTS_EMPTY_LINE_1}</h3><p>{RESIDENTS_EMPTY_LINE_2}</p></> : <><h3>Session information is unavailable</h3><p>The last snapshot contains no sessions. Reconnect before treating this room as empty.</p></>}</div>}
    {/* H0-08: a quiet text link, not a primary/promotional button — it only opens the house inspector's
        already-built Watch sessions (optional) slot, expanded; nothing is requested by opening it. */}
    {/* Review finding #2 (H0-08 fixer pass, 2026-09-25): this link is not nested under .room-context's
        `.text-button { min-height: 44px }` override (styles.css:500), which only covers the room-header
        instance, and .repository-agents is outside this fixer's owned files, so the 44px DES-02 §6 touch
        target is set inline here instead of adding a new stylesheet rule. */}
    {state.workspace.mode !== 'demo' && state.repositories.some(repo => repo.id === repoId && repo.localPath) && onWatch && <button className="text-button" style={{ minHeight: 44 }} onClick={() => onWatch(repoId)}>Watch sessions (optional)</button>}
    {residents.length > 0 && filtered.length === 0 && <p className="empty">{!showChildAgents && hierarchy.children.length ? "No primary sessions match. Enable Show child agents to search child names." : "No sessions match your search."}</p>}
    <p className="muted small">Activity reflects received updates. A response finishing does not accept a task or acknowledge a manager report.</p>
  </section>;
}
