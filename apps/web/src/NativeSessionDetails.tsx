import type { Agent, TownState } from '@agent-town/contracts';
import { agentDisplayName } from './agentDisplayName';
import { sessionHierarchy } from './sessionHierarchy';
import { ChildActivity } from './SessionPresentation';

function Timestamp({ value }: { value: string | null | undefined }) {
  return value && Number.isFinite(Date.parse(value)) ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : <>Not received</>;
}

export function NativeSessionDetails({ agent, state, connected, now, onSelect, onTracking }: {
  agent: Agent; state: TownState; onSelect: (id: string) => void; onTracking: (repoId: string) => void;
  connected: boolean; now: number;
}) {
  const sourceId = agent.discovery?.sourceId ?? agent.observation?.nativeSourceId;
  const sessionId = agent.discovery?.nativeSessionId ?? agent.observation?.sessionId;
  const parentId = agent.discovery?.parentNativeSessionId ?? agent.observation?.parentSessionId;
  const repository = state.repositories.find(repo => repo.id === agent.repoId);
  const hierarchy = sessionHierarchy(state.agents);
  const parent = hierarchy.parentById.get(agent.id);
  const children = hierarchy.childrenById.get(agent.id) ?? [];
  const connections = state.observation?.connections.filter(connection => connection.repoId === agent.repoId
    && (sourceId ? connection.nativeSourceId === sourceId : connection.id === agent.observation?.connectionId)) ?? [];
  const currentConnections = connections.filter(connection => connection.status !== 'revoked');
  return <section className="native-session-inspector" aria-label="Native session details">
    {!agent.observation && <div className="note"><p><strong>Session found · work details not received</strong><br />This character was found in local session metadata. Its task, actions and results are unavailable until the native tool supplies them. Subscription sign-in verifies account access; it does not enable activity tracking.</p></div>}
    <dl className="facts">
      {agent.discovery?.nativeAgentName && <div><dt>Native agent name</dt><dd>{agent.discovery.nativeAgentName}</dd></div>}
      {agent.discovery?.title && <div><dt>Session name</dt><dd>{agent.discovery.title}</dd></div>}
      {repository?.localPath && <div><dt>Project folder</dt><dd className="mono">{repository.localPath}</dd></div>}
      <div><dt>Native session</dt><dd className="mono">{sessionId ?? 'Unavailable'}</dd></div>
      <div><dt>Parent session</dt><dd>{parentId ? <><span className="mono">{parentId}</span>{parent && <button className="text-button parent-session-link" onClick={() => onSelect(parent.id)}>Inspect parent · {agentDisplayName(parent)}</button>}{!parent && <small>Parent unavailable. A unique parent in this project and source could not be matched in town. Review the saved session inventory.</small>}</> : 'Not recorded'}</dd></div>
      {agent.discovery && <><div><dt>Found by discovery</dt><dd><Timestamp value={agent.discovery.discoveredAt} /></dd></div><div><dt>Native history updated</dt><dd><Timestamp value={agent.discovery.nativeUpdatedAt} /></dd></div></>}
      <div><dt>Last activity from this session</dt><dd><Timestamp value={agent.observation?.sourceTime} /></dd></div>
    </dl>
    {children.length > 0 && <section className="detail-section" aria-label="Child agents">
      <h3>{children.length} child agents</h3>
      <p className="muted small">These sessions were spawned by this session. Each keeps its own activity and reports. Stored history does not establish that it is running.</p>
      <ul className="session-children">{children.map(child => <li key={child.id}><button className="text-button" aria-label={`Inspect child · ${agentDisplayName(child)}`} onClick={() => onSelect(child.id)}>{agentDisplayName(child)}</button><ChildActivity agent={child} state={state} connected={connected} now={now} /></li>)}</ul>
    </section>}
    <h3 className="subheading">Activity tracking</h3>
    {!currentConnections.length && <p className="muted">{connections.length ? 'Tracking was revoked for this source. Saved details remain available.' : 'No activity connection is registered for this session source and project.'}</p>}
    {currentConnections.map(connection => <article className="observation-card" key={connection.id}>
      <strong>{connection.label}</strong>
      <p>{connection.status === 'receiving' ? 'Events received from this connection' : 'Waiting for the first native event'}</p>
      <p className="muted small">Connection last received: <Timestamp value={connection.lastEventAt} />. This can belong to another session.</p>
      {connection.binding === 'ambiguous' && <p className="form-notice">The native source is ambiguous. Review tracking before attributing activity.</p>}
      {connection.delivery?.status !== undefined && connection.delivery.status !== 'idle' && <p className="form-notice">{connection.delivery.message ?? 'Some events are waiting for delivery.'}</p>}
      {connection.diagnostics?.map(diagnostic => <p className="muted small" key={diagnostic.code}>{diagnostic.message}</p>)}
    </article>)}
    <button className="button" onClick={() => onTracking(agent.repoId)}>Review activity tracking</button>
    <p className="muted small">Task descriptions, changed files and reports depend on what the native tool supports and sends. Hook configuration alone does not prove delivery.</p>
  </section>;
}
