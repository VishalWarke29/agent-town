import { useEffect, useRef, useState } from 'react';
import { memoryActionSchema, type ContextVersion, type Handoff, type ManagerQueueStatus, type MemoryAction, type TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';
import { manualContext } from './manual-context';

type ContextHistory = { versions: ContextVersion[]; deliveries: { runId: string; taskId: string; approvedContextVersion: number; status: string; boundary: 'initial-request'; contextBrief: string | null; newerContextDelivery: 'unsupported' }[] };
export function ManagerQueue({ state, identity }: { state: TownState; identity: IdentityController }) {
  const [status, setStatus] = useState<ManagerQueueStatus | null>(null), [error, setError] = useState(false);
  const revision = JSON.stringify([state.handoffs, state.manager.version, state.workflow?.manager, state.workflow?.policy, state.workflow?.connections, state.workflow?.reservations]);
  useEffect(() => {
    let stopped = false;
    const refresh = () => { void identity.read<ManagerQueueStatus>(`/workspaces/${encodeURIComponent(state.workspace.id)}/manager/status`).then(value => {
      if (!value || typeof value.message !== 'string' || !Array.isArray(value.reportIds) || value.inferenceCalls !== 0) throw new Error('Invalid status');
      if (!stopped) { setStatus(value); setError(false); }
    }).catch(() => { if (!stopped) { setStatus(null); setError(true); } }); };
    setStatus(null); refresh();
    const timer = setInterval(refresh, 30000);
    return () => { stopped = true; clearInterval(timer); };
  }, [identity.read, state.workspace.id, revision]);
  return <div className="note"><div><strong>Why reports are waiting</strong><p role="status">{error ? 'Queue status is unavailable. Saved reports remain separate from processing; dispatch still checks all limits.' : status?.message ?? 'Checking saved queue conditions…'}</p>{!error && status?.state === 'waiting' && (status.retryAt ? <p className="muted small">Next automatic window: {new Date(status.retryAt).toLocaleString()}</p> : <p className="muted small">Waiting for a change. Press Process to retry.</p>)}<small>These checks use no model inference.</small></div></div>;
}

export function ReportEvidence({ report }: { report: Handoff }) {
  const details = report.details;
  return <details className="workflow-details"><summary>Report evidence · {details?.outcome.replaceAll('-', ' ') ?? 'legacy summary'}</summary>
    <p className="muted small">Report ID: {report.id}</p>
    {!details ? <p>Structured evidence was not recorded for this older report. Missing checks and used context are unavailable.</p> : <>
      <dl className="facts"><div><dt>Task / run</dt><dd>{details.taskId ?? 'Unavailable'} / {details.runId ?? 'Unavailable'}</dd></div><div><dt>Source event</dt><dd>{details.sourceEventId}</dd></div><div><dt>Source time</dt><dd>{new Date(details.occurredAt).toLocaleString()}</dd></div><div><dt>Used context</dt><dd>{details.contextVersionUsed === null ? 'Unavailable' : `v${details.contextVersionUsed}`}</dd></div><div><dt>Base commit</dt><dd>{details.baseCommit ?? 'Unavailable'}</dd></div><div><dt>Branch</dt><dd>{details.branch ?? 'Unavailable'}</dd></div><div><dt>Worktree</dt><dd>{details.worktreePath ?? 'Unavailable'}</dd></div></dl>
      <p><strong>Changed files · {details.files.status}</strong></p>{details.files.paths.length ? <ul>{details.files.paths.map(path => <li key={path}>{path}</li>)}</ul> : <p>{details.files.status === 'unavailable' ? 'File evidence is unavailable.' : 'No changed files were included in this record.'}</p>}
      <p><strong>Checks</strong></p>{details.checks.length ? <ul>{details.checks.map((check, index) => <li key={index}>{check.name}: {check.result} · {check.evidence}{check.reference ? ` · ${check.reference}` : ''}</li>)}</ul> : <p>No structured check results were supplied.</p>}
      {details.decisions.length > 0 && <><p>Worker-reported decisions</p><ul>{details.decisions.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      {details.assumptions.length > 0 && <><p>Worker-reported assumptions</p><ul>{details.assumptions.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      {details.remainingWork.length > 0 && <><p>Remaining work</p><ul>{details.remainingWork.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      <ul>{details.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
      <p className="muted small">Evidence references: {details.evidenceRefs.length ? details.evidenceRefs.join(' · ') : 'Unavailable'}</p>
    </>}
  </details>;
}

export function MemoryPanel({ state, identity, available }: { state: TownState; identity: IdentityController; available: boolean }) {
  const [expanded, setExpanded] = useState(false), [history, setHistory] = useState<ContextHistory | null>(null), [loadError, setLoadError] = useState(false);
  const [version, setVersion] = useState(state.manager.version), [action, setAction] = useState<'accept-decision' | 'open-blocker'>('accept-decision');
  const [text, setText] = useState(''), [repoId, setRepoId] = useState(''), [sourceIds, setSourceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true), pending = useRef(false);
  const pendingVersion = useRef<number | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const revision = expanded ? JSON.stringify([state.manager.version, state.workflow?.manager.versions, state.runner?.runs.map(run => [run.id, run.contextVersion, run.contextDelivery])]) : '';
  useEffect(() => {
    if (!expanded) return;
    let stopped = false; setLoadError(false);
    void identity.read<ContextHistory>(`/workspaces/${encodeURIComponent(state.workspace.id)}/context`).then(value => {
      if (!Array.isArray(value?.versions) || !Array.isArray(value.deliveries)) throw new Error('Invalid context history');
      if (!stopped) setHistory(value);
    }).catch(() => { if (!stopped) { setHistory(null); setLoadError(true); } });
    return () => { stopped = true; };
  }, [identity.read, state.workspace.id, expanded, revision]);
  const versions = (state.workflow?.manager.versions ?? []).map(saved => history?.versions.find(value => value.version === saved.version) ?? saved);
  const versionIds = versions.map(value => value.version).join(',');
  useEffect(() => {
    if (pendingVersion.current !== null && state.manager.version < pendingVersion.current) return;
    pendingVersion.current = null;
    if (versions.some(value => value.version === version) || (!versions.length && version === state.manager.version)) return;
    setVersion(versions.some(value => value.version === state.manager.version) ? state.manager.version : versions.at(-1)?.version ?? state.manager.version);
  }, [version, versionIds, state.manager.version]);
  const current = versions.find(value => value.version === version);
  const versionReportIds = [...new Set([...(current?.reportIds ?? []), ...(current?.decisions?.flatMap(record => record.sourceReportIds) ?? []), ...(current?.blockerRecords?.flatMap(record => record.sourceReportIds) ?? [])])];
  const latest = version === state.manager.version;
  const canEdit = available && latest && !busy && !state.workflow?.manager.jobs.some(job => job.status === 'running');
  const missingScope = !!repoId && !state.repositories.some(repo => repo.id === repoId);
  const sources = state.handoffs.filter(report => !repoId || report.repoId === repoId);
  const scopeName = (scope: string | null) => scope === null ? 'Whole workspace' : state.repositories.find(repo => repo.id === scope)?.name ?? `Repository ${scope}`;
  const submit = async (input: MemoryAction) => {
    if (pending.current) return;
    if (!canEdit) return;
    if ((input.action === 'accept-decision' || input.action === 'open-blocker') && input.repoId && !state.repositories.some(repo => repo.id === input.repoId)) { setError('The selected repository is no longer connected. Choose the intended memory scope before saving.'); return; }
    const parsed = memoryActionSchema.safeParse(input);
    if (!parsed.success) { setError('Review the memory action and its required text.'); return; }
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await identity.request(`/workspaces/${encodeURIComponent(state.workspace.id)}/context/memory`, parsed.data);
      if (mounted.current) { pendingVersion.current = input.expectedVersion + 1; setVersion(input.expectedVersion + 1); setText(''); setSourceIds([]); setNotice('A new context version was saved. Existing runs keep their approved context.'); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The memory action could not be saved.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <details className="workflow-details" onToggle={event => setExpanded(event.currentTarget.open)}><summary>Context history and decisions</summary>
    <p className="muted small">Saved evidence only. Owner decisions and blocker changes create a new version without a model call.</p>
    {loadError && <p className="form-error" role="status">Full history is unavailable. The saved snapshot below remains readable; delivery details need a successful reload.</p>}
    <label>Context version<select value={version} onChange={event => setVersion(Number(event.target.value))}>{!versions.length && <option value={state.manager.version}>v{state.manager.version} · current context without a saved version record</option>}{versions.length > 0 && !current && <option value={version} disabled>v{version} · waiting for its saved record</option>}{[...versions].reverse().map(value => <option key={value.version} value={value.version}>v{value.version}{value.version === state.manager.version ? ' · current' : ''} · {value.origin === 'workspace-owner' ? 'owner change' : 'manager summary'}</option>)}</select></label>
    <p>{current?.overview ?? (version === state.manager.version && !versions.length ? state.manager.brief : 'The selected version record is not available yet.')}</p>
    {current && <p className="muted small">Based on v{current.previousVersion} · {new Date(current.createdAt).toLocaleString()}</p>}
    {current?.repoBriefs.map(repo => <article className="observation-card" key={repo.repoId}><strong>{state.repositories.find(value => value.id === repo.repoId)?.name ?? repo.repoId}</strong><p>{repo.brief}</p></article>)}
    <h3 className="subheading">Accepted decisions</h3>
    {!(current?.decisions?.length) && <p>No structured owner decisions are recorded in this version.</p>}
    {current?.decisions?.map(record => <article className="observation-card" key={record.id}><strong>{record.superseded ? 'Superseded' : 'Accepted by workspace owner'} · v{record.acceptedVersion}</strong><p>{record.text}</p><p>Scope: {scopeName(record.repoId)}</p><p className="muted small">Source context v{record.sourceContextVersion} · reports: {record.sourceReportIds.join(', ') || 'None linked'}</p>{record.superseded ? <p>Superseded in v{record.superseded.version}: {record.superseded.reason}</p> : latest && <MemoryReason disabled={!canEdit} label="Reason to supersede this decision" button="Supersede decision" onSubmit={reason => submit({ action: 'supersede-decision', expectedVersion: version, recordId: record.id, reason })} />}</article>)}
    <h3 className="subheading">Blockers</h3>
    {!(current?.blockerRecords?.length) && !current?.blockers.length && <p>No blockers are recorded in this version.</p>}
    {!current?.blockerRecords && current?.blockers.map((blocker, index) => <p key={index}>{blocker} · legacy context record</p>)}
    {current?.blockerRecords?.map(record => <article className="observation-card" key={record.id}><strong>{record.status === 'open' ? 'Open blocker' : 'Resolved blocker'}</strong><p>{record.text}</p><p>Scope: {scopeName(record.repoId)}</p><p className="muted small">{record.origin.replaceAll('-', ' ')} · source v{record.sourceContextVersion} · reports: {record.sourceReportIds.join(', ') || 'None linked'}</p>{record.history.map((entry, index) => <p key={index}>v{entry.version} · {entry.action} by owner: {entry.reason}</p>)}{latest && <MemoryReason key={record.status} disabled={!canEdit} label={record.status === 'open' ? 'Resolution evidence or reason' : 'Reason to reopen this blocker'} button={record.status === 'open' ? 'Resolve blocker' : 'Reopen blocker'} onSubmit={reason => submit({ action: record.status === 'open' ? 'resolve-blocker' : 'reopen-blocker', expectedVersion: version, recordId: record.id, reason })} />}</article>)}
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
    {latest ? <form className="setup-form" onSubmit={event => { event.preventDefault(); void submit({ action, expectedVersion: version, text, repoId: repoId || null, sourceReportIds: sourceIds }); }}>
      <label>Owner memory action<select value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="accept-decision">Accept a decision</option><option value="open-blocker">Open a blocker</option></select></label>
      <label>Decision or blocker text<textarea value={text} onChange={event => setText(event.target.value)} required maxLength={action === 'open-blocker' ? 500 : 1000} rows={3} /></label>
      <label>Memory scope<select value={repoId} onChange={event => { setRepoId(event.target.value); setSourceIds([]); setError(null); }}><option value="">Whole workspace</option>{missingScope && <option value={repoId} disabled>Repository {repoId} · no longer connected</option>}{state.repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
      {missingScope && <p className="form-notice" role="status">The selected repository is no longer connected. Choose the intended memory scope before saving; saved context remains unchanged.</p>}
      <label>Source reports (optional)<select multiple value={sourceIds} onChange={event => setSourceIds([...event.target.selectedOptions].map(option => option.value).slice(0, 20))}>{sources.map(report => <option key={report.id} value={report.id}>{report.id} · {report.details?.outcome ?? 'legacy summary'}</option>)}</select></label>
      <button className="button" disabled={!canEdit || missingScope}>{action === 'accept-decision' ? 'Save accepted decision' : 'Save open blocker'}</button>
      {!canEdit && <p className="muted small">Memory changes need a current connection and no running manager summary.</p>}
    </form> : <p className="muted small">This version is immutable. Select the current version to change decisions or blockers.</p>}
    <h3 className="subheading">Source reports</h3>
    {versionReportIds.length ? versionReportIds.map(id => { const report = state.handoffs.find(value => value.id === id); return report ? <article className="handoff-card" key={id}><p>{report.summary}</p><ReportEvidence report={report} /></article> : <p key={id}>{id} · source evidence unavailable</p>; }) : <p>This version did not process or link any reports.</p>}
    <h3 className="subheading">Run context delivery</h3>
    {!history?.deliveries.length && <p>No recorded managed context deliveries are available.</p>}
    {history?.deliveries.map(delivery => <details className="workflow-details" key={delivery.runId}><summary>{delivery.runId} · initial v{delivery.approvedContextVersion} · {delivery.status}</summary><p>Boundary: initial request. Newer context delivery: unsupported.</p><pre>{delivery.contextBrief ?? 'The approved context body is unavailable.'}</pre></details>)}
    {current && <ManualHandoff key={current.version} version={current} state={state} />}
  </details>;
}

function ManualHandoff({ version, state }: { version: ContextVersion; state: TownState }) {
  const [repoId, setRepoId] = useState(''), [notice, setNotice] = useState<string | null>(null);
  const [includeWorkspaceMaterial, setIncludeWorkspaceMaterial] = useState(false);
  const missingScope = !!repoId && !state.repositories.some(repo => repo.id === repoId);
  const result = manualContext(version, repoId || null, { includeWorkspaceMaterial });
  return <details className="workflow-details"><summary>Manual handoff of v{version.version}</summary>
    <p className="muted small">Review this saved context before pasting it into the intended agent conversation. This uses no model call and does not mark any agent as updated. The receiving tool may charge for processing it.</p>
    <label>Handoff scope<select value={repoId} onChange={event => { setRepoId(event.target.value); setNotice(null); setIncludeWorkspaceMaterial(false); }}><option value="">Whole workspace</option>{missingScope && <option value={repoId}>Repository {repoId} · saved scope, no longer connected</option>}{state.repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
    {repoId && <label><input type="checkbox" className="checkbox" checked={includeWorkspaceMaterial} onChange={event => setIncludeWorkspaceMaterial(event.target.checked)} /> Also include the workspace-wide overview and unscoped legacy blockers</label>}
    <p className="muted small">{result.scopeNote}</p>
    {result.reason ? <p className="form-notice" role="status">{result.reason}</p> : <><label>Review manual context<textarea className="saved-context" value={result.text ?? ''} readOnly rows={8} /></label><p className="muted small">{new TextEncoder().encode(result.text!).byteLength.toLocaleString()} bytes · source report references included; report bodies are not repeated.</p><button type="button" className="button" onClick={async () => {
      try { await navigator.clipboard.writeText(result.text!); setNotice('Copied for manual review and paste. Recipient delivery remains unverified.'); }
      catch { setNotice('Clipboard access is unavailable. Select and copy the preview text manually. Recipient delivery remains unverified.'); }
    }}>Copy reviewed context</button></>}
    {notice && <p className="form-notice" role="status">{notice}</p>}
  </details>;
}

function MemoryReason({ disabled, label, button, onSubmit }: { disabled: boolean; label: string; button: string; onSubmit(reason: string): Promise<void> }) {
  const [reason, setReason] = useState('');
  return <form className="setup-form" onSubmit={event => { event.preventDefault(); void onSubmit(reason); }}><label>{label}<textarea required value={reason} onChange={event => setReason(event.target.value)} maxLength={500} rows={2} /></label><button className="button" disabled={disabled}>{button}</button></form>;
}
