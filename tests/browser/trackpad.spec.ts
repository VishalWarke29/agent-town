import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '@agent-town/contracts';
import { initialState } from '../../apps/service/src/demo';

// Wheel events carry deltas/modifiers, not a trustworthy physical-device identity.
// These fixtures exercise the browser contract without account or provider calls.
async function fixture(page: Page, crowded = false) {
  const state = initialState();
  state.workspace = { id: 'trackpad-fixture', name: 'Trackpad interaction fixture', mode: 'private' };
  state.simulation.running = false;
  state.repositories = state.repositories.map(repo => ({ ...repo, source: 'local' }));
  state.agents = crowded ? Array.from({ length: 20 }, (_, index) => ({ ...state.agents[0]!, id: `scroll-resident-${index}`, name: `Scroll resident ${index + 1}` })) : [];
  state.handoffs = []; state.activity = [];
  state.manager = { version: 0, brief: 'Fixture manager disabled.', updatedAt: null };
  const snapshot: Snapshot = { cursor: 1, state };
  const mutations: string[] = [], remote: string[] = [], errors: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(`${request.method()} ${url.pathname}`);
    if (/^https?:/.test(request.url()) && url.hostname !== '127.0.0.1') remote.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    class StaticEventSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private closed = false;
      constructor(readonly url: string) {
        super();
        setTimeout(() => { if (!this.closed) this.onopen?.(new Event('open')); }, 0);
      }
      close() { this.closed = true; }
    }
    window.EventSource = StaticEventSource as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/session', async route => {
    const upstream = await route.fetch(), session = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...session, mode: 'private', user: { id: 'trackpad-owner', login: 'trackpad-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: state.workspace.id, name: state.workspace.name, kind: 'personal' }] } });
  });
  await page.route('**/api/v1/workspaces/trackpad-fixture/**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/snapshot')) await route.fulfill({ json: snapshot });
    else await route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toHaveAttribute('data-camera-mode', 'manual');
  expect(mutations).toEqual(['POST /api/v1/session']);
  mutations.length = 0;
  return () => { expect(mutations).toEqual([]); expect(remote).toEqual([]); expect(errors).toEqual([]); };
}

async function pose(page: Page) {
  return page.locator('canvas').evaluate(canvas => ({
    position: JSON.parse(canvas.getAttribute('data-camera-position') ?? '[]') as number[],
    target: JSON.parse(canvas.getAttribute('data-camera-target') ?? '[]') as number[],
    zoom: Number(canvas.getAttribute('data-camera-zoom')),
  }));
}
type Pose = Awaited<ReturnType<typeof pose>>;
const difference = (a: number[], b: number[]) => a.map((value, index) => value - b[index]!);
const distance = (a: number[], b: number[]) => Math.hypot(...difference(a, b));
function sameVector(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(3); expect(expected).toHaveLength(3);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 4));
}
function samePose(actual: Pose, expected: Pose) {
  sameVector(actual.position, expected.position); sameVector(actual.target, expected.target);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 4);
}
function onlyPan(actual: Pose, previous: Pose) {
  expect(actual.zoom).toBeCloseTo(previous.zoom, 4);
  expect(distance(actual.target, previous.target)).toBeGreaterThan(0.01);
  sameVector(difference(actual.position, actual.target), difference(previous.position, previous.target));
}
async function overGround(page: Page) {
  const point = await page.locator('canvas').evaluate(canvas => {
    const box = canvas.getBoundingClientRect();
    for (const y of [0.6, 0.45, 0.75, 0.3]) for (const x of [0.8, 0.65, 0.45, 0.3]) {
      const point = { x: box.x + box.width * x, y: box.y + box.height * y };
      if (document.elementFromPoint(point.x, point.y) === canvas) return point;
    }
    return null;
  });
  expect(point, 'An unobscured point on the world canvas is available').not.toBeNull();
  await page.mouse.move(point!.x, point!.y);
}
async function settle(page: Page) { await expect(page.locator('canvas')).toHaveAttribute('data-camera-mode', 'manual'); }
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    let count = 0;
    const next = () => { if (++count === 4) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }));
}

test('two-axis wheel scrolling pans ground and scene labels while house return and reset preserve their poses', async ({ page }) => {
  const clean = await fixture(page), overview = await pose(page);
  await overGround(page); await page.mouse.wheel(32, 0);
  await expect.poll(async () => distance((await pose(page)).target, overview.target)).toBeGreaterThan(0.01);
  const horizontal = await pose(page); onlyPan(horizontal, overview);
  await overGround(page); await page.mouse.wheel(0, 28);
  await expect.poll(async () => distance((await pose(page)).target, horizontal.target)).toBeGreaterThan(0.01);
  const vertical = await pose(page); onlyPan(vertical, horizontal);
  const horizontalDelta = difference(horizontal.target, overview.target), verticalDelta = difference(vertical.target, horizontal.target);
  const alignment = Math.abs(horizontalDelta.reduce((sum, value, index) => sum + value * verticalDelta[index]!, 0)) / Math.hypot(...horizontalDelta) / Math.hypot(...verticalDelta);
  expect(alignment, 'Horizontal and vertical scroll must move along distinct camera axes').toBeLessThan(0.1);
  const label = page.getByRole('button', { name: 'Web studio', exact: true });
  await label.hover(); await page.mouse.wheel(24, 0);
  await expect.poll(async () => distance((await pose(page)).target, vertical.target)).toBeGreaterThan(0.01);
  const town = await pose(page); onlyPan(town, vertical);
  await label.click(); await expect(page.getByTestId('room-context')).toHaveAttribute('data-repo-id', 'web'); await settle(page);
  await page.getByRole('button', { name: 'Back to town', exact: true }).click();
  await expect(page.getByTestId('room-context')).toHaveCount(0); await settle(page); samePose(await pose(page), town);
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click(); await settle(page); samePose(await pose(page), overview);
  clean();
});

test('Ctrl wheel pinch zooms in and out without panning the camera or scrolling the page', async ({ page }) => {
  const clean = await fixture(page), before = await pose(page);
  const pinch = (deltaY: number) => page.locator('canvas').evaluate((canvas, delta) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaX: 12, deltaY: delta, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  }, deltaY);
  expect(await pinch(-80)).toBe(true);
  await expect.poll(async () => (await pose(page)).zoom).toBeGreaterThan(before.zoom);
  const nearer = await pose(page); sameVector(nearer.position, before.position); sameVector(nearer.target, before.target);
  expect(await pinch(80)).toBe(true);
  await expect.poll(async () => (await pose(page)).zoom).toBeLessThan(nearer.zoom);
  const farther = await pose(page); sameVector(farther.position, before.position); sameVector(farther.target, before.target);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
  clean();
});

test('two-finger scrolling stays inside the glass drawer and never moves the world at its scroll boundary', async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 600 });
  const clean = await fixture(page, true), before = await pose(page);
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  const content = page.getByTestId('left-drawer').locator('.drawer-content');
  await expect(content).toBeVisible();
  expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300);
  await content.hover(); await page.mouse.wheel(0, 240);
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await frames(page); samePose(await pose(page), before);
  await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.mouse.wheel(0, 180); await frames(page);
  expect(await content.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  samePose(await pose(page), before);
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(page.getByTestId('left-drawer')).toHaveCount(0); samePose(await pose(page), before);
  clean();
});
