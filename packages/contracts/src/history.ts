import { z } from 'zod';
import type { Agent, Handoff, Repository } from './index.js';
import type { ManagedRun, RunnerTask } from './runner.js';

export interface ArchivedAgent { agent: Agent; repository: Repository; archivedAt: string }
export interface ArchivedRepository { repository: Repository; disconnectedAt: string }
export interface RootRemovalReview { path: string; repositories: { id: string; name: string }[]; allowed: boolean; reasons: string[]; reviewToken: string }
export interface ArchivedAgentSummary {
  id: string; name: string; provider: Agent['provider']; repoId: string; repositoryName: string;
  activity: Agent['activity']; updatedAt: string; archivedAt: string;
}
export interface AgentHistoryPage { items: ArchivedAgentSummary[]; total: number; nextOffset: number | null }
export interface AgentReportPage { reports: Handoff[]; reportCount: number; reportsNextOffset: number | null }
export interface AgentHistoryDetail extends ArchivedAgent, AgentReportPage { runs: ManagedRun[]; tasks: RunnerTask[] }
export interface AgentArchiveReview { agentId: string; name: string; repositoryName: string; allowed: boolean; reasons: string[]; reportCount: number; reviewToken: string }
export const archiveAgentSchema = z.object({ reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const removeRootSchema = archiveAgentSchema.extend({ path: z.string().trim().min(1).max(1024) }).strict();
export const historyQuerySchema = z.object({ offset: z.coerce.number().int().min(0).max(10_000_000).default(0), limit: z.coerce.number().int().min(1).max(50).default(25) }).strict();
