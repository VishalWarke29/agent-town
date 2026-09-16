import type { Agent, Repository } from '@agent-town/contracts';

export function campusBounds(repositories: Repository[], reportingAgents: number, agents: Pick<Agent, 'home'>[] = []) {
  const homes = agents.filter(agent => agent.home.every(value => Number.isFinite(value) && Math.abs(value) <= 1024));
  return {
    minX: Math.min(-15, ...repositories.map(repo => repo.position[0] - 5), ...homes.map(agent => agent.home[0] - 1.5)),
    maxX: Math.max(15, ...repositories.map(repo => repo.position[0] + 5), ...homes.map(agent => agent.home[0] + 1.5)),
    minZ: Math.min(-12, ...repositories.map(repo => repo.position[1] - 5), ...homes.map(agent => agent.home[1] - 1.5)),
    maxZ: Math.max(12, ...repositories.map(repo => repo.position[1] + 5), ...homes.map(agent => agent.home[1] + 1.5), Math.ceil(reportingAgents / 3) * 0.75 + 3),
  };
}
