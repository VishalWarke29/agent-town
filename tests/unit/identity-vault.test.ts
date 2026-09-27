import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/service/src/app';
import { createDefaultIdentity, IdentityRegistry, IdentityService, resolveVaultDirectory, WindowsDpapiVault, type IdentityProvider } from '../../apps/service/src/identity';

const realCredentialsDirectory = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'AgentTownCredentials') : undefined;
async function realVaultFileCount(): Promise<number> {
  if (!realCredentialsDirectory) return 0;
  try { return (await readdir(realCredentialsDirectory)).length; } catch { return 0; }
}

const savedEnv = { AGENT_TOWN_DATA_DIR: process.env.AGENT_TOWN_DATA_DIR, AGENT_TOWN_VAULT_DIR: process.env.AGENT_TOWN_VAULT_DIR };
beforeEach(() => { delete process.env.AGENT_TOWN_DATA_DIR; delete process.env.AGENT_TOWN_VAULT_DIR; });
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key as keyof typeof savedEnv]; else process.env[key as keyof typeof savedEnv] = value; }
});

it('resolveVaultDirectory: leaves the owner\'s real vault path unchanged when no scoping env var is set', () => {
  expect(resolveVaultDirectory('/some/private/dir')).toBeUndefined();
  expect(resolveVaultDirectory()).toBeUndefined();
});

it('resolveVaultDirectory: derives a scoped vault dir from the data directory when AGENT_TOWN_DATA_DIR is set', () => {
  process.env.AGENT_TOWN_DATA_DIR = 'C:/scratch/browser-tests/123';
  expect(resolveVaultDirectory('C:/scratch/browser-tests/123/development/private')).toBe(join('C:/scratch/browser-tests/123/development/private', 'credentials'));
});

it('resolveVaultDirectory: AGENT_TOWN_VAULT_DIR always wins, even over a scoped data directory', () => {
  process.env.AGENT_TOWN_DATA_DIR = 'C:/scratch/browser-tests/123';
  process.env.AGENT_TOWN_VAULT_DIR = 'C:/scratch/explicit-vault';
  expect(resolveVaultDirectory('C:/scratch/browser-tests/123/development/private')).toBe(resolve('C:/scratch/explicit-vault'));
});

it.skipIf(process.platform !== 'win32')('createDefaultIdentity: a scoped instance (AGENT_TOWN_DATA_DIR set) stores a real credential without writing to the owner\'s real vault folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-town-vault-isolation-'));
  const privateDirectory = join(directory, 'private');
  process.env.AGENT_TOWN_DATA_DIR = directory;
  const before = await realVaultFileCount();
  const identity = createDefaultIdentity(privateDirectory);
  try {
    const vault = (identity as unknown as { vault: WindowsDpapiVault }).vault;
    await vault.put('fake-secret-reference', 'fake-secret-value-never-a-real-token');
    expect(await vault.get('fake-secret-reference')).toBe('fake-secret-value-never-a-real-token');
    const scopedFiles = await readdir(join(privateDirectory, 'credentials'));
    expect(scopedFiles).toContain('fake-secret-reference.dpapi');
    const after = await realVaultFileCount();
    expect(after).toBe(before);
  } finally {
    identity.close();
    identityCleanupGuard(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

function identityCleanupGuard(directory: string): void {
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('agent-town-vault-isolation-')) throw new Error('Unsafe fixture cleanup');
}

it.skipIf(process.platform !== 'win32')('completes device sign-in through the real Windows vault and keeps the workspace through service restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-town-native-sign-in-'));
  const vaultDirectory = join(directory, 'vault');
  const privateDirectory = join(directory, 'private');
  const database = join(directory, 'identity.sqlite');
  const headers = { host: '127.0.0.1:4312', origin: 'http://127.0.0.1:4312' };
  let now = Date.now();
  const provider: IdentityProvider = {
    begin: vi.fn(async () => ({ deviceCode: 'fixture-device-code', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 })),
    poll: vi.fn(async () => ({ status: 'authorized' as const, accessToken: 'fixture-only-access-token', expiresIn: 3600 })),
    verifyUser: vi.fn(async () => ({ id: '803', login: 'native-vault-fixture', displayName: 'Native Vault Fixture', avatarUrl: null })),
    listRepositories: vi.fn(async () => ({ repositories: [], truncated: false, checkedAt: new Date(now).toISOString() })),
  };
  let instance: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    // Existing protected storage is essential: first-use-only tests missed the failure.
    await new WindowsDpapiVault(vaultDirectory).put('preexisting-fixture-reference', 'preexisting fixture value');
    const unchangedPath = join(vaultDirectory, 'preexisting-fixture-reference.dpapi');
    const before = await readFile(unchangedPath, 'utf8');
    let workspaceId = '';
    for (let restart = 0; restart < 2; restart++) {
      const vault = new WindowsDpapiVault(vaultDirectory);
      const registry = new IdentityRegistry(database);
      const identity = new IdentityService({ registry, vault, provider, clientId: 'Iv1.nativeVaultFixture', now: () => now });
      instance = await createApp({ port: 4312, database: ':memory:', privateDirectory, identity, vault });
      const session = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers });
      let cookie = session.cookies.map(item => `${item.name}=${item.value}`).join('; ');
      const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: { ...headers, cookie, 'x-csrf-token': session.json().csrf } });
      expect(start.statusCode).toBe(200);
      now += 6000;
      const completion = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', payload: { flowId: start.json().flowId }, headers: { ...headers, cookie, 'x-csrf-token': session.json().csrf } });
      expect(completion.statusCode).toBe(200);
      expect(completion.json()).toMatchObject({ status: 'authorized', session: { user: { id: '803' } } });
      expect(JSON.stringify(completion.json())).not.toContain('fixture-only-access-token');
      cookie = completion.cookies.map(item => `${item.name}=${item.value}`).join('; ');
      if (restart === 0) {
        const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'Preserved native vault workspace', kind: 'personal' }, headers: { ...headers, cookie, 'x-csrf-token': completion.json().session.csrf } });
        expect(created.statusCode).toBe(200);
        workspaceId = created.json().workspace.id;
      } else {
        expect(completion.json().session.workspaces).toContainEqual(expect.objectContaining({ id: workspaceId, name: 'Preserved native vault workspace' }));
      }
      expect(await identity.listRepositories('803')).toMatchObject({ repositories: [] });
      const credential = registry.credential('803');
      expect(credential).not.toBeNull();
      expect(JSON.parse((await new WindowsDpapiVault(vaultDirectory).get(credential!.reference))!)).toMatchObject({ accessToken: 'fixture-only-access-token' });
      expect(await readFile(unchangedPath, 'utf8')).toBe(before);
      expect((await readdir(vaultDirectory)).every(name => name.endsWith('.dpapi'))).toBe(true);
      await instance.app.close();
      instance = undefined;
    }
    expect(provider.poll).toHaveBeenCalledTimes(2);
    expect(provider.listRepositories).toHaveBeenCalledTimes(2);
  } finally {
    await instance?.app.close();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('agent-town-native-sign-in-')) throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 45_000);
