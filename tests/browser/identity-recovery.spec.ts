import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { createApp } from '../../apps/service/src/app';
import { IdentityError, IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';

for (const failure of ['storage', 'identity verification'] as const) {
test(`a consumed sign-in code closes on ${failure} failure, preserves the cause, and a fresh attempt succeeds`, async ({ page }, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-identity-recovery-'));
  let now = Date.now(); let starts = 0; let modelCalls = 0; let pollRequests = 0;
  let failCompletion = true;
  let sessionReplies = 0;
  const polledCodes: string[] = [];
  const remoteRequests: string[] = [];
  const pageErrors: string[] = [];
  const vaultData = new Map<string, string>();
  const completionMessage = failure === 'storage' ? 'Windows protected credential storage could not complete the operation.' : 'GitHub identity verification is temporarily unavailable.';
  const vault: CredentialVault = {
    available: true,
    put: async (key, value) => {
      if (failCompletion) throw new IdentityError('vault_unavailable', completionMessage, 503);
      vaultData.set(key, value);
    },
    get: async key => vaultData.get(key) ?? null,
    delete: async key => { vaultData.delete(key); },
  };
  const provider: IdentityProvider = {
    begin: async () => {
      starts++;
      return { deviceCode: `fixture-device-${starts}`, userCode: `TEST-000${starts}`, verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 };
    },
    poll: async (_client, deviceCode) => {
      polledCodes.push(deviceCode);
      // A pre-exchange outage is retryable; storage failure after the next
      // successful exchange is terminal. Exercise both through the real API.
      if (polledCodes.length === 1) throw new IdentityError('github_unavailable', 'GitHub is temporarily unavailable.', 502);
      return { status: 'authorized', accessToken: 'fixture-not-a-real-credential', expiresIn: 3600 };
    },
    verifyUser: async () => {
      if (failure === 'identity verification' && failCompletion) throw new IdentityError('github_unavailable', completionMessage, 502);
      return { id: '901', login: 'recovery-owner', displayName: 'Recovery Fixture', avatarUrl: null };
    },
    listRepositories: async () => { throw new Error('Sign-in must not list repositories'); },
  };
  const registry = new IdentityRegistry(join(directory, 'identity.sqlite'));
  const identity = new IdentityService({ registry, vault, provider, clientId: 'Iv1.identityRecoveryFixture', now: () => now });
  const forbiddenModelCall = async (): Promise<never> => { modelCalls++; throw new Error('Sign-in must not call a model provider'); };
  const instance = await createApp({ port: 4311, database: ':memory:', privateDirectory: directory, identity, vault, workflowProvider: { verify: forbiddenModelCall, countInput: forbiddenModelCall, summarize: forbiddenModelCall } });
  const baseHeaders = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
  let cookie = '';
  try {
    await page.clock.install();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseHeaders.origin) { remoteRequests.push(url.origin); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/v1/')) { await route.continue(); return; }
      if (url.pathname === '/api/v1/auth/github/device/poll') pollRequests++;
      const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST' | 'PATCH', url: `${url.pathname}${url.search}`, headers: { ...request.headers(), ...baseHeaders, ...(cookie ? { cookie } : {}) }, ...(request.postData() ? { payload: request.postData()! } : {}) });
      if (response.cookies.length) cookie = response.cookies.map(item => `${item.name}=${item.value}`).join('; ');
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      if (url.pathname === '/api/v1/session') sessionReplies++;
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open connections', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Private workspace setup', exact: true });
    const signIn = setup.getByRole('button', { name: 'Sign in with GitHub', exact: true });
    await expect(signIn).toBeEnabled();
    await signIn.click();
    await expect(setup.locator('.device-code')).toHaveText('TEST-0001');

    now += 6000; await page.clock.runFor(6000);
    await expect(setup.getByRole('status')).toHaveText('GitHub is temporarily unavailable.');
    await expect(setup.locator('.device-code')).toHaveText('TEST-0001');
    await expect(setup.getByRole('alert')).toHaveCount(0);
    expect(polledCodes).toEqual(['fixture-device-1']);

    now += 11000; await page.clock.runFor(11000);
    await expect(setup.getByRole('alert')).toHaveText(completionMessage);
    await expect(setup.getByRole('status')).toContainText('for a new code');
    await expect(setup.locator('.device-code')).toHaveCount(0);
    await expect(setup.getByRole('link', { name: 'Open GitHub', exact: true })).toHaveCount(0);
    await expect(setup.getByRole('button', { name: 'Cancel sign-in', exact: true })).toHaveCount(0);
    await expect(signIn).toBeEnabled();
    expect(registry.getOwner('901')).toBeNull();
    expect(vaultData.size).toBe(0);
    expect(pollRequests).toBe(2);
    const previousReplies = sessionReplies;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => sessionReplies).toBe(previousReplies + 1);
    await expect(setup.getByRole('alert')).toHaveText(completionMessage);
    if (failure === 'storage') {
      mkdirSync('docs/assets/previews', { recursive: true });
      await setup.getByRole('alert').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `docs/assets/previews/identity-storage-error-${testInfo.project.name}.png`, animations: 'disabled' });
    }

    // Pass the service's start throttle and several old poll intervals. A
    // consumed flow must not overwrite the actual cause with "cancelled".
    now += 31000; await page.clock.runFor(31000);
    expect(pollRequests).toBe(2);
    expect(polledCodes).toEqual(['fixture-device-1', 'fixture-device-1']);
    await expect(setup.getByRole('alert')).toHaveText(completionMessage);
    failCompletion = false;
    await signIn.click();
    await expect(setup.locator('.device-code')).toHaveText('TEST-0002');
    await expect(setup.getByRole('alert')).toHaveCount(0);
    now += 6000; await page.clock.runFor(6000);
    await expect(page.getByRole('status').filter({ hasText: 'GitHub connected. Choose or create your private workspace.' })).toBeVisible();
    await page.getByRole('button', { name: 'Open connections', exact: true }).click();
    await expect(setup.getByRole('button', { name: 'Sign out of GitHub', exact: true })).toBeVisible();
    await expect(setup.getByText('Recovery Fixture', { exact: true })).toBeVisible();
    await expect(setup.getByLabel('Workspace name', { exact: true })).toBeVisible();
    await expect(setup.locator('.device-code')).toHaveCount(0);
    expect(registry.getOwner('901')?.login).toBe('recovery-owner');
    expect(vaultData.size).toBe(1);
    expect(starts).toBe(2);
    expect(pollRequests).toBe(3);
    expect(polledCodes).toEqual(['fixture-device-1', 'fixture-device-1', 'fixture-device-2']);
    expect(remoteRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(modelCalls).toBe(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await instance.app.close();
    const full = resolve(directory);
    if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-identity-recovery-')) throw new Error('Unsafe fixture cleanup');
    rmSync(full, { recursive: true, force: true });
  }
});
}
