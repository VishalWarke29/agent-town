import { useEffect, useRef, useState } from 'react';

import { Check, ExternalLink, FileCheck, LoaderCircle, Play, ShieldCheck, Square } from 'lucide-react';

import { getModelProfile, profilePrice, createRunDraftSchema, type CreateRunDraft, type RunnerPreflight, type RunnerState, type RunnerTask, type RunTool, type TownState, type WorkflowModel, type SubscriptionLoginStatus, type ManagerProposal, type WorktreeEvidence } from '@agent-town/contracts';

import type { IdentityController } from './useIdentity';

import { CoordinationPanel } from './CoordinationPanel';

import { EvidenceDialog } from './EvidenceDialog';

import { dollarsToMicroUsd, editMoney, money } from './money';



function useRunAction() {

  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);

  const active = useRef(true); const pending = useRef(false);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const run = async (work: () => Promise<string | void>) => {

    if (pending.current) return;

    pending.current = true; setBusy(true); setError(null); setNotice(null);

    try { const message = await work(); if (active.current && message) setNotice(message); }

    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'The task action could not be completed.'); }

    finally { pending.current = false; if (active.current) setBusy(false); }

  };

  return { busy, error, notice, active, run };

}

function Feedback({ action }: { action: ReturnType<typeof useRunAction> }) { return <>{action.error && <p className="form-error" role="alert">{action.error}</p>}{action.notice && <p className="form-notice" role="status">{action.notice}</p>}</>; }

const toolName: Record<RunTool, string> = { codex: 'Native Codex', 'openai-api': 'Bounded OpenAI API worker', 'anthropic-api': 'Bounded Anthropic API worker', claude: 'Native Claude SDK in WSL' };



function useRunner(state: TownState, identity: IdentityController) {

  const [remote, setRemote] = useState<RunnerState | null>(null);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {

    if (state.runner) return;

    let disposed = false;

    void identity.read<RunnerState>(`/workspaces/${encodeURIComponent(state.workspace.id)}/runner`).then(result => { if (!disposed) setRemote(result); }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Task execution status is unavailable.'); });

    return () => { disposed = true; };

  }, [state.runner, state.workspace.id, identity.read]);

  return { runner: state.runner ?? remote, error };

}



export function SubscriptionConnections({ state, identity, available }: { state: TownState; identity: IdentityController; available: boolean }) {

  const { runner, error } = useRunner(state, identity);

  const [label, setLabel] = useState('');

  const [login, setLogin] = useState<NonNullable<SubscriptionLoginStatus['prompt']> | null>(null);

  const [loginMessage, setLoginMessage] = useState<string | null>(null);

  const [loginError, setLoginError] = useState<string | null>(null);

  const action = useRunAction();

  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}/subscriptions`;

  useEffect(() => {

    if (!login) return;

    let disposed = false; let timer: ReturnType<typeof setTimeout>; let expiryTimer: ReturnType<typeof setTimeout>;

    let expiresAt = Date.parse(login.expiresAt);

    const endAttempt = (message: string, failed: boolean) => {
      if (disposed) return;
      disposed = true; clearTimeout(timer); clearTimeout(expiryTimer);
      setLogin(null); setLoginError(failed ? message : null); setLoginMessage(failed ? null : message);
    };

    const expire = () => endAttempt('This Codex sign-in code expired. Prepare a new Codex subscription sign-in for a fresh code.', true);

    const scheduleExpiry = () => { clearTimeout(expiryTimer); expiryTimer = setTimeout(expire, Math.max(0, expiresAt - Date.now())); };

    scheduleExpiry();

    const poll = async () => {

      if (Date.now() >= expiresAt) { expire(); return; }

      try {

        const result = await identity.read<SubscriptionLoginStatus>(`${prefix}/${encodeURIComponent(login.connectionId)}`);

        if (disposed) return;


        if (['verified', 'failed', 'disconnected'].includes(result.status)) {
          endAttempt(result.message ?? (result.status === 'verified' ? 'Codex subscription connection verified. No worker has started.' : 'This attempt ended. Prepare a new Codex subscription sign-in.'), result.status === 'failed');
          return;
        }

        // The service may report an earlier deadline when a saved attempt is
        // resumed. A successful status read never extends a code's lifetime.
        if (result.prompt) {
          const reportedExpiry = Date.parse(result.prompt.expiresAt);
          if (!Number.isFinite(reportedExpiry) || reportedExpiry <= Date.now()) { expire(); return; }
          if (reportedExpiry < expiresAt) { expiresAt = reportedExpiry; scheduleExpiry(); }
        }

        setLoginMessage(result.message);

      } catch (cause) {
        if (disposed) return;
        const status = cause instanceof Error && 'status' in cause ? cause.status : null;
        if (status === 401 || status === 403 || status === 404) {
          const message = cause instanceof Error ? cause.message : 'This subscription sign-in attempt is unavailable.';
          endAttempt(`${message} ${status === 404 ? 'Prepare' : 'Refresh Agent Town, then prepare'} a new Codex subscription sign-in.`, true);
          return;
        }
        setLoginMessage('Subscription status is temporarily unavailable. Retrying until this code expires.');
      }

      if (!disposed) timer = setTimeout(() => void poll(), 5000);

    };

    timer = setTimeout(() => void poll(), 5000);

    return () => { disposed = true; clearTimeout(timer); clearTimeout(expiryTimer); };

  }, [login, identity.read, prefix]);

  return <section aria-label="Codex subscription connection"><Feedback action={{ ...action, notice: loginMessage || loginError ? null : action.notice }} />{error && <p className="form-error" role="status">{error}</p>}{loginError && <p className="form-error" role="alert">{loginError}</p>}<p className="muted small">Connect a Codex subscription account for supported managed work. This does not connect your existing conversations to activity tracking. Use Set up tracking for local sessions. Subscription limits remain controlled by the provider; Agent Town cannot enforce an exact dollar cap on subscription usage.</p><form className="setup-form" onSubmit={event => { event.preventDefault(); void action.run(async () => {

    setLoginError(null); setLoginMessage(null);

    const result = await identity.request<{ connectionId: string; loginId: string; verificationUrl: string; userCode: string; expiresAt?: string }>(prefix, { label: label.trim() });

    const destination = new URL(result.verificationUrl);

    if (destination.origin !== 'https://auth.openai.com' || !!destination.username || !!destination.password) throw new Error('The subscription sign-in destination could not be verified.');

    const expiresAt = result.expiresAt === undefined ? Date.now() + 10 * 60000 : Date.parse(result.expiresAt);

    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('This Codex sign-in attempt expired. Prepare a new subscription sign-in.');

    if (action.active.current) { setLogin({ ...result, expiresAt: new Date(Math.min(expiresAt, Date.now() + 10 * 60000)).toISOString() }); setLoginMessage(null); setLabel(''); }

    return 'Complete the native Codex sign-in below. Connecting does not start a worker.';

  }); }}><label>Subscription connection label<input value={label} onChange={event => setLabel(event.target.value)} required maxLength={80} placeholder="Personal Codex subscription" /></label><button className="button primary" disabled={!available || action.busy || !!login || !label.trim()}>Prepare Codex subscription sign-in</button></form>{login && <div className="device-flow"><p className="muted small">You can close this panel and choose Resume sign-in before this attempt expires. Codes are kept only by the local service during sign-in.</p><p>Enter this code on the verified OpenAI sign-in page:</p><strong className="device-code">{login.userCode}</strong><a className="button primary" href={login.verificationUrl} target="_blank" rel="noopener noreferrer">Open OpenAI sign-in <ExternalLink size={15} /></a><button className="text-button" disabled={!available || action.busy} onClick={() => void action.run(async () => { await identity.request(`${prefix}/${encodeURIComponent(login.connectionId)}/disconnect`); if (action.active.current) setLogin(null); return 'Subscription sign-in cancelled.'; })}>Cancel subscription sign-in</button></div>}{loginMessage && <p className="form-notice" role="status">{loginMessage}</p>}{runner?.subscriptions.map(connection => <article className="observation-card" key={connection.id}><strong>{connection.label}</strong><p>{connection.status === 'verified' ? 'Verified subscription account' : connection.status}</p><dl><div><dt>Account</dt><dd>{connection.accountLabel ?? 'Unavailable'}</dd></div><div><dt>Default for Codex subscription</dt><dd>{runner.subscriptionDefault === connection.id ? 'Yes' : 'No'}</dd></div><div><dt>Available models</dt><dd>{connection.models.length}</dd></div></dl>{connection.status === 'pending' && (!login || login.connectionId !== connection.id) && <button className="button" disabled={!available || action.busy} onClick={() => void action.run(async () => {

    const result = await identity.read<SubscriptionLoginStatus>(`${prefix}/${encodeURIComponent(connection.id)}`);

    if (result.status === 'pending' && result.prompt) {

      const destination = new URL(result.prompt.verificationUrl);

      if (destination.origin !== 'https://auth.openai.com' || destination.username || destination.password) throw new Error('The subscription sign-in destination could not be verified.');

      const expiresAt = Date.parse(result.prompt.expiresAt);

      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('This Codex sign-in attempt expired. Prepare a new subscription sign-in.');

      if (action.active.current) { setLogin({ ...result.prompt, expiresAt: new Date(Math.min(expiresAt, Date.now() + 10 * 60000)).toISOString() }); setLoginMessage(result.message); setLoginError(null); }

      return 'Resumed the pending sign-in. No worker has started.';

    }

    return result.message ?? (result.status === 'verified' ? 'Subscription sign-in is complete.' : 'Start a new sign-in attempt.');

  })}>Resume sign-in</button>}{connection.status === 'verified' && <button className="button" disabled={!available || action.busy || runner.subscriptionDefault === connection.id} onClick={() => void action.run(async () => { await identity.request(`${prefix}/${encodeURIComponent(connection.id)}/default`); return 'Subscription default saved for future tasks.'; })}>Use as subscription default</button>}{connection.status !== 'disconnected' && <button className="text-button" disabled={!available || action.busy} onClick={() => void action.run(async () => { await identity.request(`${prefix}/${encodeURIComponent(connection.id)}/disconnect`); return 'Subscription connection disconnected. No fallback account is selected.'; })}>Disconnect subscription</button>}</article>)}</section>;

}



export type TaskDraftSeed = { key: string; repoId: string; objective: string; acceptanceCriteria: string[]; sourceProposalId?: string; revision?: RunnerTask };

export function proposalDraft(proposal: ManagerProposal): TaskDraftSeed { return { key: proposal.id, repoId: proposal.repoId, objective: proposal.title, acceptanceCriteria: proposal.acceptanceCriteria, sourceProposalId: proposal.id }; }

export function RunnerPanel({ state, identity, available, proposal }: { state: TownState; identity: IdentityController; available: boolean; proposal?: ManagerProposal | null }) {

  const { runner, error } = useRunner(state, identity);

  const [evidence, setEvidence] = useState<RunnerTask | null>(null);

  const [revision, setRevision] = useState<TaskDraftSeed | null>(null);

  const [showHistory, setShowHistory] = useState(false);

  const seed = revision ?? (proposal ? proposalDraft(proposal) : null);

  if (!runner) return <p className={error ? 'form-error' : 'muted'} role="status">{error ?? 'Loading task execution status…'}</p>;

  return <section aria-label="Managed tasks"><div className="feature-heading"><FileCheck size={25} /><h3>Give a task a clear beginning.</h3><p>Prepare a draft, review its exact account and limits, then approve it. Finished work stays available for your final review.</p></div><CoordinationPanel state={{ ...state, runner }} identity={identity} /><DraftForm key={seed?.key ?? "new-task"} state={state} runner={runner} identity={identity} available={available} seed={seed} /><h3 className="subheading">Tasks and reviews</h3><label className="check-setting"><input type="checkbox" checked={showHistory} onChange={event => setShowHistory(event.target.checked)} /><span>Include archived tasks</span></label>{runner.tasks.length === 0 && <p className="empty">No managed task drafts yet.</p>}{[...runner.tasks].filter(task => showHistory || !task.archivedAt).reverse().map(task => <TaskCard key={task.id} task={task} state={state} runner={runner} identity={identity} available={available} onEvidence={() => setEvidence(task)} onRevise={() => setRevision({ key: `${task.id}:${crypto.randomUUID()}`, repoId: task.draft.repoId, objective: task.draft.objective, acceptanceCriteria: task.draft.acceptanceCriteria, sourceProposalId: task.draft.sourceProposalId, revision: task })} />)}{evidence && <EvidenceDialog title="Exact task approval details" onClose={() => setEvidence(null)}><h3>{evidence.draft.objective}</h3><dl className="facts"><div><dt>Repository</dt><dd>{state.repositories.find(repo => repo.id === evidence.draft.repoId)?.name ?? evidence.draft.repoId}</dd></div><div><dt>Base commit</dt><dd className="mono">{evidence.baseCommit}</dd></div><div><dt>Approval fingerprint</dt><dd className="mono">{evidence.approvalHash}</dd></div><div><dt>Connection ID</dt><dd className="mono">{evidence.draft.connectionId}</dd></div><div><dt>Tool / billing</dt><dd>{toolName[evidence.draft.tool]} · {evidence.draft.mode}</dd></div><div><dt>Model</dt><dd className="mono">{evidence.draft.model}</dd></div><div><dt>Limits</dt><dd>{evidence.draft.mode === 'subscription' ? `1 outer turn · ${evidence.draft.maxMinutes} min deadline` : `${evidence.draft.maxTurns} provider requests · ${evidence.draft.maxMinutes} min deadline · ${evidence.draft.maxOutputTokens} output tokens/request`}</dd></div><div><dt>Native internal requests / output cap</dt><dd>{evidence.draft.mode === 'subscription' ? 'Native allowance · local cap unavailable' : 'Not applicable to this API worker'}</dd></div><div><dt>API budget</dt><dd>{evidence.draft.mode === 'api' ? money(evidence.draft.budgetMicroUsd) : 'Not an enforceable subscription dollar cap'}</dd></div><div><dt>Shared context</dt><dd>Version {evidence.contextVersion}</dd></div></dl><h3>Prerequisite tasks</h3><p>{(evidence.draft.dependencyTaskIds ?? []).map(id => runner.tasks.find(task => task.id === id)?.draft.objective ?? id).join("; ") || "None"}</p><h3>Acceptance criteria</h3><ul>{evidence.draft.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul><h3>Context included with this draft</h3><pre className="saved-context">{evidence.contextBrief}</pre>{evidence.draft.price && <><h3>Saved model price and quality record</h3><p>{evidence.draft.price.priceSource}</p><p>Checked {evidence.draft.price.priceCheckedAt.slice(0, 10)} · {evidence.draft.price.qualityStatus}</p><p>{evidence.draft.price.qualityNote}</p></>}</EvidenceDialog>}</section>;

}



const emptyPrice = { context: '', input: '', output: '', cached: '', write: '', source: '', date: '', note: '', checked: false };

function DraftForm({ state, runner, identity, available, seed }: { state: TownState; runner: RunnerState; identity: IdentityController; available: boolean; seed: TaskDraftSeed | null }) {

  const local = state.repositories.filter(repo => repo.localPath && repo.projectKind !== 'folder');
  const hasPlainFolders = state.repositories.some(repo => repo.localPath && repo.projectKind === 'folder');

  const [tool, setTool] = useState<RunTool>('openai-api');

  const [mode, setMode] = useState<'api' | 'subscription'>('api');

  const [requestedRepoId, setRepoId] = useState(seed ? (local.some(repo => repo.id === seed.repoId) ? seed.repoId : '') : local[0]?.id ?? '');
  const repoId = local.some(repo => repo.id === requestedRepoId) ? requestedRepoId : '';

  const [connectionId, setConnectionId] = useState(state.workflow?.defaults['openai:api'] ?? '');

  const [dependencies, setDependencies] = useState<string[]>([]);

  const [objective, setObjective] = useState(seed?.objective ?? ''); const [criteria, setCriteria] = useState(seed?.acceptanceCriteria.join('\n') ?? '');

  const [model, setModel] = useState(''); const [price, setPrice] = useState(emptyPrice);

  const [turns, setTurns] = useState('10'); const [minutes, setMinutes] = useState('10'); const [output, setOutput] = useState('1200'); const [budget, setBudget] = useState('');

  const [acknowledge, setAcknowledge] = useState(false);

  const [preflight, setPreflight] = useState<RunnerPreflight | null>(null);

  const action = useRunAction();

  const localIds = local.map(repo => repo.id).join(',');
  const scopeRef = useRef(`${tool}:${repoId}:${localIds}`); scopeRef.current = `${tool}:${repoId}:${localIds}`;

  useEffect(() => { const ids = localIds ? localIds.split(',') : []; setRepoId(current => ids.includes(current) ? current : ''); setPreflight(null); }, [localIds]);

  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}`;

  const provider = tool === 'claude' || tool === 'anthropic-api' ? 'anthropic' : 'openai';

  const connections = mode === 'subscription' ? runner.subscriptions.filter(connection => connection.status === 'verified').map(connection => ({ ...connection, models: connection.models })) : (state.workflow?.connections ?? []).filter(connection => connection.provider === provider && connection.status === 'verified');

  const selected = connections.find(connection => connection.id === connectionId);

  const managerPrice = state.workflow?.manager.config.model;
  const documentedModel = mode === 'api' ? getModelProfile(provider, model) : undefined;

  const changeTool = (next: RunTool) => { const nextMode = next === 'codex' ? 'subscription' : 'api'; setTool(next); setMode(nextMode); setTurns(nextMode === 'subscription' ? '1' : '10'); setConnectionId(nextMode === 'subscription' ? runner.subscriptionDefault ?? '' : state.workflow?.defaults[`${next === 'claude' || next === 'anthropic-api' ? 'anthropic' : 'openai'}:api`] ?? ''); setModel(''); setPrice(emptyPrice); setPreflight(null); setAcknowledge(false); };

  const buildPrice = (): WorkflowModel | null => mode === 'subscription' ? null : { model, contextWindowTokens: Number(price.context), inputPerMillionMicroUsd: dollarsToMicroUsd(price.input), outputPerMillionMicroUsd: dollarsToMicroUsd(price.output), cachedInputPerMillionMicroUsd: dollarsToMicroUsd(price.cached), cacheWritePerMillionMicroUsd: dollarsToMicroUsd(price.write), priceSource: price.source, priceCheckedAt: `${price.date}T00:00:00.000Z`, qualityStatus: price.checked ? 'user-attested' : 'unevaluated', qualityNote: price.note.trim() };

  if (!local.length) return <p className="empty">{hasPlainFolders ? 'Connected project folders support agent observation. Managed tasks require an existing Git repository with a verified commit and an isolated worktree.' : 'Connect a local Git repository before preparing a managed task.'}</p>;

  return <details className="workflow-details" open={seed ? true : undefined}><summary>Prepare a new task</summary>{seed && <p className="form-notice">{seed.revision ? "Editing a new revision. The earlier attempt and evidence stay saved; an unstarted draft is archived when its revision is saved." : "From a saved manager proposal. Review the account, model, limits and current context before saving."} No work starts until you approve this new draft.</p>}<form className="setup-form" onSubmit={event => { event.preventDefault(); void action.run(async () => {

    if (!repoId || !preflight?.ready || preflight.tool !== tool) throw new Error('Pass the selected tool and Git repository checks first.');

    if (!selected?.models.includes(model)) throw new Error('Choose a model exposed by the selected account.');

    if (mode === 'api' && (!price.checked || !price.note.trim())) throw new Error('Review the model quality needed for this task before preparing the draft.');

    const draft: CreateRunDraft = { ...(seed?.sourceProposalId && seed.repoId === repoId ? { sourceProposalId: seed.sourceProposalId } : {}), ...(seed?.revision ? { revisionOf: seed.revision.id } : {}), dependencyTaskIds: dependencies, repoId, tool, connectionId, mode, objective: objective.trim(), acceptanceCriteria: criteria.split(/\r?\n/).map(value => value.trim()).filter(Boolean), model, price: buildPrice(), maxTurns: mode === 'subscription' ? 1 : Number(turns), maxOutputTokens: Number(output), maxMinutes: Number(minutes), budgetMicroUsd: mode === 'subscription' ? 0 : dollarsToMicroUsd(budget), acknowledgeSubscriptionLimits: acknowledge };

    if (mode === 'api' && draft.budgetMicroUsd <= 0) throw new Error('Set a positive API budget for this task.');

    const parsed = createRunDraftSchema.safeParse(draft);

    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Review task details and limits.');

    await identity.request(`${prefix}/tasks`, parsed.data);

    return 'Draft saved. Review its immutable approval details below before starting work.';

  }); }}><Feedback action={action} />{hasPlainFolders && <p className="muted small">Plain project folders support agent observation. Managed tasks are available only for Git repositories with a verified commit and an isolated worktree.</p>}<label>Task repository<select value={repoId} onChange={event => { setRepoId(event.target.value); setPreflight(null); }} disabled={action.busy}><option value="">Choose a Git repository</option>{local.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label><label>Managed worker tool<select value={tool} onChange={event => changeTool(event.target.value as RunTool)} disabled={action.busy}><option value="openai-api">Bounded OpenAI API worker</option><option value="anthropic-api">Bounded Anthropic API worker</option><option value="codex">Native Codex</option><option value="claude">Native Claude SDK in WSL</option></select></label>{tool === 'codex' && <label>Native Codex billing mode<select value={mode} onChange={event => { const next = event.target.value as 'api' | 'subscription'; setMode(next); setTurns(next === 'subscription' ? '1' : '10'); setConnectionId(next === 'subscription' ? runner.subscriptionDefault ?? '' : state.workflow?.defaults['openai:api'] ?? ''); setModel(''); setPrice(emptyPrice); setAcknowledge(false); }}><option value="subscription">Subscription</option><option value="api">API · native hard cap unavailable</option></select></label>}

    <button type="button" className="button" disabled={!available || action.busy || !repoId} onClick={() => void action.run(async () => { const scope = `${tool}:${repoId}:${localIds}`; const result = await identity.request<RunnerPreflight>(`${prefix}/runner/preflight`, { tool, repoId }, AbortSignal.timeout(180000)); if (action.active.current && scopeRef.current === scope) setPreflight(result); })}><ShieldCheck size={16} />Check execution requirements</button>

    {preflight && <div className="preflight-results" role="status"><strong>{preflight.ready ? 'Execution requirements passed' : 'Execution is blocked'}</strong><ul>{preflight.checks.map((check, index) => <li key={index}><strong>{check.passed ? 'Passed' : 'Blocked'} · {check.name}</strong><span>{check.message}</span></li>)}</ul></div>}

    {tool === 'claude' && <p className="form-notice">The native Claude SDK cannot enforce this app’s strict reservation bound for all auxiliary calls. Choose the separate bounded Anthropic API worker for metered API work.</p>}

    {tool === 'codex' && mode === 'api' && <p className="form-notice">Native Codex API mode cannot enforce this app’s hard request/output budget. Choose the separate bounded OpenAI API worker for metered API work.</p>}

    <label>Task billing connection<select value={connectionId} onChange={event => { setConnectionId(event.target.value); setModel(''); setPrice(emptyPrice); }}><option value="">Choose a verified connection</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label} · {mode}</option>)}</select></label>

    <label>Task model<select value={model} onChange={event => { setModel(event.target.value); setPrice(emptyPrice); }} disabled={!selected}><option value="">Choose a model explicitly</option>{selected?.models.map(id => <option key={id} value={id}>{id}{mode === "api" && !getModelProfile(provider, id) ? " · compatibility unverified" : ""}</option>)}</select></label>

    {mode === 'api' && model && !documentedModel && <p className="form-notice">This model is listed by the account, but its API compatibility has not been reviewed. Choose a supported snapshot before preparing a task.</p>}
    {documentedModel && <button type="button" className="button" onClick={() => { const record = profilePrice(documentedModel); setPrice({ context: String(record.contextWindowTokens), input: editMoney(record.inputPerMillionMicroUsd), output: editMoney(record.outputPerMillionMicroUsd), cached: editMoney(record.cachedInputPerMillionMicroUsd), write: editMoney(record.cacheWritePerMillionMicroUsd), source: record.priceSource, date: record.priceCheckedAt.slice(0, 10), note: '', checked: false }); }}>Load documented price fields</button>}
    {mode === 'api' && model && <><details className="workflow-details" open><summary>Task model price and quality</summary>{managerPrice && selected?.models.includes(managerPrice.model) && <button type="button" className="button" onClick={() => { setModel(managerPrice.model); setPrice({ context: String(managerPrice.contextWindowTokens), input: editMoney(managerPrice.inputPerMillionMicroUsd), output: editMoney(managerPrice.outputPerMillionMicroUsd), cached: editMoney(managerPrice.cachedInputPerMillionMicroUsd), write: editMoney(managerPrice.cacheWritePerMillionMicroUsd), source: managerPrice.priceSource, date: managerPrice.priceCheckedAt.slice(0, 10), note: managerPrice.qualityNote, checked: false }); }}>Copy {managerPrice.model} and its reviewed prices</button>}<label>Task model context window (tokens)<input type="number" min={4096} max={2000000} required value={price.context} onChange={event => setPrice(current => ({ ...current, context: event.target.value }))} /></label>{([{ key: 'input', label: 'Task input price' }, { key: 'output', label: 'Task output price' }, { key: 'cached', label: 'Task cached input price' }, { key: 'write', label: 'Task cache-write price' }] as const).map(field => <label key={field.key}>{field.label} (USD per million tokens)<input inputMode="decimal" required value={price[field.key]} onChange={event => setPrice(current => ({ ...current, [field.key]: event.target.value }))} /></label>)}<label>Task official price source<input type="url" required value={price.source} onChange={event => setPrice(current => ({ ...current, source: event.target.value }))} /></label><label>Task price checked on<input type="date" required value={price.date} onChange={event => setPrice(current => ({ ...current, date: event.target.value }))} /></label><label>Task model quality evidence<textarea required maxLength={500} value={price.note} onChange={event => setPrice(current => ({ ...current, note: event.target.value }))} /></label><label className="check-setting"><input type="checkbox" checked={price.checked} onChange={event => setPrice(current => ({ ...current, checked: event.target.checked }))} /><span>I reviewed this model and its quality for this task</span></label></details></>}

    <details className="workflow-details"><summary>Prerequisite tasks (optional)</summary><p className="muted small">Select up to 20 existing tasks whose results must be accepted first. Changes in their worktrees are not merged automatically.</p>{runner.tasks.length === 0 && <p className="empty">No earlier tasks in this workspace.</p>}{runner.tasks.map(task => <label className="check-setting" key={task.id}><input type="checkbox" checked={dependencies.includes(task.id)} disabled={!dependencies.includes(task.id) && dependencies.length >= 20} onChange={event => setDependencies(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id))} /><span>{task.draft.objective} · {task.status.replaceAll("_", " ")}</span></label>)}</details><label>Task objective<textarea required minLength={5} maxLength={4000} rows={4} value={objective} onChange={event => setObjective(event.target.value)} /></label><label>Acceptance criteria (one per line)<textarea required rows={4} value={criteria} onChange={event => setCriteria(event.target.value)} /></label><label>{mode === 'subscription' ? 'Native outer turns' : 'Maximum provider requests'}<input type="number" min={1} max={20} required disabled={mode === 'subscription'} value={mode === 'subscription' ? '1' : turns} onChange={event => setTurns(event.target.value)} /></label><label>Maximum task minutes<input type="number" min={1} max={15} required value={minutes} onChange={event => setMinutes(event.target.value)} /></label>{mode === 'api' && <label>Maximum task output tokens per request<input type="number" min={256} max={8192} required value={output} onChange={event => setOutput(event.target.value)} /></label>}{mode === 'api' ? <label>Task API budget (USD)<input inputMode="decimal" required value={budget} onChange={event => setBudget(event.target.value)} /></label> : <label className="check-setting"><input type="checkbox" checked={acknowledge} onChange={event => setAcknowledge(event.target.checked)} /><span>I understand subscription credits have provider limits and no exact local dollar cap. Internal requests and output tokens use the native allowance; a local cap is unavailable.</span></label>}

    <button className="button primary" disabled={!available || action.busy || !repoId || !preflight?.ready || !model || !connectionId || (mode === 'api' && !documentedModel) || (tool === 'codex' && mode === 'api')}>{action.busy ? <LoaderCircle size={16} className="spin" /> : <FileCheck size={16} />}Create reviewable task draft</button><p className="muted small">A draft starts no worker. Approval rechecks execution, account identity, repository state, and available budget.</p>

  </form></details>;

}



function TaskCard({ task, state, runner, identity, available, onEvidence, onRevise }: { task: RunnerTask; state: TownState; runner: RunnerState; identity: IdentityController; available: boolean; onEvidence: () => void; onRevise: () => void }) {

  const [reviewed, setReviewed] = useState(false);
  const [sourceEvidence, setSourceEvidence] = useState<WorktreeEvidence | null>(null);

  useEffect(() => setReviewed(false), [task.approvalHash]);

  const action = useRunAction();

  const run = runner.runs.find(item => item.id === task.runId);

  const account = state.workflow?.connections.find(connection => connection.id === task.draft.connectionId)?.label ?? runner.subscriptions.find(connection => connection.id === task.draft.connectionId)?.label ?? 'Saved connection unavailable';

  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}`;

  return <article className="managed-task"><h3>{task.draft.objective}</h3><p className="task-state">{task.status.replaceAll('_', ' ')}</p><Feedback action={action} /><dl className="facts"><div><dt>Repository</dt><dd>{state.repositories.find(repo => repo.id === task.draft.repoId)?.name ?? 'Unavailable'}</dd></div><div><dt>Worker</dt><dd>{toolName[task.draft.tool]}</dd></div><div><dt>Account / mode</dt><dd>{account} · {task.draft.mode}</dd></div><div><dt>Model</dt><dd className="mono">{task.draft.model}</dd></div><div><dt>Base commit</dt><dd className="mono">{task.baseCommit}</dd></div><div><dt>Limits</dt><dd>{task.draft.mode === 'subscription' ? `1 outer turn · ${task.draft.maxMinutes} min deadline` : `${task.draft.maxTurns} provider requests · ${task.draft.maxMinutes} min deadline · ${task.draft.maxOutputTokens} output tokens/request`}</dd></div><div><dt>Native internal requests / output cap</dt><dd>{task.draft.mode === 'subscription' ? 'Native allowance · local cap unavailable' : 'Not applicable to this API worker'}</dd></div><div><dt>API budget</dt><dd>{task.draft.mode === 'api' ? money(task.draft.budgetMicroUsd) : 'Provider subscription limits'}</dd></div><div><dt>Context version</dt><dd>v{task.contextVersion}</dd></div></dl><p className="muted small">Prerequisites: {(task.draft.dependencyTaskIds ?? []).map(id => runner.tasks.find(value => value.id === id)?.draft.objective ?? id).join("; ") || "None"}</p><ul className="task-criteria">{task.draft.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul><button className="text-button" onClick={onEvidence}>Open exact approval details</button>{task.archivedAt && <p className="muted small">Archived · evidence retained</p>}{task.draft.revisionOf && <p className="muted small">Revision of {task.draft.revisionOf}</p>}{!['approved', 'running', 'awaiting_review'].includes(task.status) && <div className="setup-actions"><button className="button" onClick={onRevise}>Prepare edited revision</button>{!task.archivedAt && <button className="text-button" disabled={!available || action.busy} onClick={() => void action.run(async () => { await identity.request(`${prefix}/tasks/${encodeURIComponent(task.id)}/archive`); return 'Task archived. Reports and earlier attempts remain available in history.'; })}>Archive task</button>}</div>}{task.status === 'draft' && !task.archivedAt && <div className="setup-form"><label className="check-setting"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed this exact task, account, model, and limits</span></label><button className="button primary" disabled={!available || action.busy || !reviewed} onClick={() => void action.run(async () => { await identity.request(`${prefix}/tasks/${encodeURIComponent(task.id)}/approve`, { approvalHash: task.approvalHash }, AbortSignal.timeout(180000)); return 'Task approval saved. Its run keeps this account and these limits.'; })}><Play size={15} />Approve and start this task</button></div>}{run && <><dl className="facts"><div><dt>Run state</dt><dd>{run.status === 'awaiting_review' ? 'Worker finished · result saved' : run.status.replaceAll('_', ' ')}</dd></div><div><dt>Branch</dt><dd className="mono">{run.branch ?? 'Not created'}</dd></div><div><dt>Worktree</dt><dd className="mono">{run.worktreePath ?? 'Not created'}</dd></div><div><dt>Context delivery</dt><dd>{run.contextDelivery === 'provider-acknowledged' ? `Provider acknowledged v${run.contextVersion}` : run.contextDelivery === 'pending' ? 'Pending' : 'Unsupported'}</dd></div><div><dt>Provider requests</dt><dd>{run.providerRequests ?? 'Unavailable'}</dd></div><div><dt>Saved report</dt><dd>{run.reportId ? 'Available at the manager' : 'Not received'}</dd></div></dl>{run.message && <p className="form-notice">{run.message}</p>}{run.changedFilesUnavailable && <p className="form-notice">Changed-file metadata is unavailable. Review the saved worktree directly.</p>}{run.changedFiles.length > 0 && <><h4>Reported changed files</h4><ul className="changed-files">{run.changedFiles.map(file => <li key={file}><button className="text-button" disabled={!available || action.busy || ['starting', 'running'].includes(run.status)} onClick={() => void action.run(async () => { const result = await identity.read<WorktreeEvidence>(`${prefix}/tasks/${encodeURIComponent(task.id)}/evidence?file=${encodeURIComponent(file)}`); if (action.active.current) setSourceEvidence(result); })}><code>{file}</code> · Inspect diff</button></li>)}</ul></>}{['starting', 'running'].includes(run.status) && <button className="button" disabled={!available || action.busy} onClick={() => void action.run(async () => { await identity.request(`${prefix}/runs/${encodeURIComponent(run.id)}/cancel`); return 'Cancellation requested. Already-sent provider work may finish; check the saved run state.'; })}><Square size={14} />Cancel managed run</button>}</>}{sourceEvidence && <EvidenceDialog title="Current worktree changes" onClose={() => setSourceEvidence(null)}><h3>{sourceEvidence.file}</h3><p>{sourceEvidence.message}</p><p className="muted small">Read {new Date(sourceEvidence.observedAt).toLocaleString()} · fingerprint {sourceEvidence.fingerprint}</p>{sourceEvidence.truncated && <p className="form-notice">This preview is truncated. Review the complete file in the saved worktree.</p>}<pre className="saved-context">{sourceEvidence.text}</pre></EvidenceDialog>}{task.status === 'accepted' && <div className="setup-form"><p className="muted small">Integration is a separate step. Apply and commit the reviewed changes yourself, then verify their source content against the retained result.</p>{task.integration && <p className="form-notice">Committed source verified at {task.integration.commit}. No merge, push or deployment was performed by Agent Town.</p>}<button className="button" disabled={!available || action.busy || !run?.sourceFingerprint || run.changedFilesUnavailable} onClick={() => void action.run(async () => { await identity.request(`${prefix}/tasks/${encodeURIComponent(task.id)}/integration/verify`, undefined, AbortSignal.timeout(180000)); return 'The committed checkout matches the retained source changes. Integration evidence saved.'; })}>Verify committed integration</button>{!run?.sourceFingerprint && <p className="muted small">This older or incomplete run has no complete source fingerprint. Automatic integration verification is unavailable.</p>}</div>}{task.status === 'awaiting_review' && <div className="setup-actions"><p className="muted small">Review the saved report and worktree before deciding. Acceptance does not push, merge, deploy, or start a follow-up task.</p><button className="button primary" disabled={!available || action.busy} onClick={() => void action.run(async () => { await identity.request(`${prefix}/tasks/${encodeURIComponent(task.id)}/review`, { decision: 'accepted' }); return 'Result accepted. Final integration remains under your control.'; })}><Check size={15} />Accept reviewed result</button><button className="button" disabled={!available || action.busy} onClick={() => void action.run(async () => { await identity.request(`${prefix}/tasks/${encodeURIComponent(task.id)}/review`, { decision: 'changes_requested' }); return 'Changes requested. No new attempt starts without another approved task.'; })}>Request changes without rerunning</button></div>}</article>;

}

