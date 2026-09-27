import { expect, test } from '@playwright/test';
import type { Agent, BrowserSession, Snapshot } from '@agent-town/contracts';

// A drawer panel that throws while rendering used to unmount the entire app (white screen).
// The saved-report response below is well-formed JSON with the wrong inner shape, so the failure
// happens inside a child component rather than in the page's own render.
const workspaceId = 'panel-boundary';
const agent: Agent = { id: 'observed-agent', name: 'Codex session', provider: 'Codex', role: 'Observed session', repoId: 'project', task: 'Task not linked', activity: 'idle', color: '#6c8c91', home: [-5.4, -0.5], updatedAt: new Date().toISOString(), files: [], evidence: 'Observed tool event', contextVersion: null, observation: { connectionId: 'fixture-connection', sessionId: 'fixture-session', parentSessionId: null, lastSequence: 1, sourceTime: new Date().toISOString(), freshness: 'current', billing: 'unavailable' } };

test('a panel that throws is contained: the world, sidebars and footer stay usable', async ({ page }) => {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Boundary fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [{ id: 'project', name: 'Local project', description: '', language: 'TypeScript', branch: 'main', color: '#859b87', position: [-6, -3], source: 'local', localPath: String.raw`C:\synthetic-boundary\project` }], agents: [agent], activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null }, observation: { connections: [] }, discovery: { roots: [String.raw`C:\synthetic-boundary`], candidates: [], operation: null } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'boundary-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Boundary fixture', kind: 'personal' }], identity: { configured: true } };
  const pageErrors: string[] = [];
  let reportReads = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
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
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    // Only a mock. Nothing asks for a tool check on its own any more: it starts when the person presses "Check this computer" (H0-02, D38).
    if (path.endsWith('/observation/tool-detection')) return route.fulfill({ json: { repoId: 'project', tools: ['codex', 'claude', 'cursor', 'copilot-cli'].map(provider => ({ provider, label: provider, state: 'not-installed', sessionCount: null, sessionCountExact: true, message: null })) } });
    if (/\/agents\/observed-agent\/reports$/.test(path)) {
      reportReads++;
      // A report whose `details` lacks `outcome`: the list renders, then one report card throws.
      return route.fulfill({ json: { reports: [{ id: 'report-1', agentId: 'observed-agent', summary: 'Malformed saved report', status: 'saved', contextVersion: null, delivery: 'unsupported', createdAt: new Date().toISOString(), details: {} }], reportCount: 1, reportsNextOffset: null } });
    }
    return route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  const canvas = await page.locator('canvas').elementHandle();

  await page.getByRole('button', { name: 'Local project', exact: true }).click();
  await page.getByRole('button', { name: 'Repository details', exact: true }).click();
  const drawer = page.getByTestId('right-drawer');
  // H0-07: the inspector keeps its fixed slot order (facts, Assign, Residents, then Details and Watch
  // collapsed last) even when a later panel in the same drawer goes on to throw.
  expect(await drawer.locator('[data-slot]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-slot')))).toEqual(['facts', 'assign', 'residents', 'details', 'watch']);
  await drawer.locator('button[data-agent-id="observed-agent"]').click();

  // The failing panel is replaced by a message; nothing else is lost.
  const alert = drawer.getByRole('alert').filter({ hasText: 'This panel could not be displayed' });
  await expect(alert).toBeVisible();
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  expect(await page.locator('canvas').evaluate((node, old) => node === old, canvas)).toBe(true);
  expect(reportReads).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);

  // Retrying a deterministic failure shows the same message again rather than looping or crashing.
  await alert.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(alert).toBeVisible();
  expect(pageErrors).toEqual([]);

  // The rest of the app still responds: the drawer closes and the navigation opens.
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close navigation', exact: true })).toBeVisible();
});
