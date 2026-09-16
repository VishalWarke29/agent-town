import { agentDisplayName } from './agentDisplayName';
import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react';
import { activityLabel, type AgentArchiveReview, type AgentHistoryDetail, type AgentHistoryPage, type TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';

const when = (value: string) => new Date(value).toLocaleString();

interface Props { state: TownState; identity: IdentityController; available: boolean; onSelectAgent?: (id: string) => void }
export function HistoryPanel(props: Props) { return <WorkspaceHistory key={props.state.workspace.id} {...props} />; }
function WorkspaceHistory({ state, identity, available, onSelectAgent }: Props) {
  const [view, setView] = useState<'active' | 'history'>('active');
  const [page, setPage] = useState<AgentHistoryPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reportOffset, setReportOffset] = useState(0);
  const [detail, setDetail] = useState<AgentHistoryDetail | null>(null);
  const [review, setReview] = useState<AgentArchiveReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false), mounted = useRef(true);
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (view !== 'history' || !available) return;
    const abort = new AbortController(); setLoading(true); setError(null);
    if (detailId) setDetail(null); else setPage(null);
    const path = detailId ? `${prefix}/history/agents/${encodeURIComponent(detailId)}?offset=${reportOffset}` : `${prefix}/history/agents?offset=${offset}`;
    identity.request<AgentHistoryPage | AgentHistoryDetail>(path, undefined, AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]), 'GET')
      .then(result => { if (abort.signal.aborted) return; if (detailId) setDetail(result as AgentHistoryDetail); else setPage(result as AgentHistoryPage); })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'History could not be loaded. Retry after reconnecting.'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [view, available, prefix, detailId, offset, reportOffset, revision, state.history?.updatedAt, identity.request]);

  const act = async (work: () => Promise<void>) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await work(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'This history action failed. Try again.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const reviewAgent = (id: string) => void act(async () => {
    const value = await identity.request<AgentArchiveReview>(`${prefix}/agents/${encodeURIComponent(id)}/archive`, undefined, undefined, 'GET');
    if (mounted.current) setReview(value);
  });
  const archive = () => review && void act(async () => {
    await identity.request(`${prefix}/agents/${encodeURIComponent(review.agentId)}/archive`, { reviewToken: review.reviewToken });
    if (mounted.current) { setReview(null); setNotice('Session archived. Its reports and identity remain in History; a newer active event can resume it.'); setRevision(value => value + 1); }
  });

  return <section className="session-history" aria-label="Sessions and history">
    <div className="segmented" aria-label="Session view">
      <button aria-pressed={view === 'active'} onClick={() => { setView('active'); setError(null); }}>In town ({state.agents.length})</button>
      <button aria-pressed={view === 'history'} onClick={() => { setView('history'); setReview(null); setOffset(0); setDetailId(null); setDetail(null); setError(null); }}>History ({state.history?.archivedAgents ?? 0})</button>
    </div>
    <p className="muted small">The live town holds up to 200 sessions. Archive ended sessions to free space. Reports, accounts, task evidence and context versions stay saved.</p>
    {!available && <p className="muted small" role="status">Reconnect to the local service to load history or archive sessions.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="form-notice" role="status">{notice}</p>}
    {view === 'active' && <>
      {!state.agents.length && <p className="muted small">No sessions are in the live town. Archived sessions are available in History.</p>}
      {state.agents.map(agent => <article className="observation-card" key={agent.id}>
        <strong>{agentDisplayName(agent)}</strong><p>{agent.provider} · {state.repositories.find(repo => repo.id === agent.repoId)?.name ?? agent.repoId} · {agent.activity === 'unknown' && agent.discovery ? 'Discovered · activity unknown' : activityLabel[agent.activity]}</p>
        <div className="setup-actions">{onSelectAgent && <button className="button" onClick={() => onSelectAgent(agent.id)}>Open {agentDisplayName(agent)} details</button>}<button className="button" disabled={!available || busy} onClick={() => reviewAgent(agent.id)}><Archive size={15} />Review archive for {agentDisplayName(agent)}</button></div>
        {review?.agentId === agent.id && <section className="archive-review" aria-label={`Archive review for ${agentDisplayName(agent)}`}>
          <p className="small">Archive <strong>{review.name}</strong> from <strong>{review.repositoryName}</strong>? {review.reportCount} saved reports stay available. No files are deleted and no work is accepted by this action.</p>
          {!review.allowed && <ul className="setup-steps">{review.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          <p className="muted small">Only ended or explicitly disconnected sessions can leave the town. A new active event resumes the same identity when capacity is available.</p>
          <div className="setup-actions"><button className="button primary" disabled={!available || busy || !review.allowed} onClick={archive}>Archive session</button><button className="button" disabled={busy} onClick={() => setReview(null)}>Keep in town</button></div>
        </section>}
      </article>)}
    </>}
    {view === 'history' && <>
      <button className="button" disabled={!available || loading} onClick={() => setRevision(value => value + 1)}>{loading ? <LoaderCircle size={15} className="spin" /> : <Archive size={15} />}Refresh history</button>
      {loading && <p className="muted small" role="status">Reading saved history…</p>}
      {detailId ? <>
        <button className="text-button" onClick={() => { setDetailId(null); setDetail(null); setError(null); }}><ArrowLeft size={14} />Back to session history</button>
        {detail && detail.agent.id === detailId && <article className="history-detail">
          <h3>{agentDisplayName(detail.agent)}</h3><p className="muted small">{detail.repository.name} · Archived {when(detail.archivedAt)} · Saved state: {activityLabel[detail.agent.activity]}</p>
          {detail.repository.localPath && <code className="repo-path">{detail.repository.localPath}</code>}
          <dl className="facts"><div><dt>Session identity</dt><dd>{detail.agent.observation?.sessionId ?? detail.agent.discovery?.nativeSessionId ?? detail.agent.id}</dd></div><div><dt>Parent session</dt><dd>{detail.agent.observation?.parentSessionId ?? detail.agent.discovery?.parentNativeSessionId ?? 'None'}</dd></div><div><dt>Context received</dt><dd>{detail.agent.contextVersion === null ? 'Unavailable' : `v${detail.agent.contextVersion}`}</dd></div><div><dt>Saved reports</dt><dd>{detail.reportCount}</dd></div></dl>
          {detail.runs.map(run => <p className="muted small" key={run.id}>Run {run.id}: {run.status} · {run.mode} · {run.model} · Account {run.connectionId} · Context v{run.contextVersion} ({run.contextDelivery})</p>)}
          {detail.tasks.map(task => <p className="muted small" key={task.id}>Task review: {task.status.replaceAll('_', ' ')}{task.archivedAt ? ' · Task archived' : ' · Task remains in Tasks'}. Worker completion, human review and manager context are separate states.</p>)}
          {!detail.reports.length && <p className="muted small">No reports are saved for this session.</p>}
          {detail.reports.map(report => <article className="observation-card" key={report.id}><strong>{report.details?.outcome ?? 'Reported response'}</strong><p>{when(report.createdAt)} · {report.status} · {report.contextVersion === null ? 'Manager context pending' : `Manager context v${report.contextVersion}`}</p><p className="history-report">{report.summary}</p>{report.details && <><p className="muted small">Files: {report.details.files.status === 'unavailable' ? 'Unavailable' : report.details.files.paths.join(', ') || 'None reported'}</p><ul className="setup-steps">{report.details.checks.map((check, index) => <li key={`${check.name}-${index}`}>{check.name}: {check.result} · {check.evidence}</li>)}</ul></>}</article>)}
          <div className="setup-actions"><button className="button" disabled={loading || reportOffset === 0} onClick={() => setReportOffset(value => Math.max(0, value - 25))}>Newer reports</button><button className="button" disabled={loading || detail.reportsNextOffset === null} onClick={() => setReportOffset(detail.reportsNextOffset!)}>Older reports</button></div>
        </article>}
      </> : <>
        {page && !loading && page.total === 0 && <p className="muted small">No sessions have been archived yet.</p>}
        {page?.items.map(item => <article className="observation-card" key={item.id}><strong>{item.name}</strong><p>{item.repositoryName} · {activityLabel[item.activity]} · Archived {when(item.archivedAt)}</p><button className="button" onClick={() => { setDetailId(item.id); setReportOffset(0); setDetail(null); }}>Open history for {item.name}</button></article>)}
        {page && <div className="setup-actions"><p className="muted small">{page.total} archived sessions · page {Math.floor(offset / 25) + 1}</p><button className="button" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 25))}><ArrowLeft size={14} />Newer sessions</button><button className="button" disabled={loading || page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>Older sessions<ArrowRight size={14} /></button></div>}
      </>}
    </>}
  </section>;
}
