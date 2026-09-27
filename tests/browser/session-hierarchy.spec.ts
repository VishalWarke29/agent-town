import { expect, test, type Page } from '@playwright/test';
import type { Agent, BrowserSession, Handoff, Snapshot } from '@agent-town/contracts';

const stamp = '2026-09-15T12:00:00.000Z';
const sourceId = '3fb1d314-1d46-48c9-9114-f35f78480428';

function session(index: number, parent?: Agent, repoId = 'project'): Agent {
  const nativeSessionId = `0199abcd-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return { id: `hierarchy-${String(index).padStart(3, '0')}`, name: `Codex · ${nativeSessionId.slice(0, 8)}`, provider: 'Codex', role: parent ? 'Discovered child session' : 'Discovered session', repoId, task: 'External session · task not linked', activity: 'unknown', color: '#71876a', home: [-5.4, -0.5], updatedAt: stamp, files: [], evidence: 'Current activity is unavailable.', contextVersion: null,
    discovery: { sourceId, nativeSessionId, title: parent?.discovery?.title ?? `Primary session ${index + 1}`, ...(parent ? { parentNativeSessionId: parent.discovery!.nativeSessionId, nativeAgentName: `Child ${index}` } : {}), discoveredAt: stamp, nativeUpdatedAt: stamp } };
}

function family() {
  const parents = [session(0), session(1), session(2)];
  const children = Array.from({ length: 15 }, (_, index) => session(index + 100, parents[Math.floor(index / 5)]));
  return { parents, children, agents: [...parents, ...children] };
}

async function fixture(page: Page, agents: Agent[], handoffs: Handoff[] = []) {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: 'hierarchy-fixture', name: 'Session hierarchy fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [
    { id: 'project', name: 'Fixture project', description: '', language: '', branch: '', color: '#859b87', position: [-6, -3], source: 'local', localPath: 'C:\\synthetic-hierarchy\\project' },
    ...(agents.some(agent => agent.repoId === 'other') ? [{ id: 'other', name: 'Other folder', description: '', language: '', branch: '', color: '#859b87', position: [6, -3] as [number, number], source: 'local' as const, localPath: 'C:\\synthetic-hierarchy\\other' }] : []),
  ], agents, activity: [], handoffs, manager: { version: 0, brief: 'Fixture context remains separate from saved reports.', updatedAt: null }, observation: { connections: [] } } };
  const browserSession: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'hierarchy-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: snapshot.state.workspace.id, name: snapshot.state.workspace.name, kind: 'personal' }], identity: { configured: true } };
  const mutations: string[] = [], unexpected: string[] = [], remote: string[] = [], errors: string[] = [], reportReads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:/.test(request.url()) && url.hostname !== '127.0.0.1') remote.push(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.pathname !== '/api/v1/session') mutations.push(`${request.method()} ${url.pathname}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class HierarchyEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('hierarchy-fixture-state', this.listener); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; window.removeEventListener('hierarchy-fixture-state', this.listener); }
    }
    window.EventSource = HierarchyEvents as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (path === '/api/v1/session') return route.fulfill({ json: browserSession });
    // LiveTrackingPanel polls this (WS3-24) for a "rebuilt, restart to use it" notice, but only while the project has a
    // connection, and at most every 30 seconds (H0-02, D38); a fixture with nothing to report answers it, and it is
    // not an unsupported action. tests/browser/houses-first.spec.ts pins when it may and may not be asked.
    if (path === '/api/v1/health' && method === 'GET') return route.fulfill({ json: { ok: true, rebuiltPendingRestart: false } });
    // Only a mock. Nothing asks for a tool check on its own any more: it starts when the person presses "Check this computer" (H0-02, D38).
    if (path === '/api/v1/workspaces/hierarchy-fixture/snapshot' && method === 'GET') return route.fulfill({ json: snapshot });
    if (path === '/api/v1/workspaces/hierarchy-fixture/observation/tool-detection' && method === 'GET') return route.fulfill({ json: { repoId: new URL(route.request().url()).searchParams.get('repoId'), tools: ['codex', 'claude', 'cursor', 'copilot-cli'].map(provider => ({ provider, label: provider, state: 'not-installed', sessionCount: null, sessionCountExact: true, message: null })) } });
    const reportMatch = path.match(/^\/api\/v1\/workspaces\/hierarchy-fixture\/agents\/(hierarchy-\d+)\/reports$/);
    if (reportMatch && method === 'GET') {
      reportReads.push(reportMatch[1]!);
      const reports = snapshot.state.handoffs.filter(report => report.agentId === reportMatch[1]);
      return route.fulfill({ json: { reports, reportCount: reports.length, reportsNextOffset: null } });
    }
    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  return { snapshot, mutations, unexpected, remote, errors, reportReads,
    publish: async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('hierarchy-fixture-state', { detail: current })), snapshot); } };
}

const world = (page: Page) => page.getByTestId('world-canvas');
const room = (page: Page) => page.getByTestId('room-context');
const drawer = (page: Page) => page.getByTestId('right-drawer');
const roster = (page: Page) => page.getByTestId('repository-agents');
const label = (page: Page, agent: Agent) => world(page).locator(`.agent-label[data-agent-id="${agent.id}"]`);
async function enterHouse(page: Page) {
  await page.getByRole('button', { name: 'Fixture project', exact: true }).click();
  await expect(page.locator('canvas')).not.toHaveAttribute('data-camera-mode', 'transition');
}
function expectReadOnly(result: Awaited<ReturnType<typeof fixture>>) {
  expect(result.mutations).toEqual([]); expect(result.unexpected).toEqual([]); expect(result.remote).toEqual([]); expect(result.errors).toEqual([]);
}

test('three primary sessions are the default while fifteen child characters remain an explicit reversible view', async ({ page }, testInfo) => {
  const data = family(), result = await fixture(page, data.agents);
  const canvas = await page.locator('canvas').elementHandle();
  await expect(world(page)).toHaveAttribute('data-visible-actor-count', '3');
  for (const child of data.children) await expect(label(page, child)).toHaveCount(0);
  await enterHouse(page);
  await expect(world(page)).toHaveAttribute('data-visible-desk-agents', JSON.stringify(data.parents.map(agent => agent.id)));
  await expect(room(page)).toContainText('3 primary sessions');
  await expect(room(page)).toContainText('15 child agents');
  await expect(room(page)).toContainText('3 desk residents');
  const toggle = room(page).getByRole('checkbox', { name: 'Show child agents', exact: true });
  await expect(toggle).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('primary-sessions-default.png') });
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await expect(room(page)).toContainText('18 desk residents');
  const rendered = new Set<string>();
  for (let index = 0; index < 3; index++) {
    await expect(room(page)).toContainText(`Page ${index + 1} of 3`);
    const ids = JSON.parse((await world(page).getAttribute('data-visible-desk-agents'))!) as string[];
    expect(ids).toHaveLength(6); for (const id of ids) rendered.add(id);
    if (index < 2) await room(page).getByRole('button', { name: 'Next desks', exact: true }).click();
  }
  expect([...rendered].sort()).toEqual(data.agents.map(agent => agent.id).sort());
  await toggle.uncheck();
  await expect(world(page)).toHaveAttribute('data-visible-desk-agents', JSON.stringify(data.parents.map(agent => agent.id)));
  await expect(room(page)).toContainText('Page 1 of 1');
  await expect(world(page)).toHaveAttribute('data-visible-actor-count', '3');
  expect(await page.locator('canvas').evaluate((node, old) => node === old, canvas)).toBe(true);
  await page.reload();
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await expect(world(page)).toHaveAttribute('data-visible-actor-count', '3');
  await enterHouse(page);
  await room(page).getByRole('button', { name: 'Repository details', exact: true }).click();
  await expect(roster(page).locator('.agent-row')).toHaveCount(3);
  await drawer(page).getByRole('checkbox', { name: 'Show child agents', exact: true }).check();
  await expect(roster(page).locator('.agent-row')).toHaveCount(18);
  await roster(page).getByRole('textbox', { name: 'Find a repository agent', exact: true }).fill('Child 100');
  await expect(roster(page).locator('.agent-row')).toHaveCount(1);
  await expect(roster(page).locator('.agent-row')).toHaveAttribute('data-agent-id', data.children[0]!.id);
  expect(result.snapshot.state.agents).toHaveLength(18);
  expectReadOnly(result);
});

test('a child remains inspectable with its saved report while primary-only world and List keep the same scope', async ({ page }, testInfo) => {
  const data = family(), reporting = data.children.at(-1)!;
  reporting.activity = 'reporting';
  reporting.observation = { connectionId: 'fixture-hook', nativeSourceId: sourceId, sessionId: reporting.discovery!.nativeSessionId, parentSessionId: reporting.discovery!.parentNativeSessionId!, lastSequence: 1, sourceTime: new Date(Date.now() - 180000).toISOString(), freshness: 'current', billing: 'unavailable' };
  const report: Handoff = { id: 'child-saved-report', agentId: reporting.id, repoId: reporting.repoId, createdAt: stamp, summary: 'Saved child evidence remains available while its character is collapsed.', status: 'saved', contextVersion: null, delivery: 'unsupported' };
  const result = await fixture(page, data.agents, [report]);
  await enterHouse(page);
  await expect(world(page)).toHaveAttribute('data-visible-actor-count', '3');
  await label(page, data.parents[2]!).click();
  const childLink = drawer(page).getByRole('button', { name: 'Inspect child · Child 114', exact: true });
  await childLink.scrollIntoViewIfNeeded();
  await expect(childLink.locator('..')).toContainText('Last reported');
  await expect(childLink.locator('..')).toContainText('stale');
  await page.screenshot({ path: testInfo.outputPath('parent-child-details.png') });
  await childLink.focus(); await page.keyboard.press('Enter');
  await expect(drawer(page).getByRole('heading', { name: 'Child 114', exact: true })).toBeVisible();
  await expect(drawer(page)).toContainText(reporting.discovery!.nativeSessionId);
  await expect(drawer(page).getByRole('button', { name: 'Inspect parent · Primary session 3', exact: true })).toBeVisible();
  await expect(page.getByTestId('session-reports')).toContainText(report.summary);
  await expect(page.getByTestId('session-reports')).toContainText('Pending');
  await expect(world(page)).toHaveAttribute('data-visible-actor-count', '3');
  reporting.updatedAt = new Date().toISOString(); reporting.observation!.lastSequence = 2;
  await result.publish();
  await expect(drawer(page).getByRole('heading', { name: 'Child 114', exact: true })).toBeVisible();
  await page.getByTestId('session-reports').getByRole('heading', { name: 'Saved reports', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('collapsed-child-saved-report.png') });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await room(page).getByRole('checkbox', { name: 'Show child agents', exact: true }).check();
  await expect(world(page)).toHaveAttribute('data-visible-actor-count', '7');
  await expect(room(page)).toContainText('17 desk residents');
  await room(page).getByRole('checkbox', { name: 'Show child agents', exact: true }).uncheck();
  await expect(world(page)).toHaveAttribute('data-visible-actor-count', '3');
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('.agent-row')).toHaveCount(3);
  await expect(roster(page)).toContainText('15 child agents');
  await page.screenshot({ path: testInfo.outputPath('primary-session-roster.png') });
  const disclosure = roster(page).locator('.session-child-disclosure').first();
  await disclosure.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(disclosure.getByRole('button', { name: 'Inspect child · Child 100', exact: true })).toBeVisible();
  await disclosure.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('nested-child-roster.png') });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Back to town', exact: true }).click();
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  const list = page.getByRole('region', { name: 'Accessible town list', exact: true });
  await expect(list.getByRole('button', { name: /^Inspect Primary session/ })).toHaveCount(3);
  await expect(list.getByRole('button', { name: 'Inspect Child 114', exact: true })).toHaveCount(0);
  await list.getByRole('button', { name: 'Inspect Primary session 3', exact: true }).click();
  await drawer(page).getByRole('button', { name: 'Inspect child · Child 114', exact: true }).click();
  await expect(page.getByTestId('session-reports')).toContainText(report.summary);
  expect(result.reportReads).toContain(reporting.id);
  expect(result.snapshot.state.agents).toHaveLength(18);
  expectReadOnly(result);
});

test('unresolved child parents stay visible and a matching native ID in another folder never absorbs them', async ({ page }, testInfo) => {
  const primary = session(0), missingParent = session(10), foreignParent = session(20, undefined, 'other');
  missingParent.discovery!.title = 'Unresolved local child';
  missingParent.discovery!.parentNativeSessionId = 'absent-parent-id';
  const crossFolder = session(11, foreignParent), nested = session(12, primary);
  const result = await fixture(page, [primary, missingParent, crossFolder, nested, foreignParent]);
  await expect(world(page)).toHaveAttribute('data-visible-actor-count', '4');
  await enterHouse(page);
  await expect(world(page)).toHaveAttribute('data-visible-desk-agents', JSON.stringify([primary.id, missingParent.id, crossFolder.id]));
  await expect(label(page, nested)).toHaveCount(0);
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('.agent-row')).toHaveCount(3);
  await expect(roster(page)).toContainText('Parent unavailable');
  await expect(roster(page).locator(`[data-agent-id="${foreignParent.id}"]`)).toHaveCount(0);
  await roster(page).locator(`[data-agent-id="${crossFolder.id}"]`).click();
  await expect(drawer(page)).toContainText('Parent unavailable');
  await expect(drawer(page).getByRole('button', { name: /^Inspect parent/ })).toHaveCount(0);
  await expect(drawer(page)).toContainText('C:\\synthetic-hierarchy\\project');
  await expect(drawer(page)).toContainText(crossFolder.discovery!.nativeSessionId);
  await page.screenshot({ path: testInfo.outputPath('unresolved-parent-exact-folder.png') });
  expectReadOnly(result);
});
