import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../../apps/service/src/app';
import { IdentityError, IdentityRegistry, IdentityService, type CredentialVault, type IdentityProvider } from '../../apps/service/src/identity';
import { SIGN_IN_CODE_WARNING } from '../../apps/web/src/firstRunCopy';

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
    // WS1-02 keeps the connections panel open across sign-in instead of closing it, so "Open
    // connections" is no longer needed here to reopen it — clicking it now would just toggle the
    // already-open panel closed.
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

// UX-03 (plan v5): a session that ends by itself (8-hour expiry, a service restart) is not a sign-out, but it must not leave the last
// person's private drawers open for whoever signs in next. Only the Connections drawer, the sign-in surface, stays open (WS1-02).
// Sign-in, workspace creation and the expiry all go through the real service; only GitHub and the model provider are simulated.
for (const open of ['Tasks', 'Connections'] as const) {
  test(`an expired session ${open === 'Tasks' ? 'closes an open Tasks drawer' : 'keeps the open Connections drawer for signing in again'} and leaves no private workspace data on screen`, async ({ page }) => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-identity-recovery-'));
    let now = Date.now(); let modelCalls = 0;
    const pageErrors: string[] = [];
    const vaultData = new Map<string, string>();
    const vault: CredentialVault = { available: true, put: async (key, value) => { vaultData.set(key, value); }, get: async key => vaultData.get(key) ?? null, delete: async key => { vaultData.delete(key); } };
    const provider: IdentityProvider = {
      begin: async () => ({ deviceCode: 'fixture-device', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
      poll: async () => ({ status: 'authorized', accessToken: 'fixture-not-a-real-credential', expiresIn: 3600 }),
      verifyUser: async () => ({ id: '903', login: 'expiry-owner', displayName: 'Expiry Fixture', avatarUrl: null }),
      listRepositories: async () => { throw new Error('Signing in must not list repositories'); },
    };
    const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'Iv1.expiryFixture', now: () => now });
    const forbiddenModelCall = async (): Promise<never> => { modelCalls++; throw new Error('An ended session must not call a model provider'); };
    const instance = await createApp({ port: 4311, database: ':memory:', privateDirectory: directory, identity, vault, workflowProvider: { verify: forbiddenModelCall, countInput: forbiddenModelCall, summarize: forbiddenModelCall } });
    const baseHeaders = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
    let cookie = '';
    try {
      const cookieOf = (response: { cookies: { name: string; value: string }[] }) => response.cookies.map(item => `${item.name}=${item.value}`).join('; ');
      const initial = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: baseHeaders });
      cookie = cookieOf(initial);
      const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
      expect(start.statusCode).toBe(200); now += 6000;
      const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', payload: { flowId: start.json().flowId }, headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
      expect(poll.statusCode).toBe(200);
      cookie = cookieOf(poll);
      const created = await instance.app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: 'Expiry private workspace', kind: 'personal' }, headers: { ...baseHeaders, cookie, 'x-csrf-token': poll.json().session.csrf } });
      expect(created.statusCode).toBe(200);
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.addInitScript(() => {
        class FixtureStream extends EventTarget { onopen: (() => void) | null = null; closed = false; constructor() { super(); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); } close() { this.closed = true; } }
        window.EventSource = FixtureStream as unknown as typeof EventSource;
      });
      await page.route('**/api/v1/**', async route => {
        const request = route.request(); const url = new URL(request.url());
        const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST', url: `${url.pathname}${url.search}`, headers: { ...request.headers(), ...baseHeaders, ...(cookie ? { cookie } : {}) }, ...(request.postData() ? { payload: request.postData()! } : {}) });
        await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
      });
      await page.goto('/');
      await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
      await expect(page.locator('.workspace-pill')).toContainText('Expiry private workspace');
      await page.getByRole('button', { name: `Open ${open.toLowerCase()}`, exact: true }).click();
      await expect(page.getByRole('heading', { name: open, level: 2 })).toBeVisible();
      if (open === 'Connections') await expect(page.getByText('Signed in as Expiry Fixture.', { exact: true })).toBeVisible();

      // The service no longer knows this browser session (expiry, restart). The next look at the workspace is refused, and the
      // app finds out the way it does in life: the workspace read fails and the session is read again.
      cookie = '';
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      if (open === 'Tasks') {
        await expect(page.getByRole('region', { name: 'Welcome to Agent Town', exact: true })).toBeVisible();
        await expect(page.getByTestId('left-drawer')).toHaveCount(0);
      } else {
        await expect(page.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeVisible();
        await expect(page.getByTestId('left-drawer')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Connections', level: 2 })).toBeVisible();
        await expect(page.getByText(/^Signed in as/)).toHaveCount(0);
      }
      await expect(page.getByTestId('right-drawer')).toHaveCount(0);
      for (const leftover of ['Expiry private workspace', 'Expiry Fixture', 'expiry-owner']) await expect(page.locator('body')).not.toContainText(leftover);
      expect(modelCalls).toBe(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      await instance.app.close();
      const full = resolve(directory);
      if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-identity-recovery-')) throw new Error('Unsafe fixture cleanup');
      rmSync(full, { recursive: true, force: true });
    }
  });
}

// UX-01 (plan v5, SP-2): the real service's disconnect reply is only { ok: true } (apps/service/src/app.ts), not a
// session, and the browser session itself is untouched by disconnect. useIdentity.ts used to hand that reply straight
// to accept() as if it were a BrowserSession, which corrupted the session state and blanked the whole app on the very
// next render. Disconnecting must keep the town open and the person signed in, and say so in plain words.
test('disconnecting GitHub, with the real { ok: true } reply, keeps the town open and signed in and shows "GitHub credential removed"', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-identity-recovery-'));
  const pageErrors: string[] = [];
  const vaultData = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { vaultData.set(key, value); }, get: async key => vaultData.get(key) ?? null, delete: async key => { vaultData.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    poll: async () => ({ status: 'authorized', accessToken: 'fixture-not-a-real-credential', expiresIn: 3600 }),
    verifyUser: async () => ({ id: '905', login: 'disconnect-owner', displayName: 'Disconnect Fixture', avatarUrl: null }),
    listRepositories: async () => { throw new Error('Signing in must not list repositories'); },
  };
  let now = Date.now();
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'Iv1.disconnectFixture', now: () => now });
  const forbiddenModelCall = async (): Promise<never> => { throw new Error('Disconnecting GitHub must not call a model provider'); };
  const instance = await createApp({ port: 4311, database: ':memory:', privateDirectory: directory, identity, vault, workflowProvider: { verify: forbiddenModelCall, countInput: forbiddenModelCall, summarize: forbiddenModelCall } });
  const baseHeaders = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
  let cookie = '';
  try {
    const cookieOf = (response: { cookies: { name: string; value: string }[] }) => response.cookies.map(item => `${item.name}=${item.value}`).join('; ');
    // Sign in through the real service directly (as UX-03's test above does), so the test exercises the
    // disconnect reply itself rather than re-proving the device-flow UI the other tests already cover.
    const initial = await instance.app.inject({ method: 'POST', url: '/api/v1/session', headers: baseHeaders });
    cookie = cookieOf(initial);
    const start = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/start', headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
    expect(start.statusCode).toBe(200); now += 6000;
    const poll = await instance.app.inject({ method: 'POST', url: '/api/v1/auth/github/device/poll', payload: { flowId: start.json().flowId }, headers: { ...baseHeaders, cookie, 'x-csrf-token': initial.json().csrf } });
    expect(poll.statusCode).toBe(200);
    cookie = cookieOf(poll);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/v1/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST', url: `${url.pathname}${url.search}`, headers: { ...request.headers(), ...baseHeaders, cookie }, ...(request.postData() ? { payload: request.postData()! } : {}) });
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open connections', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Private workspace setup', exact: true });
    await expect(setup.getByText('Disconnect Fixture', { exact: true })).toBeVisible();
    await setup.getByRole('button', { name: 'Disconnect GitHub', exact: true }).click();
    await setup.getByRole('button', { name: 'Yes, permanently disconnect', exact: true }).click();

    await expect(setup.getByRole('status').filter({ hasText: 'GitHub credential removed' })).toBeVisible();
    // The town stayed open and signed in: still on the sign-in surface, not a blank page, ready to sign
    // out or sign back in — never treated the { ok: true } reply as a session.
    await expect(setup.getByRole('button', { name: 'Sign out of GitHub', exact: true })).toBeVisible();
    await expect(setup.getByText('Disconnect Fixture', { exact: true })).toBeVisible();
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(pageErrors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await instance.app.close();
    const full = resolve(directory);
    if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-identity-recovery-')) throw new Error('Unsafe fixture cleanup');
    rmSync(full, { recursive: true, force: true });
  }
});

// UX-33: anyone can start a GitHub device sign-in and read the code it shows to talk a person into typing it
// for them, so the code screen must warn, before the code, to enter it only if this browser started sign-in
// itself. The warning is one shared constant (SIGN_IN_CODE_WARNING); it must never claim the flow is safe.
test('the sign-in code screen warns, in reading order before the code, to enter it only if you started sign-in here just now', async ({ page }, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-identity-recovery-'));
  const pageErrors: string[] = [];
  const vaultData = new Map<string, string>();
  const vault: CredentialVault = { available: true, put: async (key, value) => { vaultData.set(key, value); }, get: async key => vaultData.get(key) ?? null, delete: async key => { vaultData.delete(key); } };
  const provider: IdentityProvider = {
    begin: async () => ({ deviceCode: 'fixture-device', userCode: 'WARN-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    // Pending, not authorized: the code screen must stay up for this test to inspect it.
    poll: async () => ({ status: 'pending' }),
    verifyUser: async () => { throw new Error('Sign-in must not complete in this test'); },
    listRepositories: async () => { throw new Error('Sign-in must not list repositories'); },
  };
  const identity = new IdentityService({ registry: new IdentityRegistry(join(directory, 'identity.sqlite')), vault, provider, clientId: 'Iv1.signInWarningFixture', now: () => Date.now() });
  const forbiddenModelCall = async (): Promise<never> => { throw new Error('Showing the sign-in code must not call a model provider'); };
  const instance = await createApp({ port: 4311, database: ':memory:', privateDirectory: directory, identity, vault, workflowProvider: { verify: forbiddenModelCall, countInput: forbiddenModelCall, summarize: forbiddenModelCall } });
  const baseHeaders = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
  let cookie = '';
  try {
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/v1/**', async route => {
      const request = route.request(); const url = new URL(request.url());
      const response = await instance.app.inject({ method: request.method() as 'GET' | 'POST', url: `${url.pathname}${url.search}`, headers: { ...request.headers(), ...baseHeaders, ...(cookie ? { cookie } : {}) }, ...(request.postData() ? { payload: request.postData()! } : {}) });
      if (response.cookies.length) cookie = response.cookies.map(item => `${item.name}=${item.value}`).join('; ');
      await route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open connections', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Private workspace setup', exact: true });
    await setup.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
    await expect(setup.locator('.device-code')).toHaveText('WARN-CODE');

    // Visual and reading order: the heading, then the warning, then the code — not merely present somewhere on the page.
    const order = await setup.locator('.device-flow').evaluate(node => Array.from(node.children).map(child => child.textContent?.trim() ?? ''));
    const summary = order.map(text => text.slice(0, 40)).join(' | ');
    const headingIndex = order.findIndex(text => text.startsWith('Enter this one-time code on GitHub'));
    const warningIndex = order.findIndex(text => text.startsWith('Only enter this code if you started sign-in here just now'));
    const codeIndex = order.findIndex(text => text === 'WARN-CODE');
    expect(headingIndex, summary).toBe(0);
    expect(warningIndex, summary).toBe(1);
    expect(codeIndex, summary).toBeGreaterThan(warningIndex);

    const warning = setup.getByText(SIGN_IN_CODE_WARNING, { exact: true });
    await expect(warning).toBeVisible();
    expect(SIGN_IN_CODE_WARNING.toLowerCase()).not.toContain('safe');
    mkdirSync('docs/assets/previews', { recursive: true });
    await warning.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `docs/assets/previews/sign-in-code-warning-${testInfo.project.name}.png`, animations: 'disabled' });

    // 390 px is covered by this same spec run under the mobile Playwright project. Simulate 200% zoom on a
    // common laptop by halving the desktop viewport (the technique the 2026-09-24 audit's zoom-matrix probe uses).
    await page.setViewportSize({ width: 720, height: 480 });
    await expect(warning).toBeVisible();
    await expect(setup.locator('.device-code')).toBeVisible();

    // Does not depend on colour: an axe pass over this region catches a colour-only distinction as well as contrast.
    const accessibility = await new AxeBuilder({ page }).include('.device-flow').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations.map(value => ({ id: value.id, targets: value.nodes.map(node => node.target) }))).toEqual([]);

    expect(pageErrors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await instance.app.close();
    const full = resolve(directory);
    if (!full.startsWith(resolve(tmpdir()) + sep) || !full.includes('agent-town-identity-recovery-')) throw new Error('Unsafe fixture cleanup');
    rmSync(full, { recursive: true, force: true });
  }
});
