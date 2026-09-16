import { useEffect, useState } from 'react';
import { FileText, LoaderCircle, RotateCcw } from 'lucide-react';
import type { AgentReportPage, Handoff, TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';

interface Props { state: TownState; identity: IdentityController; agentId: string; available: boolean }
const pageSize = 25;
const when = (value: string) => new Date(value).toLocaleString();

/** Workspace/session changes discard cached evidence and cancel the previous read. */
export function SessionReports(props: Props) {
  return <SelectedSessionReports key={JSON.stringify([props.state.workspace.id, props.agentId])} {...props} />;
}

function SelectedSessionReports({ state, identity, agentId, available }: Props) {
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; page: AgentReportPage } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const reportRevision = JSON.stringify(state.handoffs.filter(report => report.agentId === agentId).map(report => [report.id, report.status, report.contextVersion]));
  const key = JSON.stringify([offset, revision, reportRevision, state.history?.updatedAt]);
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}/agents/${encodeURIComponent(agentId)}/reports`;
  const page = available && loaded?.key === key ? loaded.page : null;
  const error = available && failure?.key === key ? failure.message : null;
  const loading = available && !page && !error;

  useEffect(() => {
    if (!available) { setLoaded(null); setFailure(null); return; }
    const abort = new AbortController();
    identity.request<AgentReportPage>(`${prefix}?offset=${offset}&limit=${pageSize}`, undefined, AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]), 'GET')
      .then(value => { if (!abort.signal.aborted) { setLoaded({ key, page: value }); setFailure(null); } })
      .catch(cause => {
        if (abort.signal.aborted) return;
        const message = cause instanceof Error && cause.name === 'TimeoutError' ? 'Saved reports took too long to load. Retry when the local service is ready.'
          : cause instanceof Error ? cause.message : 'Saved reports could not be loaded. Retry after reconnecting.';
        setFailure({ key, message });
      });
    return () => abort.abort();
  }, [available, prefix, offset, key, identity.request]);

  return <section className="detail-section history-detail" aria-label="Saved reports" data-testid="session-reports" aria-busy={loading}>
    <div className="section-summary"><h3><FileText size={16} />Saved reports</h3>{page && <span>{page.reportCount} saved</span>}</div>
    <p className="muted small">Reports are saved evidence. Manager processing, task acceptance and delivery of updated context are separate steps.</p>
    {!available && <p className="muted small" role="status">Reconnect to the local service to read saved reports.</p>}
    {loading && <p className="muted small" role="status"><LoaderCircle size={15} className="spin" />Reading saved reports…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="button" disabled={!available || loading} onClick={() => setRevision(value => value + 1)}><RotateCcw size={15} />{error ? 'Retry reports' : 'Refresh reports'}</button>
    {page && <>
      {!page.reportCount && <p className="muted small">No reports are saved for this session. Discovered history does not import past responses; a supported report event must be received.</p>}
      {page.reportCount > 0 && !page.reports.length && <p className="muted small">No reports remain on this page. Open a newer page.</p>}
      {page.reports.map(report => <SavedReport key={report.id} report={report} />)}
      {(page.reportCount > pageSize || offset > 0) && <div className="setup-actions" aria-label="Report pages">
        <p className="muted small">{page.reports.length ? `${offset + 1}–${offset + page.reports.length} of ${page.reportCount} reports` : `${page.reportCount} saved reports`}</p>
        <button type="button" className="button" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>Newer reports</button>
        <button type="button" className="button" disabled={page.reportsNextOffset === null} onClick={() => setOffset(page.reportsNextOffset!)}>Older reports</button>
      </div>}
    </>}
  </section>;
}

function EvidenceList({ title, values }: { title: string; values: string[] }) {
  return <><h4>{title}</h4>{values.length ? <ul className="setup-steps history-report">{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p className="muted small">None reported.</p>}</>;
}

function SavedReport({ report }: { report: Handoff }) {
  const details = report.details;
  return <article className="observation-card" aria-label={`Report saved ${when(report.createdAt)}`}>
    <strong>{details?.outcome === 'completed-response' ? 'Response finished' : details?.outcome.replaceAll('-', ' ') ?? 'Reported response'}</strong>
    <dl className="facts">
      <div><dt>Report storage</dt><dd>Saved <time dateTime={report.createdAt}>{when(report.createdAt)}</time></dd></div>
      <div><dt>Manager processing</dt><dd>{report.status === 'processed' ? 'Processed' : 'Pending'}</dd></div>
      <div><dt>Manager context</dt><dd>{report.contextVersion === null ? 'No version recorded' : `v${report.contextVersion}`}</dd></div>
      <div><dt>Updated context delivery</dt><dd>Unsupported for this report</dd></div>
    </dl>
    <p className="history-report">{report.summary}</p>
    {details ? <details className="workflow-details"><summary>Report evidence and limitations</summary>
      <dl className="facts">
        <div><dt>Reported at</dt><dd>{when(details.occurredAt)}</dd></div>
        <div><dt>Context used for this report</dt><dd>{details.contextVersionUsed === null ? 'Unavailable' : `v${details.contextVersionUsed}`}</dd></div>
        <div><dt>Task</dt><dd>{details.taskId ?? 'Not linked'}</dd></div><div><dt>Run</dt><dd>{details.runId ?? 'Not linked'}</dd></div>
        <div><dt>Branch</dt><dd>{details.branch ?? 'Unavailable'}</dd></div><div><dt>Base commit</dt><dd>{details.baseCommit ?? 'Unavailable'}</dd></div>
        <div><dt>Worktree</dt><dd>{details.worktreePath ?? 'Unavailable'}</dd></div>
        <div><dt>Source event</dt><dd>{details.sourceEventId}</dd></div>
      </dl>
      <h4>Files · {details.files.status}</h4>
      {details.files.status === 'unavailable' ? <p className="muted small">File changes are unavailable.</p> : details.files.paths.length ? <ul className="setup-steps history-report">{details.files.paths.map((path, index) => <li key={index}><code>{path}</code></li>)}</ul> : <p className="muted small">No files reported.</p>}
      <h4>Checks</h4>{details.checks.length ? <ul className="setup-steps history-report">{details.checks.map((check, index) => <li key={index}><strong>{check.name}</strong>: {check.result} · Evidence {check.evidence}{check.reference && <p>{check.reference}</p>}</li>)}</ul> : <p className="muted small">No check results reported.</p>}
      <EvidenceList title="Decisions" values={details.decisions} /><EvidenceList title="Assumptions" values={details.assumptions} />
      <EvidenceList title="Remaining work" values={details.remainingWork} /><EvidenceList title="Evidence references" values={details.evidenceRefs} /><EvidenceList title="Limitations" values={details.limitations} />
    </details> : <p className="muted small">Structured evidence and limitations are unavailable for this report.</p>}
  </article>;
}
