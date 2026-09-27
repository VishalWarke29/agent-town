import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubDeviceProvider, IdentityError, IdentityRegistry, IdentityService, WindowsDpapiVault, type CredentialVault, type IdentityProvider, type IdentityPrincipal, type IdentityOptions, type DeviceTokenResult } from '../../apps/service/src/identity/index';
import { readLocalConfig } from '../../apps/service/src/config';

const alice: IdentityPrincipal = { id: '123', login: 'alice', displayName: 'Alice', avatarUrl: null };
const bob: IdentityPrincipal = { id: '456', login: 'bob', displayName: 'Bob', avatarUrl: null };
const secret = 'ghu_fixture_not_a_real_credential';
const device = { deviceCode: 'private-device-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };
const instances: IdentityService[] = [];
const directories: string[] = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'agent-town-identity-')); directories.push(value); return value; };
afterEach(() => {
  for (const instance of instances.splice(0)) instance.close();
  for (const value of directories.splice(0)) {
    const fullPath = resolve(value);
    if (!fullPath.startsWith(resolve(tmpdir()) + sep) || !fullPath.includes('agent-town-identity-')) throw new Error('Unsafe test cleanup path');
    rmSync(fullPath, { recursive: true, force: true });
  }
});

function setup(overrides: Partial<IdentityProvider> = {}, database = ':memory:', options: Pick<IdentityOptions, 'clientId' | 'readClientId'> = {}) {
  let now = 1_000_000;
  const secrets = new Map<string, string>();
  const vault: CredentialVault = {
    available: true,
    put: vi.fn(async (reference, value) => { secrets.set(reference, value); }),
    get: vi.fn(async reference => secrets.get(reference) ?? null),
    delete: vi.fn(async reference => { secrets.delete(reference); }),
  };
  const provider: IdentityProvider = {
    begin: vi.fn(async () => device),
    poll: vi.fn(async (): Promise<DeviceTokenResult> => ({ status: 'authorized', accessToken: secret, expiresIn: 28800 })),
    verifyUser: vi.fn(async () => alice),
    listRepositories: vi.fn(async () => ({ repositories: [], truncated: false, checkedAt: new Date(now).toISOString() })),
    ...overrides,
  };
  const registry = new IdentityRegistry(database);
  const service = new IdentityService({ registry, vault, provider, clientId: 'Iv1.publicFixtureId', now: () => now, ...options });
  instances.push(service);
  return { service, registry, vault, provider, secrets, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('private identity and ownership', () => {
  it('does not offer fake login when a client ID or protected vault is unavailable', async () => {
    const registry = new IdentityRegistry(':memory:');
    const service = new IdentityService({ registry, vault: { available: false, put: vi.fn(), get: vi.fn(), delete: vi.fn() } });
    instances.push(service);
    expect(service.status()).toMatchObject({ configured: false, storageAvailable: false });
    await expect(service.startDevice('browser')).rejects.toMatchObject({ code: 'identity_unavailable' });
    expect(registry.listWorkspaces('123')).toEqual([]);
  });

  it('detects a newly saved public Client ID without initiating sign-in or provider requests', async () => {
    const projectDirectory = directory();
    const readClientId = vi.fn(() => readLocalConfig({ projectDirectory, env: {} }).githubClientId);
    const { service, provider, registry } = setup({}, ':memory:', { clientId: '', readClientId });
    expect(service.status().configured).toBe(false);
    writeFileSync(join(projectDirectory, 'agent-town.config.json'), JSON.stringify({ githubClientId: 'Iv1.savedFixtureId' }));
    expect(service.status()).toMatchObject({ configured: true, storageAvailable: true, reason: null });
    expect(provider.begin).not.toHaveBeenCalled();
    expect(provider.poll).not.toHaveBeenCalled();
    expect(provider.verifyUser).not.toHaveBeenCalled();
    expect(provider.listRepositories).not.toHaveBeenCalled();
    expect(registry.getOwner(alice.id)).toBeNull();
    await service.startDevice('explicit-sign-in');
    expect(provider.begin).toHaveBeenCalledWith('Iv1.savedFixtureId', expect.any(AbortSignal));
    expect(readClientId).toHaveBeenCalledTimes(2);
  });

  it('retries incomplete or invalid setup without exposing its contents or contacting GitHub', async () => {
    const projectDirectory = directory();
    const path = join(projectDirectory, 'agent-town.config.json');
    const { service, provider } = setup({}, ':memory:', {
      clientId: '', readClientId: () => readLocalConfig({ projectDirectory, env: {} }).githubClientId,
    });
    writeFileSync(path, `{ "githubClientId": "${secret}`);
    const transient = service.status();
    expect(transient.configured).toBe(false);
    expect(transient.reason).toContain('retry automatically');
    expect(JSON.stringify(transient)).not.toContain(secret);
    await expect(service.startDevice('browser')).rejects.toMatchObject({ code: 'identity_unavailable' });
    writeFileSync(path, JSON.stringify({ githubClientId: 'short' }));
    expect(service.status().configured).toBe(false);
    expect(provider.begin).not.toHaveBeenCalled();
    expect(provider.poll).not.toHaveBeenCalled();
    writeFileSync(path, JSON.stringify({ githubClientId: 'Iv1.fixedFixtureId' }));
    expect(service.status().configured).toBe(true);
    expect(provider.begin).not.toHaveBeenCalled();
  });

  it('pins an adopted Client ID across later edits, pending authorization, and future sign-ins', async () => {
    const readClientId = vi.fn(() => '  Iv1.firstFixtureId  ');
    const { service, provider, advance } = setup({}, ':memory:', { clientId: '', readClientId });
    expect(service.status().configured).toBe(true);
    const pending = await service.startDevice('first-browser');
    readClientId.mockReturnValue('Iv1.changedFixtureId');
    expect(service.status().configured).toBe(true);
    advance(5000);
    await service.pollDevice('first-browser', pending.flowId);
    expect(provider.poll).toHaveBeenCalledWith('Iv1.firstFixtureId', device.deviceCode, expect.any(AbortSignal));
    readClientId.mockImplementation(() => { throw new Error('later config became unreadable'); });
    await service.startDevice('second-browser');
    expect(provider.begin).toHaveBeenNthCalledWith(2, 'Iv1.firstFixtureId', expect.any(AbortSignal));
    expect(readClientId).toHaveBeenCalledTimes(1);
  });

  it('keeps an initially configured registration without consulting the setup reader', async () => {
    const readClientId = vi.fn(() => 'Iv1.otherFixtureId');
    const { service, provider } = setup({}, ':memory:', { readClientId });
    expect(service.status().configured).toBe(true);
    await service.startDevice('browser');
    expect(provider.begin).toHaveBeenCalledWith('Iv1.publicFixtureId', expect.any(AbortSignal));
    expect(readClientId).not.toHaveBeenCalled();
  });

  it('verifies identity before promotion, binds codes to browser sessions, and never returns a token', async () => {
    const { service, provider, registry, advance } = setup();
    const prompt = await service.startDevice('browser-a');
    expect(JSON.stringify(prompt)).not.toContain(device.deviceCode);
    await expect(service.pollDevice('browser-b', prompt.flowId)).rejects.toMatchObject({ statusCode: 404 });
    expect(registry.getOwner(alice.id)).toBeNull();
    advance(5000);
    const result = await service.pollDevice('browser-a', prompt.flowId);
    expect(result).toEqual({ status: 'authorized', nextPollAt: null, principal: alice });
    expect(provider.verifyUser).toHaveBeenCalledWith(secret, expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(registry.getOwner(alice.id)).toEqual(alice);
    await expect(service.pollDevice('browser-a', prompt.flowId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('honors the interval and slow_down and serializes concurrent polling', async () => {
    const poll = vi.fn<IdentityProvider['poll']>().mockResolvedValueOnce({ status: 'slow_down', interval: 12 }).mockResolvedValue({ status: 'pending' });
    const { service, advance } = setup({ poll });
    const prompt = await service.startDevice('browser');
    await service.pollDevice('browser', prompt.flowId);
    expect(poll).not.toHaveBeenCalled();
    advance(5000);
    await Promise.all([service.pollDevice('browser', prompt.flowId), service.pollDevice('browser', prompt.flowId)]);
    expect(poll).toHaveBeenCalledTimes(1);
    advance(11999);
    await service.pollDevice('browser', prompt.flowId);
    expect(poll).toHaveBeenCalledTimes(1);
    advance(1);
    await service.pollDevice('browser', prompt.flowId);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('expires or cancels without creating an owner or polling GitHub again', async () => {
    const { service, provider, registry, advance } = setup();
    const expired = await service.startDevice('expired-browser');
    advance(900_000);
    expect((await service.pollDevice('expired-browser', expired.flowId)).status).toBe('expired');
    const cancelled = await service.startDevice('cancelled-browser');
    service.cancelDevice('cancelled-browser', cancelled.flowId);
    advance(5000);
    expect((await service.pollDevice('cancelled-browser', cancelled.flowId)).status).toBe('cancelled');
    expect(provider.poll).not.toHaveBeenCalled();
    expect(registry.getOwner(alice.id)).toBeNull();
  });

  it('discards late authorization when cancelled during credential persistence', async () => {
    const { service, registry, vault, secrets, advance } = setup();
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vault.put = async (reference, value) => { secrets.set(reference, value); entered(); await blocked; };
    const prompt = await service.startDevice('browser');
    advance(5000);
    const completion = service.pollDevice('browser', prompt.flowId);
    await started;
    service.cancelDevice('browser', prompt.flowId);
    release();
    expect((await completion).status).toBe('cancelled');
    expect(registry.getOwner(alice.id)).toBeNull();
    expect(secrets.size).toBe(0);
  });

  it('does not establish identity if protected persistence fails', async () => {
    const { service, registry, vault, advance } = setup();
    vault.put = async () => { throw new Error(`sensitive native error ${secret}`); };
    const prompt = await service.startDevice('browser');
    advance(5000);
    await expect(service.pollDevice('browser', prompt.flowId)).rejects.toMatchObject({ message: 'Sign-in could not be completed. Start again.', restartSignIn: true });
    expect(registry.getOwner(alice.id)).toBeNull();
    expect((await service.pollDevice('browser', prompt.flowId)).status).toBe('cancelled');
  });

  it.each(['verification', 'storage'] as const)('marks a failed %s after token issuance as requiring a fresh sign-in', async stage => {
    const { service, registry, vault, provider, advance } = setup();
    const failure = stage === 'storage'
      ? new IdentityError('vault_unavailable', 'Fixture storage unavailable.', 503)
      : new IdentityError('github_unavailable', 'Fixture provider unavailable.', 502);
    if (stage === 'storage') vault.put = async () => { throw failure; };
    else provider.verifyUser = async () => { throw failure; };
    const prompt = await service.startDevice('terminal-browser'); advance(5000);
    await expect(service.pollDevice('terminal-browser', prompt.flowId)).rejects.toMatchObject({ code: failure.code, message: failure.message, statusCode: failure.statusCode, restartSignIn: true });
    expect(registry.getOwner(alice.id)).toBeNull();
    expect((await service.pollDevice('terminal-browser', prompt.flowId)).status).toBe('cancelled');
    expect(provider.poll).toHaveBeenCalledTimes(1);
  });

  it('retains a retryable provider failure before token issuance without requiring a fresh sign-in', async () => {
    const { service, provider, advance } = setup();
    vi.mocked(provider.poll).mockRejectedValueOnce(new IdentityError('github_unavailable', 'Fixture provider unavailable.', 502));
    const prompt = await service.startDevice('retryable-browser'); advance(5000);
    await expect(service.pollDevice('retryable-browser', prompt.flowId)).rejects.toMatchObject({ code: 'github_unavailable', restartSignIn: undefined });
    expect(provider.verifyUser).not.toHaveBeenCalled();
    advance(5000);
    expect((await service.pollDevice('retryable-browser', prompt.flowId)).status).toBe('authorized');
    expect(provider.poll).toHaveBeenCalledTimes(2);
  });

  it('persists workspaces by stable owner ID across restart and hides other accounts', () => {
    const path = join(directory(), 'app.sqlite');
    const registry = new IdentityRegistry(path);
    registry.registerOwner(alice, 'github-reference-alice', null);
    registry.registerOwner(bob, 'github-reference-bob', null);
    const own = registry.createWorkspace(alice.id, ' Personal ', 'personal');
    registry.createWorkspace(bob.id, 'Company', 'company');
    registry.registerOwner({ ...alice, login: 'alice-renamed' }, 'github-reference-alice-new', null);
    expect(registry.listWorkspaces(alice.id)).toEqual([own]);
    expect(() => registry.requireWorkspace(bob.id, own.id)).toThrow('Workspace not found.');
    expect(() => registry.createWorkspace('unknown', 'Invalid')).toThrow('Sign in');
    expect(() => registry.createWorkspace(alice.id, 'bad\nname')).toThrow('workspace name');
    registry.close();
    const reopened = new IdentityRegistry(path);
    expect(reopened.requireWorkspace(alice.id, own.id).name).toBe('Personal');
    expect(reopened.getOwner(alice.id)?.login).toBe('alice-renamed');
    reopened.close();
    expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  });

  it('revalidates GitHub identity and removes revoked or mismatched credentials without fallback', async () => {
    const { service, registry, provider, secrets, advance } = setup();
    const prompt = await service.startDevice('browser');
    advance(5000);
    await service.pollDevice('browser', prompt.flowId);
    provider.verifyUser = vi.fn(async () => bob);
    await expect(service.listRepositories(alice.id)).rejects.toMatchObject({ code: 'github_identity_mismatch' });
    expect(provider.listRepositories).not.toHaveBeenCalled();
    expect(registry.credential(alice.id)).toBeNull();
    expect(secrets.size).toBe(0);
    await expect(service.listRepositories(alice.id)).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each(['verifyUser', 'listRepositories'] as const)('preserves the durable credential when shutdown interrupts %s', async stage => {
    const database = join(directory(), 'shutdown.sqlite');
    const { service, registry, provider, secrets, vault, advance } = setup({}, database);
    const prompt = await service.startDevice('browser'); advance(5000); await service.pollDevice('browser', prompt.flowId);
    const credential = registry.credential(alice.id)!, saved = secrets.get(credential.reference);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const paused = vi.fn(async () => { await gate; return stage === 'verifyUser' ? alice : { repositories: [], truncated: false, checkedAt: new Date().toISOString() }; });
    if (stage === 'verifyUser') provider.verifyUser = paused as IdentityProvider['verifyUser'];
    else provider.listRepositories = paused as IdentityProvider['listRepositories'];
    const pending = service.listRepositories(alice.id), rejection = expect(pending).rejects.toMatchObject({ code: 'identity_unavailable', statusCode: 503 });
    await vi.waitFor(() => expect(paused).toHaveBeenCalledTimes(1));
    service.close(); instances.splice(instances.indexOf(service), 1); release(); await rejection;
    expect(secrets.get(credential.reference)).toBe(saved); expect(vault.delete).not.toHaveBeenCalled();
    const reopened = new IdentityRegistry(database);
    expect(reopened.credential(alice.id)).toEqual(credential);
    const restarted = new IdentityService({ registry: reopened, vault, provider: { ...provider, verifyUser: async () => alice, listRepositories: async () => ({ repositories: [], truncated: false, checkedAt: new Date().toISOString() }) }, clientId: 'Iv1.publicFixtureId', now: () => 1_005_000 });
    instances.push(restarted); await expect(restarted.listRepositories(alice.id)).resolves.toMatchObject({ repositories: [] });
  });

  it('binds access-only grants to their registration and refuses legacy unbound tokens before provider calls', async () => {
    const database = join(directory(), 'registration.sqlite');
    const { service, registry, provider, secrets, vault, advance } = setup({ poll: vi.fn(async () => ({ status: 'authorized' as const, accessToken: secret, expiresIn: null })) }, database);
    const prompt = await service.startDevice('browser'); advance(5000); await service.pollDevice('browser', prompt.flowId);
    const credential = registry.credential(alice.id)!;
    expect(JSON.parse(secrets.get(credential.reference)!)).toEqual({ version: 1, clientId: 'Iv1.publicFixtureId', accessToken: secret });
    await expect(service.listRepositories(alice.id)).resolves.toMatchObject({ repositories: [] });
    service.close(); instances.splice(instances.indexOf(service), 1);
    vi.mocked(provider.verifyUser).mockClear(); vi.mocked(provider.listRepositories).mockClear();
    const restarted = new IdentityService({ registry: new IdentityRegistry(database), vault, provider, clientId: 'Iv1.differentRegistration', now: () => 1_005_000 });
    instances.push(restarted);
    await expect(restarted.listRepositories(alice.id)).rejects.toMatchObject({ code: 'github_reauthentication_required' });
    secrets.set(credential.reference, secret);
    await expect(restarted.listRepositories(alice.id)).rejects.toMatchObject({ code: 'github_reauthentication_required' });
    expect(provider.verifyUser).not.toHaveBeenCalled(); expect(provider.listRepositories).not.toHaveBeenCalled();
    expect(restarted.registry.credential(alice.id)).toEqual(credential);
  });

  it('requires new sign-in after token expiry and prevents rapid device starts', async () => {
    const { service, advance, provider } = setup();
    const prompt = await service.startDevice('browser');
    await expect(service.startDevice('browser')).rejects.toMatchObject({ statusCode: 429 });
    advance(5000);
    await service.pollDevice('browser', prompt.flowId);
    advance(28800_001);
    await expect(service.listRepositories(alice.id)).rejects.toMatchObject({ code: 'github_reauthentication_required' });
    expect(provider.listRepositories).not.toHaveBeenCalled();
  });
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
describe('protected GitHub refresh rotation', () => {
  const rotatingPair: DeviceTokenResult = { status: 'authorized', accessToken: secret, expiresIn: 120, refreshToken: 'ghr_fixture_refresh_token', refreshExpiresIn: 3600 };
  const nextPair = { accessToken: 'ghu_fixture_rotated_token', expiresIn: 28800, refreshToken: 'ghr_fixture_next_refresh_token', refreshExpiresIn: 3600 };
  async function authorized(overrides: Partial<IdentityProvider> = {}) {
    const result = setup({ poll: vi.fn(async () => rotatingPair), refresh: vi.fn(async () => nextPair), ...overrides });
    const prompt = await result.service.startDevice('rotation-browser'); result.advance(5000);
    await result.service.pollDevice('rotation-browser', prompt.flowId);
    result.advance(121000);
    return result;
  }

  it('preserves an unexpired grant through a transient vault read failure and retries without refreshing it', async () => {
    const { service, registry, provider, secrets, vault, advance } = setup({
      poll: vi.fn(async () => ({ ...rotatingPair, expiresIn: 28800 })),
      refresh: vi.fn(async () => nextPair),
    });
    const prompt = await service.startDevice('storage-read-browser'); advance(5000);
    await service.pollDevice('storage-read-browser', prompt.flowId);
    const previous = registry.credential(alice.id)!;
    const saved = secrets.get(previous.reference);
    vi.mocked(provider.verifyUser).mockClear();
    vi.mocked(vault.put).mockClear();
    const read = vault.get;
    const storageError = new IdentityError('vault_unavailable', 'Fixture credential read is temporarily unavailable.', 503);
    vault.get = vi.fn(read).mockRejectedValueOnce(storageError);

    await expect(service.listRepositories(alice.id)).rejects.toBe(storageError);
    expect(registry.credential(alice.id)).toEqual(previous);
    expect([...secrets.entries()]).toEqual([[previous.reference, saved]]);
    expect(provider.verifyUser).not.toHaveBeenCalled();
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provider.listRepositories).not.toHaveBeenCalled();
    expect(vault.put).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();

    await expect(service.listRepositories(alice.id)).resolves.toMatchObject({ repositories: [], truncated: false });
    expect(registry.credential(alice.id)).toEqual(previous);
    expect([...secrets.entries()]).toEqual([[previous.reference, saved]]);
    expect(provider.verifyUser).toHaveBeenCalledExactlyOnceWith(secret, expect.any(AbortSignal));
    expect(provider.listRepositories).toHaveBeenCalledExactlyOnceWith(secret, expect.any(AbortSignal));
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(vault.put).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it('rotates a pair once for concurrent readers and removes old encrypted references', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.fn(async () => { await gate; return nextPair; });
    const { service, registry, provider, secrets } = await authorized({ refresh });
    const previous = registry.credential(alice.id)!.reference;
    expect(JSON.parse(secrets.get(previous)!).refreshState).toBe('ready');
    const first = service.listRepositories(alice.id), second = service.listRepositories(alice.id);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const claim = registry.credential(alice.id)!.reference;
    expect(claim).not.toBe(previous);
    expect(JSON.parse(secrets.get(claim)!).refreshState).toBe('inflight');
    release(); await Promise.all([first, second]);
    const current = registry.credential(alice.id)!.reference;
    expect(current).not.toBe(claim); expect(secrets.has(previous)).toBe(false); expect(secrets.has(claim)).toBe(false);
    expect(JSON.parse(secrets.get(current)!).refreshToken).toBe(nextPair.refreshToken);
    expect(provider.listRepositories).toHaveBeenCalledWith(nextPair.accessToken, expect.any(AbortSignal));
    expect(refresh).toHaveBeenCalledWith('Iv1.publicFixtureId', 'ghr_fixture_refresh_token', expect.any(AbortSignal));
  });

  it('preserves the original grant and storage error when preparing a refresh claim fails', async () => {
    const { service, registry, provider, secrets, vault } = await authorized();
    const previous = registry.credential(alice.id)!;
    const saved = secrets.get(previous.reference);
    const storageError = new IdentityError('vault_unavailable', 'Fixture protected storage is temporarily unavailable.', 503);
    const write = vault.put;
    vault.put = vi.fn(async () => { throw storageError; });

    await expect(service.listRepositories(alice.id)).rejects.toBe(storageError);
    expect(registry.credential(alice.id)).toEqual(previous);
    expect([...secrets.entries()]).toEqual([[previous.reference, saved]]);
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provider.listRepositories).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalledWith(previous.reference);

    vault.put = write;
    await service.listRepositories(alice.id);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(provider.refresh).toHaveBeenCalledWith('Iv1.publicFixtureId', 'ghr_fixture_refresh_token', expect.any(AbortSignal));
    expect(registry.credential(alice.id)?.reference).not.toBe(previous.reference);
    expect(provider.listRepositories).toHaveBeenCalledWith(nextPair.accessToken, expect.any(AbortSignal));
  });

  it('cleans a failed claim write and hides unexpected native diagnostics without discarding the grant', async () => {
    const { service, registry, provider, secrets, vault } = await authorized();
    const previous = registry.credential(alice.id)!;
    const saved = secrets.get(previous.reference);
    vault.put = vi.fn(async (reference, value) => {
      secrets.set(reference, value);
      throw new Error(`Unexpected native diagnostic containing ${secret}`);
    });

    await expect(service.listRepositories(alice.id)).rejects.toEqual(new IdentityError('vault_unavailable', 'Windows protected credential storage could not complete the operation.', 503));
    expect(registry.credential(alice.id)).toEqual(previous);
    expect([...secrets.entries()]).toEqual([[previous.reference, saved]]);
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provider.listRepositories).not.toHaveBeenCalled();
  });

  it('requires new sign-in without replay when saving replacement credentials fails after refresh', async () => {
    const { service, registry, provider, secrets, vault } = await authorized();
    const write = vault.put;
    vault.put = vi.fn(async (reference, value) => {
      if (!reference.startsWith('github-pending-')) throw new IdentityError('vault_unavailable', 'Fixture replacement storage failed.', 503);
      await write(reference, value);
    });

    await expect(service.listRepositories(alice.id)).rejects.toMatchObject({ code: 'github_reauthentication_required', statusCode: 401 });
    expect(registry.credential(alice.id)).toBeNull();
    expect(secrets.size).toBe(0);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(provider.listRepositories).not.toHaveBeenCalled();
    await expect(service.listRepositories(alice.id)).rejects.toMatchObject({ code: 'github_reauthentication_required' });
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rotation with an unknown outcome', async () => {
    const refresh = vi.fn(async () => { throw new Error('Uncertain network response with private data'); });
    const { service, registry } = await authorized({ refresh });
    await expect(service.listRepositories(alice.id)).rejects.toEqual(new IdentityError('github_reauthentication_required', 'GitHub authorization needs a new sign-in. Your workspace and saved work remain available.', 401));
    expect(registry.credential(alice.id)).toBeNull();
    await expect(service.listRepositories(alice.id)).rejects.toMatchObject({ statusCode: 401 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cannot resurrect a disconnected account after a rotation response arrives', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.fn(async () => { await gate; return nextPair; });
    const { service, registry, secrets } = await authorized({ refresh });
    const pending = service.listRepositories(alice.id);
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 401 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await service.disconnect(alice.id); release(); await rejected;
    expect(registry.credential(alice.id)).toBeNull(); expect(secrets.size).toBe(0);
  });

  it('preserves a newer sign-in when an old rotation finishes', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.fn(async () => { await gate; return nextPair; });
    const { service, registry, secrets } = await authorized({ refresh });
    const pending = service.listRepositories(alice.id);
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 401 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const reference = 'github-fixture-newer-sign-in'; secrets.set(reference, 'ghu_newer_valid_fixture');
    registry.registerOwner(alice, reference, null);
    release(); await rejected;
    expect(registry.credential(alice.id)?.reference).toBe(reference);
    expect(secrets.get(reference)).toBe('ghu_newer_valid_fixture');
  });

  it('refuses a saved interrupted claim and a different application registration', async () => {
    const { service, registry, secrets, provider } = await authorized();
    const reference = registry.credential(alice.id)!.reference;
    const envelope = JSON.parse(secrets.get(reference)!);
    secrets.set(reference, JSON.stringify({ ...envelope, refreshState: 'inflight' }));
    await expect(service.listRepositories(alice.id)).rejects.toMatchObject({ statusCode: 401 });
    secrets.set(reference, JSON.stringify({ ...envelope, clientId: 'Iv1.differentRegistration' }));
    await expect(service.listRepositories(alice.id)).rejects.toMatchObject({ statusCode: 401 });
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it('uses the device-flow refresh body without client secrets or token URLs', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ access_token: nextPair.accessToken, token_type: 'bearer', expires_in: nextPair.expiresIn, refresh_token: nextPair.refreshToken, refresh_token_expires_in: nextPair.refreshExpiresIn }));
    const provider = new GitHubDeviceProvider(request);
    expect(await provider.refresh('Iv1.publicFixtureId', 'ghr_fixture_refresh_token')).toEqual(nextPair);
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://github.com/login/oauth/access_token');
    const body = new URLSearchParams(String(options?.body));
    expect(body.get('refresh_token')).toBe('ghr_fixture_refresh_token');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.has('client_secret')).toBe(false); expect(options?.redirect).toBe('error');
  });
});

describe('GitHub protocol boundaries', () => {
  it('posts device credentials in a body, pins GitHub origins, and ignores incomplete refresh material', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ device_code: device.deviceCode, user_code: device.userCode, verification_uri: device.verificationUri, expires_in: 900, interval: 5 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: secret, token_type: 'bearer', scope: '', refresh_token: 'discard-this', expires_in: 28800 }));
    const provider = new GitHubDeviceProvider(request);
    expect(await provider.begin('Iv1.public')).toEqual(device);
    expect(await provider.poll('Iv1.public', device.deviceCode)).toEqual({ status: 'authorized', accessToken: secret, expiresIn: 28800 });
    const [url, options] = request.mock.calls[1];
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(String(url)).not.toContain(device.deviceCode);
    expect(options?.redirect).toBe('error');
    expect(new URLSearchParams(String(options?.body)).get('device_code')).toBe(device.deviceCode);
  });

  it('rejects provider verification links and sanitizes upstream errors', async () => {
    const malicious = { device_code: device.deviceCode, user_code: device.userCode, verification_uri: 'https://evil.invalid/device', expires_in: 900, interval: 5 };
    const provider = new GitHubDeviceProvider(vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(malicious)).mockResolvedValueOnce(jsonResponse({ message: secret }, 401)));
    await expect(provider.begin('Iv1.public')).rejects.toThrow('GitHub device sign-in is unavailable');
    await expect(provider.verifyUser(secret)).rejects.toEqual(new IdentityError('github_unauthorized', 'GitHub authorization expired or was revoked. Sign in again.', 401));
  });

  it('lists only selected installation repositories and rejects write-capable installations', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ total_count: 1, installations: [{ id: 77, permissions: { contents: 'read', metadata: 'read' } }] }))
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, repositories: [{ id: 99, name: 'private-repo', full_name: 'alice/private-repo', private: true, default_branch: 'main', archived: false, html_url: 'https://github.com/alice/private-repo' }] }))
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, installations: [{ id: 77, permissions: { contents: 'write' } }] }));
    const provider = new GitHubDeviceProvider(request);
    const result = await provider.listRepositories(secret);
    expect(result.repositories[0]).toMatchObject({ id: '99', installationId: '77', private: true });
    expect(request.mock.calls[1][0]).toBe('https://api.github.com/user/installations/77/repositories?per_page=100&page=1');
    expect(result.truncated).toBe(false);
    await expect(provider.listRepositories(secret)).rejects.toMatchObject({ code: 'github_permissions_too_broad' });
  });
});

describe('Windows protected credential storage', () => {
  // Real DPAPI needs a genuinely interactive-capable Windows user profile; GitHub's hosted
  // windows-latest runner account does not reliably provide one (confirmed: fails there with
  // "Windows protected credential storage could not complete the operation" even though every
  // other win32-only test in this suite passes fine on that same runner) — skip there, not on a
  // real developer's own Windows machine, where this test still runs and still matters.
  it.skipIf(process.platform !== 'win32' || !!process.env.CI)('round-trips through real DPAPI without plaintext files and removes the credential', async () => {
    const path = directory();
    const vault = new WindowsDpapiVault(path);
    await vault.put('github-test-reference', secret);
    const files = readdirSync(path);
    expect(files).toEqual(['github-test-reference.dpapi']);
    expect(readFileSync(join(path, files[0]), 'utf8')).not.toContain(secret);
    expect(await vault.get('github-test-reference')).toBe(secret);
    await expect(vault.get('../outside-reference')).rejects.toMatchObject({ code: 'credential_reference_invalid' });
    await vault.delete('github-test-reference');
    expect(await vault.get('github-test-reference')).toBeNull();
  }, 30_000);
});
