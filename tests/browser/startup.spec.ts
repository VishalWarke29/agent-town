import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';

test('missing GitHub setup refreshes automatically, recovers after restart, and stops checking when ready', async ({ page, baseURL }) => {
  let configured = false;
  let unavailable = false;
  let reads = 0;
  const unexpected: string[] = [];
  await page.clock.install();
  page.on('request', request => {
    if (request.url().includes('/auth/github/') || !request.url().startsWith(`${baseURL}/`)) unexpected.push(request.url());
  });
  await page.route('**/api/v1/session', async route => {
    reads++;
    if (unavailable) { await route.fulfill({ status: 503, json: { message: 'Fixture service restarting.' } }); return; }
    const response = await route.fetch(); const session = await response.json();
    await route.fulfill({ response, json: { ...session, user: null, workspaces: [], identity: { configured } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  const signIn = page.getByRole('button', { name: 'Sign in with GitHub', exact: true });
  await expect(page.getByText('GitHub sign-in is not set up on this computer yet', { exact: true })).toBeVisible();
  await expect(signIn).toBeDisabled();
  await expect(signIn).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('left-drawer')).toContainText('checks automatically every five seconds');
  const initialReads = reads;
  unavailable = true;
  await page.clock.runFor(5000);
  await expect(page.getByTestId('left-drawer').getByRole('alert')).toContainText('Setup will refresh automatically');
  expect(reads).toBeGreaterThan(initialReads);
  unavailable = false; configured = true;
  await page.clock.runFor(5000);
  await expect(signIn).toBeEnabled();
  await expect(page.getByText('GitHub sign-in is not set up on this computer yet', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const readyReads = reads;
  await page.clock.runFor(15000);
  expect(reads).toBe(readyReads);
  expect(unexpected).toEqual([]);
});

test('demo environment opens sample town directly and keeps real setup unavailable', async ({ page }) => {
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch(); const session = await response.json();
    await route.fulfill({ response, json: { ...session, applicationMode: 'demo', identity: { configured: false } } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exit sample town', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Demo environment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('left-drawer')).toContainText('run.ps1 -Mode development');
});

test('production environment ignores a forged preview URL and offers real setup only', async ({ page }) => {
  const samples: string[] = [];
  page.on('request', request => { if (request.url().includes('/workspaces/demo-town/')) samples.push(request.url()); });
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch(); const session = await response.json();
    await route.fulfill({ response, json: { ...session, applicationMode: 'production' } });
  });
  await page.goto('/?preview=1');
  await expect(page.getByRole('heading', { name: 'Your private town starts here.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore sample town', exact: true })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('preview')).toBe(false);
  expect(samples).toEqual([]);
});

// UX-05 (Gap 8): "or explore the sample town while you wait" named a real button when the sample town was
// available, but stayed in the sentence even in a production install where no sample town exists at all —
// a dead mention with nothing behind it. The sentence and its link must appear together, or not at all.
test('GitHub not configured in production: the sample-town mention and its link are both absent', async ({ page }) => {
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch(); const session = await response.json();
    await route.fulfill({ response, json: { ...session, applicationMode: 'production', identity: { configured: false } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(page.getByText('GitHub sign-in is not set up on this computer yet', { exact: true })).toBeVisible();
  await expect(page.getByText('while you wait', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Explore the sample town', exact: true })).toHaveCount(0);
});

test('GitHub not configured in development: the sample-town mention and its link appear together', async ({ page }) => {
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch(); const session = await response.json();
    await route.fulfill({ response, json: { ...session, applicationMode: 'development', identity: { configured: false } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(page.getByText('GitHub sign-in is not set up on this computer yet', { exact: true })).toBeVisible();
  await expect(page.getByText('while you wait', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore the sample town', exact: true })).toBeVisible();
});

test('fresh startup shows account setup without silently loading fictional work', async ({ page }, testInfo) => {
  const sampleRequests: string[] = [];
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({ response, json: { ...session, identity: { configured: false, reason: 'Fixture installation needs its public client ID.' } } });
  });
  page.on('request', request => { if (request.url().includes('/workspaces/demo-town/')) sampleRequests.push(request.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-workspace', 'demo-town');
    localStorage.setItem('agent-town-workspace:old-owner', 'demo-town');
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your private town starts here.', exact: true })).toBeVisible();
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toHaveCount(0);
  await expect(page.locator('.agent-label')).toHaveCount(0);
  await expect(page.getByTestId('left-drawer')).toHaveCount(0);
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  mkdirSync('docs/assets/previews', { recursive: true });
  await page.screenshot({ path: `docs/assets/previews/${testInfo.project.name}-setup.png`, animations: 'disabled' });
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations.map(value => ({ id: value.id, targets: value.nodes.map(node => node.target) }))).toEqual([]);
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeDisabled();
  await expect(page.getByTestId('left-drawer')).toContainText('githubClientId');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your private town starts here.', exact: true })).toBeVisible();
  expect(sampleRequests).toEqual([]);
});

// UX-02: the Connections drawer states exactly when data leaves this computer, before any sign-in exists.
// The old unqualified "sends no project files or agent activity to GitHub or any AI provider" (removed:
// false once the manager or a managed task runs) must not reappear.
test('the Connections drawer states, before sign-in, exactly when data leaves this computer', async ({ page }) => {
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({ response, json: { ...session, identity: { configured: false, reason: 'Fixture installation needs its public client ID.' } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Private workspace setup', exact: true });
  await expect(setup).toContainText('GitHub is used to sign you in and, only if you turn on the GitHub repository list, every few minutes to read repository names.');
  await expect(setup).toContainText('Report text reaches an AI provider only when you press Process, or automatically every 30 seconds if you turn that on.');
  await expect(setup).toContainText('A managed task sends its files and output to an AI provider only once you approve that task.');
  await expect(setup).toContainText('Agent Town does not send it to a provider.');
  await expect(setup).toContainText('AI credits are used only if you turn on the manager and allow paid work, then either press Process or turn on automatic processing.');
  await expect(setup).not.toContainText('sends no project files or agent activity');
});

test('sample town requires an explicit choice and can be exited back to setup', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore sample town', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('preview')).toBe('1');
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 740 });
  const intro = await page.locator('.world-intro').boundingBox();
  for (const name of ['Run demo', 'Exit sample town', 'Show list view']) {
    const bounds = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(intro!.y);
  }
  await page.setViewportSize(originalViewport);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Exit sample town', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('preview')).toBe(false);
  await expect(page.getByRole('heading', { name: 'Your private town starts here.', exact: true })).toBeVisible();
  await expect(page.locator('.agent-label')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your private town starts here.', exact: true })).toBeVisible();
});
