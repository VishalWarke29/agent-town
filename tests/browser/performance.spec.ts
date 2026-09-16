import { expect, test } from '@playwright/test';
import { initialState } from '../../apps/service/src/demo';
import { mkdirSync, writeFileSync } from 'node:fs';

test('50 sample agents remain inspectable across an expanded campus', async ({ page }, testInfo) => {
  const state = initialState();
  state.workspace.name = '50-agent performance fixture';
  state.repositories = Array.from({ length: 12 }, (_, index) => ({ ...state.repositories[index % 3]!, id: `fixture-repo-${index}`, name: `Sample repository ${index + 1}`, position: (index < 3 ? [[-6, -3.3], [5.7, -3.8], [-5, 5.5]][index] : [18 + (index - 3) % 5 * 8, -4 + Math.floor((index - 3) / 5) * 8]) as [number, number] }));
  state.agents = Array.from({ length: 50 }, (_, index) => {
    const repo = state.repositories[index % 12]!;
    return { ...state.agents[index % 5]!, id: `fixture-agent-${index}`, name: `Sample agent ${index + 1}`, repoId: repo.id, activity: 'working' as const, home: [repo.position[0] + (Math.floor(index / 12) - 2) * 0.6, repo.position[1] + 2.7] as [number, number] };
  });
  const snapshot = { cursor: 1, state };
  await page.route('**/api/v1/workspaces/demo-town/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/v1/workspaces/demo-town/events*', route => route.fulfill({ contentType: 'text/event-stream', body: `id: 1\nevent: state\ndata: ${JSON.stringify({ ...snapshot, type: 'demo.fixture', occurredAt: new Date().toISOString() })}\n\n` }));
  const errors: string[] = [], remote: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') remote.push(request.url()); });
  await page.goto('/?preview=1');
  await expect(page.locator('canvas')).toBeVisible();
  // Separate shader/asset warm-up from steady-state rendering. This is a local
  // software-renderer regression gate, not a substitute for device acceptance.
  await page.evaluate(() => new Promise<void>(resolve => {
    const start = performance.now();
    const warm = () => performance.now() - start < 2000 ? requestAnimationFrame(warm) : resolve();
    requestAnimationFrame(warm);
  }));
  const frameTiming = async () => page.evaluate(() => new Promise<{ samples: number; meanMs: number; p95Ms: number }>(resolve => {
    const frames: number[] = []; let start = 0, previous = 0;
    const step = (now: number) => {
      if (!start) start = now;
      if (previous) frames.push(now - previous);
      previous = now;
      if (now - start < 2500) requestAnimationFrame(step);
      else { const ordered = [...frames].sort((a, b) => a - b); resolve({ samples: frames.length, meanMs: frames.reduce((total, value) => total + value, 0) / frames.length, p95Ms: ordered[Math.floor(ordered.length * 0.95)]! }); }
    };
    requestAnimationFrame(step);
  }));
  const closed = await frameTiming();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await expect(page.getByTestId('left-drawer')).toBeVisible();
  const open = await frameTiming();
  const measurement = JSON.stringify({ measuredAt: new Date().toISOString(), fixture: '50 agents, 12 repositories; no model calls', renderer: 'Headless Edge/Chromium; software fallback enabled, not a hardware certification', project: testInfo.project.name, targetFps: 30, closed, open, passed: closed.meanMs <= 1000 / 30 && open.meanMs <= 1000 / 30 }, null, 2);
  mkdirSync('docs/assets/benchmarks', { recursive: true });
  const evidencePath = `docs/assets/benchmarks/50-agents-${testInfo.project.name}.json`;
  writeFileSync(evidencePath, measurement);
  await testInfo.attach('50-agent-frame-timing.json', { path: evidencePath, contentType: 'application/json' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Inspect Sample agent / })).toHaveCount(50);
  await page.getByRole('button', { name: 'Inspect Sample agent 50', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('Sample agent 50');
  expect(closed.samples).toBeGreaterThan(1); expect(open.samples).toBeGreaterThan(1);
  expect(closed.meanMs).toBeLessThanOrEqual(1000 / 30); expect(open.meanMs).toBeLessThanOrEqual(1000 / 30);
  expect(errors).toEqual([]); expect(remote).toEqual([]);
});
