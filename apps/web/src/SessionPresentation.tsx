import { activityLabel, type Agent, type TownState } from '@agent-town/contracts';
import { sessionHierarchy } from './sessionHierarchy';
import { isActivityStale } from './world/interaction';

export function sessionSummary(agents: readonly Agent[]): string {
  const groups = sessionHierarchy(agents);
  return `${groups.primary.length - groups.unresolved.length} primary sessions · ${groups.children.length} child agents${groups.unresolved.length ? ` · ${groups.unresolved.length} parent unavailable` : ''}`;
}

export function ChildAgentControl({ count, checked, onChange }: { count: number; checked: boolean; onChange: (value: boolean) => void }) {
  if (!count) return null;
  return <label className="child-agent-control"><input type="checkbox" aria-label="Show child agents" checked={checked} onChange={event => onChange(event.target.checked)} /><span>Show child agents ({count})</span></label>;
}

export function ChildActivity({ agent, state, connected, now }: { agent: Agent; state: TownState; connected: boolean; now: number }) {
  const revoked = state.observation?.connections.some(source => source.id === agent.observation?.connectionId && source.status === 'revoked');
  return <small>{agent.activity === 'unknown' ? 'Activity unknown' : `Last reported · ${activityLabel[agent.activity]}${isActivityStale(agent, connected && !revoked, now) ? ' · stale' : ''}`}</small>;
}
