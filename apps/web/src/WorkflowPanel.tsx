import { CoordinationPanel } from './CoordinationPanel';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Check, KeyRound, Leaf, LoaderCircle, ShieldCheck, Unplug } from 'lucide-react';
import { apiConnectionSchema, economyPolicySchema, getModelProfile, managerConfigSchema, profilePrice, reconcileUsageSchema, type EconomyPolicy, type Handoff, type ManagerConfig, type ManagerProposal, type TownState, type WorkflowModel, type WorkflowState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';
import { WorkflowSummary } from './WorkflowSummary';
import { dollarsToMicroUsd, editMoney, money } from './money';
import { SubscriptionConnections } from './RunnerPanel';
import { ManagerQueue, MemoryPanel, ReportEvidence } from './MemoryPanel';

function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (work: () => Promise<string | void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { const result = await work(); if (active.current && result) setNotice(result); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'The action could not be completed.'); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  return { busy, error, notice, run, active };
}
function Feedback({ operation }: { operation: ReturnType<typeof useOperation> }) { return <>{operation.error && <p className="form-error" role="alert">{operation.error}</p>}{operation.notice && <p className="form-notice" role="status">{operation.notice}</p>}</>; }
function Info({ children }: { children: ReactNode }) { return <div className="note"><ShieldCheck size={16} /><p>{children}</p></div>; }

export function WorkflowConnections({ state, identity, available }: { state: TownState & { workflow: WorkflowState }; identity: IdentityController; available: boolean }) {
  const [mode, setMode] = useState<'api' | 'subscription'>('subscription');
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [projectId, setProjectId] = useState('');
  const operation = useOperation();
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}/connections`;
  return <section aria-label="AI billing connections">
    <div className="feature-heading"><KeyRound size={25} /><h3>Choose who pays.</h3><p>Keep personal and company connections clearly named. Verification checks model access without running inference.</p></div>
    <div className="segmented" role="group" aria-label="Billing mode"><button aria-pressed={mode === 'subscription'} onClick={() => { setMode('subscription'); setApiKey(''); }}>Subscription</button><button aria-pressed={mode === 'api'} onClick={() => setMode('api')}>API credits</button></div>
    <Feedback operation={operation} />
    {mode === 'subscription' ? <><SubscriptionConnections state={state} identity={identity} available={available} /><section aria-label="Claude subscription setup"><h3 className="subheading">Claude Code subscription</h3><p className="muted small">Sign in inside Claude Code with <code>/login</code>, then confirm the active account with <code>/status</code>. Scroll down in Connections to Let your agents find their town, then choose Claude Code under Agent tool for your local project.</p><p className="muted small">In-app Claude subscription sign-in is not available yet. Observation shows supported local events; your Claude Code session keeps its own account and subscription. To connect a Claude API key here, choose API credits and Anthropic.</p></section></> : <form className="setup-form" autoComplete="off" onSubmit={event => { event.preventDefault(); void operation.run(async () => {
      const parsed = apiConnectionSchema.safeParse({ provider, label: label.trim(), apiKey, ...(provider === 'openai' && organizationId.trim() ? { organizationId: organizationId.trim() } : {}), ...(provider === 'openai' && projectId.trim() ? { projectId: projectId.trim() } : {}) });
      if (!parsed.success) throw new Error('Review the provider, connection label, and API credential format.');
      await identity.request(prefix, parsed.data);
      if (operation.active.current) { setApiKey(''); setLabel(''); }
      return 'API connection verified and protected locally. No paid work was enabled.';
    }); }}>
      <label>API provider<select value={provider} onChange={event => { setProvider(event.target.value as 'openai' | 'anthropic'); setApiKey(''); setOrganizationId(''); setProjectId(''); }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
      <label>Billing connection label<input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} required placeholder="Company API account" /></label>
      <label>API key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} minLength={12} maxLength={8192} required autoComplete="off" spellCheck={false} /></label>
      {provider === 'openai' && <><label>OpenAI organization ID (optional)<input value={organizationId} onChange={event => setOrganizationId(event.target.value)} maxLength={120} autoComplete="off" spellCheck={false} /></label><label>OpenAI project ID (optional)<input value={projectId} onChange={event => setProjectId(event.target.value)} maxLength={120} autoComplete="off" spellCheck={false} /></label></>}
      <button className="button primary" disabled={operation.busy || !available || !apiKey || !label.trim()}>{operation.busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}Verify and save API connection</button>
      <p className="muted small">The key is sent only to this local service and its selected provider. It is cleared from this form after a successful save.</p>
    </form>}
    {state.workflow.connections.map(connection => <article className="observation-card" key={connection.id}><strong>{connection.label}</strong><p>{connection.provider === 'openai' ? 'OpenAI' : 'Anthropic'} · {connection.mode === 'api' ? 'API credits' : 'Subscription'}</p><dl><div><dt>Access</dt><dd>{connection.status === 'verified' ? 'Verified model access' : connection.status === 'disconnected' ? 'Disconnected' : 'Unavailable'}</dd></div><div><dt>Provider account identity</dt><dd>Unavailable</dd></div><div><dt>Available models</dt><dd>{connection.models.length}</dd></div><div><dt>Default connection</dt><dd>{Object.values(state.workflow.defaults).includes(connection.id) ? 'Yes · for this provider and mode' : 'No'}</dd></div></dl>{connection.status === 'verified' && <div className="setup-actions"><button className="button" disabled={!available || operation.busy || Object.values(state.workflow.defaults).includes(connection.id)} onClick={() => void operation.run(async () => { await identity.request(`${prefix}/${encodeURIComponent(connection.id)}/default`); return 'Default saved for future selections. Existing requests keep their original connection.'; })}>Use as future default</button><button className="text-button" disabled={!available || operation.busy} onClick={() => void operation.run(async () => { await identity.request(`${prefix}/${encodeURIComponent(connection.id)}/disconnect`); return 'Connection disconnected. No replacement account is selected automatically.'; })}><Unplug size={14} />Disconnect billing connection</button></div>}</article>)}
    <Info>The first verified connection stays the default for its provider and billing mode. An unavailable connection blocks work; another account never takes over silently.</Info>
  </section>;
}

function PolicyForm({ policy, identity, workspaceId, available }: { policy: EconomyPolicy; identity: IdentityController; workspaceId: string; available: boolean }) {
  const [paidEnabled, setPaidEnabled] = useState(policy.paidEnabled);
  const [daily, setDaily] = useState(editMoney(policy.dailyBudgetMicroUsd));
  const [manager, setManager] = useState(editMoney(policy.managerDailyBudgetMicroUsd));
  const [run, setRun] = useState(editMoney(policy.maxRunBudgetMicroUsd));
  const [concurrency, setConcurrency] = useState<1 | 2>(policy.workerConcurrency);
  const operation = useOperation();
  return <form className="setup-form" onSubmit={event => { event.preventDefault(); void operation.run(async () => {
    const parsed = economyPolicySchema.safeParse({ paidEnabled, dailyBudgetMicroUsd: dollarsToMicroUsd(daily), managerDailyBudgetMicroUsd: dollarsToMicroUsd(manager), maxRunBudgetMicroUsd: dollarsToMicroUsd(run), workerConcurrency: concurrency, timeZone: policy.timeZone });
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Review your spending limits.');
    await identity.request(`/workspaces/${encodeURIComponent(workspaceId)}/cost-policy`, parsed.data, undefined, 'PATCH');
    return paidEnabled ? 'Paid work is permitted within these limits. The manager still needs its own explicit enablement.' : 'Paid scheduling is disabled. Saved reports and monitoring remain available.';
  }); }}>
    <h3 className="subheading">Economy limits</h3><Feedback operation={operation} />
    <label>Workspace daily limit (USD)<input inputMode="decimal" value={daily} onChange={event => setDaily(event.target.value)} required /></label>
    <label>Manager daily allowance (USD)<input inputMode="decimal" value={manager} onChange={event => setManager(event.target.value)} required /></label>
    <label>Maximum per-run limit (USD)<input inputMode="decimal" value={run} onChange={event => setRun(event.target.value)} required /></label>
    <label>Worker concurrency ceiling<select value={concurrency} onChange={event => setConcurrency(Number(event.target.value) as 1 | 2)}><option value={1}>1 worker · Economy default</option><option value={2}>2 workers</option></select></label>
    <p className="muted small">Daily accounting timezone: {policy.timeZone}. Worker execution availability is shown separately.</p>
    <label className="check-setting"><input type="checkbox" checked={paidEnabled} onChange={event => setPaidEnabled(event.target.checked)} /><span>Permit paid work within these saved limits</span></label>
    <button className="button primary" disabled={operation.busy || !available}><Leaf size={16} />Save Economy limits</button>
  </form>;
}

export function EconomyPanel({ state, identity, available }: { state: TownState & { workflow: WorkflowState }; identity: IdentityController; available: boolean }) {
  return <><WorkflowSummary workflow={state.workflow} /><PolicyForm key={JSON.stringify(state.workflow.policy)} policy={state.workflow.policy} identity={identity} workspaceId={state.workspace.id} available={available} /><UsageReconciliation state={state} identity={identity} available={available} /></>;
}

function UsageReconciliation({ state, identity, available }: { state: TownState & { workflow: WorkflowState }; identity: IdentityController; available: boolean }) {
  const uncertain = state.workflow.reservations.filter(item => item.status === 'uncertain');
  const [requestedId, setReservationId] = useState(uncertain[0]?.id ?? '');
  const reservationId = uncertain.some(item => item.id === requestedId) ? requestedId : '';
  if (!uncertain.length) return null;
  return <details className="workflow-details"><summary>Reconcile an uncertain request</summary><ReconciliationForm key={reservationId} state={state} identity={identity} available={available} reservationId={reservationId} onSelect={setReservationId} /></details>;
}

function ReconciliationForm({ state, identity, available, reservationId, onSelect }: { state: TownState & { workflow: WorkflowState }; identity: IdentityController; available: boolean; reservationId: string; onSelect: (id: string) => void }) {
  const uncertain = state.workflow.reservations.filter(item => item.status === 'uncertain');
  const [input, setInput] = useState(''); const [output, setOutput] = useState(''); const [cached, setCached] = useState(''); const [cacheWrite, setCacheWrite] = useState('');
  const operation = useOperation();
  return <form className="setup-form" onSubmit={event => { event.preventDefault(); void operation.run(async () => {
    if (!available || !uncertain.some(item => item.id === reservationId)) throw new Error('Choose an uncertain request from the current workspace before reconciling.');
    if ([input, output, cached, cacheWrite].some(value => !value.trim())) throw new Error('Enter every verified token count. Missing usage is not zero.');
    const usage = { inputTokens: Number(input), outputTokens: Number(output), cachedInputTokens: Number(cached), cacheWriteTokens: Number(cacheWrite), reasoningTokens: null, source: 'user-reconciled' as const };
    const parsed = reconcileUsageSchema.safeParse(usage);
    if (!parsed.success) throw new Error('Enter the actual nonnegative token counts from the provider before reconciling.');
    await identity.request(`/workspaces/${encodeURIComponent(state.workspace.id)}/usage/${encodeURIComponent(reservationId)}/reconcile`, parsed.data);
    if (operation.active.current) { setInput(''); setOutput(''); setCached(''); setCacheWrite(''); }
    return 'Provider usage recorded. Review the settled cost before scheduling another request.';
  }); }}><Feedback operation={operation} /><Info>Only enter usage checked against the provider. Unknown usage must stay reserved; zero means a verified zero.</Info><label>Uncertain request<select value={reservationId} disabled={operation.busy} onChange={event => onSelect(event.target.value)}><option value="">Choose an uncertain request</option>{uncertain.map(item => <option key={item.id} value={item.id}>{item.purpose} · {item.model.model} · {new Date(item.createdAt).toLocaleString()} · {item.id}</option>)}</select></label><label>Verified input tokens<input type="number" min={0} step={1} required disabled={!reservationId || operation.busy} value={input} onChange={event => setInput(event.target.value)} /></label><label>Verified output tokens<input type="number" min={0} step={1} required disabled={!reservationId || operation.busy} value={output} onChange={event => setOutput(event.target.value)} /></label><label>Verified cached input tokens<input type="number" min={0} step={1} required disabled={!reservationId || operation.busy} value={cached} onChange={event => setCached(event.target.value)} /></label><label>Verified cache-write tokens<input type="number" min={0} step={1} required disabled={!reservationId || operation.busy} value={cacheWrite} onChange={event => setCacheWrite(event.target.value)} /></label><button className="button" disabled={!available || operation.busy || !reservationId}>Save verified usage</button>{!reservationId && <p className="muted small">Select a request and enter its own verified counts. Values are cleared when the request changes.</p>}</form>;
}

export function ManagerPanel({ state, identity, available, onPrepareTask }: { state: TownState & { workflow: WorkflowState }; identity: IdentityController; available: boolean; onPrepareTask?: (proposal: ManagerProposal) => void }) {
  const workflow = state.workflow;
  const operation = useOperation();
  const pause = useOperation();
  const acknowledgedRuns = state.runner?.runs.filter(run => run.contextDelivery === 'provider-acknowledged') ?? [];
  const acknowledgedVersions = [...new Set(acknowledgedRuns.map(run => run.contextVersion))].sort((a, b) => a - b);
  const pending = state.handoffs.filter(report => report.status === 'saved');
  const locked = workflow.manager.jobs.some(job => job.status === 'running' || job.status === 'uncertain');
  return <>
    <div className="manager-hero"><span><BookOpen size={28} /></span><div><h3>Keep the shared brief current.</h3><p>Saved reports, processing, and delivery stay separate.</p></div></div>
    <div className="brief-card"><div className="section-summary"><p className="eyebrow">SHARED BRIEF</p><span className="version">v{state.manager.version}</span></div><p className="brief-text">{state.manager.brief}</p></div>
    <Feedback operation={operation} /><Feedback operation={pause} />
    <ManagerQueue state={state} identity={identity} />
    <dl className="facts"><div><dt>Manager scheduling</dt><dd>{workflow.manager.config.enabled ? 'Enabled · bounded batches' : 'Disabled'}</dd></div><div><dt>Saved reports waiting</dt><dd>{pending.length}</dd></div><div><dt>Per-request limit</dt><dd>{money(workflow.manager.config.requestBudgetMicroUsd)}</dd></div><div><dt>Approved context delivery</dt><dd>{acknowledgedRuns.length ? `${acknowledgedRuns.length} managed run${acknowledgedRuns.length === 1 ? "" : "s"} acknowledged · ${acknowledgedVersions.map(version => `v${version}`).join(", ")}` : "No acknowledged managed deliveries"}</dd></div></dl>
    <button className="button primary" disabled={!available || operation.busy || !workflow.policy.paidEnabled || !workflow.manager.config.enabled || locked || !pending.length} onClick={() => void operation.run(async () => { await identity.request(`/workspaces/${encodeURIComponent(state.workspace.id)}/manager/process`, {}, AbortSignal.timeout(90000)); return 'Manager request finished. Review its saved result and usage below.'; })}><BookOpen size={16} />Process saved reports · paid</button>
    {workflow.manager.config.enabled && <button className="button stop-manager" disabled={!available || pause.busy} onClick={() => void pause.run(async () => { await identity.request(`/workspaces/${encodeURIComponent(state.workspace.id)}/manager/config`, { ...workflow.manager.config, enabled: false }, undefined, 'PATCH'); return 'Future manager summaries are disabled. An already-sent request may still finish.'; })}>Disable future manager summaries</button>}
    <p className="muted small">New tasks capture a context version for approval. Existing runs keep their approved context; processing a report does not send them the newer brief.</p>
    <Info>Processing uses the saved account, model, and request limit. Economy groups automatic reports for 30 seconds and starts at most six automatic batches per rolling hour.</Info>
    <ManagerSettings key={JSON.stringify(workflow.manager.config)} state={state} identity={identity} available={available && !locked} />
    <h3 className="subheading">Reports at the desk</h3>
    {state.handoffs.length === 0 && <p className="empty">No reports have been received. A tool ending its response does not create a success report.</p>}
    {state.handoffs.map(report => <article className="handoff-card" key={report.id}><div className="section-summary"><strong>{state.agents.find(agent => agent.id === report.agentId)?.name ?? (report.details?.runId ? 'Managed run' : 'Observed agent')}</strong><time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{report.summary}</p><div className="handoff-status">{report.status === 'processed' ? <><Check size={14} />Manager processed v{report.contextVersion}</> : 'Saved · manager pending'}</div><ReportContext state={state} report={report} /><ReportEvidence report={report} /></article>)}
    {workflow.manager.jobs.length > 0 && <><h3 className="subheading">Processing history</h3>{[...workflow.manager.jobs].reverse().map(job => <article className="observation-card" key={job.id}><strong>{job.status === 'processed' ? 'Brief updated' : job.status === 'running' ? 'Processing reports' : job.status === 'uncertain' ? 'Outcome uncertain · reconcile usage' : 'Processing failed · previous brief kept'}</strong><p>{job.model} · {job.reportIds.length} reports</p>{job.contextEvidence && <p className="muted small">{job.contextEvidence.inputTokens.toLocaleString()} input tokens · {job.contextEvidence.summaryBodyCount} summary bodies · {job.contextEvidence.reusedSummaryCount} repeated bodies reused · {job.contextEvidence.omittedRepoBriefCount} unrelated repository briefs omitted. Savings in dollars are not measured.</p>}{job.message && <p>{job.message}</p>}</article>)}</>}
    <CoordinationPanel state={state} identity={identity} />
    <MemoryPanel key={state.workspace.id} state={state} identity={identity} available={available} />
    {workflow.manager.proposals.length > 0 && <><h3 className="subheading">Proposed next tasks</h3>{workflow.manager.proposals.map(proposal => <article className="task-card" key={proposal.id}><h3>{proposal.title}</h3><ul>{proposal.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul><p className="muted small">Proposed from {proposal.sourceContextVersion === undefined ? 'an older unversioned result' : `context v${proposal.sourceContextVersion}`}. No worker is launched automatically.</p>{onPrepareTask && <button className="button" disabled={!available} onClick={() => onPrepareTask(proposal)}>Create task draft</button>}</article>)}</>}
  </>;
}

function ReportContext({ state, report }: { state: TownState; report: Handoff }) {
  const run = state.runner?.runs.find(item => item.id === report.agentId);
  return <>{run && <small>Approved run context: {run.contextDelivery === 'provider-acknowledged' ? `Provider acknowledged v${run.contextVersion}` : run.contextDelivery === 'pending' ? `Pending v${run.contextVersion}` : `Unsupported for v${run.contextVersion}`}</small>}<small>{report.status === 'processed' && report.contextVersion !== null ? `Brief v${report.contextVersion} delivery to the reporting agent: Unsupported` : 'New report context: manager processing pending'}</small></>;
}

function ManagerSettings({ state, identity, available }: { state: TownState & { workflow: WorkflowState }; identity: IdentityController; available: boolean }) {
  const config = state.workflow.manager.config;
  const candidates = state.workflow.connections.filter(connection => connection.status === 'verified' && connection.capabilities.manager);
  const [enabled, setEnabled] = useState(config.enabled);
  const [connectionId, setConnectionId] = useState(config.connectionId ?? '');
  const [model, setModel] = useState(config.model?.model ?? '');
  const [contextWindow, setContextWindow] = useState(String(config.model?.contextWindowTokens ?? ''));
  const [inputPrice, setInputPrice] = useState(config.model ? editMoney(config.model.inputPerMillionMicroUsd) : '');
  const [outputPrice, setOutputPrice] = useState(config.model ? editMoney(config.model.outputPerMillionMicroUsd) : '');
  const [cachedPrice, setCachedPrice] = useState(config.model ? editMoney(config.model.cachedInputPerMillionMicroUsd) : '');
  const [writePrice, setWritePrice] = useState(config.model ? editMoney(config.model.cacheWritePerMillionMicroUsd) : '');
  const [priceSource, setPriceSource] = useState(config.model?.priceSource ?? '');
  const [priceDate, setPriceDate] = useState(config.model?.priceCheckedAt.slice(0, 10) ?? '');
  const [quality, setQuality] = useState(config.model?.qualityStatus === 'user-attested');
  const [qualityNote, setQualityNote] = useState(config.model?.qualityNote ?? '');
  const [inputLimit, setInputLimit] = useState(String(config.maxInputTokens));
  const [outputLimit, setOutputLimit] = useState(String(config.maxOutputTokens));
  const [requestBudget, setRequestBudget] = useState(editMoney(config.requestBudgetMicroUsd));
  const operation = useOperation();
  const connection = candidates.find(item => item.id === connectionId);
  const profile = connection ? getModelProfile(connection.provider, model) : undefined;
  const loadProfile = () => {
    if (!profile) return;
    const value = profilePrice(profile);
    setContextWindow(String(value.contextWindowTokens)); setInputPrice(editMoney(value.inputPerMillionMicroUsd)); setOutputPrice(editMoney(value.outputPerMillionMicroUsd));
    setCachedPrice(editMoney(value.cachedInputPerMillionMicroUsd)); setWritePrice(editMoney(value.cacheWritePerMillionMicroUsd));
    setPriceSource(value.priceSource); setPriceDate(value.priceCheckedAt.slice(0, 10)); setQuality(false); setQualityNote('');
  };
  const resetPrice = () => { setContextWindow(''); setInputPrice(''); setOutputPrice(''); setCachedPrice(''); setWritePrice(''); setPriceSource(''); setPriceDate(''); setQuality(false); setQualityNote(''); };
  return <details className="workflow-details"><summary>Manager account, model, and limits</summary><form className="setup-form" onSubmit={event => { event.preventDefault(); void operation.run(async () => {
    let record: WorkflowModel | null = null;
    if (model) {
      if (!connection?.models.includes(model)) throw new Error('Choose a model available through the selected connection.');
      if (!priceDate) throw new Error('Record when you checked the official model prices.');
      record = { model, contextWindowTokens: Number(contextWindow), inputPerMillionMicroUsd: dollarsToMicroUsd(inputPrice), outputPerMillionMicroUsd: dollarsToMicroUsd(outputPrice), cachedInputPerMillionMicroUsd: dollarsToMicroUsd(cachedPrice), cacheWritePerMillionMicroUsd: dollarsToMicroUsd(writePrice), priceSource, priceCheckedAt: `${priceDate}T00:00:00.000Z`, qualityStatus: quality ? 'user-attested' : 'unevaluated', qualityNote: qualityNote.trim() };
    }
    if (enabled && (!quality || !qualityNote.trim())) throw new Error('Record your quality check before enabling this model. Agent Town does not independently verify that attestation.');
    const value: ManagerConfig = { enabled, connectionId: connectionId || null, model: record, maxInputTokens: Number(inputLimit), maxOutputTokens: Number(outputLimit), requestBudgetMicroUsd: dollarsToMicroUsd(requestBudget) };
    const parsed = managerConfigSchema.safeParse(value);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Review manager settings.');
    await identity.request(`/workspaces/${encodeURIComponent(state.workspace.id)}/manager/config`, parsed.data, undefined, 'PATCH');
    return enabled ? 'Manager enabled with the reviewed account, model, and limits. Saved reports may now trigger paid summaries.' : 'Manager settings saved. Automatic paid summaries are disabled.';
  }); }}>
    <Feedback operation={operation} />
    <label>Manager billing connection<select value={connectionId} onChange={event => { setConnectionId(event.target.value); setModel(''); resetPrice(); }}><option value="">Choose a verified API connection</option>{candidates.map(item => <option value={item.id} key={item.id}>{item.label} · {item.provider} · API</option>)}</select></label>
    <label>Manager model<select value={model} onChange={event => { setModel(event.target.value); resetPrice(); }} disabled={!connection}><option value="">Choose an available model</option>{connection?.models.map(id => <option key={id} value={id}>{id}{getModelProfile(connection.provider, id) ? ' · reviewed adapter profile' : ' · unsupported adapter profile'}</option>)}</select></label>
    {model && (profile ? <><button className="button" type="button" onClick={loadProfile}>Load documented price fields</button><p className="muted small">Profile checked {profile.documentedAt.slice(0, 10)}. Review prices and task quality; loading fields does not enable paid work or attest quality.</p></> : <p className="form-error">This model has no reviewed adapter profile. Official dispatch will block it before counting or inference. Select a supported snapshot for paid work.</p>)}
    {model && <><Info>Choose an economical model that meets your quality needs. Enter current official prices; the app does not claim these user-entered prices or quality checks are independently verified.</Info><label>Model context window (tokens)<input type="number" min={4096} max={2000000} step={1} required value={contextWindow} onChange={event => setContextWindow(event.target.value)} /></label><label>Input price (USD per million tokens)<input inputMode="decimal" required value={inputPrice} onChange={event => setInputPrice(event.target.value)} /></label><label>Output price (USD per million tokens)<input inputMode="decimal" required value={outputPrice} onChange={event => setOutputPrice(event.target.value)} /></label><label>Cached input price (USD per million tokens)<input inputMode="decimal" required value={cachedPrice} onChange={event => setCachedPrice(event.target.value)} /></label><label>Cache-write price (USD per million tokens)<input inputMode="decimal" required value={writePrice} onChange={event => setWritePrice(event.target.value)} /></label><label>Official model price source<input type="url" required value={priceSource} onChange={event => setPriceSource(event.target.value)} placeholder="https://provider.example/pricing" /></label><label>Price checked on<input type="date" required value={priceDate} onChange={event => setPriceDate(event.target.value)} /></label><label>My quality-check evidence<textarea required value={qualityNote} onChange={event => setQualityNote(event.target.value)} maxLength={500} rows={3} /></label><label className="check-setting"><input type="checkbox" checked={quality} onChange={event => setQuality(event.target.checked)} /><span>I checked this model against the quality needed for these summaries</span></label></>}
    <label>Maximum manager input tokens<input type="number" min={1024} max={32000} step={1} required value={inputLimit} onChange={event => setInputLimit(event.target.value)} /></label><label>Maximum manager output tokens<input type="number" min={256} max={1200} step={1} required value={outputLimit} onChange={event => setOutputLimit(event.target.value)} /></label><label>Manager per-request limit (USD)<input inputMode="decimal" value={requestBudget} onChange={event => setRequestBudget(event.target.value)} required /></label>
    <label className="check-setting"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={!state.workflow.policy.paidEnabled} /><span>Enable automatic manager summaries using this account and these limits</span></label>
    {!state.workflow.policy.paidEnabled && <p className="muted small">First save positive limits and permit paid work in Usage.</p>}
    <button className="button primary" disabled={!available || operation.busy}>{enabled ? 'Enable manager with these limits' : 'Save manager settings'}</button>
  </form></details>;
}
