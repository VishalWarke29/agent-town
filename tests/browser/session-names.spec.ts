import { expect, test, type Page } from '@playwright/test';
import type { Agent, BrowserSession, Snapshot } from '@agent-town/contracts';

const stamp = '2026-09-15T12:00:00.000Z';
const sourceId = '18d9d6ee-6eab-41d6-a922-179bc3c997bd';
const longTitle = 'Implement native session titles and preserve each character through restarts without changing ongoing work';
const sharedTitle = 'Migrate workspace database';

function savedAgent(index: number, title?: string, nativeAgentName?: string): Agent {
  const nativeSessionId = `0199beef-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return { id: `named-${index}`, name: `Codex · ${nativeSessionId.slice(0, 8)}`, provider: 'Codex', role: 'Discovered session', repoId: 'project', task: 'External session · task not linked', activity: 'unknown', color: '#71876a', home: [-5.4, -0.5], updatedAt: stamp, files: [], evidence: 'Current activity is unavailable.', contextVersion: null,
    discovery: { sourceId, nativeSessionId, ...(title ? { title } : {}), ...(nativeAgentName ? { nativeAgentName } : {}), discoveredAt: stamp, nativeUpdatedAt: stamp } };
}

async function fixture(page: Page, agents = [savedAgent(0, longTitle), savedAgent(1, sharedTitle), savedAgent(2, sharedTitle), savedAgent(3)]) {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: 'names-fixture', name: 'Session names fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [{ id: 'project', name: 'Fixture project', description: '', language: '', branch: '', color: '#859b87', position: [-6, -3], source: 'local', localPath: 'C:\\synthetic-names\\project' }], agents, activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports.', updatedAt: null }, observation: { connections: [] } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'names-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: snapshot.state.workspace.id, name: snapshot.state.workspace.name, kind: 'personal' }], identity: { configured: true } };
  const mutations: string[] = [], unexpected: string[] = [], remote: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^https?:/.test(request.url()) && url.hostname !== '127.0.0.1') remote.push(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && url.pathname !== '/api/v1/session') mutations.push(`${request.method()} ${url.pathname}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem('agent-town-reduced-motion', 'true');
    class NameEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('names-fixture-state', this.listener); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; window.removeEventListener('names-fixture-state', this.listener); }
    }
    window.EventSource = NameEvents as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path === '/api/v1/workspaces/names-fixture/snapshot' && route.request().method() === 'GET') return route.fulfill({ json: snapshot });
    if (/^\/api\/v1\/workspaces\/names-fixture\/agents\/named-\d+\/reports$/.test(path) && route.request().method() === 'GET') return route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } });
    unexpected.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  return { snapshot, mutations, unexpected, remote, errors,
    publish: async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('names-fixture-state', { detail: current })), snapshot); } };
}

const label = (page: Page, agent: Agent) => page.locator(`.world-canvas .agent-label[data-agent-id="${agent.id}"]`);
const drawer = (page: Page) => page.getByTestId('right-drawer');
const roster = (page: Page) => page.getByTestId('repository-agents');
async function enterHouse(page: Page) {
  await page.getByRole('button', { name: 'Fixture project', exact: true }).click();
  await expect(page.locator('canvas')).not.toHaveAttribute('data-camera-mode', 'transition');
}
function expectReadOnly(result: Awaited<ReturnType<typeof fixture>>) {
  expect(result.mutations).toEqual([]); expect(result.unexpected).toEqual([]); expect(result.remote).toEqual([]); expect(result.errors).toEqual([]);
}

test('native session titles identify characters, inspectors, searchable rosters and List while activity updates preserve identity', async ({ page }, testInfo) => {
  const result = await fixture(page);
  const agent = result.snapshot.state.agents[0]!, nativeId = agent.discovery!.nativeSessionId;
  const canvas = await page.locator('canvas').elementHandle();
  await enterHouse(page);
  await expect(label(page, agent)).toHaveAttribute('aria-label', `Inspect ${longTitle} in workroom`);
  await expect(label(page, agent)).toHaveAttribute('title', `${longTitle} · Activity unknown · Session ${nativeId}`);
  const box = await label(page, agent).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(130);
  if (testInfo.project.name === 'desktop') {
    expect(await label(page, agent).locator('.room-agent-name').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  } else await expect(label(page, agent).locator('.room-desk-number')).toHaveText('1');
  await label(page, agent).focus(); await page.keyboard.press('Enter');
  await expect(drawer(page).getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
  await expect(drawer(page).getByText(nativeId, { exact: true })).toBeVisible();
  const assignment = drawer(page).locator('.detail-section').filter({ has: page.getByText('CURRENT ASSIGNMENT', { exact: true }) });
  await expect(assignment).toContainText('External session · task not linked');
  await expect(assignment).not.toContainText(longTitle);
  const now = new Date().toISOString();
  agent.activity = 'working'; agent.updatedAt = now; agent.name = 'Codex 1';
  agent.observation = { connectionId: 'fixture-hook', sessionId: nativeId, parentSessionId: null, nativeSourceId: sourceId, lastSequence: 1, sourceTime: now, freshness: 'current', billing: 'unavailable' };
  await result.publish();
  await expect(drawer(page).getByText('Working', { exact: true })).toBeVisible();
  await expect(drawer(page).getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
  await drawer(page).getByText(nativeId, { exact: true }).scrollIntoViewIfNeeded();
  await expect(drawer(page).getByText(nativeId, { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Close details', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('native-title-inspector.png') });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(label(page, agent)).toHaveCount(1);
  await expect(label(page, agent)).toHaveAttribute('aria-label', `Inspect ${longTitle} in workroom`);
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find a repository agent', exact: true }).fill('preserve each character');
  await expect(roster(page).locator('.agent-row')).toHaveCount(1);
  await expect(roster(page).locator('.agent-row')).toHaveAttribute('data-agent-id', agent.id);
  await page.getByRole('textbox', { name: 'Find a repository agent', exact: true }).fill(result.snapshot.state.agents[2]!.discovery!.nativeSessionId);
  await expect(roster(page).locator('.agent-row')).toHaveCount(1);
  await expect(roster(page).locator('.agent-row')).toHaveAttribute('data-agent-id', 'named-2');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await expect(roster(page).getByRole('button', { name: `Inspect ${longTitle}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to town', exact: true }).click();
  const list = page.getByRole('region', { name: 'Accessible town list', exact: true });
  await expect(list.getByText(longTitle, { exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: `Inspect ${longTitle}`, exact: true })).toBeVisible();
  await list.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find an agent', exact: true }).fill('Migrate workspace database');
  await expect(page.getByTestId('left-drawer').locator('.agent-row')).toHaveCount(2);
  expect(await page.locator('canvas').evaluate((node, old) => node === old, canvas)).toBe(true);
  expectReadOnly(result);
});

test('matching native titles remain separate sessions and untitled or custom-named sessions keep honest fallbacks', async ({ page }, testInfo) => {
  const custom = savedAgent(4, 'Native source title'); custom.name = 'Owner chosen name';
  const result = await fixture(page, [savedAgent(0, sharedTitle), savedAgent(1, sharedTitle), savedAgent(2), custom]);
  await enterHouse(page);
  await expect(page.getByRole('button', { name: `Inspect ${sharedTitle} in workroom`, exact: true })).toHaveCount(2);
  for (const agent of result.snapshot.state.agents.slice(0, 2)) {
    await label(page, agent).click();
    await expect(drawer(page).getByRole('heading', { name: sharedTitle, exact: true })).toBeVisible();
    await expect(drawer(page).getByText(agent.discovery!.nativeSessionId, { exact: true })).toBeVisible();
    await expect(drawer(page)).toContainText('Discovered · activity unknown');
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
  }
  const untitled = result.snapshot.state.agents[2]!;
  await expect(label(page, untitled)).toHaveAttribute('aria-label', `Inspect Codex · …${untitled.discovery!.nativeSessionId.slice(-8)} in workroom`);
  await expect(label(page, custom)).toHaveAttribute('aria-label', 'Inspect Owner chosen name in workroom');
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('.agent-row')).toHaveCount(4);
  await expect(roster(page).getByRole('button', { name: `Inspect ${sharedTitle}`, exact: true })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('native-title-roster.png') });
  expectReadOnly(result);
});

test('long native titles stay bounded on campus while their complete title and native ID remain accessible', async ({ page }, testInfo) => {
  const agent = savedAgent(0, longTitle), now = new Date().toISOString();
  agent.activity = 'waiting'; agent.updatedAt = now;
  agent.observation = { connectionId: 'fixture-hook', sessionId: agent.discovery!.nativeSessionId, parentSessionId: null, lastSequence: 1, sourceTime: now, freshness: 'current', billing: 'unavailable' };
  const result = await fixture(page, [agent]);
  await expect(label(page, agent)).toBeVisible();
  await expect(label(page, agent)).toHaveAttribute('aria-label', `Inspect ${longTitle}`);
  await expect(label(page, agent)).toHaveAttribute('title', new RegExp(agent.discovery!.nativeSessionId));
  const name = label(page, agent).locator('.campus-agent-name');
  await expect(name).toHaveText(longTitle);
  expect(await name.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect((await name.boundingBox())!.width).toBeLessThanOrEqual(180);
  expect((await label(page, agent).boundingBox())!.width).toBeLessThanOrEqual(260);
  await page.screenshot({ path: testInfo.outputPath('native-title-campus.png') });
  await label(page, agent).click();
  await expect(drawer(page).getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
  expectReadOnly(result);
});

test('native child names distinguish a shared conversation in the room, roster, List and inspector without losing its title', async ({ page }, testInfo) => {
  const parent = savedAgent(0, sharedTitle), atlas = savedAgent(1, sharedTitle, 'Atlas'), finch = savedAgent(2, sharedTitle, 'Finch');
  for (const child of [atlas, finch]) { child.discovery!.parentNativeSessionId = parent.discovery!.nativeSessionId; child.role = 'Discovered child session'; }
  const result = await fixture(page, [parent, atlas, finch]);
  await enterHouse(page);
  await expect(label(page, atlas)).toHaveCount(0);
  await expect(label(page, finch)).toHaveCount(0);
  await page.getByTestId('room-context').getByRole('checkbox', { name: 'Show child agents', exact: true }).check();
  await expect(label(page, parent)).toHaveAttribute('aria-label', `Inspect ${sharedTitle} in workroom`);
  await expect(label(page, parent).locator('.agent-child-mark')).toHaveCount(0);
  for (const child of [atlas, finch]) {
    await expect(label(page, child)).toHaveAttribute('aria-label', `Inspect ${child.discovery!.nativeAgentName} · Child session in workroom`);
    await expect(label(page, child)).toHaveAttribute('title', `${child.discovery!.nativeAgentName} · Child session · Conversation: ${sharedTitle} · Activity unknown · Session ${child.discovery!.nativeSessionId}`);
    if (testInfo.project.name === 'desktop') await expect(label(page, child).locator('.agent-child-mark')).toBeVisible();
    else {
      await expect(label(page, child).locator('.agent-child-mark')).toBeHidden();
      await expect(label(page, child).locator('.room-desk-number')).toHaveText(child === atlas ? '2' : '3');
    }
    await expect(label(page, child).locator('.room-agent-name')).toHaveText(child.discovery!.nativeAgentName!);
    expect((await label(page, child).boundingBox())!.width).toBeLessThanOrEqual(130);
  }
  await page.screenshot({ path: testInfo.outputPath('native-child-names-room.png') });
  await label(page, atlas).focus(); await page.keyboard.press('Enter');
  await expect(drawer(page).getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible();
  await expect(drawer(page)).toContainText(sharedTitle);
  await expect(drawer(page)).toContainText(atlas.discovery!.nativeSessionId);
  await expect(drawer(page).getByRole('button', { name: `Inspect parent · ${sharedTitle}`, exact: true })).toBeVisible();
  const now = new Date().toISOString();
  atlas.name = 'Codex 2'; atlas.activity = 'working'; atlas.updatedAt = now;
  atlas.observation = { connectionId: 'fixture-hook', sessionId: atlas.discovery!.nativeSessionId, parentSessionId: parent.discovery!.nativeSessionId, nativeSourceId: sourceId, lastSequence: 1, sourceTime: now, freshness: 'current', billing: 'unavailable' };
  await result.publish();
  await expect(drawer(page).getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible();
  await expect(drawer(page).getByText('Working', { exact: true })).toBeVisible();
  await drawer(page).getByText(atlas.discovery!.nativeSessionId, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('native-child-name-details.png') });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await page.getByRole('textbox', { name: 'Find a repository agent', exact: true }).fill('Atlas');
  await expect(roster(page).locator('.agent-row')).toHaveCount(1);
  await expect(roster(page).locator('.agent-row')).toHaveAttribute('data-agent-id', atlas.id);
  await page.getByRole('textbox', { name: 'Find a repository agent', exact: true }).fill(sharedTitle);
  await expect(roster(page).locator('.agent-row')).toHaveCount(3);
  await expect(roster(page).getByRole('button', { name: 'Inspect Atlas', exact: true })).toBeVisible();
  await expect(roster(page).getByRole('button', { name: 'Inspect Finch', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('native-child-names-roster.png') });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await expect(roster(page).getByRole('button', { name: 'Inspect Atlas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to town', exact: true }).click();
  const list = page.getByRole('region', { name: 'Accessible town list', exact: true });
  await expect(list.getByText('Atlas', { exact: true })).toBeVisible();
  await expect(list.getByText('Finch', { exact: true })).toBeVisible();
  await list.getByRole('button', { name: 'Inspect Finch', exact: true }).click();
  await expect(drawer(page).getByRole('heading', { name: 'Finch', exact: true })).toBeVisible();
  await expect(drawer(page)).toContainText(finch.discovery!.nativeSessionId);
  expectReadOnly(result);
});

test('matching native nicknames keep distinct identities and native names never overwrite custom character names', async ({ page }) => {
  const first = savedAgent(0, sharedTitle, 'Atlas'), second = savedAgent(1, sharedTitle, 'Atlas'), custom = savedAgent(2, sharedTitle, 'Finch');
  first.discovery!.parentNativeSessionId = 'parent-native'; second.discovery!.parentNativeSessionId = 'parent-native';
  custom.name = 'Owner chosen reviewer';
  const result = await fixture(page, [first, second, custom]);
  await enterHouse(page);
  await expect(page.getByRole('button', { name: 'Inspect Atlas · Child session in workroom', exact: true })).toHaveCount(2);
  for (const child of [first, second]) {
    await expect(label(page, child)).toHaveAttribute('title', new RegExp(child.discovery!.nativeSessionId));
    await label(page, child).click();
    await expect(drawer(page).getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible();
    await expect(drawer(page)).toContainText(child.discovery!.nativeSessionId);
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
  }
  await expect(label(page, custom)).toHaveAttribute('aria-label', 'Inspect Owner chosen reviewer in workroom');
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('.agent-row')).toHaveCount(3);
  await expect(roster(page).getByRole('button', { name: 'Inspect Atlas', exact: true })).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Find a repository agent', exact: true }).fill('Finch');
  await expect(roster(page).locator('.agent-row')).toHaveCount(1);
  await expect(roster(page).getByRole('button', { name: 'Inspect Owner chosen reviewer', exact: true })).toBeVisible();
  expectReadOnly(result);
});
