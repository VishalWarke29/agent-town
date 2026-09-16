import type { Agent } from '@agent-town/contracts';

/** Native child names identify the agent; a shared conversation title is context. */
export function agentDisplayName(agent: Agent): string {
  const id = agent.discovery?.nativeSessionId;
  const generated = id && (agent.name === `${agent.provider} · ${id.slice(0, 8)}`
    || Boolean(agent.observation && agent.name.startsWith(`${agent.provider} `) && /^[1-9]\d*$/.test(agent.name.slice(agent.provider.length + 1))));
  if (generated && agent.discovery?.nativeAgentName) return agent.discovery.nativeAgentName;
  if (generated && agent.discovery?.title) return agent.discovery.title;
  return generated ? `${agent.provider} · ${id.length > 8 ? '…' : ''}${id.slice(-8)}` : agent.name;
}

export function agentSearchText(agent: Agent): string {
  return [agentDisplayName(agent), agent.name, agent.provider, agent.role, agent.task,
    agent.discovery?.title, agent.discovery?.nativeAgentName, agent.discovery?.nativeSessionId, agent.observation?.sessionId].filter(Boolean).join(' ').toLowerCase();
}
