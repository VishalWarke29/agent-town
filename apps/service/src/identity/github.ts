import { z } from 'zod';
import { IdentityError, type IdentityProvider, type DeviceCode, type DeviceTokenResult, type IdentityPrincipal, type GitHubRepository, type GitHubRepositoryListing } from './types.js';

const numericId = z.number().int().positive().safe().transform(String);
const tokenSchema = z.string().min(8).max(8192).regex(/^[A-Za-z0-9_.-]+$/);
const tokenPairSchema = z.object({ access_token: tokenSchema, token_type: z.literal('bearer'), scope: z.literal('').optional(), expires_in: z.number().int().positive().max(86400).optional(), refresh_token: tokenSchema.optional(), refresh_token_expires_in: z.number().int().positive().max(32_000_000).optional() });
const deviceSchema = z.object({
  device_code: z.string().min(8).max(512),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verification_uri: z.literal('https://github.com/login/device'),
  expires_in: z.number().int().min(1).max(1800),
  interval: z.number().int().min(1).max(60),
});
const userSchema = z.object({
  id: numericId,
  login: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().max(200).nullable(),
  avatar_url: z.string().url().optional(),
});
const installationSchema = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(z.object({ id: numericId, permissions: z.record(z.string(), z.string()), suspended_at: z.string().nullable().optional() })).max(100),
});
const repositorySchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(z.object({
    id: numericId, name: z.string().min(1).max(100), full_name: z.string().min(3).max(250),
    private: z.boolean(), default_branch: z.string().max(250), archived: z.boolean(),
    html_url: z.string().url(),
  })).max(100),
});

/** Fixed GitHub endpoints only. Tokens and raw responses never enter errors. */
export class GitHubDeviceProvider implements IdentityProvider {
  constructor(private readonly request: typeof fetch = fetch, private readonly now = Date.now) {}

  private async json(path: string, body: URLSearchParams | null, token?: string, signal?: AbortSignal): Promise<unknown> {
    const oauth = path.startsWith('/login/');
    const url = `${oauth ? 'https://github.com' : 'https://api.github.com'}${path}`;
    try {
      const response = await this.request(url, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: {
          Accept: oauth ? 'application/json' : 'application/vnd.github+json',
          'User-Agent': 'Agent-Town-Local',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(!oauth ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body?.toString(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new IdentityError('github_unauthorized', 'GitHub authorization expired or was revoked. Sign in again.', 401);
        if (response.status === 403 || response.status === 429) throw new IdentityError('github_access_limited', 'GitHub denied access or limited requests. Check app permissions and retry later.', 503);
        throw new IdentityError('github_unavailable', 'GitHub could not complete this request. Try again later.', 502);
      }
      // Stream with a bound instead of buffering an arbitrarily large provider response.
      const reader = response.body?.getReader();
      if (!reader) throw new IdentityError('github_response_invalid', 'GitHub returned an invalid response.', 502);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 2_000_000) { await reader.cancel(); throw new IdentityError('github_response_invalid', 'GitHub returned too much data.', 502); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      if (signal?.aborted) throw new IdentityError('device_cancelled', 'Sign-in was cancelled.', 409);
      throw new IdentityError('github_unavailable', 'GitHub could not complete this request. Check the connection and try again.', 502);
    }
  }

  async begin(clientId: string, signal?: AbortSignal): Promise<DeviceCode> {
    const response = await this.json('/login/device/code', new URLSearchParams({ client_id: clientId }), undefined, signal);
    const result = deviceSchema.safeParse(response);
    if (!result.success) throw new IdentityError('github_device_unavailable', 'GitHub device sign-in is unavailable. Check the GitHub App client ID and enable device flow.', 502);
    const value = result.data;
    return { deviceCode: value.device_code, userCode: value.user_code, verificationUri: value.verification_uri, expiresIn: value.expires_in, interval: value.interval };
  }

  async poll(clientId: string, deviceCode: string, signal?: AbortSignal): Promise<DeviceTokenResult> {
    const response = await this.json('/login/oauth/access_token', new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), undefined, signal);
    const pending = z.object({ error: z.string(), interval: z.number().int().positive().max(600).optional() }).safeParse(response);
    if (pending.success) {
      switch (pending.data.error) {
        case 'authorization_pending': return { status: 'pending' };
        case 'slow_down': return { status: 'slow_down', interval: pending.data.interval };
        case 'expired_token': case 'token_expired': return { status: 'expired' };
        case 'access_denied': return { status: 'denied' };
        default: throw new IdentityError('github_device_failed', 'GitHub could not authorize this device. Check the app settings and start sign-in again.', 502);
      }
    }
    const token = tokenPairSchema.safeParse(response);
    if (!token.success) throw new IdentityError('github_response_invalid', 'GitHub returned an invalid authorization response.', 502);
    return { status: 'authorized', accessToken: token.data.access_token, expiresIn: token.data.expires_in ?? null, ...(token.data.refresh_token && token.data.refresh_token_expires_in ? { refreshToken: token.data.refresh_token, refreshExpiresIn: token.data.refresh_token_expires_in } : {}) };
  }

  async refresh(clientId: string, refreshToken: string, signal?: AbortSignal) {
    // Device-flow tokens do not require a client secret. Never retry a rotation:
    // a lost response can mean GitHub already consumed the old token pair.
    const response = await this.json('/login/oauth/access_token', new URLSearchParams({ client_id: clientId, refresh_token: refreshToken, grant_type: 'refresh_token' }), undefined, signal);
    const token = tokenPairSchema.safeParse(response);
    if (!token.success || !token.data.refresh_token || !token.data.refresh_token_expires_in) throw new IdentityError('github_reauthentication_required', 'GitHub could not renew this authorization. Sign in again.', 401);
    return { accessToken: token.data.access_token, expiresIn: token.data.expires_in ?? null, refreshToken: token.data.refresh_token, refreshExpiresIn: token.data.refresh_token_expires_in };
  }

  async verifyUser(accessToken: string, signal?: AbortSignal): Promise<IdentityPrincipal> {
    const parsed = userSchema.safeParse(await this.json('/user', null, accessToken, signal));
    if (!parsed.success) throw new IdentityError('github_identity_invalid', 'GitHub did not return a verified user identity.', 502);
    const user = parsed.data;
    const avatar = user.avatar_url ? new URL(user.avatar_url) : null;
    return { id: user.id, login: user.login, displayName: user.name?.trim() || user.login,
      avatarUrl: avatar?.origin === 'https://avatars.githubusercontent.com' ? avatar.toString() : null };
  }

  async listRepositories(accessToken: string, signal?: AbortSignal): Promise<GitHubRepositoryListing> {
    // Only installation-selected repos. No /user/repos broad inventory and no remote writes.
    // One deadline covers installation discovery, pagination AND response bodies.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 12_000); timer.unref?.();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const cancelled = () => new IdentityError(signal?.aborted ? 'github_listing_cancelled' : 'github_listing_timeout', signal?.aborted ? 'GitHub repository listing was cancelled. Retry when ready.' : 'GitHub repository listing reached its time limit. Retry when the connection is available.', signal?.aborted ? 409 : 504);
    const read = async (path: string): Promise<unknown> => {
      if (combined.aborted) throw cancelled();
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([this.json(path, null, accessToken, combined), new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(cancelled()); combined.addEventListener('abort', onAbort, { once: true });
          if (combined.aborted) onAbort();
        })]);
      } finally { if (onAbort) combined.removeEventListener('abort', onAbort); }
    };
    try {
    const parsed = installationSchema.safeParse(await read('/user/installations?per_page=100&page=1'));
    if (!parsed.success) throw new IdentityError('github_response_invalid', 'GitHub returned invalid installation information.', 502);
    const repositories: GitHubRepository[] = [];
    const reasons: NonNullable<GitHubRepositoryListing['diagnostics']>['reasons'] = [];
    if (parsed.data.total_count > parsed.data.installations.length) reasons.push('installation-limit');
    if (parsed.data.total_count === 0) reasons.push('no-installations');
    const totals = new Map<string, number>();
    const suspendedInstallations = parsed.data.installations.filter(installation => installation.suspended_at).length;
    if (suspendedInstallations) reasons.push('suspended-installation');
    // Validate all returned installations before collecting any repository metadata.
    if (parsed.data.installations.some(installation => Object.values(installation.permissions).some(value => value !== 'read' && value !== 'none'))) {
      throw new IdentityError('github_permissions_too_broad', 'This GitHub App has write permissions. Configure read-only repository permissions before discovery.', 403);
    }
    // Bound round trips as well as response size. Larger inventories are explicitly partial.
    let remainingPages = 10;
    try {
    for (const installation of parsed.data.installations) {
      if (installation.suspended_at) continue;
      if (remainingPages === 0) { reasons.push('page-limit'); break; }
      let fetched = 0;
      for (let page = 1; remainingPages > 0; page++) {
        remainingPages--;
        const response = repositorySchema.safeParse(await read(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`));
        if (!response.success) throw new IdentityError('github_response_invalid', 'GitHub returned invalid repository information.', 502);
        totals.set(installation.id, response.data.total_count);
        for (const repo of response.data.repositories) {
          const url = new URL(repo.html_url);
          if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) throw new IdentityError('github_response_invalid', 'GitHub returned an invalid repository link.', 502);
          repositories.push({ id: repo.id, installationId: installation.id, name: repo.name, fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, htmlUrl: url.toString(), archived: repo.archived });
        }
        fetched += response.data.repositories.length;
        if (fetched >= response.data.total_count) break;
        if (!response.data.repositories.length || remainingPages === 0) { reasons.push('page-limit'); break; }
      }
    }
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (!deadline.signal.aborted) throw error;
      reasons.push('deadline');
    }
    const truncated = reasons.some(reason => reason !== 'no-installations');
    if (!truncated && parsed.data.total_count > 0 && repositories.length === 0) reasons.push('no-repositories');
    return { repositories: [...new Map(repositories.map(repo => [repo.id, repo])).values()], truncated, checkedAt: new Date(this.now()).toISOString(), diagnostics: {
      installationCount: parsed.data.installations.length, installationTotal: parsed.data.total_count,
      repositoryTotal: totals.size === parsed.data.total_count ? [...totals.values()].reduce((sum, count) => sum + count, 0) : null,
      suspendedInstallations, reasons: [...new Set(reasons)],
    } };
    } catch (error) { if (combined.aborted) throw cancelled(); throw error; }
    finally { clearTimeout(timer); }
  }
}
