import { useEffect, useRef, useState } from 'react';
import { Activity, Clipboard, Eye, FileSearch, Radio, ShieldCheck, Square, Unplug } from 'lucide-react';
import { apiInventoryRequestSchema, telemetryRegistrationSchema, type ApiEndpoint, type ApiInventory, type HttpObservation, type ServiceTraffic, type TelemetrySource, type TelemetryState, type TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';
import { EvidenceDialog } from './EvidenceDialog';

interface SourceSetup { source: TelemetrySource; setup: { endpoint: string; authorization: string; serviceName: string; protocol: 'http/protobuf'; compression: 'none' } }
interface ServiceView { sources: TelemetrySource[]; traffic: ServiceTraffic[]; inventories: ApiInventory[]; coverage: TelemetryState['coverage'] }

export function TelemetryPanel({ state, identity, cursor, available }: { state: TownState; identity: IdentityController; cursor: number; available: boolean }) {
  const local = state.repositories.filter(repo => repo.localPath);
  const [requestedRepoId, setRepoId] = useState(local[0]?.id ?? '');
  const repoId = local.some(repo => repo.id === requestedRepoId) ? requestedRepoId : '';
  const [serviceName, setServiceName] = useState('');
  const [openApiFiles, setOpenApiFiles] = useState('');
  const [setup, setSetup] = useState<SourceSetup | null>(null);
  const [reveal, setReveal] = useState(false);
  const [view, setView] = useState<ServiceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [evidence, setEvidence] = useState<{ kind: 'endpoint'; value: ApiEndpoint } | { kind: 'trace'; value: HttpObservation } | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  const latestCursor = useRef(cursor);
  latestCursor.current = cursor;
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}`;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const localIds = local.map(repo => repo.id).join(',');
  useEffect(() => { const ids = localIds ? localIds.split(',') : []; setRepoId(current => ids.includes(current) ? current : ''); }, [localIds]);
  useEffect(() => {
    if (!available) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let savedCursor = -1;
    const refresh = async () => {
      const current = latestCursor.current;
      if (current !== savedCursor) {
        try {
          const result = await identity.read<ServiceView>(`${prefix}/services`);
          if (!disposed) { setView(result); setRefreshError(false); savedCursor = current; }
        } catch { if (!disposed) setRefreshError(true); }
      }
      // Coalesce stream updates; high event rates cannot starve or flood this read.
      if (!disposed) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [available, identity.read, prefix]);
  const act = async (work: () => Promise<string | void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { const result = await work(); if (active.current && result) setNotice(result); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'This monitoring action could not be completed.'); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice('Copied. Paste it only into the selected service’s local telemetry configuration.'); }
    catch { setNotice('Clipboard access is unavailable. Reveal, select, and copy the value manually.'); }
  };
  const telemetry = state.telemetry;
  const scanning = telemetry?.inventoryOperation?.status === 'running';
  const sources = telemetry?.sources ?? view?.sources ?? [];
  const inventories = telemetry?.inventories ?? view?.inventories ?? [];
  return <section className="telemetry-panel" aria-label="Repository APIs and measured traffic">
    <div className="feature-heading"><Activity size={25} /><h3>See how your services behave.</h3><p>Discover API definitions and connect measurements from your running services. These are separate sources of information.</p></div>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
    {refreshError && <p className="form-notice" role="status">Traffic refresh is unavailable. Any displayed measurements are the last saved result.</p>}
    {!local.length ? <p className="empty">Connect a local repository before scanning API definitions or adding a telemetry source.</p> : <>
      <label className="standalone-field">API repository<select value={repoId} disabled={busy} onChange={event => { setRepoId(event.target.value); setOpenApiFiles(''); setServiceName(''); setError(null); setNotice(null); }}><option value="">Choose a local repository</option>{local.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>
      {!repoId && <p className="form-notice" role="status">Choose a repository before scanning definitions or preparing a service connection. A removed repository is never replaced automatically.</p>}
      <details className="workflow-details"><summary>Discover source API definitions</summary><form className="setup-form" onSubmit={event => { event.preventDefault(); void act(async () => {
        const paths = openApiFiles.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        const parsed = apiInventoryRequestSchema.safeParse({ repoId, ...(paths.length ? { openApiFiles: paths } : {}) });
        if (!parsed.success) throw new Error('Choose a repository and at most ten relative OpenAPI file paths.');
        await identity.request(`${prefix}/inventory/scan`, parsed.data);
        return 'Source discovery started. This reads definitions without running repository code.';
      }); }}><p className="muted small">Supported JavaScript, TypeScript, and Python patterns are scanned. Unrecognized or dynamic routes remain partial.</p><label>OpenAPI files (optional, one relative path per line)<textarea value={openApiFiles} onChange={event => setOpenApiFiles(event.target.value)} rows={3} placeholder="openapi.json" /></label><button className="button" disabled={!available || busy || scanning || !repoId}><FileSearch size={16} />Scan API definitions</button></form></details>
      {telemetry?.inventoryOperation && <p className="scan-state" role="status">{telemetry.inventoryOperation.message}</p>}
      {scanning && <button className="text-button" disabled={!available || busy} onClick={() => void act(async () => { await identity.request(`${prefix}/inventory/${encodeURIComponent(telemetry!.inventoryOperation!.id)}/cancel`); return 'Cancellation requested. Previous saved inventories stay available.'; })}><Square size={13} />Cancel API scan</button>}
      <details className="workflow-details"><summary>Connect measured service activity</summary><form className="setup-form" onSubmit={event => { event.preventDefault(); void act(async () => {
        const parsed = telemetryRegistrationSchema.safeParse({ repoId, serviceName: serviceName.trim() });
        if (!parsed.success) throw new Error('Use a service name with letters, digits, dots, underscores, or hyphens.');
        const result = await identity.request<SourceSetup>(`${prefix}/services`, parsed.data);
        if (active.current) { setSetup(result); setReveal(false); setServiceName(''); }
        return 'Telemetry source registered. Complete the local setup below; no traffic is measured until your service sends it.';
      }); }}><label>Running service name<input value={serviceName} onChange={event => setServiceName(event.target.value)} maxLength={80} required placeholder="backend-development" spellCheck={false} /></label><button className="button primary" disabled={!available || busy || !repoId || !serviceName.trim()}><Radio size={16} />Prepare service connection</button></form></details>
    </>}
    {setup && <article className="telemetry-credentials" aria-label="One-time service setup"><h3 className="subheading">Connect {setup.source.serviceName}</h3><ol><li>Open the telemetry settings for this running service or its local collector.</li><li>Use the exact service name below and the supplied local destination.</li><li>Choose HTTP/protobuf and no compression. Add the authorization value below.</li><li>Send a test request through your application, then check the measured activity.</li></ol><dl className="facts"><div><dt>Service name</dt><dd className="mono">{setup.setup.serviceName}</dd></div><div><dt>Destination</dt><dd className="mono">{setup.setup.endpoint}</dd></div><div><dt>Protocol</dt><dd>HTTP/protobuf</dd></div><div><dt>Compression</dt><dd>None</dd></div></dl><button className="text-button" onClick={() => void copy(setup.setup.endpoint)}><Clipboard size={14} />Copy telemetry destination</button><label className="standalone-field">One-time telemetry authorization<input type={reveal ? 'text' : 'password'} readOnly value={setup.setup.authorization} autoComplete="off" spellCheck={false} /></label><div className="setup-actions"><button className="button" onClick={() => setReveal(current => !current)}><Eye size={15} />{reveal ? 'Hide authorization' : 'Reveal authorization'}</button><button className="button" onClick={() => void copy(setup.setup.authorization)}><Clipboard size={15} />Copy authorization</button><button className="text-button" onClick={() => { setSetup(null); setReveal(false); }}>Close and clear this setup</button></div><p className="muted small">This credential is shown only for this setup. Closing the panel clears it from the browser. Revoke and create a new source if you lose it.</p></article>}
    <h3 className="subheading">Measured activity</h3>
    {!sources.length && <p className="empty">No running services are connected. Source definitions alone cannot provide request counts or latency.</p>}
    {sources.map(source => <article className="observation-card" key={source.id}><strong>{source.serviceName}</strong><p>{state.repositories.find(repo => repo.id === source.repoId)?.name ?? 'Repository unavailable'} · {source.status === 'receiving' ? 'Receiving telemetry' : source.status === 'revoked' ? 'Revoked' : 'Waiting for telemetry'}</p><TrafficDetails traffic={view?.traffic.find(item => item.serviceId === source.serviceId)} />{source.status !== 'revoked' && <button className="text-button" disabled={!available || busy} onClick={() => void act(async () => { await identity.request(`${prefix}/services/${encodeURIComponent(source.id)}/revoke`); if (active.current && setup?.source.id === source.id) setSetup(null); return 'Telemetry source revoked. Its existing saved measurements remain evidence.'; })}><Unplug size={14} />Revoke telemetry source</button>}</article>)}
    <h3 className="subheading">Discovered API definitions</h3>
    {!inventories.length && <p className="empty">No API inventory is saved yet.</p>}
    {inventories.map(inventory => <article className="inventory-card" key={inventory.repoId}><div className="section-summary"><strong>{state.repositories.find(repo => repo.id === inventory.repoId)?.name ?? 'Repository'}</strong><span>{inventory.coverage === 'partial' ? 'Partial coverage' : 'Scan complete'}</span></div><p>{inventory.filesScanned} files scanned · {new Date(inventory.scannedAt).toLocaleString()}</p>{inventory.issues.map((issue, index) => <p className="muted small" key={index}>{issue}</p>)}{!inventory.endpoints.length && <p className="muted small">No supported API definitions were found in this scan.</p>}{inventory.endpoints.map(endpoint => <button className="endpoint-row" key={endpoint.id} onClick={() => setEvidence({ kind: 'endpoint', value: endpoint })}><span className="method-tag">{endpoint.method}</span><span><strong>{endpoint.route ?? 'Dynamic route · unavailable'}</strong><small>{endpoint.framework} · {endpoint.confidence === 'partial' ? 'Partial definition' : 'Declared in source'}</small></span><FileSearch size={15} /></button>)}</article>)}
    {(telemetry?.spans.length ?? 0) > 0 && <><h3 className="subheading">Sampled request evidence</h3>{telemetry!.spans.slice(-20).reverse().map(span => <button className="endpoint-row" key={span.id} onClick={() => setEvidence({ kind: 'trace', value: span })}><span className="method-tag">{span.method ?? '?'}</span><span><strong>{span.route ?? 'Route unavailable'}</strong><small>{span.durationMs.toFixed(2)} ms · {span.statusCode ?? 'Status unavailable'}</small></span><FileSearch size={15} /></button>)}</>}
    <div className="note"><ShieldCheck size={16} /><p>Counts come from one selected measurement source. Metrics and sampled traces are never added together. Bodies, sensitive headers, and URL secrets are excluded.</p></div>
    {evidence && <EvidenceDialog title={evidence.kind === 'endpoint' ? 'API source evidence' : 'Sampled request evidence'} onClose={() => setEvidence(null)}>{evidence.kind === 'endpoint' ? <EndpointEvidence endpoint={evidence.value} /> : <TraceEvidence span={evidence.value} />}</EvidenceDialog>}
  </section>;
}

function TrafficDetails({ traffic }: { traffic?: ServiceTraffic }) {
  const count = (value: number | null | undefined) => value === null || value === undefined ? 'Unavailable' : value.toLocaleString();
  const latency = (value: number | null | undefined) => value === null || value === undefined ? 'Unavailable' : `${value.toFixed(2)} ms`;
  return <><dl><div><dt>Measurement source</dt><dd>{traffic?.source === 'metrics' ? 'HTTP metrics' : traffic?.source === 'sampled-spans' ? 'Sampled traces' : 'Unavailable'}</dd></div><div><dt>Requests</dt><dd>{count(traffic?.requestCount)}</dd></div><div><dt>Errors</dt><dd>{count(traffic?.errorCount)}</dd></div><div><dt>Mean latency</dt><dd>{latency(traffic?.meanLatencyMs)}</dd></div><div><dt>p50 / p95 latency</dt><dd>{latency(traffic?.p50LatencyMs)} / {latency(traffic?.p95LatencyMs)}</dd></div><div><dt>Coverage</dt><dd>{!traffic || traffic.source === 'unavailable' ? 'No measurements' : traffic.partial ? 'Partial observations' : 'Received measurement interval'}</dd></div></dl>{traffic?.latencyKind === 'histogram-upper-bound' && <p>Latency percentiles are histogram upper bounds.</p>}{traffic?.from && traffic.through && <p>Window: {new Date(traffic.from).toLocaleString()} – {new Date(traffic.through).toLocaleString()}</p>}</>;
}
function EndpointEvidence({ endpoint }: { endpoint: ApiEndpoint }) { return <><p className="evidence-intro">This is a source definition. It does not prove that an endpoint is running or receiving traffic.</p><dl className="facts"><div><dt>Method</dt><dd>{endpoint.method}</dd></div><div><dt>Route template</dt><dd className="mono">{endpoint.route ?? 'Unavailable · dynamic definition'}</dd></div><div><dt>Framework</dt><dd>{endpoint.framework}</dd></div><div><dt>Source file</dt><dd className="mono">{endpoint.source.path}:{endpoint.source.line}</dd></div><div><dt>Source hash</dt><dd className="mono">{endpoint.source.hash}</dd></div><div><dt>Confidence</dt><dd>{endpoint.confidence}</dd></div></dl>{endpoint.reason && <p>{endpoint.reason}</p>}</>; }
function TraceEvidence({ span }: { span: HttpObservation }) { return <><p className="evidence-intro">A saved sampled request. This may represent only part of the service’s traffic.</p><dl className="facts"><div><dt>Method</dt><dd>{span.method ?? 'Unavailable'}</dd></div><div><dt>Route template</dt><dd className="mono">{span.route ?? 'Unavailable'}</dd></div><div><dt>Status</dt><dd>{span.statusCode ?? 'Unavailable'}</dd></div><div><dt>Reported error</dt><dd>{span.error === null ? 'Unavailable' : span.error ? 'Yes' : 'No'}</dd></div><div><dt>Duration</dt><dd>{span.durationMs.toFixed(2)} ms</dd></div><div><dt>Observed at</dt><dd>{new Date(span.occurredAt).toLocaleString()}</dd></div><div><dt>Trace ID</dt><dd className="mono">{span.traceId}</dd></div><div><dt>Span ID</dt><dd className="mono">{span.spanId}</dd></div><div><dt>Linked run</dt><dd className="mono">{span.runId ?? 'Not linked'}</dd></div></dl><p className="muted">Request bodies, sensitive headers, and URL secrets are excluded.</p></>; }
