import { createHash } from 'node:crypto';
import type { Agent, ArchivedAgent, ObservationConnection, ObservationEvent, TownState, Provider } from '@agent-town/contracts';
import { IdentityError } from '../identity/index.js';
import { redactEvidence, safeReportedFiles } from './normalize.js';
import { allocateAgentHome, RETAINED_AGENT_LIMIT } from '../../../../packages/contracts/src/placement.js';
import { queueManagerReports } from '../workflow/budget.js';

export const observationProviders: Record<ObservationConnection['provider'], Provider> = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor', 'copilot-vscode': 'Copilot', 'copilot-cli': 'Copilot', custom: 'Other' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const observationReceiptKey = (connection: ObservationConnection, event: ObservationEvent) => event.nativeSourceId
  ? `observe-native:${event.nativeSourceId}:${event.id}`
  : `observe:${connection.id}:${event.id}`;

export function applyObservation(state: TownState, connection: ObservationConnection, event: ObservationEvent, now: string, archived?: ArchivedAgent, canonical?: { agent: Agent; suppressPlacement: boolean }): string {
  if (state.workspace.mode !== 'private') throw new IdentityError('PRIVATE_WORKSPACE_REQUIRED', 'Observation events require a private workspace.', 400);
  const repo = state.repositories.find(repo => repo.id === connection.repoId);
  if (!repo || connection.status === 'revoked') throw new IdentityError('SOURCE_REVOKED', 'This observation connection is unavailable.', 403);
  if (Date.parse(event.occurredAt) > Date.parse(now) + 300000 || Date.parse(event.occurredAt) < Date.parse(now) - 30 * 86400000) throw new IdentityError('EVENT_TIME_INVALID', 'This event is outside the supported observation window.');
  state.observation ??= { connections: [] };
  let saved = state.observation.connections.find(item => item.id === connection.id);
  if (!saved) { saved = { ...connection }; state.observation.connections.push(saved); }
  saved.status = 'receiving'; saved.lastEventAt = now;
  if (event.nativeSourceId) saved.binding = 'resolved';
  const receiptKey = observationReceiptKey(connection, event);
  const identity = event.nativeSourceId ? receiptKey : `${connection.id}:${event.id}`;
  const reportId = `report-${hash(identity)}`, activityId = `activity-${hash(identity)}`;
  if (state.activity.some(item => item.id === activityId) || state.handoffs.some(item => item.id === reportId)) return 'observation.duplicate';
  // Match saved identity metadata first so older persisted characters keep their
  // identity. Parent scope separates a child from a same-named main session.
  const parent = event.parentSessionId ?? null;
  const id = `agent-${hash(parent === null ? `${connection.id}:${event.sessionId}` : JSON.stringify([connection.id, event.sessionId, parent]))}`;
  let agent = canonical?.agent ?? state.agents.find(agent => agent.repoId === repo.id && agent.observation?.connectionId === connection.id
    && agent.observation.sessionId === event.sessionId && agent.observation.parentSessionId === parent);
  if (!agent && archived?.agent.repoId === repo.id && archived.agent.observation?.connectionId === connection.id
    && archived.agent.observation.sessionId === event.sessionId && archived.agent.observation.parentSessionId === parent) agent = archived.agent;
  if (!agent) {
    if (state.agents.length >= RETAINED_AGENT_LIMIT) throw new IdentityError('AGENT_CAPACITY', 'The live town is full. Archive ended sessions to allow new agents; saved reports remain available.', 429);
    const provider = observationProviders[connection.provider];
    agent = {
      id, name: `${provider} ${state.agents.filter(a => a.provider === provider).length + 1}`, provider, role: parent === null ? 'Observed session' : 'Observed child session', repoId: repo.id,
      task: 'External session · task not linked', activity: 'idle', color: repo.color, home: allocateAgentHome(repo.id, state.repositories, state.agents),
      updatedAt: now, files: [], evidence: 'No verification evidence has been collected.', contextVersion: null,
      observation: { connectionId: connection.id, sessionId: event.sessionId, parentSessionId: event.parentSessionId ?? null, lastSequence: null, sourceTime: '1970-01-01T00:00:00.000Z', freshness: 'current', billing: 'unavailable' },
    } satisfies Agent;
    state.agents.push(agent);
  }
  const observation = agent.observation!;
  const summary = redactEvidence(event.summary ?? '').trim();
  const hasReport = ['report', 'turn.end', 'tool.failed', 'cancelled'].includes(event.kind) && !!summary;
  // Report identity is independent of the latest activity cursor. A late report
  // is still evidence even when a newer session-end event was received first.
  if (hasReport) {
    state.handoffs.push({ id: reportId, agentId: agent.id, repoId: repo.id, summary, createdAt: now, status: 'saved', contextVersion: null, delivery: 'unsupported',
      details: { outcome: event.kind === 'tool.failed' ? 'failed' : event.kind === 'cancelled' ? 'cancelled' : 'completed-response',
        taskId: null, runId: null, sourceEventId: event.id, occurredAt: event.occurredAt, contextVersionUsed: null,
        baseCommit: null, branch: null, worktreePath: null, files: { status: event.files === undefined ? 'unavailable' : 'reported', paths: safeReportedFiles(event.files) },
        checks: [{ name: 'External verification results', result: 'unavailable', evidence: 'unavailable', reference: null }],
        decisions: [], assumptions: [], remainingWork: [], evidenceRefs: [receiptKey],
        limitations: ['External tool claims are unverified. Linked task, used context, structured checks, decisions and assumptions are unavailable.'],
      } });
    queueManagerReports(state);
  }
  const tiedTerminal = ['offline', 'failed', 'cancelled'].includes(agent.activity)
    && Date.parse(event.occurredAt) === Date.parse(observation.sourceTime) && (event.sequence === undefined || observation.lastSequence === null || event.sequence <= observation.lastSequence);
  const old = (event.sequence !== undefined && observation.lastSequence !== null && event.sequence <= observation.lastSequence)
    || Date.parse(event.occurredAt) < Date.parse(observation.sourceTime) || tiedTerminal;
  if (old) {
    if (!hasReport) return 'observation.delayed';
    state.activity.unshift({ id: activityId, message: `${agent.name}: earlier report saved; current session activity is unchanged. Manager processing is separate.`, createdAt: now, kind: 'report' });
    state.activity = state.activity.slice(0, 500);
    return 'handoff.saved';
  }
  // An archive is history, not a second live character. Only new evidence of
  // active work resumes the same identity; terminal updates and late reports stay archived.
  if (archived && !canonical?.suppressPlacement && !state.agents.some(item => item.id === agent!.id)
    && ['session.start', 'turn.start', 'tool.start', 'tool.finish'].includes(event.kind)) {
    if (state.agents.length >= RETAINED_AGENT_LIMIT) throw new IdentityError('AGENT_CAPACITY', 'This archived session resumed, but the live town is full. Archive ended sessions first; pending source events are retained.', 429);
    agent.home = allocateAgentHome(repo.id, state.repositories, state.agents);
    state.agents.push(agent);
  }
  observation.lastSequence = event.sequence ?? observation.lastSequence; observation.sourceTime = event.occurredAt;
  observation.freshness = Date.parse(now) - Date.parse(event.occurredAt) > 120000 ? 'stale' : 'current';
  agent.updatedAt = now;
  agent.files = [...new Set([...agent.files, ...safeReportedFiles(event.files)])].slice(0, 100);
  if (event.kind === 'session.start' || event.kind === 'turn.start' || event.kind === 'tool.start' || event.kind === 'tool.finish') agent.activity = 'working';
  if (event.kind === 'turn.end') agent.activity = 'idle';
  if (event.kind === 'session.end') agent.activity = 'offline';
  if (event.kind === 'tool.failed') agent.activity = 'failed';
  if (event.kind === 'cancelled') agent.activity = 'cancelled';
  if (hasReport) {
    if (!['tool.failed', 'cancelled'].includes(event.kind)) agent.activity = 'reporting';
    agent.evidence = 'A report was supplied by the external tool. Tests and task acceptance remain unverified.';
  }
  state.activity.unshift({ id: activityId, message: `${agent.name}: ${agent.activity === 'reporting' ? 'report saved; manager processing is separate' : event.kind.replaceAll('.', ' ')}${event.tool ? ` (${redactEvidence(event.tool).slice(0, 80)})` : ''}.`, createdAt: now, kind: agent.activity === 'reporting' ? 'report' : 'work' });
  state.activity = state.activity.slice(0, 500);
  return hasReport ? 'handoff.saved' : `observation.${event.kind}`;
}
