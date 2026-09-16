import { z } from 'zod';
import { workflowModelSchema, type WorkflowModel, type WorkflowUsage } from './workflow.js';

/** Current completion evidence binds the changed paths, Git modes and bytes. */
export function hasCurrentSourceFingerprint(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^v2:[a-f0-9]{64}$/.test(value);
}

export const runToolSchema = z.enum(['codex', 'openai-api', 'anthropic-api', 'claude']);
export type RunTool = z.infer<typeof runToolSchema>;
export const createRunDraftSchema = z.object({
  repoId: z.string().min(1).max(100), tool: runToolSchema,
  connectionId: z.string().min(1).max(100), mode: z.enum(['api', 'subscription']),
  objective: z.string().trim().min(5).max(4000), acceptanceCriteria: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
  dependencyTaskIds: z.array(z.string().min(1).max(100)).max(20).refine(ids => new Set(ids).size === ids.length, 'Choose each prerequisite task only once.').default([]),
  model: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:/-]+$/), price: workflowModelSchema.nullable(),
  maxTurns: z.number().int().min(1).max(20), maxOutputTokens: z.number().int().min(256).max(8192),
  maxMinutes: z.number().int().min(1).max(15), budgetMicroUsd: z.number().int().min(0).max(1_000_000_000_000),
  acknowledgeSubscriptionLimits: z.boolean().default(false),
  sourceProposalId: z.string().min(1).max(100).optional(),
  revisionOf: z.string().min(1).max(100).optional(),
}).strict();
export type CreateRunDraft = z.infer<typeof createRunDraftSchema>;
export interface RunnerTask {
  id: string; draft: CreateRunDraft; baseCommit: string; contextVersion: number; contextBrief: string;
  approvalHash: string; status: 'draft' | 'approved' | 'running' | 'awaiting_review' | 'accepted' | 'changes_requested' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string; approvedAt: string | null; runId: string | null;
  archivedAt?: string | null; sourceContextVersion?: number;
  integration?: { commit: string; verifiedAt: string; files: string[] };
}
export interface ManagedRun {
  id: string; taskId: string; tool: RunTool; connectionId: string; mode: 'api' | 'subscription'; model: string; price: WorkflowModel | null;
  status: 'starting' | 'running' | 'awaiting_review' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string; finishedAt: string | null; worktreePath: string | null; branch: string | null;
  contextVersion: number; contextDelivery: 'pending' | 'provider-acknowledged' | 'unsupported';
  providerRequests: number | null; usage: WorkflowUsage | null; message: string | null; changedFiles: string[]; changedFilesUnavailable?: boolean; reportId: string | null;
  sourceFingerprint?: string | null;
}
export interface SubscriptionConnection {
  id: string; label: string; status: 'pending' | 'verified' | 'failed' | 'disconnected';
  createdAt: string; accountLabel: string | null; accountFingerprint: string | null; models: string[];
}
/** Ephemeral, owner-scoped instructions. Never included in workspace snapshots. */
export interface SubscriptionLoginStatus {
  status: 'pending' | 'verified' | 'failed' | 'disconnected'; message: string | null;
  prompt?: { connectionId: string; verificationUrl: string; userCode: string; expiresAt: string };
}
export interface RunnerPreflight { tool: RunTool; ready: boolean; checkedAt: string; checks: { name: string; passed: boolean; message: string }[] }
export interface RunnerState { schemaVersion: 1; tasks: RunnerTask[]; runs: ManagedRun[]; subscriptions: SubscriptionConnection[]; subscriptionDefault: string | null }
export interface WorktreeEvidence { file: string; text: string; truncated: boolean; observedAt: string; fingerprint: string; source: 'current-worktree'; message: string }
export const approveRunSchema = z.object({ approvalHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const reviewRunSchema = z.object({ decision: z.enum(['accepted', 'changes_requested']) }).strict();
