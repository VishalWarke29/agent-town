import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, LoaderCircle, RefreshCw } from 'lucide-react';
import { autoDetectTools, hookOverlapConflicts, hookOverlapMessage, toolDisplayName, type AutoDetectSurface, type ObservationConnection, type Repository, type StopSyncingConnectionStatus, type StopSyncingOperation, type StopSyncingPreview, type StopSyncingStep, type ToolDetectionApplyResponse, type ToolDetectionReview, type ToolDetectionSnapshot, type ToolDetectionStatus, type ToolSurface, type TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';

const MARKS: Record<AutoDetectSurface, { mark: string; cls: string }> = { codex: { mark: 'Cx', cls: '' }, claude: { mark: 'CC', cls: 'b' }, cursor: { mark: 'Cu', cls: 'c' }, 'copilot-cli': { mark: 'GH', cls: 'd' } };
const AUTO_TOOLS = autoDetectTools.map(tool => ({ ...tool, ...MARKS[tool.provider] }));
const toolFor = (provider: AutoDetectSurface) => AUTO_TOOLS.find(tool => tool.provider === provider)!;
/** A connection that last reported longer ago than this is not described as live. Exported so H0-14's slot-1
 * status line (below) shares the exact same "is this tool live" signal this panel's own tool rows use —
 * DES-02 section 3 calls for "one shared pure status function", never two places guessing independently. */
export const RECENT_MS = 10 * 60000;
const at = (iso?: string | null) => iso ? Date.parse(iso) : 0;
export const isReceiving = (connection: ObservationConnection, now: number) => connection.status === 'receiving' && !!connection.lastEventAt && now - Date.parse(connection.lastEventAt) <= RECENT_MS;
/** Only signals that clear themselves: a rejection newer than the last accepted event, or blocked local delivery. */
export function attention(connection: ObservationConnection): string | null {
  const rejection = (connection.diagnostics ?? []).filter(item => ['hook-overlap', 'source-home-mismatch'].includes(item.code) && at(item.lastSeenAt) > at(connection.lastEventAt)).sort((a, b) => at(b.lastSeenAt) - at(a.lastSeenAt))[0];
  if (rejection) return rejection.message;
  if (connection.delivery?.status === 'blocked') return connection.delivery.message ?? 'Local delivery is blocked; events are queued.';
  if (connection.newerEventCount) return `Restart Agent Town to read ${connection.newerEventCount} newer event${connection.newerEventCount === 1 ? '' : 's'}.`;
  return null;
}

/** Exported for the same reason as isReceiving/attention above: H0-14's status line phrases "last Xm ago"
 * itself (DES-02: "Receiving activity (last 3m ago)"), and must read the same clock the rest of this panel
 * does, never a second implementation that could drift. */
export function relativeTime(iso: string, now: number) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}
/** Repository-relative, forward-slash path; a connection id inside a file name is shortened so it is not read out. */
function displayPath(full: string, base: string) {
  const trimmedBase = base.replace(/[\\/]+$/, '');
  const relative = full.toLowerCase().startsWith(trimmedBase.toLowerCase()) ? full.slice(trimmedBase.length).replace(/^[\\/]+/, '') : full;
  return relative.replaceAll('\\', '/').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '…');
}
const timedOut = (cause: unknown) => cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
const failureText = (cause: unknown, fallback: string, slow: string) => timedOut(cause) ? slow : cause instanceof Error ? cause.message : fallback;

interface Notice { text: string; steps: { label: string; text: string }[] }
interface Problem { label: string; text: string }
type RowKind = 'connected' | 'revoked' | 'found' | 'no-activity' | 'not-installed';
interface Row { status: ToolDetectionStatus; kind: RowKind; live?: ObservationConnection }

/** The four tools with a verified local-history reader (see discoverNativeSessions).
 * Copilot in VS Code and custom connectors stay on the manual single-tool setup;
 * this panel only automates what can be honestly detected. */
export function LiveTrackingPanel({ state, identity, available, repository, onManualSetup }: { state: TownState; identity: IdentityController; available: boolean; repository: Repository; onManualSetup?: (provider?: ToolSurface) => void }) {
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}/observation/tool-detection`;
  const headingId = useId(), detailsId = useId(), notCheckedId = useId();
  // Connection state comes from the live snapshot, so a tool starting to receive (or being revoked) shows up
  // without another detection; the detection result only supplies what the snapshot cannot know.
  const everyConnection = (state.observation?.connections ?? []).filter(connection => connection.repoId === repository.id && connection.status !== 'revoked');
  const active = everyConnection.filter(connection => AUTO_TOOLS.some(tool => tool.provider === connection.provider));
  const liveByProvider = new Map<ToolSurface, ObservationConnection>(active.map(connection => [connection.provider, connection]));
  const connectedNow = liveByProvider.size;
  const [expanded, setExpanded] = useState(false);
  const [tools, setTools] = useState<ToolDetectionStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [extraSelected, setExtraSelected] = useState<Set<AutoDetectSurface>>(new Set());
  const [review, setReview] = useState<ToolDetectionReview | null>(null);
  const [checked, setChecked] = useState<Set<AutoDetectSurface>>(new Set());
  const [busy, setBusy] = useState<'review' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [now, setNow] = useState(Date.now());
  const [rebuiltPendingRestart, setRebuiltPendingRestart] = useState(false);
  // null until the first detection response: nothing is claimed missing before it is actually known.
  const [bridgeAvailable, setBridgeAvailable] = useState<boolean | null>(null);
  const bridgeMissing = bridgeAvailable === false;
  const bridgeNoticeId = useId();
  const mounted = useRef(true);
  const panelRef = useRef<HTMLElement>(null), headingRef = useRef<HTMLHeadingElement>(null), reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null), recheckRef = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null), errorRef = useRef<HTMLDivElement>(null);
  const afterReview = useRef<'primary' | 'notice' | 'error'>('primary'), wasReview = useRef(false), recheckFocus = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  // A rebuild can swap the hook bridge on disk while this service process keeps running its older
  // code — silent version skew is exactly what WS3-23's spool guard protects against, but the person
  // should still know a restart picks up the fix. This is a plain health read (no tool check, no session read),
  // and it only matters once a tool is connected: a project with no connection never asks (H0-02, D38).
  // With one, it asks when the panel appears and then every 30 seconds. It depends on `read`, which is stable,
  // and not on the whole identity controller, which is a new object on every render of the app and used to
  // start this over, with an immediate request, on each render.
  const hasConnection = everyConnection.length > 0;
  const { read } = identity;
  useEffect(() => {
    if (!hasConnection) { setRebuiltPendingRestart(false); return; }
    if (!available) return;
    let closed = false;
    const check = async () => {
      try { const health = await read<{ rebuiltPendingRestart?: boolean }>('/health'); if (!closed) setRebuiltPendingRestart(!!health.rebuiltPendingRestart); }
      catch { /* Transient; the next scheduled check retries. */ }
    };
    void check(); const interval = setInterval(() => void check(), 30000);
    return () => { closed = true; clearInterval(interval); };
  }, [read, available, hasConnection]);
  /** Focus is only moved when the person has not gone elsewhere in the meantime. */
  const focusUnlessMoved = (target: HTMLElement | null | undefined) => {
    const current = document.activeElement;
    if (!current || current === document.body || panelRef.current?.contains(current)) target?.focus();
  };

  // The one button that starts a check. Nothing checks this computer on its own: not connecting a project, not opening
  // its house, not expanding this section (H0-02, D38). It reads "Check this computer" until a check has produced a result.
  const checkLabel = tools ? 'Recheck tools' : 'Check this computer';
  const detect = async (fromButton = false) => {
    recheckFocus.current = fromButton;
    setLoading(true); setError(null);
    try {
      const result = await identity.request<ToolDetectionSnapshot>(`${prefix}?repoId=${encodeURIComponent(repository.id)}`, undefined, AbortSignal.timeout(45000), 'GET');
      if (mounted.current) {
        setTools(result.tools);
        setBridgeAvailable(result.bridge?.available ?? true);
        const withSessions = result.tools.filter(tool => tool.state === 'found').length, idle = result.tools.filter(tool => tool.state === 'no-activity').length;
        setAnnouncement(`Checked local tools. ${withSessions} with sessions for this project, ${idle} with a settings folder found but no activity, ${result.tools.filter(tool => tool.state === 'connected').length} connected.`);
      }
    } catch (cause) { if (mounted.current) setError(failureText(cause, 'Local tool detection could not complete.', `Checking took longer than expected. Choose ${checkLabel} to try again.`)); }
    finally { if (mounted.current) setLoading(false); }
  };

  // Focus follows the view swap, otherwise the pressed button unmounts and focus falls to the page body.
  useEffect(() => {
    if (review) reviewHeadingRef.current?.focus();
    else if (wasReview.current) {
      const target = afterReview.current === 'notice' ? noticeRef.current : afterReview.current === 'error' ? errorRef.current : primaryRef.current;
      focusUnlessMoved(target ?? headingRef.current);
      afterReview.current = 'primary';
    }
    wasReview.current = review !== null;
  }, [review]);
  useEffect(() => { if (!loading && recheckFocus.current) { recheckFocus.current = false; focusUnlessMoved(recheckRef.current); } }, [loading]);
  // A review prepared before another path connected one of its tools is out of date; ask for a fresh one.
  useEffect(() => {
    // Not while applying: the service saves each connection (and the live snapshot shows it) before it answers.
    if (busy !== null || !review || !review.items.some(item => liveByProvider.has(item.provider))) return;
    afterReview.current = 'notice'; setReview(null);
    setNotice({ text: 'Connections changed while you were reviewing. Review again to see the current state.', steps: [] });
  });

  const rows: Row[] = (tools ?? []).map(status => {
    const live = liveByProvider.get(status.provider);
    if (live) return { status, kind: 'connected', live };
    return { status, kind: status.state === 'connected' ? 'revoked' : status.state };
  });
  const reviewable = rows.filter(row => row.kind === 'found' || (row.kind === 'no-activity' && extraSelected.has(row.status.provider)));

  const startReview = async () => {
    if (!reviewable.length) return;
    setBusy('review'); setError(null); setProblems([]); setNotice(null);
    try {
      const result = await identity.request<ToolDetectionReview>(`${prefix}/review`, { repoId: repository.id, providers: reviewable.map(row => row.status.provider) }, AbortSignal.timeout(20000));
      // Nothing is pre-ticked (D38, D40): finding a tool is not a choice to watch it. Apply stays off until the person ticks one.
      if (mounted.current) { setReview(result); setChecked(new Set()); }
    } catch (cause) { if (mounted.current) setError(failureText(cause, 'Preparing the review could not complete.', 'Preparing the review took longer than expected. Try again.')); }
    finally { if (mounted.current) setBusy(null); }
  };
  const cancelReview = () => { afterReview.current = 'primary'; setReview(null); };
  const checkedItems = review ? review.items.filter(item => checked.has(item.provider)) : [];
  const chosen = new Set<ToolSurface>(checkedItems.map(item => item.provider));
  // The review's own list plus whatever is connected now: a tool connected elsewhere since the review still counts.
  const overlap = review ? hookOverlapConflicts([...(review.activeProviders ?? []), ...everyConnection.map(connection => connection.provider), ...chosen]).filter(conflict => chosen.has(conflict.provider) || conflict.blockedBy.some(provider => chosen.has(provider))) : [];
  const applyReview = async () => {
    if (!review || overlap.length) return;
    const items = checkedItems.map(item => ({ provider: item.provider, connectionId: item.connectionId }));
    if (!items.length) return;
    setBusy('apply'); setError(null); setProblems([]); setNotice(null);
    // Disabled buttons cannot hold focus or hear Escape, so keep focus inside the review while it works.
    reviewHeadingRef.current?.focus();
    let refresh = true;
    try {
      // Up to four tools, each with protected-storage writes that can take seconds on a slow machine.
      const result = await identity.request<ToolDetectionApplyResponse>(`${prefix}/apply`, { repoId: repository.id, items }, AbortSignal.timeout(90000));
      const done = result.results.filter(item => item.applied), failed = result.results.filter(item => !item.applied);
      if (mounted.current) {
        afterReview.current = done.length ? 'notice' : 'error'; setReview(null); setExtraSelected(new Set());
        if (done.length) setNotice({ text: `Hooks added for ${done.length} tool${done.length === 1 ? '' : 's'}. Each tool shows “Receiving activity” below once its first event arrives.`, steps: done.map(item => ({ label: toolFor(item.provider).label, text: item.nextStep ?? '' })).filter(step => step.text) });
        setProblems(failed.map(item => ({ label: toolFor(item.provider).label, text: item.error ?? 'It could not be connected.' })));
      }
    } catch (cause) {
      refresh = timedOut(cause);
      if (mounted.current) {
        setReview(null);
        // The service may still finish after the browser gives up, so a timeout is a notice plus a fresh look, not a failure.
        if (timedOut(cause)) { afterReview.current = 'notice'; setNotice({ text: 'Connecting is taking longer than expected. It may still finish in the background; the list shows what is set up now.', steps: [] }); }
        else { afterReview.current = 'error'; setError(cause instanceof Error ? cause.message : 'Applying the reviewed hooks failed.'); }
      }
    }
    if (refresh) await detect();
    if (mounted.current) setBusy(null);
  };
  const toggleChecked = (provider: AutoDetectSurface) => setChecked(current => { const next = new Set(current); if (next.has(provider)) next.delete(provider); else next.add(provider); return next; });
  const toggleExtra = (provider: AutoDetectSurface) => {
    const included = !extraSelected.has(provider);
    setExtraSelected(current => { const next = new Set(current); if (included) next.add(provider); else next.delete(provider); return next; });
    setAnnouncement(`${toolFor(provider).label} ${included ? 'will be included when you review' : 'removed from the review'}.`);
  };

  const toolRow = (row: Row) => {
    const tool = toolFor(row.status.provider);
    const selected = extraSelected.has(tool.provider);
    let dot = 'off', detail = 'Not found on this machine', problem: string | null = null;
    if (row.kind === 'no-activity') { dot = 'amber'; detail = row.status.message ? `Settings folder found — ${row.status.message}` : 'Settings folder found — no activity for this project yet'; }
    else if (row.kind === 'found') { dot = 'found'; detail = `${row.status.sessionCountExact ? '' : 'At least '}${row.status.sessionCount} session${row.status.sessionCount === 1 ? '' : 's'} found for this project`; }
    else if (row.kind === 'revoked') detail = 'This connection was revoked. Its hook may still be installed: remove it in manual setup, then choose Recheck tools.';
    else if (row.kind === 'connected' && row.live) {
      problem = attention(row.live);
      const last = row.live.status === 'receiving' ? row.live.lastEventAt : null;
      dot = problem ? 'amber' : isReceiving(row.live, now) ? 'live' : 'grey';
      detail = problem ? `Needs attention: ${problem}` : isReceiving(row.live, now) ? `Receiving activity (last event ${relativeTime(last!, now)})` : last ? `No recent activity (last event ${relativeTime(last, now)})` : 'Hook applied, waiting for first activity';
    }
    return <div className="tool-row" key={tool.provider}>
      <span className={`tool-mark ${tool.cls}`} aria-hidden="true">{tool.mark}</span>
      <span className="tool-main">
        <span className="tool-name">{tool.label}</span>
        <span className="tool-detail"><span className={`status-dot ${dot}`} aria-hidden="true" />{detail}</span>
        {row.kind === 'no-activity' && selected && <span className="tool-next">Will be included when you review.</span>}
        {row.kind === 'connected' && !problem && row.status.nextStep && row.live?.status !== 'receiving' && <span className="tool-next">{row.status.nextStep}</span>}
        {problem && onManualSetup && <button type="button" className="text-button" onClick={() => onManualSetup(tool.provider)}>Review {tool.label} tracking</button>}
      </span>
      {row.kind === 'no-activity' && <button type="button" className="setup-anyway" aria-label={selected ? `Undo setting up ${tool.label}` : `Set up anyway for ${tool.label}`} disabled={!available} onClick={() => toggleExtra(tool.provider)}>{selected ? 'Undo' : 'Set up anyway'}</button>}
    </div>;
  };

  const liveText = loading ? 'Checking local files for this project.' : busy === 'review' ? 'Preparing the exact file changes.' : busy === 'apply' ? 'Connecting the selected tools.' : '';
  const everyToolResolved = rows.length > 0 && rows.every(row => row.kind === 'connected' || row.kind === 'not-installed');
  const receivingNow = active.filter(connection => isReceiving(connection, now)).length;
  const needAttention = active.filter(connection => attention(connection)).length;
  const notReceiving = connectedNow - receivingNow - needAttention;

  return <section className="tracking-panel" ref={panelRef} aria-labelledby={headingId}>
    <div className="tracking-head">
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>Live tracking: <strong>{connectedNow} of {AUTO_TOOLS.length} tools connected</strong>{notReceiving > 0 && ` · ${notReceiving} not receiving yet`}{needAttention > 0 && ` · ${needAttention} need${needAttention === 1 ? 's' : ''} attention`}</h3>
      <button type="button" className="text-button" aria-expanded={expanded} aria-controls={detailsId} disabled={!available} onClick={() => setExpanded(current => !current)}>
        {expanded ? 'Hide details' : 'Show details'}{expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
    </div>
    <p className="sr-only" role="status" aria-live="polite">{liveText || announcement}</p>
    {rebuiltPendingRestart && <p className="form-notice" role="status">Agent Town was rebuilt. Restart it to use the new version.</p>}
    {bridgeMissing && <div className="form-notice" role="status" id={bridgeNoticeId}>
      <p>Agent Town's tracking helper is not built on this computer, so tracking cannot start yet.</p>
      <details><summary>Advanced</summary><p>Run <code>npm run build</code> (or start it with <code>npm start</code>), then choose Recheck tools.</p></details>
    </div>}
    {!available && <p className="muted small">Reconnect to the local service to check or change tracking.</p>}
    {(error || problems.length > 0) && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
      {error && <p>{error}</p>}
      {problems.length > 0 && <><p>{problems.length === 1 ? 'This tool could not be connected:' : 'These tools could not be connected:'}</p><ul className="setup-steps">{problems.map(problem => <li key={problem.label}><strong>{problem.label}</strong>: {problem.text}</li>)}</ul></>}
    </div>}
    {notice && <div className="form-notice" role="status" tabIndex={-1} ref={noticeRef}>
      <p>{notice.text}</p>
      {notice.steps.length > 0 && <><p>Next step in each tool:</p><ul className="setup-steps">{notice.steps.map(step => <li key={step.label}><strong>{step.label}</strong>: {step.text}</li>)}</ul></>}
    </div>}
    {expanded && <div id={detailsId} aria-busy={loading || busy !== null}>
      {!review && <>
        {loading && !tools
          ? <div className="tool-rows" aria-hidden="true">{AUTO_TOOLS.map(tool => <div className="tool-row" key={tool.provider}><span className={`tool-mark ${tool.cls}`}>{tool.mark}</span><span className="tool-main"><span className="tool-name">{tool.label}</span><span className="tool-detail"><span className="status-dot pending spin" />Checking local files…</span></span></div>)}</div>
          : rows.length > 0 ? <>
            {everyToolResolved && connectedNow > 0 && <p className="tracking-summary">{receivingNow === connectedNow ? 'Every tool found on this machine is receiving activity.' : 'Hooks are added for every tool found on this machine.'}</p>}
            {rows.every(row => row.kind === 'not-installed') && <p className="tracking-summary">None of these tools were found on this machine. Install one and choose Recheck tools, or use manual setup for other tools.</p>}
            <div className="tool-rows">{rows.map(toolRow)}</div>
          </>
          : !tools && <p className="muted" id={notCheckedId}>Nothing has been checked yet. Press the button to see which tools (Codex, Claude Code, Cursor, Copilot CLI) are on this computer and how many saved sessions each has for this project. It only reads. It writes nothing to your project, sets nothing up and uses no AI.</p>}
        <div className="setup-actions">
          {reviewable.length > 0 && <button type="button" ref={primaryRef} className="button primary" disabled={busy !== null || loading || !available}
            aria-disabled={bridgeMissing || undefined} aria-describedby={bridgeMissing ? bridgeNoticeId : undefined}
            onClick={() => { if (bridgeMissing) { setAnnouncement('Agent Town\'s tracking helper is not built on this computer, so tracking cannot start yet.'); return; } void startReview(); }}>
            {busy === 'review' && <LoaderCircle size={15} className="spin" aria-hidden="true" />}Review &amp; connect {reviewable.length} tool{reviewable.length === 1 ? '' : 's'}</button>}
          {/* One button for both moments, so keyboard focus stays on it while the first check runs and after it. The only start of a check. 44 px like the design record asks for a primary control (styles.css is not this item's). */}
          <button type="button" ref={recheckRef} className={tools ? 'text-button' : 'button primary'} style={tools ? undefined : { minHeight: 44 }} disabled={loading || busy !== null || !available} aria-describedby={!tools && !loading ? notCheckedId : undefined} onClick={() => void detect(true)}>{tools && <RefreshCw size={13} aria-hidden="true" />}{loading && !tools ? 'Checking this computer…' : checkLabel}</button>
          {onManualSetup && <button type="button" className="text-button" onClick={() => onManualSetup()}>Manual setup for other tools</button>}
        </div>
      </>}
      {review && <div className="tool-review-list" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (busy === null) cancelReview(); } }}>
        <div className="review-head"><h4 ref={reviewHeadingRef} tabIndex={-1}>Review before connecting</h4><button type="button" className="text-button" disabled={busy !== null} onClick={cancelReview}>Cancel</button></div>
        <p className="review-note">{checkedItems.length === 0 ? 'No tool is ticked yet. ' : ''}Nothing is written until you apply below. Each tool's exact file change is shown in full.</p>
        <fieldset disabled={busy !== null}>
          <legend className="sr-only">Choose the tools to connect</legend>
          {review.items.map(item => {
            const tool = toolFor(item.provider);
            return <div className="tool-review" key={item.provider}>
              <label className="tool-review-head">
                <input type="checkbox" className="checkbox" checked={checked.has(item.provider)} onChange={() => toggleChecked(item.provider)} />
                <span className={`tool-mark ${tool.cls}`} aria-hidden="true">{tool.mark}</span>
                <span><span className="tool-review-name">{tool.label}</span><span className="tool-review-path">will add a hook to <code>{displayPath(item.configPath, repository.localPath ?? '')}</code></span></span>
              </label>
              <pre className="setup-code" tabIndex={0} role="region" aria-label={`Hook file change for ${tool.label}`}>{item.config}</pre>
              <p className="tool-next">After applying: {item.nextStep}</p>
            </div>;
          })}
        </fieldset>
        {overlap.length > 0 && <p className="form-error" role="alert">{hookOverlapMessage(overlap)}</p>}
        <div className="write-summary" aria-live="polite" aria-atomic="true">{checkedItems.length === 0 ? 'Nothing selected. Choose at least one tool to connect.' : <>You are about to write to {checkedItems.length} file{checkedItems.length === 1 ? '' : 's'}: {checkedItems.flatMap((item, index) => [index ? ', ' : '', <code key={item.provider}>{displayPath(item.configPath, repository.localPath ?? '')}</code>])}</>}</div>
        <button type="button" className="button primary" disabled={!checkedItems.length || overlap.length > 0 || busy !== null || !available} onClick={() => void applyReview()}>{busy === 'apply' && <LoaderCircle size={15} className="spin" aria-hidden="true" />}Apply reviewed hooks ({checkedItems.length})</button>
      </div>}
    </div>}
  </section>;
}

// ============================================================================================================
// H0-14: the house inspector's "Watching" status line and "Stop watching this project" (DES-02 section 3 and
// 5.3). Kept in this file — the only file that already imports and mounts it for the Watch section — rather
// than split across a new module, so the focus-trapped dialog and the announcer below stay a small, isolated
// piece that UX-31's shared Dialog/Announcer components can replace in one change (H0-14 risk note); nothing
// else in the app imports these two exports besides App.tsx's inspector.
// ============================================================================================================

export type WatchDotState = 'receiving' | 'waiting' | 'attention';
/** DES-02 section 3's per-tool status vocabulary, exact words, for the compact line this item adds to the
 * house inspector's Facts slot (and, being the same component, the List view). Deliberately NOT the same
 * strings toolRow() above renders ("Receiving activity (last event 3m ago)", "Hook applied, waiting for
 * first activity") — those are pinned by tests/browser/tracking-onboarding.spec.ts, a file this item does
 * not own, and changing them would be an unauthorized rewrite of H0-02/H0-04's already-reviewed work. Both
 * places read the same isReceiving/attention/RECENT_MS signal above, so they can never disagree about WHICH
 * state a connection is in — only how each screen phrases it. */
export function watchLine(connection: ObservationConnection, now: number): { state: WatchDotState; dot: 'live' | 'amber' | 'grey'; text: string } {
  const problem = attention(connection);
  if (problem) return { state: 'attention', dot: 'amber', text: `Needs attention: ${problem}` };
  if (isReceiving(connection, now)) return { state: 'receiving', dot: 'live', text: `Receiving activity (last ${relativeTime(connection.lastEventAt!, now)})` };
  return { state: 'waiting', dot: 'grey', text: 'Waiting for first activity' };
}

/** The project-relative settings file one connection's own hook entries live in, mirrored from
 * apps/service/src/observation/setup.ts's observationSetup() (read 2026-09-25: claude -> .claude/settings.
 * local.json, codex -> .codex/hooks.json, cursor -> .cursor/hooks.json, everything else, including
 * copilot-cli, -> .github/hooks/agent-town-<connection id>.json; custom has none). The Stop-watching preview
 * route (apps/service/src/observation/service.ts, not owned by this item) only returns a path when it judged
 * the file unsafe to edit; the confirm dialog still has to name every file it is about to touch ("names
 * project-relative files and tools" — H0-14 acceptance), so it is recomputed here for display only and never
 * used to decide what the stop job actually does. Re-check this mapping if setup.ts's ever changes. */
export function hookConfigRelativePath(provider: ToolSurface, connectionId: string): string | null {
  if (provider === 'claude') return '.claude/settings.local.json';
  if (provider === 'codex') return '.codex/hooks.json';
  if (provider === 'cursor') return '.cursor/hooks.json';
  if (provider === 'custom') return null;
  return `.github/hooks/agent-town-${connectionId}.json`;
}

const STOP_STEP_LABEL: Record<StopSyncingStep, string> = {
  'entries-removed': "removing Agent Town's settings entries",
  neutralized: 'pausing this connection',
  drained: 'saving its last activity',
  revoked: 'turning off watching',
  cleaned: 'cleaning up local files',
};

function joinToolLabels(providers: readonly ToolSurface[]): string {
  const names = providers.map(provider => toolDisplayName[provider]);
  if (names.length <= 1) return names[0] ?? '';
  return names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Preview-time and post-run connection rows share this shape; a preview's `entries` (event name + count)
 * doubles as its "how many would be removed" figure since `removedEntries` there is the removal's own dry
 * prediction (planHookRemoval never writes). */
function entriesFigure(connection: StopSyncingConnectionStatus): string {
  if (connection.hooks === 'unsupported') return 'No automatic settings file for this connector';
  if (connection.hooks === 'left') return connection.removedEntries > 0 ? `${connection.removedEntries} ${connection.removedEntries === 1 ? 'entry' : 'entries'} · could not be safely edited` : 'Could not be safely edited';
  if (connection.removedEntries === 0) return 'No Agent Town lines found';
  return `${connection.removedEntries} ${connection.removedEntries === 1 ? 'entry' : 'entries'}`;
}

/** A native <dialog> with its own focus trap and Escape handling, mirroring EvidenceDialog.tsx's proven
 * pattern (own file, not reused here on purpose — see the module header above). Mounted once for the whole
 * lifetime of the confirm -> running -> settled flow, so remounting it never re-triggers the initial-focus
 * step or drops the open native modal. */
function StopDialogShell({ initialFocusRef, onEscape, children }: { initialFocusRef: { current: HTMLButtonElement | null }; onEscape: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    opener.current = document.activeElement as HTMLElement | null;
    dialog.showModal();
    initialFocusRef.current?.focus();
    return () => { dialog.close(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The base .evidence-dialog class sets `height: auto` (not the browser default `fit-content` a plain
  // <dialog> would otherwise get), which combined with its own fixed `inset: 6vh 5vw` stretches the box to
  // that full area regardless of content — fine for EvidenceDialog's other callers (RunnerPanel,
  // TelemetryPanel), whose content is usually long enough to fill it, but it leaves a tall dead area below
  // this dialog's much shorter confirm/settled screens. `height: fit-content` restores real shrink-to-fit
  // sizing for this dialog only (margin: auto from the class still centers it vertically); `maxHeight`
  // keeps very long content (an interrupted preview with several connections) inside the 6vh top/bottom
  // inset and lets `.evidence-content`'s own `overflow: auto` scroll it, never overflowing the viewport.
  return <dialog ref={ref} className="evidence-dialog glass" style={{ maxWidth: 'min(440px, calc(100vw - 32px))', height: 'fit-content', maxHeight: 'calc(100vh - 12vh)' }} aria-label="Stop watching this project" aria-modal="true"
    onCancel={event => { event.preventDefault(); onEscape(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEscape(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')).filter(node => node.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}><div className="evidence-content" style={{ padding: '20px 22px 22px' }}>{children}</div></dialog>;
}

type StopPhase = 'closed' | 'confirm' | 'starting' | 'running' | 'settled';

/** H0-14: the "Watching" status line plus "Stop watching this project" and its dialog, for the house
 * inspector's Facts slot (slot 1, DES-02 section 1: "The status line ... and the 'Stop watching this
 * project' button live inside slot 1, above the fact rows ... They are the only controls in slot 1."). The
 * dialog's own open/running state is a plain useState of THIS component, which App.tsx's RepositoryFacts
 * always mounts once a project has a local path (never only when a connection currently exists) — the risk
 * note this item's plan carries by name: "Mount the dialog above the 'has a connection' condition: the
 * first revoke commit removes the line mid-flow." A connection revoking mid-stop must never unmount this
 * component and lose the running job's progress. */
export function WatchingStatus({ state, identity, available, repository }: { state: TownState; identity: IdentityController; available: boolean; repository: Repository }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const connections = (state.observation?.connections ?? []).filter(connection => connection.repoId === repository.id);
  // Scoped to the four auto-detected tools, matching the lede's own watchedTools filter in App.tsx: a
  // manually connected "custom" surface stays a Connections-only concept until this line's own item says
  // otherwise, but Stop watching's dialog below still lists every connection the job would actually touch.
  const watchedAuto = connections.filter(connection => connection.status !== 'revoked' && autoDetectTools.some(tool => tool.provider === connection.provider));

  const [phase, setPhase] = useState<StopPhase>('closed');
  const [preview, setPreview] = useState<StopSyncingPreview | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [operation, setOperation] = useState<StopSyncingOperation | null>(null);
  const [stopWithoutEditing, setStopWithoutEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const keepRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Set synchronously by openDialog/closeDialog (never through an effect, which would still be one render
  // behind a same-tick close): guards start()'s async POST completion, the only in-flight request here with
  // no dependency-array cleanup of its own, so a Keep-watching/Escape close mid-request can never silently
  // reopen this dialog into "running" a moment later once that request lands.
  const closedRef = useRef(true);
  // A per-invocation token for openDialog()'s own preview GET (H0-14 fixer review, finding n=3): closedRef
  // alone cannot tell one open from the next. A fast Escape-then-reopen before the first GET resolves leaves
  // it in flight with closedRef back to false (the dialog is open again, just a second time); without this
  // token, that first, now-stale response could still land and silently overwrite the second open's fresh
  // preview. Each call captures the counter's value at its own start and only ever applies its own result
  // while it is still the most recent one requested.
  const openSeq = useRef(0);
  const previouslyReceiving = useRef(new Set<string>());
  useEffect(() => {
    for (const connection of watchedAuto) {
      const receiving = isReceiving(connection, now);
      if (receiving && !previouslyReceiving.current.has(connection.id)) { previouslyReceiving.current.add(connection.id); setAnnouncement(`${toolDisplayName[connection.provider]} is now receiving activity.`); }
      else if (!receiving) previouslyReceiving.current.delete(connection.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedAuto.map(connection => `${connection.id}:${connection.status}:${connection.lastEventAt}`).join(','), now]);

  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}/observation/stop-syncing`;

  const openDialog = async () => {
    closedRef.current = false;
    const seq = ++openSeq.current;
    setPhase('confirm'); setError(null); setPreview(null); setStopWithoutEditing(false); setOperationId(null); setOperation(null); setBusy(true);
    try {
      const result = await identity.request<StopSyncingPreview>(`${prefix}?repoId=${encodeURIComponent(repository.id)}`, undefined, AbortSignal.timeout(20000), 'GET');
      // Only this call's own result, and only while it is still the most recent open (see openSeq above).
      if (mounted.current && !closedRef.current && openSeq.current === seq) setPreview(result);
    } catch (cause) { if (mounted.current && !closedRef.current && openSeq.current === seq) setError(failureText(cause, 'Preparing Stop watching could not complete.', 'Checking what Stop watching would do took longer than expected. Try again.')); }
    finally { if (mounted.current && openSeq.current === seq) setBusy(false); }
  };
  const closeDialog = () => { closedRef.current = true; setPhase('closed'); };

  const start = async (options: { discard: boolean; refresh: boolean }) => {
    setPhase('starting'); setError(null); setBusy(true);
    try {
      const usable = options.refresh ? await identity.request<StopSyncingPreview>(`${prefix}?repoId=${encodeURIComponent(repository.id)}`, undefined, AbortSignal.timeout(20000), 'GET') : preview;
      if (!usable) throw new Error('Review Stop watching again before continuing.');
      if (mounted.current && !closedRef.current) setPreview(usable);
      const result = await identity.request<{ operationId: string; repoId: string }>(prefix, { repoId: repository.id, reviewToken: usable.reviewToken, editFiles: !stopWithoutEditing, discard: options.discard }, AbortSignal.timeout(20000), 'POST');
      // The job itself now runs server-side regardless of what the UI does next; only the LOCAL reaction
      // (switching this dialog to its running/poll view) is skipped once the person closed it in the meantime.
      if (!mounted.current || closedRef.current) return;
      setOperationId(result.operationId); setOperation(null); setPhase('running'); setAnnouncement('Stopping watching started.');
    } catch (cause) {
      if (!mounted.current || closedRef.current) return;
      // SW-6: a controlled, reassuring sentence, not the raw server/network message — every path this catch
      // can reach (the preview refresh or the POST itself throwing) means the job never actually started, so
      // "nothing was removed" is true regardless of the technical reason. A retry after an earlier PARTIAL
      // result is the one case where something did already change, so that variant says "nothing more".
      setError(timedOut(cause) ? 'Starting Stop watching took longer than expected. Try again.' : options.refresh ? 'Trying again did not finish. Nothing more was changed.' : 'Stopping did not finish. Nothing was removed and your sessions are as they were.');
      setPhase(options.refresh ? 'settled' : 'confirm');
    } finally { if (mounted.current) setBusy(false); }
  };

  // Poll while a job runs. Its own current step per connection is read live from state.observation.
  // stopSyncingProgress below (pushed through the app's normal town-state stream, so it is already true
  // after a reload without this poll); this poll exists for the job's OVERALL status and its richer
  // per-connection results once finished (StopSyncingOperation.connections), which are not part of that
  // durable, per-connection-only progress record.
  useEffect(() => {
    if (phase !== 'running' || !operationId) return;
    let disposed = false;
    const poll = async () => {
      try {
        const result = await identity.request<StopSyncingOperation>(`${prefix}/${encodeURIComponent(operationId)}`, undefined, AbortSignal.timeout(15000), 'GET');
        if (disposed || !mounted.current) return;
        setOperation(result);
        if (result.status !== 'running') { setPhase('settled'); setAnnouncement(result.status === 'stopped' ? 'Stop watching finished.' : result.status === 'partial' ? 'Stop watching finished partially.' : 'Stopping was cancelled.'); }
      } catch (cause) { if (!disposed && mounted.current) setError(failureText(cause, "Checking Stop watching's progress could not complete. It may still be running.", 'Checking progress took longer than expected. It may still be running.')); }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => { disposed = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, operationId]);

  const cancel = async () => {
    if (!operationId) return;
    try { await identity.request<{ cancellationRequested: boolean }>(`${prefix}/${encodeURIComponent(operationId)}/cancel`, undefined, AbortSignal.timeout(10000), 'POST'); }
    catch { /* Best-effort; the next poll reflects the true state regardless. */ }
  };
  // The result banner takes focus when it appears, so the Cancel button unmounting (running -> settled)
  // never silently drops focus back to the page (mirrors this file's own reviewHeadingRef pattern above).
  useEffect(() => { if (phase === 'settled') resultRef.current?.focus({ preventScroll: true }); }, [phase]);

  const stepOf = (connectionId: string) => state.observation?.stopSyncingProgress?.find(item => item.connectionId === connectionId) ?? null;
  // H0-32: watchedAuto above filters OUT every revoked connection, so once Stop watching has revoked every
  // connection for this project but a later step (typically clean-up) never fully completed, watchedAuto alone
  // goes to 0 and this whole component (including the only way back into that unfinished work) would silently
  // disappear on close/reload. The durable per-connection record — independent of watchedAuto, and still true
  // after a restart — is what keeps this recoverable. Reads the persisted `retryable` flag (result !== 'stopped'),
  // not just result === 'partial': a connection can also be left revoked with result still null (an unexpected
  // clean-up failure interrupted before it could even be marked partial), and that must be just as recoverable.
  const stopSyncingRecovery = connections.some(connection => stepOf(connection.id)?.retryable === true);
  if (!watchedAuto.length && !stopSyncingRecovery && phase === 'closed') return null;
  const rowsSource: StopSyncingConnectionStatus[] | null = operation?.connections ?? preview?.connections ?? null;
  const residentsShown = state.agents.filter(agent => agent.repoId === repository.id).length;
  const interrupted = phase === 'confirm' && !!preview && preview.connections.some(connection => stepOf(connection.connectionId)?.result === null);
  const anyUneditable = !!preview && preview.connections.some(connection => connection.hooks === 'left');
  const totalRemaining = operation?.connections.reduce((sum, connection) => sum + (connection.eventsRemaining ?? 0), 0) ?? 0;
  // H0-32: which of the settled, fully-stopped connections actually had their settings file edited versus
  // left in place (the owner's "stop without editing files" choice, or a file that could not safely be
  // edited) — the settled banner below must never claim entries were removed for a connection this is true of.
  const settledLeftBehind = phase === 'settled' && operation?.status === 'stopped' ? operation.connections.filter(connection => connection.hooks === 'left') : [];
  // Distinct from the above: a connection can also be 'absent' (nothing of Agent Town's was ever there to
  // remove) or 'unsupported' (a custom connector, which never had an automatic hook file at all) — neither
  // of those is "left behind", but neither is "removed" either, and the banner must not fold them into a
  // false "entries were removed" claim just because they are not in settledLeftBehind.
  const settledRemoved = phase === 'settled' && operation?.status === 'stopped' ? operation.connections.some(connection => connection.hooks === 'removed') : false;

  return <>
    <div className="tool-rows" data-slot="watching" style={{ marginBottom: 14 }}>
      {watchedAuto.map(connection => { const line = watchLine(connection, now); return <p key={connection.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, margin: '4px 0', color: '#445140' }}><span className={`status-dot ${line.dot}`} aria-hidden="true" /><span>{toolDisplayName[connection.provider]} · {line.text}</span></p>; })}
      {(watchedAuto.length > 0 || stopSyncingRecovery) && <button type="button" className="button" style={{ minHeight: 44, marginTop: 6 }} disabled={!available || phase === 'starting' || phase === 'running'} onClick={() => void openDialog()}>{watchedAuto.length > 0 ? 'Stop watching this project' : 'Finish stopping this project'}</button>}
    </div>
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

    {phase !== 'closed' && <StopDialogShell initialFocusRef={keepRef} onEscape={closeDialog}>
      <p className="eyebrow">{repository.name.toUpperCase()} · WATCH SESSIONS</p>
      <h2 style={{ fontSize: 19, margin: '6px 0 14px' }}>{interrupted ? 'Resume stopping this project?' : 'Stop watching this project?'}</h2>

      {(phase === 'confirm' || phase === 'starting') && <>
        {/* "Keep watching" is always present, first, at this fixed spot — StopDialogShell's initial-focus
            effect runs synchronously right after this dialog's first mount, before the preview request
            below can possibly have resolved, so the ref it focuses must already be in the DOM at that
            instant (H0-14 acceptance: "focus starts on Keep watching"). */}
        <div className="setup-actions" style={{ marginBottom: 14 }}>
          {/* Disabled only while a POST to actually start the job is in flight (phase 'starting'): once that
              request lands it moves this same component to 'running' regardless of whether the dialog is
              still open, so letting it close mid-request would silently reopen itself a moment later. The
              read-only preview GET (phase 'confirm') has no such side effect, so Keep watching stays live
              through it. */}
          <button type="button" className="button" style={{ minHeight: 44 }} ref={keepRef} disabled={phase === 'starting'} onClick={closeDialog}>Keep watching</button>
        </div>
        {busy && !preview && <p style={{ fontSize: 12 }} role="status">Checking what Stop watching would do…</p>}
        {error && <p className="form-error" role="alert" style={{ fontSize: 12 }}>{error}{!preview && <> <button type="button" className="text-button" style={{ fontSize: 12 }} onClick={() => void openDialog()}>Try again</button></>}</p>}
        {preview && <>
          {interrupted && <p className="form-notice" style={{ fontSize: 12 }} role="status">Agent Town may have been interrupted while stopping this project before. Some tools may already be stopped. Choose Resume to finish.</p>}
          <p style={{ fontSize: 12 }}>Agent Town will:</p>
          <ul style={{ fontSize: 12, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Remove Agent Town's lines from its own settings files:
              <div style={{ marginTop: 6, marginBottom: 4 }}>{preview.connections.map(connection => { const path = hookConfigRelativePath(connection.provider, connection.connectionId); return <div key={connection.connectionId} style={{ fontSize: 12, margin: '3px 0' }}><code style={{ fontSize: 12 }}>{path ?? `${toolDisplayName[connection.provider]} (no automatic settings file)`}</code>{path && <> · {entriesFigure(connection)}</>}</div>; })}</div>
            </li>
            <li>Stop reading activity from {joinToolLabels(preview.connections.map(connection => connection.provider))}.</li>
          </ul>
          {anyUneditable && <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, margin: '10px 0', padding: '8px 0' }}>
            <input type="checkbox" className="checkbox" checked={stopWithoutEditing} onChange={event => setStopWithoutEditing(event.target.checked)} />
            <span>At least one settings file could not be safely edited (it is too large or open elsewhere). Stop without editing files: Agent Town stops reading activity, but its lines stay in that file until you remove them yourself.</span>
          </label>}
          <p className="write-summary" style={{ fontSize: 12 }}>Hides the {residentsShown} session{residentsShown === 1 ? '' : 's'} shown for this project in town. They stay in history and you can show them again. Saved reports and history are kept. Agent Town removes only its own lines from those settings files.</p>
          {preview.automaticManagerProcessing && <p className="form-notice" style={{ fontSize: 12 }} role="status">The manager processes reports automatically. Any report this stop saves stays saved and readable, but is held from that automatic pass.</p>}
          <p className="muted small" style={{ fontSize: 12 }}>A session already open in a tool may keep sending until you restart it; Agent Town ignores it.</p>
          <div className="setup-actions">
            <button type="button" className="button primary" style={{ minHeight: 44 }} disabled={busy} onClick={() => void start({ discard: false, refresh: false })}>{busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}{interrupted ? 'Resume' : 'Stop watching'}</button>
          </div>
          <p className="muted small" style={{ fontSize: 12 }}>Stopping uses no AI and deletes no saved reports.</p>
        </>}
      </>}

      {phase === 'running' && <>
        <p role="status" aria-live="polite" style={{ fontSize: 12 }}>Stopping. This takes a few seconds.</p>
        <div style={{ margin: '10px 0' }}>{(rowsSource ?? []).map(connection => { const progress = stepOf(connection.connectionId); const done = connection.result !== null; return <p key={connection.connectionId} style={{ fontSize: 12, margin: '4px 0' }}>{toolDisplayName[connection.provider]}: {done ? (connection.result === 'stopped' ? 'stopped' : 'partial') : progress?.step ? STOP_STEP_LABEL[progress.step] : 'waiting to start'}</p>; })}</div>
        <div className="setup-actions">
          <button type="button" className="button" style={{ minHeight: 44 }} disabled={operation ? !operation.cancellable : true} onClick={() => void cancel()}>{operation?.cancellable ? 'Cancel between connections' : 'Finishing this connection…'}</button>
        </div>
      </>}

      {phase === 'settled' && operation && <>
        {operation.status === 'stopped' && <>
          <p ref={resultRef} tabIndex={-1} role="status" style={{ fontSize: 12 }}>Stopped watching {joinToolLabels(operation.connections.map(connection => connection.provider))}. {settledLeftBehind.length
            ? `Agent Town stopped reading activity; its settings entries were left in place for ${joinToolLabels(settledLeftBehind.map(connection => connection.provider))} — remove ${settledLeftBehind.length === 1 ? 'it' : 'them'} yourself when ready.`
            : settledRemoved ? "Agent Town's entries were removed; open sessions may need a restart to fully stop."
            : 'Agent Town had no entries to remove for these tools; open sessions may need a restart to fully stop.'} Reports and sessions are kept.</p>
        </>}
        {operation.status === 'partial' && <>
          <p ref={resultRef} tabIndex={-1} className="form-notice" role="status" style={{ fontSize: 12 }}>Stop watching is partial. {operation.connections.filter(connection => connection.result === 'partial').length} of {operation.connections.length} connections still need attention. Reports and sessions are kept.</p>
        </>}
        {operation.status === 'cancelled' && <p ref={resultRef} tabIndex={-1} className="form-notice" role="status" style={{ fontSize: 12 }}>Stopping was cancelled. {operation.connections.filter(connection => connection.result === 'stopped').length} of {operation.connections.length} connections are stopped; the rest still watch. Choose Stop watching this project again to finish.</p>}
        <div style={{ margin: '10px 0' }}>{operation.connections.map(connection => <p key={connection.connectionId} style={{ fontSize: 12, margin: '4px 0' }}>{toolDisplayName[connection.provider]}: {connection.result === 'stopped' ? 'Stopped' : connection.result === 'partial' ? 'Partial · not fully stopped' : 'Not started'} · {entriesFigure(connection)}{connection.eventsRemaining ? ` · ${connection.eventsRemaining} event${connection.eventsRemaining === 1 ? '' : 's'} still unread` : ''}</p>)}</div>
        {error && <p className="form-error" role="alert" style={{ fontSize: 12 }}>{error}</p>}
        <div className="setup-actions">
          {operation.status !== 'stopped' && <button type="button" className="button primary" style={{ minHeight: 44 }} disabled={busy} onClick={() => void start({ discard: false, refresh: true })}>{busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}Try again</button>}
          {operation.status === 'partial' && totalRemaining > 0 && <button type="button" className="button" style={{ minHeight: 44 }} disabled={busy} onClick={() => void start({ discard: true, refresh: true })}>Discard {totalRemaining} unread event{totalRemaining === 1 ? '' : 's'} and finish</button>}
          <button type="button" className="button" style={{ minHeight: 44 }} ref={keepRef} disabled={busy} onClick={closeDialog}>{operation.status === 'stopped' ? 'Close' : 'Keep watching'}</button>
        </div>
      </>}
    </StopDialogShell>}
  </>;
}
