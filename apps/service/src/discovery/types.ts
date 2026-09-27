export type DiscoveryIssue =
  | 'entry-limit' | 'depth-limit' | 'repository-limit' | 'instruction-limit'
  | 'time-limit' | 'cancelled' | 'unreadable-entry' | 'unsafe-path'
  | 'git-unavailable' | 'git-output-limit' | 'git-timeout' | 'unsafe-git-config'
  | 'unsupported-git-layout' | 'external-git-directory';

export interface DiscoveryLimits {
  maxRoots: number;
  maxDepth: number;
  maxEntries: number;
  maxRepositories: number;
  maxInstructionsPerRepository: number;
  maxDurationMs: number;
  gitTimeoutMs: number;
  maxGitOutputBytes: number;
  maxMetadataFileBytes: number;
}

export interface InstructionMetadata {
  path: string;
  scope: string;
  tool: 'shared' | 'claude' | 'codex' | 'cursor' | 'copilot';
  kind: 'instructions' | 'rules' | 'agent' | 'skill' | 'settings' | 'hooks';
  bytes: number;
  modifiedAt: string;
  appliedToRun: false;
  contentRead: false;
}

export interface RepositoryGitState {
  availability: 'available' | 'unavailable';
  branch: string | null;
  head: string | null;
  changedFiles: number | null;
  untrackedFiles: null;
  scope: 'tracked-files';
  refreshedAt: string;
  reason: DiscoveryIssue | null;
}

export interface DiscoveredRepository {
  id: string;
  name: string;
  canonicalPath: string;
  rootPath: string;
  kind: 'checkout' | 'worktree';
  commonGitDirectory: string | null;
  git: RepositoryGitState;
  instructions: InstructionMetadata[];
  scannedAt: string;
  fingerprint: string;
}

export interface DiscoveryResult {
  roots: string[];
  repositories: DiscoveredRepository[];
  coverage: {
    status: 'complete' | 'partial';
    issues: DiscoveryIssue[];
    entriesVisited: number;
    excludedEntries: number;
    unsafeEntries: number;
  };
  delta: { added: string[]; changed: string[]; removed: string[]; removalConfirmed: boolean };
  scannedAt: string;
}

export interface DiscoveryOptions {
  previous?: DiscoveredRepository[];
  limits?: Partial<DiscoveryLimits>;
  signal?: AbortSignal;
}

export const DEFAULT_DISCOVERY_LIMITS: Readonly<DiscoveryLimits> = Object.freeze({
  maxRoots: 8, maxDepth: 12, maxEntries: 30_000, maxRepositories: 100,
  maxInstructionsPerRepository: 200, maxDurationMs: 30_000,
  gitTimeoutMs: 3_000, maxGitOutputBytes: 512_000, maxMetadataFileBytes: 128_000,
});

export type ProtectedRootCode =
  | 'system-root' | 'program-files-root' | 'user-profile-root' | 'other-profile-root'
  | 'app-data-root' | 'agent-town-data-root' | 'excluded-name-root';

export class DiscoveryError extends Error {
  constructor(public readonly code: 'invalid-root' | 'unsafe-root' | 'unavailable-root' | 'invalid-limits' | ProtectedRootCode) {
    super({
      'invalid-root': 'Choose an absolute local project folder, not a drive or home folder.',
      'unsafe-root': 'The selected folder contains a symbolic link, junction, or unsupported path.',
      'unavailable-root': 'The selected folder is unavailable or is not a directory.',
      'invalid-limits': 'Discovery limits must be positive integers within the supported bounds.',
      'system-root': 'Windows system folders cannot be used as a project folder.',
      'program-files-root': 'Installed-application folders cannot be used as a project folder.',
      'user-profile-root': 'The Users folder itself cannot be used as a project folder. Choose a folder inside your own account.',
      'other-profile-root': 'Another account’s profile folder cannot be used as a project folder. Choose a folder inside your own account.',
      'app-data-root': 'Application-data folders (AppData) cannot be used as a project folder.',
      'agent-town-data-root': 'Agent Town’s own private data folder cannot be used as a project folder.',
      'excluded-name-root': 'This folder’s name is reserved for build, dependency or tool output and cannot be used as a project folder.',
    }[code]);
    this.name = 'DiscoveryError';
  }
}
