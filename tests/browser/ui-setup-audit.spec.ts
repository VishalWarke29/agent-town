import { expect, test, type Page } from '@playwright/test';
import type { BrowserSession, ObservationSetup, Repository, Snapshot } from '@agent-town/contracts';

const checkedAt = '2026-09-15T12:00:00Z';
const repository = (id: string): Repository => ({ id, name: `Project ${id}`, source: 'local', projectKind: 'folder', localPath: `C:\\synthetic-ui\\${id}`, description: 'Synthetic folder fixture', branch: '', color: '#859b87', position: [-6, -3], language: 'Unavailable', discoveryStatus: { state: 'current', checkedAt, lastVerifiedAt: checkedAt, reasons: [] } });

async function setupFixture(page: Page, repositories: Repository[] = []) {
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: 'ui-setup-audit', name: 'Setup audit fixture', mode: 'private' }, simulation: { running: false, step: 0 }, repositories, agents: [], handoffs: [], activity: [], manager: { version: 0, brief: 'No reports received.', updatedAt: null }, discovery: { roots: [], candidates: [], operation: null }, observation: { connections: [] } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'synthetic-owner', login: 'synthetic-owner', displayName: 'Synthetic owner', avatarUrl: null }, workspaces: [{ id: snapshot.state.workspace.id, name: snapshot.state.workspace.name, kind: 'personal' }], identity: { configured: true } };
  const unexpected: string[] = [];
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      closed = false;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('setup-audit-state', this.listener); setTimeout(() => { if (!this.closed) this.onopen?.(); }, 0); }
      close() { this.closed = true; window.removeEventListener('setup-audit-state', this.listener); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    if (path === '/api/v1/workspaces/ui-setup-audit/observation/native-setup' && route.request().method() === 'GET') return route.fulfill({ json: { sources: [], tools: [] } });
    unexpected.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 400, json: { message: 'No provider or mutation is permitted in this UI fixture.' } });
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(current => window.dispatchEvent(new CustomEvent('setup-audit-state', { detail: current })), snapshot); };
  return { snapshot, session, publish, unexpected };
}

test('a reachable loopback town ignores an offline internet hint and retries actual snapshot failures', async ({ page }) => {
  let blocked = false, reads = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await page.route('**/api/v1/workspaces/demo-town/snapshot', async route => {
    reads++;
    if (blocked) return route.fulfill({ status: 503, json: { message: 'Synthetic local transport outage.' } });
    return route.continue();
  });
  await page.goto('/?preview=1');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  const beforeHint = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect.poll(() => reads).toBeGreaterThan(beforeHint);
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  blocked = true;
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText('Reconnecting · showing last saved state', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Run|Pause) demo$/ })).toBeDisabled();
  blocked = false;
  // No online event is sent. A local service recovering must be enough.
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Run|Pause) demo$/ })).toBeEnabled();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('configured account setup pauses only for failed local transport and recovers without an online event', async ({ page }) => {
  const { session, unexpected } = await setupFixture(page);
  session.user = null; session.workspaces = [];
  let blocked = false;
  await page.route('**/api/v1/session', route => route.fulfill(blocked ? { status: 503, json: { message: 'Synthetic local service outage.' } } : { json: session }));
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  const signIn = page.getByRole('button', { name: 'Sign in with GitHub', exact: true });
  await expect(signIn).toBeEnabled();
  blocked = true;
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(signIn).toBeDisabled();
  await expect(page.getByTestId('left-drawer')).toContainText('local service reconnects');
  blocked = false;
  await expect(signIn).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test('repository checkbox edits survive unrelated live connections and removed scope is discarded', async ({ page }) => {
  const a = repository('a'), b = repository('b'), c = repository('c');
  const { snapshot, publish, unexpected } = await setupFixture(page, [a]);
  snapshot.state.discovery!.candidates = [a, b, c];
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await page.getByRole('button', { name: 'Open repositories', exact: true }).click();
  const choices = page.locator('.candidate-selection');
  await choices.getByRole('checkbox', { name: /Project a/ }).uncheck();
  await choices.getByRole('checkbox', { name: /Project b/ }).check();
  snapshot.state.repositories.push(c);
  await publish();
  await expect(choices.getByRole('checkbox', { name: /Project a/ })).not.toBeChecked();
  await expect(choices.getByRole('checkbox', { name: /Project b/ })).toBeChecked();
  await expect(choices.getByRole('checkbox', { name: /Project c/ })).toBeChecked();
  snapshot.state.repositories = [a];
  snapshot.state.discovery!.candidates = [a];
  await publish();
  await expect(choices.getByRole('checkbox', { name: /Project c/ })).toHaveCount(0);
  await expect(choices.getByRole('button', { name: 'Save repository selection', exact: true })).toBeDisabled();
  await expect(choices).toContainText('Some unsaved selections disappeared');
  await choices.getByRole('button', { name: 'Discard missing selections', exact: true }).click();
  await expect(choices.getByRole('button', { name: 'Save repository selection', exact: true })).toBeEnabled();
  await expect(choices.getByRole('checkbox', { name: /Project a/ })).not.toBeChecked();
  expect(unexpected).toEqual([]);
});

test('revocation received while reviewing a hook closes stale configuration and prevents applying it', async ({ page }) => {
  const repo = repository('observed');
  const { snapshot, publish, unexpected } = await setupFixture(page, [repo]);
  const setup: ObservationSetup = { connection: { id: 'synthetic-observer', provider: 'codex', repoId: repo.id, label: 'Synthetic observer', status: 'unverified', createdAt: checkedAt, lastEventAt: null, version: null, coverage: 'partial', droppedEvents: 0 }, configPath: 'C:\\synthetic-ui\\observed\\.codex\\config.toml', config: 'synthetic configuration only', bridgeCommand: 'synthetic bridge only', instructions: ['Synthetic setup for UI review.'] };
  snapshot.state.observation!.connections = [setup.connection];
  await page.route('**/observation/connections/synthetic-observer/setup', route => route.fulfill({ json: setup }));
  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'Review hook setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply reviewed Agent Town hook', exact: true })).toBeEnabled();
  snapshot.state.observation!.connections = [{ ...setup.connection, status: 'revoked' }];
  await publish();
  await expect(page.getByLabel('Proposed hook configuration', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply reviewed Agent Town hook', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Observe existing agents', exact: true })).toContainText('This observation connection was revoked.');
  expect(unexpected).toEqual([]);
});

test('a pointer pressed on startup Connections cannot activate the replacement world-view control', async ({ page }) => {
  const { snapshot, unexpected } = await setupFixture(page, [repository('startup')]);
  let releaseSnapshot!: () => void;
  const gate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  await page.route('**/api/v1/workspaces/ui-setup-audit/snapshot', async route => {
    await gate;
    await route.fulfill({ json: snapshot });
  });
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Opening the workshop', exact: true })).toBeVisible();
    const setupControl = page.getByRole('button', { name: 'Open connections', exact: true });
    await expect(setupControl).toBeVisible();
    const bounds = await setupControl.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    releaseSnapshot();
    await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show list view', exact: true })).toBeVisible();
    await page.mouse.up();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(page.getByRole('button', { name: 'Show list view', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Accessible town list', exact: true })).toHaveCount(0);
    expect(unexpected).toEqual([]);
  } finally { releaseSnapshot(); }
});

test('a stalled snapshot has a deadline and a fresh automatic retry can open the town', async ({ page }) => {
  const { unexpected } = await setupFixture(page);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let waiting = true;
    window.fetch = (input, init) => {
      if (waiting && String(input).endsWith('/snapshot')) {
        waiting = false;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Synthetic stalled request aborted.', 'AbortError')), { once: true });
        });
      }
      return original(input, init);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Opening the workshop', exact: true })).toBeVisible();
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible({ timeout: 16000 });
  await expect(page.getByRole('heading', { name: 'Opening the workshop', exact: true })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
