import { expect, test, type Page } from '@playwright/test';
import type { BrowserSession, NativeSession, NativeSessionPage, Repository, Snapshot } from '@agent-town/contracts';

/**
 * H0-33 (follow-up to H0-12/H0-15). Three things the unit suite cannot prove on its own, because they are
 * genuinely about what the browser does with a live component, not the server's data shape:
 *  1. The "N hidden · Show" badge appears the INSTANT a fresh page loads state.repositories[...].
 *     hiddenSessionCount (the read-time overlay store.ts now carries), with zero additional requests —
 *     never waiting for a hide/show action to happen first in this same page session (the gap H0-07 left,
 *     disclosed in RepositoryAgents.tsx's own comment).
 *  2. Real "Load more" pagination reaches every one of 26+ hidden sessions, appending pages rather than
 *     replacing the list.
 *  3. The request-sequencing guard: when two requests for the SAME repository's hidden list are in flight
 *     at once (an everyday same-instance race — e.g. opening the disclosure while an includeOlder toggle is
 *     still settling — rather than the cross-repository case, which both of RepositoryAgents' real callers
 *     already prevent structurally via `key={repoId}` forcing a full remount), the response that resolves
 *     LAST does not get to overwrite a NEWER request's already-applied, correct result.
 */
const stamp = '2026-09-15T12:00:00.000Z';
const sourceId = '7c9b7a7e-2f3e-4a63-9d0d-6a6f3b9d6a11';
const workspaceId = 'hidden-overlay-fixture';

function repo(id: string, name: string): Repository {
  return { id, name, description: 'Fixture project', language: 'TypeScript', branch: 'main', color: '#859b87', position: [-6, -3], source: 'local', projectKind: 'git', localPath: String.raw`C:\synthetic-hidden-overlay\${id}` };
}
function hiddenSession(index: number, repoId: string, hiddenAt: string): NativeSession {
  return { id: `${repoId}-hidden-${index}`, agentId: `${repoId}-hidden-${index}`, sourceId, provider: 'codex', nativeSessionId: `native-${repoId}-${index}`, title: `Fixture hidden session ${index}`, repoId,
    createdAt: stamp, nativeUpdatedAt: stamp, discoveredAt: stamp, observedAt: stamp, visible: false, visibility: 'hidden', hiddenAt, sceneVisible: false, activity: 'unknown' };
}

async function openRepository(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByTestId('room-context')).toBeVisible();
  await page.getByRole('button', { name: 'Repository details', exact: true }).click();
  const drawer = page.getByTestId('right-drawer');
  await expect(drawer).toBeVisible();
  return drawer;
}

test('the hidden-session badge appears on a fresh load with no request, and Load more reaches all 30 rows', async ({ page }) => {
  const project = repo('project', 'Overlay pagination café');
  const recentAt = stamp;
  const all = Array.from({ length: 30 }, (_, index) => hiddenSession(index, 'project', recentAt));
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Hidden overlay fixture', mode: 'private' }, simulation: { running: false, step: 0 },
    repositories: [{ ...project, hiddenSessionCount: all.length }], agents: [], activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'fixture-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Hidden overlay fixture', kind: 'personal' }], identity: { configured: true } };
  const calls: { path: string; query: string }[] = [];

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
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    if (path === '/api/v1/health') return route.fulfill({ json: { ok: true, rebuiltPendingRestart: false } });
    if (/\/agents\/[^/]+\/reports$/.test(path)) return route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } });
    if (path.endsWith('/native-sessions')) {
      calls.push({ path, query: url.search });
      const cursor = url.searchParams.get('cursor'), offset = cursor ? Number(cursor) : 0;
      const body: NativeSessionPage = { items: all.slice(offset, offset + 25), total: all.length, nextCursor: offset + 25 < all.length ? String(offset + 25) : null, hiddenTotal: all.length };
      return route.fulfill({ json: body });
    }
    return route.fulfill({ status: 400, json: { message: 'Unexpected fixture operation.' } });
  });

  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  const drawer = await openRepository(page, 'Overlay pagination café');

  // The badge is known from the snapshot alone: no /native-sessions request has happened yet.
  const summary = drawer.locator('[data-testid="hidden-sessions"] summary');
  await expect(summary).toContainText('30 sessions hidden · Show');
  expect(calls, 'the badge must not itself trigger a request').toEqual([]);

  // Opening it (Show) is the explicit action that fetches the first page.
  await summary.click();
  await expect(drawer.locator('[data-testid="hidden-sessions"] li')).toHaveCount(25);
  expect(calls).toHaveLength(1);
  const loadMore = drawer.getByRole('button', { name: 'Load more hidden sessions', exact: true });
  await expect(loadMore).toBeVisible();

  // Load more appends the remaining rows rather than replacing the list.
  await loadMore.click();
  await expect(drawer.locator('[data-testid="hidden-sessions"] li')).toHaveCount(30);
  await expect(drawer.locator('[data-testid="hidden-sessions"] li').first()).toContainText('Fixture hidden session 0');
  await expect(drawer.locator('[data-testid="hidden-sessions"] li').last()).toContainText('Fixture hidden session 29');
  await expect(loadMore).toHaveCount(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.query).toContain('cursor=25');
});

test('a slower response for a superseded request cannot overwrite the newer one that already applied', async ({ page }) => {
  const project = repo('project', 'Overlay race café');
  const recent = Array.from({ length: 4 }, (_, index) => hiddenSession(index, 'project', stamp));
  const withOlder = [...recent, ...Array.from({ length: 3 }, (_, index) => hiddenSession(100 + index, 'project', new Date(Date.parse(stamp) - 40 * 86400000).toISOString()))];
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Hidden overlay fixture', mode: 'private' }, simulation: { running: false, step: 0 },
    repositories: [{ ...project, hiddenSessionCount: withOlder.length }], agents: [], activity: [], handoffs: [], manager: { version: 0, brief: 'No received reports', updatedAt: null } } };
  const session: BrowserSession = { csrf: 'synthetic-csrf', mode: 'private', applicationMode: 'development', user: { id: 'fixture-owner', login: 'fixture-owner', displayName: 'Fixture owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Hidden overlay fixture', kind: 'personal' }], identity: { configured: true } };

  let releaseSlowRecentRequest!: () => void;
  const slowRecentRequested = new Promise<void>(resolve => { releaseSlowRecentRequest = resolve; });
  let recentRequests = 0;

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
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: session });
    if (path.endsWith('/snapshot')) return route.fulfill({ json: snapshot });
    if (path === '/api/v1/health') return route.fulfill({ json: { ok: true, rebuiltPendingRestart: false } });
    if (/\/agents\/[^/]+\/reports$/.test(path)) return route.fulfill({ json: { reports: [], reportCount: 0, reportsNextOffset: null } });
    if (path.endsWith('/native-sessions')) {
      const includeOlder = url.searchParams.get('includeOlder') === 'true';
      if (!includeOlder) {
        // The FIRST request this test makes (opening the disclosure) is deliberately held open until the
        // test releases it, well after the second (includeOlder) request below has already resolved and
        // been applied — proving the late arrival is ignored rather than clobbering the newer result.
        recentRequests++;
        await slowRecentRequested;
        const body: NativeSessionPage = { items: recent, total: recent.length, nextCursor: null, hiddenTotal: withOlder.length };
        return route.fulfill({ json: body });
      }
      const body: NativeSessionPage = { items: withOlder, total: withOlder.length, nextCursor: null, hiddenTotal: withOlder.length };
      return route.fulfill({ json: body });
    }
    return route.fulfill({ status: 400, json: { message: 'Unexpected fixture operation.' } });
  });

  await page.goto('/');
  await expect(page.getByText('Local service connected', { exact: true })).toBeVisible();
  const drawer = await openRepository(page, 'Overlay race café');

  const summary = drawer.locator('[data-testid="hidden-sessions"] summary');
  await expect(summary).toContainText('7 sessions hidden · Show');
  await summary.click();
  await expect.poll(() => recentRequests).toBe(1);

  // While that first (recent-only) request is still held open, check "Include older" — a second,
  // independent request for the SAME repository that this fixture answers immediately.
  await drawer.getByRole('checkbox', { name: 'Include sessions hidden more than 30 days ago', exact: true }).check();
  await expect(drawer.locator('[data-testid="hidden-sessions"] li')).toHaveCount(7);
  for (const label of ['Fixture hidden session 0', 'Fixture hidden session 100']) await expect(drawer.locator('[data-testid="hidden-sessions"] li', { hasText: label })).toBeVisible();

  // Now let the superseded, slower request finally resolve. Its 4-item, recent-only page must not replace
  // the 7-item, includeOlder page already showing.
  releaseSlowRecentRequest();
  await page.waitForTimeout(300);
  await expect(drawer.locator('[data-testid="hidden-sessions"] li')).toHaveCount(7);
  for (const label of ['Fixture hidden session 0', 'Fixture hidden session 100']) await expect(drawer.locator('[data-testid="hidden-sessions"] li', { hasText: label })).toBeVisible();
});
