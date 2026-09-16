import type { Agent, Repository } from './index.js';

type House = Pick<Repository, 'id' | 'position'>;
type Resident = Pick<Agent, 'id' | 'repoId' | 'home'>;
type Point = [number, number];
export const RETAINED_AGENT_LIMIT = 200;
export const AGENT_HOME_SPACING = 1.1;
export const AGENT_HOME_RADIUS = 18.4;
const finitePoint = (point: readonly number[]) => point.length === 2 && point.every(value => Number.isFinite(value) && Math.abs(value) <= 1024);
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const offsets: Point[] = [];
for (let x = -16; x <= 16; x++) for (let z = -16; z <= 16; z++) {
  const point: Point = [x * 1.15, z * 1.15];
  if (Math.hypot(...point) <= AGENT_HOME_RADIUS) offsets.push(point);
}
// Nearby front-door ground wins ties, then the sides/back. No random scene state.
const score = ([x, z]: Point) => x * x + z * z + (z < 0 ? 3 : 0) + Math.abs(x) * 0.01;
offsets.sort((a, b) => score(a) - score(b) || b[1] - a[1] || a[0] - b[0]);

function clearGround(home: Point, repositories: readonly House[], occupied: readonly Resident[], id?: string): boolean {
  if (!finitePoint(home)) return false;
  // Includes the house foundation/roof margin. Keep the central manager area free.
  if (Math.abs(home[0]) < 2.3 && home[1] > -4.3 && home[1] < 1.6) return false;
  if (repositories.some(repo => Math.abs(home[0] - repo.position[0]) < 3.15 && Math.abs(home[1] - repo.position[1]) < 2.65)) return false;
  return !occupied.some(agent => agent.id !== id && finitePoint(agent.home) && distance(home, agent.home) < AGENT_HOME_SPACING);
}

/** Stable persisted homes shared by observed sessions and managed runs. No model calls. */
export function allocateAgentHome(repoId: string, repositories: readonly House[], agents: readonly Resident[], agentId?: string): Point {
  const repo = repositories.find(repo => repo.id === repoId);
  if (!repo || repositories.some(repo => !finitePoint(repo.position)) || repositories.length > 200 || agents.length > RETAINED_AGENT_LIMIT) throw new Error('Agent placement requires a selected repository and bounded workspace.');
  const existing = agentId ? agents.find(agent => agent.id === agentId && agent.repoId === repoId) : undefined;
  if (existing && distance(existing.home, repo.position) <= AGENT_HOME_RADIUS && clearGround(existing.home, repositories, agents, agentId)) return [...existing.home];
  if (!existing && agents.length >= RETAINED_AGENT_LIMIT) throw new Error('The workspace has reached its retained agent limit.');
  for (const offset of offsets) {
    const home: Point = [Number((repo.position[0] + offset[0]).toFixed(4)), Number((repo.position[1] + offset[1]).toFixed(4))];
    if (clearGround(home, repositories, agents, agentId)) return home;
  }
  throw new Error('No clear agent position is available near this repository.');
}

/** Translate homes with moved houses and repair old overlaps without moving valid residents. */
export function reconcileAgentHomes<T extends Resident>(repositories: readonly House[], agents: readonly T[], previousRepositories: readonly House[] = repositories): T[] {
  const previous = new Map(previousRepositories.map(repo => [repo.id, repo]));
  const current = new Map(repositories.map(repo => [repo.id, repo]));
  const candidates = agents.map(agent => {
    const before = previous.get(agent.repoId), after = current.get(agent.repoId);
    if (!before || !after) return agent;
    const home: Point = [Number((agent.home[0] + after.position[0] - before.position[0]).toFixed(4)), Number((agent.home[1] + after.position[1] - before.position[1]).toFixed(4))];
    return { ...agent, home };
  });
  const placed: T[] = [], pending: T[] = [];
  // Stable ID ordering makes a legacy collision's winner independent of array order.
  for (const agent of [...candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const repo = current.get(agent.repoId);
    if (!repo || distance(agent.home, repo.position) <= AGENT_HOME_RADIUS && clearGround(agent.home, repositories, placed, agent.id)) placed.push(agent);
    else pending.push(agent);
  }
  for (const agent of pending) placed.push({ ...agent, home: allocateAgentHome(agent.repoId, repositories, placed) });
  const byId = new Map(placed.map(agent => [agent.id, agent]));
  return agents.map(agent => byId.get(agent.id)!);
}
