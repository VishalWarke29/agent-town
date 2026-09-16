import { expect, test, type Page, type Route } from '@playwright/test';
import type { Agent, AgentReportPage, BrowserSession, Handoff, NativeSession, NativeSetupSnapshot, Snapshot } from '@agent-town/contracts';

const stamp = '2026-09-15T12:00:00.000Z';
const sourceId = '5fb1d314-1d46-48c9-9114-f35f78480428';
const fullSummary = `${'A complete saved report remains readable. '.repeat(12)}[End of full report] <img src="https://example.invalid/private" onerror="window.reportInjected=true">`;
const agent = (id: string, name: string): Agent => ({ id, name, provider: 'Codex', role: 'Discovered session', repoId: 'project', task: 'External session · task not linked', activity: 'unknown', color: '#71876a', home: [-6, -3], updatedAt: stamp, files: [], evidence: 'Current activity is unavailable.', contextVersion: null,
  discovery: { sourceId, nativeSessionId: `native-${id}`, discoveredAt: stamp, nativeUpdatedAt: stamp } });
const reports: Handoff[] = Array.from({ length: 26 }, (_, index) => ({ id: `report-${index}`, agentId: 'alpha', repoId: 'project', createdAt: new Date(Date.parse(stamp) - index * 1000).toISOString(), summary: index === 0 ? fullSummary : `Saved evidence ${index}`, status: index === 0 ? 'processed' : 'saved', contextVersion: index === 0 ? 9 : null, delivery: 'unsupported',
  ...(index === 0 ? { details: { outcome: 'ready-for-review' as const, taskId: 'fixture-task', runId: 'fixture-run', sourceEventId: 'fixture-event', occurredAt: stamp, contextVersionUsed: 3, baseCommit: 'fixture-base', branch: 'fixture-branch', worktreePath: null,
    files: { status: 'reported' as const, paths: ['src/fixture.ts'] }, checks: [{ name: 'Fixture typecheck', result: 'passed' as const, evidence: 'reported' as const, reference: 'Safe check reference' }], decisions: ['Keep the existing API'], assumptions: ['Fixture metadata is synthetic'], remainingWork: ['Human review remains'], evidenceRefs: ['Safe evidence reference'], limitations: ['Native activity was not independently verified'] } } : {}) }));

async function fixture(page: Page, respond: (id: string, offset: number, route: Route) => Promise<void>, options: { observedAlpha?: boolean } = {}) {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: 'reports-fixture', name: 'Report fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [{ id: 'project', name: 'Fixture project', description: '', language: '', branch: '', color: '#859b87', position: [-6, -3], source: 'local', localPath: 'C:\\synthetic-reports\\project' }],
    agents: [agent('alpha', 'Report session Alpha'), { ...agent('beta', 'Report session Beta'), discovery: { sourceId, nativeSessionId: 'native-beta', parentNativeSessionId: 'native-alpha', discoveredAt: stamp, nativeUpdatedAt: stamp } }], activity: [], handoffs: [], manager: { version: 9, brief: 'Saved fixture context', updatedAt: stamp } } };
  if (options.observedAlpha) Object.assign(snapshot.state.agents[0]!, { role: 'Observed session', activity: 'working', observation: { connectionId: 'fixture-connection', nativeSourceId: sourceId, sessionId: 'native-alpha', parentSessionId: null, lastSequence: 1, sourceTime: stamp, freshness: 'current', billing: 'unavailable' } });
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'reports-owner', login: 'reports-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: snapshot.state.workspace.id, name: snapshot.state.workspace.name, kind: 'personal' }], identity: { configured: true } };
  const calls: { method: string; path: string; offset: number }[] = [], remote: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') remote.push(request.url()); });
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      constructor() { super(); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    const offset = Number(url.searchParams.get('offset') ?? 0);
    calls.push({ method: route.request().method(), path, offset });
    const match = path.match(/^\/api\/v1\/workspaces\/reports-fixture\/agents\/([^/]+)\/reports$/);
    if (match) return respond(decodeURIComponent(match[1]!), offset, route);
    return route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  return { calls, remote, errors };
}

const viewer = (page: Page) => page.getByTestId('session-reports');

test('selected session reports retry, paginate and show full evidence without processing or model calls', async ({ page }, testInfo) => {
  let first = true;
  const result = await fixture(page, async (_id, offset, route) => {
    if (first) { first = false; return route.fulfill({ status: 503, json: { message: 'Saved report storage is temporarily unavailable.' } }); }
    const body: AgentReportPage = { reports: reports.slice(offset, offset + 25), reportCount: reports.length, reportsNextOffset: offset === 0 ? 25 : null };
    return route.fulfill({ json: body });
  }, { observedAlpha: true });
  await page.getByRole('button', { name: 'Inspect Report session Alpha', exact: true }).click();
  const assignment = page.getByTestId('right-drawer').locator('.detail-section').filter({ has: page.getByText('CURRENT ASSIGNMENT', { exact: true }) });
  await expect(assignment).toContainText('External session · task not linked');
  await expect(assignment).toContainText('The tool has not supplied a task description. Activity updates alone do not identify the assignment.');
  await expect(assignment).not.toContainText('Reported by the connected tool.');
  await expect(viewer(page).getByRole('alert')).toHaveText('Saved report storage is temporarily unavailable.');
  await expect(viewer(page)).not.toContainText('No reports are saved');
  await viewer(page).getByRole('button', { name: 'Retry reports', exact: true }).click();
  await expect(viewer(page).locator('article')).toHaveCount(25);
  const firstReport = viewer(page).locator('article').first();
  await expect(firstReport.locator('.history-report').first()).toHaveText(fullSummary);
  await expect(firstReport.locator('img')).toHaveCount(0);
  await expect(firstReport.locator('.facts > div').filter({ has: page.locator('dt', { hasText: /^Manager processing$/ }) })).toContainText('Processed');
  await expect(firstReport.locator('.facts > div').filter({ has: page.locator('dt', { hasText: /^Manager context$/ }) })).toContainText('v9');
  await expect(firstReport.locator('.facts > div').filter({ has: page.locator('dt', { hasText: /^Updated context delivery$/ }) })).toContainText('Unsupported');
  await viewer(page).getByRole('heading', { name: 'Saved reports', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/assets/previews/session-reports-${testInfo.project.name}.png` });
  await firstReport.getByText('Report evidence and limitations', { exact: true }).click();
  for (const text of ['src/fixture.ts', 'Fixture typecheck', 'Safe check reference', 'Keep the existing API', 'Fixture metadata is synthetic', 'Human review remains', 'Safe evidence reference', 'Native activity was not independently verified']) await expect(firstReport.getByText(text, { exact: true })).toBeVisible();
  await expect(firstReport.locator('.facts > div').filter({ has: page.locator('dt', { hasText: /^Context used for this report$/ }) })).toContainText('v3');
  await page.screenshot({ path: `docs/assets/previews/session-report-evidence-${testInfo.project.name}.png` });
  await viewer(page).getByRole('button', { name: 'Older reports', exact: true }).click();
  await expect(viewer(page).locator('article')).toHaveCount(1);
  await expect(viewer(page).getByText('Saved evidence 25', { exact: true })).toBeVisible();
  await expect(viewer(page).getByRole('button', { name: 'Older reports', exact: true })).toBeDisabled();
  await viewer(page).getByRole('button', { name: 'Newer reports', exact: true }).click();
  await expect(viewer(page).locator('article')).toHaveCount(25);
  expect(result.calls.map(call => call.offset)).toEqual([0, 0, 25, 0]);
  expect(result.calls.every(call => call.method === 'GET')).toBe(true);
  expect(result.remote).toEqual([]); expect(result.errors).toEqual([]);
});

test('a cancelled report read cannot populate another session and its verified parent remains inspectable', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    Reflect.set(window, '__sessionReportAborts', 0);
    window.fetch = (input, options) => {
      if (String(input).includes('/agents/alpha/reports')) options?.signal?.addEventListener('abort', () => { Reflect.set(window, '__sessionReportAborts', Number(Reflect.get(window, '__sessionReportAborts')) + 1); }, { once: true });
      return fetch(input, options);
    };
  });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let requested = false, completed = false;
  const result = await fixture(page, async (id, _offset, route) => {
    if (id === 'alpha') {
      requested = true; await waiting;
      // The UI intentionally aborts this request when its selection closes.
      try { await route.fulfill({ json: { reports: [reports[0]], reportCount: 1, reportsNextOffset: null } satisfies AgentReportPage }); }
      catch { /* An aborted browser request has no response consumer. */ }
      finally { completed = true; }
      return;
    }
    await route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } satisfies AgentReportPage });
  });
  try {
    await page.getByRole('button', { name: 'Inspect Report session Alpha', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await expect(viewer(page).getByRole('status')).toHaveText('Reading saved reports…');
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Number(Reflect.get(window, '__sessionReportAborts')))).toBeGreaterThan(0);
    await page.getByRole('region', { name: 'Accessible town list', exact: true }).getByRole('checkbox', { name: 'Show child agents', exact: true }).check();
    await page.getByRole('button', { name: 'Inspect Report session Beta', exact: true }).click();
    await expect(viewer(page)).toContainText('No reports are saved for this session.');
    release(); await expect.poll(() => completed).toBe(true);
    await expect(page.getByTestId('right-drawer').getByRole('heading', { name: 'Report session Beta', exact: true })).toBeVisible();
    await expect(viewer(page).locator('article')).toHaveCount(0);
    await expect(viewer(page)).not.toContainText('[End of full report]');
    const parent = page.getByRole('button', { name: 'Inspect parent · Report session Alpha', exact: true });
    await parent.scrollIntoViewIfNeeded();
    const linkBounds = await parent.boundingBox(), textBounds = await parent.locator('..').locator('span.mono').boundingBox();
    expect(linkBounds).not.toBeNull(); expect(textBounds).not.toBeNull();
    expect(linkBounds!.y - textBounds!.y - textBounds!.height).toBeGreaterThanOrEqual(7.5);
    await page.screenshot({ path: `docs/assets/previews/session-parent-${testInfo.project.name}.png` });
    await parent.click();
    await expect(page.getByTestId('right-drawer').getByRole('heading', { name: 'Report session Alpha', exact: true })).toBeVisible();
    await expect(viewer(page)).toContainText('[End of full report]');
    expect(result.calls.at(-1)?.path).toBe('/api/v1/workspaces/reports-fixture/agents/alpha/reports');
    expect(result.calls.every(call => call.method === 'GET')).toBe(true);
    expect(result.remote).toEqual([]); expect(result.errors).toEqual([]);
  } finally { release(); }
});

test('hidden native inventory sessions expose saved reports without adding a character or starting work', async ({ page }, testInfo) => {
  const hiddenAgent = agent('hidden', 'Hidden report session');
  const result = await fixture(page, async (id, _offset, route) => {
    expect(id).toBe('hidden');
    await route.fulfill({ json: { reports: [{ ...reports[0]!, agentId: id }], reportCount: 1, reportsNextOffset: null } satisfies AgentReportPage });
  });
  const item: NativeSession = { id: 'hidden-record', agentId: hiddenAgent.id, sourceId, provider: 'codex', nativeSessionId: 'native-hidden', repoId: 'project', createdAt: stamp, nativeUpdatedAt: stamp, discoveredAt: stamp, observedAt: null, visible: false, visibility: 'hidden', sceneVisible: false, activity: 'unknown' };
  const setup: NativeSetupSnapshot = { sources: [{ id: sourceId, provider: 'codex', label: 'Fixture profile', status: 'ready', discovery: 'available', lastScanAt: stamp, message: null, revision: 1 }], tools: [{ provider: 'codex', label: 'Codex', detected: true, discovery: 'available', version: 'fixture-version', message: 'Synthetic metadata only.', defaultHomePath: null }] };
  const inventoryCalls: { method: string; path: string }[] = [];
  await page.route('**/api/v1/workspaces/reports-fixture/observation/**', async route => {
    const path = new URL(route.request().url()).pathname; inventoryCalls.push({ path, method: route.request().method() });
    if (path.endsWith('/native-setup')) return route.fulfill({ json: setup });
    if (path.endsWith('/native-sessions')) return route.fulfill({ json: { items: [item], total: 1, nextCursor: null } });
    if (path.endsWith('/native-sessions/hidden-record/detail')) return route.fulfill({ json: hiddenAgent });
    return route.fulfill({ status: 404, json: { message: 'Unsupported read-only inventory fixture operation.' } });
  });
  await page.getByRole('navigation', { name: 'List view navigation' }).getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('combobox', { name: 'Local agent profile', exact: true }).selectOption(sourceId);
  const card = page.locator('.native-session-card');
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'View session details', exact: true }).click();
  await expect(viewer(page)).toContainText('[End of full report]');
  await viewer(page).getByRole('heading', { name: 'Saved reports', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `docs/assets/previews/inventory-session-reports-${testInfo.project.name}.png` });
  await expect(card.getByRole('button', { name: 'Show session native-hidden in town', exact: true })).toBeEnabled();
  expect([...result.calls, ...inventoryCalls].every(call => call.method === 'GET')).toBe(true);
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect Hidden report session', exact: true })).toHaveCount(0);
  expect(result.remote).toEqual([]); expect(result.errors).toEqual([]);
});
