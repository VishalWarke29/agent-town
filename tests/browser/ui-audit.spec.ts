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
    if (path.endsWith('/reports')) { await route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } }); return; }
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
  // 640x360 and 960x540 (UX-04, A11Y-1, RV-1) join the original 320x740 and 844x390 cases: short or
  // zoomed viewports where the room-context and List compete for the same list-layout height. 320x256
  // is covered for the List on its own below; combined with an open room-context, its available height
  // (118px) is still less than the room-context's own 100px minimum, which is unrelated to this fix and
  // stays a known gap (see the evidence note for UX-04).
  for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }, { width: 640, height: 360 }, { width: 960, height: 540 }]) {
    await page.setViewportSize(viewport);
    const context = page.getByTestId('room-context'), list = page.getByRole('region', { name: 'Accessible town list', exact: true });
    await expect(context).toBeVisible(); await expect(list).toBeVisible();
    // A resize does not itself move an existing scroll position; reset to the top first so every case
    // below reflects a person freshly looking at the List at that size, not scroll state left behind by
    // a previous size in this loop or by a scrollIntoViewIfNeeded call later in the same iteration.
    await list.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`long-room-${viewport.width}x${viewport.height}.png`) });
    const a = await context.boundingBox(), b = await list.boundingBox();
    expect.soft(!!a && !!b && (a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1), `${viewport.width}x${viewport.height} repository controls and List surface do not cover each other`).toBe(true);
    // The List heading and connection pill stay clear of the top bar and each other (ACC: never sits
    // under the pill or top bar; heading stays visible), measured before scrolling to the roster below.
    const metrics = await page.evaluate(() => {
      const layout = document.querySelector('.list-layout')!.getBoundingClientRect();
      const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
      const pill = document.querySelector('.connection-pill')!.getBoundingClientRect();
      const listView = document.querySelector('.list-view')!.getBoundingClientRect();
      const heading = document.querySelector('.list-heading h1')!.getBoundingClientRect();
      return {
        underTopbar: layout.top < topbar.bottom, underPill: layout.bottom > pill.top,
        // Full containment (top AND bottom) inside .list-view's own box, not just the top edge: a heading
        // whose top peeks just inside the scroll container while its bottom is clipped by that container's
        // own overflow:auto (only the tops of its letters showing) must fail here, not read as "visible".
        headingVisible: heading.height > 0 && heading.width > 0 && heading.top >= listView.top - 1 && heading.bottom <= listView.bottom + 1,
        scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      };
    });
    expect.soft(metrics.underTopbar, `${viewport.width}x${viewport.height} List view never sits under the top bar`).toBe(false);
    expect.soft(metrics.underPill, `${viewport.width}x${viewport.height} List view never sits under the connection pill`).toBe(false);
    expect.soft(metrics.headingVisible, `${viewport.width}x${viewport.height} List heading stays visible`).toBe(true);
    expect.soft(metrics.scrollWidth <= metrics.clientWidth + 1, `${viewport.width}x${viewport.height} creates no horizontal page scroll`).toBe(true);
    await list.getByRole('button', { name: `Inspect ${fixture.agentName}`, exact: true }).scrollIntoViewIfNeeded();
    expect.soft(await targetReachable(list.getByRole('button', { name: `Inspect ${fixture.agentName}`, exact: true })), `${viewport.width}x${viewport.height} roster remains reachable`).toBe(true);
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

// UX-04 (A11Y-1, RV-1; WCAG 1.4.10 reflow, 1.4.4 resize text): at 640x360, 844x390, 960x540 and
// 320x256 (short or zoomed viewports) a drawer's header, tabs and footer used to leave only a ~24px
// content slit, and the List view collapsed the same way. Verified against the "variant B" fix in
// .data/ui-audit/verify-4523/probe.mjs; see docs/02-ui-and-animation.md and docs/36-ui-reaudit.md.
const SHORT_VIEWPORTS = [
  { width: 640, height: 360, minContent: 160 },
  { width: 844, height: 390, minContent: 160 },
  { width: 960, height: 540, minContent: 160 },
  { width: 320, height: 256, minContent: 118 },
] as const;

test('short and zoomed viewports keep the Agents drawer content, its zero-AI footer and every control readable', async ({ page }, testInfo) => {
  const fixture = await uiFixture(page);
  const original = fixture.snapshot.state.agents[0]!;
  fixture.snapshot.state.agents = Array.from({ length: 3 }, (_, index) => ({ ...original, id: `audit-worker-${index}`, name: `Audit worker ${index}` }));
  await page.setViewportSize({ width: 640, height: 360 });
  await ready(page);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();

  for (const { width, height, minContent } of SHORT_VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'Open agents', exact: true }).click();
    const drawer = page.getByTestId('left-drawer');
    await expect(drawer).toBeVisible();
    const content = drawer.locator('.drawer-content');
    const contentBox = await content.boundingBox();
    expect.soft(contentBox?.height ?? 0, `${width}x${height} keeps a readable drawer content area, not a thin slit`).toBeGreaterThanOrEqual(minContent);
    expect.soft(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${width}x${height} creates no horizontal drawer overflow`).toBe(true);
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${width}x${height} creates no horizontal page scroll`).toBe(true);
    // The footer's "Local monitoring uses zero AI calls" line is an Economy-relevant fact: it survives
    // at ordinary laptop heights (960x540) and only disappears below the narrower 420px threshold.
    expect.soft(await drawer.locator('.drawer-footer').isVisible(), `${width}x${height} zero-AI footer visibility follows the 420px threshold`).toBe(height > 420);

    if (width === 960) {
      // A non-modal drawer at this width must not cover the top bar: brand and workspace pill stay clickable.
      for (const selector of ['.brand-mark', '.workspace-pill']) {
        const reachable = await page.locator(selector).first().evaluate(element => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return !!hit && (element === hit || element.contains(hit));
        });
        expect.soft(reachable, `${selector} stays clickable behind the drawer at 960x540`).toBe(true);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`short-${width}x${height}-agents.png`) });

    // Tab reaches every drawer control and keeps it inside the visible viewport (scrolled into view)
    // rather than clipped above or below the drawer's own short box.
    const tabStops = await drawer.locator('button, input, a[href]').count();
    await drawer.locator('.drawer-header .icon-button').focus();
    for (let i = 0; i < tabStops; i++) {
      await page.keyboard.press('Tab');
      const stillInDrawer = await drawer.evaluate(element => element.contains(document.activeElement));
      if (!stillInDrawer) break;
      const withinViewport = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.bottom <= innerHeight + 1;
      });
      expect.soft(withinViewport, `${width}x${height} tab stop ${i} scrolls fully into view`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});

test('short and zoomed viewports keep the List heading, three rows and navigation clear of the pill and top bar', async ({ page }, testInfo) => {
  const fixture = await uiFixture(page);
  const original = fixture.snapshot.state.agents[0]!;
  fixture.snapshot.state.agents = Array.from({ length: 6 }, (_, index) => ({ ...original, id: `audit-worker-${index}`, name: `Audit worker ${index}` }));

  for (const { width, height } of SHORT_VIEWPORTS) {
    // A fresh navigation per size (rather than resizing one live page across unrelated widths and
    // heights) avoids Chrome's scroll-anchoring carrying an old scroll offset into the next viewport,
    // which is not what a person opening the List view at that size would ever see.
    await page.setViewportSize({ width, height });
    await ready(page);
    await page.getByRole('button', { name: 'Show list view', exact: true }).click();
    const list = page.getByRole('region', { name: 'Accessible town list', exact: true });
    await expect(list).toBeVisible();
    const metrics = await page.evaluate(() => {
      const layout = document.querySelector('.list-layout')!.getBoundingClientRect();
      const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
      const pill = document.querySelector('.connection-pill')!.getBoundingClientRect();
      const listView = document.querySelector('.list-view')!.getBoundingClientRect();
      const heading = document.querySelector('.list-heading h1')!.getBoundingClientRect();
      return {
        underTopbar: layout.top < topbar.bottom,
        underPill: layout.bottom > pill.top,
        // Full containment (top AND bottom) inside .list-view's own box, not just the top edge: a heading
        // whose top peeks just inside the scroll container while its bottom is clipped by that container's
        // own overflow:auto (only the tops of its letters showing) must fail here, not read as "visible".
        headingVisible: heading.height > 0 && heading.width > 0 && heading.top >= listView.top - 1 && heading.bottom <= listView.bottom + 1,
        scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      };
    });
    expect.soft(metrics.underTopbar, `${width}x${height} List view never sits under the top bar`).toBe(false);
    expect.soft(metrics.underPill, `${width}x${height} List view never sits under the connection pill`).toBe(false);
    expect.soft(metrics.headingVisible, `${width}x${height} List heading stays visible`).toBe(true);
    expect.soft(metrics.scrollWidth <= metrics.clientWidth + 1, `${width}x${height} creates no horizontal page scroll`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`short-${width}x${height}-list-top.png`) });

    // At least three rows exist and are reachable inside the List's own scrollable area (ACC: 640x360).
    // A future fixture/filter change that drops below 3 real rows must fail here, not silently shrink
    // the loop below and pass anyway.
    const totalRows = await list.locator('tbody tr').count();
    expect.soft(totalRows, `${width}x${height} List has at least 3 rows`).toBeGreaterThanOrEqual(3);
    const rowCount = Math.min(3, totalRows);
    for (let i = 0; i < rowCount; i++) {
      const button = list.locator('tbody tr').nth(i).getByRole('button', { name: /^Inspect /, exact: false });
      await button.scrollIntoViewIfNeeded();
      const reachable = await button.evaluate(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return !!hit && (element === hit || element.contains(hit));
      });
      expect.soft(reachable, `${width}x${height} row ${i} stays reachable inside the List`).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`short-${width}x${height}-list.png`) });
  }
  expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]); expect(fixture.mutations).toEqual([]);
});
