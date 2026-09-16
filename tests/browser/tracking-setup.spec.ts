import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Agent, BrowserSession, NativeSession, NativeSetupSnapshot, ObservationSetup, Snapshot } from '@agent-town/contracts';

const sourceId = '2e8d2342-408c-4ddf-8d44-422fd775e1a0';
const stamp = '2026-09-15T12:00:00.000Z';
const prefix = '/api/v1/workspaces/tracking-fixture/observation';

async function trackingFixture(page: Page) {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: 'tracking-fixture', name: 'Tracking fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [{ id: 'project', name: 'Local project', description: 'Synthetic local project', language: 'TypeScript', branch: '', color: '#859b87', position: [-6, -3], projectKind: 'folder', source: 'local', localPath: 'C:\\synthetic-tracking\\project' }], agents: [], activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null }, observation: { connections: [] } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'tracking-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: snapshot.state.workspace.id, name: snapshot.state.workspace.name, kind: 'personal' }], identity: { configured: true } };
  const tools: NativeSetupSnapshot = { sources: [], tools: [{ provider: 'codex', label: 'Codex', detected: true, defaultHomePath: 'C:\\synthetic-tracking\\.codex', discovery: 'available', message: 'Read-only metadata discovery available.', version: 'fixture-version' }, { provider: 'copilot-vscode', label: 'Copilot in VS Code', detected: false, defaultHomePath: null, discovery: 'unsupported', message: 'Existing editor history discovery is unavailable. Future hooks are supported.', version: null }] };
  const items: NativeSession[] = Array.from({ length: 26 }, (_, index) => ({ id: `record-${index}`, agentId: `agent-${index}`, sourceId, provider: 'codex', nativeSessionId: `native-session-${index}`, repoId: 'project', createdAt: stamp, nativeUpdatedAt: stamp, discoveredAt: stamp, observedAt: null, visible: false, sceneVisible: false, activity: 'unknown' }));
  const setup: ObservationSetup = { connection: { id: 'hook-connection', provider: 'codex', repoId: 'project', label: 'Local Codex tracking', nativeSourceId: sourceId, binding: 'declared', status: 'unverified', createdAt: stamp, lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 }, configPath: 'C:\\synthetic-tracking\\project\\.codex\\hooks.json', config: '{"hooks":{}}', bridgeCommand: 'synthetic-reviewed-command', instructions: ['Review this exact hook definition in the native tool.', 'Resume the session after trusting the hook.'], readiness: { configured: false, nativeTrustRequired: true, sourceBinding: 'declared', overlappingHooks: false }, diagnostics: [{ code: 'awaiting_native_event', message: 'No supported event has arrived yet.' }] };
  const calls: { path: string; method: string; body: unknown }[] = [], pageErrors: string[] = [], remote: string[] = [];
  let scanned = false;
  const toAgent = (item: NativeSession): Agent => ({ id: item.agentId, name: `Codex session ${item.nativeSessionId}`, provider: 'Codex', role: 'Discovered session', repoId: item.repoId, task: 'External session · task not linked', activity: item.activity, color: '#71876a', home: [-6, -3], updatedAt: stamp, files: [], evidence: 'No observed evidence.', contextVersion: null, discovery: { sourceId, nativeSessionId: item.nativeSessionId, discoveredAt: stamp, nativeUpdatedAt: stamp } });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') remote.push(request.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('tracking-fixture-state', this.listener); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; window.removeEventListener('tracking-fixture-state', this.listener); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    if (/\/agents\/[^/]+\/reports$/.test(path) && request.method() === 'GET') return route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } });
    calls.push({ path, method: request.method(), body: request.postDataJSON() });
    if (path === `${prefix}/native-setup`) return route.fulfill({ json: tools });
    if (path === `${prefix}/native-sources`) {
      tools.sources = [{ id: sourceId, provider: 'codex', label: 'Codex local profile', status: 'ready', discovery: 'available', lastScanAt: null, message: null, revision: 1 }];
      return route.fulfill({ json: tools.sources[0] });
    }
    if (path.endsWith('/scan')) { scanned = true; tools.sources[0]!.lastScanAt = stamp; return route.fulfill({ json: { items: items.slice(0, 25), total: items.length, nextCursor: 'page-two' } }); }
    if (path === `${prefix}/native-sessions`) {
      const second = url.searchParams.get('cursor') === 'page-two';
      return route.fulfill({ json: { items: scanned ? second ? items.slice(25) : items.slice(0, 25) : [], total: scanned ? items.length : 0, nextCursor: scanned && !second ? 'page-two' : null } });
    }
    if (path.endsWith('/visibility')) {
      const item = items.find(value => path.includes(`/${value.id}/`))!;
      item.visible = !!request.postDataJSON().visible; item.sceneVisible = item.visible;
      snapshot.state.agents = items.filter(value => value.visible).map(toAgent);
      return route.fulfill({ json: snapshot });
    }
    if (path.endsWith('/detail')) { const item = items.find(value => path.includes(`/${value.id}/`))!; return route.fulfill({ json: toAgent(item) }); }
    if (path === `${prefix}/connections`) { snapshot.state.observation!.connections = [setup.connection]; return route.fulfill({ json: setup }); }
    if (path.endsWith('/apply')) { setup.readiness!.configured = true; return route.fulfill({ json: setup }); }
    if (path.endsWith('/setup')) return route.fulfill({ json: setup });
    return route.fulfill({ status: 400, json: { message: 'Unexpected synthetic tracking operation.' } });
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('tracking-fixture-state', { detail: current })), snapshot); };
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  return { snapshot, tools, items, setup, calls, pageErrors, remote, publish, toAgent };
}

async function enterTracking(page: Page) {
  await page.getByRole('button', { name: 'Local project', exact: true }).click();
  await page.getByTestId('room-context').getByRole('button', { name: 'Set up tracking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up local agent tracking', exact: true })).toBeVisible();
}
async function registerProfile(page: Page) {
  await page.getByRole('button', { name: 'Use detected profile folder', exact: true }).click();
  await page.getByRole('button', { name: 'Register profile', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Local agent profile', exact: true })).toHaveValue(sourceId);
}

test('house tracking setup discovers unknown sessions, reconciles activity and preserves its world', async ({ page }, testInfo) => {
  const evidence = await trackingFixture(page);
  const canvas = await page.locator('canvas').elementHandle();
  await enterTracking(page);
  await expect(page.getByRole('combobox', { name: 'Repository for observation', exact: true })).toHaveValue('project');
  await registerProfile(page);
  await page.getByRole('button', { name: 'Scan existing sessions', exact: true }).click();
  const cards = page.locator('.native-session-list');
  await expect(cards.getByText('Discovered · activity unknown', { exact: true })).toHaveCount(25);
  expect(await page.locator('canvas').evaluate((node, old) => node === old, canvas)).toBe(true);
  await page.getByRole('button', { name: 'Show session native-session-0 in town', exact: true }).click();
  await evidence.publish();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect Codex session native-session-0 in workroom', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect Codex session native-session-0 in workroom', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('Discovered · activity unknown');
  await expect(page.getByTestId('right-drawer')).toContainText('Session found · work details not received');
  await expect(page.getByTestId('right-drawer')).toContainText('Last activity from this session');
  await expect(page.getByTestId('right-drawer')).not.toContainText('Received · partial coverage');
  const actual = evidence.snapshot.state.agents[0]!;
  actual.activity = 'working'; actual.updatedAt = new Date().toISOString(); actual.observation = { connectionId: 'hook-connection', sessionId: 'native-session-0', parentSessionId: null, lastSequence: 1, sourceTime: actual.updatedAt, freshness: 'current', billing: 'unavailable' };
  await evidence.publish();
  await expect(page.getByTestId('right-drawer').getByText('Working', { exact: true })).toBeVisible();
  expect(evidence.snapshot.state.agents).toHaveLength(1);
  await expect(page.getByTestId('right-drawer')).not.toContainText('Discovered · activity unknown');
  await page.screenshot({ path: testInfo.outputPath('tracking-reconciled-session.png') });
  expect(evidence.remote).toEqual([]); expect(evidence.pageErrors).toEqual([]);
});

test('inventory pages and hidden choices remain available independently of live characters', async ({ page }) => {
  const evidence = await trackingFixture(page);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await page.getByRole('button', { name: 'Set up tracking', exact: true }).click();
  await registerProfile(page);
  await page.getByRole('checkbox', { name: 'Include history older than 30 days' }).check();
  await page.getByRole('button', { name: 'Scan existing sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Next sessions', exact: true }).click();
  await expect(page.locator('.native-session-card')).toHaveCount(1);
  await expect(page.locator('.native-session-card')).toContainText('native-session-25');
  await page.getByRole('button', { name: 'View session details', exact: true }).click();
  await expect(page.locator('.native-session-detail')).toContainText('No observed evidence.');
  await page.getByRole('button', { name: 'Show session native-session-25 in town', exact: true }).click();
  await page.getByRole('button', { name: 'Hide session native-session-25', exact: true }).click();
  await page.getByRole('button', { name: 'Previous sessions', exact: true }).click();
  await expect(page.locator('.native-session-card')).toHaveCount(25);
  expect(evidence.calls.find(call => call.path.endsWith('/scan'))?.body).toEqual({ repoId: 'project', includeOlder: true });
  expect(evidence.items[25]!.visible).toBe(false);
  expect(evidence.remote).toEqual([]); expect(evidence.pageErrors).toEqual([]);
});

test('applying a reviewed hook keeps native trust and real event verification separate', async ({ page }, testInfo) => {
  const evidence = await trackingFixture(page);
  await enterTracking(page); await registerProfile(page);
  await page.getByLabel('Connection label', { exact: true }).fill('Local Codex tracking');
  await page.getByRole('button', { name: 'Prepare observation setup', exact: true }).click();
  await evidence.publish();
  await page.getByRole('button', { name: 'Apply reviewed Agent Town hook', exact: true }).click();
  const review = page.getByRole('article', { name: 'Review observation hook setup', exact: true });
  await expect(review).toContainText('Hook file is on disk.');
  await expect(review).toContainText('Native trust still needs review in the tool.');
  await expect(page.locator('.observation-connections')).toContainText('No event received');
  await expect(page.locator('.observation-connections')).not.toContainText('Receiving events');
  expect(evidence.calls.find(call => call.path === `${prefix}/connections`)?.body).toMatchObject({ nativeSourceId: sourceId, repoId: 'project', provider: 'codex' });
  await page.screenshot({ path: testInfo.outputPath('tracking-native-verification.png') });
  const accessibility = await new AxeBuilder({ page }).include('[data-testid="left-drawer"]').analyze();
  expect(accessibility.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([]);
  expect(evidence.remote).toEqual([]); expect(evidence.pageErrors).toEqual([]);
});

test('unavailable history and detection failures have recovery without claiming zero sessions', async ({ page }) => {
  const evidence = await trackingFixture(page);
  await enterTracking(page);
  await page.getByRole('combobox', { name: 'Agent tool', exact: true }).selectOption('copilot-vscode');
  await expect(page.getByRole('region', { name: 'Find local agent sessions' })).toContainText('Existing editor history discovery is unavailable');
  await expect(page.getByRole('button', { name: 'Scan existing sessions', exact: true })).toBeDisabled();
  await page.route('**/observation/native-setup?**', route => route.fulfill({ status: 503, json: { message: 'Synthetic profile store is temporarily unavailable.' } }));
  await page.getByRole('button', { name: 'Refresh tool status', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic profile store is temporarily unavailable.');
  await expect(page.locator('.native-session-list')).toHaveCount(0);
  expect(evidence.pageErrors).toEqual([]);
});

test('a late inventory read cannot erase a completed scan', async ({ page }) => {
  const evidence = await trackingFixture(page);
  let releaseRead!: () => void;
  const delayedRead = new Promise<void>(resolve => { releaseRead = resolve; });
  let waiting = false;
  await page.route('**/observation/native-sessions?**', async route => {
    waiting = true; await delayedRead;
    await route.fulfill({ json: { items: [], total: 0, nextCursor: null } });
  });
  await enterTracking(page); await registerProfile(page);
  await expect.poll(() => waiting).toBe(true);
  await page.getByRole('button', { name: 'Scan existing sessions', exact: true }).click();
  await expect(page.locator('.native-session-card')).toHaveCount(25);
  releaseRead();
  await expect(page.getByText('Loading saved session inventory…', { exact: true })).toHaveCount(0);
  await expect(page.locator('.native-session-card')).toHaveCount(25);
  expect(evidence.pageErrors).toEqual([]);
});

test('cancelled discovery does not display a late result as a finished scan', async ({ page }) => {
  const evidence = await trackingFixture(page);
  let releaseScan!: () => void;
  const delayedScan = new Promise<void>(resolve => { releaseScan = resolve; });
  let cancelled = false;
  await page.route('**/native-sources/*/scan', async route => { await delayedScan; await route.fulfill({ json: { items: evidence.items, total: 26, nextCursor: null } }); });
  await page.route('**/native-sources/*/cancel', async route => { cancelled = true; await route.fulfill({ json: { cancelled: true } }); });
  await enterTracking(page); await registerProfile(page);
  await page.getByRole('button', { name: 'Scan existing sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel scan', exact: true }).click();
  await expect.poll(() => cancelled).toBe(true);
  releaseScan();
  await expect(page.getByText('Scan cancellation requested. Any sessions already saved remain available.', { exact: true })).toBeVisible();
  await expect(page.locator('.native-session-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Scan existing sessions', exact: true })).toBeEnabled();
  expect(evidence.pageErrors).toEqual([]);
});

test('continuing native discovery uses its scan cursor separately from saved inventory pages', async ({ page }) => {
  const evidence = await trackingFixture(page);
  const requests: unknown[] = [];
  await page.route('**/native-sources/*/scan', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const source = evidence.tools.sources[0]!;
    source.nextScanCursor = body.cursor ? null : 'native-history-cursor';
    source.lastScanRepoId = 'project'; source.lastScanIncludeOlder = false;
    await route.fulfill({ json: { items: evidence.items.slice(0, 25), total: body.cursor ? 26 : 25, nextCursor: body.cursor ? 'saved-inventory-page' : null } });
  });
  await enterTracking(page); await registerProfile(page);
  await page.getByRole('button', { name: 'Scan existing sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Find more sessions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Find more sessions', exact: true })).toHaveCount(0);
  await expect(page.locator('.native-session-list')).toContainText('26 saved matches');
  expect(requests).toEqual([{ repoId: 'project', includeOlder: false }, { repoId: 'project', includeOlder: false, cursor: 'native-history-cursor' }]);
  expect(evidence.pageErrors).toEqual([]);
});

for (const status of [503, 422] as const) {
  test(`scan ${status} refreshes profile diagnostics while preserving its error and saved sessions`, async ({ page }) => {
    const evidence = await trackingFixture(page);
    await enterTracking(page); await registerProfile(page);
    await expect(page.locator('.tracking-readiness')).toContainText('Profile folder found');
    await page.getByRole('button', { name: 'Scan existing sessions', exact: true }).click();
    await expect(page.locator('.native-session-card')).toHaveCount(25);
    await page.route('**/native-sources/*/scan', async route => {
      const source = evidence.tools.sources[0]!;
      source.discovery = status === 422 ? 'unsupported' : 'unavailable';
      source.status = 'unavailable'; source.message = 'Updated profile diagnostic from the failed scan.';
      await route.fulfill({ status, json: { message: `Native scan could not complete (${status}). Existing history is retained.` } });
    });
    await page.getByRole('button', { name: 'Scan existing sessions', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(`Native scan could not complete (${status}). Existing history is retained.`);
    await expect(page.getByText('Profile: Unavailable · Updated profile diagnostic from the failed scan.', { exact: true })).toBeVisible();
    await expect(page.locator('.native-session-card')).toHaveCount(25);
    await expect(page.getByRole('alert')).toHaveText(`Native scan could not complete (${status}). Existing history is retained.`);
    if (status === 422) await expect(page.getByRole('button', { name: 'Scan existing sessions', exact: true })).toBeDisabled();
    else await expect(page.getByRole('button', { name: 'Scan existing sessions', exact: true })).toBeEnabled();
    expect(evidence.pageErrors).toEqual([]);
  });
}
