export * from './model-profiles.js';
import { z } from 'zod';
import type { ObservationState } from './observation.js';
import type { WorkflowState } from './workflow.js';
import type { TelemetryState } from './telemetry.js';
export * from './observation.js';
export * from './workflow.js';
export * from './telemetry.js';
export * from './runner.js';
export * from './placement.js';
export * from './history.js';
export * from './folder-picker.js';
export * from './db-visualizer.js';
export * from './vault.js';

export const DEMO_WORKSPACE = 'demo-town';
export const demoCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('play') }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('handoff'), agentId: z.string().min(1).max(80) }).strict(),
  z.object({ action: z.literal('process'), handoffId: z.string().min(1).max(80) }).strict(),
]);
export type DemoCommand = z.infer<typeof demoCommandSchema>;
export type AgentActivity = 'working' | 'testing' | 'waiting' | 'reporting' | 'review' | 'idle' | 'offline' | 'failed' | 'cancelled' | 'unknown';
export type Provider = 'Claude' | 'Codex' | 'Cursor' | 'Copilot' | 'Other';
export interface Repository {
  id: string;
  name: string;
  description: string;
  language: string;
  branch: string;
  color: string;
  position: [number, number];
  source?: 'local' | 'github';
  /** Missing on legacy Git repository records. */
  projectKind?: 'folder' | 'git';
  localPath?: string;
  githubId?: number;
  githubUrl?: string;
  selectedRoot?: string;
  scan?: { at: string; coverage: 'complete' | 'partial'; reasons: string[] };
  discoveryStatus?: { state: 'current' | 'stale' | 'unavailable'; checkedAt: string; lastVerifiedAt: string | null; reasons: string[] };
  git?: { availability: 'available' | 'unavailable'; head: string | null; changedFiles: number | null; untrackedFiles: number | null; reason?: string };
  instructions?: InstructionFile[];
}
/** `kind` is optional so a repository record saved before WS5-02 still loads: the drawer falls back to
 * a filename-based guess when it is missing, and a later scan fills it in. */
export interface InstructionFile { path: string; tool: string; scope: string; size: number; modifiedAt: string; hash: string | null; appliedToRun: false; kind?: 'instructions' | 'rules' | 'agent' | 'skill' | 'settings' | 'hooks' }
export interface WorkspaceSummary { id: string; name: string; kind: 'personal' | 'company' }
export interface PublicUser { id: string; login: string; displayName: string | null; avatarUrl: string | null }
export type ApplicationMode = 'demo' | 'development' | 'production';
export interface BrowserSession { csrf: string; mode: 'demo' | 'private'; applicationMode?: ApplicationMode; user: PublicUser | null; workspaces: WorkspaceSummary[]; identity: { configured: boolean; reason?: string } }
export interface DiscoveryState {
  roots: string[];
  candidates: Repository[];
  operation: { id: string; status: 'running' | 'complete' | 'cancelled' | 'failed' | 'interrupted'; startedAt: string; finishedAt: string | null; message: string; coverage: 'complete' | 'partial' | null; reasons?: string[]; foundCount?: number; retainedCount?: number } | null;
  githubListing?: GitHubListingStatus;
  refresh?: { checkedAt: string; watchedPaths: number; skippedPaths: number; reconciliationSeconds: number; state: 'watching' | 'periodic-only' | 'inactive' };
}
export interface GitHubListingStatus {
  checkedAt: string;
  status: 'complete' | 'partial' | 'failed';
  installationCount: number | null;
  installationTotal: number | null;
  repositoryTotal: number | null;
  receivedCount: number;
  retainedCount: number;
  selectableCount: number;
  reasons: string[];
}
export const createWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['personal', 'company']) }).strict();
export const addRootSchema = z.object({ path: z.string().trim().min(1).max(1024) }).strict();
export const connectLocalProjectSchema = z.object({ path: z.string().trim().min(1).max(1024) }).strict();
export interface ConnectLocalProjectResult { repository: Repository; snapshot: Snapshot; duplicate: boolean }
export const selectRepositoriesSchema = z.object({ ids: z.array(z.string().min(1).max(100)).max(100) }).strict();
export const deviceFlowSchema = z.object({ flowId: z.string().min(1).max(100) }).strict();
export interface Agent {
  id: string;
  name: string;
  provider: Provider;
  role: string;
  repoId: string;
  task: string;
  activity: AgentActivity;
  color: string;
  home: [number, number];
  updatedAt: string;
  files: string[];
  evidence: string;
  contextVersion: number | null;
  discovery?: { sourceId: string; nativeSessionId: string; parentNativeSessionId?: string; title?: string; nativeAgentName?: string; discoveredAt: string; nativeUpdatedAt: string | null };
  observation?: { connectionId: string; sessionId: string; parentSessionId: string | null; lastSequence: number | null; sourceTime: string; freshness: 'current' | 'stale'; billing: 'unavailable'; nativeSourceId?: string };
}
export interface Handoff {
  id: string;
  agentId: string;
  repoId: string;
  summary: string;
  createdAt: string;
  status: 'saved' | 'processed';
  contextVersion: number | null;
  delivery: 'unsupported';
  details?: HandoffDetails;
}
export interface HandoffDetails {
  outcome: 'completed-response' | 'ready-for-review' | 'blocked' | 'failed' | 'cancelled' | 'interrupted';
  taskId: string | null; runId: string | null; sourceEventId: string; occurredAt: string;
  contextVersionUsed: number | null;
  baseCommit: string | null; branch: string | null; worktreePath: string | null;
  files: { status: 'observed' | 'reported' | 'unavailable'; paths: string[] };
  checks: { name: string; result: 'passed' | 'failed' | 'unavailable'; evidence: 'observed' | 'reported' | 'unavailable'; reference: string | null }[];
  decisions: string[]; assumptions: string[]; remainingWork: string[];
  evidenceRefs: string[]; limitations: string[];
}
export interface Activity {
  id: string;
  message: string;
  createdAt: string;
  kind: 'work' | 'report' | 'context' | 'system';
}
export type { BackupStatus } from './operations.js';
export interface TownState {
  history?: { archivedAgents: number; updatedAt: string | null };
  schemaVersion: 1;
  workspace: { id: string; name: string; mode: 'demo' | 'private' };
  discovery?: DiscoveryState;
  observation?: ObservationState;
  workflow?: WorkflowState;
  telemetry?: TelemetryState;
  runner?: import('./runner.js').RunnerState;
  vault?: import('./vault.js').VaultState;
  simulation: { running: boolean; step: number };
  repositories: Repository[];
  agents: Agent[];
  handoffs: Handoff[];
  activity: Activity[];
  manager: { version: number; brief: string; updatedAt: string | null };
}
export interface Snapshot { cursor: number; state: TownState }
export interface StateEvent extends Snapshot { type: string; occurredAt: string }
export const activityLabel: Record<AgentActivity, string> = {
  working: 'Working', testing: 'Testing', waiting: 'Needs input', reporting: 'Report saved', review: 'Awaiting review',
  idle: 'Response finished', offline: 'Session ended', failed: 'Reported failure', cancelled: 'Cancelled', unknown: 'Activity unknown',
};
