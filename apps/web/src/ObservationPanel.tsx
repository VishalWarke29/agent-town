import { useEffect, useRef, useState } from 'react';
import { Clipboard, Plug, Radio, ShieldCheck, Unplug } from 'lucide-react';
import type { NativeToolStatus, ObservationSetup, ToolSurface, TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';
import { NativeTrackingPanel } from './NativeTrackingPanel';
import { agentDisplayName } from './agentDisplayName';

const surfaces: { id: ToolSurface; label: string }[] = [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude Code' }, { id: 'cursor', label: 'Cursor' }, { id: 'copilot-vscode', label: 'Copilot in VS Code' }, { id: 'copilot-cli', label: 'Copilot CLI' }, { id: 'custom', label: 'Other agent · custom connector' }];

type StageStatus = 'ok' | 'unknown' | 'blocked';
interface DiagnosticStage { name: string; status: StageStatus; detail: string }

/** Turns today's already-computed signals into an ordered checklist so a user can see
 * which stage is stuck instead of one ambiguous "review in the native tool" message.
 * This reads existing server state only (detected tools, stored source binding, hook
 * file presence, spool depth, last receipt, agent activity). Live verification that the
 * native tool's own hook list actually contains this hook is a documented future step
 * (docs/41-live-tracking-completion-plan.md) and is NOT probed here — nothing below is
 * a live/verified check of the native tool itself. */
function diagnosticStages(setup: ObservationSetup, tool: NativeToolStatus | null, state: TownState): DiagnosticStage[] {
  const connection = setup.connection, readiness = setup.readiness;
  const agent = state.agents.find(candidate => candidate.observation?.connectionId === connection.id);
  const pending = connection.delivery?.pendingEvents ?? null;
  return [
    { name: 'Tool and surface identified', status: tool ? (tool.detected ? 'ok' : 'blocked') : 'unknown',
      detail: tool ? (tool.detected ? `${tool.label} profile folder detected automatically.` : `${tool.label} profile folder was not detected automatically. Register its folder manually below.`) : 'Local tool detection has not completed for this surface yet.' },
    { name: 'Runtime readiness checked', status: !readiness ? 'unknown' : readiness.sourceBinding === 'resolved' ? 'ok' : readiness.sourceBinding === 'ambiguous' || readiness.sourceBinding === 'unavailable' ? 'blocked' : 'unknown',
      detail: !readiness ? 'Readiness has not been checked yet.' : readiness.sourceBinding === 'resolved' ? 'A selected local profile is bound to this connection.' : readiness.sourceBinding === 'declared' ? 'A profile is selected but not yet confirmed by a native event.' : readiness.sourceBinding === 'ambiguous' ? 'Multiple profiles could match this connection. Review and select one.' : 'No local profile is selected for this connection.' },
    { name: 'Hook attempted', status: !readiness ? 'unknown' : readiness.configured ? 'ok' : 'blocked',
      detail: !readiness ? 'Hook status has not been checked yet.' : readiness.configured ? (readiness.nativeTrustRequired ? 'Hook file is on disk. Native trust still needs review in the tool.' : 'Hook file is on disk.') : 'No hook file was found on disk yet. Apply the reviewed hook below.' },
    { name: 'Event queued', status: connection.delivery?.status === 'blocked' ? 'blocked' : connection.lastEventAt || (pending !== null && pending > 0) ? 'ok' : 'unknown',
      detail: connection.delivery?.status === 'blocked' ? connection.delivery.message ?? 'Local delivery is blocked.' : pending !== null ? `${pending} event${pending === 1 ? '' : 's'} pending at last check.` : 'No local spool activity observed yet.' },
    { name: 'Event committed', status: connection.lastEventAt ? 'ok' : connection.status === 'revoked' ? 'blocked' : 'unknown',
      detail: connection.lastEventAt ? `Last committed event: ${new Date(connection.lastEventAt).toLocaleString()}.` : connection.status === 'revoked' ? 'This connection was revoked before an event was committed.' : 'No event has been committed yet.' },
    { name: 'Character updated', status: agent && agent.activity !== 'unknown' ? 'ok' : 'unknown',
      detail: agent && agent.activity !== 'unknown' ? `${agentDisplayName(agent)} last updated ${new Date(agent.updatedAt).toLocaleString()}.` : agent ? `${agentDisplayName(agent)} is linked, but activity is still unknown.` : 'No character is linked to this connection yet.' },
  ];
}

const stageLabel: Record<StageStatus, string> = { ok: 'Confirmed', unknown: 'Not yet confirmed', blocked: 'Blocked' };
function DiagnosticChecklist({ stages }: { stages: DiagnosticStage[] }) {
  return <ol className="facts diagnostic-checklist">{stages.map((stage, index) => <li key={stage.name}><strong>{index + 1}. {stage.name}</strong> · <span className={`stage-status stage-${stage.status}`}>{stageLabel[stage.status]}</span><p className="muted small">{stage.detail}</p></li>)}</ol>;
}

export function ObservationPanel({ state, identity, available, selectedRepoId, onRepoChange, initialProvider, initialSourceId, initialSessionId }: { state: TownState; identity: IdentityController; available: boolean; selectedRepoId?: string | null; onRepoChange?: (id: string) => void; initialProvider?: ToolSurface; initialSourceId?: string; initialSessionId?: string }) {
  const local = state.repositories.filter(repo => repo.localPath);
  // H0-09 (D38): nothing is pre-selected or read until the owner asks. A blank tool/project means
  // "Choose a tool" / "Choose a project" below; only an inspected session presets both at once.
  const [provider, setProvider] = useState<ToolSurface | ''>(initialProvider ?? '');
  const [repoId, setRepoId] = useState(selectedRepoId ?? '');
  const [sourceId, setSourceId] = useState(initialSourceId ?? '');
  const [toolStatus, setToolStatus] = useState<NativeToolStatus | null>(null);
  const [label, setLabel] = useState('');
  const [setup, setSetup] = useState<ObservationSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The manual setup form (and its NativeTrackingPanel, which reads a local tool profile) mounts only
  // once the person has actually opened it: from an inspected session, from "Manual setup for other
  // tools" inside a house's Watch section (H0-08; both pass a hint below), or from the "Set up
  // tracking" button in this drawer. Opening Connections alone never does.
  const [formOpen, setFormOpen] = useState(() => !!(initialProvider || selectedRepoId));
  const localIds = local.map(repo => repo.id).join(',');
  useEffect(() => { if (selectedRepoId && localIds.split(',').includes(selectedRepoId)) { setRepoId(selectedRepoId); setFormOpen(true); } }, [selectedRepoId, localIds]);
  useEffect(() => { setSourceId(''); }, [repoId, provider]);
  useEffect(() => {
    const ids = localIds ? localIds.split(',') : [];
    setRepoId(current => ids.includes(current) ? current : '');
  }, [localIds]);
  // Apply a specific inspected agent's provider/source only when the inspector actually
  // supplied one; a context-less visit to this panel (this drawer's own "Set up tracking"
  // button, or Connections opened generically) must not force it back to a default tool or
  // clear whatever the user already selected. Declared after the blanket sourceId reset
  // above so this hint is the final word in the same commit.
  useEffect(() => { if (initialProvider) { setProvider(initialProvider); setSourceId(initialSourceId ?? ''); setFormOpen(true); } }, [initialProvider, initialSourceId]);
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}/observation/connections`;
  const connections = state.observation?.connections ?? [];
  const reviewedRevoked = !!setup && (setup.connection.status === 'revoked' || connections.some(connection => connection.id === setup.connection.id && connection.status === 'revoked'));
  useEffect(() => {
    if (!reviewedRevoked) return;
    setSetup(null);
    setNotice('This observation connection was revoked. Its setup is closed; prepare a new connection before applying a hook.');
  }, [reviewedRevoked]);
  const act = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Observation setup could not be completed.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice('Copied. Review the configuration before applying it.'); }
    catch { setNotice('Clipboard access is unavailable. Select and copy the setup text below.'); }
  };

  return <section className="observation-setup" aria-label="Observe existing agents">
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="form-notice" role="status">{notice}</p>}
    {!local.length ? <p className="empty">Connect a local repository before setting up observation. A remote repository alone has no local hook destination.</p> : formOpen ? <>
    <div className="feature-heading"><Radio size={25} /><h3 id="tracking-setup-heading" tabIndex={-1}>Set up local agent tracking</h3><p>Find sessions already working on your project, then enable future activity updates. One independently identified session keeps one character across messages and resumed work.</p></div>
    {initialSessionId && <p className="muted small">Opened from session <code className="mono">{initialSessionId}</code> · matched to {surfaces.find(surface => surface.id === provider)?.label ?? provider}. Confirm this is the intended tool before continuing.</p>}
    <div className="setup-form"><label>Agent tool<select value={provider} disabled={busy} onChange={event => setProvider(event.target.value as ToolSurface | '')}><option value="" disabled>Choose a tool</option>{surfaces.map(surface => <option key={surface.id} value={surface.id}>{surface.label}</option>)}</select></label>
      <label>Repository for observation<select value={repoId} disabled={busy} onChange={event => { setRepoId(event.target.value); onRepoChange?.(event.target.value); }} required><option value="" disabled>Choose a project</option>{local.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label></div>
    {repoId ? <NativeTrackingPanel state={state} identity={identity} available={available && !busy} repoId={repoId} provider={provider} sourceId={sourceId} onSourceChange={setSourceId} onToolStatus={setToolStatus} /> : <p className="muted small">Choose a project above to see its detected local profile.</p>}
    <h4>3. Review and enable future activity</h4><p className="muted small">Billing accounts and native subscriptions are separate. Monitoring uses zero AI calls.</p>
    {!sourceId && <p className="muted small">Select a local profile above to match discovered history and future events to the same character. Without a profile, that identity link remains unverified.</p>}
    <form className="setup-form" onSubmit={event => { event.preventDefault(); if (!repoId || !provider || !label.trim()) return; void act(async () => { const result = await identity.request<ObservationSetup>(prefix, { provider, repoId, label: label.trim(), ...(sourceId ? { nativeSourceId: sourceId } : {}) }); if (mounted.current) { setSetup(result); setLabel(''); } }); }}>
      <label>Connection label<input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} required placeholder="My coding session" /></label>
      <button className="button primary" disabled={!available || busy || !provider || !local.some(repo => repo.id === repoId) || !label.trim()}><Plug size={16} />Prepare observation setup</button>
    </form></> : <div className="setup-actions"><button className="button primary" onClick={() => setFormOpen(true)}><Plug size={16} />Set up tracking</button></div>}
    {connections.length > 0 && <div className="observation-connections"><h3 className="subheading">Observation connections</h3>{connections.map(connection => <article className="observation-card" key={connection.id}>
      <strong>{connection.label}</strong><p>{surfaces.find(surface => surface.id === connection.provider)?.label} · {state.repositories.find(repo => repo.id === connection.repoId)?.name ?? 'Repository unavailable'}</p>
      <dl><div><dt>Events</dt><dd>{connection.status === 'revoked' ? 'Revoked' : connection.status === 'receiving' ? 'Receiving events' : 'Waiting for first event'}</dd></div><div><dt>Profile identity</dt><dd>{connection.binding === 'resolved' ? 'Resolved' : connection.binding === 'ambiguous' ? 'Needs review · source ambiguous' : connection.nativeSourceId ? 'Selected · awaiting native verification' : 'Not selected'}</dd></div><div><dt>Coverage</dt><dd>Partial · native verification required</dd></div><div><dt>Tool version</dt><dd>{connection.version ?? 'Unavailable'}</dd></div><div><dt>Last receipt</dt><dd>{connection.lastEventAt ? new Date(connection.lastEventAt).toLocaleString() : 'No event received'}</dd></div><div><dt>Dropped or rejected records</dt><dd>{connection.droppedEvents === 0 ? 'No recorded loss' : `${connection.droppedEventsExact === true ? '' : 'At least '}${connection.droppedEvents}`}</dd></div>{connection.delivery && connection.status !== 'revoked' && <><div><dt>Local replay</dt><dd>{connection.delivery.status === 'idle' ? 'No pending events at last check' : connection.delivery.status === 'blocked' ? 'Waiting for recovery' : 'Events queued'}</dd></div><div><dt>Pending at last check</dt><dd>{connection.delivery.pendingEvents ?? 'Unavailable'}</dd></div></>}</dl>
      {connection.delivery?.message && connection.status !== 'revoked' && <p className={connection.delivery.status === 'blocked' ? 'form-error' : 'muted small'}>{connection.delivery.message}</p>}
      {!!connection.newerEventCount && connection.status !== 'revoked' && <p className="form-notice">Restart Agent Town to read {connection.newerEventCount} newer event{connection.newerEventCount === 1 ? '' : 's'}.</p>}
      {connection.diagnostics?.map(item => <p className="form-notice" key={item.code}>{item.message}<br /><small>Last recorded: {new Date(item.lastSeenAt).toLocaleString()}</small></p>)}
      {connection.status !== 'revoked' && <div className="setup-actions">{connection.provider === provider && connection.repoId === repoId && sourceId && connection.nativeSourceId !== sourceId && <button className="button" disabled={busy || !available} onClick={() => void act(async () => { const result = await identity.request<ObservationSetup>(`${prefix}/${encodeURIComponent(connection.id)}/source`, { nativeSourceId: sourceId }); if (mounted.current) { setSetup(result); setNotice('Profile selected. Review and apply the updated hook before relying on session matching.'); } })}>Link selected profile and review hook</button>}<button className="button" disabled={busy || !available} onClick={() => void act(async () => { const result = await identity.read<ObservationSetup>(`${prefix}/${encodeURIComponent(connection.id)}/setup`); if (mounted.current) setSetup(result); })}>Review hook setup</button><button className="text-button" disabled={busy || !available} onClick={() => void act(async () => { await identity.request(`${prefix}/${encodeURIComponent(connection.id)}/revoke`); if (mounted.current) { if (setup?.connection.id === connection.id) setSetup(null); setNotice('Observation revoked. This connection can no longer submit events, but its hook file is left in place. A single "Stop watching this project" action for this is planned, not built yet; remove the hook by hand below in the meantime.'); } })}><Unplug size={14} />Revoke observation</button></div>}
    {connection.status === 'revoked' && connection.provider !== 'custom' && <button className="button" disabled={busy || !available} onClick={() => void act(async () => { await identity.request(`${prefix}/${encodeURIComponent(connection.id)}/remove-hooks`); if (mounted.current) setNotice('Revoked Agent Town hook removed. Unrelated hooks are preserved.'); })}>Remove Agent Town hook</button>}
    </article>)}</div>}
    {setup && !reviewedRevoked && <article className="hook-preview" aria-label="Review observation hook setup"><h3 className="subheading">Review setup for {setup.connection.label}</h3>{setup.readiness && <DiagnosticChecklist stages={diagnosticStages(setup, toolStatus, state)} />}{setup.diagnostics?.map((item, index) => <p className="form-notice" key={`${item.code}:${index}`}>{item.message}</p>)}<ol>{setup.instructions.map((instruction, index) => <li key={index}>{instruction}</li>)}</ol><p className="eyebrow">CONFIGURATION FILE</p><code className="repo-path">{setup.configPath}</code><label className="setup-code-label">Proposed hook configuration<textarea className="setup-code" readOnly rows={8} value={setup.config} /></label><button className="text-button" onClick={() => void copy(setup.config)}><Clipboard size={14} />Copy hook configuration</button><label className="setup-code-label">Local bridge command<textarea className="setup-code" readOnly rows={3} value={setup.bridgeCommand} /></label><button className="text-button" onClick={() => void copy(setup.bridgeCommand)}><Clipboard size={14} />Copy bridge command</button>{setup.connection.provider === 'custom' && <p className="form-notice">Use the reviewed bridge command in your agent integration. This custom connector does not install a native hook file.</p>}<div className="setup-actions hook-actions"><button className="button primary" disabled={busy || !available || setup.connection.status === 'revoked' || setup.connection.provider === 'custom'} onClick={() => void act(async () => { await identity.request(`${prefix}/${encodeURIComponent(setup.connection.id)}/apply`); const refreshed = await identity.read<ObservationSetup>(`${prefix}/${encodeURIComponent(setup.connection.id)}/setup`); if (mounted.current) { setSetup(refreshed); setNotice('Agent Town hook applied. Review native trust and reload instructions, then wait for a real activity event.'); } })}>Apply reviewed Agent Town hook</button><button className="button" disabled={busy || !available || setup.connection.provider === 'custom'} onClick={() => void act(async () => { await identity.request(`${prefix}/${encodeURIComponent(setup.connection.id)}/remove-hooks`); if (mounted.current) setNotice('Agent Town hook removed. Unrelated hooks are preserved. Revoke the connection separately to stop accepting events.'); })}>Remove Agent Town hook</button></div></article>}
    <h4>4. Verify activity arriving</h4><p className="muted small">Return to the native app or terminal and continue your normal work after completing its hook trust or reload step. An existing session may need to be resumed before it loads the new hook. The first supported event should update the same discovered character.</p><p className="muted small">Hook files and connected billing accounts do not prove active watching. Check the last receipt above; stale activity means the current state is unknown.</p>
    <div className="note"><ShieldCheck size={16} /><p>Receiving an event proves delivery to Agent Town. It does not prove complete native-tool coverage, task success, or control over that tool’s credits.</p></div>
  </section>;
}
