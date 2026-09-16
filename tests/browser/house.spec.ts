import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Agent, Snapshot, TownState } from '@agent-town/contracts';
import { initialState } from '../../apps/service/src/demo';
import { OrthographicCamera, Vector3 } from 'three';
import { roomAgentAnchor } from '../../apps/web/src/world/room-layout';

// Synthetic, owner-scoped browser contracts. No hooks, private files or model calls.
function houseState(): TownState {
  const state = initialState();
  state.workspace = { id: 'house-fixture', name: 'House interaction fixture', mode: 'private' };
  state.simulation.running = false;
  state.repositories = state.repositories.map(repo => ({ ...repo, source: 'local' }));
  state.agents = [];
  state.handoffs = [];
  state.activity = [];
  state.manager = { version: 0, brief: 'Fixture manager disabled.', updatedAt: null };
  return state;
}

function resident(id: string, repoId = 'web', activity: Agent['activity'] = 'working'): Agent {
  const time = new Date().toISOString();
  return { id, name: `Resident ${id}`, repoId, activity, provider: 'Claude', role: 'Observed session', task: `Reported task ${id}`, color: '#608d84', home: [-5.4, -0.5], updatedAt: time, files: [], evidence: 'Verification unavailable.', contextVersion: null,
    observation: { connectionId: `source-${repoId}`, sessionId: `session-${id}`, parentSessionId: null, lastSequence: 1, sourceTime: time, freshness: 'current', billing: 'unavailable' } };
}

async function fixture(page: Page, state: TownState) {
  const snapshot: Snapshot = { cursor: 1, state };
  const mutations: string[] = [], remote: string[] = [], errors: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(`${request.method()} ${path}`);
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') remote.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    class HouseEventSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private closed = false;
      private readonly listener: EventListener;
      constructor(readonly url: string) {
        super();
        this.listener = event => {
          const current = (event as CustomEvent).detail;
          if (!this.closed && url.includes(`/workspaces/${current.state.workspace.id}/`)) this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(current) }));
        };
        window.addEventListener('house-fixture-state', this.listener);
        setTimeout(() => { if (!this.closed) this.onopen?.(new Event('open')); }, 0);
      }
      close() { this.closed = true; window.removeEventListener('house-fixture-state', this.listener); }
    }
    window.EventSource = HouseEventSource as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(), session = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...session, mode: 'private', user: { id: 'house-owner', login: 'house-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: state.workspace.id, name: state.workspace.name, kind: 'personal' }] } });
  });
  await page.route('**/api/v1/workspaces/house-fixture/**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/snapshot')) await route.fulfill({ json: snapshot });
    else if (/\/agents\/[^/]+\/reports$/.test(new URL(route.request().url()).pathname) && route.request().method() === 'GET') await route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } });
    else await route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  // Account for the exact startup request; record every mutation after this ready boundary.
  expect(mutations).toEqual(['POST /api/v1/session']);
  mutations.length = 0;
  return { snapshot, mutations, remote, errors,
    publish: async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('house-fixture-state', { detail: current })), snapshot); } };
}

const room = (page: Page) => page.getByTestId('room-context');
const roster = (page: Page) => page.getByTestId('repository-agents');
const actor = (page: Page, agent: Agent) => page.getByRole('button', { name: `Inspect ${agent.name} in workroom`, exact: true });
async function settle(page: Page) { await expect(page.locator('canvas')).not.toHaveAttribute('data-camera-mode', 'transition'); }
async function expectSeparateDeskTargets(page: Page, residents: Agent[]) {
  const bounds = await Promise.all(residents.map(async agent => {
    const target = actor(page, agent), box = await target.boundingBox();
    expect(box, `${agent.name} has a visible desk target`).not.toBeNull();
    expect(box!.width, `${agent.name} target width`).toBeGreaterThanOrEqual(24);
    expect(box!.height, `${agent.name} target height`).toBeGreaterThanOrEqual(24);
    if (page.viewportSize()!.width < 900) await expect(target.locator('.room-desk-number')).toHaveText(String(residents.indexOf(agent) + 1));
    return box!;
  }));
  for (let first = 0; first < bounds.length; first++) for (let second = first + 1; second < bounds.length; second++) {
    const a = bounds[first]!, b = bounds[second]!;
    const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    expect(horizontal <= 0 || vertical <= 0, `${residents[first]!.name} and ${residents[second]!.name} targets must not overlap`).toBe(true);
  }
}
async function pose(page: Page) {
  return page.locator('canvas').evaluate(canvas => ({ position: JSON.parse(canvas.getAttribute('data-camera-position') ?? '[]') as number[], target: JSON.parse(canvas.getAttribute('data-camera-target') ?? '[]') as number[], zoom: Number(canvas.getAttribute('data-camera-zoom')) }));
}
function closePose(actual: Awaited<ReturnType<typeof pose>>, expected: Awaited<ReturnType<typeof pose>>) {
  expect(actual.zoom).toBeCloseTo(expected.zoom, 2);
  expect(actual.position).toHaveLength(3); expect(actual.target).toHaveLength(3);
  for (let index = 0; index < 3; index++) {
    expect(actual.position[index]).toBeCloseTo(expected.position[index]!, 2);
    expect(actual.target[index]).toBeCloseTo(expected.target[index]!, 2);
  }
}

function discoveredHouseState() {
  const state = houseState();
  const repo = state.repositories.find(item => item.id === 'web')!;
  state.repositories = [repo];
  state.agents = Array.from({ length: 18 }, (_, index) => {
    const agent = resident(`discovered-${String(index).padStart(2, '0')}`, repo.id, 'unknown');
    delete agent.observation;
    agent.provider = 'Codex'; agent.name = 'Codex · 0199beef'; agent.role = 'Discovered session';
    agent.discovery = { sourceId: 'fixture-native-source', nativeSessionId: `0199beef-0000-4000-8000-${String(index).padStart(12, '0')}`, discoveredAt: agent.updatedAt, nativeUpdatedAt: agent.updatedAt };
    return agent;
  });
  return { state, repo };
}

test('eighteen discovered sessions open details by clicking their painted characters on every desk page', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('agent-town-reduced-motion', 'true'));
  const { state, repo } = discoveredHouseState();
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click();
  await settle(page);
  const errors: { page: number; slot: number; agent: string; x: number; y: number; selected: string | null }[] = [];
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
    if (pageIndex) await page.getByRole('button', { name: 'Next desks', exact: true }).click();
    for (let slot = 0; slot < 6; slot++) {
      const agent = state.agents[pageIndex * 6 + slot]!;
      const anchor = roomAgentAnchor(repo, slot)!;
      const cameraPose = await pose(page), box = (await page.locator('canvas').boundingBox())!;
      const camera = new OrthographicCamera(-box.width / 2, box.width / 2, box.height / 2, -box.height / 2, 0.1, 200);
      camera.position.fromArray(cameraPose.position); camera.zoom = cameraPose.zoom; camera.lookAt(new Vector3().fromArray(cameraPose.target)); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
      // Sprite center, below its HTML name label. This is actual pointer input
      // at the visible character, not a programmatic callback or label click.
      const point = new Vector3(anchor[0], anchor[1] + 0.68, anchor[2]).project(camera);
      const x = box.x + (point.x + 1) * box.width / 2, y = box.y + (1 - point.y) * box.height / 2;
      await page.mouse.click(x, y);
      const drawer = page.getByTestId('right-drawer');
      const selected = await drawer.count() ? await drawer.innerText() : null;
      if (!selected?.includes(agent.discovery!.nativeSessionId)) errors.push({ page: pageIndex + 1, slot: slot + 1, agent: agent.id, x, y, selected });
      if (await drawer.count()) await page.getByRole('button', { name: 'Close details', exact: true }).click();
    }
  }
  await page.screenshot({ path: testInfo.outputPath('discovered-character-clicks.png') });
  expect(errors).toEqual([]);
  expect(evidence.mutations).toEqual([]); expect(evidence.remote).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('discovered sessions with shared name prefixes remain selectable from labels, keyboard and the full roster', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => localStorage.setItem('agent-town-reduced-motion', 'true'));
  const { state } = discoveredHouseState();
  const evidence = await fixture(page, state);
  const canvas = await page.locator('canvas').elementHandle();
  await page.getByRole('button', { name: 'Web studio', exact: true }).click();
  await settle(page);
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
    if (pageIndex) await page.getByRole('button', { name: 'Next desks', exact: true }).click();
    for (const agent of state.agents.slice(pageIndex * 6, pageIndex * 6 + 6)) {
      const label = page.locator(`.world-canvas .agent-label[data-agent-id="${agent.id}"]`);
      await expect(label).toHaveAttribute('aria-label', `Inspect Codex · …${agent.discovery!.nativeSessionId.slice(-8)} in workroom`);
      await expect(label).toHaveAttribute('title', new RegExp(agent.discovery!.nativeSessionId));
      if (agent === state.agents.at(-1)) { await label.focus(); await page.keyboard.press('Enter'); }
      else await label.click();
      await expect(page.getByTestId('right-drawer')).toContainText(agent.discovery!.nativeSessionId);
      await expect(page.getByTestId('right-drawer')).toContainText('Discovered · activity unknown');
      await page.getByRole('button', { name: 'Close details', exact: true }).click();
    }
  }
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('.agent-row')).toHaveCount(18);
  await roster(page).locator(`[data-agent-id="${state.agents[0]!.id}"]`).click();
  await expect(page.getByTestId('right-drawer')).toContainText(state.agents[0]!.discovery!.nativeSessionId);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await expect(roster(page).locator('.agent-row')).toHaveCount(18);
  await roster(page).locator(`[data-agent-id="${state.agents.at(-1)!.id}"]`).click();
  await expect(page.getByTestId('right-drawer')).toContainText(state.agents.at(-1)!.discovery!.nativeSessionId);
  expect(await page.locator('canvas').evaluate((node, old) => node === old, canvas)).toBe(true);
  expect(evidence.mutations).toEqual([]); expect(evidence.remote).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('house entry reveals its agents, preserves the canvas and returns the town pose without mutations', async ({ page }, testInfo) => {
  const state = houseState(), worker = resident('one');
  state.agents = [worker, resident('neighbor', 'api')];
  const evidence = await fixture(page, state);
  const canvas = page.locator('canvas'); await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-camera-mode', 'manual');
  if (testInfo.project.name === 'desktop') {
    const initialZoom = (await pose(page)).zoom;
    await page.mouse.move(1080, 480);
    await page.keyboard.down('Control');
    try { await page.mouse.wheel(0, -5); } finally { await page.keyboard.up('Control'); }
    await expect.poll(async () => (await pose(page)).zoom).toBeGreaterThan(initialZoom);
  }
  const element = await canvas.elementHandle(), bounds = await canvas.boundingBox(), town = await pose(page);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click();
  await expect(room(page)).toHaveAttribute('data-repo-id', 'web');
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  await settle(page); await expect(actor(page, worker)).toBeVisible();
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-visible-actor-count', '2');
  await expect(page.getByRole('button', { name: 'Web studio', exact: true })).toHaveAttribute('data-room-open', 'true');
  const focused = await pose(page); expect(focused.zoom).toBeGreaterThan(town.zoom);
  await expect(room(page).getByRole('heading', { name: 'Web studio', exact: true }).getByRole('button', { name: 'Web studio', exact: true })).toBeVisible();
  await expect(page.locator('.world-label[data-room-open="true"]')).toHaveCount(0);
  const residentLabel = await actor(page, worker).boundingBox();
  expect(residentLabel).not.toBeNull();
  const roomStrip = await room(page).boundingBox(); expect(roomStrip).not.toBeNull();
  for (const label of [residentLabel!]) {
    const horizontal = Math.min(label.x + label.width, roomStrip!.x + roomStrip!.width) - Math.max(label.x, roomStrip!.x);
    const vertical = Math.min(label.y + label.height, roomStrip!.y + roomStrip!.height) - Math.max(label.y, roomStrip!.y);
    expect(horizontal <= 0 || vertical <= 0, 'Scene labels must remain clear of the room controls').toBe(true);
  }
  expect(await canvas.boundingBox()).toEqual(bounds);
  expect(await canvas.evaluate((node, old) => node === old, element)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('house-workroom.png') });
  await actor(page, worker).click();
  await expect(page.getByTestId('right-drawer')).toContainText(worker.task);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(room(page)).toHaveAttribute('data-repo-id', 'web');
  closePose(await pose(page), focused);
  await page.getByRole('button', { name: 'Back to town', exact: true }).click();
  await expect(room(page)).toHaveCount(0); await settle(page); closePose(await pose(page), town);
  await expect(page.getByRole('button', { name: 'Web studio', exact: true })).toHaveAttribute('data-room-open', 'false');
  expect(evidence.mutations).toEqual([]); expect(evidence.remote).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('crowded houses keep six stable desks and every exact repository resident remains reachable', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('agent-town-opaque-panels', 'true'));
  const state = houseState(), residents = Array.from({ length: 7 }, (_, i) => resident(`desk-${i + 1}`));
  const away = resident('away', 'web', 'reporting'), ended = resident('ended', 'web', 'offline');
  const other = { ...resident('other', 'api'), name: residents[0]!.name, observation: { ...resident('other', 'api').observation!, parentSessionId: residents[0]!.observation!.sessionId } };
  state.agents = [...residents, away, ended, other];
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click(); await settle(page);
  const desks = page.getByRole('button', { name: /^Inspect .+ in workroom$/ });
  await expect(desks).toHaveCount(6);
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-visible-actor-count', '9');
  await expectSeparateDeskTargets(page, residents.slice(0, 6));
  await page.screenshot({ path: testInfo.outputPath('six-resident-workroom.png') });
  const scan = async (selector: string) => {
    const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([]);
  };
  await scan('[data-testid="room-context"]');
  for (const agent of residents.slice(0, 6)) {
    await actor(page, agent).click();
    await expect(page.getByTestId('right-drawer')).toContainText(agent.task);
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
  }
  const labels = () => desks.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  const firstPage = await labels();
  residents[2]!.activity = 'waiting'; await evidence.publish();
  await expect(desks).toHaveCount(6); expect(await labels()).toEqual(firstPage);
  await page.getByRole('button', { name: 'Next desks', exact: true }).click();
  await expect(desks).toHaveCount(1); await expect(actor(page, residents[6]!)).toBeVisible();
  await page.getByRole('button', { name: 'Previous desks', exact: true }).click();
  await expect(desks).toHaveCount(6);
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('[data-agent-id]')).toHaveCount(9);
  await scan('[data-testid="repository-agents"]');
  await expect(roster(page).locator('[data-agent-id="other"]')).toHaveCount(0);
  await expect(roster(page).locator('[data-agent-id="away"]')).toContainText(/report/i);
  await expect(roster(page).locator('[data-agent-id="ended"]')).toContainText(/ended/i);
  await roster(page).getByRole('button', { name: `Inspect ${residents[6]!.name}`, exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText(residents[6]!.task);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  residents[6]!.activity = 'reporting';
  state.handoffs.push({ id: 'desk-report', agentId: residents[6]!.id, repoId: 'web', summary: 'Fixture response saved for review.', createdAt: new Date().toISOString(), status: 'saved', contextVersion: null, delivery: 'unsupported' });
  await evidence.publish();
  await expect(actor(page, residents[6]!)).toHaveCount(0);
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-visible-actor-count', '10');
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('[data-agent-id="desk-7"]')).toContainText('Report saved');
  expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('rapid house switches and reset cancel obsolete camera requests', async ({ page }) => {
  const state = houseState(); state.agents = [resident('web'), resident('api', 'api')];
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).dispatchEvent('click');
  await page.getByRole('button', { name: 'Backend lab', exact: true }).dispatchEvent('click');
  await page.getByRole('button', { name: 'Web studio', exact: true }).dispatchEvent('click');
  await expect(room(page)).toHaveAttribute('data-repo-id', 'web'); await settle(page);
  const focused = await pose(page);
  await page.getByRole('button', { name: 'Web studio', exact: true }).dispatchEvent('click');
  await settle(page); closePose(await pose(page), focused);
  await page.getByRole('button', { name: 'Backend lab', exact: true }).dispatchEvent('click');
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await expect(room(page)).toHaveCount(0); await settle(page);
  expect((await pose(page)).target).toEqual([0, 0, 0]);
  expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('reduced motion, stale reports and reconnection retain truthful repository context', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = houseState(), current = resident('current'), stale = resident('stale');
  stale.observation!.freshness = 'stale'; stale.observation!.sourceTime = new Date(Date.now() - 180000).toISOString();
  state.agents = [current, stale];
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(room(page)).toHaveAttribute('data-repo-id', 'web');
  await expect(page.locator('canvas')).toHaveAttribute('data-camera-mode', 'manual');
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('[data-agent-id="stale"]')).toContainText(/stale|last reported/i);
  await expect(roster(page).locator('[data-agent-id="current"]')).not.toContainText(/stale/i);
  // Playwright route fulfillment can still reply while its browser is offline.
  // Make the local snapshot unavailable too: the internet hint alone must not
  // defeat a reachable loopback service, and this fixture's SSE is simulated.
  let snapshotUnavailable = true;
  await page.route('**/api/v1/workspaces/house-fixture/snapshot', route => route.fulfill(snapshotUnavailable
    ? { status: 503, json: { message: 'Synthetic local snapshot transport interruption.' } }
    : { json: evidence.snapshot }));
  await context.setOffline(true);
  await expect(page.getByText('Reconnecting · showing last saved state', { exact: true })).toBeVisible();
  await expect(roster(page)).toContainText('Reconnecting · showing last reported activity.');
  await expect(room(page)).toHaveAttribute('data-repo-id', 'web');
  // Each network hint checks only the local session. Check it explicitly,
  // retaining the no-unexpected-mutations assertion for all other actions.
  await expect.poll(() => evidence.mutations).toEqual(['POST /api/v1/session']);
  evidence.mutations.length = 0;
  current.activity = 'reporting'; state.handoffs.push({ id: 'fixture-report', agentId: current.id, repoId: 'web', summary: 'Fixture report saved.', createdAt: new Date().toISOString(), status: 'saved', contextVersion: null, delivery: 'unsupported' });
  snapshotUnavailable = false;
  await context.setOffline(false);
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  // Online recovery re-establishes the local session; it must start no other work.
  await expect.poll(() => evidence.mutations).toEqual(['POST /api/v1/session']);
  evidence.mutations.length = 0;
  await expect(roster(page).locator('[data-agent-id="current"]')).toContainText(/report/i);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  // The original house label unmounts on entry. Returning from another repository
  // must find its replacement, rather than focus the last visited house.
  await page.getByRole('button', { name: 'Backend lab', exact: true }).dispatchEvent('click');
  await expect(room(page)).toHaveAttribute('data-repo-id', 'api');
  await page.keyboard.press('Escape');
  await expect(room(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Web studio', exact: true })).toBeFocused();
  expect(state.handoffs[0]!.status).toBe('saved'); expect(state.manager.version).toBe(0);
  expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('following leaves desk presentation and can return to the repository', async ({ page }) => {
  const state = houseState(), worker = resident('follow'); state.agents = [worker];
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click(); await settle(page);
  await actor(page, worker).click();
  await page.getByRole('button', { name: 'Follow this agent', exact: true }).click();
  await expect(page.locator('canvas')).toHaveAttribute('data-camera-mode', 'follow');
  await expect.poll(async () => (await pose(page)).target.map(value => Number(value.toFixed(2)))).toEqual([worker.home[0], 0.05, worker.home[1]]);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(actor(page, worker)).toHaveCount(0);
  const repositoryTitle = room(page).getByRole('heading', { name: 'Web studio', exact: true }).getByRole('button', { name: 'Web studio', exact: true });
  await expect(repositoryTitle).toHaveAttribute('aria-expanded', 'false');
  await expect(repositoryTitle).toHaveAttribute('data-room-open', 'false');
  await page.getByRole('button', { name: 'Back to repository', exact: true }).click();
  await settle(page); await expect(actor(page, worker)).toBeVisible();
  await expect(page.locator('canvas')).toHaveAttribute('data-camera-mode', 'manual');
  await expect(repositoryTitle).toHaveAttribute('aria-expanded', 'true');
  await expect(repositoryTitle).toHaveAttribute('data-room-open', 'true');
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await expect(roster(page)).toHaveAttribute('data-repo-id', 'web');
  const listHeading = room(page).getByRole('heading', { name: 'Web studio', exact: true });
  await expect(listHeading).toBeVisible();
  await expect(listHeading.getByRole('button')).toHaveCount(0);
  await roster(page).getByRole('button', { name: 'Inspect Resident follow', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText(worker.task);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Back to town', exact: true }).click();
  await expect(room(page)).toHaveCount(0);
  const fallbackFocus = page.locator('button:focus');
  await expect(fallbackFocus).toHaveAttribute('aria-label', /^(Open repositories|Show world)$/);
  await expect(fallbackFocus).toBeEnabled();
  await expect(fallbackFocus).toBeInViewport({ ratio: 1 });
  expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('empty or removed repositories recover without invented agents', async ({ page }) => {
  const state = houseState(), evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Tools shed', exact: true }).click(); await settle(page);
  await expect(room(page)).toHaveAttribute('data-repo-id', 'tools');
  await expect(page.getByRole('button', { name: /^Inspect .+ in workroom$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page)).toContainText(/no.*sessions/i);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  state.repositories = state.repositories.filter(repo => repo.id !== 'tools'); await evidence.publish();
  await expect(room(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Tools shed', exact: true })).toHaveCount(0);
  await settle(page); expect((await pose(page)).target).toEqual([0, 0, 0]);
  expect(state.agents).toEqual([]); expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('shrinking and restoring a crowded repository preserves the reachable desk page', async ({ page }) => {
  const state = houseState(), residents = Array.from({ length: 13 }, (_, index) => resident(`page-${String(index + 1).padStart(2, '0')}`));
  state.agents = [...residents];
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click(); await settle(page);
  await page.getByRole('button', { name: 'Next desks', exact: true }).click();
  await page.getByRole('button', { name: 'Next desks', exact: true }).click();
  await expect(room(page)).toContainText('Page 3 of 3 · 1 shown · 13 desk residents');
  state.agents = residents.slice(0, 7); await evidence.publish();
  await expect(room(page)).toContainText('Page 2 of 2 · 1 shown · 7 desk residents');
  state.agents = [...residents]; await evidence.publish();
  await expect(room(page)).toContainText('Page 2 of 3 · 6 shown · 13 desk residents');
  await expect(page.getByRole('button', { name: /^Inspect .+ in workroom$/ })).toHaveCount(6);
  expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('WebGL loss inside a room preserves the equivalent repository roster and details', async ({ page }) => {
  const state = houseState(), worker = resident('fallback'); state.agents = [worker, resident('neighbor', 'api')];
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click(); await settle(page);
  const canLoseContext = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    extension.loseContext(); return true;
  });
  expect(canLoseContext).toBe(true);
  await expect(page.getByRole('button', { name: '3D world unavailable; List view active', exact: true })).toBeDisabled();
  await expect(roster(page)).toHaveAttribute('data-repo-id', 'web');
  await expect(roster(page).locator('[data-agent-id]')).toHaveCount(1);
  await roster(page).getByRole('button', { name: `Inspect ${worker.name}`, exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText(worker.task);
  await expect(page.getByRole('button', { name: 'Follow this agent', exact: true })).toBeDisabled();
  expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('a short landscape viewport keeps room controls and scoped inspection reachable', async ({ page }, testInfo) => {
  const state = houseState(); state.agents = Array.from({ length: 6 }, (_, index) => resident(`landscape-${index + 1}`));
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click(); await settle(page);
  await page.setViewportSize({ width: 844, height: 390 }); await settle(page);
  await expect(room(page)).toHaveAttribute('data-repo-id', 'web');
  await expectSeparateDeskTargets(page, state.agents);
  await page.screenshot({ path: testInfo.outputPath('landscape-workroom.png') });
  const contextBounds = await room(page).boundingBox(); expect(contextBounds).not.toBeNull();
  for (const agent of state.agents) {
    const labelBounds = await actor(page, agent).boundingBox(); expect(labelBounds).not.toBeNull();
    const center = { x: labelBounds!.x + labelBounds!.width / 2, y: labelBounds!.y + labelBounds!.height / 2 };
    expect(center.x, `${agent.name} is within the viewport`).toBeGreaterThanOrEqual(0);
    expect(center.x).toBeLessThanOrEqual(844); expect(center.y).toBeGreaterThanOrEqual(0); expect(center.y).toBeLessThanOrEqual(390);
    const covered = center.x >= contextBounds!.x && center.x <= contextBounds!.x + contextBounds!.width && center.y >= contextBounds!.y && center.y <= contextBounds!.y + contextBounds!.height;
    expect(covered, `${agent.name} must not be covered by the room card`).toBe(false);
  }
  for (const agent of state.agents) {
    await actor(page, agent).click();
    await expect(page.getByTestId('right-drawer')).toContainText(agent.task);
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await roster(page).getByRole('button', { name: 'Inspect Resident landscape-6', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('Reported task landscape-6');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Back to town', exact: true }).click();
  await expect(room(page)).toHaveCount(0);
  expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});


test('reporting frees its desk without shifting other residents or closing an inspected second-page session', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = houseState(), residents = 'abcdefg'.split('').map(id => resident(`stable-${id}`, 'web', 'idle'));
  state.agents = [...residents];
  const evidence = await fixture(page, state);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click(); await settle(page);
  const firstDesk = await actor(page, residents[0]!).boundingBox();
  const positions = await Promise.all([residents[1]!, residents[5]!].map(agent => actor(page, agent).boundingBox()));
  expect(firstDesk).not.toBeNull(); positions.forEach(position => expect(position).not.toBeNull());
  await page.getByRole('button', { name: 'Next desks', exact: true }).click();
  await actor(page, residents[6]!).click();
  residents[0]!.activity = 'reporting';
  state.handoffs.push({ id: 'stable-report', agentId: residents[0]!.id, repoId: 'web', summary: 'A saved report leaves a desk vacancy.', createdAt: new Date().toISOString(), status: 'saved', contextVersion: null, delivery: 'unsupported' });
  await evidence.publish();
  await expect(page.getByTestId('right-drawer')).toContainText(residents[6]!.task);
  await expect(room(page)).toContainText('Page 2 of 2 · 1 shown · 6 desk residents');
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-visible-desk-agents', JSON.stringify([residents[6]!.id]));
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(actor(page, residents[6]!)).toBeVisible();
  await page.getByRole('button', { name: 'Previous desks', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Inspect .+ in workroom$/ })).toHaveCount(5);
  for (const [index, agent] of [residents[1]!, residents[5]!].entries()) {
    const next = await actor(page, agent).boundingBox(); expect(next).not.toBeNull();
    expect(next!.x).toBeCloseTo(positions[index]!.x, 1); expect(next!.y).toBeCloseTo(positions[index]!.y, 1);
  }
  const joined = resident('stable-h', 'web', 'idle'); state.agents.push(joined); await evidence.publish();
  await expect(actor(page, joined)).toBeVisible();
  const filled = await actor(page, joined).boundingBox(); expect(filled).not.toBeNull();
  expect(filled!.x + filled!.width / 2).toBeCloseTo(firstDesk!.x + firstDesk!.width / 2, 1);
  expect(filled!.y).toBeCloseTo(firstDesk!.y, 1);
  await page.getByRole('button', { name: 'Next desks', exact: true }).click();
  await expect(actor(page, residents[6]!)).toBeVisible();
  // This fixture publishes the outcome of a separately reviewed archive; navigation makes no archive request.
  state.agents = state.agents.filter(agent => agent.id !== residents[6]!.id);
  state.history = { archivedAgents: 1, updatedAt: new Date().toISOString() };
  await evidence.publish();
  await expect(room(page)).toContainText('Page 1 of 1 · 6 shown · 6 desk residents');
  await expect(page.getByRole('button', { name: /^Inspect .+ in workroom$/ })).toHaveCount(6);
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  await expect(roster(page).locator('[data-agent-id="stable-a"]')).toContainText(/report/i);
  expect(state.handoffs[0]!.status).toBe('saved'); expect(state.manager.version).toBe(0);
  expect(evidence.mutations).toEqual([]); expect(evidence.remote).toEqual([]); expect(evidence.errors).toEqual([]);
});
