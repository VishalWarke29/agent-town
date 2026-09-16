import { describe, expect, it } from 'vitest';
import { AGENT_HOME_RADIUS, AGENT_HOME_SPACING, allocateAgentHome, reconcileAgentHomes } from '../../packages/contracts/src/placement';

type Resident = { id: string; repoId: string; home: [number, number] };
const houses = [{ id: 'first', position: [-6, -3.3] as [number, number] }, { id: 'second', position: [5.7, -3.8] as [number, number] }, { id: 'third', position: [-5, 5.5] as [number, number] }];
const separation = (agents: Resident[]) => { for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) expect(Math.hypot(agents[i].home[0] - agents[j].home[0], agents[i].home[1] - agents[j].home[1])).toBeGreaterThanOrEqual(AGENT_HOME_SPACING - 0.0001); };

describe('repository residents', () => {
  it('places observed and managed residents on distinct nearby ground without moving an existing resident', () => {
    const agents: Resident[] = [{ id: 'managed-existing', repoId: 'first', home: [-5.3, -0.6] }];
    for (let i = 0; i < 28; i++) {
      const repoId = houses[i % houses.length].id;
      agents.push({ id: `session-${i}`, repoId, home: allocateAgentHome(repoId, houses, agents) });
    }
    separation(agents);
    for (const agent of agents) {
      expect(allocateAgentHome(agent.repoId, houses, agents, agent.id)).toEqual(agent.home);
      const repo = houses.find(repo => repo.id === agent.repoId)!;
      expect(Math.hypot(agent.home[0] - repo.position[0], agent.home[1] - repo.position[1])).toBeLessThanOrEqual(AGENT_HOME_RADIUS);
      for (const house of houses) expect(Math.abs(agent.home[0] - house.position[0]) >= 3.15 || Math.abs(agent.home[1] - house.position[1]) >= 2.65).toBe(true);
    }
  });

  it('translates residents when houses move and retains their identities, order, and relative positions', () => {
    const agents: Resident[] = houses.map(repo => ({ id: `resident-${repo.id}`, repoId: repo.id, home: allocateAgentHome(repo.id, houses, []) }));
    const originals = structuredClone(agents), moved = houses.map(repo => ({ ...repo, position: [repo.position[0] + 30, repo.position[1] + 20] as [number, number] }));
    const result = reconcileAgentHomes(moved, agents, houses);
    expect(agents).toEqual(originals);
    expect(result.map(agent => agent.id)).toEqual(agents.map(agent => agent.id));
    for (let i = 0; i < result.length; i++) expect(result[i].home).toEqual([Number((agents[i].home[0] + 30).toFixed(4)), Number((agents[i].home[1] + 20).toFixed(4))]);
    separation(result);
  });

  it('repairs old overlapping homes deterministically while preserving clear occupied homes', () => {
    const first = allocateAgentHome('first', houses, []), residents: Resident[] = [{ id: 'a', repoId: 'first', home: first }, { id: 'b', repoId: 'first', home: [...first] }];
    residents.push({ id: 'c', repoId: 'first', home: allocateAgentHome('first', houses, residents) });
    const repaired = reconcileAgentHomes(houses, residents);
    separation(repaired); expect(repaired[0].home).toEqual(first); expect(repaired[2].home).toEqual(residents[2].home);
    const reordered = reconcileAgentHomes(houses, [...residents].reverse());
    for (const agent of repaired) expect(reordered.find(item => item.id === agent.id)!.home).toEqual(agent.home);
    expect(reconcileAgentHomes(houses, repaired)).toEqual(repaired);
  });

  it('supports the retained 200-agent limit without reusing homes and refuses another allocation', () => {
    const agents: Resident[] = [];
    for (let i = 0; i < 200; i++) agents.push({ id: String(i), repoId: 'first', home: allocateAgentHome('first', houses, agents) });
    separation(agents);
    expect(() => allocateAgentHome('first', houses, agents)).toThrow('retained agent limit');
    expect(allocateAgentHome('first', houses, agents, agents[0].id)).toEqual(agents[0].home);
    expect(() => allocateAgentHome('missing', houses, [])).toThrow('selected repository');
  });
});
