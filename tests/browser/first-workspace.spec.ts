import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { createApp } from '../../apps/service/src/app';
import { IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';

test('a workspace created through the real service exposes account, Economy and manager setup immediately', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-first-workspace-'));
  let now = Date.now(); let providerCalls = 0;
  const vaultData = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { vaultData.set(key, value); }, get: async key => vaultData.get(key) ?? null, delete: async key => { vaultData.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: 'fixture-test-credential', expiresIn: 3600 }),
    verifyUser: async () => ({ id: '601', login: 'test-owner', displayName: 'Test Owner', avatarUrl: null }),
    listRepositories: async () => ({ repositories: [], truncated: false, checkedAt: new Date(now).toISOString() }),
  };
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'Iv1.firstWorkspaceFixture', now: () => now });
  const forbiddenProviderCall = async (): Promise<never> => { providerCalls++; throw new Error('Opening setup must not call a model provider'); };
  const instance = await createApp({ port: 4311, database: ':memory:', privateDirectory: directory, identity, vault, workflowProvider: { verify: forbiddenProviderCall, countInput: forbiddenProviderCall, summarize: forbiddenProviderCall } });
  const baseHeaders = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
  try {
    const initial = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: baseHeaders });
    let cookie = initial.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
    expect(start.statusCode).toBe(200); now += 6000;
    const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', payload: { flowId: start.json().flowId }, headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
    expect(poll.statusCode).toBe(200);
    cookie = poll.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'Fresh real-service workspace', kind: 'personal' }, headers: { ...baseHeaders, cookie, 'x-csrf-token': poll.json().session.csrf } });
    expect(created.statusCode).toBe(200);
    const id: string = created.json().workspace.id;
    const getSnapshot = () => instance.app.inject({ url: `/api/v1/workspaces/${id}/snapshot`, headers: { ...baseHeaders, cookie } });
    const snapshot = (await getSnapshot()).json();
    expect(snapshot.state.workflow.policy.paidEnabled).toBe(false);
    expect(snapshot.state.workflow.connections).toEqual([]);
    // Only identity is simulated. Workspace creation, persistence and API reads
    // use the application, without hand-populating a workflow in the fixture.
    await page.addInitScript(() => {
      class FixtureStream extends EventTarget { onopen: (() => void) | null = null; closed = false; constructor() { super(); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); } close() { this.closed = true; } }
      window.EventSource = FixtureStream as unknown as typeof EventSource;
    });
    await page.route('**/api/v1/**', async route => {
      const request = route.request();
      const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST', url: new URL(request.url()).pathname, headers: { ...request.headers(), ...baseHeaders, cookie }, ...(request.postData() ? { payload: request.postData()! } : {}) });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open connections', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Billing mode', exact: true })).toBeVisible();
    await expect(page.getByText('Billing mode preview', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Subscription connection label', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'API credits', exact: true }).click();
    await expect(page.getByLabel('API key', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Usage', exact: true }).click();
    await expect(page.getByLabel('Permit paid work within these saved limits', { exact: true })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Save Economy limits', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Open manager', exact: true }).click();
    await expect(page.getByText('Manager account, model, and limits', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Process saved reports · paid', exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open connections', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Billing mode', exact: true })).toBeVisible();
    expect((await getSnapshot()).json().state.workflow).toEqual(snapshot.state.workflow);
    expect(providerCalls).toBe(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await instance.app.close();
    const full = resolve(directory);
    if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-first-workspace-')) throw new Error('Unsafe fixture cleanup');
    rmSync(full, { recursive: true, force: true });
  }
});
