import { expect, test } from '@playwright/test';
import type { Agent, BrowserSession, Snapshot, WorkflowState } from '@agent-town/contracts';

// UX-01: the app shell itself must never look broken with no explanation.
//  - A render throw outside any inner boundary (WorldBoundary, PanelBoundary; see panel-boundary.spec.ts
//    for those) used to unmount the whole React tree, leaving a blank page (SP-2's actual failure mode).
//    AppBoundary is the last line of defense around <App/> in main.tsx.
//  - With JavaScript off, index.html's <noscript> must say so in one plain sentence instead of showing
//    nothing at all (Gap 16).
//  - Zod's `new Function` fast-path probe must never reach the page as a CSP violation under the
//    service's real, unchanged header (SP-4): apps/web/src/zod-jitless.ts turns the probe off before
//    anything else can trigger it.

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const workspaceId = 'app-shell';
const agent: Agent = { id: 'observed-agent', name: 'Codex session', provider: 'Codex', role: 'Observed session', repoId: 'project', task: 'Task not linked', activity: 'idle', color: '#6c8c91', home: [-5.4, -0.5], updatedAt: new Date().toISOString(), files: [], evidence: 'Observed tool event', contextVersion: null };
// Minimal non-demo workflow state (matches tests/browser/workspaces.spec.ts's fixture shape) so the
// manager drawer renders ManagerPanel (and its nested MemoryPanel) instead of WorkspaceReadiness.
const workflow: WorkflowState = { schemaVersion: 1, connections: [], defaults: {}, policy: { paidEnabled: false, dailyBudgetMicroUsd: 0, managerDailyBudgetMicroUsd: 0, maxRunBudgetMicroUsd: 0, workerConcurrency: 1, timeZone: 'UTC' }, reservations: [], manager: { config: { enabled: false, connectionId: null, model: null, maxInputTokens: 4096, maxOutputTokens: 800, requestBudgetMicroUsd: 0 }, queueReportIds: [], jobs: [], versions: [], proposals: [], automaticStarts: [] } };
const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Shell fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [{ id: 'project', name: 'Local project', description: '', language: 'TypeScript', branch: 'main', color: '#859b87', position: [-6, -3], source: 'local' }], agents: [agent], activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null }, observation: { connections: [] }, discovery: { roots: [], candidates: [], operation: null }, workflow } };
const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'shell-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Shell fixture', kind: 'personal' }], identity: { configured: true } };

test('a render throw outside any inner boundary shows a recovery page with a Reload button, not a blank page', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // The real disconnect route's own reply (apps/service/src/app.ts): { ok: true }, not a BrowserSession.
    // Handing this straight to the session state (as the pre-fix useIdentity.ts's disconnectGithub did)
    // reproduces the same crash on the very first load, without needing to drive a full sign-in flow here.
    if (path === '/api/v1/session') return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  await page.goto('/');

  const recovery = page.getByRole('alert').filter({ hasText: 'Agent Town ran into a problem' });
  await expect(recovery).toBeVisible();
  const reload = recovery.getByRole('button', { name: 'Reload page', exact: true });
  await expect(reload).toBeVisible();
  const box = await reload.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  // No stack, file path or other technical detail anywhere on the recovery page itself.
  const bodyText = await page.locator('body').innerText();
  for (const leak of ['Cannot read prop', '.ts:', '.tsx:', 'at Object', 'apps/web/src', 'C:\\', 'node_modules']) {
    expect(bodyText).not.toContain(leak);
  }

  // React's own error boundary catches the throw (AppBoundary's getDerivedStateFromError /
  // componentDidCatch): it never reaches the browser as an uncaught exception, so the page keeps
  // running (the Reload button above is live) instead of the tree being torn down.
  expect(pageErrors).toEqual([]);
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('with JavaScript off, the page shows one plain sentence saying Agent Town needs JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('/');
    const notice = page.locator('noscript');
    await expect(notice).toContainText('Agent Town needs JavaScript', { useInnerText: true });
    // Nothing else on the page: no half-built app shell to misread as broken, no script executed at all.
    await expect(page.locator('#root')).toBeEmpty();
    const bodyText = (await page.locator('body').innerText()).trim();
    expect(bodyText).toBe('Agent Town needs JavaScript to run. Please turn it on in your browser.');
  } finally {
    await context.close();
  }
});

test('a load under the service\'s real CSP raises zero securitypolicyviolation events, and the header stays unchanged with no unsafe-eval', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(`${event.violatedDirective} blocked=${event.blockedURI}`);
    });
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
    if (path.endsWith('/observation/tool-detection')) return route.fulfill({ json: { repoId: 'project', tools: [] } });
    return route.fulfill({ status: 404, json: { message: 'Unsupported fixture action' } });
  });
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toBe(CSP);
  expect(response?.headers()['content-security-policy']).not.toContain('unsafe-eval');

  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  const openAndClose = async (label: string) => {
    const button = page.getByRole('button', { name: label, exact: true }).first();
    if (await button.count()) { await button.click(); await page.waitForTimeout(200); await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  };
  // Exercise the panels that call a zod schema's .safeParse() at runtime, so the fix is proven against
  // real use, not just an app that never happened to touch those modules this run: RunnerPanel ('Open
  // tasks'), WorkflowPanel's WorkflowConnections ('Open connections'), MemoryPanel, which is nested
  // inside ManagerPanel ('Open manager', reachable only in this default/world view, not list view) and
  // TelemetryPanel ('Open api activity', reachable only after switching to list view; App.tsx's
  // always-visible tool-dock has no button for it). 'Open repositories', 'Open settings', 'Open usage'
  // and 'Open activity' add broad navigation coverage but touch no zod schema themselves.
  await openAndClose('Open manager');
  for (const label of ['Open repositories', 'Open connections', 'Open tasks', 'Open settings']) await openAndClose(label);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  for (const label of ['Open usage', 'Open activity', 'Open api activity']) await openAndClose(label);

  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
  expect(violations).toEqual([]);
});
