import { randomUUID } from 'node:crypto';
import { DEMO_WORKSPACE, type TownState, type DemoCommand, type AgentActivity } from '@agent-town/contracts';

export function initialState(now = new Date().toISOString()): TownState {
  return {
    schemaVersion: 1,
    workspace: { id: DEMO_WORKSPACE, name: 'The little workshop', mode: 'demo' },
    simulation: { running: false, step: 0 },
    repositories: [
      { id: 'web', name: 'Web studio', description: 'The home of thoughtful interfaces.', language: 'TypeScript · React', branch: 'sample/ui-polish', color: '#ba7258', position: [-6, -3.7] },
      { id: 'api', name: 'Backend lab', description: 'Where the pieces come together.', language: 'Python · FastAPI', branch: 'sample/auth-flow', color: '#728c80', position: [5.7, -4.1] },
      { id: 'tools', name: 'Tools shed', description: 'Small tools. A little more possibility.', language: 'TypeScript · Node', branch: 'sample/cli-tests', color: '#a08cb0', position: [-6.4, 4] },
    ],
    agents: [
      { id: 'milo', name: 'Milo', provider: 'Claude', role: 'Frontend engineer', repoId: 'web', task: 'Polish the sign-in experience', activity: 'working', color: '#c37b57', home: [-5.4, -0.5], updatedAt: now, files: ['src/sign-in.tsx', 'src/fields.css'], evidence: 'Sample: form labels and keyboard navigation checked.', contextVersion: null },
      { id: 'nova', name: 'Nova', provider: 'Codex', role: 'Backend engineer', repoId: 'api', task: 'Check the session refresh flow', activity: 'testing', color: '#608d84', home: [5.1, -0.6], updatedAt: now, files: ['auth/session.py', 'tests/test_session.py'], evidence: 'Sample: 12 session tests passed.', contextVersion: null },
      { id: 'pip', name: 'Pip', provider: 'Cursor', role: 'UI engineer', repoId: 'web', task: 'Review the empty states', activity: 'waiting', color: '#b19552', home: [-2.9, -1.5], updatedAt: now, files: ['src/empty-state.tsx'], evidence: 'Sample: waiting for wording feedback.', contextVersion: null },
      { id: 'sage', name: 'Sage', provider: 'Copilot', role: 'Tools engineer', repoId: 'tools', task: 'Add coverage for CLI flags', activity: 'working', color: '#9081a9', home: [-4.7, 6.4], updatedAt: now, files: ['tests/cli.test.ts'], evidence: 'Sample: argument cases are being reviewed.', contextVersion: null },
      { id: 'fern', name: 'Fern', provider: 'Claude', role: 'Quality engineer', repoId: 'api', task: 'Review API error messages', activity: 'review', color: '#738a50', home: [6.2, 4.9], updatedAt: now, files: ['api/errors.py'], evidence: 'Sample: error copy is ready for human review.', contextVersion: null },
    ],
    handoffs: [],
    activity: [{ id: randomUUID(), message: 'Sample town ready. No accounts are connected.', createdAt: now, kind: 'system' }],
    manager: { version: 0, brief: 'The workshop is ready. Send a sample report from an agent to see how persistent handoffs work.', updatedAt: null },
  };
}

function log(state: TownState, message: string, kind: TownState['activity'][number]['kind'], now: string) {
  state.activity.unshift({ id: randomUUID(), message, kind, createdAt: now });
  state.activity = state.activity.slice(0, 80);
}

export class CommandError extends Error {}

export function applyDemoCommand(state: TownState, command: DemoCommand, now: string): string {
  if (command.action === 'play' || command.action === 'pause') {
    state.simulation.running = command.action === 'play';
    log(state, `Sample activity ${state.simulation.running ? 'started' : 'paused'}.`, 'system', now);
    return `demo.${command.action}`;
  }
  if (command.action === 'handoff') {
    const agent = state.agents.find(a => a.id === command.agentId);
    if (!agent) throw new CommandError('This sample agent does not exist.');
    if (state.handoffs.some(h => h.agentId === agent.id && h.status === 'saved')) throw new CommandError('This agent already has a pending report.');
    // This bounded demo is not a retention policy for real reports.
    if (state.handoffs.length >= 100) throw new CommandError('The preview has reached its 100-report limit.');
    agent.activity = 'reporting';
    agent.updatedAt = now;
    state.handoffs.unshift({ id: randomUUID(), agentId: agent.id, repoId: agent.repoId, summary: `${agent.task}. ${agent.evidence}`, createdAt: now, status: 'saved', contextVersion: null, delivery: 'unsupported' });
    log(state, `${agent.name} saved a sample report for the manager.`, 'report', now);
    return 'demo.handoff.saved';
  }
  const handoff = state.handoffs.find(h => h.id === command.handoffId);
  if (!handoff) throw new CommandError('This sample report does not exist.');
  if (handoff.status === 'processed') throw new CommandError('This report has already been processed.');
  handoff.status = 'processed';
  handoff.contextVersion = ++state.manager.version;
  state.manager.brief = state.handoffs.filter(h => h.status === 'processed').slice(0, 5).map(h => {
    const author = state.agents.find(a => a.id === h.agentId);
    return `${author?.name ?? 'Agent'}: ${h.summary}`;
  }).join('\n\n');
  state.manager.updatedAt = now;
  const agent = state.agents.find(a => a.id === handoff.agentId)!;
  agent.activity = 'review';
  agent.updatedAt = now;
  // Saving a brief does not deliver context to an agent or accept its task.
  log(state, `Sample brief v${state.manager.version} saved. Context delivery is not connected.`, 'context', now);
  return 'demo.handoff.processed';
}

export function advanceDemo(state: TownState, now: string): string {
  state.simulation.step++;
  if (state.simulation.step % 100 === 0) {
    state.simulation.running = false;
    log(state, 'The 10-minute sample activity session has finished. You can start another.', 'system', now);
    return 'demo.session.finished';
  }
  const agent = state.agents[state.simulation.step % state.agents.length]!;
  if (agent.activity === 'reporting') return 'demo.tick';
  const next: Record<AgentActivity, AgentActivity> = { working: 'testing', testing: 'review', waiting: 'working', review: 'working', reporting: 'reporting', idle: 'working', offline: 'working', failed: 'waiting', cancelled: 'waiting', unknown: 'unknown' };
  agent.activity = next[agent.activity];
  agent.updatedAt = now;
  log(state, `${agent.name}: sample activity changed to ${agent.activity}.`, 'work', now);
  return 'demo.agent.activity';
}
