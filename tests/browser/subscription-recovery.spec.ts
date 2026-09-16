import { expect, test } from '@playwright/test';
import type { BrowserSession, Snapshot } from '@agent-town/contracts';
import { initialWorkflow } from '../../apps/service/src/workflow/budget';

for (const failure of [401, 403, 404, 'expired'] as const) {
  test(`Codex subscription recovers from ${failure} without retaining a stale code or starting work`, async ({ page }) => {
    let now = Date.now(); let starts = 0; let polls = 0;
    let responseMode: 'temporary' | 'lost' | 'verified' = 'temporary';
    const mutations: string[] = []; const remoteRequests: string[] = []; const pageErrors: string[] = [];
    const workspaceId = 'subscription-recovery';
    const prefix = `/api/v1/workspaces/${workspaceId}`;
    const session: BrowserSession = { csrf: 'fixture-only-csrf', mode: 'private', applicationMode: 'development', user: { id: '901', login: 'fixture-owner', displayName: 'Fixture Owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Subscription recovery', kind: 'personal' }], identity: { configured: true } };
    const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Subscription recovery', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [], agents: [], handoffs: [], activity: [], manager: { version: 0, brief: 'No paid work enabled.', updatedAt: null }, workflow: initialWorkflow(), runner: { schemaVersion: 1, tasks: [], runs: [], subscriptions: [], subscriptionDefault: null } } };
    await page.clock.install({ time: new Date(now) });
    await page.addInitScript(() => {
      class FixtureStream extends EventTarget {
        onopen: (() => void) | null = null;
        closed = false;
        constructor() { super(); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
        close() { this.closed = true; }
      }
      window.EventSource = FixtureStream as unknown as typeof EventSource;
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:4311') { remoteRequests.push(url.origin); await route.abort(); return; }
      if (!url.pathname.startsWith('/api/v1/')) { await route.continue(); return; }
      if (url.pathname === '/api/v1/session') { await route.fulfill({ json: session }); return; }
      if (request.method() !== 'GET') mutations.push(url.pathname);
      if (url.pathname === `${prefix}/snapshot`) { await route.fulfill({ json: snapshot }); return; }
      if (url.pathname === `${prefix}/subscriptions` && request.method() === 'POST') {
        starts++;
        await route.fulfill({ json: { connectionId: `fixture-connection-${starts}`, loginId: `fixture-login-${starts}`, verificationUrl: 'https://auth.openai.com/codex/device', userCode: `RECO-000${starts}`, expiresAt: new Date(now + (failure === 'expired' && starts === 1 ? 20000 : 60000)).toISOString() } });
        return;
      }
      if (url.pathname.startsWith(`${prefix}/subscriptions/`) && request.method() === 'GET') {
        polls++;
        if (responseMode === 'temporary') { await route.fulfill({ status: 503, json: { code: 'SERVICE_TEMPORARY', message: 'Fixture service temporarily unavailable.' } }); return; }
        if (responseMode === 'lost') { await route.fulfill({ status: failure === 'expired' ? 404 : failure, json: { code: 'SESSION_OR_ATTEMPT_LOST', message: 'Fixture sign-in attempt is unavailable.' } }); return; }
        await route.fulfill({ json: { status: 'verified', message: 'Fixture subscription verified. No worker has started.' } });
        return;
      }
      await route.fulfill({ status: 404, json: { message: 'Unexpected fixture action' } });
    });

    await page.goto('/');
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    // Exercise the same Connections workflow through its accessible List entry.
    // A live 3D canvas schedules every virtual animation frame during runFor;
    // stopping its rendering keeps the full polling/expiry timeline deterministic.
    await page.getByRole('button', { name: 'Show list view', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Accessible town list', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open connections', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Codex subscription connection', exact: true });
    const label = setup.getByLabel('Subscription connection label', { exact: true });
    const prepare = setup.getByRole('button', { name: 'Prepare Codex subscription sign-in', exact: true });
    await label.fill('First fixture account'); await prepare.click();
    await expect(setup.locator('.device-code')).toHaveText('RECO-0001');

    now += 6000; await page.clock.runFor(6000);
    await expect(setup.getByRole('status')).toContainText('Retrying until this code expires');
    await expect(setup.locator('.device-code')).toHaveText('RECO-0001');
    await expect(setup.getByRole('alert')).toHaveCount(0);
    expect(polls).toBe(1);
    if (failure === 'expired') { now += 15000; await page.clock.runFor(15000); }
    else { responseMode = 'lost'; now += 6000; await page.clock.runFor(6000); }

    await expect(setup.getByRole('alert')).toContainText(failure === 'expired' ? 'code expired' : 'Fixture sign-in attempt is unavailable');
    await expect(setup.getByRole('alert')).toContainText('new Codex subscription sign-in');
    if (failure === 401 || failure === 403) await expect(setup.getByRole('alert')).toContainText('Refresh Agent Town');
    await expect(setup.locator('.device-code')).toHaveCount(0);
    await expect(setup.getByRole('link', { name: 'Open OpenAI sign-in', exact: true })).toHaveCount(0);
    await expect(setup.getByText('Complete the native Codex sign-in below. Connecting does not start a worker.', { exact: true })).toHaveCount(0);
    const endedPolls = polls;
    now += 20000; await page.clock.runFor(20000);
    expect(polls).toBe(endedPolls);

    responseMode = 'verified';
    await label.fill('Fresh fixture account'); await prepare.click();
    await expect(setup.locator('.device-code')).toHaveText('RECO-0002');
    await expect(setup.getByRole('alert')).toHaveCount(0);
    now += 6000; await page.clock.runFor(6000);
    await expect(setup.getByRole('status')).toHaveText('Fixture subscription verified. No worker has started.');
    await expect(setup.locator('.device-code')).toHaveCount(0);
    expect(polls).toBe(endedPolls + 1);
    expect(starts).toBe(2);
    expect(mutations).toEqual([`${prefix}/subscriptions`, `${prefix}/subscriptions`]);
    expect(remoteRequests).toEqual([]); expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain('RECO-000');
  });
}
