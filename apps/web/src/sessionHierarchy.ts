import type { Agent } from '@agent-town/contracts';

export interface SessionHierarchy {
  primary: Agent[];
  children: Agent[];
  unresolved: Agent[];
  parentById: Map<string, Agent>;
  childrenById: Map<string, Agent[]>;
  descendantsById: Map<string, Agent[]>;
}

export function sessionParentId(agent: Agent): string | undefined {
  return agent.discovery?.parentNativeSessionId ?? agent.observation?.parentSessionId ?? undefined;
}

function nativeId(agent: Agent): string | undefined {
  return agent.discovery?.nativeSessionId ?? agent.observation?.sessionId;
}

function source(agent: Agent): { kind: 'native' | 'connection'; id: string } | undefined {
  const discovered = agent.discovery?.sourceId, observed = agent.observation?.nativeSourceId;
  if (discovered && observed && discovered !== observed) return undefined;
  const id = discovered ?? observed;
  return id ? { kind: 'native', id } : agent.observation?.connectionId
    ? { kind: 'connection', id: agent.observation.connectionId } : undefined;
}

/** Candidates must identify the same tool, project and approved native namespace. */
export function matchingSessionParents(agent: Agent, agents: readonly Agent[]): Agent[] {
  const parentId = sessionParentId(agent), namespace = source(agent);
  if (!parentId || parentId === nativeId(agent) || !namespace) return [];
  return agents.filter(candidate => {
    const candidateSource = source(candidate);
    return candidate.id !== agent.id && candidate.repoId === agent.repoId && candidate.provider === agent.provider
      && nativeId(candidate) === parentId && candidateSource?.kind === namespace.kind && candidateSource.id === namespace.id;
  });
}

/** A view of saved visible actors only; absent ancestors are never invented. */
export function sessionHierarchy(agents: readonly Agent[]): SessionHierarchy {
  const parentById = new Map<string, Agent>(), unresolvedIds = new Set<string>();
  const cyclic = new Set<string>();
  const idCounts = new Map<string, number>();
  for (const agent of agents) idCounts.set(agent.id, (idCounts.get(agent.id) ?? 0) + 1);
  for (const agent of agents) {
    if (idCounts.get(agent.id) !== 1) { unresolvedIds.add(agent.id); continue; }
    if (!sessionParentId(agent)) continue;
    if (sessionParentId(agent) === nativeId(agent)) { cyclic.add(agent.id); continue; }
    const matches = matchingSessionParents(agent, agents);
    if (matches.length !== 1 || idCounts.get(matches[0]!.id) !== 1) unresolvedIds.add(agent.id);
    else parentById.set(agent.id, matches[0]!);
  }

  // Iterative walks are bounded by the input size (normally at most 200 actors).
  // An actor leading into a cycle also lacks a usable ancestry path.
  for (const agent of agents) {
    const path = new Set<string>();
    let current: Agent | undefined = agent;
    while (current) {
      if (path.has(current.id) || cyclic.has(current.id)) {
        for (const id of path) cyclic.add(id);
        break;
      }
      path.add(current.id);
      current = parentById.get(current.id);
    }
  }
  for (const id of cyclic) { parentById.delete(id); unresolvedIds.add(id); }

  const childrenById = new Map<string, Agent[]>(), descendantsById = new Map<string, Agent[]>();
  for (const agent of agents) { childrenById.set(agent.id, []); descendantsById.set(agent.id, []); }
  for (const agent of agents) {
    const parent = parentById.get(agent.id);
    if (parent) childrenById.get(parent.id)!.push(agent);
    let ancestor = parent;
    while (ancestor) {
      descendantsById.get(ancestor.id)!.push(agent);
      ancestor = parentById.get(ancestor.id);
    }
  }
  return {
    primary: agents.filter(agent => !parentById.has(agent.id)),
    children: agents.filter(agent => parentById.has(agent.id)),
    unresolved: agents.filter(agent => unresolvedIds.has(agent.id)),
    parentById, childrenById, descendantsById,
  };
}
