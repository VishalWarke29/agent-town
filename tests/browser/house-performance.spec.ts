import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { allocateAgentHome, type Snapshot } from '@agent-town/contracts';
import { initialState } from '../../apps/service/src/demo';

function buildManifest() {
  const configured = process.env.AGENT_TOWN_VERIFICATION_ROOT;
  if (configured && !isAbsolute(configured)) throw new Error('AGENT_TOWN_VERIFICATION_ROOT must name an absolute verification directory.');
  const directory = resolve(configured ?? '.', 'apps/web/dist');
  const files = ['index.html', ...readdirSync(resolve(directory, 'assets')).filter(file => /\.(js|css)$/.test(file)).sort().map(file => `assets/${file}`)];
  const assets = files.map(file => {
    const bytes = readFileSync(resolve(directory, file));
    return { file, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { directory, assets };
}

function crowdedSnapshot(): Snapshot {
  const state = initialState(), palette = [...state.agents];
  state.workspace.name = '50-session workroom performance fixture';
  state.simulation.running = false;
  state.agents = [];
  state.handoffs = [];
  state.activity = [];
  for (let index = 0; index < 50; index++) {
    const id = `crowded-${String(index + 1).padStart(3, '0')}`;
    state.agents.push({ ...palette[index % palette.length]!, id, repoId: 'web', name: `Sample resident ${index + 1}`, task: `Sample assignment ${index + 1}`, activity: 'working', home: allocateAgentHome('web', state.repositories, state.agents) });
  }
  return { cursor: 1, state };
}

async function loadFixture(page: Page, snapshot: Snapshot) {
  const remote: string[] = [], mutations: string[] = [], errors: string[] = [];
  page.on('request', request => {
    if (!/^https?:/.test(request.url())) return;
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') remote.push(request.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(`${request.method()} ${url.pathname}`);
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    // Deliver synthetic committed-state-shaped messages without a real connector,
    // service mutation, paid request, or a periodically reconnecting mock stream.
    class FixtureEventSource extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private closed = false;
      private readonly listener: EventListener;
      constructor(readonly url: string) {
        super();
        this.listener = event => {
          const snapshot = (event as CustomEvent).detail;
          if (!this.closed && url.includes(`/workspaces/${snapshot.state.workspace.id}/`)) this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) }));
        };
        window.addEventListener('house-performance-state', this.listener);
        setTimeout(() => { if (!this.closed) this.onopen?.(new Event('open')); }, 0);
      }
      close() { this.closed = true; window.removeEventListener('house-performance-state', this.listener); }
    }
    window.EventSource = FixtureEventSource as unknown as typeof EventSource;
    localStorage.setItem('agent-town-hint-dismissed', 'true');
  });
  await page.route('**/api/v1/session', async route => {
    const response = await route.fetch(), session = await response.json();
    // Explicit sample mode also avoids account-setup polling contaminating timing.
    await route.fulfill({ response, json: { ...session, mode: 'demo', applicationMode: 'demo', user: null, workspaces: [] } });
  });
  await page.route('**/api/v1/workspaces/demo-town/snapshot', route => route.fulfill({ json: snapshot }));
  await page.goto('/?preview=1');
  await expect(page.getByText('Demo mode · local service connected', { exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  expect(mutations).toEqual(['POST /api/v1/session']);
  mutations.length = 0;
  return { remote, mutations, errors };
}

async function warmFrames(page: Page, durationMs: number) {
  await page.evaluate(duration => new Promise<void>(resolve => {
    const started = performance.now();
    const frame = () => performance.now() - started < duration ? requestAnimationFrame(frame) : resolve();
    requestAnimationFrame(frame);
  }), durationMs);
}

async function frameTiming(page: Page) {
  return page.evaluate(() => new Promise<{ samples: number; durationMs: number; meanMs: number; meanFps: number; p95Ms: number; maxMs: number }>(resolve => {
    const samples: number[] = [];
    let start = 0, previous = 0;
    const frame = (time: number) => {
      if (!start) start = time;
      if (previous) samples.push(time - previous);
      previous = time;
      if (time - start < 3000) requestAnimationFrame(frame);
      else {
        const sorted = [...samples].sort((a, b) => a - b), meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        resolve({ samples: samples.length, durationMs: time - start, meanMs, meanFps: 1000 / meanMs, p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!, maxMs: sorted.at(-1)! });
      }
    };
    requestAnimationFrame(frame);
  }));
}

async function syntheticUpdateTiming(page: Page, initial: Snapshot) {
  return page.evaluate(snapshot => new Promise<{ published: number; observed: number; latestObserved: number; targetRatePerSecond: number; actualRatePerSecond: number; meanMs: number; p95Ms: number; maxMs: number; coalescedUpdates: number }>(resolve => {
    const total = 60, intervalMs = 50, started = performance.now();
    const sentAt = new Map<number, number>(), seen = new Set<number>(), latency: number[] = [];
    let published = 0, latestObserved = 0, lastPublishedAt = started;
    const publish = () => {
      published++;
      const now = performance.now();
      sentAt.set(published, now); lastPublishedAt = now;
      snapshot.cursor++;
      snapshot.state.agents[0]!.task = `Synthetic update ${published}`;
      snapshot.state.agents[0]!.activity = published % 2 ? 'testing' : 'working';
      snapshot.state.agents[0]!.updatedAt = new Date().toISOString();
      window.dispatchEvent(new CustomEvent('house-performance-state', { detail: snapshot }));
      if (published < total) setTimeout(publish, Math.max(0, started + (published + 1) * intervalMs - performance.now()));
    };
    const inspect = () => {
      const task = document.querySelector('[data-testid="repository-agents"] [data-agent-id="crowded-001"] .resident-task')?.textContent ?? '';
      const match = /^Synthetic update (\d+)$/.exec(task);
      const sequence = match ? Number(match[1]) : 0;
      if (sequence && !seen.has(sequence) && sentAt.has(sequence)) {
        seen.add(sequence); latestObserved = sequence;
        latency.push(performance.now() - sentAt.get(sequence)!);
      }
      if (latestObserved < total && performance.now() - started < 6500) { requestAnimationFrame(inspect); return; }
      const sorted = [...latency].sort((a, b) => a - b);
      resolve({ published, observed: latency.length, latestObserved, targetRatePerSecond: 1000 / intervalMs, actualRatePerSecond: published / ((lastPublishedAt - started) / 1000), meanMs: latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : Number.POSITIVE_INFINITY, p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY, maxMs: sorted.at(-1) ?? Number.POSITIVE_INFINITY, coalescedUpdates: published - latency.length });
    };
    setTimeout(publish, intervalMs);
    requestAnimationFrame(inspect);
  }), initial);
}

async function saveEvidence(testInfo: TestInfo, prefix: string, evidence: unknown) {
  mkdirSync('docs/assets/benchmarks', { recursive: true });
  const path = `docs/assets/benchmarks/${prefix}-${testInfo.project.name}.json`;
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  await testInfo.attach(`${prefix}.json`, { path, contentType: 'application/json' });
}

test('a concentrated 50-agent workroom stays responsive and all residents remain reachable', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const uiBuild = buildManifest(), snapshot = crowdedSnapshot(), requests = await loadFixture(page, snapshot);
  await warmFrames(page, 2000);
  await page.getByRole('button', { name: 'Web studio', exact: true }).click();
  await expect(page.getByTestId('room-context')).toHaveAttribute('data-repo-id', 'web');
  await expect(page.locator('canvas')).not.toHaveAttribute('data-camera-mode', 'transition');
  await expect(page.getByRole('button', { name: /^Inspect Sample resident \d+ in workroom$/ })).toHaveCount(6);
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-visible-actor-count', '6');
  await warmFrames(page, 1200);
  const room = await frameTiming(page);
  await page.getByRole('button', { name: 'Agents in this repository', exact: true }).click();
  const roster = page.getByTestId('repository-agents');
  await expect(roster.locator('[data-agent-id]')).toHaveCount(50);
  await warmFrames(page, 750);
  const rosterOpen = await frameTiming(page);
  const updates = await syntheticUpdateTiming(page, snapshot);
  const evidence = {
    measuredAt: new Date().toISOString(), project: testInfo.project.name, uiBuild,
    browser: testInfo.project.use.channel ?? process.env.AGENT_TOWN_BROWSER ?? 'msedge', viewport: page.viewportSize(),
    fixture: '50 simulated agents linked to one repository; six displayed desks; all 50 in the scoped roster; no model calls',
    measurementScope: `Browser requestAnimationFrame callbacks in headless Chromium/Edge with software fallback enabled. Frontend synthetic EventSource dispatch to matching roster DOM observed at the next RAF. UI artifacts: ${uiBuild.directory}. This excludes service receipt/commit/network latency and does not certify GPU frame presentation or target hardware.`,
    targetMeanFps: 30, targetFrontendLatencyP95Ms: 1000, warmupMs: { overview: 2000, room: 1200, roster: 750 }, room, rosterOpen, updates,
    measurementGatesPassed: room.samples > 30 && rosterOpen.samples > 30 && room.meanMs <= 1000 / 30 && rosterOpen.meanMs <= 1000 / 30 && updates.p95Ms < 1000 && updates.published === 60 && updates.latestObserved === 60 && updates.actualRatePerSecond >= 18 && updates.observed >= 30,
    limitations: ['No native connector or paid worker was launched.', 'No renderer frame counter, GPU memory bound or real-device certification is inferred.', 'Coalesced intermediate snapshots are reported; the latest authoritative snapshot must render.'],
  };
  await saveEvidence(testInfo, 'house-50-agents', evidence);
  await roster.getByRole('textbox', { name: 'Find a repository agent', exact: true }).fill('Sample resident 50');
  await expect(roster.locator('[data-agent-id]')).toHaveCount(1);
  await roster.getByRole('button', { name: 'Inspect Sample resident 50', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('Sample assignment 50');
  expect(room.samples).toBeGreaterThan(30); expect(rosterOpen.samples).toBeGreaterThan(30);
  expect(room.meanMs).toBeLessThanOrEqual(1000 / 30); expect(rosterOpen.meanMs).toBeLessThanOrEqual(1000 / 30);
  expect(updates.published).toBe(60); expect(updates.latestObserved).toBe(60);
  expect(updates.actualRatePerSecond).toBeGreaterThanOrEqual(18);
  expect(updates.observed).toBeGreaterThanOrEqual(30); expect(updates.p95Ms).toBeLessThan(1000);
  expect(buildManifest()).toEqual(uiBuild);
  expect(requests.mutations).toEqual([]); expect(requests.remote).toEqual([]); expect(requests.errors).toEqual([]);
});

test('100 workroom entry and exit cycles retain one canvas and bounded visible actors', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const uiBuild = buildManifest(), requests = await loadFixture(page, crowdedSnapshot());
  const canvas = page.locator('canvas'), handle = await canvas.elementHandle();
  await warmFrames(page, 1500);
  const before = await canvas.boundingBox(), started = Date.now();
  const counts: { cycle: number; deskLabels: number; actorsInRoom: number; actorsInTown: number; canvases: number }[] = [];
  for (let cycle = 1; cycle <= 100; cycle++) {
    await page.getByRole('button', { name: 'Web studio', exact: true }).dispatchEvent('click');
    await expect(page.getByTestId('room-context')).toHaveAttribute('data-repo-id', 'web');
    const labels = page.getByRole('button', { name: /^Inspect Sample resident \d+ in workroom$/ });
    await expect(labels).toHaveCount(6);
    await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-visible-actor-count', '6');
    const deskLabels = await labels.count(), actorsInRoom = Number(await page.getByTestId('world-canvas').getAttribute('data-visible-actor-count'));
    await page.getByRole('button', { name: 'Back to town', exact: true }).dispatchEvent('click');
    await expect(page.getByTestId('room-context')).toHaveCount(0);
    await expect(labels).toHaveCount(0);
    await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-visible-actor-count', '50');
    await expect(canvas).toHaveCount(1);
    if (cycle === 1 || cycle % 10 === 0) counts.push({ cycle, deskLabels, actorsInRoom, actorsInTown: Number(await page.getByTestId('world-canvas').getAttribute('data-visible-actor-count')), canvases: await canvas.count() });
  }
  const sameCanvas = await canvas.evaluate((node, original) => node === original, handle);
  const measurement = {
    measuredAt: new Date().toISOString(), project: testInfo.project.name, uiBuild, fixture: '50 simulated agents in one repository',
    cycles: 100, durationMs: Date.now() - started, reducedMotion: true, sameCanvas, checkpoints: counts,
    measurementScope: `Repeated navigation and real DOM actor-label/canvas counts. UI artifacts: ${uiBuild.directory}. Programmatic button activation tests lifecycle behavior; separate house tests exercise actual pointer and keyboard input.`,
    limitation: 'No renderer resource counters are available. Stable DOM/actor counts do not prove bounded GPU allocations, texture memory, total JS heap or target-hardware performance.',
  };
  await saveEvidence(testInfo, 'house-100-cycles', measurement);
  expect(sameCanvas).toBe(true); expect(await canvas.boundingBox()).toEqual(before);
  expect(buildManifest()).toEqual(uiBuild);
  expect(requests.mutations).toEqual([]); expect(requests.remote).toEqual([]); expect(requests.errors).toEqual([]);
});
