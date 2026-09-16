import { agentDisplayName, agentSearchText } from './agentDisplayName';
import { useEffect, useState } from 'react';
import { activityLabel, type Agent, type TownState } from '@agent-town/contracts';
import { ArrowUpRight, Search, Users } from 'lucide-react';
import { isActivityStale } from './world/interaction';
import { sessionHierarchy } from './sessionHierarchy';
import { ChildActivity, ChildAgentControl, sessionSummary } from './SessionPresentation';

export function RepositoryAgents({ state, repoId, connected, selectedId, onSelect, onSetUpTracking, showChildAgents = false, onShowChildAgents, showControls = true }: { state: TownState; repoId: string; connected: boolean; selectedId?: string; onSelect: (id: string) => void; onSetUpTracking?: (repoId: string) => void; showChildAgents?: boolean; onShowChildAgents?: (value: boolean) => void; showControls?: boolean }) {
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
  return <section className="repository-agents" data-testid="repository-agents" data-repo-id={repoId} aria-label="Agents in this repository">
    <div className="section-summary"><h3><Users size={17} />Repository sessions</h3><span>{state.workspace.mode === 'demo' ? `${residents.length} sample` : `${sessionSummary(savedResidents)} in town`}</span></div>
    {showControls && onShowChildAgents && <ChildAgentControl count={hierarchy.children.length} checked={showChildAgents} onChange={onShowChildAgents} />}
    {!connected && <p className="room-notice" role="status">Reconnecting · showing last reported activity.</p>}
    {residents.length > 0 && <label className="search"><Search size={16} /><input aria-label="Find a repository agent" placeholder="Search names, tools or tasks" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    {sections.map(section => section.agents.length > 0 && <div key={section.name} className="resident-group"><h4>{section.name}</h4>{section.agents.map(agent => {
      const sourceRevoked = agent.observation && state.observation?.connections.some(source => source.id === agent.observation!.connectionId && source.status === 'revoked');
      const stale = isActivityStale(agent, connected && !sourceRevoked, now);
      const stamp = agent.observation?.sourceTime ?? agent.updatedAt;
      return <div key={agent.id}><button type="button" className={`agent-row ${agent.id === selectedId ? 'selected' : ''}`} data-agent-id={agent.id} aria-label={`Inspect ${agentDisplayName(agent)}`} onClick={() => onSelect(agent.id)}>
        <span className="resident-avatar" style={{ backgroundColor: agent.color }} aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <span className="agent-row-body"><strong>{agentDisplayName(agent)}<small>{toolLabel(agent)}</small></strong><span className={`status status-${agent.activity}`}>{activityLabel[agent.activity]}</span>{stale && <span className="stale-tag">Last reported · stale</span>}<span className="resident-task">{agent.task || 'Assignment unavailable'}</span>{agent.activity === 'unknown' && !agent.observation ? <small>Discovered history · no activity received</small> : <small>Reported {Number.isFinite(Date.parse(stamp)) ? new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'time unavailable'}</small>}{(agent.observation?.parentSessionId ?? agent.discovery?.parentNativeSessionId) && <small>Child session · parent {agent.observation?.parentSessionId ?? agent.discovery?.parentNativeSessionId}</small>}</span><ArrowUpRight size={15} />
      </button>
      {hierarchy.unresolved.some(candidate => candidate.id === agent.id) && <p className="muted small">Parent unavailable</p>}
      {!showChildAgents && (hierarchy.childrenById.get(agent.id)?.length ?? 0) > 0 && <details className="session-child-disclosure"><summary>{hierarchy.childrenById.get(agent.id)!.length} child agents</summary><ul className="session-children">{hierarchy.childrenById.get(agent.id)!.map(child => <li key={child.id}><button className="text-button" aria-label={`Inspect child · ${agentDisplayName(child)}`} onClick={() => onSelect(child.id)}>{agentDisplayName(child)}</button><ChildActivity agent={child} state={state} connected={connected} now={now} /></li>)}</ul></details>}
      </div>;
    })}</div>)}
    {!residents.length && <div className="room-empty"><Users size={24} /><h3>{connected ? 'No observed sessions for this repository' : 'Session information is unavailable'}</h3><p>{connected ? 'Find existing local sessions and enable future activity updates. Adding a repository starts no agents.' : 'The last snapshot contains no sessions. Reconnect before treating this room as empty.'}</p></div>}
    {state.workspace.mode !== 'demo' && state.repositories.some(repo => repo.id === repoId && repo.localPath) && onSetUpTracking && <button className="button" onClick={() => onSetUpTracking(repoId)}>Set up tracking</button>}
    {residents.length > 0 && filtered.length === 0 && <p className="empty">{!showChildAgents && hierarchy.children.length ? "No primary sessions match. Enable Show child agents to search child names." : "No sessions match your search."}</p>}
    <p className="muted small">Activity reflects received updates. A response finishing does not accept a task or acknowledge a manager report.</p>
  </section>;
}
