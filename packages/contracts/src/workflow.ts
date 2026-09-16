import { z } from 'zod';

const id = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const money = z.number().int().min(0).max(1_000_000_000_000);
const modelId = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:/-]+$/);
export const apiConnectionSchema = z.object({
  provider: z.enum(['openai', 'anthropic']), label: z.string().trim().min(1).max(80),
  apiKey: z.string().min(12).max(8192).regex(/^[A-Za-z0-9_.-]+$/),
  organizationId: id.optional(), projectId: id.optional(),
}).strict();
export type ApiConnectionInput = z.infer<typeof apiConnectionSchema>;
export interface WorkflowConnection {
  id: string; provider: 'openai' | 'anthropic'; mode: 'api' | 'subscription'; label: string;
  status: 'verified' | 'disconnected' | 'unavailable'; verifiedAt: string; createdAt: string;
  accountIdentity: 'unavailable'; organizationId?: string; projectId?: string;
  models: string[]; capabilities: { manager: boolean; managedExecution: boolean };
}
export const economyPolicySchema = z.object({
  paidEnabled: z.boolean(), dailyBudgetMicroUsd: money, managerDailyBudgetMicroUsd: money,
  maxRunBudgetMicroUsd: money, workerConcurrency: z.union([z.literal(1), z.literal(2)]),
  timeZone: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Use a supported IANA timezone.'),
}).strict().refine(value => value.managerDailyBudgetMicroUsd <= value.dailyBudgetMicroUsd, 'Manager allowance must fit the daily workspace budget.')
  .refine(value => !value.paidEnabled || (value.dailyBudgetMicroUsd > 0 && value.maxRunBudgetMicroUsd > 0), 'Paid work needs positive daily and run budgets.');
export type EconomyPolicy = z.infer<typeof economyPolicySchema>;

export const workflowModelSchema = z.object({
  model: modelId, contextWindowTokens: z.number().int().min(4096).max(2_000_000),
  inputPerMillionMicroUsd: money, outputPerMillionMicroUsd: money,
  cachedInputPerMillionMicroUsd: money, cacheWritePerMillionMicroUsd: money,
  priceSource: z.string().url().max(500).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }),
  priceCheckedAt: z.string().datetime(),
  qualityStatus: z.enum(['unevaluated', 'user-attested']), qualityNote: z.string().trim().max(500),
}).strict();
export type WorkflowModel = z.infer<typeof workflowModelSchema>;
export const managerConfigSchema = z.object({
  enabled: z.boolean(), connectionId: id.nullable(), model: workflowModelSchema.nullable(),
  maxOutputTokens: z.number().int().min(256).max(1200),
  maxInputTokens: z.number().int().min(1024).max(32000),
  requestBudgetMicroUsd: money,
}).strict();
export type ManagerConfig = z.infer<typeof managerConfigSchema>;

export interface WorkflowUsage {
  inputTokens: number; outputTokens: number; cachedInputTokens: number;
  cacheWriteTokens: number; reasoningTokens: number | null;
  source: 'provider-reported' | 'user-reconciled';
}
export interface BudgetReservation {
  id: string; runId: string; purpose: 'manager' | 'worker'; connectionId: string;
  provider: 'openai' | 'anthropic'; mode: 'api'; model: WorkflowModel;
  amountMicroUsd: number; runBudgetMicroUsd: number; actualMicroUsd: number | null; usage: WorkflowUsage | null;
  status: 'reserved' | 'settled' | 'uncertain'; day: string; createdAt: string; settledAt: string | null;
  settlementSource: 'provider-usage' | 'user-reconciled' | 'not-sent' | 'provider-rejected' | null;
  /** True once this reservation pushed run/daily/manager usage to 80% or more of its limit. Warning only; scheduling still succeeds. */
  nearLimit?: boolean;
}
export interface ManagerJob {
  id: string; reportIds: string[]; connectionId: string; model: string; reservationId: string;
  status: 'running' | 'processed' | 'failed' | 'uncertain'; automatic: boolean;
  startedAt: string; completedAt: string | null; message: string | null;
  providerRequestId?: string | null; observedModel?: string | null;
  contextEvidence?: ManagerContextEvidence;
  duplicateProposalsSkipped?: number;
}
export interface ManagerContextEvidence {
  policyVersion: 1; reportIds: string[]; summaryBodyCount: number; reusedSummaryCount: number;
  includedRepoBriefIds: string[]; omittedRepoBriefCount: number; includedTaskIds: string[];
  omittedTaskCount: number; inputBytes: number; inputTokens: number; payloadHash: string;
}
export type CoordinationIssueCode = 'duplicate-task' | 'dependency-waiting' | 'dependency-missing' | 'dependency-cycle'
  | 'repository-active' | 'repository-unavailable' | 'stale-context' | 'base-changed' | 'capacity' | 'file-overlap' | 'awaiting-review' | 'integration-required';
export interface CoordinationIssue {
  code: CoordinationIssueCode; severity: 'block' | 'review'; message: string; relatedTaskIds: string[]; evidence: string[];
}
export interface TaskCoordination {
  taskId: string; repoId: string; state: 'reviewable' | 'waiting' | 'active' | 'human-review' | 'closed';
  dependencyTaskIds: string[]; issues: CoordinationIssue[];
}
export interface CoordinationPlan {
  schemaVersion: 1; advisoryOnly: true; inferenceCalls: 0; contextVersion: number;
  capacity: { limit: number; active: number; available: number };
  tasks: TaskCoordination[]; suggestedTaskIds: string[];
}
export interface ContextVersion {
  version: number; previousVersion: number; reportIds: string[]; overview: string;
  repoBriefs: { repoId: string; brief: string }[]; blockers: string[]; createdAt: string;
  origin?: 'manager' | 'workspace-owner';
  decisions?: AcceptedDecision[]; blockerRecords?: MemoryBlocker[];
}
export interface AcceptedDecision {
  id: string; text: string; repoId: string | null; sourceReportIds: string[]; sourceContextVersion: number;
  acceptedAt: string; acceptedVersion: number;
  superseded?: { at: string; version: number; reason: string };
}
export interface MemoryBlocker {
  id: string; text: string; repoId: string | null; sourceReportIds: string[]; sourceContextVersion: number;
  origin: 'manager' | 'workspace-owner' | 'legacy-context'; createdAt: string;
  status: 'open' | 'resolved';
  history: { action: 'resolved' | 'reopened'; reason: string; at: string; version: number; actor: 'workspace-owner' }[];
}
export const memoryActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept-decision'), expectedVersion: z.number().int().nonnegative(), text: z.string().trim().min(1).max(1000), repoId: id.nullable(), sourceReportIds: z.array(id).max(20) }).strict(),
  z.object({ action: z.literal('open-blocker'), expectedVersion: z.number().int().nonnegative(), text: z.string().trim().min(1).max(500), repoId: id.nullable(), sourceReportIds: z.array(id).max(20) }).strict(),
  z.object({ action: z.enum(['resolve-blocker', 'reopen-blocker', 'supersede-decision']), expectedVersion: z.number().int().nonnegative(), recordId: id, reason: z.string().trim().min(1).max(500) }).strict(),
]);
export type MemoryAction = z.infer<typeof memoryActionSchema>;
export interface ManagerQueueStatus {
  state: 'idle' | 'waiting' | 'ready' | 'running'; code: string; message: string;
  reportIds: string[]; pendingCount: number; checkedAt: string; retryAt: string | null;
  inferenceCalls: 0; dispatchVerified: false;
  basisHash?: string;
}
export interface ManagerProposal {
  id: string; sourceJobId: string; repoId: string; title: string; acceptanceCriteria: string[];
  status: 'proposed'; createdAt: string;
  sourceContextVersion?: number;
}
export interface WorkflowState {
  schemaVersion: 1; connections: WorkflowConnection[]; defaults: Record<string, string>;
  policy: EconomyPolicy; reservations: BudgetReservation[];
  manager: { config: ManagerConfig; queueReportIds: string[]; jobs: ManagerJob[]; versions: ContextVersion[]; proposals: ManagerProposal[]; automaticStarts: string[]; waitingStatus?: ManagerQueueStatus };
}
export const managerResultSchema = z.object({
  overview: z.string().min(1).max(8000),
  repoBriefs: z.array(z.object({ repoId: id, brief: z.string().min(1).max(4000) }).strict()).min(1).max(20),
  processedReportIds: z.array(id).min(1).max(20),
  blockers: z.array(z.string().min(1).max(500)).max(40),
  proposals: z.array(z.object({ repoId: id, title: z.string().min(1).max(200), acceptanceCriteria: z.array(z.string().min(1).max(300)).min(1).max(10) }).strict()).max(10),
}).strict();
export type ManagerResult = z.infer<typeof managerResultSchema>;
export const reconcileUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(100_000_000), outputTokens: z.number().int().nonnegative().max(100_000_000),
  cachedInputTokens: z.number().int().nonnegative().max(100_000_000), cacheWriteTokens: z.number().int().nonnegative().max(100_000_000),
  reasoningTokens: z.number().int().nonnegative().max(100_000_000).nullable(),
  source: z.literal('user-reconciled'),
}).strict();
