import type { CreateRunDraft, RunnerPreflight, RunTool } from '../../../../packages/contracts/src/runner.js';
import type { WorkflowConnection, WorkflowUsage } from '../../../../packages/contracts/src/workflow.js';
import type { RpcTransport } from './rpc.js';

export interface ExecutionInput {
  runId: string; worktree: string; draft: CreateRunDraft; contextVersion: number; contextBrief: string;
  connection: WorkflowConnection | null; apiKey: string | null; accountFingerprint: string | null;
  signal: AbortSignal;
  onContextDelivered(): void;
  onRequestStart(inputTokens: number, outputTokens: number): string;
  onRequestComplete(reservationId: string, usage: WorkflowUsage | null): void;
  onRequestRejected(reservationId: string): void;
}
export interface ExecutionResult { outcome: 'review' | 'failed' | 'cancelled'; summary: string; usage: WorkflowUsage | null; providerRequests: number | null }
export interface RunExecutor {
  validateDraft?(draft: CreateRunDraft): void;
  preflight(tool: RunTool, worktree?: string): Promise<RunnerPreflight>;
  execute(input: ExecutionInput): Promise<ExecutionResult>;
  subscription(home: string): Promise<RpcTransport>;
}
