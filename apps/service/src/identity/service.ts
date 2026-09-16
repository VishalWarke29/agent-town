import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { GitHubDeviceProvider } from './github.js';
import { IdentityRegistry, defaultApplicationDirectory } from './registry.js';
import { WindowsDpapiVault } from './vault.js';
import { IdentityError, type CredentialVault, type IdentityPrincipal, type IdentityProvider, type GitHubRepositoryListing, type GitHubTokenPair } from './types.js';

export interface IdentityOptions {
  registry: IdentityRegistry;
  vault: CredentialVault;
  provider?: IdentityProvider;
  clientId?: string;
  /** Re-read public setup only until the first valid registration is adopted. */
  readClientId?: () => string;
  now?: () => number;
}

const clientIdPattern = /^[A-Za-z0-9_.-]{8,120}$/;
const protectedAccessSchema = z.object({ version: z.literal(1), clientId: z.string().regex(clientIdPattern), accessToken: z.string().min(8).max(8192).regex(/^[A-Za-z0-9_.-]+$/) }).strict();
const protectedTokenSchema = protectedAccessSchema.extend({ refreshToken: z.string().min(8).max(8192).regex(/^[A-Za-z0-9_.-]+$/), refreshExpiresAt: z.number().finite(), refreshState: z.enum(['ready', 'inflight']) }).strict();
const protectedCredentialSchema = z.union([protectedTokenSchema, protectedAccessSchema]);
const reauthentication = () => new IdentityError('github_reauthentication_required', 'GitHub authorization needs a new sign-in. Your workspace and saved work remain available.', 401);

export interface DevicePrompt { flowId: string; userCode: string; verificationUri: string; expiresAt: string; interval: number }
export interface DevicePoll { status: 'pending' | 'authorized' | 'denied' | 'expired' | 'cancelled'; nextPollAt: string | null; principal?: IdentityPrincipal }
interface Flow {
  id: string;
  sessionId: string;
  deviceCode: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
  busy: boolean;
  status: 'starting' | DevicePoll['status'];
  abort: AbortController;
}

export class IdentityService {
  readonly registry: IdentityRegistry;
  private readonly vault: CredentialVault;
  private readonly provider: IdentityProvider;
  private clientId: string;
  private readonly readClientId: (() => string) | undefined;
  private readonly now: () => number;
  private readonly flows = new Map<string, Flow>();
  private readonly starts = new Map<string, number>();
  private readonly renewals = new Map<string, Promise<{ token: string; reference: string }>>();
  private readonly renewalAbort = new AbortController();
  private closed = false;

  constructor(options: IdentityOptions) {
    this.registry = options.registry;
    this.vault = options.vault;
    this.provider = options.provider ?? new GitHubDeviceProvider();
    this.clientId = options.clientId?.trim() ?? '';
    this.readClientId = options.readClientId;
    this.now = options.now ?? Date.now;
  }

  status(): { configured: boolean; storageAvailable: boolean; reason: string | null } {
    let setupReadFailed = false;
    if (!this.closed && !clientIdPattern.test(this.clientId) && this.readClientId) {
      try {
        const candidate = this.readClientId();
        if (typeof candidate === 'string' && clientIdPattern.test(candidate.trim())) this.clientId = candidate.trim();
      } catch {
        // A save may briefly leave incomplete JSON. Retry the next status read,
        // without exposing config contents or replacing a configured registration.
        setupReadFailed = true;
      }
    }
    const configured = clientIdPattern.test(this.clientId);
    return { configured, storageAvailable: this.vault.available,
      reason: !configured ? setupReadFailed ? 'GitHub setup could not be read yet. Save valid public settings in agent-town.config.json; setup will retry automatically.'
        : 'Add the public Client ID of a GitHub App with device flow enabled to agent-town.config.json. Setup checks for it automatically.'
        : !this.vault.available ? 'Windows protected credential storage is required.' : null };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, flow] of this.flows) {
      if (flow.expiresAt + 60_000 < now) { flow.abort.abort(); this.flows.delete(key); }
    }
    for (const [key, value] of this.starts) if (value + 60_000 < now) this.starts.delete(key);
  }

  async startDevice(sessionId: string): Promise<DevicePrompt> {
    const status = this.status();
    if (this.closed || !status.configured || !status.storageAvailable) throw new IdentityError('identity_unavailable', status.reason ?? 'Identity service is unavailable.', 503);
    if (!sessionId || sessionId.length > 256) throw new IdentityError('session_required', 'A local browser session is required.', 401);
    this.prune();
    const recent = this.starts.get(sessionId);
    if (recent !== undefined && this.now() - recent < 30_000) throw new IdentityError('device_start_limited', 'Wait 30 seconds before requesting another device code.', 429);
    if (this.flows.size >= 32) throw new IdentityError('device_capacity', 'Too many sign-in attempts are active. Try again later.', 429);
    this.cancelSession(sessionId);
    this.starts.set(sessionId, this.now());
    const flow: Flow = { id: randomUUID(), sessionId, deviceCode: '', expiresAt: this.now() + 900_000, interval: 5, nextPollAt: this.now(), busy: false, status: 'starting', abort: new AbortController() };
    this.flows.set(flow.id, flow);
    try {
      const code = await this.provider.begin(this.clientId, flow.abort.signal);
      if (flow.abort.signal.aborted) throw new IdentityError('device_cancelled', 'Sign-in was cancelled.', 409);
      flow.deviceCode = code.deviceCode;
      flow.expiresAt = this.now() + code.expiresIn * 1000;
      flow.interval = code.interval;
      flow.nextPollAt = this.now() + code.interval * 1000;
      flow.status = 'pending';
      return { flowId: flow.id, userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: new Date(flow.expiresAt).toISOString(), interval: flow.interval };
    } catch (error) { this.flows.delete(flow.id); throw error; }
  }

  private getFlow(sessionId: string, flowId: string): Flow {
    const flow = this.flows.get(flowId);
    if (!flow || flow.sessionId !== sessionId) throw new IdentityError('device_not_found', 'Sign-in attempt not found. Start again.', 404);
    return flow;
  }

  private terminal(flow: Flow, status: 'cancelled' | 'denied' | 'expired'): DevicePoll {
    flow.status = status;
    flow.deviceCode = '';
    flow.abort.abort();
    return { status, nextPollAt: null };
  }

  async pollDevice(sessionId: string, flowId: string): Promise<DevicePoll> {
    const flow = this.getFlow(sessionId, flowId);
    if (flow.status === 'cancelled' || flow.status === 'denied' || flow.status === 'expired') return { status: flow.status, nextPollAt: null };
    if (flow.expiresAt <= this.now()) return this.terminal(flow, 'expired');
    if (flow.busy || flow.status === 'starting' || this.now() < flow.nextPollAt) return { status: 'pending', nextPollAt: new Date(flow.nextPollAt).toISOString() };
    flow.busy = true;
    flow.nextPollAt = this.now() + flow.interval * 1000;
    let savedReference: string | null = null;
    let tokenIssued = false;
    try {
      const result = await this.provider.poll(this.clientId, flow.deviceCode, flow.abort.signal);
      if (flow.abort.signal.aborted) return this.terminal(flow, 'cancelled');
      if (flow.expiresAt <= this.now()) return this.terminal(flow, 'expired');
      if (result.status === 'slow_down') {
        flow.interval = Math.max(flow.interval + 5, result.interval ?? 0);
        flow.nextPollAt = this.now() + flow.interval * 1000;
      } else if (result.status === 'denied' || result.status === 'expired') {
        return this.terminal(flow, result.status);
      } else if (result.status === 'authorized') {
        tokenIssued = true;
        const expiresAt = result.expiresIn === null ? null : this.now() + result.expiresIn * 1000;
        const principal = await this.provider.verifyUser(result.accessToken, flow.abort.signal);
        if (flow.abort.signal.aborted || flow.expiresAt <= this.now()) return this.terminal(flow, flow.abort.signal.aborted ? 'cancelled' : 'expired');
        const reference = `github-${principal.id}-${randomUUID()}`;
        await this.vault.put(reference, this.protectedValue(result));
        savedReference = reference;
        if (flow.abort.signal.aborted || flow.expiresAt <= this.now()) {
          await this.vault.delete(reference);
          savedReference = null;
          return this.terminal(flow, flow.abort.signal.aborted ? 'cancelled' : 'expired');
        }
        const previous = this.registry.credential(principal.id);
        this.registry.registerOwner(principal, reference, expiresAt);
        savedReference = null;
        this.flows.delete(flow.id);
        flow.deviceCode = '';
        // Removing an old encrypted token is best effort after the new reference is durable.
        // A stale encrypted file is never a fallback authentication source.
        if (previous) await this.vault.delete(previous.reference).catch(() => undefined);
        return { status: 'authorized', nextPollAt: null, principal };
      }
      return { status: 'pending', nextPollAt: new Date(flow.nextPollAt).toISOString() };
    } catch (error) {
      if (savedReference) await this.vault.delete(savedReference).catch(() => undefined);
      if (flow.abort.signal.aborted) return this.terminal(flow, 'cancelled');
      // The authorization code may already have been consumed. Never blindly repeat
      // token exchange after identity verification or credential persistence failed.
      if (tokenIssued) this.terminal(flow, 'cancelled');
      if (error instanceof IdentityError) {
        if (tokenIssued) throw new IdentityError(error.code, error.message, error.statusCode, true);
        throw error;
      }
      throw new IdentityError('identity_failed', 'Sign-in could not be completed. Start again.', 502, tokenIssued ? true : undefined);
    } finally { flow.busy = false; }
  }

  cancelDevice(sessionId: string, flowId: string): void { this.terminal(this.getFlow(sessionId, flowId), 'cancelled'); }
  cancelSession(sessionId: string): void {
    for (const flow of this.flows.values()) if (flow.sessionId === sessionId) { this.terminal(flow, 'cancelled'); this.flows.delete(flow.id); }
  }

  async listRepositories(ownerId: string): Promise<GitHubRepositoryListing> {
    const { token, reference } = await this.accessToken(ownerId);
    const requireCurrent = () => {
      if (this.closed) throw new IdentityError('identity_unavailable', 'The local service stopped. Reconnect to Agent Town and retry.', 503);
      if (this.registry.credential(ownerId)?.reference !== reference) throw new IdentityError('github_request_superseded', 'The GitHub connection changed while listing repositories. Retry with the current connection.', 409);
    };
    try {
      // Account switching and revocation must not be hidden by a cached repo list.
      requireCurrent();
      const principal = await this.provider.verifyUser(token, this.renewalAbort.signal);
      requireCurrent();
      if (principal.id !== ownerId) throw new IdentityError('github_identity_mismatch', 'The GitHub connection belongs to a different account. Sign in again.', 401);
      const result = await this.provider.listRepositories(token, this.renewalAbort.signal);
      requireCurrent();
      return result;
    } catch (error) {
      if (!this.closed && error instanceof IdentityError && error.statusCode === 401) {
        this.registry.clearCredential(ownerId, reference);
        await this.vault.delete(reference).catch(() => undefined);
      }
      throw error;
    }
  }

  private protectedValue(pair: GitHubTokenPair): string {
    if (!pair.refreshToken || !pair.refreshExpiresIn) return JSON.stringify(protectedAccessSchema.parse({ version: 1, clientId: this.clientId, accessToken: pair.accessToken }));
    return JSON.stringify(protectedTokenSchema.parse({ version: 1, clientId: this.clientId, accessToken: pair.accessToken, refreshToken: pair.refreshToken, refreshExpiresAt: this.now() + pair.refreshExpiresIn * 1000, refreshState: 'ready' }));
  }

  private accessToken(ownerId: string): Promise<{ token: string; reference: string }> {
    const existing = this.renewals.get(ownerId);
    if (existing) return existing;
    const pending = this.loadOrRenew(ownerId).finally(() => { if (this.renewals.get(ownerId) === pending) this.renewals.delete(ownerId); });
    this.renewals.set(ownerId, pending);
    return pending;
  }

  private async loadOrRenew(ownerId: string): Promise<{ token: string; reference: string }> {
    if (this.closed) throw reauthentication();
    const credential = this.registry.credential(ownerId);
    if (!credential) throw reauthentication();
    const raw = await this.vault.get(credential.reference);
    if (!raw || this.closed) throw reauthentication();
    // Legacy raw access tokens do not identify their application registration.
    // Require sign-in rather than guessing which Client ID owns that grant.
    let envelope: z.infer<typeof protectedCredentialSchema>;
    try { envelope = protectedCredentialSchema.parse(JSON.parse(raw)); } catch { throw reauthentication(); }
    if (envelope.clientId !== this.clientId || ('refreshState' in envelope && envelope.refreshState !== 'ready')) throw reauthentication();
    const due = credential.expiresAt !== null && credential.expiresAt <= this.now() + 60_000;
    if (!due) {
      if (this.registry.credential(ownerId)?.reference !== credential.reference) throw reauthentication();
      return { token: envelope.accessToken, reference: credential.reference };
    }
    if (!('refreshToken' in envelope) || envelope.refreshExpiresAt <= this.now() || !this.provider.refresh) throw reauthentication();

    // Commit a durable claim before consuming a one-time refresh token. A crash
    // leaves an inflight envelope, which requires sign-in instead of blind retry.
    const claim = `github-pending-${ownerId}-${randomUUID()}`;
    let candidate: string | null = null;
    let claimed = false;
    try {
      await this.vault.put(claim, JSON.stringify({ ...envelope, refreshState: 'inflight' }));
    } catch (error) {
      // No refresh request was sent and this attempt has not replaced the grant.
      // Clean up a possibly partial write without turning a storage outage into
      // an authentication failure or exposing an unexpected native diagnostic.
      await this.vault.delete(claim).catch(() => undefined);
      if (this.closed) throw reauthentication();
      if (error instanceof IdentityError) throw error;
      throw new IdentityError('vault_unavailable', 'Windows protected credential storage could not complete the operation.', 503);
    }
    try {
      if (this.closed || !this.registry.replaceCredential(ownerId, credential.reference, claim, credential.expiresAt)) throw reauthentication();
      claimed = true;
      const pair = await this.provider.refresh(this.clientId, envelope.refreshToken, this.renewalAbort.signal);
      if (this.closed) throw reauthentication();
      const principal = await this.provider.verifyUser(pair.accessToken, this.renewalAbort.signal);
      if (this.closed || principal.id !== ownerId) throw reauthentication();
      candidate = `github-${ownerId}-${randomUUID()}`;
      await this.vault.put(candidate, this.protectedValue(pair));
      if (this.closed || !this.registry.replaceCredential(ownerId, claim, candidate, pair.expiresIn === null ? null : this.now() + pair.expiresIn * 1000)) throw reauthentication();
      const reference = candidate; candidate = null;
      await this.vault.delete(credential.reference).catch(() => undefined);
      await this.vault.delete(claim).catch(() => undefined);
      return { token: pair.accessToken, reference };
    } catch {
      if (claimed && !this.closed) this.registry.clearCredential(ownerId, claim);
      if (candidate) await this.vault.delete(candidate).catch(() => undefined);
      // Keep an interrupted claim on shutdown so restart cannot consume it again.
      if (!this.closed) await this.vault.delete(claim).catch(() => undefined);
      if (claimed && !this.closed) await this.vault.delete(credential.reference).catch(() => undefined);
      throw reauthentication();
    }
  }

  async disconnect(ownerId: string): Promise<void> {
    const credential = this.registry.credential(ownerId);
    if (credential) {
      this.registry.clearCredential(ownerId, credential.reference);
      await this.vault.delete(credential.reference);
    }
  }

  close(): void {
    this.closed = true;
    this.renewalAbort.abort();
    for (const flow of this.flows.values()) flow.abort.abort();
    this.flows.clear();
    this.starts.clear();
    this.registry.close();
  }
}

export function createDefaultIdentity(directory?: string, clientId = process.env.AGENT_TOWN_GITHUB_CLIENT_ID, readClientId?: () => string): IdentityService {
  return new IdentityService({ registry: new IdentityRegistry(join(directory ?? defaultApplicationDirectory(), 'app.sqlite')), vault: new WindowsDpapiVault(), clientId, readClientId });
}
