import { createHash } from 'node:crypto';
import type { ContextVersion, MemoryBlocker, MemoryAction, TownState } from '@agent-town/contracts';
import { WorkflowError, workflowState } from './budget.js';
import { sanitizeModelText } from './provider.js';

const key = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
export function contextMemory(previous: ContextVersion | undefined): { decisions: NonNullable<ContextVersion['decisions']>; blockerRecords: MemoryBlocker[] } {
  const decisions = structuredClone(previous?.decisions ?? []);
  const blockerRecords = structuredClone(previous?.blockerRecords ?? []);
  // Older contexts have only prose blockers. Keep their source version without
  // inventing a particular report or a human decision that was never recorded.
  for (const text of previous?.blockers ?? []) if (!blockerRecords.some(value => value.text === text)) blockerRecords.push({
    id: `blocker-${key(text)}`, text, repoId: null, sourceReportIds: [], sourceContextVersion: previous!.version,
    origin: 'legacy-context', createdAt: previous!.createdAt, status: 'open', history: [],
  });
  return { decisions, blockerRecords };
}

export function mergeManagerBlockers(previous: ContextVersion | undefined, texts: string[], reportIds: string[], version: number, now: string, secrets: string[] = []) {
  const memory = contextMemory(previous);
  for (const record of memory.blockerRecords) record.text = sanitizeModelText(record.text, secrets);
  const incoming = [...new Set(texts.map(text => sanitizeModelText(text, secrets)))];
  if (memory.blockerRecords.some(record => record.status === 'open' && !incoming.includes(record.text))) throw new WorkflowError('manager_blockers_missing', 'The manager omitted an open blocker. The previous brief is preserved.');
  if (memory.blockerRecords.some(record => record.status === 'resolved' && incoming.includes(record.text))) throw new WorkflowError('manager_blocker_resolved', 'The manager attempted to reopen an owner-resolved blocker. Review the new evidence; only the owner can reopen it.');
  for (const text of incoming) if (!memory.blockerRecords.some(record => record.text === text)) memory.blockerRecords.push({
    id: `blocker-${key(text)}`, text, repoId: null, sourceReportIds: [...reportIds], sourceContextVersion: version,
    origin: 'manager', createdAt: now, status: 'open', history: [],
  });
  if (memory.blockerRecords.length > 200) throw new WorkflowError('memory_capacity', 'The blocker history is full. Review a retention policy before more context updates.');
  return memory;
}

/** A workspace-owner action creates a new immutable version, with no model call. */
export function applyMemoryAction(state: TownState, input: MemoryAction, sourceId: string, now: string): string {
  const manager = workflowState(state).manager;
  if (state.manager.version !== input.expectedVersion) throw new WorkflowError('context_changed', 'The context changed. Review the latest version before saving this decision.');
  if (manager.jobs.some(job => job.status === 'running')) throw new WorkflowError('manager_running', 'Wait for the current summary to finish before editing memory.');
  if (manager.versions.length >= 1000) throw new WorkflowError('manager_capacity', 'The context history is full. Review retention before adding another version.');
  const previous = manager.versions.at(-1), memory = contextMemory(previous), version = state.manager.version + 1;
  if (input.action === 'accept-decision' || input.action === 'open-blocker') {
    if (input.repoId && !state.repositories.some(repo => repo.id === input.repoId)) throw new WorkflowError('repository_unavailable', 'Choose a repository in this workspace.');
    if (new Set(input.sourceReportIds).size !== input.sourceReportIds.length || input.sourceReportIds.some(id => !state.handoffs.some(report => report.id === id && (!input.repoId || report.repoId === input.repoId)))) throw new WorkflowError('memory_evidence_invalid', 'Choose existing source reports from the selected scope.');
    const text = sanitizeModelText(input.text);
    const common = { text, repoId: input.repoId, sourceReportIds: [...input.sourceReportIds], sourceContextVersion: input.expectedVersion };
    if (input.action === 'accept-decision') {
      if (memory.decisions.length >= 200) throw new WorkflowError('memory_capacity', 'The decision history is full. Review retention before accepting more decisions.');
      if (memory.decisions.some(record => !record.superseded && record.repoId === input.repoId && record.text === text)) throw new WorkflowError('decision_duplicate', 'This decision is already accepted.');
      memory.decisions.push({ ...common, id: `decision-${key(sourceId)}`, acceptedAt: now, acceptedVersion: version });
    } else {
      if (memory.blockerRecords.filter(record => record.status === 'open').length >= 40) throw new WorkflowError('memory_capacity', 'At most 40 open blockers fit the manager output contract. Resolve reviewed blockers before opening more.');
      if (memory.blockerRecords.length >= 200) throw new WorkflowError('memory_capacity', 'The blocker history is full. Review retention before adding another blocker.');
      if (memory.blockerRecords.some(record => record.text === text)) throw new WorkflowError('blocker_duplicate', 'This blocker already has a record. Reopen that record if needed.');
      memory.blockerRecords.push({ ...common, id: `blocker-${key(text)}`, origin: 'workspace-owner', createdAt: now, status: 'open', history: [] });
    }
  } else if (input.action === 'supersede-decision') {
    const record = memory.decisions.find(value => value.id === input.recordId && !value.superseded);
    if (!record) throw new WorkflowError('decision_unavailable', 'This decision is unavailable or already superseded.');
    record.superseded = { at: now, version, reason: sanitizeModelText(input.reason) };
  } else {
    const record = memory.blockerRecords.find(value => value.id === input.recordId);
    if (!record || record.status !== (input.action === 'resolve-blocker' ? 'open' : 'resolved')) throw new WorkflowError('blocker_changed', 'The blocker changed. Review its current status.');
    if (input.action === 'reopen-blocker' && memory.blockerRecords.filter(value => value.status === 'open').length >= 40) throw new WorkflowError('memory_capacity', 'At most 40 open blockers fit the manager output contract.');
    if (record.history.length >= 100) throw new WorkflowError('memory_capacity', 'This blocker has reached its reviewed history limit.');
    record.status = input.action === 'resolve-blocker' ? 'resolved' : 'open';
    record.history.push({ action: input.action === 'resolve-blocker' ? 'resolved' : 'reopened', reason: sanitizeModelText(input.reason), at: now, version, actor: 'workspace-owner' });
  }
  manager.versions.push({ version, previousVersion: state.manager.version, reportIds: [], overview: state.manager.brief,
    repoBriefs: structuredClone(previous?.repoBriefs ?? []), blockers: memory.blockerRecords.filter(record => record.status === 'open').map(record => record.text),
    createdAt: now, origin: 'workspace-owner', ...memory });
  state.manager = { ...state.manager, version, updatedAt: now };
  state.activity.unshift({ id: `memory-${key(sourceId)}`, kind: 'context', createdAt: now, message: `The workspace owner saved ${input.action.replaceAll('-', ' ')} in context v${version}. Existing run context is unchanged.` });
  state.activity = state.activity.slice(0, 500);
  return 'context.owner-updated';
}
