import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createApp } from '../../apps/service/src/app';
import { initialState } from '../../apps/service/src/demo';

const epochNow = () => performance.timeOrigin + performance.now();
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, meanMs: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p95Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.95)]! : null, maxMs: sorted.at(-1) ?? null };
};

async function clockCalibration(page: Page) {
  const samples = [];
  for (let index = 0; index < 7; index++) {
    const before = epochNow(), browser = await page.evaluate(() => performance.timeOrigin + performance.now()), after = epochNow();
    samples.push({ browserOffsetMs: browser - (before + after) / 2, uncertaintyMs: (after - before) / 2 });
  }
  return samples.sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0]!;
}

async function serveSelectedUi(page: Page) {
  const configured = process.env.AGENT_TOWN_E2E_WEB_ROOT, project = resolve('.');
  if (configured && !isAbsolute(configured)) throw new Error('AGENT_TOWN_E2E_WEB_ROOT must be an absolute read-only dist path.');
  const directory = resolve(configured ?? 'apps/web/dist');
  if (!directory.startsWith(project + sep) || !directory.endsWith(`${sep}apps${sep}web${sep}dist`) || !existsSync(resolve(directory, 'index.html'))) throw new Error('The selected UI must be an existing apps/web/dist inside this workspace.');
  // Capture immutable asset bytes once; leave every API request on the real service.
  const files = new Map<string, Buffer>();
  for (const name of ['index.html', 'favicon.svg', ...readdirSync(resolve(directory, 'assets')).map(file => `assets/${file}`)]) {
    if (existsSync(resolve(directory, name))) files.set(name, readFileSync(resolve(directory, name)));
  }
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ingest/')) return route.continue();
    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = resolve(directory, name), body = files.get(name);
    if (!target.startsWith(directory + sep) || !body) return route.fulfill({ status: 404, body: 'Missing fixture asset' });
    const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(name)] ?? 'application/octet-stream';
    return route.fulfill({ body, contentType });
  });
  return { directory: relative(project, directory), frozen: !!configured,
    assets: [...files].map(([name, body]) => ({ name, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') })) };
}

interface Probe {
  armed: boolean;
  received: Map<number, { at: number; cursor: number }>;
  dom: Map<number, number>;
  frame: Map<number, number>;
  streams: { created: number; opened: number; errors: number; closedByApp: number; stateEvents: number; bytes: number; maxBytes: number };
  instrumentation: { receiveMs: number; observerMs: number; observerCalls: number; examinedNodes: number };
  frameGaps: { at: number; gapMs: number }[];
  longTasks: { at: number; durationMs: number }[];
  longFrames: { at: number; durationMs: number; blockingMs: number | null }[];
  visibility: { at: number; state: string }[];
  firstCanvasAt: number | null;
  firstCanvasFrameAt: number | null;
  observeFeed(): void;
}
declare global { interface Window { volumeProbe: Probe } }

test('20 saved events per second reach the activity view through real SSE', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const port = address.port; await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const instance = await createApp({ database: ':memory:', port, mode: 'demo', simulationInterval: 600000 });
  const state = initialState(); state.simulation.running = false; state.activity = [];
  const prototypes = structuredClone(state.agents);
  state.agents = Array.from({ length: 50 }, (_, i) => ({ ...prototypes[i % prototypes.length]!, id: `volume-agent-${i}`, name: `Volume agent ${i + 1}`, activity: 'working' }));
  instance.store.commit('volume-fixture', current => { Object.assign(current, state); return 'demo.fixture'; });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const network = { snapshots: 0, streams: 0, failed: [] as { path: string; error: string | null }[], statuses: [] as { path: string; status: number }[] };
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.endsWith('/snapshot')) network.snapshots++; if (path.endsWith('/events')) network.streams++; });
  page.on('requestfailed', request => { if (new URL(request.url()).pathname.startsWith('/api/')) network.failed.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? null }); });
  page.on('response', response => { if (new URL(response.url()).pathname.startsWith('/api/')) network.statuses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  const published = new Map<number, { at: number; cursor: number }>();
  const unsubscribe = instance.store.subscribe(event => { const match = /^Volume event (\d+) /.exec(event.state.activity[0]?.message ?? ''); if (match) published.set(Number(match[1]), { at: epochNow(), cursor: event.cursor }); });
  try {
    const ui = await serveSelectedUi(page);
    await page.addInitScript(() => {
      const now = () => performance.timeOrigin + performance.now();
      const probe: Probe = window.volumeProbe = { armed: false, received: new Map(), dom: new Map(), frame: new Map(),
        streams: { created: 0, opened: 0, errors: 0, closedByApp: 0, stateEvents: 0, bytes: 0, maxBytes: 0 },
        instrumentation: { receiveMs: 0, observerMs: 0, observerCalls: 0, examinedNodes: 0 }, frameGaps: [], longTasks: [], longFrames: [],
        visibility: [{ at: now(), state: document.visibilityState }], firstCanvasAt: null, firstCanvasFrameAt: null, observeFeed: () => {} };
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options); probe.streams.created++;
          this.addEventListener('open', () => { probe.streams.opened++; });
          this.addEventListener('error', () => { probe.streams.errors++; });
          this.addEventListener('state', (event: MessageEvent<string>) => {
            if (!probe.armed) return;
            const at = now(), started = performance.now();
            const data = JSON.parse(event.data) as { cursor: number; state: { activity: { message: string }[] } };
            probe.streams.stateEvents++; const bytes = new TextEncoder().encode(event.data).byteLength;
            probe.streams.bytes += bytes; probe.streams.maxBytes = Math.max(probe.streams.maxBytes, bytes);
            for (const item of data.state.activity) {
              const match = /^Volume event (\d+) /.exec(item.message);
              if (match && !probe.received.has(Number(match[1]))) probe.received.set(Number(match[1]), { at, cursor: data.cursor });
            }
            probe.instrumentation.receiveMs += performance.now() - started;
          });
        }
        close() { probe.streams.closedByApp++; super.close(); }
      };
      const canvasObserver = new MutationObserver(() => {
        if (document.querySelector('canvas')) { probe.firstCanvasAt = now(); requestAnimationFrame(() => { probe.firstCanvasFrameAt = now(); }); canvasObserver.disconnect(); }
      });
      canvasObserver.observe(document, { childList: true, subtree: true });
      document.addEventListener('visibilitychange', () => probe.visibility.push({ at: now(), state: document.visibilityState }));
      let previousFrame = 0;
      const frame = () => {
        const at = now();
        if (probe.armed && previousFrame && at - previousFrame > 40 && probe.frameGaps.length < 500) probe.frameGaps.push({ at, gapMs: at - previousFrame });
        previousFrame = at; requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
        if (probe.armed) for (const entry of list.getEntries()) if (probe.longTasks.length < 500) probe.longTasks.push({ at: performance.timeOrigin + entry.startTime, durationMs: entry.duration });
      }).observe({ type: 'longtask', buffered: false });
      if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) new PerformanceObserver(list => {
        if (probe.armed) for (const entry of list.getEntries()) if (probe.longFrames.length < 500) probe.longFrames.push({ at: performance.timeOrigin + entry.startTime, durationMs: entry.duration, blockingMs: 'blockingDuration' in entry ? Number(entry.blockingDuration) : null });
      }).observe({ type: 'long-animation-frame', buffered: false });
      probe.observeFeed = () => {
        const feed = document.querySelector('.activity-feed'); if (!feed) throw new Error('Activity feed is unavailable.');
        new MutationObserver(mutations => {
          const at = now(), started = performance.now(), found: number[] = []; probe.instrumentation.observerCalls++;
          const inspect = (node: Node) => {
            if (!(node instanceof Element)) return;
            const paragraphs = node.matches('p') ? [node] : [...node.querySelectorAll('p')];
            for (const paragraph of paragraphs) {
              probe.instrumentation.examinedNodes++;
              const match = /^Volume event (\d+) /.exec(paragraph.textContent ?? '');
              if (match && !probe.dom.has(Number(match[1]))) { const id = Number(match[1]); probe.dom.set(id, at); found.push(id); }
            }
          };
          for (const mutation of mutations) {
            if (mutation.type === 'characterData') { if (mutation.target.parentElement) inspect(mutation.target.parentElement); }
            else for (const node of mutation.addedNodes) inspect(node);
          }
          if (found.length) requestAnimationFrame(() => { const at = now(); for (const id of found) probe.frame.set(id, at); });
          probe.instrumentation.observerMs += performance.now() - started;
        }).observe(feed, { childList: true, subtree: true, characterData: true });
      };
    });
    await instance.app.listen({ host: '127.0.0.1', port });
    await page.goto(`http://127.0.0.1:${port}/?preview=1`);
    await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open saved activity', exact: true }).click();
    const clockBefore = await clockCalibration(page);
    await page.evaluate(() => { window.volumeProbe.observeFeed(); window.volumeProbe.armed = true; });
    const commits: { id: number; startedAt: number; finishedAt: number; scheduledAt: number }[] = [];
    const total = 200, started = performance.now();
    for (let index = 0; index < total; index++) {
      await delay(Math.max(0, started + index * 50 - performance.now()));
      const timestamp = Date.now(), startedAt = epochNow();
      instance.store.commit(`volume-${index}`, current => {
        current.activity.unshift({ id: `volume-${index}`, kind: 'system', message: `Volume event ${index} at ${timestamp}`, createdAt: new Date(timestamp).toISOString() });
        return 'demo.volume';
      });
      commits.push({ id: index, startedAt, finishedAt: epochNow(), scheduledAt: performance.timeOrigin + started + index * 50 });
    }
    const elapsedMs = performance.now() - started;
    await expect.poll(() => page.evaluate(() => window.volumeProbe.frame.size)).toBe(total);
    const browser = await page.evaluate(() => { const p = window.volumeProbe; p.armed = false; return { received: [...p.received], dom: [...p.dom], frame: [...p.frame], streams: p.streams, instrumentation: p.instrumentation, frameGaps: p.frameGaps, longTasks: p.longTasks, longFrames: p.longFrames, visibility: p.visibility, firstCanvasAt: p.firstCanvasAt, firstCanvasFrameAt: p.firstCanvasFrameAt }; });
    const clockAfter = await clockCalibration(page), received = new Map(browser.received), dom = new Map(browser.dom), frames = new Map(browser.frame);
    const rows = commits.map(commit => {
      const saved = published.get(commit.id)!, receipt = received.get(commit.id), domAt = dom.get(commit.id)!, frameAt = frames.get(commit.id)!;
      return { id: commit.id, cursor: saved.cursor, scheduledAt: commit.scheduledAt, commitStartedAt: commit.startedAt, publishedAt: saved.at, commitFinishedAt: commit.finishedAt,
        receivedAt: receipt?.at ?? null, receivedCursor: receipt?.cursor ?? null, domAt, frameAt,
        generationDelayMs: commit.startedAt - commit.scheduledAt, commitMs: commit.finishedAt - commit.startedAt,
        publishToReceiveMs: receipt ? receipt.at - clockBefore.browserOffsetMs - saved.at : null,
        receiveToDomMs: receipt ? domAt - receipt.at : null, domToFrameMs: frameAt - domAt,
        commitToFrameMs: frameAt - clockBefore.browserOffsetMs - commit.startedAt,
        publishedToFrameMs: frameAt - clockBefore.browserOffsetMs - saved.at };
    });
    const full = summary(rows.map(row => row.commitToFrameMs)), p95Ms = full.p95Ms!;
    const evidence = { measuredAt: new Date().toISOString(), project: testInfo.project.name, events: total, targetEventsPerSecond: 20, elapsedMs, achievedEventsPerSecond: total * 1000 / elapsedMs,
      p95Ms, maxMs: full.maxMs, path: 'Store commit start → durable publish → real loopback Fastify SSE callback → React activity DOM → next animation frame',
      fixture: '50 simulated agents, 200 saved events; no warm-up added. No account or model calls. Next animation frame is a rendering proxy, not a physical-paint or native-agent acceptance claim.',
      ui, clock: { before: clockBefore, after: clockAfter, offsetDriftMs: clockAfter.browserOffsetMs - clockBefore.browserOffsetMs, method: 'Monotonic epoch clocks calibrated by minimum of seven browser round trips; raw browser timestamps retain measured offset.' },
      network, browser, storage: instance.store.diagnostics(), phases: [{ name: 'first 2 seconds', rows: rows.slice(0, 40) }, { name: '2–5 seconds', rows: rows.slice(40, 100) }, { name: '5–10 seconds', rows: rows.slice(100) }].map(phase => ({ name: phase.name, ...summary(phase.rows.map(row => row.commitToFrameMs)) })),
      stages: { commit: summary(rows.map(row => row.commitMs)), publishedToReceive: summary(rows.flatMap(row => row.publishToReceiveMs === null ? [] : [row.publishToReceiveMs])), receiveToDom: summary(rows.flatMap(row => row.receiveToDomMs === null ? [] : [row.receiveToDomMs])), domToFrame: summary(rows.map(row => row.domToFrameMs)), publishedToFrame: summary(rows.map(row => row.publishedToFrameMs)) }, rows,
      passed: p95Ms < 1000 && total * 1000 / elapsedMs >= 19 && errors.length === 0 && received.size === total && network.snapshots === 1 && network.streams === 1 && browser.streams.errors === 0 };
    mkdirSync('docs/assets/benchmarks', { recursive: true });
    const evidencePath = `docs/assets/benchmarks/event-volume-${testInfo.project.name}.json`; writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach('event-volume.json', { path: evidencePath, contentType: 'application/json' });
    expect(errors).toEqual([]); expect(received.size).toBe(total); expect(network.snapshots).toBe(1); expect(network.streams).toBe(1); expect(browser.streams.errors).toBe(0);
    expect(evidence.achievedEventsPerSecond).toBeGreaterThanOrEqual(19); expect(p95Ms).toBeLessThan(1000);
  } finally { unsubscribe(); await page.goto('about:blank'); await instance.app.close(); }
});
