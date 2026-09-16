export interface IdentityPrincipal {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface PrivateWorkspace {
  id: string;
  ownerId: string;
  name: string;
  kind: 'personal' | 'company';
  createdAt: string;
}

export interface GitHubRepository {
  id: string;
  installationId: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  archived: boolean;
}

export interface GitHubRepositoryListing {
  repositories: GitHubRepository[];
  truncated: boolean;
  checkedAt: string;
  diagnostics?: {
    installationCount: number;
    installationTotal: number;
    repositoryTotal: number | null;
    suspendedInstallations: number;
    reasons: Array<'no-installations' | 'no-repositories' | 'installation-limit' | 'page-limit' | 'deadline' | 'suspended-installation'>;
  };
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubTokenPair { accessToken: string; expiresIn: number | null; refreshToken?: string; refreshExpiresIn?: number }
export type DeviceTokenResult =
  | ({ status: 'authorized' } & GitHubTokenPair)
  | { status: 'pending' }
  | { status: 'slow_down'; interval?: number }
  | { status: 'denied' | 'expired' };

export interface IdentityProvider {
  begin(clientId: string, signal?: AbortSignal): Promise<DeviceCode>;
  poll(clientId: string, deviceCode: string, signal?: AbortSignal): Promise<DeviceTokenResult>;
  refresh?(clientId: string, refreshToken: string, signal?: AbortSignal): Promise<GitHubTokenPair>;
  verifyUser(accessToken: string, signal?: AbortSignal): Promise<IdentityPrincipal>;
  listRepositories(accessToken: string, signal?: AbortSignal): Promise<GitHubRepositoryListing>;
}

export interface CredentialVault {
  readonly available: boolean;
  put(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

export class IdentityError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400, public readonly restartSignIn?: true) {
    super(message);
    this.name = 'IdentityError';
  }
}
