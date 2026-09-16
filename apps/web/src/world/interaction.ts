import type { Agent } from '@agent-town/contracts';

export type Selection = { kind: 'agent' | 'repo'; id: string } | { kind: 'manager' };
export interface RoomView { repoId: string; agentIds: (string | null)[] }
export interface CameraAction {
  kind: 'reset' | 'in' | 'out' | 'focus' | 'room' | 'return' | 'pan';
  point?: [number, number];
  direction?: 'left' | 'right' | 'up' | 'down';
  nonce: number;
}

export const ROOM_PAGE_SIZE = 6;

export function canUseDesk(agent: Agent): boolean {
  return agent.activity === 'working' || agent.activity === 'testing' || agent.activity === 'waiting' || agent.activity === 'idle' || agent.activity === 'unknown';
}

export function isActivityStale(agent: Agent, connected: boolean, now: number): boolean {
  if (agent.activity === 'unknown' && !agent.observation) return false;
  if (!connected) return true;
  if (!agent.observation) return false;
  const sourceTime = Date.parse(agent.observation.sourceTime);
  return agent.observation.freshness === 'stale' || !Number.isFinite(sourceTime) || sourceTime > now + 5000 || now - sourceTime >= 120000;
}
