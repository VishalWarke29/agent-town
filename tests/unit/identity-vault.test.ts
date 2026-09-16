import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from '../../apps/service/src/app';
import { IdentityRegistry, IdentityService, WindowsDpapiVault, type IdentityProvider } from '../../apps/service/src/identity';

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
