import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BrowserSession, Snapshot } from '@agent-town/contracts';
import { initialWorkflow } from '../../apps/service/src/workflow/budget';

// Synthetic UI contracts only. Every API request is intercepted: no account,
// repository, telemetry producer, or model connection is involved.
async function uiFixture(page: Page, longNames = false) {
  const at = new Date().toISOString();
  const agentName = longNames ? `Worker-${'abcdefghij'.repeat(10)}` : 'Audit worker';
  const repoName = longNames ? 'Customer Platform Shared Authentication Repository With Extended Integration and Compatibility Checks' : 'Audit repository';
  const snapshot: Snapshot = { cursor: 1, state: {
    schemaVersion: 1, workspace: { id: 'ui-audit', name: 'UI audit workspace', mode: 'private' },
    workflow: initialWorkflow(), runner: { schemaVersion: 1, tasks: [], runs: [], subscriptions: [], subscriptionDefault: null },
    repositories: [{ id: 'audit-repo', name: repoName, description: 'Synthetic UI coverage.', branch: 'main', language: 'TypeScript', color: '#608d84', position: [-6, -4], source: 'local' }],
    agents: [{ id: 'audit-worker', name: agentName, repoId: 'audit-repo', provider: 'Claude', role: 'Observed session', task: 'Review the synthetic UI contract.', activity: 'working', color: '#608d84', home: [-5.4, -0.5], files: [], evidence: 'No execution has happened.', contextVersion: null, updatedAt: at }],
    handoffs: [], activity: [], manager: { version: 0, brief: 'No model calls.', updatedAt: null }, simulation: { running: false, step: 0 },
    telemetry: { inventories: [{ repoId: 'audit-repo', scannedAt: at, filesScanned: 1, coverage: 'complete', issues: [], endpoints: [{ id: 'audit-endpoint', repoId: 'audit-repo', method: 'GET', route: '/audit/health', framework: 'fastify', source: { path: 'src/audit.ts', line: 1, hash: 'a'.repeat(64) }, confidence: 'declared', reason: null }] }], spans: [], logs: [], metrics: [], metricCursors: [], seen: [], coverage: { rejected: 0, dropped: 0, lastReceivedAt: null } },
  } };
  const session: BrowserSession = { csrf: 'synthetic-ui-csrf', mode: 'private', applicationMode: 'development', user: { id: 'ui-owner', login: 'ui-owner', displayName: 'UI owner', avatarUrl: null }, workspaces: [{ id: 'ui-audit', name: snapshot.state.workspace.name, kind: 'personal' }], identity: { configured: true } };
  const errors: string[] = [], unexpected: string[] = [], mutations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') unexpected.push(request.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class UiEvents extends EventTarget {
      onopen: (() => void) | null = null; onerror: (() => void) | null = null;
      closed = false;
      constructor() { super(); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; }
    }
    window.EventSource = UiEvents as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/session') { await route.fulfill({ json: session }); return; }
    if (route.request().method() !== 'GET') mutations.push(`${route.request().method()} ${path}`);
    if (path.endsWith('/snapshot')) { await route.fulfill({ json: snapshot }); return; }
    if (path.endsWith('/services')) { await route.fulfill({ json: { sources: [], traffic: [], inventories: snapshot.state.telemetry!.inventories, coverage: snapshot.state.telemetry!.coverage } }); return; }
    unexpected.push(path);
    await route.fulfill({ status: 404, json: { message: 'Unexpected UI fixture request.' } });
  });
  return { agentName, repoName, snapshot, errors, unexpected, mutations };
}

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
}

async function targetReachable(locator: Locator) {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return rect.width >= 24 && rect.height >= 24 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && !!hit && (element === hit || element.contains(hit));
  });
}

test('320px drawers keep navigation, long names and close controls readable and reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const fixture = await uiFixture(page, true);
  fixture.snapshot.state.agents[0]!.task = `Review-${'UnbrokenAssignment'.repeat(12)}`;
  fixture.snapshot.state.agents[0]!.evidence = `Reported-${'UnbrokenEvidence'.repeat(14)}`;
  await ready(page);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  const drawer = page.getByTestId('left-drawer');
  await page.screenshot({ path: testInfo.outputPath('320-navigation.png') });
  for (const button of await drawer.getByRole('navigation', { name: 'Navigation sections' }).getByRole('button').all()) {
    expect.soft(await targetReachable(button), `${await button.getAttribute('aria-label')} navigation target fits at 320px`).toBe(true);
  }
  expect.soft(await drawer.locator('.drawer-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Long agent names do not create horizontal drawer overflow').toBe(true);
  await drawer.getByRole('button').filter({ hasText: fixture.agentName }).click();
  const details = page.getByTestId('right-drawer');
  await page.screenshot({ path: testInfo.outputPath('320-long-agent.png') });
  expect.soft(await targetReachable(details.getByRole('button', { name: 'Close details', exact: true })), 'Long heading cannot clip the close control').toBe(true);
  expect.soft(await details.locator('.drawer-header').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Long heading wraps within its header').toBe(true);
  expect.soft(await details.locator('.drawer-content').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Long assignment and evidence text wrap without horizontal inspector overflow').toBe(true);
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('long repository context leaves the List roster usable on narrow and short screens', async ({ page }, testInfo) => {
  const fixture = await uiFixture(page, true);
  await page.setViewportSize({ width: 320, height: 740 }); await ready(page);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await page.getByRole('button', { name: 'Open repositories', exact: true }).click();
  await page.getByTestId('left-drawer').getByRole('button').filter({ hasText: fixture.repoName }).click();
  for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const context = page.getByTestId('room-context'), list = page.getByRole('region', { name: 'Accessible town list', exact: true });
    await expect(context).toBeVisible(); await expect(list).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`long-room-${viewport.width}.png`) });
    const a = await context.boundingBox(), b = await list.boundingBox();
    expect.soft(!!a && !!b && (a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1), `${viewport.width}px repository controls and List surface do not cover each other`).toBe(true);
    await list.getByRole('button', { name: `Inspect ${fixture.agentName}`, exact: true }).scrollIntoViewIfNeeded();
    expect.soft(await targetReachable(list.getByRole('button', { name: `Inspect ${fixture.agentName}`, exact: true })), `${viewport.width}px roster remains reachable`).toBe(true);
  }
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('evidence stays above its drawer and retains keyboard focus across desktop-to-mobile resize', async ({ page }, testInfo) => {
  const fixture = await uiFixture(page);
  await page.setViewportSize({ width: 1440, height: 960 }); await ready(page);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await page.getByRole('button', { name: 'Open api activity', exact: true }).click();
  const endpoint = page.getByTestId('left-drawer').getByRole('button').filter({ hasText: '/audit/health' });
  await endpoint.click();
  const evidence = page.getByRole('dialog', { name: 'API source evidence', exact: true });
  await expect(evidence).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('left-drawer')).toHaveAttribute('aria-modal', 'true');
  await page.screenshot({ path: testInfo.outputPath('resized-evidence.png') });
  await expect.poll(() => targetReachable(evidence.getByRole('button', { name: 'Close evidence', exact: true })), { message: 'Evidence remains the topmost usable modal after parent modality changes' }).toBe(true);
  await page.keyboard.press('Tab');
  expect(await evidence.evaluate(element => element.contains(document.activeElement)), 'Tab remains in the evidence modal').toBe(true);
  await evidence.getByRole('button', { name: 'Close evidence', exact: true }).click();
  await expect(evidence).toHaveCount(0); await expect(endpoint).toBeFocused();
  await endpoint.click(); await expect(evidence).toBeVisible();
  // Native close requests (such as platform dismiss/back) dispatch cancel
  // without the Escape key handler. React still propagates onCancel upward.
  await evidence.evaluate(element => (element as HTMLDialogElement).requestClose());
  await expect(evidence).toHaveCount(0);
  await expect(page.getByTestId('left-drawer')).toBeVisible();
  await expect(endpoint).toBeFocused();
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('resizing two desktop drawers retains one mobile inspector and a usable return focus', async ({ page }) => {
  const fixture = await uiFixture(page);
  await page.setViewportSize({ width: 1440, height: 960 }); await ready(page);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByTestId('left-drawer').getByRole('button').filter({ hasText: fixture.agentName }).click();
  await expect(page.getByTestId('left-drawer')).toBeVisible(); await expect(page.getByTestId('right-drawer')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('left-drawer')).toHaveCount(0);
  await expect(page.getByTestId('right-drawer')).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open agents', exact: true })).toBeFocused();
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('a failed World chunk leaves an accessible List fallback and usable core navigation', async ({ page }, testInfo) => {
  const fixture = await uiFixture(page);
  let blockedChunks = 0;
  await page.route('**/assets/World-*.js', async route => { blockedChunks++; await route.abort('failed'); });
  await ready(page);
  await expect(page.getByRole('region', { name: 'Accessible town list', exact: true })).toBeVisible();
  await expect(page.getByText(/3D world is unavailable/)).toBeVisible();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await expect(page.getByTestId('left-drawer')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('failed-world-fallback.png') });
  expect(blockedChunks).toBeGreaterThan(0);
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('switching sidebar sections starts new content at the top without retaining the previous scroll', async ({ page }) => {
  const fixture = await uiFixture(page);
  const original = fixture.snapshot.state.agents[0]!;
  fixture.snapshot.state.agents = Array.from({ length: 30 }, (_, index) => ({ ...original, id: `audit-worker-${index}`, name: `Audit worker ${index}` }));
  await ready(page);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  const drawer = page.getByTestId('left-drawer'), content = drawer.locator('.drawer-content');
  await content.hover(); await page.mouse.wheel(0, 700);
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await drawer.getByRole('navigation', { name: 'Navigation sections' }).getByRole('button', { name: 'Repositories', exact: true }).click();
  await expect(drawer.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
  await expect.poll(() => content.evaluate(element => element.scrollTop), { message: 'A different sidebar section begins at its first content' }).toBe(0);
  await expect(drawer.getByText('Every project has a place in town.', { exact: true })).toBeInViewport();
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('ordinary UI text is not editable while real text fields retain normal caret and typing behavior', async ({ page }) => {
  const fixture = await uiFixture(page); await ready(page);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  const drawer = page.getByTestId('left-drawer'), heading = drawer.getByRole('heading', { name: 'Agents', exact: true });
  expect(await heading.evaluate(element => (element as HTMLElement).isContentEditable)).toBe(false);
  expect(await page.evaluate(() => document.designMode)).toBe('off');
  const input = drawer.getByRole('textbox', { name: 'Find an agent', exact: true });
  await input.fill('Audit'); await input.press('End'); await input.pressSequentially(' worker');
  await expect(input).toHaveValue('Audit worker'); await expect(input).toBeFocused();
  expect(await input.evaluate(element => { const field = element as HTMLInputElement; return { start: field.selectionStart, end: field.selectionEnd }; })).toEqual({ start: 12, end: 12 });
  await expect(drawer.locator('.agent-list .agent-row')).toHaveCount(1);
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});
